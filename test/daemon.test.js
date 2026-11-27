// Daemon and dispatch (0.8.0): code_id restarts stale daemons (D1), config_hash keeps another
// caller's daemon out of it (P11), "unknown command" from an old daemon restarts it once, long
// calls time out with daemon_timeout (D3), one-shot processes warn about background jobs (P12),
// CLI exit codes and batch lines (P8, P9).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startFakeServer } from './fake-server.js';

const execFileP = promisify(execFile);
const BIN = path.resolve('bin/openttd-agent.js');
let fake, home, env, daemonPort, daemon, dispatch, VERSION;

before(async () => {
  fake = await startFakeServer({ password: 'pw' });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-agent-daemon-'));
  daemonPort = 46000 + Math.floor(Math.random() * 900);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'pw', company: 0, daemon_port: daemonPort, tile_refresh_rows_per_sec: 0 }));
  env = { ...process.env, OPENTTD_AGENT_HOME: home, OPENTTD_AGENT_LOG: 'error' };
  process.env.OPENTTD_AGENT_HOME = home;
  process.env.OPENTTD_AGENT_LOG = 'error';
  daemon = await import('../src/daemon.js');
  ({ dispatch } = await import('../src/dispatch.js'));
  ({ VERSION } = await import('../src/version.js'));
});

after(async () => {
  await daemon.stopDaemon(daemonPort);
  fake.server.close();
});

/** Run the CLI; resolves { code, json } (json of the last stdout line). */
async function cli(args, { extraEnv = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env: { ...env, ...extraEnv } }, (err, stdout) => {
      const lines = stdout.trim().split('\n');
      let json;
      try { json = JSON.parse(stdout); } catch { json = JSON.parse(lines.at(-1) || 'null'); } // batch: the last line
      resolve({ code: err ? err.code : 0, lines, json });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

test('codeId changes when a source file changes; configHash covers company and password', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-agent-code-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x');
  const before = daemon.codeId(root);
  assert.equal(daemon.codeId(root), before, 'stable');
  fs.utimesSync(path.join(root, 'src', 'a.js'), new Date(), new Date(Date.now() + 5000));
  assert.notEqual(daemon.codeId(root), before);
  const cfg = { host: 'h', admin_port: 1, admin_password: 'p', company: 0 };
  assert.notEqual(daemon.configHash(cfg), daemon.configHash({ ...cfg, company: 1 }));
  assert.notEqual(daemon.configHash(cfg), daemon.configHash({ ...cfg, admin_password: 'q' }));
  assert.ok(!daemon.configHash(cfg).includes('p'.repeat(2)));
});

test('a daemon running other code is restarted; one that answers unknown command is restarted and retried', async () => {
  const { configHash, codeId, daemonHealth } = daemon;
  const { loadConfig } = await import('../src/config.js');
  // An impostor "old daemon": right version and config, but other code, and it does not know `status`.
  let shutdowns = 0;
  const old = http.createServer((req, res) => {
    const send = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/health') return send({ ok: true, service: 'openttd-agent-daemon', pid: 1, version: VERSION, code_id: 'stale', config_hash: configHash(loadConfig()) });
    if (req.url === '/shutdown') { shutdowns++; send({ ok: true }); old.close(); old.closeAllConnections(); return; }
    return send({ ok: false, error: "unknown_command: unknown command 'status'. Run: openttd-agent help" });
  });
  await new Promise((r) => old.listen(daemonPort, '127.0.0.1', r));
  const { result } = await dispatch('status', {}, {});
  assert.equal(shutdowns, 1, 'the stale daemon was stopped');
  assert.equal(result.ok, true);
  const h = await daemonHealth(daemonPort);
  assert.equal(h.code_id, codeId(), 'a fresh daemon runs this code');

  // Same code but it says unknown command (code_id cannot see everything): restart once, retry.
  await daemon.stopDaemon(daemonPort);
  for (let i = 0; i < 25 && (await daemon.daemonHealthy(daemonPort)); i++) await new Promise((r) => setTimeout(r, 100));
  let calls = 0;
  const confused = http.createServer((req, res) => {
    const send = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/health') return send({ ok: true, service: 'openttd-agent-daemon', pid: 1, version: VERSION, code_id: codeId(), config_hash: configHash(loadConfig()) });
    if (req.url === '/shutdown') { send({ ok: true }); confused.close(); confused.closeAllConnections(); return; }
    calls++;
    return send({ ok: false, error: "unknown_command: unknown command 'status'. Run: openttd-agent help" });
  });
  await new Promise((r) => confused.listen(daemonPort, '127.0.0.1', r));
  const again = await dispatch('status', {}, {});
  assert.equal(calls, 1);
  assert.equal(again.result.ok, true);
});

test('a daemon with other settings is left alone; the call runs in this process with a warning', async () => {
  const pid = (await daemon.daemonHealth(daemonPort))?.pid;
  const r = await cli(['vehicles'], { extraEnv: { OPENTTD_AGENT_COMPANY: '1' } });
  assert.equal(r.code, 0);
  assert.match(r.json.warnings.join(' '), /daemon_config_mismatch/);
  assert.equal(fake.received.filter((q) => q.cmd === 'vehicles').at(-1).args.company, 1, 'the caller\'s company was used');
  assert.equal((await daemon.daemonHealth(daemonPort))?.pid, pid, 'the daemon was not restarted');
});

test('a one-shot process warns that a background job does not survive it', async () => {
  const r = await cli(['save', '--every_months', '1', '--no-daemon']);
  assert.equal(r.json.ok, true);
  assert.match(r.json.warnings.join(' '), /background_job_not_kept: a periodic save/);
  const viaDaemon = await cli(['save']);
  assert.equal(viaDaemon.json.warnings, undefined);
});

test('daemon_timeout: a call with no reply within OPENTTD_AGENT_CALL_TIMEOUT_S', async () => {
  const silent = http.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  process.env.OPENTTD_AGENT_CALL_TIMEOUT_S = '0.3';
  try {
    await assert.rejects(daemon.callDaemon(silent.address().port, 'status', {}), /^Error: daemon_timeout: no reply .* within 0 s for status/);
  } finally {
    delete process.env.OPENTTD_AGENT_CALL_TIMEOUT_S;
    silent.closeAllConnections();
    silent.close();
  }
});

test('CLI: ok:false exits 1; batch lines carry the name, failures count, --no-daemon works', async () => {
  const failed = await cli(['vehicle-sell', '--vehicles', '404', '--no-daemon']);
  assert.equal(failed.json.ok, false);
  assert.equal(failed.code, 1, 'a failed result exits 1');
  const input = [
    JSON.stringify({ name: 'towns', args: { fields: 'name' } }),
    JSON.stringify({ name: 'towns', args: { bogus: 1 } }),
    JSON.stringify({ name: 'vehicle-sell', args: { vehicles: '404' } }),
    JSON.stringify({ name: 'nope' }),
  ].join('\n') + '\n';
  const b = await cli(['batch', '--no-daemon'], { input });
  assert.equal(b.code, 1);
  const lines = b.lines.map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.name, l.result.ok]), [['towns', true], ['towns', false], ['vehicle-sell', false], ['nope', false]]);
  assert.deepEqual(Object.keys(lines[0].result.towns[0]), ['name'], 'output args work in batch');
  assert.equal(lines[1].result.first_error, 'unknown_argument');
  assert.equal(lines[3].result.first_error, 'unknown_command');
});

test('CLI: compact when piped, --compact false indents; bare words join the previous value', async () => {
  const piped = await cli(['show-config']);
  assert.equal(piped.lines.length, 1, 'one line when stdout is not a terminal');
  const indented = await cli(['show-config', '--compact', 'false']);
  assert.ok(indented.lines.length > 1);
  const r = await cli(['chat', '--message', 'hello', 'all', 'players', '--no-daemon']);
  assert.equal(r.json.ok, true);
  assert.match(fake.chats.at(-1), /hello all players/);
  const bad = await cli(['towns', 'stray', '--no-daemon']);
  assert.equal(bad.json.first_error, 'bad_arguments', 'a bare word with no flag before it is still refused');
});
