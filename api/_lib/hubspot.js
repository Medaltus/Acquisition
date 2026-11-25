/**
 * api/_lib/hubspot.js
 *
 * Minimal HubSpot CRM v3 client (read-only) plus stage-mapping suggestions.
 * Env: HUBSPOT_TOKEN (private app / service key access token)
 */
import { sleep } from './util.js';

const BASE = 'https://api.hubapi.com';

async function hs(path, { method = 'GET', body } = {}) {
  const token = (process.env.HUBSPOT_TOKEN || '').trim();
  if (!token) throw new Error('Missing HUBSPOT_TOKEN env var');
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) return res.status === 204 ? {} : res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * attempt;
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (res.status === 401) throw new Error('HubSpot rejected the token (401). Check HUBSPOT_TOKEN in Vercel.');
    if (res.status === 403) throw new Error(`HubSpot token is missing a scope for ${path.split('?')[0]} (403): ${text.slice(0, 200)}`);
    throw new Error(`HubSpot ${res.status} on ${path.split('?')[0]}: ${text.slice(0, 300)}`);
  }
}

export async function getPortalId() {
  try { return String((await hs('/account-info/v3/details')).portalId || ''); } catch { return ''; }
}

/** All companies (paged), with their associated contact and deal IDs. */
export async function listCompanies(properties, maxPages = 40) {
  const out = [];
  let after = '';
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ limit: '100', archived: 'false', properties: properties.join(','), associations: 'contacts,deals' });
    if (after) qs.set('after', after);
    const data = await hs(`/crm/v3/objects/companies?${qs}`);
    out.push(...(data.results || []));
    after = data.paging?.next?.after || '';
    if (!after) break;
  }
  return out;
}

/** Batch read contacts/deals by ID. Returns Map(id -> properties). */
export async function batchRead(objectType, ids, properties) {
  const out = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const data = await hs(`/crm/v3/objects/${objectType}/batch/read`, {
      method: 'POST',
      body: { properties, inputs: unique.slice(i, i + 100).map(id => ({ id })) },
    });
    for (const r of data.results || []) out.set(String(r.id), r.properties || {});
  }
  return out;
}

/** Map(stageId -> { label, pipeline, closed, won }) across all deal pipelines. */
export async function getDealStages() {
  const out = new Map();
  const data = await hs('/crm/v3/pipelines/deals');
  for (const p of data.results || []) {
    for (const s of p.stages || []) {
      const prob = Number(s.metadata?.probability);
      out.set(String(s.id), {
        label: s.label, pipeline: p.label,
        closed: String(s.metadata?.isClosed) === 'true',
        won: String(s.metadata?.isClosed) === 'true' && prob === 1,
      });
    }
  }
  return out;
}

/** Map(ownerId -> name). Returns an empty map if the owners scope isn't granted. */
export async function getOwners() {
  const out = new Map();
  try {
    let after = '';
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({ limit: '100' });
      if (after) qs.set('after', after);
      const data = await hs(`/crm/v3/owners?${qs}`);
      for (const o of data.results || []) {
        out.set(String(o.id), [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || '');
      }
      after = data.paging?.next?.after || '';
      if (!after) break;
    }
  } catch (e) { console.error('HubSpot owners:', e.message); }
  return out;
}

/* ───── Stage suggestions (written to the HubSpot Stage Map tab, where they can be changed) ───── */

// Lifecycle stage no longer drives the dashboard stage (deal stage and lead status do). It's only used
// to spot customers, which are reported rather than imported.
const LIFECYCLE = { customer: 'Signed', evangelist: 'Signed' };
const LEAD_STATUS = {
  NEW: 'Not Contacted', OPEN: 'Researching', ATTEMPTED_TO_CONTACT: 'Contacted', CONNECTED: 'In Conversation',
  IN_PROGRESS: 'In Conversation', OPEN_DEAL: 'Proposal Sent', UNQUALIFIED: 'Disqualified', BAD_TIMING: 'Not Interested',
};

export function suggestStage(field, value, stageInfo) {
  if (field === 'lifecycle_stage') return LIFECYCLE[String(value).toLowerCase()] || '';
  if (field === 'lead_status') return LEAD_STATUS[String(value).toUpperCase()] || '';
  // deal stage: use HubSpot's closed/won flags, then the stage name
  if (stageInfo?.won) return 'Signed';
  if (stageInfo?.closed) return 'Not Interested';
  const v = String(value).toLowerCase();
  if (/won/.test(v)) return 'Signed';
  if (/lost|no decision|unqualified/.test(v)) return 'Not Interested';
  if (/contract|negotiat|proposal|quote|terms|agreement/.test(v)) return 'Proposal Sent';
  if (/meeting|demo|discovery|qualif|present|call|intro|scheduled|conversation/.test(v)) return 'In Conversation';
  if (/audit/.test(v)) return 'Audit Ready';
  if (/contact|outreach|sent|email|reach/.test(v)) return 'Contacted';
  if (/research|prospect|new/.test(v)) return 'Researching';
  return '';
}
