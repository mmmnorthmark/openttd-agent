// Local daemon: keeps one admin connection and the world mirror warm so CLI
// calls are fast and can be chained. Listens on 127.0.0.1 only.
// API: GET /health; POST /call {name, args} -> {ok: true, result} | {ok: false, error}

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeContext } from './context.js';
import { runCommand } from './commands.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { VERSION } from './version.js';

const VERSION_CHECK = 'openttd-agent-daemon';

export function startDaemon({ port = loadConfig().daemon_port } = {}) {
  const ctx = makeContext();
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, service: VERSION_CHECK, pid: process.pid, version: VERSION });
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
      const result = await runCommand(ctx, name, parsed.args ?? {});
      log.info('daemon', 'call', { name, ms: Date.now() - started });
      reply(200, { ok: true, result });
    } catch (e) {
      log.warn('daemon', 'call failed', { name, ms: Date.now() - started, error: e.message });
      reply(200, { ok: false, error: e.message });
    }
  });
  server.listen(port, '127.0.0.1', () => log.info('daemon', 'listening', { port, pid: process.pid }));
  return server;
}

const base = (port) => `http://127.0.0.1:${port}`;

/** Health of the daemon on `port`: { version } (null for a daemon older than 0.7.0) when one answers, else null. */
export async function daemonHealth(port) {
  try {
    const r = await fetch(`${base(port)}/health`, { signal: AbortSignal.timeout(1000) });
    const j = await r.json();
    return j.service === VERSION_CHECK ? { version: j.version ?? null, pid: j.pid } : null;
  } catch { return null; }
}

export async function daemonHealthy(port) { return (await daemonHealth(port)) !== null; }

export async function ensureDaemon(port) {
  const h = await daemonHealth(port);
  if (h && h.version === VERSION) return;
  if (h) {
    // A daemon keeps the code it started with: after an update it would answer with old behaviour.
    log.info('daemon', 'restarting a daemon of another version', { running: h.version, now: VERSION });
    await stopDaemon(port);
    for (let i = 0; i < 25 && (await daemonHealthy(port)); i++) await new Promise((r) => setTimeout(r, 100));
  }
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'openttd-agent.js');
  const child = spawn(process.execPath, [bin, 'daemon'], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await daemonHealthy(port)) return;
  }
  throw new Error(`daemon did not start on 127.0.0.1:${port}; try: openttd-agent daemon (foreground) to see errors`);
}

export async function callDaemon(port, name, args) {
  const r = await fetch(`${base(port)}/call`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}

export async function stopDaemon(port) {
  if (!(await daemonHealthy(port))) return { running: false };
  await fetch(`${base(port)}/shutdown`, { method: 'POST' }).catch(() => {});
  return { stopped: true };
}
