// Copies files that are still in server/uploads into the database (uploaded_files).
// Links do not change (/uploads/<name>), so products and reviews keep working.
// Run once after updating:  npm run uploads:to-db --prefix server
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');
const { ensureFilesTable, saveFile, exists } = require('../src/files');

const DIR = path.join(__dirname, '..', 'uploads');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm' };

(async () => {
  try {
    await ensureFilesTable();
    const names = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((n) => MIME[path.extname(n).toLowerCase()]) : [];
    let added = 0; let skipped = 0;
    for (const name of names) {
      if (await exists(name)) { skipped++; continue; }
      await saveFile({ name, mime: MIME[path.extname(name).toLowerCase()], buffer: fs.readFileSync(path.join(DIR, name)), original: name });
      added++; console.log('Saved  ', name);
    }
    console.log(`\nDone: ${added} file(s) copied into the database, ${skipped} already there.`);
    if (added) console.log('The files in server/uploads can stay as a backup; the website now reads them from the database.');
  } catch (e) {
    console.error('Could not copy files:', e.code || e.message);
    process.exitCode = 1;
  } finally { await pool.end(); }
})();
