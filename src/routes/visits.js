// Visitor counter: the website records one row per page view in `page_visits`.
// No names, phone numbers or IP addresses are stored — only a random browser ID,
// the page path, the device type and the referring site.
const express = require('express');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Dates on the dashboard follow Indian time by default (UTC+5:30). Change with TZ_OFFSET_MINUTES in .env.
const OFFSET = Number(process.env.TZ_OFFSET_MINUTES || 330);

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS page_visits (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  visitor_id  CHAR(36)     NOT NULL,
  path        VARCHAR(255) NOT NULL,
  device      ENUM('mobile','tablet','desktop') DEFAULT 'desktop',
  referrer    VARCHAR(255) DEFAULT '',
  created_at  DATETIME     NOT NULL,
  INDEX idx_visits_time (created_at),
  INDEX idx_visits_visitor (visitor_id, created_at)
) ENGINE=InnoDB`;

/** Creates the table automatically on databases set up before visitor counting existed. */
async function ensureVisitsTable() {
  await pool.query(CREATE_SQL);
}

/* ---------- public: record a page view ---------- */
const publicRouter = express.Router();
const BOT = /bot|crawl|spider|slurp|bing|google|yandex|baidu|duckduck|facebookexternalhit|preview|headless|lighthouse|pingdom|uptime/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const recent = new Map(); // visitor+path → time, to ignore double counts within 10 seconds
const perIp = new Map();  // simple flood guard: 120 page views per IP per 10 minutes

publicRouter.post('/track', wrap(async (req, res) => {
  res.status(204).end(); // reply immediately; the visitor never waits for this
  const b = req.body || {};
  const ua = String(req.headers['user-agent'] || '');
  const vid = String(b.visitorId || '');
  let path = String(b.path || '').split('?')[0].slice(0, 255);
  if (!UUID.test(vid) || !path.startsWith('/') || path.startsWith('/admin') || BOT.test(ua)) return;
  path = path.replace(/\/+$/, '') || '/';

  const now = Date.now();
  const key = vid + path;
  if (recent.has(key) && now - recent.get(key) < 10000) return;
  recent.set(key, now);
  const ip = req.ip;
  const f = perIp.get(ip);
  if (f && now - f.at < 600000) { if (++f.n > 120) return; } else perIp.set(ip, { n: 1, at: now });
  if (recent.size > 5000) for (const [k, t] of recent) if (now - t > 10000) recent.delete(k);
  if (perIp.size > 5000) for (const [k, v] of perIp) if (now - v.at > 600000) perIp.delete(k);

  const device = ['mobile', 'tablet', 'desktop'].includes(b.device) ? b.device : 'desktop';
  let ref = '';
  try { const r = new URL(String(b.referrer || '')); if (r.host && r.host !== req.headers.host) ref = r.host.slice(0, 255); } catch (e) { /* no referrer */ }
  await pool.query('INSERT INTO page_visits (visitor_id, path, device, referrer, created_at) VALUES (?,?,?,?,UTC_TIMESTAMP())', [vid, path, device, ref]);
}));

/* ---------- admin: visit statistics ---------- */
const adminRouter = express.Router();
adminRouter.use(requireAdmin);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
/** Today's date in the site's time zone, as YYYY-MM-DD. */
const localToday = () => ymd(new Date(Date.now() + OFFSET * 60000));
/** Local midnight of a YYYY-MM-DD date → UTC 'YYYY-MM-DD HH:MM:SS' for SQL. */
function utcStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - OFFSET * 60000);
  return `${ymd(t)} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}
const addDays = (dateStr, n) => { const [y, m, d] = dateStr.split('-').map(Number); return ymd(new Date(Date.UTC(y, m - 1, d + n))); };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

adminRouter.get('/visits', wrap(async (req, res) => {
  const today = localToday();
  const range = String(req.query.range || 'today');
  let from; let to;
  if (range === 'today') { from = today; to = today; }
  else if (range === 'yesterday') { from = addDays(today, -1); to = from; }
  else if (range === '7d') { from = addDays(today, -6); to = today; }
  else if (range === '30d') { from = addDays(today, -29); to = today; }
  else if (range === 'custom') {
    from = String(req.query.from || ''); to = String(req.query.to || '');
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: 'Choose both a start date and an end date.' });
    if (from > to) return res.status(400).json({ error: 'The start date must be on or before the end date.' });
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    if (days > 366) return res.status(400).json({ error: 'Choose a range of one year or less.' });
  } else return res.status(400).json({ error: 'Unknown range.' });

  const start = utcStart(from);
  const end = utcStart(addDays(to, 1));
  const W = 'created_at >= ? AND created_at < ?';
  const args = [start, end];
  const local = `DATE_ADD(created_at, INTERVAL ${OFFSET} MINUTE)`;
  const single = from === to;

  const [[tot]] = await pool.query(`SELECT COUNT(*) views, COUNT(DISTINCT visitor_id) visitors FROM page_visits WHERE ${W}`, args);
  // a "new" visitor is one whose first ever visit falls inside this range
  const [[fresh]] = await pool.query(
    `SELECT COUNT(*) n FROM (SELECT visitor_id, MIN(created_at) first FROM page_visits GROUP BY visitor_id HAVING first >= ? AND first < ?) x`, args);
  const [series] = single
    ? await pool.query(`SELECT HOUR(${local}) k, COUNT(*) views, COUNT(DISTINCT visitor_id) visitors FROM page_visits WHERE ${W} GROUP BY k ORDER BY k`, args)
    : await pool.query(`SELECT DATE_FORMAT(${local}, '%Y-%m-%d') k, COUNT(*) views, COUNT(DISTINCT visitor_id) visitors FROM page_visits WHERE ${W} GROUP BY k ORDER BY k`, args);
  const [pages] = await pool.query(`SELECT path, COUNT(*) views, COUNT(DISTINCT visitor_id) visitors FROM page_visits WHERE ${W} GROUP BY path ORDER BY views DESC LIMIT 10`, args);
  const [devices] = await pool.query(`SELECT device, COUNT(DISTINCT visitor_id) visitors FROM page_visits WHERE ${W} GROUP BY device`, args);
  const [refs] = await pool.query(`SELECT referrer, COUNT(DISTINCT visitor_id) visitors FROM page_visits WHERE ${W} AND referrer <> '' GROUP BY referrer ORDER BY visitors DESC LIMIT 5`, args);
  const [[all]] = await pool.query("SELECT COUNT(*) views, COUNT(DISTINCT visitor_id) visitors, DATE_FORMAT(MIN(created_at), '%Y-%m-%dT%H:%i:%sZ') since FROM page_visits");

  // fill gaps so the chart shows every hour / day, even with zero visits
  const map = new Map(series.map((r) => [String(r.k), r]));
  const points = [];
  if (single) {
    for (let h = 0; h < 24; h++) { const r = map.get(String(h)); points.push({ label: `${pad(h)}:00`, visitors: r ? Number(r.visitors) : 0, views: r ? Number(r.views) : 0 }); }
  } else {
    for (let d = from; d <= to; d = addDays(d, 1)) { const r = map.get(d); points.push({ label: d, visitors: r ? Number(r.visitors) : 0, views: r ? Number(r.views) : 0 }); }
  }

  res.json({
    range, from, to, today, unit: single ? 'hour' : 'day',
    visitors: Number(tot.visitors), views: Number(tot.views), newVisitors: Number(fresh.n),
    points,
    pages: pages.map((p) => ({ path: p.path, views: Number(p.views), visitors: Number(p.visitors) })),
    devices: Object.fromEntries(devices.map((d) => [d.device, Number(d.visitors)])),
    referrers: refs.map((r) => ({ site: r.referrer, visitors: Number(r.visitors) })),
    allTime: { visitors: Number(all.visitors), views: Number(all.views), since: all.since }
  });
}));

module.exports = { publicRouter, adminRouter, ensureVisitsTable, CREATE_SQL };
