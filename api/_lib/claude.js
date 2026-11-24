/**
 * api/_lib/claude.js
 *
 * Env: ANTHROPIC_API_KEY, optional ANTHROPIC_MODEL
 */
const DEFAULT_MODEL = 'claude-sonnet-5-5';

async function callOnce(body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': (process.env.ANTHROPIC_API_KEY || '').trim(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(170000),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Ask Claude; optionally with web search. Returns the concatenated text of the final answer. */
export async function askClaude({ system, prompt, useSearch = false, maxSearches = 6, maxTokens = 8000 }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY env var');
  const base = {
    model: (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim(),
    max_tokens: maxTokens,
    system,
  };
  if (useSearch) base.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }];

  let messages = [{ role: 'user', content: prompt }];
  let data;
  for (let turn = 0; turn < 4; turn++) {
    data = await callOnce({ ...base, messages });
    if (data.stop_reason !== 'pause_turn') break;       // long searches can pause; resume them
    messages = [...messages, { role: 'assistant', content: data.content }];
  }
  // Text blocks may be split around citations, so join without separators.
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

/** Pull JSON out of a model reply (handles ```json fences and stray prose). */
export function parseJson(text) {
  const attempts = [];
  const fences = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  attempts.push(...fences.reverse(), String(text).trim());
  const firstOpen = String(text).search(/[\[{]/);
  const lastClose = Math.max(String(text).lastIndexOf(']'), String(text).lastIndexOf('}'));
  if (firstOpen >= 0 && lastClose > firstOpen) attempts.push(String(text).slice(firstOpen, lastClose + 1));
  for (const a of attempts) { try { return JSON.parse(a); } catch { /* next */ } }
  return null;
}
