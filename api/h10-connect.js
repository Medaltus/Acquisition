/**
 * api/h10-connect.js
 *
 * Connects the scanner to Helium 10 (OAuth, one time). Open in a browser:
 *   /api/h10-connect?key=<CRON_SECRET, URL-encoded>
 * Registers the scanner with Helium 10 (first time only), then sends you to Helium 10 to approve.
 * Helium 10 returns to /api/h10-callback, which saves the tokens (encrypted) on the Settings tab.
 * The connection shows in Helium 10 under Settings > MCP > Authorized AI Clients Management,
 * where it can be revoked.
 */
import crypto from 'node:crypto';
import { isAuthorized } from './_lib/util.js';
import { baseUrl } from './_lib/inbound.js';
import { getSetting, setSetting } from './_lib/settings.js';
import { AUTH_BASE, MCP_URL } from './_lib/helium10.js';

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).send('Unauthorized');
  try {
    const redirectUri = `${baseUrl(req)}/api/h10-callback`;
    let client = await getSetting('helium10_client');
    if (!client?.client_id || client.redirect_uri !== redirectUri) {
      const r = await fetch(`${AUTH_BASE}/connect/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Medaltus Brand Scanner', redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
          token_endpoint_auth_method: 'none', scope: 'mcp:tools',
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.client_id) return res.status(502).send(`Helium 10 registration failed: ${JSON.stringify(data).slice(0, 300)}`);
      client = { client_id: data.client_id, redirect_uri: redirectUri };
      await setSetting('helium10_client', client);
    }
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(16));
    await setSetting('helium10_pending', { state, verifier, client_id: client.client_id, redirect_uri: redirectUri, at: Date.now() });
    const url = `${AUTH_BASE}/oauth2/authorize?${new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, scope: 'mcp:tools',
      state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256', resource: MCP_URL,
    })}`;
    res.writeHead(302, { Location: url });
    return res.end();
  } catch (e) {
    return res.status(500).send(`Could not start the Helium 10 connection: ${e.message}`);
  }
}
