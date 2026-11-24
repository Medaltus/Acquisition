/**
 * api/audit-update.js
 *
 * Gap audit builder writes. POST JSON:
 * { type: 'verify', brand_id, updates: [{ _row, verified: 'Y' | '' | 'Excluded', value? }] }
 * { type: 'add', brand_id, scan_id, row: { section, label, value, source, source_url } }
 * { type: 'build', brand_id, scan_id, selections: {...}, logo_data? }
 * { type: 'exported', brand_id }
 */
import { TABS } from './_lib/schema.js';
import { readTab, appendRows, updateRows } from './_lib/sheets.js';
import { isDashboardAuthorized, nowIso } from './_lib/util.js';

const MAX_LOGO_CHARS = 48000;   // Google Sheets cells hold 50,000 characters

export default async function handler(req, res) {
  if (!isDashboardAuthorized(req)) return res.status(401).json({ error: 'Wrong or missing dashboard password' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const brandId = String(body.brand_id || '');
  if (!brandId) return res.status(400).json({ error: 'brand_id is required' });

  try {
    if (body.type === 'verify') {
      const data = await readTab(TABS.AUDIT_DATA);
      const updates = [];
      for (const u of body.updates || []) {
        const row = data.rows.find(r => r._row === Number(u._row) && r.brand_id === brandId);
        if (!row) continue;
        const d = {};
        if (u.verified !== undefined) {
          if (!['Y', '', 'Excluded'].includes(u.verified)) return res.status(400).json({ error: `Unknown verified value "${u.verified}"` });
          d.verified = u.verified;
          d.verified_by = u.verified ? `dashboard ${nowIso().slice(0, 10)}` : '';
        }
        if (u.value !== undefined && String(u.value) !== row.value) {
          d.value = String(u.value).trim();
          d.method = 'manual';
          d.confidence = 'High';
          d.notes = [row.notes, `Edited from "${row.value}"`].filter(Boolean).join(' | ');
        }
        if (Object.keys(d).length) updates.push({ row: row._row, data: d });
      }
      await updateRows(TABS.AUDIT_DATA, data.headers, updates);
      return res.status(200).json({ ok: true, updated: updates.length });
    }

    if (body.type === 'add') {
      const r = body.row || {};
      if (!body.scan_id || !r.label || !r.value) return res.status(400).json({ error: 'scan_id, label, and value are required' });
      const data = await readTab(TABS.AUDIT_DATA);
      const row = {
        brand_id: brandId, scan_id: body.scan_id, section: r.section || 'Manual notes', field: `manual.${Date.now().toString(36)}`,
        label: String(r.label).trim(), value: String(r.value).trim(), source: String(r.source || 'Entered by hand').trim(),
        source_url: String(r.source_url || '').trim(), method: 'manual', confidence: 'High', verified: 'Y',
        verified_by: `dashboard ${nowIso().slice(0, 10)}`, captured_at: nowIso(), notes: '',
      };
      await appendRows(TABS.AUDIT_DATA, data.headers, [row]);
      return res.status(200).json({ ok: true, field: row.field });
    }

    if (body.type === 'build') {
      const builds = await readTab(TABS.AUDIT_BUILDS);
      const existing = builds.rows.find(r => r.brand_id === brandId);
      const data = { updated_at: nowIso(), status: body.status || 'In progress', selections: JSON.stringify(body.selections || {}) };
      if (body.scan_id) data.scan_id = body.scan_id;
      if (body.logo_data !== undefined) {
        if (String(body.logo_data).length > MAX_LOGO_CHARS) return res.status(400).json({ error: 'Logo is too large to store. Try a smaller image.' });
        data.logo_data = body.logo_data;
      }
      if (existing) await updateRows(TABS.AUDIT_BUILDS, builds.headers, [{ row: existing._row, data }]);
      else await appendRows(TABS.AUDIT_BUILDS, builds.headers, [{ brand_id: brandId, ...data }]);
      return res.status(200).json({ ok: true, updated_at: data.updated_at });
    }

    if (body.type === 'exported') {
      const [builds, brands] = await Promise.all([readTab(TABS.AUDIT_BUILDS), readTab(TABS.BRANDS)]);
      const b = builds.rows.find(r => r.brand_id === brandId);
      const stamp = nowIso();
      if (b) await updateRows(TABS.AUDIT_BUILDS, builds.headers, [{ row: b._row, data: {
        exported_at: stamp, export_count: String((Number(b.export_count) || 0) + 1), status: 'Exported' } }]);
      const brand = brands.rows.find(r => r.brand_id === brandId);
      if (brand) {
        const data = { audit_status: 'Exported' };
        // Move early-stage prospects to "Audit Ready" in the outreach pipeline
        if (['', 'Not Contacted', 'Researching'].includes(brand.outreach_status || '')) {
          data.outreach_status = 'Audit Ready'; data.outreach_updated = stamp;
        }
        await updateRows(TABS.BRANDS, brands.headers, [{ row: brand._row, data }]);
      }
      return res.status(200).json({ ok: true, exported_at: stamp });
    }

    res.status(400).json({ error: 'Unknown request type' });
  } catch (err) {
    console.error('audit-update error:', err);
    res.status(500).json({ error: err.message });
  }
}
