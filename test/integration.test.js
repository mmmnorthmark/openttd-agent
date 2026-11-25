// End-to-end against the fake admin server: library API and the real CLI
// (with its auto-started daemon), using an isolated OPENTTD_AGENT_HOME.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startFakeServer } from './fake-server.js';

const run = promisify(execFile);
const BIN = path.resolve('bin/openttd-agent.js');
let fake, home, env;

before(async () => {
  fake = await startFakeServer({ password: 'pw' });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-agent-'));
  const daemonPort = 47000 + Math.floor(Math.random() * 900);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'pw', company: 0, daemon_port: daemonPort, tile_refresh_rows_per_sec: 0 }));
  env = { ...process.env, OPENTTD_AGENT_HOME: home, OPENTTD_AGENT_LOG: 'error' };
  process.env.OPENTTD_AGENT_HOME = home;
  process.env.OPENTTD_AGENT_LOG = 'error';
});

after(async () => {
  await run(process.execPath, [BIN, 'daemon-stop'], { env }).catch(() => {});
  fake.server.close();
});

const cli = async (...args) => JSON.parse((await run(process.execPath, [BIN, ...args], { env })).stdout);

test('library: connect, find wood pairs ranked by route effort', async () => {
  const { connect } = await import('../src/index.js');
  const game = await connect();
  try {
    const res = await game.run('find-cargo-pairs', { cargo: 'wood', min_distance: 10, max_distance: 200, max_transported_pct: 50 });
    assert.equal(res.total_candidates, 1, 'the 75%-served forest is excluded');
    assert.equal(res.pairs[0].source.id, 1);
    assert.equal(res.pairs[0].dest.type, 'Sawmill');
    assert.equal(res.pairs[0].route.reachable, true);
    assert.ok(res.map_complete);
    const gaps = await game.run('town-gaps', { min_population: 0 });
    assert.equal(gaps[0].name, 'Bigton');
  } finally { game.close(); }
});

test('CLI via daemon: status, chained calls, build uses configured company', async () => {
  const status = await cli('status');
  assert.equal(status.info.map_x, 64);
  assert.equal(status.my_company, 0);
  const effort = await cli('route-effort', '--x1', '10', '--y1', '20', '--x2', '50', '--y2', '20');
  assert.equal(effort.reachable, true);
  const built = await cli('build-road', '--x1', '1', '--y1', '1', '--x2', '5', '--y2', '1');
  assert.equal(built.ok, true);
  assert.equal(fake.received.at(-1).args.company, 0);
});

test('CLI reports bad arguments as JSON error with exit code 1', async () => {
  await assert.rejects(run(process.execPath, [BIN, 'route-effort', '--x1', 'abc'], { env }), (e) => {
    assert.equal(e.code, 1);
    assert.match(JSON.parse(e.stdout).error, /bad arguments/);
    return true;
  });
});

test('client-side rate limit blocks builds over max_builds_per_minute', async () => {
  const { makeContext } = await import('../src/context.js');
  const { runCommand } = await import('../src/commands.js');
  const ctx = makeContext();
  ctx.cfg.max_builds_per_minute = 1;
  try {
    await runCommand(ctx, 'build-road', { x1: 1, y1: 1, x2: 2, y2: 1 });
    await assert.rejects(runCommand(ctx, 'build-road', { x1: 1, y1: 1, x2: 2, y2: 1 }), /client rate limit/);
  } finally { ctx.close(); }
});
