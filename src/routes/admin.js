// Admin API: everything in the store is operated from here (requires login).
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { pool, json } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { loadProducts, getSettings, SETTING_DEFAULTS } = require('../store');
const { loadOrders, restock } = require('./public');
// accepts 12,999 / ₹12,999 / 12 999
const num = (v) => Number(String(v ?? '').replace(/[₹,\s]/g, ''));
const { cancelPaymentForOrder } = require('./payments');

const router = express.Router();
router.use(requireAdmin);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);

/* ---------- uploads (photos up to 5 MB, videos up to 20 MB) ---------- */
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const IMG = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const VID = ['video/mp4', 'video/webm'];
// files are kept in memory, then saved in MySQL (see src/files.js) so they survive redeploys
const { saveFile } = require('../files');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(IMG.includes(file.mimetype) || VID.includes(file.mimetype) ? null : new Error('Only JPG, PNG, WebP, GIF images or MP4/WebM videos are allowed.'), true)
});

router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 20 MB.' : err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    if (IMG.includes(req.file.mimetype) && req.file.size > 5 * 1024 * 1024) return res.status(400).json({ error: 'Photos must be 5 MB or smaller.' });
    const name = Date.now() + '-' + crypto.randomBytes(6).toString('hex') + path.extname(req.file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    try {
      await saveFile({ name, mime: req.file.mimetype, buffer: req.file.buffer, original: req.file.originalname });
    } catch (e) {
      console.error('[Uploads] Could not save file in the database:', e.code || e.message);
      return res.status(500).json({ error: e.code === 'ER_NET_PACKET_TOO_LARGE' ? 'The database refused this file because it is too large. Try a smaller file.' : 'Could not save the file. Please try again.' });
    }
    const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
    res.status(201).json({ url: `${base}/uploads/${name}`, type: req.file.mimetype.startsWith('video') ? 'video' : 'image' });
  });
});

/* ---------- dashboard ---------- */
router.get('/stats', wrap(async (req, res) => {
  const [[o]] = await pool.query(`SELECT COUNT(*) total, SUM(status='placed') placed, SUM(status='shipped') shipped,
    COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total END),0) value FROM orders`);
  const [[p]] = await pool.query('SELECT COUNT(*) total, SUM(stock <= 3) low FROM products');
  const [[e]] = await pool.query("SELECT COUNT(*) total, SUM(status='new') fresh FROM enquiries");
  res.json({
    orders: { total: Number(o.total), placed: Number(o.placed || 0), shipped: Number(o.shipped || 0), value: Number(o.value) },
    products: { total: Number(p.total), low: Number(p.low || 0) },
    enquiries: { total: Number(e.total), fresh: Number(e.fresh || 0) }
  });
}));

/* ---------- products ---------- */
router.get('/products', wrap(async (req, res) => res.json(await loadProducts({ includeHidden: true }))));

function readProduct(b) {
  const d = {
    name: clean(b.name, 190),
    cat: clean(b.cat, 30) || 'wall',
    price: num(b.price),
    mrp: num(b.mrp) || 0,
    stock: Math.max(0, parseInt(num(b.stock), 10) || 0),
    description: clean(b.desc, 5000),
    highlights: (Array.isArray(b.highlights) ? b.highlights : []).map((x) => clean(x, 200)).filter(Boolean).slice(0, 8),
    specs: ['material', 'finish', 'dimensions', 'weight', 'care'].reduce((o, k) => { o[k] = clean((b.specs || {})[k], 200); return o; }, {}),
    images: (Array.isArray(b.images) ? b.images : []).map((x) => clean(x, 500)).filter(Boolean).slice(0, 4),
    video: clean(b.video, 500),
    model3d: clean(b.model3d, 30),
    featured: b.featured ? 1 : 0,
    active: b.active === false ? 0 : 1,
    colors: (Array.isArray(b.colors) ? b.colors : []).filter((c) => c && clean(c.name)).slice(0, 12).map((c) => ({
      name: clean(c.name, 80),
      hex: /^#[0-9a-f]{6}$/i.test(c.hex || '') ? c.hex : '#8a6f58',
      stock: c.stock === '' || c.stock == null ? null : Math.max(0, parseInt(num(c.stock), 10) || 0),
      images: (Array.isArray(c.images) ? c.images : []).map((x) => clean(x, 500)).filter(Boolean).slice(0, 4)
    }))
  };
  const bad = !d.name ? 'Add a product name.'
    : !(d.price > 0) ? 'Enter a selling price above 0.'
    : d.mrp && d.mrp < d.price ? 'MRP should be equal to or more than the selling price.' : '';
  return { d, bad };
}

async function saveColors(conn, productId, colors) {
  await conn.query('DELETE FROM product_colors WHERE product_id = ?', [productId]);
  let i = 0;
  for (const c of colors) {
    i += 1;
    await conn.query('INSERT INTO product_colors (product_id, name, hex, stock, images, sort_order) VALUES (?,?,?,?,?,?)',
      [productId, c.name, c.hex, c.stock, JSON.stringify(c.images), i]);
  }
}

router.post('/products', wrap(async (req, res) => {
  const { d, bad } = readProduct(req.body || {});
  if (bad) return res.status(400).json({ error: bad });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO products (name, cat, price, mrp, stock, description, highlights, specs, images, video, model3d, featured, active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.name, d.cat, d.price, d.mrp, d.stock, d.description, JSON.stringify(d.highlights), JSON.stringify(d.specs), JSON.stringify(d.images), d.video, d.model3d, d.featured, d.active]
    );
    await saveColors(conn, r.insertId, d.colors);
    await conn.commit();
    const [p] = await loadProducts({ includeHidden: true, id: r.insertId });
    res.status(201).json(p);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

router.put('/products/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { d, bad } = readProduct(req.body || {});
  if (bad) return res.status(400).json({ error: bad });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      `UPDATE products SET name=?, cat=?, price=?, mrp=?, stock=?, description=?, highlights=?, specs=?, images=?, video=?, model3d=?, featured=?, active=? WHERE id=?`,
      [d.name, d.cat, d.price, d.mrp, d.stock, d.description, JSON.stringify(d.highlights), JSON.stringify(d.specs), JSON.stringify(d.images), d.video, d.model3d, d.featured, d.active, id]
    );
    if (!r.affectedRows) { await conn.rollback(); return res.status(404).json({ error: 'Product not found.' }); }
    await saveColors(conn, id, d.colors);
    await conn.commit();
    const [p] = await loadProducts({ includeHidden: true, id });
    res.json(p);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

router.patch('/products/:id/active', wrap(async (req, res) => {
  const [r] = await pool.query('UPDATE products SET active = ? WHERE id = ?', [req.body.active ? 1 : 0, Number(req.params.id)]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Product not found.' });
  res.json({ ok: true });
}));

router.delete('/products/:id', wrap(async (req, res) => {
  const [r] = await pool.query('DELETE FROM products WHERE id = ?', [Number(req.params.id)]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Product not found.' });
  res.json({ ok: true });
}));

/* ---------- categories ---------- */
router.post('/categories', wrap(async (req, res) => {
  const code = clean(req.body.code, 30).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const name = clean(req.body.name, 80);
  if (!code || !name) return res.status(400).json({ error: 'Add a short code and a name.' });
  await pool.query('INSERT INTO categories (code, name, sort_order) VALUES (?,?,99) ON DUPLICATE KEY UPDATE name = VALUES(name)', [code, name]);
  res.status(201).json({ code, name });
}));

/* ---------- orders ---------- */
router.get('/orders', wrap(async (req, res) => {
  const s = clean(req.query.status, 20);
  res.json(s && s !== 'all' ? await loadOrders('WHERE status = ?', [s]) : await loadOrders('', []));
}));

router.patch('/orders/:id/status', wrap(async (req, res) => {
  const status = req.body.status;
  if (!['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
    const o = rows[0];
    if (!o) { await conn.rollback(); return res.status(404).json({ error: 'Order not found.' }); }
    if (o.status === 'cancelled' && status !== 'cancelled') { await conn.rollback(); return res.status(409).json({ error: 'A cancelled order cannot be reopened. Ask the customer to order again.' }); }
    if (status === 'cancelled' && o.status !== 'cancelled') await restock(conn, o.id);
    if (status === 'cancelled' && o.status !== 'cancelled') await cancelPaymentForOrder(conn, o.id);
    await conn.query('UPDATE orders SET status = ? WHERE id = ?', [status, o.id]);
    await conn.query('INSERT INTO order_history (order_id, status, changed_by) VALUES (?,?,?)', [o.id, status, 'admin']);
    await conn.commit();
    const [order] = await loadOrders('WHERE id = ?', [o.id]);
    res.json(order);
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

/* ---------- enquiries (all website forms) ---------- */
router.get('/enquiries', wrap(async (req, res) => {
  const t = clean(req.query.type, 20);
  const [rows] = await pool.query(`SELECT * FROM enquiries ${t && t !== 'all' ? 'WHERE type = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT 500`, t && t !== 'all' ? [t] : []);
  res.json(rows.map((r) => ({ ...r, details: json(r.details, {}) })));
}));

router.patch('/enquiries/:id', wrap(async (req, res) => {
  if (!['new', 'contacted', 'closed'].includes(req.body.status)) return res.status(400).json({ error: 'Unknown status.' });
  await pool.query('UPDATE enquiries SET status = ? WHERE id = ?', [req.body.status, Number(req.params.id)]);
  res.json({ ok: true });
}));

router.delete('/enquiries/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM enquiries WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
}));

/* ---------- settings + coupons ---------- */
router.get('/settings', wrap(async (req, res) => {
  const [coupons] = await pool.query('SELECT id, code, percent, active FROM coupons ORDER BY id');
  res.json({ settings: await getSettings(), coupons: coupons.map((c) => ({ ...c, active: !!c.active })) });
}));

router.put('/settings', wrap(async (req, res) => {
  const b = req.body || {};
  const s = b.settings || {};
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const k of Object.keys(SETTING_DEFAULTS)) {
      if (!(k in s)) continue;
      const def = SETTING_DEFAULTS[k];
      const v = typeof def === 'boolean' ? !!s[k] : typeof def === 'number' ? Math.max(0, Number(s[k]) || 0) : clean(s[k], 300);
      await conn.query('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, JSON.stringify(v)]);
    }
    if (Array.isArray(b.coupons)) {
      const list = b.coupons.filter((c) => c && clean(c.code)).map((c) => ({
        code: clean(c.code, 40).toUpperCase().replace(/\s+/g, ''), percent: Math.min(90, Math.max(1, parseInt(c.percent, 10) || 0)), active: c.active === false ? 0 : 1
      }));
      await conn.query('DELETE FROM coupons');
      for (const c of list) await conn.query('INSERT IGNORE INTO coupons (code, percent, active) VALUES (?,?,?)', [c.code, c.percent, c.active]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  const [coupons] = await pool.query('SELECT id, code, percent, active FROM coupons ORDER BY id');
  res.json({ settings: await getSettings(), coupons: coupons.map((c) => ({ ...c, active: !!c.active })) });
}));

module.exports = router;
