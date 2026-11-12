// Uploaded photos and videos are stored inside MySQL, so they survive redeploys on hosts with
// temporary disks (Railway, Render) — no volume needed.
//
//   uploaded_files       one row per file (name, type, size)
//   uploaded_file_parts  the file's bytes in 1 MB parts — works with any MySQL max_allowed_packet
//
// Links stay the same as before: /uploads/<name>. The server answers them from the database;
// older files that are still in the server/uploads folder keep working too.
const { pool } = require('./db');

const PART = 1024 * 1024; // 1 MB per row

const TABLES = [
  `CREATE TABLE IF NOT EXISTS uploaded_files (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(120) NOT NULL,
    mime        VARCHAR(60) NOT NULL,
    size        INT NOT NULL DEFAULT 0,
    original    VARCHAR(200) NOT NULL DEFAULT '',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_uploaded_files_name (name)
  )`,
  `CREATE TABLE IF NOT EXISTS uploaded_file_parts (
    file_id     INT NOT NULL,
    seq         INT NOT NULL,
    data        MEDIUMBLOB NOT NULL,
    PRIMARY KEY (file_id, seq),
    CONSTRAINT fk_file_parts_file FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE CASCADE
  )`
];
const TABLE = TABLES.join(';\n'); // for reference / SQL file

async function ensureFilesTable(conn = pool) { for (const t of TABLES) await conn.query(t); }

/** Save a file (Buffer). `conn` may be a connection inside a transaction; otherwise one is used here. */
async function saveFile({ name, mime, buffer, original = '' }, conn) {
  const own = !conn;
  const c = conn || await pool.getConnection();
  try {
    if (own) await c.beginTransaction();
    const [r] = await c.query('INSERT INTO uploaded_files (name, mime, size, original) VALUES (?,?,?,?)', [name, mime, buffer.length, String(original).slice(0, 200)]);
    for (let at = 0, seq = 0; at < buffer.length || seq === 0; at += PART, seq++) {
      await c.query('INSERT INTO uploaded_file_parts (file_id, seq, data) VALUES (?,?,?)', [r.insertId, seq, buffer.subarray(at, at + PART)]);
    }
    if (own) await c.commit();
  } catch (e) { if (own) await c.rollback(); throw e; } finally { if (own) c.release(); }
  return name;
}

const exists = async (name) => { const [[r]] = await pool.query('SELECT 1 AS ok FROM uploaded_files WHERE name = ?', [name]); return !!r; };

// GET /uploads/:name — sends the file from MySQL, part by part (low memory). Supports Range
// requests so videos play and seek (Safari/iPhone needs this). Unknown names fall through.
async function serveFile(req, res, next) {
  try {
    const name = String(req.params.name || '');
    if (!/^[\w.-]{1,120}$/.test(name)) return next();
    const [[f]] = await pool.query('SELECT id, mime, size, created_at FROM uploaded_files WHERE name = ?', [name]);
    if (!f) return next();
    const etag = `"${name}"`;
    res.set({ 'Content-Type': f.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag, 'Last-Modified': new Date(f.created_at).toUTCString() });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    const size = Number(f.size);
    let start = 0;
    let end = size - 1;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && size > 0) {
      if (m[1] === '' && m[2] !== '') start = Math.max(0, size - Number(m[2]));
      else { start = Number(m[1] || 0); if (m[2] !== '') end = Math.min(size - 1, Number(m[2])); }
      if (start > end || start >= size) { res.set('Content-Range', `bytes */${size}`); return res.status(416).end(); }
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.set('Content-Length', String(Math.max(0, end - start + 1)));
    if (req.method === 'HEAD' || size === 0) return res.end();

    // send only the parts that cover start..end, one at a time
    for (let seq = Math.floor(start / PART); seq <= Math.floor(end / PART); seq++) {
      const [[p]] = await pool.query('SELECT data FROM uploaded_file_parts WHERE file_id = ? AND seq = ?', [f.id, seq]);
      if (!p) break;
      const from = seq * PART;
      const chunk = p.data.subarray(Math.max(0, start - from), Math.min(p.data.length, end - from + 1));
      if (!res.write(chunk)) await new Promise((ok) => res.once('drain', ok));
      if (res.destroyed) return;
    }
    res.end();
  } catch (e) { if (res.headersSent) res.destroy(); else next(e); }
}

module.exports = { TABLE, TABLES, PART, ensureFilesTable, saveFile, serveFile, exists };
