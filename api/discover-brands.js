// Daily cron. Runs enabled sources that haven't run in REFRESH_DAYS, extracts brand names,
// logs every sighting to "Raw Discoveries", and upserts deduped brands into "Brands".
// Manual: /api/discover-brands?key=<CRON_SECRET>&source=<source_name>  (forces one source)
import { TABS, STATUS } from './_lib/schema.js';
import { readTab, appendRows, updateRows, logRun } from './_lib/sheets.js';
import { askClaude, parseJson } from './_lib/claude.js';
import {
  isAuthorized, nowIso, normalizeName, normalizeDomain, slugify, appendUnique, fetchText, fetchJson, htmlToText, sleep,
} from './_lib/util.js';

const REFRESH_DAYS = 7;
const MAX_SOURCES_PER_RUN = 2;
const MAX_BRANDS_PER_SOURCE = 150;
const TIME_BUDGET_MS = 240000;

const SYSTEM = `You build prospect lists for Medaltus, an ecommerce agency that expands beauty, skincare, haircare, makeup, nail, and wellness/supplement brands onto marketplaces.
Only include consumer product BRANDS in those categories. Exclude retailers, marketplaces, distributors, agencies, media outlets, and investors.
Respond with ONLY a JSON array, no prose and no markdown. Each item: {"brand_name": string, "website_url": string, "note": string}.
website_url is the brand's own official site if you know it with confidence, otherwise "". note is short context (funding round, job title, etc.) or "".`;

/** Shopify retailers expose every product's vendor in /products.json, so the full brand list needs no AI. */
async function shopifyVendors(domainOrUrl, retailerName = '') {
  const origin = /^https?:\/\//i.test(domainOrUrl) ? new URL(domainOrUrl).origin : `https://${domainOrUrl.replace(/\/.*$/, '')}`;
  const vendors = new Set();
  for (let page = 1; page <= 60; page++) {
    const data = await fetchJson(`${origin}/products.json?limit=250&page=${page}`);
    if (!data || !Array.isArray(data.products)) {
      if (page === 1) throw new Error(`${origin}/products.json is not available (not a Shopify store, or blocked)`);
      break;
    }
    if (!data.products.length) break;
    data.products.forEach(p => { if (p.vendor && p.vendor.trim()) vendors.add(p.vendor.trim()); });
    await sleep(300);
  }
  // Drop the retailer's own house/gift-card/rewards "vendors" (e.g. "Credo Rewards", "Soko Glam")
  const self = normalizeName(retailerName).slice(0, 5);
  return [...vendors]
    .filter(name => !(self && normalizeName(name).startsWith(self)))
    .map(name => ({ brand_name: name, website_url: '', note: '' }));
}

async function brandsFromSource(src) {
  const type = (src.source_type || 'search').toLowerCase().trim();

  if (type === 'shopify_vendors') return shopifyVendors(String(src.source_value || '').trim(), src.source_name);

  if (type === 'paste') {
    return String(src.paste_text || '')
      .split(/\r?\n|,(?=\s*[A-Z])/)
      .map(s => s.trim())
      .filter(s => s && s.length <= 60)
      .map(name => ({ brand_name: name, website_url: '', note: '' }));
  }

  if (type === 'url') {
    const page = await fetchText(src.source_value, { timeout: 20000 });
    const text = page.ok ? htmlToText(page.text, 60000) : '';
    if (text.length > 500) {
      const reply = await askClaude({
        system: SYSTEM,
        prompt: `Extract up to ${MAX_BRANDS_PER_SOURCE} brands from this page (${src.source_value}).\n\nPAGE TEXT:\n${text}`,
      });
      return parseJson(reply) || [];
    }
    // Blocked or JS-rendered page: fall back to web search for the same page
  }

  const task = type === 'url'
    ? `List the brands shown on this page: ${src.source_value}`
    : src.source_value;
  const reply = await askClaude({
    system: SYSTEM,
    prompt: `${task}\n\nUse web search. Return up to ${MAX_BRANDS_PER_SOURCE} brands as the JSON array described.`,
    useSearch: true,
    maxSearches: 8,
  });
  const parsed = parseJson(reply);
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error(`No brands parsed from search reply: ${String(reply).replace(/\s+/g, ' ').slice(0, 400) || '(empty reply)'}`);
  }
  return parsed;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const deadline = Date.now() + TIME_BUDGET_MS;
  const errors = [];
  let added = 0, updated = 0, sighted = 0;

  try {
    const [sources, brands, exclusions, raw] = await Promise.all([
      readTab(TABS.SOURCES), readTab(TABS.BRANDS), readTab(TABS.EXCLUSIONS), readTab(TABS.RAW),
    ]);

    // Indexes for dedupe
    const byDomain = new Map(), byName = new Map(), ids = new Set();
    for (const b of brands.rows) {
      const d = normalizeDomain(b.website_url); if (d) byDomain.set(d, b);
      const n = normalizeName(b.brand_name); if (n) byName.set(n, b);
      if (b.brand_id) ids.add(b.brand_id);
    }
    const excludedDomains = new Set(exclusions.rows.map(e => normalizeDomain(e.domain)).filter(Boolean));
    const excludedNames = new Set(exclusions.rows.map(e => normalizeName(e.brand_name)).filter(Boolean));

    // Which sources to run
    const forced = req.query?.source;
    const cutoff = Date.now() - REFRESH_DAYS * 86400000;
    const due = sources.rows
      .filter(s => forced ? s.source_name === forced
        : String(s.enabled).trim().toUpperCase().startsWith('Y') && (!s.last_run || Date.parse(s.last_run) < cutoff))
      .sort((a, b) => (Date.parse(a.last_run) || 0) - (Date.parse(b.last_run) || 0))
      .slice(0, forced ? 1 : MAX_SOURCES_PER_RUN);

    const newBrands = [], brandUpdates = new Map(), rawRows = [], sourceUpdates = [];

    for (const src of due) {
      if (Date.now() > deadline) break;
      let found = [];
      try {
        const cap = String(src.source_type).trim().toLowerCase() === 'shopify_vendors' ? 2000 : MAX_BRANDS_PER_SOURCE;
        found = (await brandsFromSource(src)).filter(b => b && b.brand_name).slice(0, cap);
      } catch (e) {
        errors.push(`${src.source_name}: ${e.message}`);
        continue;
      }

      const signal = (src.signal_label || src.source_name || '').trim();
      for (const f of found) {
        const name = String(f.brand_name).trim();
        const url = String(f.website_url || '').trim();
        const domain = normalizeDomain(url);
        const nName = normalizeName(name);
        const sig = f.note ? `${signal} (${String(f.note).trim()})` : signal;
        sighted++;

        rawRows.push({
          found_at: nowIso(), brand_name: name, website_url: url,
          source_name: src.source_name, source_ref: src.source_type === 'url' ? src.source_value : src.source_type,
          signal: sig,
        });

        if ((domain && excludedDomains.has(domain)) || excludedNames.has(nName)) continue;

        const existing = (domain && byDomain.get(domain)) || byName.get(nName);
        if (existing) {
          const sourcesStr = appendUnique(existing.sources, src.source_name);
          const signalsStr = appendUnique(existing.signals, sig);
          const sourceCount = sourcesStr.split(' | ').filter(Boolean).length;
          existing.sources = sourcesStr;
          existing.signals = signalsStr;
          if (!existing._row) {               // brand first found earlier in this same run
            existing.source_count = sourceCount;
            if (!existing.website_url && url) {
              existing.website_url = url;
              existing.discovery_status = STATUS.NEW;
              if (domain) byDomain.set(domain, existing);
            }
            continue;
          }
          const patch = brandUpdates.get(existing) || {};
          Object.assign(patch, { sources: sourcesStr, source_count: sourceCount, signals: signalsStr });
          if (!existing.website_url && url) {
            patch.website_url = url;
            existing.website_url = url;
            if (existing.discovery_status === STATUS.NEEDS_URL) patch.discovery_status = STATUS.NEW;
          }
          brandUpdates.set(existing, patch);
          continue;
        }

        let id = slugify(name), i = 2;
        while (ids.has(id)) id = `${slugify(name)}-${i++}`;
        ids.add(id);
        const row = {
          brand_id: id, brand_name: name, website_url: url, lead_source: 'outbound',
          first_seen: nowIso(), sources: src.source_name, source_count: 1, signals: sig,
          discovery_status: url ? STATUS.NEW : STATUS.NEEDS_URL,
        };
        newBrands.push(row);
        if (domain) byDomain.set(domain, row);
        byName.set(nName, row);
      }

      sourceUpdates.push({ row: src._row, data: { last_run: nowIso(), brands_found: found.length } });
    }

    await appendRows(TABS.RAW, raw.headers, rawRows);
    await appendRows(TABS.BRANDS, brands.headers, newBrands);
    const updates = [...brandUpdates.entries()].map(([b, data]) => ({ row: b._row, data }));
    await updateRows(TABS.BRANDS, brands.headers, updates);
    await updateRows(TABS.SOURCES, sources.headers, sourceUpdates);
    added = newBrands.length; updated = updates.length;

    await logRun({
      job: 'discover-brands', processed: due.map(s => s.source_name).join(', ') || 'none due',
      added, updated, errors: errors.join(' || '), notes: `${sighted} sightings`,
    });
    res.status(200).json({ ok: true, sources: due.map(s => s.source_name), sighted, added, updated, errors });
  } catch (err) {
    console.error('discover-brands error:', err);
    await logRun({ job: 'discover-brands', errors: err.message });
    res.status(500).json({ error: err.message });
  }
}
