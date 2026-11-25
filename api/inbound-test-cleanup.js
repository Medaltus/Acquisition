/**
 * api/inbound-test-cleanup.js
 *
 * Removes everything created by inbound test submissions: every row whose brand_id starts with "test-"
 * (Brands, Products, Contacts, Audit Data, Audit Findings, Audit Builds) and every Inbound Log row from a
 * test submission (submission ID starting with "test-", or a test brand). Real prospects are never touched.
 *
 * GET ?key=<CRON_SECRET>              shows what would be deleted (nothing is deleted)
 * GET ?key=<CRON_SECRET>&confirm=yes  deletes it
 */
import { TABS } from './_lib/schema.js';
import { readTab, deleteRows, logRun } from './_lib/sheets.js';
import { isAuthorized } from './_lib/util.js';

const BRAND_TABS = [TABS.BRANDS, TABS.PRODUCTS, TABS.CONTACTS, TABS.AUDIT_DATA, TABS.AUDIT_FINDINGS, TABS.AUDIT_BUILDS];
const isTestId = id => String(id || '').startsWith('test-');

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const confirm = req.query?.confirm === 'yes';
  try {
    const found = {};
    for (const tab of BRAND_TABS) {
      const { rows } = await readTab(tab);
      found[tab] = rows.filter(r => isTestId(r.brand_id));
    }
    const log = await readTab(TABS.INBOUND);
    found[TABS.INBOUND] = log.rows.filter(r => isTestId(r.submission_id) || isTestId(r.brand_id) || String(r.outcome).startsWith('TEST:'));

    const summary = Object.fromEntries(Object.entries(found).map(([tab, rows]) => [tab, rows.length]));
    const brands = found[TABS.BRANDS].map(b => `${b.brand_name} (${b.brand_id})`);
    if (!confirm) {
      return res.status(200).json({ ok: true, dryRun: true, wouldDelete: summary, testBrands: brands,
        next: 'Add &confirm=yes to delete these rows.' });
    }

    for (const [tab, rows] of Object.entries(found)) await deleteRows(tab, rows.map(r => r._row));
    await logRun({ job: 'inbound-test-cleanup', processed: brands.length, notes: JSON.stringify(summary) });
    res.status(200).json({ ok: true, deleted: summary, testBrands: brands });
  } catch (err) {
    console.error('inbound-test-cleanup error:', err);
    res.status(500).json({ error: err.message });
  }
}
