/**
 * api/_lib/hunter.js
 *
 * Hunter.io API (v2): account credits, email finder (name + domain), email verifier.
 * Env: HUNTER_API_KEY
 */
const BASE = 'https://api.hunter.io/v2';

async function hunter(path, params = {}) {
  const key = (process.env.HUNTER_API_KEY || '').trim();
  if (!key) throw new Error('Missing HUNTER_API_KEY env var');
  const qs = new URLSearchParams({ ...params, api_key: key });
  const res = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(30000) });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Hunter rejected the API key (401). Check HUNTER_API_KEY in Vercel.');
  if (res.status === 429) throw new Error('Hunter rate limit or monthly credits reached (429).');
  if (!res.ok) throw new Error(`Hunter ${res.status}: ${body?.errors?.[0]?.details || JSON.stringify(body).slice(0, 200)}`);
  return body.data || {};
}

/** Remaining monthly credits: { searches: {used, available}, verifications: {used, available}, plan } */
export async function getCredits() {
  const d = await hunter('/account');
  const r = d.requests || {};
  return {
    plan: d.plan_name || '',
    searches: { used: r.searches?.used ?? 0, available: r.searches?.available ?? 0 },
    verifications: { used: r.verifications?.used ?? 0, available: r.verifications?.available ?? 0 },
    resets: d.reset_date || '',
  };
}

/** Name + domain -> { email, score, status } (status from Hunter's built-in verification when it has one). */
export async function findEmail({ domain, firstName, lastName }) {
  const d = await hunter('/email-finder', { domain, first_name: firstName, last_name: lastName });
  return { email: d.email || '', score: d.score ?? '', status: d.verification?.status || '', position: d.position || '' };
}

/** Email -> { status: valid | invalid | accept_all | webmail | disposable | unknown, score } */
export async function verifyEmail(email) {
  const d = await hunter('/email-verifier', { email });
  return { status: d.status || d.result || 'unknown', score: d.score ?? '' };
}
