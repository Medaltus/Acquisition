/**
 * api/_lib/sheets.js
 *
 * Minimal Google Sheets client using a service account (no npm dependencies).
 * Env: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, BRAND_SCANNER_SHEET_ID
 */
import crypto from 'node:crypto';
import { HEADERS, TABS } from './schema.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
let tokenCache = { token: null, exp: 0 };

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sheetId() {
  const id = (process.env.BRAND_SCANNER_SHEET_ID || '').trim();
  if (!id) throw new Error('Missing BRAND_SCANNER_SHEET_ID env var');
  return id;
}

export async function getGoogleToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && now < tokenCache.exp - 60) return tokenCache.token;

  const email = (process.env.GOOGLE_CLIENT_EMAIL || '').trim();
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!email || !key) throw new Error('Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY env var');

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(key);
  const jwt = `${header}.${claim}.${b64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google auth failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return tokenCache.token;
}

async function gfetch(path, options = {}) {
  const token = await getGoogleToken();
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${API}/${sheetId()}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(`Sheets API ${res.status} on ${path}: ${await res.text()}`);
  }
}

const rangeOf = (tab, a1 = 'A1:ZZ') => encodeURIComponent(`'${tab}'!${a1}`);

export function colLetter(index) {
  let n = index + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Read a tab. Returns { headers, rows } where each row is an object keyed by header, plus _row (sheet row number). */
export async function readTab(tab) {
  const data = await gfetch(`/values/${rangeOf(tab)}?valueRenderOption=FORMATTED_VALUE`);
  const values = data.values || [];
  const headers = (values[0] || []).map(h => String(h).trim());
  const rows = values.slice(1).map((r, i) => {
    const obj = { _row: i + 2 };
    headers.forEach((h, j) => { if (h) obj[h] = r[j] !== undefined ? String(r[j]) : ''; });
    return obj;
  }).filter(o => headers.some(h => h && o[h] !== ''));
  return { headers, rows };
}

function requireHeaders(tab, headers, keys) {
  const missing = keys.filter(k => !headers.includes(k));
  if (missing.length) {
    throw new Error(`Tab "${tab}" is missing columns: ${missing.join(', ')}. Run /api/setup-sheet to add them.`);
  }
}

/** Append row objects; values are matched to columns by header name. Stored RAW so UPCs keep leading zeros. */
export async function appendRows(tab, headers, objects) {
  if (!objects.length) return;
  requireHeaders(tab, headers, [...new Set(objects.flatMap(o => Object.keys(o)))].filter(k => k !== '_row'));
  for (let i = 0; i < objects.length; i += 500) {
    const values = objects.slice(i, i + 500).map(o => headers.map(h => (o[h] ?? '')));
    await gfetch(`/values/${rangeOf(tab, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values }),
    });
  }
}

/** Update specific cells. updates = [{ row: 5, data: { discovery_status: 'Enriched', platform: 'Shopify' } }] */
export async function updateRows(tab, headers, updates) {
  const data = [];
  for (const u of updates) {
    requireHeaders(tab, headers, Object.keys(u.data));
    for (const [key, value] of Object.entries(u.data)) {
      data.push({ range: `'${tab}'!${colLetter(headers.indexOf(key))}${u.row}`, values: [[value ?? '']] });
    }
  }
  for (let i = 0; i < data.length; i += 500) {
    await gfetch('/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data: data.slice(i, i + 500) }),
    });
  }
}

/** Raw cell values of a tab (no header handling), for user-imported files like LinkedIn exports. */
export async function readValues(tab) {
  const data = await gfetch(`/values/${rangeOf(tab)}?valueRenderOption=FORMATTED_VALUE`);
  return data.values || [];
}

export async function listTabs() {
  const meta = await gfetch('?fields=sheets.properties.title');
  return (meta.sheets || []).map(s => s.properties.title);
}

export async function addTab(title) {
  await gfetch(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] }),
  });
}

/** Make sure a tab's grid has at least `needed` columns (new tabs start with 26; full tabs can't grow on write). */
async function ensureColumns(tab, needed) {
  const meta = await gfetch('?fields=sheets.properties(sheetId,title,gridProperties.columnCount)');
  const props = (meta.sheets || []).map(s => s.properties).find(p => p.title === tab);
  if (!props) throw new Error(`Tab "${tab}" not found`);
  const have = props.gridProperties?.columnCount || 0;
  if (needed <= have) return;
  await gfetch(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: [{ appendDimension: { sheetId: props.sheetId, dimension: 'COLUMNS', length: needed - have } }] }),
  });
}

export async function writeHeaderCells(tab, startIndex, headers) {
  if (!headers.length) return;
  await ensureColumns(tab, startIndex + headers.length);
  const a1 = `${colLetter(startIndex)}1`;
  await gfetch(`/values/${rangeOf(tab, a1)}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [headers] }),
  });
}

export async function logRun(entry) {
  try {
    const { headers } = await readTab(TABS.RUN_LOG);
    await appendRows(TABS.RUN_LOG, headers.length ? headers : HEADERS[TABS.RUN_LOG], [{
      timestamp: new Date().toISOString(), ...entry,
    }]);
  } catch (e) {
    console.error('Run Log write failed:', e.message);
  }
}

/** Delete whole rows (sheet row numbers, 1-based) from a tab. Deletes bottom-up so row numbers stay valid. */
export async function deleteRows(tab, rowNumbers) {
  const rowsDesc = [...new Set(rowNumbers)].filter(n => n > 1).sort((a, b) => b - a);
  if (!rowsDesc.length) return 0;
  const meta = await gfetch('?fields=sheets.properties(sheetId,title)');
  const props = (meta.sheets || []).map(s => s.properties).find(p => p.title === tab);
  if (!props) throw new Error(`Tab "${tab}" not found`);
  // Group consecutive rows into ranges: [10, 9, 8, 4] -> 8-10, 4
  const ranges = [];
  for (const n of rowsDesc) {
    const last = ranges[ranges.length - 1];
    if (last && last.start === n + 1) last.start = n; else ranges.push({ start: n, end: n });
  }
  const requests = ranges.map(r => ({ deleteDimension: { range: { sheetId: props.sheetId, dimension: 'ROWS', startIndex: r.start - 1, endIndex: r.end } } }));
  for (let i = 0; i < requests.length; i += 100) {
    await gfetch(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: requests.slice(i, i + 100) }) });
  }
  return rowsDesc.length;
}
