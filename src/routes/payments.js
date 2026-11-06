// Payments: history, refunds and Razorpay settings for the admin panel.
//
// Today the store takes Cash on delivery, UPI on delivery and Pickup — every order gets a payment
// record here, and the admin marks it paid when the money is received.
// Razorpay (online payments) is prepared: tables have the Razorpay columns, the webhook below
// verifies Razorpay's signature, and Admin → Payment settings shows whether the keys are set.
// Keys live only in server/.env (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET).
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { resolveRange, OFFSET } = require('../dates');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS payments (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    order_id            INT NOT NULL,
    order_code          VARCHAR(20) NOT NULL,
    provider            ENUM('offline','razorpay') NOT NULL DEFAULT 'offline',
    method              VARCHAR(30) NOT NULL,
    amount              DECIMAL(10,2) NOT NULL,
    currency            CHAR(3) NOT NULL DEFAULT 'INR',
    status              ENUM('pending','paid','failed','cancelled','refunded','partially_refunded') NOT NULL DEFAULT 'pending',
    refunded_amount     DECIMAL(10,2) NOT NULL DEFAULT 0,
    reference           VARCHAR(120) DEFAULT '',
    razorpay_order_id   VARCHAR(60) DEFAULT NULL,
    razorpay_payment_id VARCHAR(60) DEFAULT NULL,
    razorpay_signature  VARCHAR(200) DEFAULT NULL,
    method_detail       VARCHAR(60) DEFAULT '',
    notes               VARCHAR(500) DEFAULT '',
    paid_at             DATETIME NULL,
    created_at          DATETIME NOT NULL,
    updated_at          DATETIME NOT NULL,
    UNIQUE KEY uq_payment_order (order_id),
    INDEX idx_pay_status (status),
    INDEX idx_pay_created (created_at),
    INDEX idx_pay_rzp_order (razorpay_order_id),
    CONSTRAINT fk_payment_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS refunds (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    payment_id         INT NOT NULL,
    order_code         VARCHAR(20) NOT NULL,
    amount             DECIMAL(10,2) NOT NULL,
    reason             VARCHAR(300) DEFAULT '',
    mode               ENUM('manual','razorpay') NOT NULL DEFAULT 'manual',
    status             ENUM('pending','processed','failed') NOT NULL DEFAULT 'processed',
    reference          VARCHAR(120) DEFAULT '',
    razorpay_refund_id VARCHAR(60) DEFAULT NULL,
    created_by         VARCHAR(190) DEFAULT '',
    created_at         DATETIME NOT NULL,
    INDEX idx_refund_created (created_at),
    CONSTRAINT fk_refund_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`
];

/** Creates the tables if needed and adds a payment record for any order that has none (older orders). */
async function ensurePaymentTables() {
  for (const sql of TABLES) await pool.query(sql);
  await pool.query(`INSERT INTO payments (order_id, order_code, provider, method, amount, status, created_at, updated_at)
    SELECT o.id, o.order_code, 'offline', o.payment, o.total,
      CASE WHEN o.status = 'cancelled' THEN 'cancelled' ELSE 'pending' END,
      CONVERT_TZ(o.created_at, @@session.time_zone, '+00:00'), UTC_TIMESTAMP()
    FROM orders o LEFT JOIN payments p ON p.order_id = o.id WHERE p.id IS NULL`);
}

/** Called when an order is placed (inside the order transaction). */
async function createPaymentForOrder(conn, order) {
  await conn.query(`INSERT IGNORE INTO payments (order_id, order_code, provider, method, amount, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
  [order.id, order.code, order.method === 'razorpay' ? 'razorpay' : 'offline', order.method, order.total]);
}

/** Called when an order is cancelled: an unpaid payment is closed. Paid ones stay for a refund. */
async function cancelPaymentForOrder(conn, orderId) {
  await conn.query("UPDATE payments SET status = 'cancelled', updated_at = UTC_TIMESTAMP() WHERE order_id = ? AND status = 'pending'", [orderId]);
}

/* ---------- Razorpay configuration (keys only from .env) ---------- */
function razorpayConfig() {
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  const hasSecret = !!process.env.RAZORPAY_KEY_SECRET;
  const mode = keyId.startsWith('rzp_live_') ? 'live' : keyId.startsWith('rzp_test_') ? 'test' : '';
  return { configured: !!keyId && hasSecret, keyId, mode, hasSecret, hasWebhookSecret: !!process.env.RAZORPAY_WEBHOOK_SECRET };
}

/** Calls the Razorpay REST API (used for refunds of online payments). */
async function razorpayApi(path, body) {
  const c = razorpayConfig();
  if (!c.configured) throw Object.assign(new Error('Razorpay keys are not set in server/.env.'), { status: 400, expose: true });
  const res = await fetch('https://api.razorpay.com/v1' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64') },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error('Razorpay: ' + ((data.error && data.error.description) || res.status)), { status: 502, expose: true });
  return data;
}

/* ---------- Razorpay webhook (needs the raw request body) ---------- */
const webhookRouter = express.Router();
webhookRouter.post('/payments/razorpay/webhook', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook secret not set.' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = String(req.headers['x-razorpay-signature'] || '');
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    return res.status(400).json({ error: 'Invalid signature.' });
  }
  let evt;
  try { evt = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Bad JSON.' }); }
  const pay = evt.payload && evt.payload.payment && evt.payload.payment.entity;
  const ref = evt.payload && evt.payload.refund && evt.payload.refund.entity;
  if ((evt.event === 'payment.captured' || evt.event === 'order.paid') && pay && pay.order_id) {
    await pool.query(`UPDATE payments SET status = 'paid', provider = 'razorpay', razorpay_payment_id = ?, method_detail = ?, paid_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
      WHERE razorpay_order_id = ? AND status IN ('pending','failed')`, [pay.id, clean(pay.method, 60), pay.order_id]);
  } else if (evt.event === 'payment.failed' && pay && pay.order_id) {
    await pool.query("UPDATE payments SET status = 'failed', notes = ?, updated_at = UTC_TIMESTAMP() WHERE razorpay_order_id = ? AND status = 'pending'",
      [clean(pay.error_description, 500), pay.order_id]);
  } else if (evt.event === 'refund.processed' && ref) {
    await pool.query("UPDATE refunds SET status = 'processed' WHERE razorpay_refund_id = ?", [ref.id]);
  }
  res.json({ ok: true });
}));

/* ---------- admin APIs ---------- */
const adminRouter = express.Router();
adminRouter.use(requireAdmin);

const local = (col) => `DATE_FORMAT(DATE_ADD(${col}, INTERVAL ${OFFSET} MINUTE), '%Y-%m-%d %H:%i')`;
const mapPayment = (p) => ({
  id: p.id, orderId: p.order_id, orderCode: p.order_code, provider: p.provider, method: p.method, amount: Number(p.amount),
  status: p.status, refunded: Number(p.refunded_amount), reference: p.reference, methodDetail: p.method_detail, notes: p.notes,
  razorpayOrderId: p.razorpay_order_id, razorpayPaymentId: p.razorpay_payment_id,
  createdAt: p.created_local, paidAt: p.paid_local, customer: { name: p.customer_name, phone: p.phone, email: p.email }, orderStatus: p.order_status
});

adminRouter.get('/payments', wrap(async (req, res) => {
  const r = resolveRange(req.query);
  if (r.error) return res.status(400).json({ error: r.error });
  const where = []; const args = [];
  if (!r.all) { where.push('p.created_at >= ? AND p.created_at < ?'); args.push(r.start, r.end); }
  const status = clean(req.query.status, 30);
  if (status && status !== 'all') { where.push('p.status = ?'); args.push(status); }
  const method = clean(req.query.method, 30);
  if (method && method !== 'all') { where.push('p.method = ?'); args.push(method); }
  const q = clean(req.query.q, 60);
  if (q) { where.push('(p.order_code LIKE ? OR o.customer_name LIKE ? OR o.phone LIKE ? OR p.razorpay_payment_id LIKE ? OR p.reference LIKE ?)'); args.push(...Array(5).fill(`%${q}%`)); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [rows] = await pool.query(`SELECT p.*, ${local('p.created_at')} created_local, ${local('p.paid_at')} paid_local,
      o.customer_name, o.phone, o.email, o.status order_status
    FROM payments p JOIN orders o ON o.id = p.order_id ${W} ORDER BY p.created_at DESC, p.id DESC LIMIT 1000`, args);
  const list = rows.map(mapPayment);
  const sum = (f) => r2(list.filter(f).reduce((a, p) => a + p.amount, 0));
  res.json({
    from: r.from || null, to: r.to || null, today: r.today,
    summary: {
      collected: r2(list.filter((p) => ['paid', 'partially_refunded', 'refunded'].includes(p.status)).reduce((a, p) => a + p.amount, 0)),
      refunded: r2(list.reduce((a, p) => a + p.refunded, 0)),
      pending: sum((p) => p.status === 'pending'),
      pendingCount: list.filter((p) => p.status === 'pending').length,
      online: list.filter((p) => p.provider === 'razorpay').length,
      count: list.length
    },
    payments: list
  });
}));

adminRouter.post('/payments/:id/mark-paid', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM payments WHERE id = ?', [Number(req.params.id)]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Payment not found.' });
  if (p.status !== 'pending' && p.status !== 'failed') return res.status(409).json({ error: `This payment is already ${p.status.replace('_', ' ')}.` });
  if (p.provider === 'razorpay') return res.status(409).json({ error: 'Online payments are marked paid automatically by Razorpay.' });
  await pool.query("UPDATE payments SET status = 'paid', reference = ?, method_detail = ?, notes = ?, paid_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?",
    [clean(req.body.reference, 120), clean(req.body.methodDetail, 60), clean(req.body.notes, 500), p.id]);
  res.json({ ok: true });
}));

adminRouter.post('/payments/:id/refund', wrap(async (req, res) => {
  const amount = r2(req.body.amount);
  const reason = clean(req.body.reason, 300);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM payments WHERE id = ? FOR UPDATE', [Number(req.params.id)]);
    const p = rows[0];
    if (!p) { await conn.rollback(); return res.status(404).json({ error: 'Payment not found.' }); }
    if (!['paid', 'partially_refunded'].includes(p.status)) { await conn.rollback(); return res.status(409).json({ error: 'Only paid payments can be refunded.' }); }
    const left = r2(Number(p.amount) - Number(p.refunded_amount));
    if (!(amount > 0) || amount > left) { await conn.rollback(); return res.status(400).json({ error: `Enter a refund amount between ₹1 and ₹${left}.` }); }
    if (!reason) { await conn.rollback(); return res.status(400).json({ error: 'Add a reason for the refund.' }); }
    let mode = 'manual'; let rzpId = null; let status = 'processed';
    if (p.provider === 'razorpay' && p.razorpay_payment_id) {
      const rf = await razorpayApi(`/payments/${p.razorpay_payment_id}/refund`, { amount: Math.round(amount * 100), notes: { reason, order: p.order_code } });
      mode = 'razorpay'; rzpId = rf.id; status = rf.status === 'processed' ? 'processed' : 'pending';
    }
    await conn.query('INSERT INTO refunds (payment_id, order_code, amount, reason, mode, status, reference, razorpay_refund_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())',
      [p.id, p.order_code, amount, reason, mode, status, clean(req.body.reference, 120), rzpId, req.admin.email]);
    const total = r2(Number(p.refunded_amount) + amount);
    await conn.query('UPDATE payments SET refunded_amount = ?, status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [total, total >= Number(p.amount) ? 'refunded' : 'partially_refunded', p.id]);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

adminRouter.get('/refunds', wrap(async (req, res) => {
  const r = resolveRange(req.query);
  if (r.error) return res.status(400).json({ error: r.error });
  const W = r.all ? '' : 'WHERE f.created_at >= ? AND f.created_at < ?';
  const [rows] = await pool.query(`SELECT f.*, ${local('f.created_at')} created_local, p.method, p.provider, p.amount paid_amount, o.customer_name, o.phone
    FROM refunds f JOIN payments p ON p.id = f.payment_id JOIN orders o ON o.id = p.order_id ${W} ORDER BY f.created_at DESC, f.id DESC LIMIT 1000`, r.all ? [] : [r.start, r.end]);
  const list = rows.map((f) => ({
    id: f.id, orderCode: f.order_code, amount: Number(f.amount), reason: f.reason, mode: f.mode, status: f.status, reference: f.reference,
    razorpayRefundId: f.razorpay_refund_id, by: f.created_by, createdAt: f.created_local, method: f.method, paidAmount: Number(f.paid_amount),
    customer: { name: f.customer_name, phone: f.phone }
  }));
  res.json({ from: r.from || null, to: r.to || null, today: r.today, total: r2(list.reduce((a, f) => a + f.amount, 0)), refunds: list });
}));

adminRouter.get('/payments/config', wrap(async (req, res) => {
  const c = razorpayConfig();
  const [rows] = await pool.query("SELECT v FROM settings WHERE k = 'razorpayEnabled'");
  let enabled = false;
  try { enabled = rows.length ? JSON.parse(typeof rows[0].v === 'string' ? rows[0].v : JSON.stringify(rows[0].v)) === true : false; } catch (e) { enabled = false; }
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  res.json({
    razorpay: { configured: c.configured, mode: c.mode, keyId: c.keyId ? c.keyId.slice(0, 12) + '…' : '', hasWebhookSecret: c.hasWebhookSecret, enabled: enabled && c.configured },
    webhookUrl: (base || 'https://YOUR-API-DOMAIN') + '/api/payments/razorpay/webhook'
  });
}));

adminRouter.put('/payments/config', wrap(async (req, res) => {
  const on = !!req.body.razorpayEnabled;
  if (on && !razorpayConfig().configured) return res.status(400).json({ error: 'Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to server/.env and restart the API first.' });
  await pool.query("INSERT INTO settings (k, v) VALUES ('razorpayEnabled', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(on)]);
  res.json({ ok: true, enabled: on });
}));

module.exports = { webhookRouter, adminRouter, ensurePaymentTables, createPaymentForOrder, cancelPaymentForOrder, TABLES };
