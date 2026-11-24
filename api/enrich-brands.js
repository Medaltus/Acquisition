// Every 2 hours. For brands with status "New" or "Needs URL":
// finds the official site if missing, reads the homepage, and fills category, socials, logo,
// platform, and signals. Never overwrites a cell that already has a value.
// Manual: /api/enrich-brands?key=<CRON_SECRET>&brand_id=<id>
import { TABS, STATUS, CATEGORIES } from './_lib/schema.js';
import { readTab, updateRows, logRun } from './_lib/sheets.js';
import { askClaude, parseJson } from './_lib/claude.js';
import { isAuthorized, normalizeDomain, appendUnique, fetchText, htmlToText } from './_lib/util.js';
import { detectPlatform, findSocials, findLogo, marketplaceSignals, pageTitleAndDescription } from './_lib/site.js';

const BATCH_SIZE = 12;
const TIME_BUDGET_MS = 240000;

async function findOfficialSite(brand) {
  const reply = await askClaude({
    system: 'You find official brand websites. Respond with ONLY JSON: {"website_url": string, "confidence": "high"|"low"}. Use "" if not found. Never return a retailer, marketplace, or social media URL.',
    prompt: `Find the official website of the beauty/wellness brand "${brand.brand_name}".${brand.signals ? ` Context: ${brand.signals}` : ''}`,
    useSearch: true,
    maxSearches: 3,
    maxTokens: 1000,
  });
  const out = parseJson(reply) || {};
  return out.confidence === 'high' ? String(out.website_url || '').trim() : '';
}

async function classify(brand, html, finalUrl) {
  const { title, desc } = pageTitleAndDescription(html);
  const reply = await askClaude({
    system: `You classify beauty and wellness brands from their homepage. Respond with ONLY JSON:
{"is_brand": boolean, "category": one of ${JSON.stringify(CATEGORIES)}, "retailers": string[], "amazon": "none"|"mentioned"|"coming_soon", "headquarters_country": string}
is_brand = true only if this is a consumer brand selling its own beauty, skincare, haircare, makeup, nail, or wellness/supplement products (not a retailer, salon, spa, clinic, or agency).
retailers = physical or online retailers the site says it is sold at. amazon = whether the site mentions Amazon availability.`,
    prompt: `Brand: ${brand.brand_name}\nURL: ${finalUrl}\nTitle: ${title}\nMeta description: ${desc}\n\nHOMEPAGE TEXT:\n${htmlToText(html, 8000)}`,
    maxTokens: 800,
  });
  return parseJson(reply) || {};
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const deadline = Date.now() + TIME_BUDGET_MS;
  const errors = [], updates = [];

  try {
    const brands = await readTab(TABS.BRANDS);
    const byDomain = new Map();
    for (const b of brands.rows) { const d = normalizeDomain(b.website_url); if (d && !byDomain.has(d)) byDomain.set(d, b); }

    const queue = req.query?.brand_id
      ? brands.rows.filter(b => b.brand_id === req.query.brand_id)
      : brands.rows.filter(b => [STATUS.NEW, STATUS.NEEDS_URL].includes(b.discovery_status)).slice(0, BATCH_SIZE);

    for (const b of queue) {
      if (Date.now() > deadline) break;
      const data = {};
      try {
        let url = b.website_url;
        if (!url) {
          url = await findOfficialSite(b);
          if (!url) { updates.push({ row: b._row, data: { discovery_status: STATUS.URL_NOT_FOUND } }); continue; }
        }

        const page = await fetchText(/^https?:\/\//i.test(url) ? url : `https://${url}`, { timeout: 20000 });
        if (!page.ok || page.text.length < 500) {
          updates.push({ row: b._row, data: { website_url: b.website_url || url, discovery_status: STATUS.UNREACHABLE } });
          continue;
        }

        const origin = new URL(page.finalUrl).origin;
        const domain = normalizeDomain(origin);
        const other = byDomain.get(domain);
        if (other && other !== b) {
          updates.push({ row: b._row, data: { website_url: origin, discovery_status: STATUS.DUPLICATE,
            signals: appendUnique(b.signals, `Duplicate of ${other.brand_id}`) } });
          continue;
        }
        byDomain.set(domain, b);

        const html = page.text;
        const socials = findSocials(html);
        const info = await classify(b, html, origin);

        let signals = b.signals;
        for (const s of marketplaceSignals(html)) signals = appendUnique(signals, s);
        if (info.amazon === 'coming_soon') signals = appendUnique(signals, 'Says coming soon to Amazon');
        if (info.amazon === 'mentioned') signals = appendUnique(signals, 'Mentions Amazon on site');
        if (Array.isArray(info.retailers) && info.retailers.length) {
          signals = appendUnique(signals, `Retailers on site: ${info.retailers.slice(0, 6).join(', ')}`);
        }
        if (info.headquarters_country) signals = appendUnique(signals, `HQ: ${info.headquarters_country}`);

        // Fill only blank cells so manual overrides are never overwritten
        const fill = (key, value) => { if (value && !b[key]) data[key] = value; };
        data.website_url = origin;
        fill('category', CATEGORIES.includes(info.category) ? info.category : '');
        fill('instagram_handle', socials.instagram);
        fill('tiktok_handle', socials.tiktok);
        fill('logo_url', findLogo(html, origin));
        fill('platform', detectPlatform(html));
        data.signals = signals;
        data.discovery_status = info.is_brand === false ? STATUS.NOT_A_FIT : STATUS.ENRICHED;
        updates.push({ row: b._row, data });
      } catch (e) {
        errors.push(`${b.brand_name}: ${e.message}`);
      }
    }

    await updateRows(TABS.BRANDS, brands.headers, updates);
    await logRun({ job: 'enrich-brands', processed: queue.length, updated: updates.length, errors: errors.join(' || ') });
    res.status(200).json({ ok: true, processed: queue.length, updated: updates.length, errors });
  } catch (err) {
    console.error('enrich-brands error:', err);
    await logRun({ job: 'enrich-brands', errors: err.message });
    res.status(500).json({ error: err.message });
  }
}
