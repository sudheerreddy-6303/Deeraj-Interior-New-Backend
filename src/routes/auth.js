const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { sign, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// simple in-memory brute-force guard: 10 failed attempts per IP per 15 minutes
const fails = new Map();
function tooMany(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.at > 15 * 60 * 1000) { fails.delete(ip); return false; }
  return f.n >= 10;
}

router.post('/login', async (req, res, next) => {
  try {
    const ip = req.ip;
    if (tooMany(ip)) return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const [rows] = await pool.query('SELECT * FROM admins WHERE email = ?', [email]);
    const admin = rows[0];
    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      const f = fails.get(ip) || { n: 0, at: Date.now() };
      f.n += 1; fails.set(ip, f);
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    fails.delete(ip);
    res.json({ token: sign(admin), admin: { id: admin.id, name: admin.name, email: admin.email } });
  } catch (e) {
    // database not reachable / tables missing → say so instead of a generic error
    if (e.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'The admin table is missing. On the server run: npm run db:setup' });
    if (e.code && /^(ECONNREFUSED|ER_ACCESS_DENIED_ERROR|ER_BAD_DB_ERROR|ENOTFOUND|ETIMEDOUT|PROTOCOL_CONNECTION_LOST)$/.test(e.code)) {
      return res.status(503).json({ error: `The server cannot connect to MySQL (${e.code}). Check the DB_ settings in server/.env.` });
    }
    next(e);
  }
});

router.get('/me', requireAdmin, (req, res) => res.json({ admin: req.admin }));

router.post('/password', requireAdmin, async (req, res, next) => {
  try {
    const { current, next: nextPw } = req.body || {};
    if (!nextPw || String(nextPw).length < 8) return res.status(400).json({ error: 'The new password needs at least 8 characters.' });
    const [rows] = await pool.query('SELECT * FROM admins WHERE id = ?', [req.admin.id]);
    if (!rows[0] || !(await bcrypt.compare(String(current || ''), rows[0].password_hash))) return res.status(400).json({ error: 'Your current password is incorrect.' });
    await pool.query('UPDATE admins SET password_hash = ? WHERE id = ?', [await bcrypt.hash(String(nextPw), 10), req.admin.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
