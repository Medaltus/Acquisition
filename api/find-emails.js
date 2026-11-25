/**
 * api/find-emails.js
 *
 * Finds and verifies personal emails for the top contacts at prospect brands using Hunter.io.
 *   - Contact with no email      -> Hunter Email Finder (name + brand domain), uses 1 search credit
 *   - Email flagged "verify"     -> Hunter Email Verifier, uses 1 verification credit
 * Only the highest-ranked contacts (founder/CEO first) at each brand are looked up, best prospects first,
 * and every contact is looked up once (email_checked_at), so credits aren't spent twice.
 * Checks remaining credits first and stops before running out.
 * Calls:
 *   GET  /api/find-emails?credits=1                     -> remaining Hunter credits, no lookups
 *   GET  /api/find-emails                                -> batch run (CRON_SECRET)
 *   GET  /api/find-emails?brand_id=<id>                  -> one brand
 *   POST /api/find-emails { brand_id, name }             -> one contact (dashboard button)
 * Env: HUNTER_API_KEY, optional HUNTER_PER_BRAND (default 1), HUNTER_MAX_PER_RUN (default 5)
 */
import { TABS } from './_lib/schema.js';
import { readTab, updateRows, logRun } from './_lib/sheets.js';
import { isAuthorized, isDashboardAuthorized, nowIso, normalizeDomain, normalizeName } from './_lib/util.js';
import { getCredits, findEmail, verifyEmail } from './_lib/hunter.js';

const PER_BRAND = Number(process.env.HUNTER_PER_BRAND) || 1;
const MAX_PER_RUN = Number(process.env.HUNTER_MAX_PER_RUN) || 5;
const MAX_RANK = 4;   // founder/CEO, C-level, VP/Head, Director
const AZ_ORDER = ['Not on Amazon', 'Resellers only', 'Brand + resellers', 'On Amazon: multiple sellers', 'On Amazon: reseller signals',
  'Listed, no active offers', 'On Amazon: one seller', 'On Amazon: single seller', 'Brand only'];

const needsWork = c => !c.email_checked_at && (!c.email || /verify/i.test(c.email_source || ''));
const splitName = n => { const p = String(n).trim().split(/\s+/); return { firstName: p[0], lastName: p.slice(1).join(' ') }; };

export default async function handler(req, res) {
  if (!isAuthorized(req) && !isDashboardAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const credits = await getCredits();
    if (req.query?.credits) return res.status(200).json({ ok: true, credits });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const onlyBrand = body.brand_id || req.query?.brand_id || '';
    const onlyName = body.name ? normalizeName(body.name) : '';

    const [brands, contacts] = await Promise.all([readTab(TABS.BRANDS), readTab(TABS.CONTACTS)]);
    const brandById = new Map(brands.rows.map(b => [b.brand_id, b]));

    // Pick work: single contact, single brand, or best prospects' top contacts
    let queue = contacts.rows.filter(c => brandById.get(c.brand_id)?.website_url);
    if (onlyName) queue = queue.filter(c => c.brand_id === onlyBrand && normalizeName(c.name) === onlyName);
    else {
      queue = queue.filter(c => needsWork(c) && Number(c.rank || 9) <= MAX_RANK && (!onlyBrand || c.brand_id === onlyBrand));
      queue.sort((a, b) => {
        const za = AZ_ORDER.indexOf(brandById.get(a.brand_id)?.amazon_status), zb = AZ_ORDER.indexOf(brandById.get(b.brand_id)?.amazon_status);
        return ((za + 1) || 99) - ((zb + 1) || 99) || Number(a.rank || 9) - Number(b.rank || 9);
      });
      const perBrand = {};
      queue = queue.filter(c => (perBrand[c.brand_id] = (perBrand[c.brand_id] || 0) + 1) <= PER_BRAND).slice(0, onlyBrand ? PER_BRAND : MAX_PER_RUN);
    }
    if (!queue.length) return res.status(200).json({ ok: true, credits, results: [], note: 'No contacts need an email lookup.' });

    let searchesLeft = credits.searches.available - credits.searches.used;
    let verifsLeft = credits.verifications.available - credits.verifications.used;
    const contactUpdates = [], brandUpdates = [], results = [];

    for (const c of queue) {
      const b = brandById.get(c.brand_id);
      const domain = normalizeDomain(b.website_url);
      const stamp = nowIso();
      try {
        let email = c.email, status = '', score = '', source = c.email_source;
        if (c.email && /verify/i.test(c.email_source || '')) {
          if (verifsLeft <= 0) { results.push({ name: c.name, brand: b.brand_name, skipped: 'No Hunter verification credits left' }); continue; }
          const v = await verifyEmail(c.email); verifsLeft--;
          status = v.status; score = v.score;
          source = `Found in research, Hunter verified: ${v.status}`;
          if (v.status === 'invalid') { email = ''; source = 'Research email failed Hunter verification'; }
        } else {
          if (searchesLeft <= 0) { results.push({ name: c.name, brand: b.brand_name, skipped: 'No Hunter search credits left' }); continue; }
          const { firstName, lastName } = splitName(c.name);
          if (!lastName) { results.push({ name: c.name, brand: b.brand_name, skipped: 'Needs a first and last name' }); continue; }
          const f = await findEmail({ domain, firstName, lastName }); searchesLeft--;
          email = f.email; score = f.score; status = f.status || (f.email ? 'unverified' : 'not found');
          source = f.email ? `Hunter (confidence ${f.score}${f.status ? `, ${f.status}` : ''})` : 'Hunter: no email found';
          // Verify when Hunter's finder didn't already verify it
          if (f.email && !f.status && verifsLeft > 0) {
            const v = await verifyEmail(f.email); verifsLeft--;
            status = v.status; source = `Hunter (confidence ${f.score}, verified ${v.status})`;
            if (v.status === 'invalid') { email = ''; source = 'Hunter found an address but it failed verification'; }
          }
        }
        contactUpdates.push({ row: c._row, data: { email, email_source: source, email_status: status, email_score: score, email_checked_at: stamp } });

        // Fill the brand's primary contact email when this is the primary person (HubSpot owns linked brands)
        if (email && !b.hubspot_company_id && normalizeName(b.contact_name) === normalizeName(c.name) && !b.contact_email) {
          brandUpdates.push({ row: b._row, data: { contact_email: email } });
        }
        results.push({ name: c.name, brand: b.brand_name, email: email || '(none)', status });
      } catch (e) {
        results.push({ name: c.name, brand: b.brand_name, error: e.message });
        if (/credits|429/.test(e.message)) break;
      }
    }

    await updateRows(TABS.CONTACTS, contacts.headers, contactUpdates);
    await updateRows(TABS.BRANDS, brands.headers, brandUpdates);
    const found = results.filter(r => r.email && r.email !== '(none)').length;
    await logRun({ job: 'find-emails', processed: results.length, updated: found,
      errors: results.filter(r => r.error).map(r => `${r.brand}: ${r.error}`).join(' || '),
      notes: `Searches left ${searchesLeft}, verifications left ${verifsLeft}` });
    res.status(200).json({ ok: true, found, results, creditsLeft: { searches: searchesLeft, verifications: verifsLeft } });
  } catch (err) {
    console.error('find-emails error:', err);
    res.status(500).json({ error: err.message });
  }
}
