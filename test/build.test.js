// Construction commands end-to-end against the fake admin server (64x64 flat map,
// water column at x=30 except y=50..52, houses at 40..44,10..14).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServer } from './fake-server.js';

let fake, ctx, runCommand;
const run = (name, args) => runCommand(ctx, name, args);
const execs = () => fake.received.filter((r) => r.cmd === 'exec');
const lastExec = () => execs().at(-1).args;

before(async () => {
  fake = await startFakeServer({ password: 'pw' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-agent-build-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'pw', company: 0, tile_refresh_rows_per_sec: 0 }));
  process.env.OPENTTD_AGENT_HOME = home;
  process.env.OPENTTD_AGENT_LOG = 'error';
  ({ runCommand } = await import('../src/commands.js'));
  ctx = (await import('../src/context.js')).makeContext();
});

after(() => { ctx.close(); fake.server.close(); });

test('build-rail: dry run plans over the river with a bridge and reports cost per step', async () => {
  const res = await run('build-rail', { x1: 24, y1: 20, x2: 36, y2: 20, dry_run: true, margin: 5, bridge: 'fastest', rail_type: 1 });
  assert.equal(res.reachable, true);
  assert.equal(res.bridges, 1);
  assert.equal(res.dry_run, true);
  assert.equal(res.ok, true);
  assert.deepEqual(lastExec().steps, [['rail', 24, 20, 25, 20, 29, 20], ['bridge', 0, 29, 20, 31, 20, -2], ['rail', 31, 20, 32, 20, 36, 20]]);
  assert.equal(lastExec().rail_type, 1);
  assert.equal(res.cost, 30);
  assert.deepEqual(res.results.map((r) => r.op), ['rail', 'bridge', 'rail']);
});

test('build-rail: plan_only returns steps without an exec; unreachable explains what to try', async () => {
  const before = execs().length;
  const plan = await run('build-rail', { x1: 5, y1: 5, x2: 12, y2: 5, plan_only: true, show_path: true });
  assert.deepEqual(plan.steps, [['rail', 5, 5, 6, 5, 12, 5]]);
  assert.equal(plan.path.length, 8);
  assert.equal(execs().length, before);
  const no = await run('build-rail', { x1: 24, y1: 20, x2: 36, y2: 20, margin: 3, max_bridge: 3, plan_only: true });
  assert.equal(no.reachable, true, 'a 3-tile bridge spans the 1-tile river');
  const edge = await run('build-rail', { x1: 36, y1: 12, x2: 40, y2: 12, margin: 2, plan_only: true });
  assert.equal(edge.reachable, true, 'the end anchor may be any tile, here a house on the edge of town');
  const inside = await run('build-rail', { x1: 36, y1: 12, x2: 42, y2: 12, margin: 2, plan_only: true });
  assert.equal(inside.reachable, false);
  assert.match(inside.reason, /larger margin/);
});

test('build-road-path builds for the configured company', async () => {
  const res = await run('build-road-path', { x1: 3, y1: 3, x2: 9, y2: 6 });
  assert.equal(res.ok, true);
  assert.equal(lastExec().company, 0);
  assert.ok(lastExec().steps.every((s) => s[0] === 'road'));
  assert.equal(lastExec().dry_run, false);
});

test('single-step builders send the right step', async () => {
  await run('build-rail-station', { x: 10, y: 10, axis: 'y', platforms: 2, length: 5, join: 'adjacent' });
  assert.deepEqual(lastExec().steps, [['rail_station', 10, 10, true, 2, 5, -2]]);
  await assert.rejects(run('build-rail-station', { x: 10, y: 10, join: 'nearby' }), /join must be/);
  await run('build-rail-depot', { x: 9, y: 9, front_x: 10, front_y: 9 });
  assert.deepEqual(lastExec().steps, [['rail_depot', 9, 9, 10, 9]]);
  await run('build-signal', { x: 14, y: 10, front_x: 13, front_y: 10, type: 'block', two_way: true });
  assert.deepEqual(lastExec().steps, [['signal', 14, 10, 13, 10, 8]]);
  await run('build-signal', { x: 14, y: 10, front_x: 13, front_y: 10, type: 'path_oneway', two_way: true });
  assert.deepEqual(lastExec().steps, [['signal', 14, 10, 13, 10, 5]]);
  await run('build-road-station', { x: 4, y: 4, front_x: 4, front_y: 5, kind: 'bus', drive_through: true, join: '7' });
  assert.deepEqual(lastExec().steps, [['road_station', 4, 4, 4, 5, false, true, 7]]);
  await run('build-bridge', { type: 'road', x1: 29, y1: 5, x2: 31, y2: 5, bridge: '2' });
  assert.deepEqual(lastExec().steps, [['bridge', 1, 29, 5, 31, 5, 2]]);
  await run('build-tunnel', { x: 8, y: 8 });
  assert.deepEqual(lastExec().steps, [['tunnel', 0, 8, 8]]);
  await run('build-dock', { x: 29, y: 30 });
  assert.deepEqual(lastExec().steps, [['dock', 29, 30, -1]]);
  await run('build-airport', { x: 50, y: 50, airport: 'Small', dry_run: true });
  assert.deepEqual(lastExec().steps, [['airport', 50, 50, 0, -1]]);
  await assert.rejects(run('build-airport', { x: 50, y: 50, airport: 'jumbo' }), /unknown airport 'jumbo'. Available: small/);
});

test('templates run as one exec and return where to connect', async () => {
  const t = await run('build-terminus', { x: 10, y: 30, platforms: 2, length: 4, dry_run: true });
  assert.deepEqual(t.connect_at, { x: 16, y: 30, dir: 'sw' });
  assert.equal(lastExec().steps[0][0], 'rail_station');
  const loop = await run('build-passing-loop', { x: 20, y: 40, dir: 'se', length: 5, side: -1 });
  assert.deepEqual(loop.ends, [{ x: 20, y: 40 }, { x: 20, y: 46 }]);
  assert.equal(lastExec().steps.at(-1)[0], 'signal');
});

test('terraform and demolish normalise rectangles; demolish passes allow_houses', async () => {
  await run('terraform', { x0: 5, y0: 5, x1: 8, y1: 7, dry_run: true });
  assert.deepEqual(lastExec().steps, [['level', 5, 5, 9, 8]]);
  await run('terraform', { op: 'raise', x0: 5, y0: 5, x1: 6, y1: 5, corners: 8 });
  assert.deepEqual(lastExec().steps, [['raise', 5, 5, 8], ['raise', 6, 5, 8]]);
  const d = await run('demolish', { x0: 9, y0: 9, x1: 7, y1: 8 });
  assert.deepEqual(lastExec().steps, [['demolish', 7, 8, 9, 9, false]]);
  assert.equal(d.tiles_cleared, 100);
  await assert.rejects(run('demolish', { x0: 0, y0: 0, x1: 30, y1: 30 }), /area too large/);
});

test('rail-types and bridge-types decode rows', async () => {
  assert.deepEqual((await run('rail-types', {}))[1], { id: 1, name: 'Electrified railway construction', max_speed: 0, track_cost: 75 });
  assert.equal((await run('bridge-types', { length: 5 }))[1].price, 1500);
});

test('find-cargo-pairs pairs goods with towns that accept them; acceptance command', async () => {
  const res = await run('find-cargo-pairs', { cargo: 'goods', with_effort: false });
  assert.equal(res.total_candidates, 1, 'Smallham accepts goods only at 4');
  assert.equal(res.pairs[0].dest.kind, 'town');
  assert.equal(res.pairs[0].dest.name, 'Bigton');
  assert.equal(res.pairs[0].dest.acceptance, 12);
  assert.equal(res.pairs[0].source.secondary, true);
  const acc = await run('acceptance', { x: 42, y: 12 });
  assert.deepEqual(acc.cargo.map((c) => [c.label, c.acceptance, c.accepted]), [['PASS', 30, true], ['GOOD', 12, true]]);
  const one = await run('acceptance', { x: 10, y: 50, cargo: 'wood' });
  assert.deepEqual(one.cargo.map((c) => [c.label, c.acceptance, c.accepted]), [['WOOD', 0, false]]);
  assert.deepEqual(fake.received.filter((r) => r.cmd === 'acceptance').at(-1).args.cargos, [7]);
});

test('build-cargo-route dry run: both termini, the line, a depot and a train, with the total cost', async () => {
  const before = execs().length;
  const res = await run('build-cargo-route', { from_industry: 1, to_industry: 2, cargo: 'wood', dry_run: true });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 400));
  assert.ok(execs().slice(before).every((e) => e.args.dry_run === true), 'a dry run sends only dry-run execs');
  assert.equal(res.train.locomotive.id, 5, 'cheapest to run');
  assert.equal(res.train.wagon.id, 27);
  assert.equal(res.train.wagons, 7, 'fills a 4-tile platform');
  assert.equal(res.train.cost, 8000 + 7 * 1500);
  assert.deepEqual(res.orders, { source: 'full_load_any', dest: 'unload,no_load' });
  assert.equal(res.estimated_cost, res.source_site.cost + res.dest_site.cost + res.line.cost + res.depot.cost + res.train.cost);
  assert.ok(res.source_site.connect_at.x > res.source_site.x - 10 && res.dest_site.x > 40, 'one station at each end');
  assert.ok(res.line.tiles > 20);
  assert.equal(res.dest_site.acceptance, 8);
});

test('build-cargo-route builds in order, buys and orders the train, starts it', async () => {
  const before = execs().length;
  const res = await run('build-cargo-route', { from_industry: 1, to_industry: 2, cargo: 'wood', wagons: 3 });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 400));
  const real = execs().slice(before).filter((e) => !e.args.dry_run).map((e) => e.args.steps);
  assert.equal(real[0][0][0], 'rail_station');
  assert.equal(real[1][0][0], 'rail_station');
  assert.ok(real[2].every((st) => st[0] === 'rail' || st[0] === 'bridge'), 'then the line');
  assert.equal(real[3][0][0], 'rail_depot');
  const [loco, wagons, orders, start] = real.slice(4);
  assert.deepEqual(loco, [['veh_buy', res.depot.x, res.depot.y, 5, -1, -1]]);
  assert.equal(wagons.length, 3);
  assert.deepEqual(wagons[0], ['veh_buy', res.depot.x, res.depot.y, 27, -1, res.vehicle], 'no refit: the wagon already carries wood');
  assert.deepEqual(orders, [['order_add', res.vehicle, res.source_site.x, res.source_site.y, 96, -1], ['order_add', res.vehicle, res.dest_site.x, res.dest_site.y, 132, -1]]);
  assert.deepEqual(start, [['veh_start_stop', res.vehicle, 1]]);
  assert.equal(res.vehicle, 100);
  assert.ok(res.total_cost > 0);
  assert.deepEqual(res.built.map((b) => b.step), ['source_station', 'dest_station', 'rail_line', 'depot', 'buy_locomotive', 'buy_wagons', 'orders', 'start']);
});

test('build-cargo-route stops at a failed step and reports what was built', async () => {
  fake.state.failOps = ['veh_buy'];
  const before = execs().length;
  try {
    const res = await run('build-cargo-route', { from_industry: 1, to_industry: 2, cargo: 'wood' });
    assert.equal(res.ok, false);
    assert.equal(res.failed_step, 'buy_locomotive');
    assert.deepEqual(res.built.map((b) => b.step), ['source_station', 'dest_station', 'rail_line', 'depot']);
    assert.ok(res.built[3].x !== undefined && res.built[0].connect_at);
    assert.match(res.hint, /nothing was demolished/);
    assert.equal(execs().slice(before).filter((e) => e.args.steps.some((st) => st[0] === 'demolish')).length, 0);
  } finally { fake.state.failOps = []; }
  await assert.rejects(run('build-cargo-route', { from_industry: 1, from_town: 'Bigton', to_industry: 2, cargo: 'wood' }), /exactly one of --from_industry, --from_town/);
  const refused = await run('build-cargo-route', { from_industry: 2, to_town: 'Smallham', cargo: 'goods', dry_run: true });
  assert.equal(refused.failed_step, 'dest_station');
  assert.match(refused.error, /accepts Goods \(acceptance \d/);
});
