// Argument contract (0.8.0) in runCommand: error codes, strict numbers, null keys, repairs
// (number <-> string, clamping), ignored flags, read-only mode. In-process against the fake server.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServer } from './fake-server.js';

let fake, ctx, runCommand, COMMANDS;
const run = (name, args, opts) => runCommand(ctx, name, args, opts);
const lastExec = () => fake.received.filter((r) => r.cmd === 'exec').at(-1).args;
const execCount = () => fake.received.filter((r) => r.cmd === 'exec').length;

before(async () => {
  fake = await startFakeServer({ password: 'pw' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-agent-args-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'pw', company: 0, tile_refresh_rows_per_sec: 0 }));
  process.env.OPENTTD_AGENT_HOME = home;
  process.env.OPENTTD_AGENT_LOG = 'error';
  ({ runCommand, COMMANDS } = await import('../src/commands.js'));
  ctx = (await import('../src/context.js')).makeContext();
});

after(() => { ctx.close(); fake.server.close(); });

test('error codes: unknown_command, unknown_argument, bad_arguments with "required"', async () => {
  await assert.rejects(run('no-such', {}), /^Error: unknown_command: unknown command 'no-such'/);
  await assert.rejects(run('route-effort', { x1: 1, y1: 1, x2: 2, y2: 2, help: true }), /^Error: unknown_argument: unknown argument for route-effort: --help/);
  await assert.rejects(run('route-effort', { x1: 1, y1: 1, x2: 2 }), /^Error: bad_arguments: bad arguments for route-effort: --y2: required$/);
  await assert.rejects(run('route-effort', { x1: 'abc', y1: 1, x2: 2, y2: 2 }), /--x1: .*expected number.*\(got "abc"\)/);
});

test('strict numbers: null keys are dropped, "" is not given, false and [] are refused (never company 0)', async () => {
  const r = await run('vehicles', { company: null, limit: '' });
  assert.equal(r.ok, true);
  await assert.rejects(run('vehicles', { company: false }), /bad_arguments: .*--company/);
  await assert.rejects(run('vehicles', { company: [] }), /bad_arguments: .*--company/);
  await assert.rejects(run('route-effort', { x1: '', y1: 1, x2: 2, y2: 2 }), /--x1: required/);
  assert.equal((await run('route-effort', { x1: ' 10 ', y1: '20', x2: 50, y2: 20 })).ok, true, 'numeric strings still work (CLI flags are text)');
});

test('a JSON number for a text argument is its text (P4)', async () => {
  const r = await run('towns', { name: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.matched, 0);
});

test('L13: reads and dry runs clamp out-of-range numbers; a real build refuses them', async () => {
  const r = await run('vehicles', { limit: 0 });
  assert.deepEqual(r.clamped, { limit: { from: 0, to: 1 } });
  const dry = await run('vehicle-buy', { depot_x: 5, depot_y: 5, engine: 1, count: 99, dry_run: true });
  assert.deepEqual(dry.clamped, { count: { from: 99, to: 50 } });
  const before = execCount();
  await assert.rejects(run('vehicle-buy', { depot_x: 5, depot_y: 5, engine: 1, count: 99 }), /bad_arguments: .*--count: Too big/);
  assert.equal(execCount(), before, 'nothing sent');
});

test('L13: read commands ignore --dry_run and --list; vehicle-depot ignores --depot auto', async () => {
  const r = await run('towns', { dry_run: true, list: true });
  assert.deepEqual([r.ok, r.ignored_args], [true, ['dry_run', 'list']]);
  const d = await run('vehicle-depot', { vehicles: '5', depot: 'auto', dry_run: true });
  assert.deepEqual(d.ignored_args, ['depot']);
});

test('read-only: dry-runnable commands are forced to a dry run, reads run, other actions are refused', async () => {
  const b = await run('build-road', { x1: 1, y1: 1, x2: 3, y2: 1 }, { readOnly: true });
  assert.deepEqual([b.ok, b.dry_run, b.forced_dry_run], [true, true, true]);
  assert.equal(lastExec().dry_run, true);
  const asked = await run('build-road', { x1: 1, y1: 1, x2: 3, y2: 1, dry_run: true }, { readOnly: true });
  assert.equal(asked.forced_dry_run, undefined, 'already a dry run');
  assert.equal((await run('towns', {}, { readOnly: true })).ok, true);
  assert.equal((await run('rate', {}, { readOnly: true })).ok, true, 'rate without arguments only shows');
  await assert.rejects(run('rate', { command_delay_ticks: 1 }, { readOnly: true }), /^Error: read_only: 'rate'/);
  const rcons = fake.state.rcons.length;
  await assert.rejects(run('pause', {}, { readOnly: true }), /read_only/);
  assert.equal(fake.state.rcons.length, rcons, 'nothing sent');
});

test('every registry command has a read-only class (add new commands to src/readonly.js)', async () => {
  const { commandClass } = await import('../src/readonly.js');
  const missing = COMMANDS.filter((c) => commandClass(c.name, Object.keys(c.args.shape)) === null).map((c) => c.name);
  assert.deepEqual(missing, []);
});
