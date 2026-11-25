/**
 * api/_lib/spapi.js
 *
 * Amazon Selling Partner API (US). LWA-only auth (AWS signing is no longer required by SP-API).
 * Env: SP_CLIENT_ID, SP_CLIENT_SECRET, SP_REFRESH_TOKEN, optional SP_MARKETPLACE_ID
 */
import { sleep, cleanGtin } from './util.js';

const ENDPOINT = 'https://sellingpartnerapi-na.amazon.com';
export const MARKETPLACE_ID = (process.env.SP_MARKETPLACE_ID || 'ATVPDKIKX0DER').trim();

let lwa = { token: null, exp: 0 };
async function accessToken() {
  if (lwa.token && Date.now() < lwa.exp - 60000) return lwa.token;
  const env = k => (process.env[k] || '').trim();
  if (!env('SP_CLIENT_ID') || !env('SP_CLIENT_SECRET') || !env('SP_REFRESH_TOKEN')) {
    throw new Error('Missing SP_CLIENT_ID, SP_CLIENT_SECRET, or SP_REFRESH_TOKEN env var');
  }
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env('SP_REFRESH_TOKEN'),
      client_id: env('SP_CLIENT_ID'),
      client_secret: env('SP_CLIENT_SECRET'),
    }),
  });
  if (!res.ok) throw new Error(`LWA error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  lwa = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return lwa.token;
}

// Simple per-operation throttles (SP-API rate limits)
const throttles = { catalog: { gap: 600, last: 0 }, offers: { gap: 10500, last: 0 } };
async function throttle(op) {
  const t = throttles[op];
  const wait = t.last + t.gap - Date.now();
  if (wait > 0) await sleep(wait);
  t.last = Date.now();
}

async function sp(path, { method = 'GET', body, op = 'catalog' } = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await throttle(op);
    const res = await fetch(`${ENDPOINT}${path}`, {
      method,
      headers: { 'x-amz-access-token': await accessToken(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(2000 * attempt); continue; }
    throw new Error(`SP-API ${res.status} ${path.split('?')[0]}: ${(await res.text()).slice(0, 300)}`);
  }
}

function summarize(item) {
  const summary = (item.summaries || []).find(s => s.marketplaceId === MARKETPLACE_ID) || item.summaries?.[0] || {};
  const ranks = (item.salesRanks || []).find(r => r.marketplaceId === MARKETPLACE_ID) || item.salesRanks?.[0] || {};
  const top = ranks.displayGroupRanks?.[0] || ranks.classificationRanks?.[0];
  const ids = (item.identifiers || []).flatMap(g => g.identifiers || []).map(i => String(i.identifier));
  return {
    asin: item.asin,
    title: summary.itemName || '',
    brand: summary.brand || '',
    salesRank: top ? `#${Number(top.rank).toLocaleString('en-US')} in ${top.title}` : '',
    rankNumber: top ? Number(top.rank) : null,
    identifiers: ids,
  };
}

const INCLUDED = 'summaries,identifiers,salesRanks';

/** Look up UPC/EAN codes (20 per call). Returns Map(code -> first matching item summary). */
export async function lookupCodes(codes) {
  const found = new Map();
  const key = c => String(c).replace(/^0+/, '');

  async function search(batch, type) {
    const qs = new URLSearchParams({
      identifiers: batch.join(','), identifiersType: type,
      marketplaceIds: MARKETPLACE_ID, includedData: INCLUDED, pageSize: '20',
    });
    const data = await sp(`/catalog/2022-04-01/items?${qs}`);
    for (const item of data.items || []) {
      const s = summarize(item);
      for (const code of batch) {
        if (!found.has(code) && s.identifiers.some(id => key(id) === key(code))) found.set(code, s);
      }
    }
  }

  const upcs = codes.filter(c => c.length === 12);
  const eans = codes.filter(c => c.length === 13);
  for (let i = 0; i < upcs.length; i += 20) await search(upcs.slice(i, i + 20), 'UPC');
  for (let i = 0; i < eans.length; i += 20) await search(eans.slice(i, i + 20), 'EAN');

  // Amazon sometimes stores a UPC as a 13-digit EAN with a leading zero: retry misses that way
  const missed = upcs.filter(c => !found.has(c)).map(c => '0' + c);
  for (let i = 0; i < missed.length; i += 20) {
    const batch = missed.slice(i, i + 20);
    await search(batch, 'EAN');
    for (const ean of batch) if (found.has(ean)) { found.set(ean.slice(1), found.get(ean)); found.delete(ean); }
  }
  return found;
}

/** Catalog search by brand. Returns item summaries whose brand matches. */
export async function searchBrand(brandName) {
  const qs = new URLSearchParams({
    keywords: brandName, brandNames: brandName,
    marketplaceIds: MARKETPLACE_ID, includedData: INCLUDED, pageSize: '20',
  });
  const data = await sp(`/catalog/2022-04-01/items?${qs}`);
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return (data.items || []).map(summarize).filter(s => norm(s.brand) === norm(brandName));
}

/** Offers for up to 20 ASINs per call (rate limit ~1 call / 10s). Returns Map(asin -> offer summary). */
export async function getOffers(asins) {
  const out = new Map();
  const me = (process.env.SP_SELLER_ID || '').trim();
  for (let i = 0; i < asins.length; i += 20) {
    const batch = asins.slice(i, i + 20);
    const data = await sp('/batches/products/pricing/v0/itemOffers', {
      method: 'POST', op: 'offers',
      body: {
        requests: batch.map(asin => ({
          uri: `/products/pricing/v0/items/${asin}/offers`, method: 'GET',
          MarketplaceId: MARKETPLACE_ID, ItemCondition: 'New', CustomerType: 'Consumer',
        })),
      },
    });
    for (const r of data.responses || []) {
      const asin = r.body?.payload?.ASIN || String(r.request?.uri || '').match(/items\/([A-Z0-9]{10})\//)?.[1];
      if (!asin) continue;
      const p = r.body?.payload || {};
      const offers = p.Offers || [];
      const bb = (p.Summary?.BuyBoxPrices || []).find(b => /new/i.test(b.condition)) || p.Summary?.BuyBoxPrices?.[0];
      const winner = offers.find(o => o.IsBuyBoxWinner);
      out.set(asin, {
        offerCount: p.Summary?.TotalOfferCount ?? offers.length,
        sellerCount: new Set(offers.map(o => o.SellerId)).size,
        buyBoxPrice: bb?.ListingPrice?.Amount ?? winner?.ListingPrice?.Amount ?? '',
        buyBoxFba: winner ? (winner.IsFulfilledByAmazon ? 'FBA' : 'FBM') : '',
        buyBoxSellerId: winner?.SellerId || '',
        sellerIds: [...new Set(offers.map(o => o.SellerId).filter(Boolean))],
        medaltusSells: me ? offers.some(o => o.SellerId === me) : false,
      });
    }
  }
  return out;
}

/**
 * Full offer detail for up to 20 ASINs per call (used by the gap audit).
 * Returns Map(asin -> { offerCount, buyBoxPrice, offers: [{ sellerId, price, fba, buyBox, feedbackCount, feedbackPct }] }).
 */
export async function getOfferDetails(asins) {
  const out = new Map();
  for (let i = 0; i < asins.length; i += 20) {
    const batch = asins.slice(i, i + 20);
    const data = await sp('/batches/products/pricing/v0/itemOffers', {
      method: 'POST', op: 'offers',
      body: {
        requests: batch.map(asin => ({
          uri: `/products/pricing/v0/items/${asin}/offers`, method: 'GET',
          MarketplaceId: MARKETPLACE_ID, ItemCondition: 'New', CustomerType: 'Consumer',
        })),
      },
    });
    for (const r of data.responses || []) {
      const asin = r.body?.payload?.ASIN || String(r.request?.uri || '').match(/items\/([A-Z0-9]{10})\//)?.[1];
      if (!asin) continue;
      const p = r.body?.payload || {};
      const bb = (p.Summary?.BuyBoxPrices || []).find(b => /new/i.test(b.condition)) || p.Summary?.BuyBoxPrices?.[0];
      const offers = (p.Offers || []).map(o => ({
        sellerId: o.SellerId || '',
        price: Number(o.ListingPrice?.Amount) || null,
        shipping: Number(o.Shipping?.Amount) || 0,
        fba: !!o.IsFulfilledByAmazon,
        buyBox: !!o.IsBuyBoxWinner,
        feedbackCount: o.SellerFeedbackRating?.FeedbackCount ?? null,
        feedbackPct: o.SellerFeedbackRating?.SellerPositiveFeedbackRating ?? null,
      }));
      out.set(asin, {
        offerCount: p.Summary?.TotalOfferCount ?? offers.length,
        buyBoxPrice: Number(bb?.ListingPrice?.Amount) || offers.find(o => o.buyBox)?.price || null,
        offers,
        error: r.status?.statusCode >= 400 ? (r.body?.errors?.[0]?.message || `status ${r.status.statusCode}`) : '',
      });
    }
  }
  return out;
}

/**
 * Catalog detail for up to 20 ASINs per call: title, brand, rank, image count, bullets, description.
 * Returns Map(asin -> detail).
 */
export async function getCatalogDetails(asins) {
  const out = new Map();
  for (let i = 0; i < asins.length; i += 20) {
    const batch = asins.slice(i, i + 20);
    const qs = new URLSearchParams({
      identifiers: batch.join(','), identifiersType: 'ASIN', marketplaceIds: MARKETPLACE_ID,
      includedData: 'summaries,images,attributes,salesRanks,relationships', pageSize: '20',
    });
    const data = await sp(`/catalog/2022-04-01/items?${qs}`);
    for (const item of data.items || []) {
      const base = summarize(item);
      const imgSet = (item.images || []).find(s => s.marketplaceId === MARKETPLACE_ID) || item.images?.[0] || {};
      const variants = new Set((imgSet.images || []).map(im => im.variant).filter(Boolean));
      const attrs = item.attributes || {};
      const bullets = (attrs.bullet_point || []).map(b => String(b.value || '').trim()).filter(Boolean);
      const description = (attrs.product_description || []).map(d => String(d.value || '')).join(' ').trim();
      const mainImage = (imgSet.images || []).filter(im => im.variant === 'MAIN').sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.link || '';
      const rel = (item.relationships || []).find(r => r.marketplaceId === MARKETPLACE_ID) || item.relationships?.[0] || {};
      const parentAsin = (rel.relationships || []).flatMap(r => r.parentAsins || [])[0] || '';
      out.set(item.asin, {
        ...base,
        parentAsin,
        imageCount: variants.size,
        mainImage,
        bulletCount: bullets.length,
        hasDescription: description.length > 40,
        titleLength: base.title.length,
      });
    }
  }
  return out;
}

/**
 * Best-effort storefront names from Amazon's public seller pages. SP-API doesn't return names,
 * and Amazon sometimes serves a robot check, so unknown names come back as ''.
 */
export async function getSellerNames(sellerIds) {
  const names = new Map();
  for (const id of [...new Set(sellerIds.filter(Boolean))]) {
    try {
      const res = await fetch(`https://www.amazon.com/sp?seller=${encodeURIComponent(id)}&marketplaceID=${MARKETPLACE_ID}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(10000),
      });
      const html = res.ok ? await res.text() : '';
      const m = html.match(/id=["']seller-name["'][^>]*>([^<]{1,120})</i)
        || html.match(/<h1[^>]*>\s*([^<]{1,120}?)\s*<\/h1>/i);
      const name = m ? m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim() : '';
      names.set(id, /robot|captcha|sorry/i.test(name) ? '' : name);
    } catch { names.set(id, ''); }
    await sleep(700);
  }
  return names;
}

export { cleanGtin };
