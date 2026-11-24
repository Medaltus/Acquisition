/**
 * api/audit-scan.js
 *
 * Gap audit scan for one brand, run in three stages so each fits in one function call.
 * The dashboard calls them in order: POST { brand_id, stage: 'amazon' } -> returns scan_id,
 * then { brand_id, scan_id, stage: 'web' }, then { brand_id, scan_id, stage: 'findings' }.
 * 'findings' can be re-run any time (after verifying or editing data) to re-rank findings.
 * Auth: dashboard password (x-dashboard-key) or CRON_SECRET (?key=).
 */
import { TABS, AUDIT_STAGES } from './_lib/schema.js';
import { readTab, appendRows, updateRows } from './_lib/sheets.js';
import { isAuthorized, isDashboardAuthorized, nowIso, cleanGtin } from './_lib/util.js';
import { lookupCodes, searchBrand, getOfferDetails, getCatalogDetails, getSellerNames } from './_lib/spapi.js';
import { askClaude, parseJson } from './_lib/claude.js';
import {
  isNonBeauty, judgeComparison, sellerIsBrand, buildFacts, evaluateFindings, suggestSelections,
  copyIsGrounded, fmtPct, fmtMoney,
} from './_lib/audit.js';

const AUDIT_MODEL = () => (process.env.AUDIT_MODEL || 'claude-opus-5-5').trim();
const MAX_DETAIL_ASINS = 20;
const MAX_SELLER_LOOKUPS = 12;
const HERO_COUNT = 3;

const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
const J = v => JSON.stringify(v);
const dpUrl = asin => `https://www.amazon.com/dp/${asin}`;

/** Build one Audit Data row. */
function dp(ctx, section, field, label, value, o = {}) {
  return {
    brand_id: ctx.brand.brand_id, scan_id: ctx.scanId, section, field, label,
    value: value === null || value === undefined ? '' : String(value),
    source: o.source || '', source_url: o.url || '', method: o.method || 'auto',
    confidence: o.confidence || (o.method === 'ai' ? 'Needs check' : o.method === 'needed' ? 'Missing' : 'High'),
    verified: '', verified_by: '', captured_at: ctx.stamp, notes: o.notes || '',
  };
}

/* ───────────── Stage 1: Amazon (SP-API) + the brand's site ───────────── */
async function stageAmazon(ctx) {
  const { brand } = ctx;
  const products = (await readTab(TABS.PRODUCTS)).rows.filter(p => p.brand_id === brand.brand_id);
  const beauty = products.filter(p => !isNonBeauty(p));
  const rows = [];
  const notes = [];

  // Site
  const titles = new Set(beauty.map(p => p.product_title).filter(Boolean));
  rows.push(dp(ctx, 'Channel presence', 'channel.shopify.status', 'Own website', brand.website_url ? 'Brand-run' : 'Absent',
    { source: 'Brand website', url: brand.website_url }));
  rows.push(dp(ctx, 'Channel presence', 'channel.shopify.detail', 'Own website detail',
    brand.website_url ? `${brand.platform && brand.platform !== 'Other' ? brand.platform + ' store' : 'Own store'}, ${titles.size} products` : '',
    { source: 'Product scan', url: brand.website_url }));
  rows.push(dp(ctx, 'Listing control', 'site.beauty_product_count', 'Beauty products on their site', titles.size,
    { source: 'Product scan (gift cards and merch excluded)', url: brand.website_url }));

  // UPCs: how many site variants share each one (shared UPCs make price comparisons unreliable)
  const upcVariants = new Map();
  for (const p of beauty) {
    const code = cleanGtin(p.upc);
    if (!code) continue;
    const key = `${p.product_title}|${p.variant_title}`;
    upcVariants.set(code, (upcVariants.get(code) || new Set()).add(key));
  }
  const heroUpcs = String(brand.hero_upcs || '').split(/[\s,|]+/).map(cleanGtin).filter(Boolean);
  const codes = [...new Set([...heroUpcs, ...upcVariants.keys()])].filter(c => c.length === 12 || c.length === 13).slice(0, 100);
  const byCode = codes.length ? await lookupCodes(codes) : new Map();

  let brandHits = [];
  try { brandHits = await searchBrand(brand.amazon_brand_name || brand.brand_name); }
  catch (e) { notes.push(`Brand search failed: ${e.message}`); }

  const all = new Map();
  for (const s of byCode.values()) all.set(s.asin, { ...s, via: 'upc' });
  for (const s of brandHits) if (!all.has(s.asin)) all.set(s.asin, { ...s, via: 'brand search' });
  const heroAsins = String(brand.hero_asins || '').split(/[\s,|]+/).filter(a => /^[A-Z0-9]{10}$/.test(a));

  rows.push(dp(ctx, 'Listing control', 'amazon.asin_count', 'Amazon listings found for the brand', all.size,
    { source: 'Amazon SP-API (UPC lookup + brand search)', notes: `${byCode.size} by UPC, ${all.size - byCode.size} by brand search` }));

  // Missing products (unique UPCs from the site with no Amazon listing)
  const siteCodes = [...upcVariants.keys()];
  const missingCodes = siteCodes.filter(c => !byCode.has(c));
  const examples = missingCodes.slice(0, 5).map(c => beauty.find(p => cleanGtin(p.upc) === c)?.product_title).filter(Boolean);
  rows.push(dp(ctx, 'Channel presence', 'amazon.missing_products', 'Site products with no Amazon listing',
    J({ missing: missingCodes.length, checked: siteCodes.length, examples }),
    { source: 'Amazon SP-API UPC lookup', notes: examples.length ? `e.g. ${examples.join('; ')}` : '' }));

  // Pick ASINs to check in detail
  const ranked = [...all.values()].sort((a, b) => (a.rankNumber ?? 9e9) - (b.rankNumber ?? 9e9));
  const detailAsins = [...new Set([...heroAsins, ...ranked.filter(r => r.via === 'upc').map(r => r.asin), ...ranked.map(r => r.asin)])]
    .slice(0, MAX_DETAIL_ASINS);

  const [catalog, offers] = detailAsins.length
    ? await Promise.all([getCatalogDetails(detailAsins), getOfferDetails(detailAsins)])
    : [new Map(), new Map()];

  // Sellers
  const sellerIds = [...new Set([...offers.values()].flatMap(o => o.offers.map(x => x.sellerId)))].slice(0, MAX_SELLER_LOOKUPS);
  const names = sellerIds.length ? await getSellerNames(sellerIds) : new Map();
  const medaltusId = (process.env.SP_SELLER_ID || '').trim();
  const nameOf = id => id === medaltusId ? 'Medaltus' : (names.get(id) || '');

  let anyBrand = false, anyUnknown = false, fbm = 0;
  const noOffer = [], sellerSummary = new Set();
  for (const asin of detailAsins) {
    const o = offers.get(asin);
    const c = catalog.get(asin) || all.get(asin) || {};
    if (!o) continue;
    if (!o.offers.length && !o.error) { noOffer.push({ asin, title: c.title || '' }); continue; }
    const sellers = o.offers.map(x => {
      const name = nameOf(x.sellerId);
      const isBrand = x.sellerId === medaltusId ? false : sellerIsBrand(name, brand);
      if (isBrand) anyBrand = true;
      if (isBrand === null) anyUnknown = true;
      sellerSummary.add(x.sellerId);
      return { id: x.sellerId, name, isBrand, price: x.price, fba: x.fba, buyBox: x.buyBox };
    });
    const bb = sellers.find(s => s.buyBox);
    if (bb && !bb.fba) fbm++;
    rows.push(dp(ctx, 'Listing control', `control.${asin}.sellers`, `Sellers on ${c.title ? c.title.slice(0, 70) : asin}`,
      J({ count: sellers.length, product: c.title || '', bb_seller: bb?.name || '', sellers }),
      { source: 'Amazon SP-API offers + public seller pages', url: dpUrl(asin), notes: o.offerCount > sellers.length ? `${o.offerCount} total offers` : '' }));
  }
  const brandSeller = anyBrand ? 'Yes' : (!sellerSummary.size ? 'No listings with offers' : anyUnknown ? 'Unknown' : 'No');
  rows.push(dp(ctx, 'Listing control', 'control.brand_seller', 'Does the brand sell its own Amazon listings?', brandSeller,
    { source: 'Seller names vs brand name', confidence: brandSeller === 'Unknown' ? 'Needs check' : 'High',
      notes: brandSeller === 'Unknown' ? 'Some seller names were blocked by Amazon. Open the listings and check the Sold by line, then edit this to Yes or No.' : '' }));
  rows.push(dp(ctx, 'Listing control', 'control.no_offer_asins', 'Listings with nobody selling', J(noOffer.map(n => n.asin)),
    { source: 'Amazon SP-API offers', notes: noOffer.map(n => n.title.slice(0, 60)).join('; ') }));
  rows.push(dp(ctx, 'Listing control', 'control.fbm_buybox', 'Listings with a merchant-fulfilled Buy Box', fbm, { source: 'Amazon SP-API offers' }));

  const spellings = [...new Set([...all.values()].filter(s => s.via === 'upc').map(s => s.brand).filter(Boolean))];
  rows.push(dp(ctx, 'Listing control', 'control.brand_spellings', 'Brand name spellings on Amazon', J(spellings),
    { source: 'Amazon catalog brand field (UPC matches only)' }));

  // Amazon channel status
  const listingsWithOffers = detailAsins.length - noOffer.length;
  const amazonStatus = !all.size ? 'Absent' : brandSeller === 'Yes' ? 'Brand-run'
    : brandSeller === 'No' ? 'Sold by others' : brandSeller === 'No listings with offers' ? 'Listed, not selling' : 'Unknown';
  rows.push(dp(ctx, 'Channel presence', 'channel.amazon.status', 'Amazon', amazonStatus,
    { source: 'Amazon SP-API', confidence: amazonStatus === 'Unknown' ? 'Needs check' : 'High',
      notes: amazonStatus === 'Unknown' ? 'Set to Brand-run or Sold by others once the seller check is confirmed.' : '' }));
  rows.push(dp(ctx, 'Channel presence', 'channel.amazon.detail', 'Amazon detail',
    !all.size ? 'No listings found' : `${sellerSummary.size} seller${sellerSummary.size === 1 ? '' : 's'} across ${listingsWithOffers} active listing${listingsWithOffers === 1 ? '' : 's'}${noOffer.length ? `, ${noOffer.length} with no offers` : ''}`,
    { source: 'Amazon SP-API' }));

  // Price comparisons (site price vs Buy Box)
  const compared = new Set();
  for (const p of beauty) {
    const code = cleanGtin(p.upc);
    const hit = code && byCode.get(code);
    if (!hit || compared.has(hit.asin)) continue;
    const o = offers.get(hit.asin);
    const site = parseFloat(p.price), bbPrice = o?.buyBoxPrice;
    if (!(site > 0) || !(bbPrice > 0)) continue;
    const judged = judgeComparison(p, hit.title, upcVariants.get(code)?.size || 1, brand.brand_name);
    const gap = (bbPrice - site) / site;
    const bb = o.offers.find(x => x.buyBox);
    compared.add(hit.asin);
    rows.push(dp(ctx, 'Pricing', `pricing.${hit.asin}.compare`, `${p.product_title}${p.variant_title ? ` (${p.variant_title})` : ''}`,
      J({ asin: hit.asin, product: p.product_title, variant: p.variant_title, site_price: site, bb_price: bbPrice, gap: Math.round(gap * 1000) / 1000,
        bb_seller: bb ? nameOf(bb.sellerId) : '', valid: judged.valid, reason: judged.reason }),
      { source: 'Brand site price vs Amazon Buy Box', url: dpUrl(hit.asin),
        confidence: judged.valid ? 'High' : 'Excluded from findings', notes: judged.reason || `${fmtMoney(bbPrice)} vs ${fmtMoney(site)} (${fmtPct(gap)})` }));
  }

  // Best rank + hero listings
  const withRank = detailAsins.map(a => ({ asin: a, ...(catalog.get(a) || all.get(a) || {}) })).filter(x => x.rankNumber);
  const best = withRank.sort((a, b) => a.rankNumber - b.rankNumber)[0];
  if (best) {
    rows.push(dp(ctx, 'Search visibility', 'amazon.best_rank', 'Best Amazon sales rank',
      J({ rank: best.rankNumber, category: String(best.salesRank).replace(/^#[\d,]+ in /, ''), product: best.title, asin: best.asin }),
      { source: 'Amazon SP-API catalog', url: dpUrl(best.asin), notes: best.salesRank }));
  }
  const heroes = [...new Set([...heroAsins, ...withRank.map(x => x.asin), ...detailAsins])].filter(a => catalog.has(a)).slice(0, HERO_COUNT);
  for (const asin of heroes) {
    const c = catalog.get(asin);
    const src = { source: 'Amazon SP-API catalog', url: dpUrl(asin) };
    rows.push(dp(ctx, 'Listing scorecard', `score.${asin}.name`, 'Hero product', c.title, src));
    const siteRow = beauty.find(p => byCode.get(cleanGtin(p.upc))?.asin === asin);
    if (siteRow) rows.push(dp(ctx, 'Listing scorecard', `score.${asin}.site_name`, 'Hero product name on their site', siteRow.product_title,
      { source: 'Brand website (matched by UPC)', url: siteRow.product_url }));
    rows.push(dp(ctx, 'Listing scorecard', `score.${asin}.title_length`, `Title length (${asin})`, c.titleLength, src));
    rows.push(dp(ctx, 'Listing scorecard', `score.${asin}.bullets`, `Bullet points (${asin})`, c.bulletCount, src));
    rows.push(dp(ctx, 'Listing scorecard', `score.${asin}.images`, `Images (${asin})`, c.imageCount, src));
  }

  ctx.heroes = heroes.map(a => ({ asin: a, title: catalog.get(a)?.title || '' }));
  return { rows, notes, summary: `${all.size} listings, ${sellerSummary.size} sellers, brand seller: ${brandSeller}` };
}

/* ───────────── Stage 2: web research (Claude + web search) ───────────── */
const WEB_SYSTEM = `You research beauty and wellness brands for a marketplace audit. Accuracy matters more than completeness:
a wrong fact in front of a brand owner costs more than a blank. Only report what you found in a search result,
and give the URL you found it on. If you can't confirm something, use null (numbers) or "unknown" (statuses).
Respond with ONLY JSON, no prose.`;

async function researchChannels(ctx) {
  const b = ctx.brand;
  const prompt = `Brand: ${b.brand_name}
Website: ${b.website_url}
Instagram: ${b.instagram_handle || 'unknown'}   TikTok: ${b.tiktok_handle || 'unknown'}
Example products: ${ctx.productNames.slice(0, 6).join('; ')}

Find, for this brand in the United States:
1. Walmart.com: are its products listed? Is the seller the brand itself or a third party? Note anything off (wrong price, wrong image).
2. Target+ (Target's marketplace) or Target.com: is it listed? By whom?
3. TikTok Shop: does the brand have its own TikTok Shop? Do creators post about its products?
4. Current follower counts for its TikTok and Instagram accounts.

JSON shape:
{"walmart":{"status":"brand-run"|"sold by others"|"absent"|"unknown","detail":"one short sentence","url":""},
 "target_plus":{"status":"brand-run"|"sold by others"|"absent"|"unknown","detail":"","url":""},
 "tiktok_shop":{"status":"brand-run"|"sold by others"|"absent"|"unknown","detail":"","url":""},
 "tiktok_followers":{"value":number|null,"url":""},
 "instagram_followers":{"value":number|null,"url":""},
 "creators_note":{"value":"one sentence or empty","url":""}}`;
  return parseJson(await askClaude({ system: WEB_SYSTEM, prompt, useSearch: true, maxSearches: 10, maxTokens: 3000, model: AUDIT_MODEL() }));
}

async function researchListings(ctx) {
  const b = ctx.brand;
  const prompt = `Brand: ${b.brand_name} (${b.category || 'beauty'}), website ${b.website_url}

A. For each Amazon listing below, find the current star rating, number of ratings, whether the listing has a product
video, whether it has A+ content (the "From the brand" / "Product description" image modules), and any obvious problems
(old packaging, images that look like another brand's, reviews about opened, expired, or fake product).
${ctx.heroes.map(h => `- ${h.asin}: ${h.title} (https://www.amazon.com/dp/${h.asin})`).join('\n') || '- none'}

B. Name the 3 closest competitors: similar products and price point, sold on Amazon. For each, list the US channels they
sell on (from: Amazon, Walmart, Target+, TikTok Shop, Ulta, Sephora, own site) and the rating count on their top Amazon listing.

C. Suggest 3 to 5 core Amazon search keywords a shopper would use to find this brand's hero products (not the brand name).

JSON shape:
{"listings":[{"asin":"","rating":number|null,"rating_count":number|null,"has_video":true|false|null,"has_aplus":true|false|null,"issues":"","url":""}],
 "competitors":[{"name":"","website":"","channels":["Amazon"],"amazon_rating_count":number|null,"url":""}],
 "keywords":["",""]}`;
  return parseJson(await askClaude({ system: WEB_SYSTEM, prompt, useSearch: true, maxSearches: 12, maxTokens: 4000, model: AUDIT_MODEL() }));
}

const yn = v => (v === true ? 'Yes' : v === false ? 'No' : '');
const STATUS_LABEL = { 'brand-run': 'Brand-run', 'sold by others': 'Sold by others', absent: 'Absent', unknown: 'Unknown' };

async function stageWeb(ctx, scanRows) {
  const heroAsins = [...new Set(scanRows.filter(r => /^score\.[A-Z0-9]{10}\.name$/.test(r.field)).map(r => r.field.split('.')[1]))];
  ctx.heroes = heroAsins.map(a => ({ asin: a, title: scanRows.find(r => r.field === `score.${a}.name`)?.value || '' }));
  const products = (await readTab(TABS.PRODUCTS)).rows.filter(p => p.brand_id === ctx.brand.brand_id && !isNonBeauty(p));
  ctx.productNames = [...new Set(products.map(p => p.product_title))];

  const [ch, li] = await Promise.allSettled([researchChannels(ctx), researchListings(ctx)]);
  const rows = [], notes = [];
  const A = { method: 'ai', source: 'Web research (Claude)' };

  if (ch.status === 'fulfilled' && ch.value) {
    const c = ch.value;
    for (const [key, label] of [['walmart', 'Walmart'], ['target_plus', 'Target+'], ['tiktok_shop', 'TikTok Shop']]) {
      const v = c[key] || {};
      rows.push(dp(ctx, 'Channel presence', `channel.${key}.status`, label, STATUS_LABEL[String(v.status).toLowerCase()] || 'Unknown', { ...A, url: v.url }));
      rows.push(dp(ctx, 'Channel presence', `channel.${key}.detail`, `${label} detail`, v.detail || '', { ...A, url: v.url }));
    }
    rows.push(dp(ctx, 'Growth signals', 'social.tiktok_followers', 'TikTok followers', c.tiktok_followers?.value ?? '', { ...A, url: c.tiktok_followers?.url }));
    rows.push(dp(ctx, 'Growth signals', 'social.instagram_followers', 'Instagram followers', c.instagram_followers?.value ?? '', { ...A, url: c.instagram_followers?.url }));
    if (c.creators_note?.value) rows.push(dp(ctx, 'Growth signals', 'social.creators', 'Creator activity', c.creators_note.value, { ...A, url: c.creators_note.url }));
  } else {
    notes.push(`Channel research failed: ${ch.reason?.message || 'no JSON returned'}`);
    for (const [key, label] of [['walmart', 'Walmart'], ['target_plus', 'Target+'], ['tiktok_shop', 'TikTok Shop']]) {
      rows.push(dp(ctx, 'Channel presence', `channel.${key}.status`, label, 'Unknown', { method: 'needed', source: 'Research failed: check by hand' }));
    }
  }

  if (li.status === 'fulfilled' && li.value) {
    const l = li.value;
    for (const h of ctx.heroes) {
      const x = (l.listings || []).find(v => v.asin === h.asin) || {};
      const src = { ...A, url: x.url || `https://www.amazon.com/dp/${h.asin}` };
      rows.push(dp(ctx, 'Listing scorecard', `score.${h.asin}.rating`, `Star rating (${h.asin})`, x.rating ?? '', src));
      rows.push(dp(ctx, 'Listing scorecard', `score.${h.asin}.reviews`, `Ratings count (${h.asin})`, x.rating_count ?? '', src));
      rows.push(dp(ctx, 'Listing scorecard', `score.${h.asin}.video`, `Has video (${h.asin})`, yn(x.has_video), src));
      rows.push(dp(ctx, 'Listing scorecard', `score.${h.asin}.aplus`, `Has A+ content (${h.asin})`, yn(x.has_aplus), src));
      if (x.issues) rows.push(dp(ctx, 'Listing control', `control.${h.asin}.issues`, `Listing issues (${h.asin})`, x.issues, src));
    }
    (l.competitors || []).slice(0, 3).forEach((c, idx) => {
      const i = idx + 1, src = { ...A, url: c.url || c.website };
      rows.push(dp(ctx, 'Competitors', `competitor.${i}.name`, `Competitor ${i}`, c.name, src));
      rows.push(dp(ctx, 'Competitors', `competitor.${i}.channels`, `${c.name}: channels`, (c.channels || []).join(', '), src));
      rows.push(dp(ctx, 'Competitors', `competitor.${i}.amazon_reviews`, `${c.name}: ratings on top Amazon listing`, c.amazon_rating_count ?? '', src));
      rows.push(dp(ctx, 'Competitors', `competitor.${i}.est_monthly_revenue`, `${c.name}: est. monthly Amazon sales ($)`, '',
        { method: 'needed', source: 'Helium 10 X-Ray or Black Box', notes: 'Add from Helium 10 to use this competitor in the callout with a dollar figure.' }));
    });
    (l.keywords || []).slice(0, 5).forEach((k, idx) => {
      rows.push(dp(ctx, 'Search visibility', `visibility.kw.${idx + 1}.keyword`, `Core keyword ${idx + 1}`, k, A));
      rows.push(dp(ctx, 'Search visibility', `visibility.kw.${idx + 1}.rank`, `Brand's rank for “${k}”`, '',
        { method: 'needed', source: 'Helium 10 Cerebro or Keyword Tracker', notes: 'Enter a rank number, or "Not ranked" if outside the top 100.' }));
    });
  } else {
    notes.push(`Listing/competitor research failed: ${li.reason?.message || 'no JSON returned'}`);
  }
  return { rows, notes, summary: `${rows.length} data points from web research` };
}

/* ───────────── Stage 3: findings ───────────── */
async function polishCopy(findings, facts) {
  if (!findings.length) return {};
  const allowedFor = f => [f.big, f.claim, f.detail, f.fix, ...f.refs.map(r => facts.by[r]?.value || '')].join(' ');
  const prompt = `Rewrite the copy for these audit findings so each reads well on a printed card for a beauty brand owner.
Rules:
- Keep the meaning and every fact. Do not add numbers, names, or claims that aren't in the original.
- "claim" sits directly under the big number and should read naturally after it (e.g. big "5" + claim "sellers control your Amazon listing.").
- claim: under 12 words. detail: one or two short sentences. fix: under 12 words, starts with a verb or noun phrase.
- Plain, confident, specific. No hype words, no exclamation marks, no em dashes.

${J(findings.map(f => ({ id: f.finding_id, big: f.big, claim: f.claim, detail: f.detail, fix: f.fix })))}

Respond with ONLY JSON: {"<id>": {"claim": "", "detail": "", "fix": ""}}`;
  let out = {};
  try { out = parseJson(await askClaude({ system: 'You are a senior marketplace strategist who writes short, exact copy.', prompt, maxTokens: 3000, model: AUDIT_MODEL() })) || {}; }
  catch (e) { console.error('polish failed:', e.message); return {}; }
  const kept = {};
  for (const f of findings) {
    const c = out[f.finding_id];
    if (!c) continue;
    const text = `${c.claim} ${c.detail} ${c.fix}`;
    if (c.claim && c.detail && c.fix && copyIsGrounded(text, allowedFor(f))) kept[f.finding_id] = c;
  }
  return kept;
}

async function stageFindings(ctx, scanRows, { polish = true } = {}) {
  const facts = buildFacts(scanRows);
  const findings = evaluateFindings(facts, ctx.brand);
  const polished = polish ? await polishCopy(findings, facts) : {};
  const firedAt = nowIso();
  const out = findings.map(f => ({
    brand_id: ctx.brand.brand_id, scan_id: ctx.scanId, finding_id: f.finding_id, category: f.category, rank: f.rank,
    score: f.score, big_number: f.big, claim: polished[f.finding_id]?.claim || f.claim,
    detail: polished[f.finding_id]?.detail || f.detail, fix: polished[f.finding_id]?.fix || f.fix, next_step: f.step || '',
    model_fit: f.model_fit, data_refs: f.refs.join(','), copy_source: polished[f.finding_id] ? 'ai (numbers checked)' : 'template',
    fired_at: firedAt,
  }));
  // Keep step text with the selection suggestions (not a sheet column)
  const sug = suggestSelections(findings, facts);
  return { findings: out, suggestions: sug, summary: `${out.length} findings fired` };
}

/* ───────────── Handler ───────────── */
export default async function handler(req, res) {
  if (!isAuthorized(req) && !isDashboardAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const b = req.method === 'POST' ? body(req) : (req.query || {});
  const stage = String(b.stage || '');
  if (!AUDIT_STAGES.includes(stage)) return res.status(400).json({ error: `stage must be one of ${AUDIT_STAGES.join(', ')}` });

  try {
    const brands = await readTab(TABS.BRANDS);
    const brand = brands.rows.find(r => r.brand_id === b.brand_id);
    if (!brand) return res.status(404).json({ error: `Brand ${b.brand_id} not found` });
    if (!brand.website_url) return res.status(400).json({ error: `${brand.brand_name} has no website yet. Run enrich-brands first.` });

    const stamp = nowIso();
    const scanId = stage === 'amazon' ? `${brand.brand_id}-${Date.now().toString(36)}` : String(b.scan_id || '');
    if (!scanId) return res.status(400).json({ error: 'scan_id is required after the amazon stage' });
    const ctx = { brand, scanId, stamp };
    const setBrand = data => updateRows(TABS.BRANDS, brands.headers, [{ row: brand._row, data }]);

    if (stage === 'amazon') {
      await setBrand({ scan_status: 'Scanning: Amazon', scan_requested_at: stamp, scan_completed_at: '' });
      const builds = await readTab(TABS.AUDIT_BUILDS);
      const existing = builds.rows.find(r => r.brand_id === brand.brand_id);
      const buildRow = { scan_id: scanId, updated_at: stamp, status: 'Scanning', selections: '' };
      if (existing) await updateRows(TABS.AUDIT_BUILDS, builds.headers, [{ row: existing._row, data: buildRow }]);
      else await appendRows(TABS.AUDIT_BUILDS, builds.headers, [{ brand_id: brand.brand_id, ...buildRow }]);
    }

    const dataTab = await readTab(TABS.AUDIT_DATA);
    const scanRows = () => dataTab.rows.filter(r => r.scan_id === scanId);
    let result;

    if (stage === 'amazon') {
      result = await stageAmazon(ctx);
      await appendRows(TABS.AUDIT_DATA, dataTab.headers, result.rows);
      await setBrand({ scan_status: 'Scanning: web research' });
    } else if (stage === 'web') {
      const existingFields = new Set(scanRows().map(r => r.field));
      result = await stageWeb(ctx, scanRows());
      // Re-running web research on the same scan only adds fields that aren't there yet
      await appendRows(TABS.AUDIT_DATA, dataTab.headers, result.rows.filter(r => !existingFields.has(r.field)));
      await setBrand({ scan_status: 'Scanning: findings' });
    } else {
      result = await stageFindings(ctx, scanRows(), { polish: b.polish !== false && b.polish !== 'false' });
      const fTab = await readTab(TABS.AUDIT_FINDINGS);
      await appendRows(TABS.AUDIT_FINDINGS, fTab.headers, result.findings);
      const builds = await readTab(TABS.AUDIT_BUILDS);
      const row = builds.rows.find(r => r.brand_id === brand.brand_id);
      if (row && row.scan_id === scanId && !row.selections) {
        await updateRows(TABS.AUDIT_BUILDS, builds.headers, [{ row: row._row, data: {
          status: 'Needs review', updated_at: nowIso(),
          selections: J({ suggested: result.suggestions, headline: result.suggestions.headline, cards: result.suggestions.cards,
            model: result.suggestions.model, steps: result.suggestions.steps }),
        } }]);
      }
      await setBrand({ scan_status: 'Ready', scan_completed_at: nowIso(), audit_status: 'Needs review' });
    }

    res.status(200).json({ ok: true, stage, scan_id: scanId, summary: result.summary, notes: result.notes || [] });
  } catch (err) {
    console.error('audit-scan error:', err);
    res.status(500).json({ error: err.message });
  }
}
