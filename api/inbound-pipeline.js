/**
 * api/inbound-pipeline.js
 *
 * Fast-track scan for website form leads. Runs ONE step per call, then starts the next call:
 *   enrich -> products -> amazon -> contacts -> audit_amazon -> audit_web -> audit_findings -> review
 * Each step reuses the existing endpoint's code, so inbound brands get exactly the same scan as outbound ones.
 *
 * ?brand_id=<id>  run that brand's current step (called by inbound-form and by itself)
 * no brand_id     (cron, every 5 minutes) restart any lead whose step stalled
 * Auth: CRON_SECRET (Bearer header or ?key=)
 */
import { TABS, STATUS, INBOUND_STEPS, INBOUND_DONE } from './_lib/schema.js';
import { readTab, updateRows, logRun } from './_lib/sheets.js';
import { isAuthorized, nowIso } from './_lib/util.js';
import { runHandler, kickPipeline } from './_lib/inbound.js';
import enrichBrands from './enrich-brands.js';
import scanProducts from './scan-products.js';
import amazonCheck from './amazon-check.js';
import findContacts from './find-contacts.js';
import auditScan from './audit-scan.js';

const STALE_MS = 6 * 60 * 1000;   // a step that hasn't reported back in 6 minutes is retried
const MAX_ATTEMPTS = 3;
const MAX_KICKS_PER_CRON = 5;

const next = step => INBOUND_STEPS[INBOUND_STEPS.indexOf(step) + 1] || INBOUND_DONE.REVIEW;
const errText = out => out.body?.error || (out.body?.errors || []).join('; ') || `status ${out.statusCode}`;

async function freshBrand(id) {
  const brands = await readTab(TABS.BRANDS);
  return { brands, brand: brands.rows.find(r => r.brand_id === id) };
}

/** Run one step. Returns { step, note } for what to save, or throws to retry the same step. */
async function runStep(brand) {
  const id = brand.brand_id;
  switch (brand.inbound_step) {
    case 'enrich': {
      if (![STATUS.NEW, STATUS.NEEDS_URL].includes(brand.discovery_status)) return { step: next('enrich') };
      const out = await runHandler(enrichBrands, { brand_id: id });
      if (out.statusCode >= 400) throw new Error(`Enrich: ${errText(out)}`);
      const { brand: b } = await freshBrand(id);
      if ([STATUS.URL_NOT_FOUND, STATUS.UNREACHABLE].includes(b.discovery_status)) {
        return { step: INBOUND_DONE.NEEDS_WEBSITE, note: b.discovery_status === STATUS.UNREACHABLE ? `Couldn't open ${b.website_url}` : "Couldn't find their website" };
      }
      if (b.discovery_status === STATUS.DUPLICATE) return { step: INBOUND_DONE.FAILED, note: `Same website as another prospect: ${b.signals.split(' | ').find(s => s.startsWith('Duplicate of')) || ''}` };
      if (b.discovery_status === STATUS.NOT_A_FIT) return { step: INBOUND_DONE.NOT_A_FIT, note: 'Their site doesn\'t look like a beauty or wellness brand. Check by hand.' };
      return { step: next('enrich') };
    }
    case 'products': {
      const out = await runHandler(scanProducts, { brand_id: id });
      const note = out.statusCode >= 400 ? `Product scan: ${errText(out)}` : '';
      return { step: next('products'), note };      // the audit still runs without a product scan
    }
    case 'amazon': {
      const out = await runHandler(amazonCheck, { brand_id: id });
      return { step: next('amazon'), note: out.statusCode >= 400 ? `Amazon check: ${errText(out)}` : '' };
    }
    case 'contacts': {
      if (brand.contacts_checked_at) return { step: next('contacts') };
      const out = await runHandler(findContacts, { brand_id: id });
      return { step: next('contacts'), note: out.statusCode >= 400 ? `Contact search: ${errText(out)}` : '' };
    }
    case 'audit_amazon':
    case 'audit_web':
    case 'audit_findings': {
      const stage = brand.inbound_step.replace('audit_', '');
      let scanId = '';
      if (stage !== 'amazon') {
        const builds = await readTab(TABS.AUDIT_BUILDS);
        scanId = builds.rows.find(r => r.brand_id === id)?.scan_id || '';
        if (!scanId) return { step: 'audit_amazon', note: 'No audit scan found, starting it again' };
      }
      const out = await runHandler(auditScan, { brand_id: id, stage, ...(scanId ? { scan_id: scanId } : {}) });
      if (out.statusCode >= 400) throw new Error(`Audit ${stage}: ${errText(out)}`);
      return { step: next(brand.inbound_step), note: (out.body?.notes || []).join('; ') };
    }
    default:
      return null;   // finished or waiting on Jaclyn
  }
}

async function runBrand(req, id) {
  let { brands, brand } = await freshBrand(id);
  if (!brand) return { brand_id: id, error: 'Brand not found' };
  if (!INBOUND_STEPS.includes(brand.inbound_step)) return { brand_id: id, step: brand.inbound_step, note: 'Nothing to run' };

  const step = brand.inbound_step;
  await updateRows(TABS.BRANDS, brands.headers, [{ row: brand._row, data: { inbound_updated: nowIso() } }]);

  let result, error = '';
  try { result = await runStep(brand); }
  catch (e) { error = e.message; }

  ({ brands, brand } = await freshBrand(id));
  const attempts = (Number(brand.inbound_attempts) || 0) + 1;
  const data = { inbound_updated: nowIso() };
  if (error) {
    data.inbound_attempts = String(attempts);
    data.inbound_note = `${error} (try ${attempts} of ${MAX_ATTEMPTS})`;
    if (attempts >= MAX_ATTEMPTS) data.inbound_step = INBOUND_DONE.FAILED;
  } else {
    data.inbound_step = result.step;
    data.inbound_attempts = '0';
    data.inbound_note = result.note || '';
    // Audit scanned: move a not-yet-contacted lead to Audit Ready (HubSpot-linked leads keep HubSpot's stage)
    if (result.step === INBOUND_DONE.REVIEW && !brand.hubspot_company_id
      && ['', 'Not Contacted', 'Researching'].includes(brand.outreach_status || '')) {
      data.outreach_status = 'Audit Ready';
      data.outreach_updated = nowIso();
    }
  }
  await updateRows(TABS.BRANDS, brands.headers, [{ row: brand._row, data }]);
  await logRun({ job: 'inbound-pipeline', processed: 1, updated: 1, errors: error,
    notes: `${brand.brand_name}: ${step} -> ${data.inbound_step || step}${data.inbound_note ? ` (${data.inbound_note})` : ''}` });

  if (INBOUND_STEPS.includes(data.inbound_step || step)) await kickPipeline(req, id);
  return { brand_id: id, ran: step, step: data.inbound_step || step, note: data.inbound_note, error };
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (req.query?.brand_id) return res.status(200).json({ ok: true, ...(await runBrand(req, req.query.brand_id)) });

    // Cron: restart leads whose step never reported back
    const { rows } = await readTab(TABS.BRANDS);
    const stalled = rows.filter(b => INBOUND_STEPS.includes(b.inbound_step)
      && (!b.inbound_updated || Date.now() - Date.parse(b.inbound_updated) > STALE_MS))
      .slice(0, MAX_KICKS_PER_CRON);
    for (const b of stalled) await kickPipeline(req, b.brand_id);
    res.status(200).json({ ok: true, restarted: stalled.map(b => `${b.brand_name} (${b.inbound_step})`) });
  } catch (err) {
    console.error('inbound-pipeline error:', err);
    await logRun({ job: 'inbound-pipeline', errors: err.message });
    res.status(500).json({ error: err.message });
  }
}
