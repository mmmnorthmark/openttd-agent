// guide probes against the fake admin server, in-process, with an isolated home
// (own daemon and relay ports, so nothing on this machine is touched).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServer } from './fake-server.js';

let fake, ctx, runCommand;

before(async () => {
  fake = await startFakeServer({ password: 'secret-pw' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-agent-guide-'));
  const port = 46000 + Math.floor(Math.random() * 900);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'secret-pw', daemon_port: port, relay_port: port + 1, tile_refresh_rows_per_sec: 0 }));
  process.env.OPENTTD_AGENT_HOME = home;
  process.env.OPENTTD_AGENT_LOG = 'error';
  ({ runCommand } = await import('../src/commands.js'));
  ctx = (await import('../src/context.js')).makeContext();
});

after(() => { ctx.close(); fake.server.close(); });

test('guide (host, inferred) sees the running game, the missing relay and no players; no secrets', async () => {
  const g = await runCommand(ctx, 'guide', {});
  assert.equal(g.role, 'host');
  const done = Object.fromEntries(g.steps.map((s) => [s.id, s.done]));
  assert.equal(done.launch, true);
  assert.equal(done.relay, false);
  assert.equal(done['relay-add-player'], false);
  assert.equal(g.next.id === 'relay' || g.next.id === 'doctor' || g.next.id === 'install-gamescript', true);
  assert.doesNotMatch(JSON.stringify(g), /secret-pw/);
  assert.equal(fake.state.rcons.length, 0, 'guide sends no console commands');
});

test('guide (player) with an unreachable relay says so and stops there', async () => {
  const g = await runCommand({ ...ctx, cfg: { ...ctx.cfg, relay: 'http://127.0.0.1:9', relay_token: 'tok-secret' } }, 'guide', { role: 'player' });
  assert.equal(g.role, 'player');
  const relay = g.steps.find((s) => s.id === 'relay');
  assert.equal(relay.done, false);
  assert.doesNotMatch(JSON.stringify(g), /tok-secret/);
});
