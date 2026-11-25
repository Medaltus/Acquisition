/**
 * api/h10-callback.js
 *
 * Helium 10 sends the browser back here after you approve the scanner (started by /api/h10-connect).
 * Exchanges the one-time code for tokens and saves them (encrypted) on the Settings tab.
 */
import { getSetting, setSetting } from './_lib/settings.js';
import { AUTH_BASE, MCP_URL, TOKEN_KEY } from './_lib/helium10.js';

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;color:#1a1a1a">
<h2>${title}</h2><p>${body}</p></body>`;

export default async function handler(req, res) {
  const send = (status, title, body) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.status(status).send(page(title, body)); };
  const { code, state, error, error_description: desc } = req.query || {};
  if (error) return send(400, 'Helium 10 was not connected', `Helium 10 said: ${String(desc || error)}`);
  try {
    const pending = await getSetting('helium10_pending');
    if (!pending || !state || pending.state !== state || Date.now() - pending.at > 15 * 60000) {
      return send(400, 'This link has expired', 'Start again from /api/h10-connect.');
    }
    const r = await fetch(`${AUTH_BASE}/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: String(code || ''), redirect_uri: pending.redirect_uri,
        client_id: pending.client_id, code_verifier: pending.verifier, resource: MCP_URL,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) return send(502, 'Helium 10 was not connected', `Token exchange failed: ${String(data.error_description || data.error || r.status)}`);
    await setSetting(TOKEN_KEY, {
      client_id: pending.client_id, access_token: data.access_token, refresh_token: data.refresh_token || '',
      expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000, connected_at: new Date().toISOString(),
    });
    await setSetting('helium10_pending', {});
    return send(200, 'Helium 10 is connected', `The Brand Scanner can now read Cerebro data.${data.refresh_token ? '' : ' Note: Helium 10 did not send a refresh token, so this connection will need reconnecting when it expires.'} You can close this tab.`);
  } catch (e) {
    return send(500, 'Helium 10 was not connected', e.message);
  }
}
