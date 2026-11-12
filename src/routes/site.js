// Website content stored in the database and edited in Admin → Website:
//   texts   – hero heading, services line, tagline, stats, phone, email, WhatsApp, social links
//   images  – every photo on the website by slot (e.g. "home.grid.1" → /uploads/…)
//   slides  – home hero slides [{ img, video, title, tag }]
//   locations – experience centres / factory [{ name, address, phone, map }]
//
// The website's built-in photos and logos (server/seed-media) are copied into the database
// (uploaded_files, named site-<file>) when the server starts, so every image is served from MySQL.
//
// Public:  GET /api/site
// Admin:   GET /api/admin/site, PUT /api/admin/site/:section   (section = texts | images | slides | locations)
const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { saveFile, exists } = require('../files');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg) => Object.assign(new Error(msg), { status: 400, expose: true });
const clean = (v, max = 2000) => String(v == null ? '' : v).trim().slice(0, max);

const TABLE = `CREATE TABLE IF NOT EXISTS site_content (
  k           VARCHAR(40) PRIMARY KEY,
  v           MEDIUMTEXT NOT NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`;
const SECTIONS = ['texts', 'images', 'slides', 'locations'];

const SEED_DIR = path.join(__dirname, '..', '..', 'seed-media');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
// website path of each built-in file → name in the database
const libraryEntries = () => (fs.existsSync(SEED_DIR) ? fs.readdirSync(SEED_DIR) : [])
  .filter((f) => MIME[path.extname(f).toLowerCase()])
  .map((f) => [/\.png$/i.test(f) ? `/${f}` : `/img/${f}`, `site-${f}`, f]);

async function ensureSiteContent() {
  await pool.query(TABLE);
  let added = 0;
  for (const [, name, file] of libraryEntries()) {
    if (await exists(name)) continue;
    await saveFile({ name, mime: MIME[path.extname(file).toLowerCase()], buffer: fs.readFileSync(path.join(SEED_DIR, file)), original: file });
    added++;
  }
  if (added) console.log(`[Website] Saved ${added} built-in photo(s)/logo(s) in the database.`);
}

const base = () => (process.env.PUBLIC_URL || '').replace(/\/$/, '');
async function load() {
  const [rows] = await pool.query('SELECT k, v FROM site_content');
  const out = { texts: {}, images: {}, slides: null, locations: null };
  for (const r of rows) { try { out[r.k] = JSON.parse(r.v); } catch (e) { /* ignore broken value */ } }
  const [files] = await pool.query("SELECT name FROM uploaded_files WHERE name LIKE 'site-%'");
  const have = new Set(files.map((f) => f.name));
  out.library = Object.fromEntries(libraryEntries().filter(([, n]) => have.has(n)).map(([p, n]) => [p, `${base()}/uploads/${n}`]));
  return out;
}

const url = (v, label) => {
  const s = clean(v, 500);
  if (s && !/^(https?:\/\/|\/)/i.test(s)) throw bad(`${label}: use an uploaded file.`);
  return s;
};
const link = (v, label) => {
  const s = clean(v, 500);
  if (s && !/^https?:\/\//i.test(s)) throw bad(`${label}: the link must start with https://`);
  return s;
};

const VALIDATE = {
  texts(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('Nothing to save.');
    const out = {};
    for (const [k, v] of Object.entries(b)) {
      if (!/^[a-zA-Z0-9_.]{1,40}$/.test(k)) continue;
      out[k] = /^social\./.test(k) ? link(v, k.replace('social.', '')) : /Url$/.test(k) ? link(v, 'Form link') : clean(v, 2000);
    }
    if ('whatsapp' in out && out.whatsapp && !/^\d{10,15}$/.test(out.whatsapp.replace(/\D/g, ''))) throw bad('WhatsApp number: enter 10 to 15 digits, e.g. 919000700930.');
    if (out.whatsapp) out.whatsapp = out.whatsapp.replace(/\D/g, '');
    if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw bad('Enter a valid email address.');
    return out;
  },
  images(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('Nothing to save.');
    const out = {};
    for (const [k, v] of Object.entries(b)) { if (/^[a-zA-Z0-9_.-]{1,60}$/.test(k) && v) out[k] = url(v, 'Photo'); }
    return out;
  },
  slides(b) {
    if (!Array.isArray(b)) throw bad('Nothing to save.');
    if (b.length > 12) throw bad('Up to 12 hero slides.');
    return b.map((s, i) => {
      const img = url(s && s.img, `Slide ${i + 1} photo`);
      if (!img) throw bad(`Slide ${i + 1}: add a photo.`);
      return { img, video: url(s.video, `Slide ${i + 1} video`), title: clean(s.title, 120), tag: clean(s.tag, 60) };
    });
  },
  locations(b) {
    if (!Array.isArray(b)) throw bad('Nothing to save.');
    if (b.length > 10) throw bad('Up to 10 locations.');
    return b.map((l, i) => {
      const name = clean(l && l.name, 120);
      if (!name) throw bad(`Location ${i + 1}: enter a name.`);
      return { name, address: clean(l.address, 300), phone: clean(l.phone, 30), map: link(l.map, `Location ${i + 1} map link`) };
    });
  }
};

const publicRouter = express.Router();
publicRouter.get('/site', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await load());
}));

const adminRouter = express.Router();
adminRouter.use('/site', requireAdmin);
adminRouter.get('/site', wrap(async (req, res) => res.json(await load())));
adminRouter.put('/site/:section', wrap(async (req, res) => {
  const k = req.params.section;
  if (!SECTIONS.includes(k)) return res.status(404).json({ error: 'Not found.' });
  const v = VALIDATE[k](req.body && req.body.value);
  await pool.query('INSERT INTO site_content (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, JSON.stringify(v)]);
  res.json(await load());
}));
// back to the built-in content for one section
adminRouter.delete('/site/:section', wrap(async (req, res) => {
  if (!SECTIONS.includes(req.params.section)) return res.status(404).json({ error: 'Not found.' });
  await pool.query('DELETE FROM site_content WHERE k = ?', [req.params.section]);
  res.json(await load());
}));

module.exports = { publicRouter, adminRouter, ensureSiteContent, TABLE };
