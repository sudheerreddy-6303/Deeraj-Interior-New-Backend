// Bulk-add products to the online store from the backend (no admin panel needed).
//
// 1. Put product photos/videos in server/import/images/
// 2. Fill server/import/products.csv (open it in Excel, then "Save As → CSV UTF-8")
// 3. Run:  npm run import:products            (adds new products, updates ones with the same name)
//          npm run import:products -- --dry   (only checks the file, saves nothing)
//
// CSV columns (first row = headers):
//   name*, category*, price*, mrp, stock*, description, highlights, material, finish, dimensions,
//   weight, care, photos, video, colors, featured, visible, model3d
// - category:   a code like wall / sculpt / furn / table / light (a new code is created automatically)
// - highlights: separate with |            e.g.  Ready to hang|Solid wood frame
// - photos:     up to 4 file names, |        e.g.  vase-1.jpg|vase-2.jpg|vase-3.jpg|vase-4.jpg
// - video:      one file name               e.g.  vase.mp4
// - colors:     Name:#hex:stock:photo1+photo2, separated by ;   e.g.  Ivory:#efe7da:8:ivory.jpg;Sage:#8c9b87:6
// - featured / visible: yes or no (visible defaults to yes)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const CSV = process.argv.find((a) => a.endsWith('.csv')) || path.join(ROOT, 'import', 'products.csv');
const IMG_DIR = path.join(path.dirname(CSV), 'images');
const UPLOADS = path.join(ROOT, 'uploads');
const DRY = process.argv.includes('--dry');
const BASE = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

function parseCSV(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

const yes = (v, d) => (v === undefined || String(v).trim() === '' ? d : /^(y|yes|true|1)$/i.test(String(v).trim()));
const list = (v, sep = '|') => String(v || '').split(sep).map((x) => x.trim()).filter(Boolean);

/** Queue a file from import/images to be saved in the database (uploaded_files) and return its public URL. */
const PENDING = [];
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
function upload(file, problems, rowNo) {
  const src = path.join(IMG_DIR, file);
  if (!fs.existsSync(src)) { problems.push(`Row ${rowNo}: file not found in import/images: ${file}`); return null; }
  const ext = path.extname(file).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.mp4', '.webm'].includes(ext)) { problems.push(`Row ${rowNo}: unsupported file type: ${file}`); return null; }
  const max = ['.mp4', '.webm'].includes(ext) ? 20 : 5;
  if (fs.statSync(src).size > max * 1024 * 1024) { problems.push(`Row ${rowNo}: ${file} is larger than ${max} MB`); return null; }
  const name = Date.now() + '-' + crypto.randomBytes(5).toString('hex') + ext;
  PENDING.push({ name, mime: MIME[ext], src, original: file });
  return `${BASE}/uploads/${name}`;
}

(async () => {
  if (!fs.existsSync(CSV)) { console.error(`CSV not found: ${CSV}`); process.exit(1); }
  const rows = parseCSV(fs.readFileSync(CSV, 'utf8'));
  const head = rows.shift().map((h) => h.trim().toLowerCase().replace(/\*$/, ''));
  const get = (r, k) => { const i = head.indexOf(k); return i < 0 ? '' : String(r[i] || '').trim(); };
  for (const need of ['name', 'category', 'price', 'stock']) if (!head.includes(need)) { console.error(`Missing column: ${need}`); process.exit(1); }

  const problems = [];
  const items = rows.map((r, idx) => {
    const n = idx + 2; // spreadsheet row number
    const p = {
      name: get(r, 'name'), cat: get(r, 'category').toLowerCase(), price: Number(get(r, 'price')), mrp: Number(get(r, 'mrp')) || 0,
      stock: parseInt(get(r, 'stock'), 10), description: get(r, 'description'), highlights: list(get(r, 'highlights')).slice(0, 8),
      specs: { material: get(r, 'material'), finish: get(r, 'finish'), dimensions: get(r, 'dimensions'), weight: get(r, 'weight'), care: get(r, 'care') },
      featured: yes(get(r, 'featured'), false) ? 1 : 0, active: yes(get(r, 'visible'), true) ? 1 : 0, model3d: get(r, 'model3d'),
      photos: list(get(r, 'photos')).slice(0, 4), video: get(r, 'video'),
      colors: list(get(r, 'colors'), ';').map((c) => { const [name, hex, stock, photos] = c.split(':').map((x) => (x || '').trim()); return { name, hex: /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#8a6f58', stock: stock === '' || stock == null ? null : Math.max(0, parseInt(stock, 10) || 0), photos: list(photos, '+').slice(0, 4) }; }).filter((c) => c.name),
      row: n
    };
    if (!p.name) problems.push(`Row ${n}: name is empty`);
    if (!p.cat) problems.push(`Row ${n}: category is empty`);
    if (!(p.price > 0)) problems.push(`Row ${n}: price must be above 0`);
    if (p.mrp && p.mrp < p.price) problems.push(`Row ${n}: MRP is less than price`);
    if (!(p.stock >= 0)) problems.push(`Row ${n}: stock must be 0 or more`);
    return p;
  });
  if (problems.length) { console.error('Please fix these rows and run again:\n - ' + problems.join('\n - ')); process.exit(1); }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'deeraj_interiors', charset: 'utf8mb4'
  });
  let added = 0; let updated = 0;
  try {
    await require('../src/files').ensureFilesTable(conn); // before the transaction (CREATE TABLE would end it)
    await conn.beginTransaction();
    for (const p of items) {
      const fileProblems = [];
      const images = p.photos.map((f) => upload(f, fileProblems, p.row)).filter(Boolean);
      const video = p.video ? upload(p.video, fileProblems, p.row) || '' : '';
      const colors = p.colors.map((c) => ({ ...c, images: c.photos.map((f) => upload(f, fileProblems, p.row)).filter(Boolean) }));
      if (fileProblems.length) throw new Error('Please fix these files and run again:\n - ' + fileProblems.join('\n - '));

      await conn.query('INSERT IGNORE INTO categories (code, name, sort_order) VALUES (?, ?, 99)', [p.cat, p.cat.charAt(0).toUpperCase() + p.cat.slice(1)]);
      const [found] = await conn.query('SELECT id, images, video FROM products WHERE name = ? LIMIT 1', [p.name]);
      const vals = [p.cat, p.price, p.mrp, p.stock, p.description, JSON.stringify(p.highlights), JSON.stringify(p.specs), p.model3d, p.featured, p.active];
      let id;
      if (found.length) {
        id = found[0].id;
        // keep existing photos/video when the row leaves them empty
        const keepImgs = images.length ? JSON.stringify(images) : (typeof found[0].images === 'string' ? found[0].images : JSON.stringify(found[0].images || []));
        await conn.query('UPDATE products SET cat=?, price=?, mrp=?, stock=?, description=?, highlights=?, specs=?, model3d=?, featured=?, active=?, images=?, video=? WHERE id=?',
          [...vals, keepImgs, video || found[0].video || '', id]);
        updated += 1;
      } else {
        const [r] = await conn.query('INSERT INTO products (cat, price, mrp, stock, description, highlights, specs, model3d, featured, active, images, video, name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [...vals, JSON.stringify(images), video, p.name]);
        id = r.insertId; added += 1;
      }
      if (colors.length) {
        await conn.query('DELETE FROM product_colors WHERE product_id = ?', [id]);
        let k = 0;
        for (const c of colors) await conn.query('INSERT INTO product_colors (product_id, name, hex, stock, images, sort_order) VALUES (?,?,?,?,?,?)', [id, c.name, c.hex, c.stock, JSON.stringify(c.images), ++k]);
      }
      console.log(`${found.length ? 'Updated' : 'Added  '}  ${p.name}  (${images.length} photos${video ? ', video' : ''}${colors.length ? ', ' + colors.length + ' colours' : ''})`);
    }
    // photos and videos go into the database together with the products (same transaction)
    for (const f of PENDING) await require('../src/files').saveFile({ name: f.name, mime: f.mime, buffer: fs.readFileSync(f.src), original: f.original }, conn);
    if (DRY) { await conn.rollback(); console.log(`\nDry run OK: ${items.length} rows are valid. Nothing was saved.`); }
    else { await conn.commit(); console.log(`\nDone: ${added} added, ${updated} updated. They are live in the Online Store now.`); }
  } catch (e) {
    await conn.rollback();
    console.error(e.message.startsWith('Please') ? e.message : 'Import failed, nothing was saved: ' + e.message);
    process.exitCode = 1;
  } finally { await conn.end(); }
})();
