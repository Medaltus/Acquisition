/**
 * api/_lib/helium10.js
 *
 * Minimal client for Helium 10's MCP server (https://mcp.helium10.com/mcp), used for Cerebro
 * (reverse ASIN) data in audits.
 *
 * Auth: Helium 10 MCP only offers OAuth. Connect once with /api/h10-connect; the access and refresh
 * tokens are kept encrypted on the Settings tab and refreshed here when they expire.
 *
 * Every tool call counts against the shared Helium 10 MCP monthly quota, so callers ask for
 * specific ASINs only. Only read-only tools on READ_TOOLS can be called from the scanner: the
 * Helium 10 server also has tools that change listings, and the scanner must never use those.
 */
import { getSetting, setSetting } from './settings.js';

export const MCP_URL = 'https://mcp.helium10.com/mcp';
export const AUTH_BASE = 'https://members.helium10.com/authhub/api/scenarios/mcp';
export const TOKEN_KEY = 'helium10_oauth';

/** Read-only tools the scanner may call (matched by name). */
const READ_TOOLS = [/keywords?_by_asin/i, /reverse_asin/i, /cerebro/i, /mcp_usage/i];

let session = null;
let nextId = 1;
let cached = null;
let gatewaySession = '';   // Helium 10 asks for its session_id on every call after the first

async function accessToken(force = false) {
  cached = cached || await getSetting(TOKEN_KEY);
  if (!cached?.refresh_token && !cached?.access_token) throw new Error('Helium 10 is not connected. Open /api/h10-connect to connect it.');
  const fresh = cached.access_token && cached.expires_at && Date.now() < cached.expires_at - 120000;
  if (fresh && !force) return cached.access_token;
  if (!cached.refresh_token) throw new Error('Helium 10 connection expired. Open /api/h10-connect to reconnect.');
  const res = await fetch(`${AUTH_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: cached.refresh_token,
      client_id: cached.client_id, resource: MCP_URL,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Helium 10 sign-in expired (${data.error || res.status}). Open /api/h10-connect to reconnect.`);
  }
  cached = {
    ...cached, access_token: data.access_token,
    refresh_token: data.refresh_token || cached.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  await setSetting(TOKEN_KEY, cached);
  return cached.access_token;
}

/** True once /api/h10-connect has been completed. */
export async function helium10Ready() {
  try { cached = cached || await getSetting(TOKEN_KEY); } catch { return false; }
  return !!(cached?.refresh_token || cached?.access_token);
}

async function rpc(method, params, { notify = false, retried = false } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${await accessToken()}`,
  };
  if (session) headers['Mcp-Session-Id'] = session;
  const msg = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: nextId++, method, params };
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(90000) });
  if (res.status === 401 && !retried) {
    await accessToken(true);
    return rpc(method, params, { notify, retried: true });
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  if (notify) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Helium 10 ${res.status}: ${text.slice(0, 300)}`);
  // Response is plain JSON or an SSE stream; take the message that answers our id
  const msgs = res.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean)
    : [JSON.parse(text)];
  const reply = msgs.find(m => m.id === msg.id) || msgs[msgs.length - 1];
  if (reply?.error) throw new Error(`Helium 10: ${reply.error.message || JSON.stringify(reply.error)}`);
  return reply?.result;
}

async function connect() {
  if (session) return;
  await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'medaltus-brand-scanner', version: '1.0' },
  });
  await rpc('notifications/initialized', {}, { notify: true });
}

/** All tools the account can use: [{ name, description, inputSchema }]. Does not use quota. */
export async function listTools() {
  await connect();
  const tools = [];
  let cursor;
  do {
    const r = await rpc('tools/list', cursor ? { cursor } : {});
    tools.push(...(r?.tools || []));
    cursor = r?.nextCursor;
  } while (cursor);
  return tools;
}

/** Call one read-only tool. Returns parsed JSON when the tool returns JSON text, else the raw text. Uses 1 quota call. */
export async function callTool(name, args) {
  if (!READ_TOOLS.some(re => re.test(name))) throw new Error(`Helium 10 tool "${name}" is not on the scanner's read-only list`);
  await connect();
  const full = { context: 'Medaltus Brand Scanner audit of a prospect brand', ...args };
  if (gatewaySession) full.session_id = gatewaySession;
  const r = await rpc('tools/call', { name, arguments: full });
  let text = (r?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const meta = text.match(/\[gateway-meta\][^\n]*session_id=([^\s\]]+)/);
  if (meta) gatewaySession = meta[1];
  text = text.split('\n').filter(l => !l.trim().startsWith('[gateway-meta]')).join('\n').trim();
  if (r?.isError) throw new Error(`Helium 10 ${name}: ${text.slice(0, 300)}`);
  if (r?.structuredContent) return r.structuredContent;
  try { return JSON.parse(text); } catch { return text; }
}
