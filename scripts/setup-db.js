// Creates the database + tables, loads sample data and creates the first admin.
// Usage: npm run db:setup   (reads server/.env)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

(async () => {
  const dbName = process.env.DB_NAME || 'deeraj_interiors';
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
    charset: 'utf8mb4'
  });
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'database', f), 'utf8').replace(/deeraj_interiors/g, dbName);
  console.log('Creating tables…');
  await conn.query(read('schema.sql'));
  console.log('Loading sample data…');
  await conn.query(read('seed.sql'));

  const email = (process.env.ADMIN_EMAIL || 'admin@deerajinteriors.com').toLowerCase();
  const pass = process.env.ADMIN_PASSWORD || 'ChangeMe@123';
  const [rows] = await conn.query(`SELECT id FROM \`${dbName}\`.admins WHERE email = ?`, [email]);
  if (!rows.length) {
    await conn.query(`INSERT INTO \`${dbName}\`.admins (name, email, password_hash) VALUES (?,?,?)`, [process.env.ADMIN_NAME || 'Store Admin', email, await bcrypt.hash(pass, 10)]);
    console.log(`Admin created: ${email}`);
  } else {
    console.log(`Admin already exists: ${email}`);
  }
  await conn.end();
  console.log('Done. Start the API with: npm run dev');
})().catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
