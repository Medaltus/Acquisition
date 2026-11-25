/**
 * api/h10-probe.js
 *
 * One-time check of the Helium 10 connection before wiring Cerebro into audits.
 *   GET                 -> lists the Helium 10 tools this account has (keyword/ASIN/rank/usage tools in full). No quota used.
 *   GET ?asin=B0XXXXXXXX -> runs the reverse ASIN (Cerebro) tool once on that ASIN and returns a sample. Uses 1 quota call.
 *   GET ?brand_id=...   -> same, using the first hero ASIN from that brand's latest audit scan.
 * Auth: Authorization: Bearer CRON_SECRET.
 */
import { isAuthorized } from './_lib/util.js';
import { listTools, callTool, helium10Ready } from './_lib/helium10.js';
import { TABS } from './_lib/schema.js';
import { readTab } from './_lib/sheets.js';

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await helium10Ready())) return res.status(400).json({ error: 'Helium 10 is not connected yet. Open /api/h10-connect in a browser first.' });
  try {
    const tools = await listTools();
    const relevant = tools.filter(t => /keyword|asin|cerebro|rank|usage/i.test(`${t.name} ${t.description}`));
    let asin = String(req.query?.asin || '').trim().toUpperCase();
    const brandId = String(req.query?.brand_id || '').trim();
    if (!asin && brandId) {
      const hero = (await readTab(TABS.AUDIT_DATA)).rows.filter(r => r.brand_id === brandId && /^score\.[A-Z0-9]{10}\.name$/.test(r.field)).pop();
      if (!hero) return res.status(404).json({ error: `No hero ASIN found in Audit Data for ${brandId}` });
      asin = hero.field.split('.')[1];
    }
    if (!asin) {
      return res.status(200).json({
        ok: true, toolCount: tools.length, allTools: tools.map(t => t.name),
        relevant: relevant.map(t => ({ name: t.name, description: t.description, input: t.inputSchema })),
      });
    }
    if (!/^[A-Z0-9]{10}$/.test(asin)) return res.status(400).json({ error: 'asin must be 10 characters' });
    const tool = tools.find(t => /keywords?_by_asin|reverse_asin|cerebro/i.test(t.name));
    if (!tool) return res.status(404).json({ error: 'No reverse ASIN tool found', allTools: tools.map(t => t.name) });
    const props = Object.keys(tool.inputSchema?.properties || {});
    const args = {};
    const asinKey = props.find(p => /^asins$/i.test(p)) || props.find(p => /asin/i.test(p));
    args[asinKey] = /s$/i.test(asinKey) || tool.inputSchema.properties[asinKey]?.type === 'array' ? [asin] : asin;
    const mkt = props.find(p => /marketplace/i.test(p));
    if (mkt) args[mkt] = tool.inputSchema.properties[mkt]?.enum?.find(v => /^(US|ATVPDKIKX0DER|amazon\.com)$/i.test(v)) || 'US';
    const out = await callTool(tool.name, args);
    const sample = typeof out === 'string' ? out.slice(0, 6000) : JSON.stringify(out).slice(0, 6000);
    return res.status(200).json({ ok: true, tool: tool.name, argsSent: args, input: tool.inputSchema, sample });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
