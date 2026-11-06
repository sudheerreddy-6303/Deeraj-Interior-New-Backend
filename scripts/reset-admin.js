// Create the admin account, or reset its password, from server/.env.
// Usage: npm run admin:reset
//        npm run admin:reset -- other@email.com NewPassword123   (any email / password)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

(async () => {
  const [, , argEmail, argPass] = process.argv;
  const email = String(argEmail || process.env.ADMIN_EMAIL || 'admin@deerajinteriors.com').trim().toLowerCase();
  const password = String(argPass || process.env.ADMIN_PASSWORD || '');
  if (password.length < 8) { console.error('Password must have at least 8 characters (set ADMIN_PASSWORD in server/.env or pass it after the email).'); process.exit(1); }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'deeraj_interiors'
  });
  const hash = await bcrypt.hash(password, 10);
  const [rows] = await conn.query('SELECT id FROM admins WHERE email = ?', [email]);
  if (rows.length) {
    await conn.query('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, rows[0].id]);
    console.log(`Password reset for ${email}. You can sign in at /admin now.`);
  } else {
    await conn.query('INSERT INTO admins (name, email, password_hash) VALUES (?,?,?)', [process.env.ADMIN_NAME || 'Store Admin', email, hash]);
    console.log(`Admin created: ${email}. You can sign in at /admin now.`);
  }
  await conn.end();
})().catch((e) => {
  console.error(e.code === 'ER_NO_SUCH_TABLE' ? 'Tables are missing. Run: npm run db:setup' : 'Could not reset admin: ' + (e.code || e.message));
  process.exit(1);
});
