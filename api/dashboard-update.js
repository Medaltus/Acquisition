/**
 * api/dashboard-update.js
 *
 * Dashboard writes. POST JSON:
 * { type: 'prospect', brand_id, data: { outreach_status, outreach_owner, next_step, outreach_notes } }
 * { type: 'partner', action: 'add', data: { brand_name, website_url, sign_date, ... } }
 * { type: 'partner', action: 'update', brand_name, data: { any Partner Brands column, incl. a new brand_name } }
 * { type: 'inbound', brand_id, action: 'answers', data: { hero_products, seller_text, channels, est_revenue, notes } }
 * { type: 'inbound', brand_id, action: 'rescan', from: 'enrich' | 'products' | 'amazon' | 'audit_amazon' }
 * { type: 'inbound', brand_id, action: 'case', case_id }   (case study for the follow-up email; '' clears)
 * { type: 'inbound', brand_id, action: 'website', website_url }
 * { type: 'inbound', brand_id, action: 'sent' | 'unsent', date? }
 * Setting a prospect to "Signed" adds it to Partner Brands (sign_date = today) if it isn't there yet.
 */
import { TABS, HEADERS, OUTREACH_STAGES, OUTREACH_CLOSED, STATUS, INBOUND_DONE } from './_lib/schema.js';
import { kickPipeline } from './_lib/inbound.js';
import { readTab, appendRows, updateRows } from './_lib/sheets.js';
import { isDashboardAuthorized, normalizeName, nowIso, parseSellerIds, normalizeDomain } from './_lib/util.js';

const PROSPECT_EDITABLE = ['outreach_status', 'outreach_owner', 'next_step', 'outreach_notes',
  'contact_name', 'contact_title', 'contact_email', 'contact_linkedin', 'amazon_seller_id', 'amazon_brand_name'];
const PARTNER_EDITABLE = HEADERS[TABS.PARTNERS];
const clean = (data, allowed) =>
  Object.fromEntries(Object.entries(data || {}).filter(([k]) => allowed.includes(k)).map(([k, v]) => [k, String(v ?? '').trim()]));
const today = () => new Date().toISOString().slice(0, 10);
const RESCAN_FROM = ['enrich', 'products', 'amazon', 'audit_amazon'];
/** Seller IDs inside anything pasted: a bare ID or a storefront link (...?seller=A2S14XZ2NR1V9Q). */
const sellerIdsIn = text => [...new Set((String(text || '').toUpperCase().match(/\bA[0-9A-Z]{11,14}\b/g) || []).filter(id => /\d/.test(id)))];

async function inboundAction(req, body, brands, b) {
  const stamp = nowIso();
  const early = !b.hubspot_company_id && ['', 'Not Contacted', 'Researching', 'Audit Ready'].includes(b.outreach_status || '');

  if (body.action === 'answers') {
    const d = body.data || {};
    let answers = {};
    try { answers = JSON.parse(b.inbound_answers || '{}'); } catch { /* start fresh */ }
    answers = { ...answers, channels: String(d.channels || '').trim(), seller_text: String(d.seller_text || '').trim(),
      notes: String(d.notes || '').trim(), saved_at: stamp };
    const data = { inbound_answers: JSON.stringify(answers), hero_products: String(d.hero_products || '').trim(),
      est_revenue: String(d.est_revenue || '').trim() };
    const found = sellerIdsIn(d.seller_text);
    const ids = [...new Set([...parseSellerIds(b.amazon_seller_id), ...found])].join(', ');
    const sellerChanged = ids !== (b.amazon_seller_id || '');
    if (sellerChanged) { data.amazon_seller_id = ids; data.amazon_checked_at = ''; }
    await updateRows(TABS.BRANDS, brands.headers, [{ row: b._row, data }]);
    return { ok: true, sellerChanged, sellerIds: ids, sellerFound: found.length > 0, scanned: Boolean(b.audit_status) };
  }

  if (body.action === 'rescan') {
    const from = RESCAN_FROM.includes(body.from) ? body.from : 'audit_amazon';
    await updateRows(TABS.BRANDS, brands.headers, [{ row: b._row, data: {
      inbound_step: from, inbound_updated: stamp, inbound_attempts: '0', inbound_note: '', inbound_at: b.inbound_at || stamp,
    } }]);
    await kickPipeline(req, b.brand_id);
    return { ok: true, step: from };
  }

  if (body.action === 'website') {
    const domain = normalizeDomain(body.website_url);
    if (!domain) return { status: 400, error: 'That doesn\'t look like a website address' };
    await updateRows(TABS.BRANDS, brands.headers, [{ row: b._row, data: {
      website_url: `https://${domain}`, discovery_status: STATUS.NEW,
      inbound_step: 'enrich', inbound_updated: stamp, inbound_attempts: '0', inbound_note: '',
    } }]);
    await kickPipeline(req, b.brand_id);
    return { ok: true, step: 'enrich', website_url: `https://${domain}` };
  }

  if (body.action === 'sent') {
    const sentAt = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : today();
    const data = { audit_sent_at: sentAt, inbound_step: INBOUND_DONE.SENT, inbound_updated: stamp };
    if (early) { data.outreach_status = 'Contacted'; data.outreach_updated = stamp; }
    await updateRows(TABS.BRANDS, brands.headers, [{ row: b._row, data }]);
    return { ok: true, audit_sent_at: sentAt, outreach_status: data.outreach_status };
  }

  if (body.action === 'case') {
    // The case study the follow-up email will use ('' = let the dashboard suggest one)
    await updateRows(TABS.BRANDS, brands.headers, [{ row: b._row, data: { followup_case: String(body.case_id || '').trim() } }]);
    return { ok: true };
  }
  if (body.action === 'unsent') {
    await updateRows(TABS.BRANDS, brands.headers, [{ row: b._row, data: { audit_sent_at: '', inbound_step: INBOUND_DONE.REVIEW, inbound_updated: stamp } }]);
    return { ok: true };
  }
  return { status: 400, error: 'Unknown inbound action' };
}

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
      // Outreach and contact fields on HubSpot-linked brands are managed in HubSpot (one-way sync)
      const hsManaged = Object.keys(data).filter(k => (k.startsWith('outreach') && k !== 'outreach_notes') || k.startsWith('contact') || k === 'next_step');
      if (b.hubspot_company_id && hsManaged.length) {
        return res.status(409).json({ error: `${b.brand_name} is synced from HubSpot. Update ${hsManaged.includes('outreach_status') ? 'its stage' : 'these fields'} in HubSpot.` });
      }
      let recheck = false;
      if ('amazon_seller_id' in data) {
        const raw = data.amazon_seller_id;
        const ids = parseSellerIds(raw);
        if (raw && !ids.length) return res.status(400).json({ error: `"${raw}" doesn't look like an Amazon seller ID (it starts with A, e.g. A2S14XZ2NR1V9Q)` });
        data.amazon_seller_id = ids.join(', ');
        // Changed seller ID: clear the last check so the next amazon-check run re-classifies this brand
        if (data.amazon_seller_id !== (b.amazon_seller_id || '')) { data.amazon_checked_at = ''; recheck = true; }
      }
      if (Object.keys(data).some(k => k.startsWith('outreach') || k.startsWith('contact') || k === 'next_step')) data.outreach_updated = nowIso();
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
      return res.status(200).json({ ok: true, outreach_updated: data.outreach_updated, amazon_seller_id: data.amazon_seller_id, recheck, addedPartner });
    }

    if (body.type === 'inbound') {
      const brands = await readTab(TABS.BRANDS);
      const b = brands.rows.find(r => r.brand_id === body.brand_id);
      if (!b) return res.status(404).json({ error: `Brand ${body.brand_id} not found` });
      const out = await inboundAction(req, body, brands, b);
      return res.status(out.status || 200).json(out);
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
        // Renaming: allowed as long as no other partner already has the new name
        if ('brand_name' in data) {
          const newName = data.brand_name;
          if (!newName) delete data.brand_name;
          else if (normalizeName(newName) !== normalizeName(p.brand_name)
            && partners.rows.some(r => r !== p && normalizeName(r.brand_name) === normalizeName(newName))) {
            return res.status(409).json({ error: `${newName} is already in Partner Brands` });
          }
        }
        // A filled end date always means Retired. Reinstating sends status: 'Current' explicitly.
        if (data.end_date) data.status = 'Retired';
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
