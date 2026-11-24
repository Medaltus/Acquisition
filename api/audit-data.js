/**
 * api/audit-data.js
 *
 * Gap audit builder: everything for one brand's latest scan.
 * GET /api/audit-data?brand_id=<id>
 */
import { TABS } from './_lib/schema.js';
import { readTab } from './_lib/sheets.js';
import { isDashboardAuthorized } from './_lib/util.js';
import { RUBRIC, CATEGORY_LABELS, MODEL_COPY } from './_lib/audit.js';

const parse = v => { try { return JSON.parse(v); } catch { return null; } };

export default async function handler(req, res) {
  if (!isDashboardAuthorized(req)) return res.status(401).json({ error: 'Wrong or missing dashboard password' });
  const brandId = String(req.query?.brand_id || '');
  if (!brandId) return res.status(400).json({ error: 'brand_id is required' });
  try {
    const [brands, data, findings, builds] = await Promise.all([
      readTab(TABS.BRANDS), readTab(TABS.AUDIT_DATA).catch(() => ({ rows: [] })),
      readTab(TABS.AUDIT_FINDINGS).catch(() => ({ rows: [] })), readTab(TABS.AUDIT_BUILDS).catch(() => ({ rows: [] })),
    ]);
    const brand = brands.rows.find(b => b.brand_id === brandId);
    if (!brand) return res.status(404).json({ error: `Brand ${brandId} not found` });

    const build = builds.rows.find(r => r.brand_id === brandId) || null;
    // Latest scan: the one the build points at, else the newest scan with data
    const brandRows = data.rows.filter(r => r.brand_id === brandId);
    const latest = [...brandRows].sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)))[0];
    const scanId = build?.scan_id || latest?.scan_id || '';
    const rows = brandRows.filter(r => r.scan_id === scanId);

    // Latest batch of findings for this scan
    const fRows = findings.rows.filter(r => r.brand_id === brandId && r.scan_id === scanId);
    const lastFired = fRows.reduce((m, r) => (r.fired_at > m ? r.fired_at : m), '');
    const latestFindings = fRows.filter(r => r.fired_at === lastFired)
      .sort((a, b) => Number(a.rank) - Number(b.rank))
      .map(r => ({ ...r, data_refs: String(r.data_refs || '').split(',').filter(Boolean) }));

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: true,
      brand: {
        brand_id: brand.brand_id, brand_name: brand.brand_name, website_url: brand.website_url, logo_url: brand.logo_url,
        category: brand.category, contact_name: brand.contact_name, contact_title: brand.contact_title,
        scan_status: brand.scan_status, scan_requested_at: brand.scan_requested_at, scan_completed_at: brand.scan_completed_at,
        audit_status: brand.audit_status, outreach_status: brand.outreach_status,
      },
      scan_id: scanId,
      rows,
      findings: latestFindings,
      findings_at: lastFired,
      build: build ? { ...build, selections: parse(build.selections) || {}, logo_data: build.logo_data || '' } : null,
      rubric: RUBRIC.map(r => ({ key: r.key, label: r.label, points: r.points })),
      categories: CATEGORY_LABELS,
      models: MODEL_COPY,
    });
  } catch (err) {
    console.error('audit-data error:', err);
    res.status(500).json({ error: err.message });
  }
}
