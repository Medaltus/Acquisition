/**
 * api/_lib/util.js
 */
export const USER_AGENT =
  'Mozilla/5.0 (compatible; MedaltusBrandScanner/1.0; +https://www.medaltus.com)';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();

/** Vercel cron sends "Authorization: Bearer <CRON_SECRET>". Manual runs can use ?key=<CRON_SECRET>. */
export function isAuthorized(req) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return false;
  const header = req.headers?.authorization || '';
  return header === `Bearer ${secret}` || req.query?.key === secret;
}

/** Dashboard is open while DASHBOARD_PASSWORD is unset. Set it in Vercel to turn the sign-in screen back on. */
export function isDashboardAuthorized(req) {
  const pw = (process.env.DASHBOARD_PASSWORD || '').trim();
  if (!pw) return true;
  return (req.headers?.['x-dashboard-key'] || '') === pw;
}

/** "A2S14XZ2NR1V9Q, A1B2..." -> ['A2S14XZ2NR1V9Q', 'A1B2...'] (Amazon merchant IDs only). */
export function parseSellerIds(s) {
  return [...new Set(String(s || '').toUpperCase().split(/[\s,|;]+/).filter(id => /^A[0-9A-Z]{9,15}$/.test(id)))];
}

export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(the|inc|llc|ltd|co)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeDomain(url) {
  if (!url) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

export function slugify(s) {
  return String(s || '')
    .toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'brand';
}

export function appendUnique(listStr, item, sep = ' | ') {
  const parts = String(listStr || '').split(sep).map(s => s.trim()).filter(Boolean);
  if (item && !parts.includes(item)) parts.push(item);
  return parts.join(sep);
}

export async function fetchText(url, { timeout = 15000, accept = 'text/html,*/*' } = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, finalUrl: res.url || url };
  } catch (e) {
    return { ok: false, status: 0, text: '', finalUrl: url, error: e.message };
  }
}

export async function fetchJson(url, opts = {}) {
  const r = await fetchText(url, { accept: 'application/json', ...opts });
  if (!r.ok) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

export function htmlToText(html, maxChars = 12000) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/** Run fn over items with limited concurrency; stops starting new work after the deadline. */
export async function mapLimit(items, limit, fn, deadline = Infinity) {
  const results = new Array(items.length);
  let next = 0, stoppedEarly = false;
  async function worker() {
    while (next < items.length) {
      if (Date.now() > deadline) { stoppedEarly = true; return; }
      const i = next++;
      try { results[i] = await fn(items[i], i); } catch (e) { console.error("mapLimit item failed:", e.message); results[i] = undefined; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return { results, stoppedEarly };
}

/** Validate a GTIN (8/12/13/14 digits) by check digit; returns normalized digits or ''. */
export function cleanGtin(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return '';
  if (/^(\d)\1+$/.test(d)) return '';               // 000000000000, 111111111111...
  const body = d.slice(0, -1).split('').reverse();
  const sum = body.reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 3 : 1), 0);
  if ((10 - (sum % 10)) % 10 !== Number(d.slice(-1))) return '';
  if (d.length === 14 && d.startsWith('00')) d = d.slice(2);   // GTIN-14 wrapping a UPC-A
  if (d.length === 13 && d.startsWith('0')) d = d.slice(1);    // EAN-13 wrapping a UPC-A
  return d;
}
