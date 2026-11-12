// Client reviews (testimonials) shown on the home page, managed in Admin → Client reviews.
//
// Public:  GET /api/testimonials                 visible reviews in display order
// Admin:   GET/POST /api/admin/testimonials, PUT/DELETE /api/admin/testimonials/:id,
//          POST /api/admin/testimonials/reorder   { ids: [3, 1, 2] }
// The table is created on server start; when it is empty the three original reviews are added.
const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);
const bad = (msg) => Object.assign(new Error(msg), { status: 400, expose: true });

const TABLE = `CREATE TABLE IF NOT EXISTS testimonials (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  place       VARCHAR(160) NOT NULL DEFAULT '',
  project     VARCHAR(160) NOT NULL DEFAULT '',
  review      TEXT NOT NULL,
  rating      TINYINT NOT NULL DEFAULT 5,
  photo       VARCHAR(500) NOT NULL DEFAULT '',
  home_photo  VARCHAR(500) NOT NULL DEFAULT '',
  gallery     TEXT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_testimonials_order (active, sort_order)
)`;

const SEED = [
  ['Mr. Sreedhar Reddy', 'Suchitra, Hyderabad', 'Trividya College', 'Deeraj Interiors provided exceptional, timely and professional designs for Trividya College.', '/img/living-1.jpg', ['/img/living-1.jpg', '/img/kitchen-2.jpg', '/img/wardrobe-1.jpg']],
  ['Mr. Anvesh Reddy', 'Alwal, Hyderabad', '', 'The quality of materials and finishing is outstanding.', '/img/kitchen-1.jpg', ['/img/kitchen-1.jpg', '/img/living-2.jpg', '/img/bedroom-3.jpg']],
  ['Dr. Ratnakar', 'Kompally, Hyderabad', '', 'Very transparent pricing with no hidden costs.', '/img/bedroom-1.jpg', ['/img/bedroom-1.jpg', '/img/wardrobe-2.jpg', '/img/kitchen-2.jpg']]
];

async function ensureTestimonialsTable() {
  await pool.query(TABLE);
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM testimonials');
  if (!Number(row.n)) {
    for (let i = 0; i < SEED.length; i++) {
      const [name, place, project, review, home, gallery] = SEED[i];
      await pool.query('INSERT INTO testimonials (name, place, project, review, rating, home_photo, gallery, sort_order) VALUES (?,?,?,?,5,?,?,?)',
        [name, place, project, review, home, JSON.stringify(gallery), i + 1]);
    }
    console.log('[Reviews] Added the 3 starting client reviews.');
  }
}

const parseList = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : []; } catch (e) { return []; } };
const shape = (r) => ({
  id: r.id, name: r.name, place: r.place, project: r.project, text: r.review, rating: Number(r.rating) || 5,
  photo: r.photo, home: r.home_photo, gallery: parseList(r.gallery), order: r.sort_order, active: !!r.active, updatedAt: r.updated_at
});

// photo paths: uploaded files (/uploads/…, or full https links) and the website's own /img/… photos
const url = (v, label) => {
  const s = clean(v, 500);
  if (s && !/^(https?:\/\/|\/)/i.test(s)) throw bad(`${label}: use an uploaded photo.`);
  return s;
};

function read(b) {
  const name = clean(b.name, 120);
  const text = clean(b.text, 1000);
  if (!name) throw bad('Enter the client name.');
  if (!text) throw bad('Enter the review text.');
  const rating = Math.round(Number(b.rating) || 5);
  if (rating < 1 || rating > 5) throw bad('Rating must be between 1 and 5 stars.');
  const gallery = (Array.isArray(b.gallery) ? b.gallery : []).map((g, i) => url(g, `Home photo ${i + 1}`)).filter(Boolean).slice(0, 3);
  return {
    name, review: text, rating, place: clean(b.place, 160), project: clean(b.project, 160),
    photo: url(b.photo, 'Client photo'), home_photo: url(b.home, 'Main home photo'), gallery: JSON.stringify(gallery),
    active: b.active === false ? 0 : 1
  };
}

/* ---------- public ---------- */
const publicRouter = express.Router();
publicRouter.get('/testimonials', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM testimonials WHERE active = 1 ORDER BY sort_order, id');
  res.set('Cache-Control', 'public, max-age=60');
  res.json(rows.map(shape).map(({ active, order, updatedAt, ...r }) => r)); // eslint-disable-line no-unused-vars
}));

/* ---------- admin ---------- */
const adminRouter = express.Router();
adminRouter.use('/testimonials', requireAdmin);

adminRouter.get('/testimonials', wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM testimonials ORDER BY sort_order, id');
  res.json(rows.map(shape));
}));

adminRouter.post('/testimonials', wrap(async (req, res) => {
  const t = read(req.body || {});
  const [[m]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM testimonials');
  const [r] = await pool.query('INSERT INTO testimonials SET ?', { ...t, sort_order: Number(m.n) + 1 });
  const [[row]] = await pool.query('SELECT * FROM testimonials WHERE id = ?', [r.insertId]);
  res.status(201).json(shape(row));
}));

adminRouter.post('/testimonials/reorder', wrap(async (req, res) => {
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(Number).filter((n) => n > 0);
  if (!ids.length) throw bad('Nothing to reorder.');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < ids.length; i++) await conn.query('UPDATE testimonials SET sort_order = ? WHERE id = ?', [i + 1, ids[i]]);
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  res.json({ ok: true });
}));

adminRouter.put('/testimonials/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [[cur]] = await pool.query('SELECT * FROM testimonials WHERE id = ?', [id]);
  if (!cur) return res.status(404).json({ error: 'This review no longer exists.' });
  // quick show/hide from the list sends only { active }
  const b = req.body || {};
  const t = Object.keys(b).length === 1 && 'active' in b ? { active: b.active ? 1 : 0 } : read({ ...shape(cur), ...b });
  await pool.query('UPDATE testimonials SET ? WHERE id = ?', [t, id]);
  const [[row]] = await pool.query('SELECT * FROM testimonials WHERE id = ?', [id]);
  res.json(shape(row));
}));

adminRouter.delete('/testimonials/:id', wrap(async (req, res) => {
  const [r] = await pool.query('DELETE FROM testimonials WHERE id = ?', [Number(req.params.id)]);
  if (!r.affectedRows) return res.status(404).json({ error: 'This review no longer exists.' });
  res.json({ ok: true });
}));

module.exports = { publicRouter, adminRouter, ensureTestimonialsTable, TABLE };
