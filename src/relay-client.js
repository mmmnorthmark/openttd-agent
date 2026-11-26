// Player side of the relay: send one command to the host's relay over HTTP.
// The token travels in clear text (plain HTTP); meant for a home LAN only.

const clean = (url) => String(url).replace(/\/+$/, '');

export async function callRelay(cfg, name, args = {}, { timeoutMs = 10 * 60_000 } = {}) {
  if (!cfg.relay_token) throw new Error('relay is set but relay_token is not. Run: openttd-agent configure --relay <url> --token <token from the host>');
  let res;
  try {
    res = await fetch(`${clean(cfg.relay)}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.relay_token}` },
      body: JSON.stringify({ name, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`cannot reach the relay at ${cfg.relay} (${e.cause?.code ?? e.message}). Is 'openttd-agent relay' running on the host, and is the address right? Then run: openttd-agent guide`);
  }
  let body;
  try { body = await res.json(); } catch { throw new Error(`relay at ${cfg.relay} sent a non-JSON reply (HTTP ${res.status}); is that address an openttd-agent relay?`); }
  if (!body.ok) throw new Error(body.error ?? `relay error (HTTP ${res.status})`);
  return body.result;
}

export async function relayHealth(cfg) {
  try {
    const res = await fetch(`${clean(cfg.relay)}/health`, { signal: AbortSignal.timeout(3000) });
    return await res.json();
  } catch (e) {
    return { ok: false, error: `cannot reach the relay at ${cfg.relay} (${e.cause?.code ?? e.message})` };
  }
}
