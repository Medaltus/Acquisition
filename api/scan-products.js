/**
 * api/scan-products.js
 *
 * Every 2 hours. For "Enriched" brands: pulls the DTC product catalog and UPCs into "Products",
 * then writes product_count, upc_coverage, and status back to "Brands".
 * Manual: /api/scan-products?key=<CRON_SECRET>&brand_id=<id>
 * To rescan a brand: delete its rows in Products, set discovery_status back to "Enriched".
 */
import { TABS, STATUS } from './_lib/schema.js';
import { readTab, appendRows, updateRows, logRun } from './_lib/sheets.js';
import { isAuthorized, nowIso } from './_lib/util.js';
import { scanCatalog } from './_lib/products.js';

const BRANDS_PER_RUN = 3;
const TIME_BUDGET_MS = 250000;

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const deadline = Date.now() + TIME_BUDGET_MS;
  const errors = [], summary = [];
  let productRowsAdded = 0;

  try {
    const [brands, products] = await Promise.all([readTab(TABS.BRANDS), readTab(TABS.PRODUCTS)]);
    const alreadyScanned = new Set(products.rows.map(p => p.brand_id));

    const queue = req.query?.brand_id
      ? brands.rows.filter(b => b.brand_id === req.query.brand_id)
      : brands.rows.filter(b => b.discovery_status === STATUS.ENRICHED && b.website_url).slice(0, BRANDS_PER_RUN);

    for (const b of queue) {
      if (Date.now() > deadline - 30000) break;        // leave time to write results
      try {
        if (alreadyScanned.has(b.brand_id)) {
          errors.push(`${b.brand_name}: already has Products rows, skipped (delete them to rescan)`);
          continue;
        }
        const origin = new URL(b.website_url).origin;
        const { rows, method, partial } = await scanCatalog(origin, deadline - 30000);

        const stamp = nowIso();
        const out = rows.map(({ _handle, _variantId, ...r }) => ({
          brand_id: b.brand_id, brand_name: b.brand_name, last_scraped: stamp, ...r,
        }));
        await appendRows(TABS.PRODUCTS, products.headers, out);
        productRowsAdded += out.length;

        const withUpc = out.filter(r => r.upc).length;
        const productCount = new Set(out.map(r => r.product_title)).size;
        const status = !out.length ? STATUS.NO_PRODUCTS : partial ? STATUS.PRODUCTS_PARTIAL : STATUS.PRODUCTS_SCANNED;
        const data = {
          product_count: productCount,
          upc_coverage: out.length ? `${Math.round((withUpc / out.length) * 100)}%` : '0%',
          discovery_status: status,
        };
        if (!b.platform && method === 'shopify') data.platform = 'Shopify';
        await updateRows(TABS.BRANDS, brands.headers, [{ row: b._row, data }]);
        summary.push(`${b.brand_name}: ${out.length} variants, ${withUpc} UPCs (${method}${partial ? ', partial' : ''})`);
      } catch (e) {
        errors.push(`${b.brand_name}: ${e.message}`);
      }
    }

    await logRun({
      job: 'scan-products', processed: queue.length, added: productRowsAdded,
      errors: errors.join(' || '), notes: summary.join(' || '),
    });
    res.status(200).json({ ok: true, summary, errors });
  } catch (err) {
    console.error('scan-products error:', err);
    await logRun({ job: 'scan-products', errors: err.message });
    res.status(500).json({ error: err.message });
  }
}
