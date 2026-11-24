// Product catalog + UPC extraction from a brand's DTC site.
// Waterfall: Shopify /products.json -> per-product .json -> page JSON-LD / embedded product JSON.
// Non-Shopify: sitemap.xml -> product pages -> JSON-LD.
import { fetchJson, fetchText, mapLimit, cleanGtin, sleep } from './util.js';
import { extractJsonLd, typeIs } from './site.js';

export const LIMITS = {
  MAX_VARIANTS: 300,          // per brand
  MAX_PRODUCT_PAGES: 300,     // product pages fetched for barcode lookups / non-Shopify scraping
  SHOPIFY_PAGES: 4,           // x 250 products
  CONCURRENCY: 3,
  POLITE_DELAY_MS: 250,
};

const GTIN_KEYS = ['gtin', 'gtin12', 'gtin13', 'gtin14', 'gtin8'];

function gtinFrom(obj) {
  for (const k of GTIN_KEYS) {
    const v = cleanGtin(obj?.[k]);
    if (v) return v;
  }
  return '';
}

/* ---------------- Shopify ---------------- */

async function shopifyCatalog(origin) {
  const products = [];
  for (let page = 1; page <= LIMITS.SHOPIFY_PAGES; page++) {
    const data = await fetchJson(`${origin}/products.json?limit=250&page=${page}`);
    if (!data || !Array.isArray(data.products)) return page === 1 ? null : products;
    if (!data.products.length) break;
    products.push(...data.products);
    if (data.products.length < 250) break;
  }
  return products;
}

function shopifyRows(origin, products) {
  const rows = [];
  for (const p of products) {
    const multi = (p.variants || []).length > 1;
    for (const v of p.variants || []) {
      const upc = cleanGtin(v.barcode);
      rows.push({
        _handle: p.handle,
        _variantId: String(v.id),
        product_title: p.title || '',
        variant_title: v.title && v.title !== 'Default Title' ? v.title : '',
        sku: v.sku || '',
        upc,
        upc_source: upc ? 'products.json' : '',
        price: v.price || '',
        compare_at_price: v.compare_at_price || '',
        available: v.available === undefined ? '' : (v.available ? 'Y' : 'N'),
        product_type: p.product_type || '',
        product_url: `${origin}/products/${p.handle}${multi ? `?variant=${v.id}` : ''}`,
        image_url: v.featured_image?.src || p.images?.[0]?.src || '',
      });
    }
  }
  return rows;
}

/** Embedded theme product JSON: map variant id / sku -> barcode. */
function barcodesFromScripts(html) {
  const byId = new Map(), bySku = new Map();
  const s = String(html || '');
  const skuMatches = [...s.matchAll(/"sku"\s*:\s*"([^"]*)"/g)];
  skuMatches.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < skuMatches.length ? skuMatches[i + 1].index : Math.min(s.length, start + 3000);
    const forward = s.slice(start, end);
    const bc = forward.match(/"barcode"\s*:\s*"(\d{8,14})"/);
    if (!bc) return;
    const gtin = cleanGtin(bc[1]);
    if (!gtin) return;
    if (m[1]) bySku.set(m[1], gtin);
    const back = s.slice(Math.max(0, start - 600), start);
    const ids = [...back.matchAll(/"id"\s*:\s*(\d{6,})/g)];
    if (ids.length) byId.set(ids[ids.length - 1][1], gtin);
  });
  return { byId, bySku };
}

/** JSON-LD offers: map variant id / sku -> gtin. */
function barcodesFromJsonLd(html) {
  const byId = new Map(), bySku = new Map();
  for (const node of extractJsonLd(html)) {
    const products = typeIs(node, 'ProductGroup') ? [node, ...[].concat(node.hasVariant || [])]
                   : typeIs(node, 'Product') ? [node] : [];
    for (const p of products) {
      const offers = [].concat(p.offers || []).flatMap(o => o?.offers ? [].concat(o.offers) : [o]);
      const productGtin = gtinFrom(p);
      if (productGtin && p.sku) bySku.set(String(p.sku), productGtin);
      for (const o of offers) {
        const g = gtinFrom(o) || (offers.length === 1 ? productGtin : '');
        if (!g) continue;
        const vid = String(o.url || '').match(/variant=(\d+)/)?.[1];
        if (vid) byId.set(vid, g);
        if (o.sku) bySku.set(String(o.sku), g);
      }
      if (productGtin && offers.length <= 1) byId.set('__single__', productGtin);
    }
  }
  return { byId, bySku };
}

async function fillShopifyBarcodes(origin, rows, deadline) {
  const handles = [...new Set(rows.filter(r => !r.upc).map(r => r._handle))].slice(0, LIMITS.MAX_PRODUCT_PAGES);
  const { stoppedEarly } = await mapLimit(handles, LIMITS.CONCURRENCY, async handle => {
    const variants = rows.filter(r => r._handle === handle && !r.upc);
    if (!variants.length) return;

    // 1) per-product JSON
    const pj = await fetchJson(`${origin}/products/${handle}.json`);
    for (const v of pj?.product?.variants || []) {
      const g = cleanGtin(v.barcode);
      const row = variants.find(r => r._variantId === String(v.id));
      if (g && row && !row.upc) { row.upc = g; row.upc_source = 'product.json'; }
    }
    if (variants.every(r => r.upc)) return;

    // 2) product page: JSON-LD, then embedded theme JSON
    const page = await fetchText(`${origin}/products/${handle}`);
    if (!page.ok) return;
    const ld = barcodesFromJsonLd(page.text);
    const sc = barcodesFromScripts(page.text);
    for (const r of variants) {
      if (r.upc) continue;
      const fromLd = ld.byId.get(r._variantId) || (r.sku && ld.bySku.get(r.sku))
                  || (variants.length === 1 ? ld.byId.get('__single__') : '');
      if (fromLd) { r.upc = fromLd; r.upc_source = 'json-ld'; continue; }
      const fromScript = sc.byId.get(r._variantId) || (r.sku && sc.bySku.get(r.sku));
      if (fromScript) { r.upc = fromScript; r.upc_source = 'page-script'; }
    }
    await sleep(LIMITS.POLITE_DELAY_MS);
  }, deadline);
  return { partial: stoppedEarly };
}

/* ---------------- Non-Shopify (sitemap + JSON-LD) ---------------- */

async function sitemapProductUrls(origin) {
  const xmlAccept = { accept: 'application/xml,text/xml,*/*' };
  const locs = xml => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)/gi)].map(m => m[1].replace(/&amp;/g, '&'));

  // Sitemap locations: robots.txt first, then common defaults
  const robots = await fetchText(`${origin}/robots.txt`, { accept: 'text/plain,*/*' });
  const candidates = robots.ok
    ? [...robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1])
    : [];
  candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);

  let urls = [];
  for (const sitemapUrl of [...new Set(candidates)].slice(0, 4)) {
    const root = await fetchText(sitemapUrl, xmlAccept);
    if (!root.ok || !/<loc>/i.test(root.text)) continue;
    if (/<sitemapindex/i.test(root.text)) {
      const children = locs(root.text);
      const productMaps = children.filter(u => /product/i.test(u));
      for (const sm of (productMaps.length ? productMaps : children).slice(0, 3)) {
        const r = await fetchText(sm, xmlAccept);
        if (r.ok) urls.push(...locs(r.text));
      }
    } else {
      urls.push(...locs(root.text));
    }
    if (urls.length) break;
  }
  const productLike = urls.filter(u => /\/(products?|shop|item|p)\/|\.html$/i.test(u) && !/\.(jpe?g|png|webp)$/i.test(u));
  return [...new Set(productLike.length ? productLike : urls)].slice(0, LIMITS.MAX_PRODUCT_PAGES);
}

function rowsFromJsonLd(html, pageUrl) {
  const rows = [];
  for (const node of extractJsonLd(html)) {
    const isGroup = typeIs(node, 'ProductGroup');
    if (!isGroup && !typeIs(node, 'Product')) continue;
    const items = isGroup ? [].concat(node.hasVariant || []) : [node];
    for (const p of items.length ? items : [node]) {
      const offers = [].concat(p.offers || []).flatMap(o => o?.offers ? [].concat(o.offers) : [o]).filter(Boolean);
      const image = [].concat(p.image || node.image || [])[0];
      const base = {
        product_title: node.name || p.name || '',
        product_type: node.category || p.category || '',
        image_url: typeof image === 'string' ? image : image?.url || '',
      };
      const productGtin = gtinFrom(p) || gtinFrom(node);
      const list = offers.length ? offers : [{}];
      for (const o of list) {
        const upc = gtinFrom(o) || (list.length === 1 ? productGtin : '');
        rows.push({
          ...base,
          variant_title: isGroup || list.length > 1 ? (o.name || p.name || '') : '',
          sku: String(o.sku || p.sku || ''),
          upc,
          upc_source: upc ? 'json-ld' : '',
          price: o.price ?? o.lowPrice ?? '',
          compare_at_price: '',
          available: o.availability ? (/InStock/i.test(o.availability) ? 'Y' : 'N') : '',
          product_url: o.url || p.url || pageUrl,
        });
      }
    }
  }
  return rows;
}

async function genericCatalog(origin, deadline) {
  const urls = await sitemapProductUrls(origin);
  const rows = [];
  const { stoppedEarly } = await mapLimit(urls, LIMITS.CONCURRENCY, async url => {
    const page = await fetchText(url);
    if (page.ok) rows.push(...rowsFromJsonLd(page.text, url));
    await sleep(LIMITS.POLITE_DELAY_MS);
  }, deadline);
  return { rows, partial: stoppedEarly, pagesChecked: urls.length };
}

/* ---------------- Entry point ---------------- */

/** Many brands use the UPC as their SKU. Use it when no barcode was found and it passes the check digit. */
function upcFromSku(rows) {
  for (const r of rows) {
    if (r.upc || !r.sku) continue;
    const g = cleanGtin(r.sku);
    if (g && /^\d+$/.test(String(r.sku).trim())) { r.upc = g; r.upc_source = 'sku'; }
  }
  return rows;
}

/** Returns { rows, method, partial } for a brand's website origin. */
export async function scanCatalog(origin, deadline) {
  const shopify = await shopifyCatalog(origin);
  if (shopify && shopify.length) {
    const rows = shopifyRows(origin, shopify).slice(0, LIMITS.MAX_VARIANTS);
    const { partial } = await fillShopifyBarcodes(origin, rows, deadline);
    return { rows: upcFromSku(rows), method: 'shopify', partial };
  }
  const generic = await genericCatalog(origin, deadline);
  const seen = new Set();
  const rows = generic.rows.filter(r => {
    const key = `${r.product_title}|${r.variant_title}|${r.sku}|${r.upc}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, LIMITS.MAX_VARIANTS);
  return { rows: upcFromSku(rows), method: 'sitemap+json-ld', partial: generic.partial };
}

// exported for tests
export { barcodesFromScripts, barcodesFromJsonLd, rowsFromJsonLd };
