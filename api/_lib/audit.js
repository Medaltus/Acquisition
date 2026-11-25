/**
 * api/_lib/audit.js
 *
 * Gap audit logic: product cleanup, listing scorecard, findings library, model recommendation.
 * Everything here is deterministic. Claude only rewrites copy, and that copy is checked against
 * the numbers in the data before it's kept (see copyIsGrounded).
 */
import { normalizeName } from './util.js';

/* ───────────── Product cleanup ───────────── */

const NON_BEAUTY = /\b(gift ?cards?|e-?gift|sweatshirts?|t-?shirts?|tees?|hoodies?|hats?|caps?|totes?|socks|cosmetics? bag|signature bag|merch|dried|snacks?)\b/i;

export function isNonBeauty(row) {
  return NON_BEAUTY.test(`${row.product_title} ${row.product_type}`) || /gift card/i.test(row.product_type || '');
}
export const isBundle = row => /\b(set|bundle|duo|trio|kit|edit|collection|pack)\b/i.test(row.product_title || '');

/** Size in ml from text like "30ml", "1 fl oz", "0.5 oz | 15 ml", "120ml". Returns null if none. */
export function sizeMl(text) {
  const t = String(text || '').toLowerCase();
  const ml = t.match(/(\d+(?:\.\d+)?)\s*(ml|mL)\b/i);
  if (ml) return Number(ml[1]);
  const floz = t.match(/(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|fluid ounces?)/);
  if (floz) return Math.round(Number(floz[1]) * 29.57);
  const oz = t.match(/(\d+(?:\.\d+)?)\s*oz\b/);
  if (oz) return Math.round(Number(oz[1]) * 29.57);
  return null;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'by', 'of', 'a', 'oz', 'ml', 'fl', 'face', 'skin', 'new']);
const tokens = (s, brand) => {
  const b = new Set(String(brand || '').toLowerCase().split(/[^a-z0-9]+/));
  return new Set(String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w) && !b.has(w) && !/^\d+$/.test(w)));
};
/** Share of the site product's title words that appear in the Amazon title (0–1). */
export function titleOverlap(siteTitle, amazonTitle, brand) {
  const a = tokens(siteTitle, brand), b = tokens(amazonTitle, brand);
  if (!a.size) return 1;
  let hit = 0; for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

/**
 * Decide whether a site-vs-Amazon price comparison is trustworthy.
 * Returns { valid, reason }. Invalid comparisons are shown in the builder but never used in findings.
 */
export function judgeComparison(row, amazonTitle, upcShareCount, brand) {
  if (isNonBeauty(row)) return { valid: false, reason: 'Not a beauty product' };
  if (upcShareCount > 1) return { valid: false, reason: `UPC is used on ${upcShareCount} different site variants` };
  const siteMl = sizeMl(`${row.variant_title} ${row.product_title}`);
  const azMl = sizeMl(amazonTitle);
  if (siteMl && azMl && Math.abs(siteMl - azMl) / Math.max(siteMl, azMl) > 0.15) {
    return { valid: false, reason: `Size differs (site ${siteMl}ml, Amazon ${azMl}ml)` };
  }
  if (titleOverlap(row.product_title, amazonTitle, brand) < 0.34) {
    return { valid: false, reason: 'Product names don’t match; check it’s the same item' };
  }
  return { valid: true, reason: '' };
}

/** Is this seller the brand itself? true / false / null (name unknown). */
export function sellerIsBrand(sellerName, brand) {
  if (!sellerName) return null;
  const s = normalizeName(sellerName);
  const names = [brand.brand_name, brand.amazon_brand_name].filter(Boolean).map(normalizeName).filter(n => n.length >= 3);
  return names.some(n => s.includes(n) || n.includes(s));
}

/* ───────────── Listing scorecard (10 points) ───────────── */
// Fixed rubric so every prospect is scored the same way. Edit points here, not per audit.
export const RUBRIC = [
  { key: 'title', label: 'Title 80–200 characters', points: 1, test: d => d.title_length >= 80 && d.title_length <= 200 },
  { key: 'bullets', label: '5 bullet points', points: 1, test: d => d.bullets >= 5 },
  { key: 'images', label: '7+ images (5–6 earns 1)', points: 2, test: d => d.images >= 7 ? 2 : d.images >= 5 ? 1 : 0 },
  { key: 'video', label: 'Product video', points: 1, test: d => d.video === 'Yes' },
  { key: 'aplus', label: 'A+ content', points: 2, test: d => d.aplus === 'Yes' },
  { key: 'rating', label: 'Rating 4.3 or higher', points: 1, test: d => d.rating >= 4.3 },
  { key: 'reviews', label: '250+ reviews (50+ earns 1)', points: 2, test: d => d.reviews >= 250 ? 2 : d.reviews >= 50 ? 1 : 0 },
];

/** d = { title_length, bullets, images, video, aplus, rating, reviews } with '' for unknown. */
export function scoreListing(d) {
  let score = 0; const unknown = [], parts = [];
  for (const r of RUBRIC) {
    const v = d[r.key];
    if (v === '' || v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) { unknown.push(r.label); continue; }
    const got = typeof r.test(d) === 'number' ? r.test(d) : (r.test(d) ? r.points : 0);
    score += got; parts.push({ key: r.key, label: r.label, got, of: r.points });
  }
  return { score, unknown, parts };
}

/* ───────────── Facts: latest scan rows -> one object ───────────── */

const num = v => { const n = Number(String(v ?? '').replace(/[$,%\s★]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const parseJ = v => { try { return JSON.parse(v); } catch { return null; } };
export const fmtMoney = n => `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
export const fmtPct = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n * 100))}%`;
export const fmtK = n => n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
export const joinAnd = a => a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`;
const titleCase = w => (w.length > 3 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w);
/** Short, readable product name: drops the brand, sizes, and SEO tails ("for dry hair", "| 30 ml"). */
export function shortName(t, brand = '') {
  const b = String(brand || '').toLowerCase().trim();
  const segs = String(t || '').split(/\s+[-–—|]\s+/).map(s => s.trim()).filter(Boolean);
  let seg = [...segs].filter(s => s.toLowerCase() !== b).sort((x, y) => y.split(' ').length - x.split(' ').length)[0] || segs[0] || '';
  if (b && seg.toLowerCase().startsWith(b + ' ')) seg = seg.slice(b.length + 1);
  seg = seg.replace(/[(\[,|].*$/, '').replace(/\s+(to|for|with|by)\s.*$/i, '').replace(/[™®]/g, '').trim();
  const allCaps = seg === seg.toUpperCase() && /[A-Z]/.test(seg);
  const words = seg.split(/\s+/).slice(0, 5);
  while (words.length > 1 && /^(and|&|with|for|the|of|to|in)$/i.test(words[words.length - 1])) words.pop();
  return words.map(w => (allCaps ? w[0] + w.slice(1).toLowerCase() : titleCase(w))).join(' ');
}
let BRAND = '';
const shortN = t => shortName(t, BRAND);

/** rows = Audit Data rows for one scan. Excluded rows are dropped. */
export function buildFacts(rows) {
  const live = rows.filter(r => r.verified !== 'Excluded');
  const by = Object.fromEntries(live.map(r => [r.field, r]));
  const val = k => by[k]?.value ?? '';
  const f = { by, val, rows: live };

  f.channels = {};
  for (const ch of ['shopify', 'amazon', 'walmart', 'target_plus', 'tiktok_shop']) {
    f.channels[ch] = { status: val(`channel.${ch}.status`), detail: val(`channel.${ch}.detail`), ref: `channel.${ch}.status` };
  }
  f.pricing = live.filter(r => r.field.startsWith('pricing.') && r.field.endsWith('.compare'))
    .map(r => ({ ...parseJ(r.value), ref: r.field })).filter(p => p && p.valid);
  f.sellers = live.filter(r => /^control\.[A-Z0-9]{10}\.sellers$/.test(r.field))
    .map(r => ({ asin: r.field.split('.')[1], ...parseJ(r.value), ref: r.field })).filter(s => s && Array.isArray(s.sellers));
  f.brandSeller = val('control.brand_seller');                 // Yes / No / Unknown
  f.noOfferAsins = parseJ(val('control.no_offer_asins')) || [];
  f.asinCount = num(val('amazon.asin_count')) ?? 0;
  f.siteProducts = num(val('site.beauty_product_count')) ?? 0;
  f.missing = parseJ(val('amazon.missing_products')) || { missing: 0, checked: 0 };
  f.brandSpellings = parseJ(val('control.brand_spellings')) || [];
  f.fbmBuyBox = num(val('control.fbm_buybox')) ?? 0;
  f.bestRank = parseJ(val('amazon.best_rank'));
  f.social = { tiktok: num(val('social.tiktok_followers')), instagram: num(val('social.instagram_followers')) };

  f.heroes = [...new Set(live.filter(r => /^score\.[A-Z0-9]{10}\./.test(r.field)).map(r => r.field.split('.')[1]))]
    .map(asin => {
      const g = k => val(`score.${asin}.${k}`);
      const d = {
        asin, name: g('site_name') || g('name'),
        title_length: num(g('title_length')) ?? '', bullets: num(g('bullets')) ?? '', images: num(g('images')) ?? '',
        video: g('video'), aplus: g('aplus'), rating: num(g('rating')) ?? '', reviews: num(g('reviews')) ?? '',
      };
      const s = scoreListing(d);
      return { ...d, ...s, refs: [g('site_name') ? 'site_name' : 'name', 'title_length', 'bullets', 'images', 'video', 'aplus', 'rating', 'reviews'].map(k => `score.${asin}.${k}`).filter(k => by[k]) };
    });

  f.competitors = [1, 2, 3].map(i => ({
    i, name: val(`competitor.${i}.name`), channels: val(`competitor.${i}.channels`),
    reviews: num(val(`competitor.${i}.amazon_reviews`)), revenue: num(val(`competitor.${i}.est_monthly_revenue`)),
    refs: ['name', 'channels', 'amazon_reviews', 'est_monthly_revenue'].map(k => `competitor.${i}.${k}`).filter(k => by[k]),
  })).filter(c => c.name);

  f.visibility = parseJ(val('visibility.summary'));             // Helium 10 Cerebro summary, when it ran
  f.keywords = live.filter(r => /^visibility\.kw\.\d+\.rank$/.test(r.field)).map(r => ({
    keyword: val(r.field.replace('.rank', '.keyword')), rank: r.value, ref: r.field,
    refs: [r.field, r.field.replace('.rank', '.keyword')],
  })).filter(k => k.keyword);
  return f;
}

/* ───────────── Findings library ───────────── */
// Each finding: id, category, model ('1' | '2' | 'either'), test(facts, brand) -> null | finding.
// A finding returns big (the large number), claim, detail, fix, score (0–100, for ranking), refs (data fields).
// Categories map to the PDF cards: control (Control & Pricing), growth (Growth Channel),
// conversion (Conversion), visibility (Search Visibility).

const CHANNEL_NAMES = { amazon: 'Amazon', walmart: 'Walmart', target_plus: 'Target+', tiktok_shop: 'TikTok Shop', shopify: 'your site' };
const present = s => /brand-run|sold by others/i.test(s || '');

export const FINDINGS = [
  {
    id: 'reseller_undercut', category: 'control', model: '1',
    test: f => {
      const worst = [...f.pricing].filter(p => p.gap <= -0.10).sort((a, b) => a.gap - b.gap)[0];
      if (!worst) return null;
      return {
        big: fmtPct(worst.gap), score: Math.min(95, 60 + Math.round(-worst.gap * 100)), refs: [worst.ref],
        claim: `Amazon sells your ${shortN(worst.product)} below your site.`,
        detail: `${fmtMoney(worst.bb_price)} on Amazon vs ${fmtMoney(worst.site_price)} on your site${worst.bb_seller ? `, Buy Box held by ${worst.bb_seller}` : ''}.`,
        fix: 'Brand Registry, consolidate sellers, hold one price.',
        step: 'Stop the discounting on Amazon',
      };
    },
  },
  {
    id: 'reseller_markup', category: 'control', model: '1',
    test: f => {
      const worst = [...f.pricing].filter(p => p.gap >= 0.25).sort((a, b) => b.gap - a.gap)[0];
      if (!worst) return null;
      return {
        big: fmtPct(worst.gap), score: Math.min(85, 50 + Math.round(worst.gap * 40)), refs: [worst.ref],
        claim: `Shoppers pay more for your ${shortN(worst.product)} on Amazon.`,
        detail: `${fmtMoney(worst.bb_price)} on Amazon vs ${fmtMoney(worst.site_price)} on your site.`,
        fix: 'Take over the listing and set the price.',
        step: 'Bring Amazon pricing back to MSRP',
      };
    },
  },
  {
    id: 'no_brand_seller', category: 'control', model: '1',
    test: f => {
      if (f.brandSeller !== 'No' || !f.sellers.length) return null;
      const ids = new Set(f.sellers.flatMap(s => s.sellers.map(x => x.id)));
      return {
        big: String(ids.size), score: 90, refs: ['control.brand_seller', ...f.sellers.map(s => s.ref)],
        claim: `seller${ids.size === 1 ? '' : 's'} control your Amazon listings, and none of them are you.`,
        detail: `${f.sellers.length} listing${f.sellers.length === 1 ? '' : 's'} checked; no offer comes from the brand.`,
        fix: 'Brand Registry and a brand-run listing.',
        step: 'Take back your Amazon listing',
      };
    },
  },
  {
    id: 'crowded_listing', category: 'control', model: '1',
    test: f => {
      const top = [...f.sellers].sort((a, b) => b.count - a.count)[0];
      if (!top || top.count < 3) return null;
      return {
        big: String(top.count), score: 60 + Math.min(20, top.count * 3), refs: [top.ref],
        claim: `sellers compete on your ${shortN(top.product) || 'listing'}.`,
        detail: `${top.count} sellers on one Amazon listing${top.bb_seller ? `; ${top.bb_seller} holds the Buy Box` : ''}.`,
        fix: 'Consolidate sellers under one authorized partner.',
        step: 'Consolidate your Amazon sellers',
      };
    },
  },
  {
    id: 'no_offer_listings', category: 'control', model: 'either',
    test: f => {
      const n = f.noOfferAsins.length;
      if (!n) return null;
      return {
        big: String(n), score: Math.min(75, 50 + n * 5), refs: ['control.no_offer_asins'],
        claim: `Amazon listing${n === 1 ? '' : 's'} with nobody selling.`,
        detail: `Shoppers can find ${n === 1 ? 'this page' : 'these pages'} but can’t buy.`,
        fix: 'Restock or reactivate the listings.',
        step: 'Reactivate your dormant Amazon listings',
      };
    },
  },
  {
    id: 'duplicate_listings', category: 'control', model: 'either',
    test: f => {
      const extra = f.asinCount - f.siteProducts;
      if (f.siteProducts < 3 || extra < 4 || f.asinCount < f.siteProducts * 1.25) return null;
      return {
        big: String(f.asinCount), score: 45, refs: ['amazon.asin_count', 'site.beauty_product_count'],
        claim: `Amazon listings for ${f.siteProducts} products on your site.`,
        detail: 'Extra listings are usually duplicates or pages created by resellers.',
        fix: 'Merge duplicates and claim the catalog.',
        step: 'Clean up duplicate Amazon listings',
      };
    },
  },
  {
    id: 'brand_spellings', category: 'control', model: 'either',
    test: f => {
      if (f.brandSpellings.length < 2) return null;
      return {
        big: String(f.brandSpellings.length), score: 35, refs: ['control.brand_spellings'],
        claim: 'versions of your brand name on Amazon.',
        detail: `Listed as ${f.brandSpellings.map(s => `“${s}”`).join(' and ')}.`,
        fix: 'Unify the brand field under Brand Registry.',
        step: 'Unify your brand name on Amazon',
      };
    },
  },
  {
    id: 'walmart_unauthorized', category: 'control', model: '1',
    test: f => {
      if (!/sold by others/i.test(f.channels.walmart.status)) return null;
      return {
        big: 'Walmart', score: 60, refs: ['channel.walmart.status', 'channel.walmart.detail'],
        claim: 'sells your products without you.',
        detail: f.channels.walmart.detail || 'Third-party sellers list your products on Walmart.',
        fix: 'Correct the listing and take over pricing.',
        step: 'Correct Walmart pricing and content',
      };
    },
  },
  {
    id: 'not_on_amazon', category: 'growth', model: '1',
    test: f => {
      if (f.asinCount > 0 || !/absent/i.test(f.channels.amazon.status)) return null;
      return {
        big: '0', score: 85, refs: ['amazon.asin_count', 'channel.amazon.status'],
        claim: 'Amazon listings for your brand.',
        detail: 'Shoppers who search for you on Amazon find nothing to buy.',
        fix: 'Launch a brand-run Amazon store.',
        step: 'Launch on Amazon',
      };
    },
  },
  {
    id: 'missing_products', category: 'growth', model: 'either',
    test: f => {
      const { missing, checked } = f.missing;
      if (!checked || missing < 3 || f.asinCount === 0) return null;
      return {
        big: `${missing}/${checked}`, score: Math.min(70, 40 + missing * 2), refs: ['amazon.missing_products'],
        claim: 'of your products aren’t on Amazon.',
        detail: `We checked ${checked} product codes from your site; ${missing} have no Amazon listing.`,
        fix: 'List the rest of the catalog.',
        step: 'Add your missing products to Amazon',
      };
    },
  },
  {
    id: 'social_no_shop', category: 'growth', model: '1',
    test: f => {
      const fol = f.social.tiktok;
      if (!fol || fol < 10000 || !/absent/i.test(f.channels.tiktok_shop.status)) return null;
      return {
        big: fmtK(fol), score: Math.min(85, 55 + Math.round(Math.log10(fol) * 5)), refs: ['social.tiktok_followers', 'channel.tiktok_shop.status'],
        claim: 'TikTok followers with nowhere to buy.',
        detail: 'There’s no TikTok Shop for viewers to buy from.',
        fix: 'Open your Shop and an affiliate program.',
        step: 'Open TikTok Shop for the demand you already have',
      };
    },
  },
  {
    id: 'competitor_channels', category: 'growth', model: '1',
    test: f => {
      const mine = ['amazon', 'walmart', 'target_plus', 'tiktok_shop'].filter(c => /brand-run/i.test(f.channels[c].status)).length + 1;
      const best = f.competitors.map(c => ({ ...c, n: String(c.channels || '').split(/[,|]/).map(s => s.trim()).filter(Boolean).length }))
        .sort((a, b) => b.n - a.n)[0];
      if (!best || best.n <= mine) return null;
      return {
        big: String(best.n), score: 50 + (best.n - mine) * 5, refs: [`competitor.${best.i}.name`, `competitor.${best.i}.channels`, 'channel.amazon.status'],
        claim: `channels for ${best.name}, to your ${mine}.`,
        detail: `${best.name} sells on ${best.channels}.`,
        fix: 'Add the channels your competitors already use.',
        step: 'Match your competitors’ channel footprint',
      };
    },
  },
  {
    id: 'low_listing_score', category: 'conversion', model: 'either',
    test: f => {
      const h = f.heroes.filter(x => !x.unknown.length).sort((a, b) => a.score - b.score)[0];
      if (!h || h.score > 5) return null;
      const FIX = { title: 'title', bullets: 'bullets', images: 'images', video: 'video', aplus: 'A+ content', rating: 'ratings', reviews: 'reviews' };
      const missing = h.parts.filter(p => p.got < p.of).map(p => FIX[p.key]);
      return {
        big: `${h.score}/10`, score: 70 - h.score * 4, refs: h.refs,
        claim: `Listing score for your ${shortN(h.name) || 'hero product'}.`,
        detail: `${h.images} images, ${h.video === 'Yes' ? 'video' : 'no video'}, ${h.aplus === 'Yes' ? 'A+ content' : 'no A+ content'}.`,
        fix: missing.length ? `Rebuild ${joinAnd(missing.slice(0, 3))}.` : 'Rebuild images, A+, and keywords.',
        step: 'Rebuild your hero listings',
      };
    },
  },
  {
    id: 'thin_images', category: 'conversion', model: 'either',
    test: f => {
      const h = f.heroes.filter(x => x.images !== '' && x.images < 5).sort((a, b) => a.images - b.images)[0];
      if (!h) return null;
      return {
        big: `${h.images}/7`, score: 50, refs: [`score.${h.asin}.images`, f.by[`score.${h.asin}.site_name`] ? `score.${h.asin}.site_name` : `score.${h.asin}.name`],
        claim: `images on your ${shortN(h.name) || 'hero listing'}.`,
        detail: 'Amazon allows 7 or more; top listings use all of them.',
        fix: 'Shoot and upload a full image set.',
        step: 'Complete your listing images',
      };
    },
  },
  {
    id: 'missing_aplus', category: 'conversion', model: 'either',
    test: f => {
      const known = f.heroes.filter(h => h.aplus === 'Yes' || h.aplus === 'No');
      const without = known.filter(h => h.aplus === 'No');
      if (known.length < 2 || without.length < known.length) return null;
      return {
        big: `0/${known.length}`, score: 45, refs: without.map(h => `score.${h.asin}.aplus`),
        claim: 'hero listings have A+ content.',
        detail: 'A+ pages add brand story and comparison charts below the fold.',
        fix: 'Build A+ content for your top products.',
        step: 'Add A+ content',
      };
    },
  },
  {
    id: 'review_gap', category: 'conversion', model: 'either',
    test: f => {
      const mine = f.heroes.filter(h => h.reviews !== '').sort((a, b) => b.reviews - a.reviews)[0];
      const comp = f.competitors.filter(c => c.reviews).sort((a, b) => b.reviews - a.reviews)[0];
      if (!mine || !comp || comp.reviews < Math.max(5 * mine.reviews, 100)) return null;
      return {
        big: `${mine.reviews.toLocaleString('en-US')}`, score: 55,
        refs: [`score.${mine.asin}.reviews`, `competitor.${comp.i}.amazon_reviews`, `competitor.${comp.i}.name`],
        claim: `reviews on your top listing vs. ${comp.reviews.toLocaleString('en-US')} for ${comp.name}.`,
        detail: 'Review count is one of the first things shoppers compare.',
        fix: 'Start Vine and a post-purchase review program.',
        step: 'Close the review gap',
      };
    },
  },
  {
    id: 'low_rating', category: 'conversion', model: 'either',
    test: f => {
      const h = f.heroes.filter(x => x.rating !== '' && x.rating < 4.2).sort((a, b) => a.rating - b.rating)[0];
      if (!h) return null;
      return {
        big: `${h.rating}★`, score: 50, refs: [`score.${h.asin}.rating`, f.by[`score.${h.asin}.site_name`] ? `score.${h.asin}.site_name` : `score.${h.asin}.name`],
        claim: `rating on your ${shortN(h.name) || 'hero listing'}.`,
        detail: 'Listings under 4.2 stars lose clicks to higher-rated alternatives.',
        fix: 'Fix the root cause in reviews, then rebuild ratings.',
        step: 'Raise your hero product rating',
      };
    },
  },
  {
    id: 'missed_keyword', category: 'visibility', model: 'either',
    test: f => {
      const k = f.visibility?.missed;
      if (!k) return null;
      return {
        big: k.rank ? `#${k.rank}` : 'Unranked', score: 70, refs: ['visibility.summary'],
        claim: `for “${k.phrase}”, ${fmtK(k.volume)} Amazon searches a month.`,
        detail: k.rank ? 'Most shoppers buy from the first page of results.' : 'Your listings don’t rank for it at all.',
        fix: 'Rebuild the listing around it and support it with PPC.',
        step: `Rank for “${k.phrase}”`,
      };
    },
  },
  {
    id: 'page1_share', category: 'visibility', model: 'either',
    test: f => {
      const v = f.visibility;
      if (!v || v.top10Count < 5 || v.page1Count > Math.floor(v.top10Count * 0.3)) return null;
      return {
        big: `${v.page1Count} of ${v.top10Count}`, score: 65, refs: ['visibility.summary'],
        claim: 'of your biggest non-branded keywords put you on page 1.',
        detail: 'Shoppers who don’t know your name yet aren’t finding you.',
        fix: 'Keyword-led listing rebuild plus targeted PPC.',
        step: 'Win page 1 for your core keywords',
      };
    },
  },
  {
    id: 'rank_slipping', category: 'visibility', model: 'either',
    test: f => {
      const k = f.visibility?.slipping;
      if (!k) return null;
      return {
        big: `#${k.lastMonthRank} → #${k.rank}`, score: 62, refs: ['visibility.summary'],
        claim: `for “${k.phrase}” over the past month.`,
        detail: `${fmtK(k.volume)} searches a month, and the listing is losing ground.`,
        fix: 'Find what changed (price, stock, reviews, ads) and recover the rank.',
        step: `Recover your rank for “${k.phrase}”`,
      };
    },
  },
  {
    id: 'brand_name_ads', category: 'visibility', model: 'either',
    test: f => {
      const k = f.visibility?.brandAds;
      if (!k || k.sponsoredAds < 10 || k.volume < 100) return null;
      return {
        big: String(k.sponsoredAds), score: 52, refs: ['visibility.summary'],
        claim: `sponsored products show when shoppers search “${k.phrase}”.`,
        detail: 'Shoppers already looking for you see other products first.',
        fix: 'Defend your brand terms with your own ads and Brand Registry.',
        step: 'Defend searches for your brand name',
      };
    },
  },
  {
    id: 'keyword_not_ranking', category: 'visibility', model: 'either',
    test: f => {
      if (f.visibility) return null;   // Cerebro findings above replace this
      const unranked = r => /not|unranked|none/i.test(String(r));
      const k = f.keywords.find(x => unranked(x.rank) || num(x.rank) > 100);
      if (!k) return null;
      return {
        big: unranked(k.rank) ? 'Unranked' : `#${num(k.rank)}`, score: 60, refs: k.refs,
        claim: `for “${k.keyword}” on Amazon.`,
        detail: 'Shoppers rarely scroll past the first page of results.',
        fix: 'Rebuild keywords and support them with PPC.',
        step: `Rank for “${k.keyword}”`,
      };
    },
  },
  {
    id: 'weak_sales_rank', category: 'visibility', model: 'either',
    test: f => {
      const r = f.bestRank;
      if (!r || !r.rank || r.rank < 150000) return null;
      return {
        big: `#${Number(r.rank).toLocaleString('en-US')}`, score: 40, refs: ['amazon.best_rank'],
        claim: `is your best Amazon sales rank in ${r.category || 'its category'}.`,
        detail: `That’s for ${shortN(r.product) || 'your top product'}, your best-selling listing.`,
        fix: 'Rebuild listings and add PPC to start velocity.',
        step: 'Build sales velocity on Amazon',
      };
    },
  },
];

export const CATEGORY_LABELS = { control: 'Control & pricing', growth: 'Growth channel', conversion: 'Conversion', visibility: 'Search visibility' };

export function evaluateFindings(facts, brand) {
  BRAND = brand?.amazon_brand_name || brand?.brand_name || '';
  const out = [];
  for (const def of FINDINGS) {
    let r = null;
    try { r = def.test(facts, brand); } catch (e) { console.error(`finding ${def.id} failed:`, e.message); }
    if (r) out.push({ finding_id: def.id, category: def.category, model_fit: def.model, ...r });
  }
  out.sort((a, b) => b.score - a.score);
  out.forEach((f, i) => { f.rank = i + 1; });
  return out;
}

/** Model 1 when nobody from the brand sells on Amazon; Model 2 when they run it and it underperforms. */
export function recommendModel(facts) {
  if (facts.brandSeller === 'Yes') return '2';
  return '1';
}

export const MODEL_COPY = {
  '1': { line: 'We buy the inventory. We run the channel.', italic: 'You run the brand.', sub: '$0 retainer. Your team stays focused on your own site.' },
  '2': { line: 'We run your accounts. You keep the listings', italic: 'and the customers.', sub: '$0 retainer. We earn a share of the margin we grow.' },
};

/** Suggested picks: headline = top finding; cards = best per category, filled from the rest. */
export function suggestSelections(findings, facts) {
  const headline = findings[0]?.finding_id || '';
  const cards = [];
  for (const cat of ['control', 'growth', 'conversion', 'visibility']) {
    const f = findings.find(x => x.category === cat && !cards.includes(x.finding_id));
    if (f && cards.length < 3) cards.push(f.finding_id);
  }
  for (const f of findings) if (cards.length < 3 && !cards.includes(f.finding_id)) cards.push(f.finding_id);
  const steps = cards.map(id => findings.find(f => f.finding_id === id)?.step).filter(Boolean);
  return { headline, cards, model: recommendModel(facts), steps };
}

/* ───────────── Grounding check for AI-written copy ───────────── */

export function numbersIn(text) {
  return (String(text || '').match(/\d[\d,]*(?:\.\d+)?/g) || []).map(n => String(Number(n.replace(/,/g, ''))));
}
/** True if every number in `text` also appears in `allowedText` (the template copy + data values). */
export function copyIsGrounded(text, allowedText) {
  const allowed = new Set(numbersIn(allowedText));
  // Also allow K-formatted versions (92K <-> 92000)
  for (const n of [...allowed]) { const v = Number(n); if (v >= 1000) allowed.add(String(Math.round(v / 1000))); }
  return numbersIn(text).every(n => allowed.has(n));
}
