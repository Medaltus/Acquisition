/**
 * api/import-crm.js
 *
 * One-time (safe to re-run) import of the old CRM export from the "CRM Import" tab.
 *   Stage "Customer"   -> Partner Brands, status Current
 *   Stage "Terminated" -> Partner Brands, status Retired
 *   Any other stage    -> Brands (prospects) with an outreach status, so the scanner
 *                         finds their website, scans products, and checks Amazon
 * Existing rows are matched by brand name and only blank cells are filled, so nothing
 * edited on the dashboard or in the sheet is overwritten.
 * Run: /api/import-crm  (Authorization: Bearer <CRON_SECRET>)
 */
import { TABS, STATUS } from './_lib/schema.js';
import { readTab, appendRows, updateRows, logRun } from './_lib/sheets.js';
import { isAuthorized, nowIso, normalizeName, slugify, appendUnique } from './_lib/util.js';

const STAGE_MAP = {
  'initial contact': 'Contacted',
  'sent deck': 'Contacted',
  'sent proposal': 'Proposal Sent',
  'not interested': 'Not Interested',
};
const CATEGORY_MAP = {
  skincare: 'skincare', sunscreen: 'skincare', eye: 'skincare', tanning: 'skincare',
  haircare: 'haircare', cosmetics: 'makeup', lip: 'makeup', nails: 'nail',
  supplements: 'wellness',
};

/** "4/29/2021" -> "2021-04-29"; anything else passes through unchanged. */
function isoDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : String(s || '').trim();
}
const services = s => String(s || '').split(',').map(x => x.trim()).filter(x => x && x !== '?').join(', ');
function leadSource(whereMet) {
  const w = String(whereMet || '').toLowerCase();
  if (!w) return 'outbound';
  if (/cosmoprof|expo|show|event/.test(w)) return 'event';
  return 'referral';
}
/** Only fill cells that are currently blank. */
function fillBlanks(existing, incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== '' && v != null && !String(existing[k] ?? '').trim()) out[k] = v;
  }
  return out;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [crm, partners, brands] = await Promise.all([
      readTab(TABS.CRM_IMPORT), readTab(TABS.PARTNERS), readTab(TABS.BRANDS),
    ]);
    if (!crm.rows.length) return res.status(400).json({ error: 'The CRM Import tab is empty' });

    const partnerByName = new Map(partners.rows.map(p => [normalizeName(p.brand_name), p]));
    const brandByName = new Map(brands.rows.map(b => [normalizeName(b.brand_name), b]));
    const ids = new Set(brands.rows.map(b => b.brand_id));

    const newPartners = [], partnerUpdates = [], newBrands = [], brandUpdates = [], skipped = [];

    for (const r of crm.rows) {
      const name = String(r.brand_name || '').trim();
      if (!name) continue;
      const key = normalizeName(name);
      const stage = String(r.stage || '').trim().toLowerCase();

      if (stage === 'customer' || stage === 'terminated') {
        const data = {
          brand_name: name,
          status: stage === 'customer' ? 'Current' : 'Retired',
          category: String(r.category || '').split(',').map(s => s.trim()).filter(Boolean).join(', '),
          channels: services(r.services),
          sign_date: isoDate(r.date_signed),
          where_met: r.where_met,
          primary_contact: r.primary_contact,
          contact_email: r.contact_email,
          last_correspondence: isoDate(r.last_correspondence),
          pricing: r.pricing,
          agreement_files: r.agreement_files,
          notes: r.notes,
        };
        const existing = partnerByName.get(key);
        if (existing) {
          const patch = fillBlanks(existing, data);
          delete patch.brand_name;
          if (Object.keys(patch).length) partnerUpdates.push({ row: existing._row, data: patch });
        } else {
          newPartners.push(data);
          partnerByName.set(key, data);
        }
        continue;
      }

      const outreach = STAGE_MAP[stage];
      if (!outreach) { skipped.push(`${name} (stage "${r.stage}")`); continue; }

      const firstCat = String(r.category || '').split(',')[0].trim().toLowerCase();
      let signals = '';
      if (r.where_met) signals = appendUnique(signals, `Met: ${r.where_met}`);
      if (services(r.services)) signals = appendUnique(signals, `Services discussed: ${services(r.services)}`);
      if (stage === 'sent deck') signals = appendUnique(signals, 'Deck sent');
      const notes = [r.notes, r.pricing ? `Pricing discussed: ${r.pricing}` : ''].filter(Boolean).join('\n');
      const lastTouch = isoDate(r.last_correspondence);

      const data = {
        brand_name: name,
        category: CATEGORY_MAP[firstCat] || (firstCat ? 'other' : ''),
        contact_name: r.primary_contact,
        contact_email: r.contact_email,
        lead_source: leadSource(r.where_met),
        signals,
        outreach_status: outreach,
        outreach_notes: notes,
        outreach_updated: lastTouch,
      };
      const existing = brandByName.get(key);
      if (existing) {
        const patch = fillBlanks(existing, data);
        delete patch.brand_name;
        if (patch.signals === undefined && signals) {
          let merged = existing.signals;
          for (const s of signals.split(' | ')) merged = appendUnique(merged, s);
          if (merged !== existing.signals) patch.signals = merged;
        }
        if (Object.keys(patch).length) brandUpdates.push({ row: existing._row, data: patch });
      } else {
        let id = slugify(name), i = 2;
        while (ids.has(id)) id = `${slugify(name)}-${i++}`;
        ids.add(id);
        const row = {
          ...data, brand_id: id, first_seen: nowIso(), sources: 'CRM Import', source_count: 1,
          discovery_status: STATUS.NEEDS_URL,
        };
        newBrands.push(row);
        brandByName.set(key, row);
      }
    }

    await appendRows(TABS.PARTNERS, partners.headers, newPartners);
    await updateRows(TABS.PARTNERS, partners.headers, partnerUpdates);
    await appendRows(TABS.BRANDS, brands.headers, newBrands);
    await updateRows(TABS.BRANDS, brands.headers, brandUpdates);

    const result = {
      partnersAdded: newPartners.length, partnersUpdated: partnerUpdates.length,
      prospectsAdded: newBrands.length, prospectsUpdated: brandUpdates.length, skipped,
    };
    await logRun({ job: 'import-crm', processed: crm.rows.length,
      added: newPartners.length + newBrands.length, updated: partnerUpdates.length + brandUpdates.length,
      notes: JSON.stringify(result) });
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('import-crm error:', err);
    res.status(500).json({ error: err.message });
  }
}
