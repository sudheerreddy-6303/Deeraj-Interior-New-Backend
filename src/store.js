// Shared store helpers: load products with colours, read settings, compute totals.
const { pool, json } = require('./db');

const SETTING_DEFAULTS = {
  deliveryFee: 99, freeAbove: 2999, cod: true, upi: true, pickup: true,
  bannerOn: false, bannerTitle: '', bannerText: '', samplePrices: false
};

function mapProduct(r, colors) {
  return {
    id: r.id,
    name: r.name,
    cat: r.cat,
    price: Number(r.price),
    mrp: Number(r.mrp) || 0,
    stock: Number(r.stock),
    desc: r.description || '',
    highlights: json(r.highlights, []),
    specs: json(r.specs, {}),
    images: json(r.images, []),
    video: r.video || '',
    model3d: r.model3d || '',
    featured: !!r.featured,
    active: !!r.active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    colors: (colors || []).map((c) => ({
      id: c.id, name: c.name, hex: c.hex, stock: c.stock == null ? null : Number(c.stock), images: json(c.images, [])
    }))
  };
}

async function loadProducts({ includeHidden = false, id = null, conn = pool } = {}) {
  const where = [];
  const args = [];
  if (!includeHidden) where.push('active = 1');
  if (id != null) { where.push('id = ?'); args.push(id); }
  const [rows] = await conn.query(
    `SELECT * FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY featured DESC, created_at DESC, id DESC`,
    args
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [cols] = await conn.query(
    `SELECT * FROM product_colors WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order, id`,
    ids
  );
  return rows.map((r) => mapProduct(r, cols.filter((c) => c.product_id === r.id)));
}

async function getSettings(conn = pool) {
  const [rows] = await conn.query('SELECT k, v FROM settings');
  const s = { ...SETTING_DEFAULTS };
  rows.forEach((r) => { if (r.k in SETTING_DEFAULTS) s[r.k] = json(r.v, SETTING_DEFAULTS[r.k]); });
  return s;
}

/** Stock for a product, or for one colour when that colour has its own stock. */
function stockFor(p, colorName) {
  if (colorName) {
    const c = p.colors.find((x) => x.name === colorName);
    if (c && c.stock != null) return c.stock;
  }
  return p.stock;
}

function money(n) {
  return '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
}

module.exports = { SETTING_DEFAULTS, loadProducts, getSettings, stockFor, money };
