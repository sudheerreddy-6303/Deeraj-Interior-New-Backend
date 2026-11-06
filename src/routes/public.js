// Public API used by the website: catalogue, checkout, order tracking and enquiry forms.
const express = require('express');
const { pool } = require('../db');
const { loadProducts, getSettings, stockFor } = require('../store');
const { createPaymentForOrder, cancelPaymentForOrder } = require('./payments');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);
const PHONE_RE = /^[6-9]\d{9}$/;
const normPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/* ---------- catalogue ---------- */
router.get('/categories', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT code, name FROM categories ORDER BY sort_order, name');
  res.json(rows);
}));

router.get('/products', wrap(async (req, res) => {
  res.json(await loadProducts());
}));

router.get('/products/:id', wrap(async (req, res) => {
  const [p] = await loadProducts({ id: Number(req.params.id) });
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  res.json(p);
}));

router.get('/settings', wrap(async (req, res) => {
  res.json(await getSettings());
}));

router.post('/coupons/validate', wrap(async (req, res) => {
  const code = clean(req.body.code, 40).toUpperCase();
  const [rows] = await pool.query('SELECT code, percent FROM coupons WHERE UPPER(code) = ? AND active = 1', [code]);
  if (!rows.length) return res.status(404).json({ error: 'That coupon code is not valid.' });
  res.json({ code: rows[0].code.toUpperCase(), percent: rows[0].percent });
}));

/* ---------- orders ---------- */
function orderCode() {
  return 'DI' + Date.now().toString(36).toUpperCase().slice(-6) + Math.floor(Math.random() * 36).toString(36).toUpperCase();
}

async function loadOrders(whereSql, args, conn = pool) {
  const [orders] = await conn.query(`SELECT * FROM orders ${whereSql} ORDER BY created_at DESC, id DESC`, args);
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const ph = ids.map(() => '?').join(',');
  const [items] = await conn.query(`SELECT * FROM order_items WHERE order_id IN (${ph})`, ids);
  const [hist] = await conn.query(`SELECT * FROM order_history WHERE order_id IN (${ph}) ORDER BY created_at, id`, ids);
  return orders.map((o) => ({
    id: o.id,
    code: o.order_code,
    status: o.status,
    payment: o.payment,
    subtotal: Number(o.subtotal),
    discount: Number(o.discount),
    coupon: o.coupon_code,
    delivery: Number(o.delivery),
    total: Number(o.total),
    createdAt: o.created_at,
    customer: { name: o.customer_name, phone: o.phone, email: o.email, address: o.address, city: o.city, pincode: o.pincode },
    items: items.filter((i) => i.order_id === o.id).map((i) => ({ productId: i.product_id, name: i.name, color: i.color, price: Number(i.price), qty: i.qty })),
    history: hist.filter((h) => h.order_id === o.id).map((h) => ({ status: h.status, by: h.changed_by, at: h.created_at }))
  }));
}

/**
 * Place an order. Prices, stock, coupon and delivery are re-checked on the server,
 * and stock is reduced inside one transaction so two buyers cannot take the last piece.
 */
router.post('/orders', wrap(async (req, res) => {
  const b = req.body || {};
  const c = b.customer || {};
  const customer = {
    name: clean(c.name, 120), phone: normPhone(c.phone), email: clean(c.email, 190),
    address: clean(c.address, 500), city: clean(c.city, 120), pincode: clean(c.pincode, 10)
  };
  const bad = !customer.name ? 'Please add your name.'
    : !PHONE_RE.test(customer.phone) ? 'Please enter a valid 10-digit mobile number.'
    : !customer.address ? 'Please add your address.'
    : !customer.city ? 'Please add your city or area.'
    : !/^\d{6}$/.test(customer.pincode) ? 'Please enter a 6-digit pincode.' : '';
  if (bad) return res.status(400).json({ error: bad });

  const lines = Array.isArray(b.items) ? b.items : [];
  if (!lines.length) return res.status(400).json({ error: 'Your cart is empty.' });

  const settings = await getSettings();
  const payment = ['cod', 'upi', 'pickup'].includes(b.payment) && settings[b.payment] ? b.payment : null;
  if (!payment) return res.status(400).json({ error: 'Please choose a payment option.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const items = [];
    for (const l of lines) {
      const qty = Math.max(1, parseInt(l.qty, 10) || 0);
      // lock the product row while we check and reduce stock
      await conn.query('SELECT id FROM products WHERE id = ? FOR UPDATE', [Number(l.productId)]);
      const [p] = await loadProducts({ id: Number(l.productId), conn });
      if (!p) throw Object.assign(new Error('One of the products in your cart is no longer available.'), { status: 409 });
      const color = clean(l.color, 80);
      if (color && !p.colors.find((x) => x.name === color)) throw Object.assign(new Error(`${p.name} is no longer available in ${color}.`), { status: 409 });
      if (!color && p.colors.length) throw Object.assign(new Error(`Please choose a colour for ${p.name}.`), { status: 400 });
      const left = stockFor(p, color);
      if (qty > left) throw Object.assign(new Error(`${p.name}${color ? ' (' + color + ')' : ''} now has only ${left} in stock. Please update your cart.`), { status: 409 });
      const col = color ? p.colors.find((x) => x.name === color) : null;
      if (col && col.stock != null) await conn.query('UPDATE product_colors SET stock = stock - ? WHERE id = ?', [qty, col.id]);
      else await conn.query('UPDATE products SET stock = stock - ? WHERE id = ?', [qty, p.id]);
      items.push({ productId: p.id, name: p.name, color, price: p.price, qty });
    }

    const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);
    let discount = 0;
    let couponCode = '';
    if (b.coupon) {
      const [cp] = await conn.query('SELECT code, percent FROM coupons WHERE UPPER(code) = ? AND active = 1', [clean(b.coupon, 40).toUpperCase()]);
      if (cp.length) { discount = Math.round(subtotal * cp[0].percent / 100); couponCode = cp[0].code.toUpperCase(); }
    }
    const delivery = payment === 'pickup' || subtotal - discount >= Number(settings.freeAbove) ? 0 : Number(settings.deliveryFee) || 0;
    const total = Math.max(0, subtotal - discount + delivery);
    const code = orderCode();

    const [r] = await conn.query(
      `INSERT INTO orders (order_code, customer_name, phone, email, address, city, pincode, payment, subtotal, discount, coupon_code, delivery, total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, customer.name, customer.phone, customer.email, customer.address, customer.city, customer.pincode, payment, subtotal, discount, couponCode, delivery, total]
    );
    for (const i of items) {
      await conn.query('INSERT INTO order_items (order_id, product_id, name, color, price, qty) VALUES (?,?,?,?,?,?)', [r.insertId, i.productId, i.name, i.color, i.price, i.qty]);
    }
    await conn.query('INSERT INTO order_history (order_id, status, changed_by) VALUES (?, "placed", "customer")', [r.insertId]);
    await createPaymentForOrder(conn, { id: r.insertId, code, method: payment, total }); // payment history record
    await conn.commit();
    const [order] = await loadOrders('WHERE id = ?', [r.insertId]);
    res.status(201).json(order);
  } catch (e) {
    await conn.rollback();
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  } finally {
    conn.release();
  }
}));

/** "My orders": the browser remembers its order codes; the phone number proves ownership. */
router.post('/orders/lookup', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  const codes = (Array.isArray(req.body.codes) ? req.body.codes : []).map((c) => clean(c, 20)).filter(Boolean).slice(0, 60);
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Enter the mobile number you ordered with.' });
  const orders = codes.length
    ? await loadOrders(`WHERE phone = ? AND order_code IN (${codes.map(() => '?').join(',')})`, [phone, ...codes])
    : await loadOrders('WHERE phone = ? AND created_at > NOW() - INTERVAL 180 DAY', [phone]);
  res.json(orders);
}));

router.post('/orders/:code/cancel', wrap(async (req, res) => {
  const phone = normPhone(req.body.phone);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM orders WHERE order_code = ? AND phone = ? FOR UPDATE', [clean(req.params.code, 20), phone]);
    const o = rows[0];
    if (!o) { await conn.rollback(); return res.status(404).json({ error: 'Order not found.' }); }
    if (o.status !== 'placed') { await conn.rollback(); return res.status(409).json({ error: 'This order is already being processed. Please call us to change it.' }); }
    await restock(conn, o.id);
    await conn.query('UPDATE orders SET status = "cancelled" WHERE id = ?', [o.id]);
    await conn.query('INSERT INTO order_history (order_id, status, changed_by) VALUES (?, "cancelled", "customer")', [o.id]);
    await cancelPaymentForOrder(conn, o.id);
    await conn.commit();
    const [order] = await loadOrders('WHERE id = ?', [o.id]);
    res.json(order);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

/** Put stock back when an order is cancelled. */
async function restock(conn, orderId) {
  const [items] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  for (const i of items) {
    if (!i.product_id) continue;
    if (i.color) {
      const [c] = await conn.query('SELECT id, stock FROM product_colors WHERE product_id = ? AND name = ?', [i.product_id, i.color]);
      if (c.length && c[0].stock != null) { await conn.query('UPDATE product_colors SET stock = stock + ? WHERE id = ?', [i.qty, c[0].id]); continue; }
    }
    await conn.query('UPDATE products SET stock = stock + ? WHERE id = ?', [i.qty, i.product_id]);
  }
}

/* ---------- enquiry forms ---------- */
router.post('/enquiries', wrap(async (req, res) => {
  const b = req.body || {};
  const type = ['consultation', 'quote', 'collaboration', 'partner'].includes(b.type) ? b.type : null;
  const name = clean(b.name, 120);
  const phone = normPhone(b.phone);
  if (!type) return res.status(400).json({ error: 'Unknown form.' });
  if (!name) return res.status(400).json({ error: 'Please add your name.' });
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
  const details = {};
  Object.entries(b.details || {}).slice(0, 20).forEach(([k, v]) => { details[clean(k, 40)] = clean(v, 300); });
  const [r] = await pool.query(
    'INSERT INTO enquiries (type, name, phone, email, details, message, source_page) VALUES (?,?,?,?,?,?,?)',
    [type, name, phone, clean(b.email, 190), JSON.stringify(details), clean(b.message, 3000), clean(b.page, 40)]
  );
  res.status(201).json({ id: r.insertId, ok: true });
}));

module.exports = { router, loadOrders, restock };
