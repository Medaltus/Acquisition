/**
 * api/_lib/inbound.js
 *
 * Helpers for website form leads: reading a Webflow form submission, guessing the brand's website,
 * and starting the next step of the fast-track scan.
 */
import { normalizeDomain, normalizeName } from './util.js';

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'gmx.com', 'hey.com',
  'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'mail.com', 'zoho.com',
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * Webflow sends { triggerType, payload: { name, data: { "<field name>": value }, id, pageUrl, ... } }.
 * Field names on the Medaltus forms don't match their contents ("Full Name 2" holds the email),
 * so fields are matched by what's in them, not only by their names.
 */
export function parseSubmission(body) {
  const p = body?.payload || body || {};
  const data = p.data || {};
  const entries = Object.entries(data).map(([k, v]) => [String(k), String(v ?? '').trim()]);

  const email = (entries.find(([, v]) => EMAIL_RE.test(v)) || [])[1] || '';
  const brandText = (entries.find(([k, v]) => /brand|company|website/i.test(k) && v && !EMAIL_RE.test(v)) || [])[1] || '';
  const name = (entries.find(([k, v]) => /name/i.test(k) && !/brand|company/i.test(k) && v && !EMAIL_RE.test(v)) || [])[1] || '';
  const requests = entries
    .filter(([k, v]) => /request|callback|information/i.test(k) && /^(true|on|yes)$/i.test(v))
    .map(([k]) => k.replace(/\s*\d+$/, '').trim());

  return {
    submissionId: String(p.id || p._id || ''),
    formName: String(p.name || ''),
    page: String(p.pageUrl || p.publishedPath || p.pageId || ''),
    name, email, brandText, requests,
    raw: JSON.stringify(data).slice(0, 2000),
  };
}

/** The brand's likely website: what they typed if it looks like a domain, else their work email's domain. */
export function guessWebsite({ brandText, email }) {
  const typed = String(brandText || '').trim();
  if (/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(typed)) {
    const d = normalizeDomain(typed);
    if (d) return `https://${d}`;
  }
  const domain = String(email || '').split('@')[1]?.toLowerCase() || '';
  if (!domain || FREE_MAIL.has(domain) || domain === 'medaltus.com') return '';
  // With a brand name typed, only trust the email domain if it matches the name (an agency or parent
  // company email would point at the wrong site). Otherwise enrichment looks the site up by name.
  const label = domain.split('.')[0].replace(/[^a-z0-9]/g, '');
  const name = normalizeName(typed);
  if (typed && !(name && label.length >= 3 && (name.includes(label) || label.includes(name)))) return '';
  return `https://${domain}`;
}

/** "lumenandrye.com" -> "Lumenandrye" (placeholder name when the form had no brand field). */
export function nameFromDomain(url) {
  const label = normalizeDomain(url).split('.')[0] || '';
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : '';
}

export function baseUrl(req) {
  const prod = (process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  if (prod) return `https://${prod}`;
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || '';
  return host ? `https://${host}` : '';
}

/**
 * Start the next pipeline step in its own function call. We only wait long enough for the request
 * to be received; the step keeps running on Vercel. If it ever doesn't start, the 5-minute cron picks it up.
 */
export async function kickPipeline(req, brandId) {
  const base = baseUrl(req);
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!base || !secret) return false;
  try {
    await fetch(`${base}/api/inbound-pipeline?brand_id=${encodeURIComponent(brandId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(2500),
    });
  } catch { /* timeout is expected: the step is still running */ }
  return true;
}

/** Run another endpoint's handler in this function call, as an authorized cron request. */
export async function runHandler(handler, query) {
  const out = { statusCode: 200, body: null };
  const res = {
    setHeader() { return res; },
    status(c) { out.statusCode = c; return res; },
    json(o) { out.body = o; return res; },
    send(o) { out.body = o; return res; },
    end() { return res; },
  };
  const req = { method: 'GET', headers: {}, body: {}, query: { key: (process.env.CRON_SECRET || '').trim(), ...query } };
  await handler(req, res);
  return out;
}
