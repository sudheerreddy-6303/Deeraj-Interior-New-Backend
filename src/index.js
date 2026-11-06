require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { pool } = require('./db');

const app = express();
app.set('trust proxy', 1);

const origins = (process.env.CLIENT_URL || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean);
const warned = new Set();
app.use(cors({
  origin: (origin, cb) => {
    const ok = !origin || origins.includes(origin) || origins.includes('*');
    if (!ok && !warned.has(origin)) {
      warned.add(origin);
      console.warn(`[CORS] Blocked requests from ${origin}. Add it to CLIENT_URL in server/.env (comma-separated) and restart the API.`);
    }
    cb(null, ok);
  }
}));
const payments = require('./routes/payments');
app.use('/api', payments.webhookRouter);        // Razorpay webhook (needs the raw body, so it comes before express.json)
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, db: 'connected' }); }
  catch (e) { res.status(500).json({ ok: false, db: 'not connected', error: e.code }); }
});

const visits = require('./routes/visits');
app.use('/api', visits.publicRouter);           // POST /api/track (visitor counter)
app.use('/api/admin', visits.adminRouter);      // GET /api/admin/visits
app.use('/api/admin', payments.adminRouter);    // payments, refunds, Razorpay settings
app.use('/api', require('./routes/public').router);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// uploaded product photos and videos
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), { maxAge: '30d' }));

// In production, serve the built React app from client/dist (single deploy)
const dist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// errors → JSON with a readable message
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong on our side. Please try again.' });
});

const port = Number(process.env.PORT || 5000);
app.listen(port, async () => {
  console.log(`Deeraj Interiors API running on http://localhost:${port}`);
  // startup checks so login problems are easy to spot
  try { await visits.ensureVisitsTable(); } catch (e) { /* reported by the database check below */ }
  try { await payments.ensurePaymentTables(); } catch (e) { console.error('[Payments] Could not prepare payment tables:', e.code || e.message); }
  try {
    const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM admins');
    if (!Number(row.n)) console.warn('[Admin] No admin account yet. Run: npm run db:setup  (or npm run admin:reset)');
    else console.log(`[Admin] ${row.n} admin account(s) ready. Sign in at ${origins[0]}/admin`);
  } catch (e) {
    console.error(`[Database] Cannot use MySQL (${e.code || e.message}). Check DB_HOST / DB_USER / DB_PASSWORD / DB_NAME in server/.env, then run: npm run db:setup`);
  }
  if (!process.env.JWT_SECRET) console.warn('[Security] JWT_SECRET is not set in server/.env; using a development secret.');
});
