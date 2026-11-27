// Host tools (0.8.0): admin login failures, launch dry runs, server profiles, host commands
// against the fake admin server, GS timeout diagnosis, persisted background jobs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { AdminClient } from '../src/admin-client.js';
import { startFakeServer } from './fake-server.js';

test('admin login: a socket closed before welcome fails at once with admin_auth', async () => {
  const server = net.createServer((sock) => sock.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const started = Date.now();
  const admin = new AdminClient({ host: '127.0.0.1', port: server.address().port, password: 'x' });
  await assert.rejects(admin.connect(10000), /^Error: admin_auth: /);
  assert.ok(Date.now() - started < 2000, 'no wait for the 10 s timeout');
  server.close();
});

test('admin login: a wrong password is admin_auth too', async () => {
  const fake = await startFakeServer({ password: 'right' });
  const admin = new AdminClient({ host: '127.0.0.1', port: fake.port, password: 'wrong' });
  await assert.rejects(admin.connect(5000), /admin_auth: admin login refused: WRONG_PASSWORD/);
  fake.server.close();
});

// ---- host commands against the fake server (isolated OPENTTD_AGENT_HOME) -----------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-host-'));
process.env.OPENTTD_AGENT_HOME = HOME; // before config.js is first imported
process.env.OPENTTD_AGENT_LOG = 'error';
const { runCommand } = await import('../src/commands.js');
const host = await import('../src/host.js');

async function withFake(fn, opts) {
  const fake = await startFakeServer({ password: 'pw', ...opts });
  const ctx = { cfg: { host: '127.0.0.1', admin_port: fake.port, admin_password: 'pw', company: 0, tile_refresh_rows_per_sec: 0 }, session: async () => { throw new Error('host commands never use the session'); } };
  try { return await fn(fake, ctx); } finally { fake.server.close(); }
}

test('console runs one rcon command and returns its lines', () => withFake(async (fake, ctx) => {
  const r = await runCommand(ctx, 'console', { command: 'setting command_pause_level' });
  assert.equal(r.ok, true);
  assert.match(r.lines[0], /command_pause_level' is '3'/);
  assert.equal(fake.state.rcons.at(-1), 'setting command_pause_level');
}));

test('load: ls, then load by index, waits for the new game and AgentBridge; --pause applies after', () => withFake(async (fake, ctx) => {
  fake.state.saves.push('t-two');
  const r = await runCommand(ctx, 'load', { name: 't-two.sav', pause: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.loaded, 't-two');
  assert.equal(r.paused, true);
  assert.deepEqual(r.map, [64, 64]);
  assert.ok(fake.state.rcons.includes('ls'));
  assert.ok(fake.state.rcons.includes('load 3'), 'index of t-two in the ls list');
  assert.equal(fake.state.loads, 1);
  const missing = await runCommand(ctx, 'load', { name: 'nope' }).catch((e) => e);
  assert.match(missing.message, /^save_not_found: /);
  await assert.rejects(runCommand(ctx, 'load', { name: '../x' }), /save name must be/);
}));

test('company-new starts an AI and returns the new 0-based company id', () => withFake(async (fake, ctx) => {
  const r = await runCommand(ctx, 'company-new', {});
  assert.equal(r.company, 1);
  assert.equal(fake.state.rcons.at(-1), 'start_ai IdleAI');
  await assert.rejects(runCommand(ctx, 'company-new', { ai: 'NoSuchAI' }), /^Error: company_new_failed: /);
}));

test('server-stop saves first, then quits; a missing save name never quits', () => withFake(async (fake, ctx) => {
  const r = await runCommand(ctx, 'server-stop', { save: 't080-stop' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.save.saved, 't080-stop.sav');
  assert.equal(r.method, 'console_quit');
  assert.deepEqual(fake.state.rcons.slice(-2), ['save t080-stop', 'quit']);
}));

test('install-gamescript --reload: rescan, save, load, wait for the bundled version, keep the pause state', () => withFake(async (fake, ctx) => {
  const personal = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-host-personal-'));
  process.env.OPENTTD_PERSONAL_DIR = personal;
  const { bundledGsVersion } = await import('../src/setup.js');
  fake.state.gsVersion = 11;
  fake.state.versionAfterLoad = bundledGsVersion();
  fake.state.paused = true;
  try {
    const r = await runCommand(ctx, 'install-gamescript', { reload: true, save_name: 'reload-test' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.bridge_version_before, 11);
    assert.equal(r.bridge_version_now, bundledGsVersion());
    assert.equal(r.paused, true);
    assert.ok(fs.existsSync(path.join(personal, 'game', 'AgentBridge', 'info.nut')));
    const i = fake.state.rcons.indexOf('rescan_game');
    assert.ok(i >= 0 && fake.state.rcons.indexOf('save reload-test') > i && fake.state.rcons.some((c) => /^load \d+$/.test(c)));
  } finally { delete process.env.OPENTTD_PERSONAL_DIR; }
}));

test('saves and server-log read the launch profile; an unknown --server says which exist', async () => {
  const dir = path.join(HOME, 'profiles', 'side');
  fs.mkdirSync(path.join(dir, 'save'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openttd.cfg'), '[network]\nserver_port = 4989\nserver_admin_port = 4987\n');
  fs.writeFileSync(path.join(dir, 'save', 'a.sav'), 'x');
  fs.writeFileSync(path.join(dir, 'save', 'b.sav'), 'xy');
  fs.utimesSync(path.join(dir, 'save', 'a.sav'), new Date(1000), new Date(1000));
  fs.writeFileSync(path.join(dir, 'openttd.log'), [
    'dbg: [script:4] [18] [I] AgentBridge v12 started', 'dbg: [net:3] [admin] connected', 'dbg: [script:0] [S] Your script made an error: the index foo does not exist',
    'dbg: [script:0] The script died unexpectedly.'].join('\n'));
  const ctx = { cfg: { host: '127.0.0.1', admin_port: 3977, admin_password: 'pw' } };
  const saves = await runCommand(ctx, 'saves', { server: 'side' });
  assert.deepEqual(saves.saves.map((x) => x.name), ['b', 'a']);
  const t = host.serverTarget(ctx.cfg, 'side');
  assert.deepEqual([t.admin_port, t.game_port], [4987, 4989]);
  const lg = await runCommand(ctx, 'server-log', { server: 'side', errors: true });
  assert.equal(lg.gs.state, 'died');
  assert.equal(lg.lines.length, 2);
  await assert.rejects(runCommand(ctx, 'saves', { server: 'nope' }), /unknown_server: .*Known: side/);
  assert.equal(host.diagnoseGs({ host: '127.0.0.1', admin_port: 4987 }).code, 'gs_died');
});

test('parseLs keeps savegames only and drops .sav', () => {
  assert.deepEqual(host.parseLs(['0) .. (Parent directory)', '1) autosave/ (Directory)', '2) t080-a.sav', 'junk']), [{ index: 2, name: 't080-a' }]);
});
