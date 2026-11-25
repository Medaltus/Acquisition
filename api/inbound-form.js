/**
 * api/inbound-form.js
 *
 * Receives every medaltus.com form submission (Webflow form_submission webhook) and starts the
 * fast-track scan for that brand. It never changes the form or the website.
 *
 * Webflow webhook URL: https://<deployment>/api/inbound-form?key=<INBOUND_SECRET>
 * Each submission:
 *   1. is logged in the "Inbound Log" tab as received (Webflow retries are ignored by submission ID)
 *   2. is matched to a brand: the Brand Name field, a website typed in it, or the email's domain
 *   3. skips current/past partners (logged, nothing else happens)
 *   4. updates the prospect if we already have it, or adds it with lead_source "inbound"
 *   5. adds the person to Contacts and starts the scan (enrich, products, Amazon, contacts, audit)
 */
import { TABS, STATUS } from './_lib/schema.js';
import { readTab, appendRows, updateRows, logRun } from './_lib/sheets.js';
import { nowIso, normalizeDomain, normalizeName, slugify, appendUnique } from './_lib/util.js';
import { parseSubmission, guessWebsite, nameFromDomain, kickPipeline } from './_lib/inbound.js';

const RECENT_AUDIT_DAYS = 30;

function authorized(req) {
  const secret = (process.env.INBOUND_SECRET || '').trim();
  return Boolean(secret) && req.query?.key === secret;
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(200).json({ ok: true, note: 'Inbound endpoint is live. Webflow sends POST.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const sub = parseSubmission(body);
  const stamp = nowIso();
  const logRow = {
    received_at: stamp, submission_id: sub.submissionId, form_name: sub.formName, page: sub.page,
    name: sub.name, email: sub.email, brand_text: sub.brandText, requests: sub.requests.join(', '), raw: sub.raw,
  };

  try {
    const [log, brands, partners, contacts] = await Promise.all([
      readTab(TABS.INBOUND), readTab(TABS.BRANDS),
      readTab(TABS.PARTNERS).catch(() => ({ rows: [] })), readTab(TABS.CONTACTS),
    ]);
    const finish = async (outcome, extra = {}) => {
      await appendRows(TABS.INBOUND, log.headers, [{ ...logRow, ...extra, outcome }]);
      return res.status(200).json({ ok: true, outcome, ...extra });
    };

    // Webflow retries a webhook it thinks failed; process each submission once
    if (sub.submissionId && log.rows.some(r => r.submission_id === sub.submissionId)) {
      return res.status(200).json({ ok: true, outcome: 'Already received' });
    }
    if (!sub.email) return finish('Skipped: no email in submission');

    const website = guessWebsite(sub);
    logRow.website_guess = website;
    const typedIsDomain = website && normalizeDomain(sub.brandText) === normalizeDomain(website);
    const brandName = (!typedIsDomain && sub.brandText) || nameFromDomain(website);
    if (!brandName) return finish('No brand: personal email and no brand name, so nothing to scan');

    const domain = normalizeDomain(website);
    const nName = normalizeName(brandName);

    const partner = partners.rows.find(p => (domain && normalizeDomain(p.website_url) === domain) || normalizeName(p.brand_name) === nName);
    if (partner) return finish(`Existing partner: ${partner.brand_name}`);

    const formMessage = [sub.formName, sub.page && `on ${sub.page}`, sub.requests.length && `· Requested: ${sub.requests.join(', ')}`]
      .filter(Boolean).join(' ');
    let brand = brands.rows.find(b => (domain && normalizeDomain(b.website_url) === domain) || normalizeName(b.brand_name) === nName);
    let step;

    if (brand) {
      const recentAudit = brand.audit_status && Date.parse(brand.scan_completed_at) > Date.now() - RECENT_AUDIT_DAYS * 86400000;
      step = recentAudit ? 'review'
        : [STATUS.NEW, STATUS.NEEDS_URL, STATUS.URL_NOT_FOUND, STATUS.UNREACHABLE].includes(brand.discovery_status) ? 'enrich'
        : 'products';
      const data = {
        lead_source: appendUnique(brand.lead_source, 'inbound', ', '),
        inbound_at: stamp, inbound_step: step, inbound_updated: stamp, inbound_attempts: '0',
        inbound_note: recentAudit ? 'Already had an audit scan from the last 30 days' : '',
        form_message: formMessage,
        signals: appendUnique(brand.signals, 'Filled out the medaltus.com form'),
      };
      if (!brand.website_url && website) { data.website_url = website; if (brand.discovery_status === STATUS.NEEDS_URL) data.discovery_status = STATUS.NEW; }
      if (!brand.hubspot_company_id) {
        if (!brand.contact_email) { data.contact_email = sub.email; if (sub.name) data.contact_name = sub.name; }
        if (['', 'Not Contacted', 'Researching'].includes(brand.outreach_status || '')) {
          data.outreach_status = step === 'review' ? 'Audit Ready' : 'Researching';
          data.outreach_updated = stamp;
        }
      }
      await updateRows(TABS.BRANDS, brands.headers, [{ row: brand._row, data }]);
      logRow.brand_id = brand.brand_id;
    } else {
      const ids = new Set(brands.rows.map(b => b.brand_id));
      let id = slugify(brandName), i = 2;
      while (ids.has(id)) id = `${slugify(brandName)}-${i++}`;
      step = 'enrich';
      brand = {
        brand_id: id, brand_name: brandName, website_url: website, lead_source: 'inbound',
        first_seen: stamp, sources: 'Website form', source_count: 1, signals: 'Filled out the medaltus.com form',
        discovery_status: website ? STATUS.NEW : STATUS.NEEDS_URL,
        contact_name: sub.name, contact_email: sub.email, form_message: formMessage,
        outreach_status: 'Researching', outreach_updated: stamp,
        inbound_at: stamp, inbound_step: step, inbound_updated: stamp, inbound_attempts: '0',
      };
      await appendRows(TABS.BRANDS, brands.headers, [brand]);
      logRow.brand_id = id;
    }

    // The person who filled out the form, at the top of the brand's contact list
    const known = contacts.rows.some(c => c.brand_id === logRow.brand_id && String(c.email).toLowerCase() === sub.email.toLowerCase());
    if (!known) {
      await appendRows(TABS.CONTACTS, contacts.headers, [{
        brand_id: logRow.brand_id, brand_name: brand.brand_name, name: sub.name, title: '', rank: 9,
        email: sub.email, email_source: 'Submitted on the website form', source: 'Website form',
        source_url: sub.page, evidence: `Filled out ${sub.formName || 'a form'} on medaltus.com`, found_at: stamp,
      }]);
    }

    await appendRows(TABS.INBOUND, log.headers, [{ ...logRow, outcome: step === 'review' ? 'Matched a prospect with a recent audit' : 'Scan started' }]);
    if (step !== 'review') await kickPipeline(req, logRow.brand_id);
    await logRun({ job: 'inbound-form', processed: 1, added: brand._row ? 0 : 1, updated: brand._row ? 1 : 0, notes: `${brand.brand_name}: ${step}` });
    res.status(200).json({ ok: true, brand_id: logRow.brand_id, step });
  } catch (err) {
    console.error('inbound-form error:', err);
    await logRun({ job: 'inbound-form', errors: `${sub.email || 'unknown'}: ${err.message}` });
    // 500 makes Webflow retry later, which is what we want if the sheet was briefly unavailable
    res.status(500).json({ error: err.message });
  }
}
