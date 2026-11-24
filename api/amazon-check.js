/**
 * api/amazon-check.js
 *
 * Every 2 hours. For brands whose products have been scanned: looks up their UPCs on Amazon,
 * falls back to a brand-name catalog search, pulls offers/Buy Box, and classifies the brand.
 * Re-checks "Not on Amazon" brands every RECHECK_DAYS to catch a first listing appearing.
 * Manual: /api/amazon-check?key=<CRON_SECRET>&brand_id=<id>
 */
import { TABS, STATUS, AMAZON_STATUS } from './_lib/schema.js';
import { readTab, updateRows, logRun } from './_lib/sheets.js';
import { isAuthorized, nowIso, appendUnique } from './_lib/util.js';
import { lookupCodes, searchBrand, getOffers } from './_lib/spapi.js';

const BRANDS_PER_RUN = 5;
const MAX_UPCS_PER_BRAND = 100;
const MAX_ASINS_FOR_OFFERS = 40;
const RECHECK_DAYS = 30;
const RESELLER_SELLER_THRESHOLD = 3;   // 3+ sellers on any listing
const UNDERCUT_THRESHOLD = -0.10;      // Buy Box 10%+ below the brand's own site price
const TIME_BUDGET_MS = 250000;

const READY = [STATUS.PRODUCTS_SCANNED, STATUS.PRODUCTS_PARTIAL, STATUS.NO_PRODUCTS];

function median(nums) {
  const a = nums.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const pct = n => (n === null ? '' : `${n > 0 ? '+' : ''}${Math.round(n * 100)}%`);

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const deadline = Date.now() + TIME_BUDGET_MS;
  const errors = [], summary = [];

  try {
    const [brands, products] = await Promise.all([readTab(TABS.BRANDS), readTab(TABS.PRODUCTS)]);
    const recheckBefore = Date.now() - RECHECK_DAYS * 86400000;

    const queue = req.query?.brand_id
      ? brands.rows.filter(b => b.brand_id === req.query.brand_id)
      : brands.rows.filter(b => READY.includes(b.discovery_status) && (
          !b.amazon_checked_at ||
          (b.amazon_status === AMAZON_STATUS.NOT_ON_AMAZON && Date.parse(b.amazon_checked_at) < recheckBefore)
        )).slice(0, BRANDS_PER_RUN);

    for (const b of queue) {
      if (Date.now() > deadline - 40000) break;
      try {
        const stamp = nowIso();
        const rows = products.rows.filter(p => p.brand_id === b.brand_id);
        const notes = [];

        // 1) UPC lookups (override hero_upcs first, then scraped UPCs)
        const heroUpcs = String(b.hero_upcs || '').split(/[\s,|]+/).filter(Boolean);
        const codes = [...new Set([...heroUpcs, ...rows.map(r => r.upc)].map(c => String(c || '').replace(/\D/g, '')).filter(c => c.length === 12 || c.length === 13))]
          .slice(0, MAX_UPCS_PER_BRAND);
        const byCode = codes.length ? await lookupCodes(codes) : new Map();

        // 2) Brand-name catalog search (catches listings without UPC matches and name differences)
        const searchName = b.amazon_brand_name || b.brand_name;
        let brandHits = [];
        try { brandHits = await searchBrand(searchName); } catch (e) { notes.push(`Brand search failed: ${e.message}`); }

        // 3) Offers / Buy Box for everything found
        const items = new Map();
        for (const s of byCode.values()) items.set(s.asin, s);
        for (const s of brandHits) if (!items.has(s.asin)) items.set(s.asin, s);
        const heroAsins = String(b.hero_asins || '').split(/[\s,|]+/).filter(a => /^[A-Z0-9]{10}$/.test(a));
        const asins = [...new Set([...heroAsins, ...items.keys()])].slice(0, MAX_ASINS_FOR_OFFERS);
        const offers = asins.length ? await getOffers(asins) : new Map();

        // 4) Write product-level matches
        const productUpdates = [], gaps = [];
        for (const r of rows) {
          const code = String(r.upc || '').replace(/\D/g, '');
          if (!code) continue;
          const hit = byCode.get(code);
          if (!hit) {
            productUpdates.push({ row: r._row, data: { match_method: 'upc: not found', last_amazon_check: stamp } });
            continue;
          }
          const o = offers.get(hit.asin) || {};
          const sitePrice = parseFloat(r.price);
          const bbPrice = parseFloat(o.buyBoxPrice);
          const gap = sitePrice > 0 && bbPrice > 0 ? (bbPrice - sitePrice) / sitePrice : null;
          if (gap !== null) gaps.push(gap);
          productUpdates.push({ row: r._row, data: {
            asin: hit.asin, match_method: 'upc', amazon_title: hit.title, amazon_brand: hit.brand,
            sales_rank: hit.salesRank, buy_box_price: o.buyBoxPrice ?? '', buy_box_fba: o.buyBoxFba ?? '',
            offer_count: o.offerCount ?? '', seller_count: o.sellerCount ?? '', price_gap: pct(gap),
            last_amazon_check: stamp,
          } });
        }
        await updateRows(TABS.PRODUCTS, products.headers, productUpdates);

        // 5) Classify the brand
        const offerList = asins.map(a => offers.get(a)).filter(Boolean);
        const withOffers = offerList.filter(o => o.offerCount > 0);
        const maxSellers = offerList.reduce((m, o) => Math.max(m, o.sellerCount || 0), 0);
        const medianGap = median(gaps);
        let status;
        if (!asins.length) status = AMAZON_STATUS.NOT_ON_AMAZON;
        else if (!withOffers.length) status = AMAZON_STATUS.NO_OFFERS;
        else if (maxSellers >= RESELLER_SELLER_THRESHOLD || (medianGap !== null && medianGap <= UNDERCUT_THRESHOLD)) status = AMAZON_STATUS.RESELLERS;
        else status = AMAZON_STATUS.SINGLE;

        if (!codes.length) notes.push('No UPCs: result based on brand-name search only');
        if (asins.length && !byCode.size) notes.push('Found by brand search only; verify listings belong to this brand');
        if (medianGap !== null && medianGap <= UNDERCUT_THRESHOLD) notes.push(`Amazon priced ${pct(medianGap)} vs site`);
        if (offerList.some(o => o.medaltusSells)) notes.push('A Medaltus account already sells this brand');
        const fbmCount = offerList.filter(o => o.buyBoxFba === 'FBM').length;
        if (fbmCount) notes.push(`${fbmCount} listing(s) with a merchant-fulfilled (FBM) Buy Box`);

        const amazonBrands = [...new Set([...items.values()].map(s => s.brand).filter(Boolean))];
        const listedAs = amazonBrands.find(x => x.toLowerCase() !== String(b.brand_name).toLowerCase());

        const data = {
          amazon_status: status,
          amazon_asin_count: asins.length,
          amazon_upc_matches: codes.length ? `${byCode.size} of ${codes.length}` : '0 of 0',
          amazon_max_sellers: maxSellers,
          amazon_price_gap: pct(medianGap),
          amazon_checked_at: stamp,
          amazon_notes: notes.join('; '),
        };
        if (listedAs && !b.amazon_brand_name) data.amazon_brand_name = listedAs;
        if (b.amazon_status === AMAZON_STATUS.NOT_ON_AMAZON && status !== AMAZON_STATUS.NOT_ON_AMAZON) {
          data.signals = appendUnique(b.signals, `First Amazon listing detected ${stamp.slice(0, 10)}`);
        }
        await updateRows(TABS.BRANDS, brands.headers, [{ row: b._row, data }]);
        summary.push(`${b.brand_name}: ${status} (${asins.length} ASINs, UPC matches ${data.amazon_upc_matches}, max sellers ${maxSellers}${medianGap !== null ? `, price gap ${pct(medianGap)}` : ''})`);
      } catch (e) {
        errors.push(`${b.brand_name}: ${e.message}`);
      }
    }

    await logRun({ job: 'amazon-check', processed: queue.length, updated: summary.length,
      errors: errors.join(' || '), notes: summary.join(' || ') });
    res.status(200).json({ ok: true, summary, errors });
  } catch (err) {
    console.error('amazon-check error:', err);
    await logRun({ job: 'amazon-check', errors: err.message });
    res.status(500).json({ error: err.message });
  }
}
