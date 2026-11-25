/**
 * api/_lib/cerebro.js
 *
 * Search visibility from Helium 10 Cerebro (reverse ASIN), for audits and the follow-up re-scans.
 *
 * Calls per brand: one current pull per hero product family (Cerebro already covers every variation
 * under the parent), plus one previous-month pull for the top family, so the first audit can already
 * show movement. Max 4 calls a scan.
 *
 * Branded keywords (containing the brand name) are kept apart: they measure demand for the brand,
 * not discoverability. Visibility findings use non-branded keywords only.
 */
import { callTool } from './helium10.js';

export const CEREBRO_TOOL = 'get_keywords_by_asin';
export const MIN_VOLUME = 1000;         // a keyword below this isn't worth a headline
export const PAGE1_RANK = 48;           // roughly the first page of Amazon search results
const ROWS_PER_CALL = 1000;             // one call, inline (Helium 10 inlines up to 1,000 rows)

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/** Phrases that mean "this brand": the brand name, with and without spaces. */
export function brandMatcher(...names) {
  const forms = new Set();
  for (const n of names.filter(Boolean)) {
    const k = norm(n).replace(/\b(the|inc|llc|co|company|beauty|cosmetics|skincare|labs?)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (k.length >= 3) { forms.add(k); forms.add(k.replace(/ /g, '')); }
  }
  return phrase => { const p = ` ${norm(phrase)} `; const q = p.replace(/ /g, ''); return [...forms].some(f => p.includes(` ${f} `) || (f.length >= 6 && q.includes(f))); };
}

function keywordsOf(out) {
  if (typeof out === 'string') { try { out = JSON.parse(out); } catch { return []; } }
  return out?.data?.keywords || out?.keywords || [];
}

/** One Cerebro pull for an ASIN (current, or a past month 'YYYY-MM'). */
export async function pullKeywords(asin, period = '') {
  const args = { asin, marketplace: 'US', limit: ROWS_PER_CALL, response_format: 'inline' };
  if (period) args.time_period = period;
  return keywordsOf(await callTool(CEREBRO_TOOL, args)).map(k => ({
    phrase: String(k.phrase || '').trim(),
    volume: Number(k.search_volume) || 0,
    rank: Number(k.organic_rank) || null,
    sponsoredRank: Number(k.sponsored_rank) || null,
    sponsoredAds: Number(k.sponsored_asins_count) || 0,
    amazonChoice: k.amazon_choice && k.amazon_choice !== 'N/A' ? k.amazon_choice : '',
    trend30: Number(k.search_volume_trend_30d_pct) || 0,
  })).filter(k => k.phrase);
}

export const lastMonth = (d = new Date()) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * Pull and summarize visibility for a brand's hero families.
 * heroes: [{ asin, title }] (one per product family). Returns { families, summary, calls }.
 */
export async function scanVisibility(heroes, brandNames, { withHistory = true } = {}) {
  const isBranded = brandMatcher(...brandNames);
  const families = [];
  let calls = 0;
  for (const h of heroes) {
    const kws = await pullKeywords(h.asin); calls++;
    families.push({ ...h, keywords: kws.map(k => ({ ...k, branded: isBranded(k.phrase) })) });
  }
  if (withHistory && families[0]) {
    try {
      const prev = await pullKeywords(families[0].asin, lastMonth()); calls++;
      const byPhrase = new Map(prev.map(k => [k.phrase.toLowerCase(), k]));
      families[0].keywords.forEach(k => { const p = byPhrase.get(k.phrase.toLowerCase()); if (p) k.lastMonthRank = p.rank; });
      families[0].history = lastMonth();
    } catch { /* history is a bonus; the current pull is what matters */ }
  }
  return { families, summary: summarize(families), calls };
}

/** Combine the families into the numbers the audit uses. Keyword ranks are the best across families. */
export function summarize(families) {
  const merged = new Map();
  for (const f of families) for (const k of f.keywords) {
    const key = k.phrase.toLowerCase();
    const cur = merged.get(key);
    if (!cur || (k.rank && (!cur.rank || k.rank < cur.rank))) merged.set(key, { ...k, asin: f.asin, product: f.title });
  }
  const all = [...merged.values()];
  const generic = all.filter(k => !k.branded).sort((a, b) => b.volume - a.volume);
  const branded = all.filter(k => k.branded).sort((a, b) => b.volume - a.volume);
  const top10 = generic.slice(0, 10);
  const onPage1 = top10.filter(k => k.rank && k.rank <= PAGE1_RANK);
  // Biggest miss: prefer a big keyword they're close on (page 2 to 3) over a head term they don't rank for at all
  const big = generic.filter(k => k.volume >= MIN_VOLUME);
  const missed = big.find(k => k.rank && k.rank > 20 && k.rank <= 150) || big.find(k => !k.rank || k.rank > 150) || null;
  const slipping = generic.concat(branded).filter(k => k.volume >= MIN_VOLUME && k.rank && k.lastMonthRank && k.rank - k.lastMonthRank >= 5)
    .sort((a, b) => b.volume - a.volume)[0] || null;
  const brandAds = branded.filter(k => k.sponsoredAds > 0).sort((a, b) => b.volume - a.volume)[0] || null;
  return {
    keywordsFound: all.length,
    genericTop: generic.slice(0, 5),
    top10Count: top10.length,
    page1Count: onPage1.length,
    genericPage1Volume: generic.filter(k => k.rank && k.rank <= PAGE1_RANK).reduce((s, k) => s + k.volume, 0),
    genericVolume: generic.reduce((s, k) => s + k.volume, 0),
    brandedVolume: branded.reduce((s, k) => s + k.volume, 0),
    brandedTop: branded[0] || null,
    brandAds,
    missed,
    slipping,
    history: families[0]?.history || '',
  };
}

/** Rows for the Rank Snapshots tab: top non-branded and branded keywords per family. */
export function snapshotRows(families, base) {
  const rows = [];
  for (const f of families) {
    const pick = [
      ...f.keywords.filter(k => !k.branded).sort((a, b) => b.volume - a.volume).slice(0, 25),
      ...f.keywords.filter(k => k.branded).sort((a, b) => b.volume - a.volume).slice(0, 10),
    ];
    for (const k of pick) rows.push({
      ...base, asin: f.asin, period: 'current', phrase: k.phrase, branded: k.branded ? 'Y' : '',
      search_volume: k.volume, organic_rank: k.rank ?? '', sponsored_rank: k.sponsoredRank ?? '',
      sponsored_ads: k.sponsoredAds, amazon_choice: k.amazonChoice,
    });
    if (f.history) for (const k of pick.filter(x => x.lastMonthRank)) rows.push({
      ...base, asin: f.asin, period: f.history, phrase: k.phrase, branded: k.branded ? 'Y' : '',
      search_volume: '', organic_rank: k.lastMonthRank, sponsored_rank: '', sponsored_ads: '', amazon_choice: '',
    });
  }
  return rows;
}
