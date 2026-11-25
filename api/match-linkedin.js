/**
 * api/match-linkedin.js
 *
 * Daily (and manual). Matches LinkedIn connections exports to prospect brands to surface warm intros.
 * Import each person's LinkedIn "Connections.csv" into its own tab named "LinkedIn - <Name>"
 * (e.g. "LinkedIn - Jaclyn"). The 3 note lines LinkedIn puts above the header are handled.
 *   - Connections whose company matches a prospect get written to the brand's warm_intros
 *     ("Jaclyn: Jane Doe (Founder)") and added to the Contacts tab with their LinkedIn URL.
 *   - The brand's primary contact is filled from a connection if it's blank and not managed in HubSpot.
 * Manual: /api/match-linkedin (Authorization: Bearer <CRON_SECRET>)
 */
import { TABS } from './_lib/schema.js';
import { readTab, readValues, listTabs, appendRows, updateRows, logRun } from './_lib/sheets.js';
import { isAuthorized, nowIso, normalizeName } from './_lib/util.js';
import { titleRank } from './_lib/contacts.js';

function parseExport(values, owner) {
  const h = values.findIndex(r => r.some(c => /^first name$/i.test(String(c).trim())) && r.some(c => /^company$/i.test(String(c).trim())));
  if (h < 0) return [];
  const idx = name => values[h].findIndex(c => String(c).trim().toLowerCase() === name);
  const col = { first: idx('first name'), last: idx('last name'), url: idx('url'), email: idx('email address'), company: idx('company'), position: idx('position') };
  return values.slice(h + 1).map(r => ({
    name: [r[col.first], r[col.last]].filter(Boolean).join(' ').trim(),
    url: col.url >= 0 ? String(r[col.url] || '').trim() : '',
    email: col.email >= 0 ? String(r[col.email] || '').trim() : '',
    company: String(r[col.company] || '').trim(),
    position: col.position >= 0 ? String(r[col.position] || '').trim() : '',
    owner,
  })).filter(c => c.name && c.company);
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const tabs = (await listTabs()).filter(t => /^linkedin\b/i.test(t) || /^connections$/i.test(t));
    if (!tabs.length) return res.status(200).json({ ok: true, note: 'No LinkedIn tabs found. Import Connections.csv into a tab named "LinkedIn - <your name>".' });

    const connections = [];
    for (const t of tabs) {
      const owner = t.replace(/^linkedin\s*[-–:]?\s*/i, '').trim() || 'You';
      connections.push(...parseExport(await readValues(t), /^connections$/i.test(t) ? 'You' : owner));
    }

    const [brands, contacts] = await Promise.all([readTab(TABS.BRANDS), readTab(TABS.CONTACTS)]);
    const keys = brands.rows.map(b => ({ b, keys: [normalizeName(b.brand_name), normalizeName(b.amazon_brand_name)].filter(k => k.length >= 3) }));
    const matchBrand = company => {
      const c = normalizeName(company);
      if (!c) return null;
      return (keys.find(x => x.keys.includes(c)) || keys.find(x => x.keys.some(k => k.length >= 5 && c.startsWith(k))))?.b || null;
    };

    const byBrand = new Map();
    for (const c of connections) {
      const b = matchBrand(c.company);
      if (b) (byBrand.get(b) || byBrand.set(b, []).get(b)).push(c);
    }

    const brandUpdates = [], newContacts = [];
    const known = new Set(contacts.rows.map(c => `${c.brand_id}|${normalizeName(c.name)}`));
    for (const [b, cs] of byBrand) {
      cs.sort((x, y) => titleRank(x.position) - titleRank(y.position));
      const intros = cs.map(c => `${c.owner}: ${c.name}${c.position ? ` (${c.position})` : ''}`).join(' | ');
      const data = {};
      if (intros !== b.warm_intros) data.warm_intros = intros;
      const top = cs[0];
      if (!b.hubspot_company_id && !b.contact_name) {
        Object.assign(data, { contact_name: top.name, contact_title: top.position, contact_email: top.email, contact_linkedin: top.url });
      }
      if (Object.keys(data).length) brandUpdates.push({ row: b._row, data });
      for (const c of cs) {
        const key = `${b.brand_id}|${normalizeName(c.name)}`;
        if (known.has(key)) continue;
        known.add(key);
        newContacts.push({ brand_id: b.brand_id, brand_name: b.brand_name, name: c.name, title: c.position, rank: titleRank(c.position),
          email: c.email, email_source: c.email ? `LinkedIn connection (${c.owner})` : '', linkedin_url: c.url,
          source: `LinkedIn connection (${c.owner})`, source_url: c.url, evidence: `Connected to ${c.owner}; lists ${c.company}`, found_at: nowIso() });
      }
    }

    await updateRows(TABS.BRANDS, brands.headers, brandUpdates);
    await appendRows(TABS.CONTACTS, contacts.headers, newContacts);
    const result = { tabs, connections: connections.length, brandsWithWarmIntros: byBrand.size, contactsAdded: newContacts.length };
    await logRun({ job: 'match-linkedin', processed: connections.length, added: newContacts.length, updated: brandUpdates.length, notes: JSON.stringify(result) });
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('match-linkedin error:', err);
    await logRun({ job: 'match-linkedin', errors: err.message });
    res.status(500).json({ error: err.message });
  }
}
