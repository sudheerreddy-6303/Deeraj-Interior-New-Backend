const jwt = require('jsonwebtoken');

function secret() {
  return process.env.JWT_SECRET || 'dev-only-secret-change-me';
}

function sign(admin) {
  return jwt.sign({ id: admin.id, email: admin.email, name: admin.name }, secret(), { expiresIn: '7d' });
}

/** Protects admin routes: expects "Authorization: Bearer <token>". */
function requireAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please sign in to the admin panel.' });
  try {
    req.admin = jwt.verify(token, secret());
    next();
  } catch (e) {
    res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
}

module.exports = { sign, requireAdmin };
