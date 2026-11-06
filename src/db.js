const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || '',
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  charset: 'utf8mb4'
});

/** MySQL returns JSON columns parsed, MariaDB returns strings: normalise both. */
function json(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

module.exports = { pool, json };
