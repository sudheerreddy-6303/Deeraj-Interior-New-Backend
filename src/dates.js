// Date-range helpers for admin reports (Today / Yesterday / 7 days / 30 days / Custom).
// Dates follow the site's time zone (TZ_OFFSET_MINUTES, default 330 = India). Database times are UTC.
const OFFSET = Number(process.env.TZ_OFFSET_MINUTES || 330);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const localToday = () => ymd(new Date(Date.now() + OFFSET * 60000));
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(Date.UTC(y, m - 1, d + n))); };
function utcStart(s) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - OFFSET * 60000);
  return `${ymd(t)} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Turns ?range=today|yesterday|7d|30d|all|custom&from&to into { from, to, start, end } (start/end in UTC), or { error }. */
function resolveRange(q) {
  const today = localToday();
  const range = String(q.range || '30d');
  let from; let to;
  if (range === 'all') return { range, all: true, today };
  if (range === 'today') { from = today; to = today; }
  else if (range === 'yesterday') { from = addDays(today, -1); to = from; }
  else if (range === '7d') { from = addDays(today, -6); to = today; }
  else if (range === '30d') { from = addDays(today, -29); to = today; }
  else if (range === 'custom') {
    from = String(q.from || ''); to = String(q.to || '');
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) return { error: 'Choose both a start date and an end date.' };
    if (from > to) return { error: 'The start date must be on or before the end date.' };
    if ((Date.parse(to) - Date.parse(from)) / 86400000 + 1 > 366) return { error: 'Choose a range of one year or less.' };
  } else return { error: 'Unknown range.' };
  return { range, from, to, today, start: utcStart(from), end: utcStart(addDays(to, 1)) };
}

module.exports = { OFFSET, localToday, addDays, utcStart, resolveRange };
