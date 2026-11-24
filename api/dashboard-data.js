/**
 * api/dashboard-data.js
 *
 * Dashboard: all data for Current Brands, Retired Brands, and Future Prospects in one call.
 * Auth: x-dashboard-key header must equal DASHBOARD_PASSWORD.
 */
import { TABS, STATUS, OUTREACH_STAGES, OUTREACH_CLOSED } from './_lib/schema.js';
import { readTab } from './_lib/sheets.js';
import { isDashboardAuthorized } from './_lib/util.js';

const PROSPECT_FIELDS = [
  'brand_id', 'brand_name', 'website_url', 'category', 'amazon_brand_name', 'instagram_handle',
  'tiktok_handle', 'lead_source', 'first_seen', 'sources', 'source_count', 'signals', 'platform',
  'product_count', 'upc_coverage', 'discovery_status', 'logo_url', 'amazon_status',
  'amazon_asin_count', 'amazon_upc_matches', 'amazon_max_sellers', 'amazon_price_gap',
  'amazon_checked_at', 'amazon_notes', 'amazon_seller_id', 'amazon_brand_buybox', 'hubspot_company_id', 'hubspot_url', 'hubspot_owner', 'hubspot_stage', 'hubspot_synced_at', 'outreach_status', 'outreach_owner', 'outreach_updated',
  'next_step', 'outreach_notes', 'contact_name', 'contact_title', 'contact_email', 'contact_linkedin',
  'scan_status', 'scan_completed_at', 'audit_status',
];
const HIDDEN = [STATUS.DUPLICATE];

const isRetired = p => /^retired$/i.test(String(p.status || '').trim()) || Boolean(String(p.end_date || '').trim());
const pick = (row, fields) => Object.fromEntries(fields.map(f => [f, row[f] ?? '']));

export default async function handler(req, res) {
  if (!isDashboardAuthorized(req)) return res.status(401).json({ error: 'Wrong or missing dashboard password' });
  try {
    const [partners, brands, products] = await Promise.all([
      readTab(TABS.PARTNERS).catch(() => ({ rows: [] })),
      readTab(TABS.BRANDS),
      readTab(TABS.PRODUCTS),
    ]);

    // Per-brand product rollups
    const stats = {};
    for (const p of products.rows) {
      const s = (stats[p.brand_id] ||= { variants: 0, titles: new Set(), withUpc: 0, onAmazon: 0, notOnAmazon: 0 });
      s.variants++;
      if (p.product_title) s.titles.add(p.product_title);
      if (p.upc) s.withUpc++;
      if (p.asin) s.onAmazon++;
      else if (String(p.match_method).startsWith('upc: not found')) s.notOnAmazon++;
    }

    const prospects = brands.rows
      .filter(b => !HIDDEN.includes(b.discovery_status))
      .map(b => {
        const s = stats[b.brand_id];
        return {
          ...pick(b, PROSPECT_FIELDS),
          _row: b._row,
          stats: s ? { variants: s.variants, products: s.titles.size, withUpc: s.withUpc,
            onAmazon: s.onAmazon, notOnAmazon: s.notOnAmazon } : null,
        };
      });

    const partnerRows = partners.rows.map(p => ({ ...p }));
    const sheetId = (process.env.BRAND_SCANNER_SHEET_ID || '').trim();

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      sheetUrl: sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : '',
      stages: OUTREACH_STAGES,
      closedStages: OUTREACH_CLOSED,
      current: partnerRows.filter(p => !isRetired(p)),
      retired: partnerRows.filter(p => isRetired(p)),
      prospects,
    });
  } catch (err) {
    console.error('dashboard-data error:', err);
    res.status(500).json({ error: err.message });
  }
}
