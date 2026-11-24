// Dashboard: product list for one brand. GET /api/brand-products?brand_id=<id>
import { TABS } from './_lib/schema.js';
import { readTab } from './_lib/sheets.js';
import { isDashboardAuthorized } from './_lib/util.js';

const FIELDS = [
  'product_title', 'variant_title', 'sku', 'upc', 'price', 'available', 'product_url', 'image_url',
  'asin', 'match_method', 'amazon_title', 'sales_rank', 'buy_box_price', 'buy_box_fba',
  'offer_count', 'seller_count', 'price_gap',
];

export default async function handler(req, res) {
  if (!isDashboardAuthorized(req)) return res.status(401).json({ error: 'Wrong or missing dashboard password' });
  const brandId = String(req.query?.brand_id || '');
  if (!brandId) return res.status(400).json({ error: 'brand_id is required' });
  try {
    const { rows } = await readTab(TABS.PRODUCTS);
    const products = rows.filter(r => r.brand_id === brandId)
      .map(r => Object.fromEntries(FIELDS.map(f => [f, r[f] ?? ''])));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, products });
  } catch (err) {
    console.error('brand-products error:', err);
    res.status(500).json({ error: err.message });
  }
}
