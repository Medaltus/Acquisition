/**
 * api/dashboard-update.js
 *
 * Dashboard writes. POST JSON:
 * { type: 'prospect', brand_id, data: { outreach_status, outreach_owner, next_step, outreach_notes } }
 * { type: 'partner', action: 'add', data: { brand_name, website_url, sign_date, ... } }
 * { type: 'partner', action: 'update', brand_name, data: { end_date, retired_reason, ... } }
 * Setting a prospect to "Signed" adds it to Partner Brands (sign_date = today) if it isn't there yet.
 */
import { TABS, HEADERS, OUTREACH_STAGES, OUTREACH_CLOSED } from './_lib/schema.js';
import { readTab, appendRows, updateRows } from './_lib/sheets.js';
import { isDashboardAuthorized, normalizeName, nowIso } from './_lib/util.js';

const PROSPECT_EDITABLE = ['outreach_status', 'outreach_owner', 'next_step', 'outreach_notes',
  'contact_name', 'contact_title', 'contact_email', 'contact_linkedin'];
const PARTNER_EDITABLE = HEADERS[TABS.PARTNERS];
const clean = (data, allowed) =>
  Object.fromEntries(Object.entries(data || {}).filter(([k]) => allowed.includes(k)).map(([k, v]) => [k, String(v ?? '').trim()]));
const today = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  if (!isDashboardAuthorized(req)) return res.status(401).json({ error: 'Wrong or missing dashboard password' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  try {
    if (body.type === 'prospect') {
      const brands = await readTab(TABS.BRANDS);
      const b = brands.rows.find(r => r.brand_id === body.brand_id);
      if (!b) return res.status(404).json({ error: `Brand ${body.brand_id} not found` });
      const data = clean(body.data, PROSPECT_EDITABLE);
      if (data.outreach_status && ![...OUTREACH_STAGES, ...OUTREACH_CLOSED].includes(data.outreach_status)) {
        return res.status(400).json({ error: `Unknown outreach status "${data.outreach_status}"` });
      }
      data.outreach_updated = nowIso();
      await updateRows(TABS.BRANDS, brands.headers, [{ row: b._row, data }]);

      let addedPartner = false;
      if (data.outreach_status === 'Signed') {
        const partners = await readTab(TABS.PARTNERS);
        const exists = partners.rows.some(p => normalizeName(p.brand_name) === normalizeName(b.brand_name));
        if (!exists) {
          await appendRows(TABS.PARTNERS, partners.headers, [{
            brand_name: b.brand_name, website_url: b.website_url, sign_date: today(), status: 'Current',
            category: b.category, primary_contact: b.contact_name, contact_email: b.contact_email,
            notes: 'Signed from prospect pipeline',
          }]);
          addedPartner = true;
        }
      }
      return res.status(200).json({ ok: true, outreach_updated: data.outreach_updated, addedPartner });
    }

    if (body.type === 'partner') {
      const partners = await readTab(TABS.PARTNERS);
      const data = clean(body.data, PARTNER_EDITABLE);

      if (body.action === 'add') {
        if (!data.brand_name) return res.status(400).json({ error: 'brand_name is required' });
        if (partners.rows.some(p => normalizeName(p.brand_name) === normalizeName(data.brand_name))) {
          return res.status(409).json({ error: `${data.brand_name} is already in Partner Brands` });
        }
        await appendRows(TABS.PARTNERS, partners.headers, [{ status: 'Current', ...data }]);
        return res.status(200).json({ ok: true });
      }

      if (body.action === 'update') {
        const p = partners.rows.find(r => normalizeName(r.brand_name) === normalizeName(body.brand_name));
        if (!p) return res.status(404).json({ error: `${body.brand_name} not found in Partner Brands` });
        delete data.brand_name;
        if ('end_date' in data) data.status = data.end_date ? 'Retired' : 'Current';
        await updateRows(TABS.PARTNERS, partners.headers, [{ row: p._row, data }]);
        return res.status(200).json({ ok: true });
      }
    }

    res.status(400).json({ error: 'Unknown request type' });
  } catch (err) {
    console.error('dashboard-update error:', err);
    res.status(500).json({ error: err.message });
  }
}
