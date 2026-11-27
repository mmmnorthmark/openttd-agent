// POST JSON over node:http (daemon and relay calls). Not fetch: undici's fetch gives up on a reply
// whose headers take over 5 minutes (headersTimeout), and a long turn-advance or build takes that.
// One overall timeout instead: OPENTTD_AGENT_CALL_TIMEOUT_S (default 3600 s).

import http from 'node:http';
import https from 'node:https';

export const callTimeoutMs = (env = process.env) => {
  const s = Number(env.OPENTTD_AGENT_CALL_TIMEOUT_S);
  return Number.isFinite(s) && s > 0 ? s * 1000 : 3600_000;
};

/** Error with `.code` = 'timeout' | the socket error code (ECONNREFUSED, ...), and `.cause`. */
function httpError(message, code, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause) e.cause = cause;
  return e;
}

/**
 * POST `body` as JSON to `url`; resolves { status, json } (json null when the reply is not JSON,
 * then `text` holds it). Rejects with .code 'timeout' after `timeoutMs`, or the socket error code.
 */
export function postJson(url, body, { headers = {}, timeoutMs = callTimeoutMs() } = {}) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON: the caller says so */ }
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', (e) => { clearTimeout(timer); reject(httpError(e.message, e.code ?? 'failed', e)); });
    });
    const timer = setTimeout(() => req.destroy(httpError(`no reply within ${Math.round(timeoutMs / 1000)} s`, 'timeout')), timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e.code === 'timeout' ? e : httpError(e.message, e.code ?? 'failed', e)); });
    req.end(payload);
  });
}
