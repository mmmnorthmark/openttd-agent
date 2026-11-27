// Local daemon: keeps one admin connection, the world mirror and the background jobs warm so CLI
// and MCP calls are fast and can be chained. Listens on 127.0.0.1 only.
// API: GET /health -> { ok, service, pid, version, code_id, config_hash }
//      POST /call {name, args, opts: {readOnly}} -> {ok: true, result} | {ok: false, error}
//      (result: the full enveloped result; the caller shapes it, see src/dispatch.js)
//
// Stale code (D1): code_id hashes the mtimes and sizes of src/, bin/ and gamescript/ when the daemon
// starts; a caller whose code_id differs restarts it. Caller env (P11): config_hash covers the
// settings that change what a call does (host, port, password, company, relay, throttle); a caller
// whose hash differs runs in its own process instead (see dispatch.js).

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeContext } from './context.js';
import { executeCommand } from './commands.js';
import { loadConfig } from './config.js';
import { postJson, callTimeoutMs } from './http-json.js';
import { log } from './log.js';
import { VERSION } from './version.js';

const VERSION_CHECK = 'openttd-agent-daemon';
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_DIRS = ['src', 'bin', 'gamescript'];

/** Hash of path, size and mtime of every file under src/, bin/ and gamescript/ of `root`. */
export function codeId(root = PACKAGE_ROOT) {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        h.update(`${path.relative(root, p)}:${st.size}:${st.mtimeMs}\n`);
      }
    }
  };
  for (const d of CODE_DIRS) walk(path.join(root, d));
  return h.digest('hex').slice(0, 16);
}

const CONFIG_KEYS = ['host', 'admin_port', 'admin_password', 'company', 'relay', 'relay_token', 'max_builds_per_minute', 'tile_refresh_rows_per_sec'];

/** Hash of the settings that change what a call does. Never the settings themselves (a password is one). */
export function configHash(cfg) {
  return crypto.createHash('sha256').update(JSON.stringify(CONFIG_KEYS.map((k) => cfg[k] ?? null))).digest('hex').slice(0, 16);
}

export function startDaemon({ port = loadConfig().daemon_port } = {}) {
  const ctx = makeContext();
  const myCode = codeId();
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') {
      return reply(200, { ok: true, service: VERSION_CHECK, pid: process.pid, version: VERSION, code_id: myCode, config_hash: configHash(loadConfig()) });
    }
    if (req.method === 'POST' && req.url === '/shutdown') { reply(200, { ok: true }); ctx.close(); server.close(); setTimeout(() => process.exit(0), 50); return; }
    if (req.method !== 'POST' || req.url !== '/call') return reply(404, { ok: false, error: 'not found' });
    let body = '';
    for await (const chunk of req) body += chunk;
    const started = Date.now();
    let name;
    try {
      const parsed = JSON.parse(body || '{}');
      name = parsed.name;
      ctx.refreshConfig();
      const result = await executeCommand(ctx, name, parsed.args ?? {}, { readOnly: parsed.opts?.readOnly === true });
      log.info('daemon', 'call', { name, ms: Date.now() - started });
      reply(200, { ok: true, result });
    } catch (e) {
      log.warn('daemon', 'call failed', { name, ms: Date.now() - started, error: e.message });
      reply(200, { ok: false, error: e.message });
    }
  });
  // Long calls (turn-advance, big builds) must not be cut by node's 5-minute request timeout (D3).
  server.requestTimeout = 0;
  server.listen(port, '127.0.0.1', () => log.info('daemon', 'listening', { port, pid: process.pid, code_id: myCode }));
  return server;
}

const base = (port) => `http://127.0.0.1:${port}`;

/** Health of the daemon on `port`: { version, pid, code_id, config_hash } (fields null on older daemons), else null. */
export async function daemonHealth(port) {
  try {
    const r = await fetch(`${base(port)}/health`, { signal: AbortSignal.timeout(1000) });
    const j = await r.json();
    return j.service === VERSION_CHECK ? { version: j.version ?? null, pid: j.pid, code_id: j.code_id ?? null, config_hash: j.config_hash ?? null } : null;
  } catch { return null; }
}

export async function daemonHealthy(port) { return (await daemonHealth(port)) !== null; }

async function waitGone(port) {
  for (let i = 0; i < 25 && (await daemonHealthy(port)); i++) await new Promise((r) => setTimeout(r, 100));
}

/**
 * Make sure a daemon running this code with this config answers on `port`. Returns
 * { usable: true } or { usable: false, reason } when a daemon with other settings (another
 * caller's env) runs there: it is left alone (its background jobs are someone's), and the
 * caller runs the command itself. A daemon of another version or code is restarted.
 */
export async function ensureDaemon(port, cfg = loadConfig()) {
  const h = await daemonHealth(port);
  if (h) {
    if (h.config_hash && h.config_hash !== configHash(cfg)) return { usable: false, reason: 'config_mismatch' };
    if (h.version === VERSION && h.code_id === codeId()) return { usable: true };
    // A daemon keeps the code it started with: after an update or an edit it would answer with old behaviour.
    log.info('daemon', 'restarting a daemon running other code', { running: h.version, code: h.code_id, now: VERSION });
    await stopDaemon(port);
    await waitGone(port);
  }
  const bin = path.join(PACKAGE_ROOT, 'bin', 'openttd-agent.js');
  const child = spawn(process.execPath, [bin, 'daemon'], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await daemonHealthy(port)) return { usable: true };
  }
  throw new Error(`daemon_failed: daemon did not start on 127.0.0.1:${port}; try: openttd-agent daemon (foreground) to see errors, or --no-daemon`);
}

/** Restart the daemon on `port` (stop, then start with this code). */
export async function restartDaemon(port, cfg) {
  await stopDaemon(port);
  await waitGone(port);
  return ensureDaemon(port, cfg);
}

/** One call to the daemon: the full enveloped result. Throws its error text, or daemon_timeout / daemon_failed. */
export async function callDaemon(port, name, args, opts = {}) {
  const timeoutMs = callTimeoutMs();
  let r;
  try {
    r = await postJson(`${base(port)}/call`, { name, args, opts }, { timeoutMs });
  } catch (e) {
    if (e.code === 'timeout') {
      throw new Error(`daemon_timeout: no reply from the background daemon within ${Math.round(timeoutMs / 1000)} s for ${name}; it may still be running there (check status). Set OPENTTD_AGENT_CALL_TIMEOUT_S for longer calls`);
    }
    throw new Error(`daemon_failed: the background daemon on 127.0.0.1:${port} did not answer ${name} (${e.code ?? e.message}); run: openttd-agent daemon-stop, then try again`);
  }
  if (!r.json) throw new Error(`daemon_failed: the background daemon sent a non-JSON reply (HTTP ${r.status})`);
  if (!r.json.ok) throw new Error(r.json.error);
  return r.json.result;
}

export async function stopDaemon(port) {
  if (!(await daemonHealthy(port))) return { running: false };
  await fetch(`${base(port)}/shutdown`, { method: 'POST' }).catch(() => {});
  return { stopped: true };
}
