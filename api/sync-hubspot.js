/**
 * api/sync-hubspot.js
 *
 * Hourly, one-way sync: HubSpot -> sheet. HubSpot is the source of truth for contacts and
 * outreach stage on any brand linked to a HubSpot company.
 *   - Matches HubSpot companies to Partner Brands, then Brands (prospects), by domain, then name.
 *   - Prospects get: outreach stage, owner, primary contact, next step, last activity, HubSpot link.
 *   - Partners get: primary contact, email, last correspondence, HubSpot link.
 *   - HubSpot companies in the pipeline that aren't in the sheet yet are added as prospects
 *     (source "HubSpot"), so the scanner finds their products and checks Amazon.
 *   - A won deal / customer stage moves a prospect to Partner Brands (Current).
 * Stage mapping lives in the "HubSpot Stage Map" tab: new HubSpot stages are added there with a
 * suggested dashboard stage, which you can change. A blank dashboard_stage means "ignore".
 * Manual: /api/sync-hubspot (Authorization: Bearer <CRON_SECRET>)
 */
import { TABS, STATUS } from './_lib/schema.js';
import { readTab, appendRows, updateRows, logRun } from './_lib/sheets.js';
import { isAuthorized, nowIso, normalizeName, normalizeDomain, slugify } from './_lib/util.js';
import { listCompanies, batchRead, getDealStages, getOwners, getPortalId, suggestStage } from './_lib/hubspot.js';

const COMPANY_PROPS = ['name', 'domain', 'website', 'lifecyclestage', 'hs_lead_status', 'hubspot_owner_id',
  'notes_last_contacted', 'hs_last_sales_activity_timestamp', 'notes_last_updated', 'hs_lastmodifieddate'];
const CONTACT_PROPS = ['firstname', 'lastname', 'jobtitle', 'email', 'hs_linkedin_url', 'lastmodifieddate', 'notes_last_contacted'];
const DEAL_PROPS = ['dealname', 'dealstage', 'pipeline', 'closedate', 'hs_next_step', 'hs_lastmodifieddate', 'hubspot_owner_id'];
const IMPORT_LIFECYCLES = ['lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity'];

const toDate = v => { const d = v ? new Date(/^\d+$/.test(v) ? Number(v) : v) : null; return d && !isNaN(d) ? d.toISOString() : ''; };
const latest = (...vals) => vals.map(toDate).filter(Boolean).sort().pop() || '';

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  // Not connected yet: skip quietly instead of logging an error every hour
  if (!(process.env.HUBSPOT_TOKEN || '').trim()) return res.status(200).json({ ok: true, skipped: 'HUBSPOT_TOKEN not set yet' });
  const stamp = nowIso();
  try {
    const [brands, partners, stageMap] = await Promise.all([
      readTab(TABS.BRANDS), readTab(TABS.PARTNERS), readTab(TABS.HUBSPOT_MAP),
    ]);
    const [companies, stages, owners, portalId] = await Promise.all([
      listCompanies(COMPANY_PROPS), getDealStages(), getOwners(), getPortalId(),
    ]);

    const contactIds = companies.flatMap(c => (c.associations?.contacts?.results || []).map(a => String(a.id)));
    const dealIds = companies.flatMap(c => (c.associations?.deals?.results || []).map(a => String(a.id)));
    const [contacts, deals] = await Promise.all([
      contactIds.length ? batchRead('contacts', contactIds, CONTACT_PROPS) : new Map(),
      dealIds.length ? batchRead('deals', dealIds, DEAL_PROPS) : new Map(),
    ]);

    // Stage map: existing rows win; unseen HubSpot values are added with a suggestion
    const map = new Map(stageMap.rows.map(r => [`${r.hubspot_field}|${r.hubspot_value}`, r.dashboard_stage]));
    const newMapRows = [];
    const stageFor = (field, value, info) => {
      if (!value) return '';
      const key = `${field}|${value}`;
      if (!map.has(key)) {
        const suggested = suggestStage(field, value, info);
        map.set(key, suggested);
        newMapRows.push({ hubspot_field: field, hubspot_value: value, dashboard_stage: suggested,
          notes: suggested ? 'Suggested automatically. Change if needed.' : 'No match. Pick a dashboard stage or leave blank to ignore.' });
      }
      return map.get(key) || '';
    };

    // Sheet indexes
    const index = rows => {
      const byDomain = new Map(), byName = new Map(), byHs = new Map();
      for (const r of rows) {
        const d = normalizeDomain(r.website_url); if (d) byDomain.set(d, r);
        const n = normalizeName(r.brand_name); if (n) byName.set(n, r);
        if (r.hubspot_company_id) byHs.set(String(r.hubspot_company_id), r);
      }
      return (id, domain, name) => byHs.get(id) || (domain && byDomain.get(domain)) || byName.get(name);
    };
    const findPartner = index(partners.rows);
    const findBrand = index(brands.rows);
    const ids = new Set(brands.rows.map(b => b.brand_id));
    const partnerNames = new Set(partners.rows.map(p => normalizeName(p.brand_name)));

    const brandUpdates = [], partnerUpdates = [], newBrands = [], newPartners = [];
    const unmatchedCustomers = [];
    let linked = 0;

    for (const c of companies) {
      const p = c.properties || {};
      const id = String(c.id);
      const name = String(p.name || '').trim();
      if (!name) continue;
      const domain = normalizeDomain(p.domain || p.website);
      const nName = normalizeName(name);
      const url = portalId ? `https://app.hubspot.com/contacts/${portalId}/record/0-2/${id}` : '';
      const owner = owners.get(String(p.hubspot_owner_id || '')) || '';

      // Primary contact: the most recently active associated contact with an email
      const cons = (c.associations?.contacts?.results || []).map(a => contacts.get(String(a.id))).filter(Boolean);
      const contact = cons.filter(x => x.email).sort((a, b) => latest(b.notes_last_contacted, b.lastmodifieddate).localeCompare(latest(a.notes_last_contacted, a.lastmodifieddate)))[0] || cons[0];
      const contactName = contact ? [contact.firstname, contact.lastname].filter(Boolean).join(' ') : '';

      // Deal: the most recently updated one
      const ds = (c.associations?.deals?.results || []).map(a => deals.get(String(a.id))).filter(Boolean)
        .sort((a, b) => String(b.hs_lastmodifieddate).localeCompare(String(a.hs_lastmodifieddate)));
      const deal = ds[0];
      const info = deal ? stages.get(String(deal.dealstage)) : null;

      // Dashboard stage: deal stage, then lead status, then lifecycle stage
      const dealStage = deal && info ? stageFor('deal_stage', `${info.label} (${info.pipeline})`, info) : '';
      const leadStage = stageFor('lead_status', p.hs_lead_status);
      const lifeStage = stageFor('lifecycle_stage', p.lifecyclestage);
      const stage = dealStage || leadStage || lifeStage;
      const hsLabel = deal && info ? `Deal: ${info.label} (${info.pipeline})`
        : p.hs_lead_status ? `Lead status: ${p.hs_lead_status}` : p.lifecyclestage ? `Lifecycle: ${p.lifecyclestage}` : '';
      const lastActivity = latest(p.notes_last_contacted, p.hs_last_sales_activity_timestamp, p.notes_last_updated);

      // Only write non-empty HubSpot values (never blank out sheet data)
      const set = (obj, row, key, val) => { if (val !== '' && val != null && String(row[key] ?? '') !== String(val)) obj[key] = val; };

      const partner = findPartner(id, domain, nName);
      if (partner) {
        const d = {};
        set(d, partner, 'hubspot_company_id', id); set(d, partner, 'hubspot_url', url); set(d, partner, 'hubspot_owner', owner);
        set(d, partner, 'primary_contact', contactName); set(d, partner, 'contact_email', contact?.email || '');
        set(d, partner, 'last_correspondence', lastActivity.slice(0, 10));
        if (!partner.website_url && domain) d.website_url = `https://${domain}`;
        if (Object.keys(d).length) partnerUpdates.push({ row: partner._row, data: { ...d, hubspot_synced_at: stamp } });
        linked++;
        continue;
      }

      let brand = findBrand(id, domain, nName);
      if (!brand) {
        const inPipeline = deal || IMPORT_LIFECYCLES.includes(String(p.lifecyclestage).toLowerCase()) || p.hs_lead_status;
        // A won deal for a brand not in the sheet: add it straight to Partner Brands
        if (dealStage === 'Signed') {
          if (!partnerNames.has(nName)) {
            partnerNames.add(nName);
            newPartners.push({
              brand_name: name, website_url: domain ? `https://${domain}` : '', status: 'Current',
              sign_date: (toDate(deal?.closedate) || stamp).slice(0, 10), primary_contact: contactName,
              contact_email: contact?.email || '', hubspot_company_id: id, hubspot_url: url, hubspot_owner: owner,
              hubspot_synced_at: stamp, notes: 'Signed in HubSpot',
            });
            linked++;
          }
          continue;
        }
        // Lifecycle "customer" alone isn't proof it's a partner brand (could be a vendor): report it instead
        if (stage === 'Signed') { if (!partnerNames.has(nName)) unmatchedCustomers.push(name); continue; }
        if (!inPipeline) continue;
        let bid = slugify(name), i = 2;
        while (ids.has(bid)) bid = `${slugify(name)}-${i++}`;
        ids.add(bid);
        brand = {
          brand_id: bid, brand_name: name, website_url: domain ? `https://${domain}` : '', first_seen: stamp,
          sources: 'HubSpot', source_count: 1, lead_source: 'hubspot',
          discovery_status: domain ? STATUS.NEW : STATUS.NEEDS_URL,
        };
        newBrands.push(brand);
      }

      const d = {};
      set(d, brand, 'hubspot_company_id', id); set(d, brand, 'hubspot_url', url); set(d, brand, 'hubspot_owner', owner);
      set(d, brand, 'hubspot_stage', hsLabel);
      set(d, brand, 'outreach_status', stage); set(d, brand, 'outreach_owner', owner);
      set(d, brand, 'contact_name', contactName); set(d, brand, 'contact_title', contact?.jobtitle || '');
      set(d, brand, 'contact_email', contact?.email || ''); set(d, brand, 'contact_linkedin', contact?.hs_linkedin_url || '');
      set(d, brand, 'next_step', deal?.hs_next_step || '');
      set(d, brand, 'outreach_updated', lastActivity);
      if (!brand.website_url && domain) d.website_url = `https://${domain}`;

      if (brand._row) { if (Object.keys(d).length) brandUpdates.push({ row: brand._row, data: { ...d, hubspot_synced_at: stamp } }); }
      else Object.assign(brand, d, { hubspot_synced_at: stamp });
      linked++;

      // Won deal / customer: add to Partner Brands
      if (stage === 'Signed' && !partnerNames.has(nName)) {
        partnerNames.add(nName);
        newPartners.push({
          brand_name: name, website_url: brand.website_url || (domain ? `https://${domain}` : ''), status: 'Current',
          sign_date: (toDate(deal?.closedate) || stamp).slice(0, 10), category: brand.category || '',
          primary_contact: contactName, contact_email: contact?.email || '', hubspot_company_id: id, hubspot_url: url,
          hubspot_owner: owner, hubspot_synced_at: stamp, notes: 'Signed in HubSpot',
        });
      }
    }

    await appendRows(TABS.HUBSPOT_MAP, stageMap.headers, newMapRows);
    await appendRows(TABS.BRANDS, brands.headers, newBrands);
    await updateRows(TABS.BRANDS, brands.headers, brandUpdates);
    await appendRows(TABS.PARTNERS, partners.headers, newPartners);
    await updateRows(TABS.PARTNERS, partners.headers, partnerUpdates);

    const result = {
      companies: companies.length, linked, prospectsUpdated: brandUpdates.length, prospectsAdded: newBrands.length,
      partnersUpdated: partnerUpdates.length, partnersAdded: newPartners.length, newStageMappings: newMapRows.length,
      customersNotInPartnerBrands: unmatchedCustomers,
    };
    await logRun({ job: 'sync-hubspot', processed: companies.length, added: newBrands.length + newPartners.length,
      updated: brandUpdates.length + partnerUpdates.length, notes: JSON.stringify(result).slice(0, 45000) });
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('sync-hubspot error:', err);
    await logRun({ job: 'sync-hubspot', errors: err.message });
    res.status(500).json({ error: err.message });
  }
}
