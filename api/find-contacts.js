/**
 * api/find-contacts.js
 *
 * Hourly. Free contact finding for prospects (no paid data services):
 *   1) Reads the brand's own About / Team / Story / Press / Contact / Wholesale pages for named people
 *      and published emails.
 *   2) One Claude web search for founders and ecommerce/marketing leaders (press, interviews,
 *      public profiles), combined with the site text.
 *   3) Ranks everyone by title (founder/CEO first), saves them all to the Contacts tab, and fills the
 *      brand's primary contact if it's blank and the brand isn't managed in HubSpot.
 * Only emails actually published on a page are saved. Nothing is guessed.
 * Manual: /api/find-contacts?brand_id=<id> (Authorization: Bearer <CRON_SECRET>)
 */
import { TABS, STATUS } from './_lib/schema.js';
import { readTab, appendRows, updateRows, logRun } from './_lib/sheets.js';
import { isAuthorized, nowIso, normalizeDomain, normalizeName, fetchText, htmlToText, appendUnique } from './_lib/util.js';
import { askClaude, parseJson } from './_lib/claude.js';
import { titleRank, classifyEmails, emailMatchesName } from './_lib/contacts.js';

const BRANDS_PER_RUN = 5;
const TIME_BUDGET_MS = 250000;
const PAGE_HINT = /(about|our-story|story|team|founder|who-we-are|people|leadership|press|media|contact|wholesale|partner)/i;
const READY = [STATUS.ENRICHED, STATUS.PRODUCTS_SCANNED, STATUS.PRODUCTS_PARTIAL, STATUS.NO_PRODUCTS];
// Best prospects first
const AZ_ORDER = ['Not on Amazon', 'Resellers only', 'Brand + resellers', 'On Amazon: multiple sellers', 'On Amazon: reseller signals',
  'Listed, no active offers', 'On Amazon: one seller', 'On Amazon: single seller', 'Brand only'];

async function readSite(origin) {
  const home = await fetchText(origin, { timeout: 15000 });
  if (!home.ok) return { pages: [], emails: [] };
  const links = new Set();
  for (const m of home.text.matchAll(/href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], origin);
      if (u.origin === new URL(origin).origin && PAGE_HINT.test(u.pathname) && !/\.(jpg|png|pdf)$/i.test(u.pathname)) links.add(u.href.split('?')[0]);
    } catch { /* bad href */ }
  }
  const pages = [{ url: origin, html: home.text }];
  for (const url of [...links].slice(0, 6)) {
    const r = await fetchText(url, { timeout: 12000 });
    if (r.ok) pages.push({ url, html: r.text });
  }
  const emails = pages.flatMap(p => [...p.html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map(m => m[0]));
  return { pages, emails };
}

const SYSTEM = `You find the leadership of consumer beauty, skincare, haircare, and wellness brands for B2B outreach.
Find the most senior people, prioritizing: founder/co-founder/CEO/owner, then CMO / chief growth or digital officer,
then VP or Head of Ecommerce/Digital/Growth/Marketing, then Directors of those areas.
Only include real people you saw named on a page with this brand. Never invent people, titles, or emails.
Only include an email if it was published on a page you read. Include a LinkedIn profile URL only if it appeared in your results.
Respond with ONLY JSON: {"people":[{"name":string,"title":string,"source_url":string,"linkedin_url":string,"email":string,"evidence":string}]}
evidence = a short phrase saying where you saw them (e.g. "About page: 'founded by Jane Doe'"). Use "" for unknown fields.`;

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const deadline = Date.now() + TIME_BUDGET_MS;
  const errors = [], summary = [];
  try {
    const [brands, contacts] = await Promise.all([readTab(TABS.BRANDS), readTab(TABS.CONTACTS)]);
    const queue = req.query?.brand_id
      ? brands.rows.filter(b => b.brand_id === req.query.brand_id)
      : brands.rows
        .filter(b => READY.includes(b.discovery_status) && b.website_url && !b.contacts_checked_at)
        .sort((a, b) => (AZ_ORDER.indexOf(a.amazon_status) + 1 || 99) - (AZ_ORDER.indexOf(b.amazon_status) + 1 || 99))
        .slice(0, BRANDS_PER_RUN);

    for (const b of queue) {
      if (Date.now() > deadline - 40000) break;
      try {
        const origin = new URL(b.website_url).origin;
        const domain = normalizeDomain(origin);
        const { pages, emails } = await readSite(origin);
        const { role, personal } = classifyEmails(emails, domain);
        const siteText = pages.map(p => `--- ${p.url}\n${htmlToText(p.html, 4000)}`).join('\n').slice(0, 14000);

        const reply = await askClaude({
          system: SYSTEM,
          prompt: `Brand: ${b.brand_name}\nWebsite: ${origin}\nEmails published on their site: ${[...role, ...personal].join(', ') || 'none'}\n\nTEXT FROM THEIR SITE:\n${siteText}\n\nUse web search (press, interviews, LinkedIn results, company profiles) to find the founder and senior ecommerce/marketing/digital leaders. Return the JSON.`,
          useSearch: true, maxSearches: 4, maxTokens: 3000,
        });
        const people = (parseJson(reply)?.people || [])
          .filter(p => p && String(p.name || '').trim().split(/\s+/).length >= 2)
          .map(p => {
            const name = String(p.name).trim();
            // Emails: published on their site = trusted; from research only = flagged to verify before sending
            const siteEmails = emails.map(e => e.toLowerCase());
            let email = String(p.email || '').toLowerCase().trim();
            let email_source = !email ? '' : siteEmails.includes(email) ? 'Published on brand site' : 'Found in research: verify before sending';
            if (email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) { email = ''; email_source = ''; }
            if (!email) { const m = personal.find(e => emailMatchesName(e, name)); if (m) { email = m; email_source = 'Published on brand site'; } }
            return { name, title: String(p.title || '').trim(), rank: titleRank(p.title), email, email_source,
              linkedin_url: /linkedin\.com\/in\//i.test(p.linkedin_url || '') ? p.linkedin_url : '',
              source: 'Brand site + web research', source_url: p.source_url || '', evidence: String(p.evidence || '').slice(0, 300) };
          })
          .sort((x, y) => x.rank - y.rank);

        // Save new people (skip ones already in Contacts for this brand)
        const existing = new Set(contacts.rows.filter(c => c.brand_id === b.brand_id).map(c => normalizeName(c.name)));
        const fresh = people.filter(p => !existing.has(normalizeName(p.name)))
          .map(p => ({ brand_id: b.brand_id, brand_name: b.brand_name, ...p, found_at: nowIso() }));
        await appendRows(TABS.CONTACTS, contacts.headers, fresh);
        fresh.forEach(p => { contacts.rows.push(p); existing.add(normalizeName(p.name)); });

        // Brand row: role emails, checked time, primary contact if blank (HubSpot owns contacts on linked brands)
        const data = { contacts_checked_at: nowIso() };
        let roles = b.role_emails;
        role.forEach(e => { roles = appendUnique(roles, e); });
        if (roles !== b.role_emails) data.role_emails = roles;
        const top = people.find(p => p.rank < 9) || people[0];
        if (top && !b.hubspot_company_id && !b.contact_name) {
          Object.assign(data, { contact_name: top.name, contact_title: top.title, contact_email: top.email, contact_linkedin: top.linkedin_url });
        }
        await updateRows(TABS.BRANDS, brands.headers, [{ row: b._row, data }]);
        summary.push(`${b.brand_name}: ${people.length} people${top ? `, top: ${top.name} (${top.title || 'no title'})` : ''}, ${role.length} role emails`);
      } catch (e) { errors.push(`${b.brand_name}: ${e.message}`); }
    }

    await logRun({ job: 'find-contacts', processed: queue.length, updated: summary.length, errors: errors.join(' || '), notes: summary.join(' || ') });
    res.status(200).json({ ok: true, summary, errors });
  } catch (err) {
    console.error('find-contacts error:', err);
    await logRun({ job: 'find-contacts', errors: err.message });
    res.status(500).json({ error: err.message });
  }
}
