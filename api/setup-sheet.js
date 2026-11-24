// One-time (safe to re-run): creates any missing tabs, adds any missing column headers,
// and seeds the Sources tab with starter sources if it's empty.
// Run: https://<your-deployment>/api/setup-sheet?key=<CRON_SECRET>
import { TABS, HEADERS, SEED_SOURCES, SOURCE_UPGRADES } from './_lib/schema.js';
import { listTabs, addTab, readTab, writeHeaderCells, appendRows, updateRows } from './_lib/sheets.js';
import { isAuthorized } from './_lib/util.js';

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const report = [];
    const existing = await listTabs();

    for (const tab of Object.values(TABS)) {
      if (!existing.includes(tab)) { await addTab(tab); report.push(`Created tab "${tab}"`); }
      const { headers } = await readTab(tab);
      const missing = HEADERS[tab].filter(h => !headers.includes(h));
      if (missing.length) {
        await writeHeaderCells(tab, headers.length, missing);
        report.push(`"${tab}": added ${missing.length} column(s)`);
      }
    }

    const sources = await readTab(TABS.SOURCES);
    if (!sources.rows.length) {
      await appendRows(TABS.SOURCES, sources.headers, SEED_SOURCES);
      report.push(`Seeded ${SEED_SOURCES.length} starter sources`);
    } else {
      // Upgrade original "search" seed rows to the Shopify vendor method
      const upgrades = [];
      for (const up of SOURCE_UPGRADES) {
        const row = sources.rows.find(r => r.source_name === up.source_name && r.source_type === 'search');
        if (row) upgrades.push({ row: row._row, data: { source_type: up.source_type, source_value: up.source_value, last_run: '' } });
      }
      if (upgrades.length) {
        await updateRows(TABS.SOURCES, sources.headers, upgrades);
        report.push(`Upgraded ${upgrades.length} source(s) to shopify_vendors`);
      }
    }

    res.status(200).json({ ok: true, report: report.length ? report : ['Sheet already set up'] });
  } catch (err) {
    console.error('setup-sheet error:', err);
    res.status(500).json({ error: err.message });
  }
}
