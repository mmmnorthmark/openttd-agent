// Player side of the relay: send one command to the host's relay over HTTP.
// The token travels in clear text (plain HTTP); meant for a home LAN only.

import { postJson, callTimeoutMs } from './http-json.js';

const clean = (url) => String(url).replace(/\/+$/, '');

export async function callRelay(cfg, name, args = {}, { timeoutMs = callTimeoutMs() } = {}) {
  if (!cfg.relay_token) throw new Error('relay is set but relay_token is not. Run: openttd-agent configure --relay <url> --token <token from the host>, or run: openttd-agent guide');
  let res;
  try {
    res = await postJson(`${clean(cfg.relay)}/call`, { name, args }, { headers: { authorization: `Bearer ${cfg.relay_token}` }, timeoutMs });
  } catch (e) {
    if (e.code === 'timeout') throw new Error(`relay_timeout: no reply from the relay at ${cfg.relay} within ${Math.round(timeoutMs / 1000)} s for ${name}; it may still be running there. Set OPENTTD_AGENT_CALL_TIMEOUT_S for longer calls`);
    throw new Error(`cannot reach the relay at ${cfg.relay} (${e.code ?? e.message}). Is 'openttd-agent relay' running on the host, and is the address right? Then run: openttd-agent guide`);
  }
  const body = res.json;
  if (!body) throw new Error(`relay at ${cfg.relay} sent a non-JSON reply (HTTP ${res.status}); is that address an openttd-agent relay?`);
  if (!body.ok) throw new Error(body.error ?? `relay error (HTTP ${res.status})`);
  return body.result;
}

export async function relayHealth(cfg) {
  try {
    const res = await fetch(`${clean(cfg.relay)}/health`, { signal: AbortSignal.timeout(3000) });
    return await res.json();
  } catch (e) {
    return { ok: false, error: `cannot reach the relay at ${cfg.relay} (${e.cause?.code ?? e.message}). run: openttd-agent guide` };
  }
}
