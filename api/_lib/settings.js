/**
 * api/_lib/settings.js
 *
 * Small encrypted key/value store on the "Settings" tab, for connection state the scanner has to
 * update itself (e.g. Helium 10 OAuth tokens, which rotate on every refresh). Values are AES-256-GCM
 * encrypted with a key derived from SETTINGS_KEY (or CRON_SECRET if that isn't set), so the sheet
 * never holds a usable token. Changing that secret just means reconnecting.
 */
import crypto from 'node:crypto';
import { TABS } from './schema.js';
import { readTab, appendRows, updateRows } from './sheets.js';
import { nowIso } from './util.js';

const key = () => {
  const secret = (process.env.SETTINGS_KEY || process.env.CRON_SECRET || '').trim();
  if (!secret) throw new Error('SETTINGS_KEY or CRON_SECRET must be set');
  return crypto.createHash('sha256').update(`medaltus-settings:${secret}`).digest();
};

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

function decrypt(blob) {
  if (!String(blob || '').startsWith('v1:')) return '';
  try {
    const buf = Buffer.from(blob.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}

/** Read one setting as parsed JSON (or null). */
export async function getSetting(name) {
  const row = (await readTab(TABS.SETTINGS)).rows.find(r => r.key === name);
  const text = row ? decrypt(row.value) : '';
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Save one setting (any JSON value), replacing the old value. */
export async function setSetting(name, value) {
  const tab = await readTab(TABS.SETTINGS);
  const data = { key: name, value: encrypt(JSON.stringify(value)), updated_at: nowIso() };
  const row = tab.rows.find(r => r.key === name);
  if (row) await updateRows(TABS.SETTINGS, tab.headers, [{ row: row._row, data }]);
  else await appendRows(TABS.SETTINGS, tab.headers, [data]);
}
