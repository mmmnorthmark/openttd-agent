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
  assert.deepEqual((await run('rail-types', {})).rail_types[1], { id: 1, name: 'Electrified railway construction', max_speed: 0, track_cost: 75 });
  assert.equal((await run('bridge-types', { length: 5 })).bridge_types[1].price, 1500);
});

test('find-cargo-pairs pairs goods with towns that accept them; acceptance command', async () => {
  const res = await run('find-cargo-pairs', { cargo: 'goods', with_effort: false, min_distance: 0 });
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

test('find-cargo-pairs pairs passengers town with town; names feed build-cargo-route', async () => {
  const res = await run('find-cargo-pairs', { cargo: 'passengers', with_effort: false });
  assert.equal(res.total_candidates, 2);
  const [p] = res.pairs;
  assert.deepEqual(p.source, { kind: 'town', id: 1, name: 'Bigton', x: 42, y: 12, population: 5000 });
  assert.deepEqual(p.dest, { kind: 'town', id: 2, name: 'Smallham', x: 10, y: 50, population: 300, acceptance: 9 });
  assert.deepEqual([p.cargo, p.source_last_month, p.source_transported_pct, p.distance], ['Passengers', 800, 10, 70]);
  assert.equal((await run('find-cargo-pairs', { cargo: 'passengers', dest_kind: 'industry', with_effort: false })).total_candidates, 0);
  assert.equal((await run('find-cargo-pairs', { cargo: 'passengers', limit: 1, with_effort: false })).pairs.length, 1);
  const withEffort = await run('find-cargo-pairs', { cargo: 'passengers', limit: 1 });
  assert.equal(typeof withEffort.pairs[0].route.reachable, 'boolean');
});

test('purchase-land: dry run normalises corners, estimates cost and buys nothing', async () => {
  const res = await run('purchase-land', { x0: 13, y0: 32, x1: 10, y1: 30, dry_run: true });
  assert.deepEqual(lastExec().steps, [['buy_land', 10, 30, 13, 32]]);
  assert.equal(lastExec().dry_run, true);
  assert.equal(lastExec().company, 0);
  assert.deepEqual(res, { ok: true, error: null, dry_run: true, company: 0, area: [10, 30, 13, 32], tiles: 12, estimated_cost: 600, money: 100000, affordable: true });
  assert.equal(fake.state.land.size, 0);
  await assert.rejects(run('purchase-land', { x0: 0, y0: 0, x1: 20, y1: 19, dry_run: true }), /area too large: 21x20 = 420 tiles; purchase-land buys at most 400/);
  await assert.rejects(run('purchase-land', { x0: 60, y0: 0, x1: 64, y1: 1 }), /outside the map/);
});

test('purchase-land buys, refuses the whole rectangle on protected tiles, and owned-land lists the plots', async () => {
  try {
    const res = await run('purchase-land', { x0: 10, y0: 30, x1: 13, y1: 32 });
    assert.deepEqual(res, { ok: true, error: null, dry_run: false, company: 0, area: [10, 30, 13, 32], tiles_bought: 12, cost: 600, money: res.money });
    assert.equal(fake.state.land.size, 12);
    // houses at 40..44,10..14, already-owned tiles and another company's tile: nothing is bought
    fake.state.landOwnedBy['20,30'] = 1;
    const refused = await run('purchase-land', { x0: 38, y0: 9, x1: 41, y1: 10 });
    assert.equal(refused.ok, false);
    assert.equal(refused.tiles_bought, 0);
    assert.match(refused.error, /^refused: 2 of 8 tiles cannot be bought, nothing was bought: 40,10 is a town building; 41,10 is a town building/);
    const again = await run('purchase-land', { x0: 13, y0: 32, x1: 14, y1: 32, dry_run: true });
    assert.match(again.error, /13,32 is already your owned land/);
    assert.match((await run('purchase-land', { x0: 20, y0: 30, x1: 20, y1: 30 })).error, /20,30 belongs to company 1/);
    assert.match((await run('purchase-land', { x0: 30, y0: 5, x1: 30, y1: 5 })).error, /30,5 is water/);
    assert.equal(fake.state.land.size, 12);
    // a later plot touching the first one, then the listing merges rows into rectangles
    await run('purchase-land', { x0: 10, y0: 33, x1: 13, y1: 33 });
    await run('purchase-land', { x0: 50, y0: 50, x1: 50, y1: 50 });
    const owned = await run('owned-land', {});
    assert.equal(owned.company, 0);
    assert.equal(owned.tiles, 17);
    assert.deepEqual(owned.rects, [[10, 30, 13, 33], [50, 50, 50, 50]]);
    const part = await run('owned-land', { x0: 12, y0: 31, x1: 11, y1: 30 });
    assert.deepEqual(part, { ok: true, error: null, company: 0, area: [11, 30, 12, 31], tiles: 4, rects: [[11, 30, 12, 31]] });
    assert.deepEqual((await run('owned-land', { limit: 1 })).truncated, true);
    await assert.rejects(run('owned-land', { x0: 1, y0: 1 }), /give all of --x0 --y0 --x1 --y1/);
  } finally { fake.state.land.clear(); fake.state.landOwnedBy = {}; }
});

test('purchase-land reports a failure while buying: what was bought and the failed tile', async () => {
  fake.state.landFailAt = '12,41';
  try {
    const res = await run('purchase-land', { x0: 10, y0: 40, x1: 13, y1: 42 });
    assert.equal(res.ok, false);
    assert.equal(res.tiles_bought, 6);
    assert.deepEqual(res.bought, [[10, 40, 13, 40], [10, 41, 11, 41]]);
    assert.deepEqual(res.failed_tile, { x: 12, y: 41 });
    assert.equal(res.not_bought, 6);
    assert.match(res.error, /tile 12,41: .*\(6 tiles bought before it\)/);
    assert.equal(fake.state.land.size, 6);
  } finally { fake.state.landFailAt = null; fake.state.land.clear(); }
});

test('airport-sites marks sites on your owned land and lists them first', async () => {
  const plain = await run('airport-sites', { town: 'Smallham', limit: 2 });
  assert.ok(plain.sites.length > 0 && plain.sites.every((st) => st.owned === false));
  fake.state.land.set('9,48', 1); // another company's land is not ours
  try {
    await run('purchase-land', { x0: 4, y0: 58, x1: 7, y1: 60 }); // refreshes the mirror there
    const res = await run('airport-sites', { town: 'Smallham', limit: 2 });
    assert.deepEqual([res.sites[0].x, res.sites[0].y, res.sites[0].owned], [4, 58, true]);
    assert.equal(res.sites[0].buildable, true);
    assert.equal(res.sites.filter((st) => st.owned).length, 1);
  } finally { fake.state.land.clear(); }
});

test('owned land commands explain an older AgentBridge; airport-sites still works', async () => {
  fake.state.gsVersion = 9;
  try {
    await assert.rejects(run('purchase-land', { x0: 1, y0: 1, x1: 2, y1: 2, dry_run: true }), /older than v10/);
    await assert.rejects(run('owned-land', {}), /older than v10/);
    const res = await run('airport-sites', { town: 'Smallham', limit: 1 });
    assert.ok(res.sites.length && res.sites.every((st) => !('owned' in st)));
  } finally { fake.state.gsVersion = 12; }
});

test('build-signal --remove: no_signal_here instead of ERR_PRECONDITION_FAILED', async () => {
  const before = fake.received.filter((r) => r.cmd === 'exec').length;
  const none = await run('build-signal', { x: 15, y: 20, front_x: 14, front_y: 20, remove: true });
  assert.deepEqual([none.ok, none.first_error], [false, 'no_signal_here']);
  assert.match(none.error, /the tile has no signals/);
  const wrong = await run('build-signal', { x: 18, y: 20, front_x: 17, front_y: 20, remove: true });
  assert.match(wrong.error, /one facing trains from \(19,20\): give that as --front_x/);
  assert.equal(fake.received.filter((r) => r.cmd === 'exec').length, before, 'nothing was sent');
  const ok = await run('build-signal', { x: 18, y: 20, front_x: 19, front_y: 20, remove: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(lastExec().steps, [['signal_remove', 18, 20, 19, 20]]);
  assert.equal((await run('build-signal', { x: 5, y: 5, front_x: 7, front_y: 5, remove: true })).first_error, 'front_not_adjacent');
});

test('road stops and depots: connected, --connect auto, decoded drive-through refusals', async () => {
  const dep = await run('build-road-depot', { x: 38, y: 12, front_x: 38, front_y: 11, connect: 'auto' });
  assert.equal(dep.ok, true);
  assert.deepEqual([dep.connect.ok, dep.connect.from, dep.connect.to], [true, { x: 38, y: 11 }, { x: 38, y: 9 }]);
  assert.equal(lastExec().steps[0][0], 'road');
  fake.state.failOps = ['road_station'];
  try {
    const dt = await run('build-road-station', { x: 36, y: 9, front_x: 37, front_y: 9, drive_through: true });
    assert.equal(dt.first_error, 'drive_through_refused');
    assert.match(dt.error, /junction: road leaves \(36,9\) sideways/);
  } finally { fake.state.failOps = []; }
  const bay = await run('build-road-station', { x: 47, y: 10, front_x: 47, front_y: 9 });
  assert.equal(bay.connected, false, 'the fake world has no stop there');
  const dry = await run('build-road-depot', { x: 38, y: 12, front_x: 38, front_y: 11, dry_run: true });
  assert.equal(dry.connected, undefined, 'a dry run builds nothing to check');
});

test('build-passing-loop: site check, train length, dry run ok, remove', async () => {
  const sig = await run('build-passing-loop', { x: 15, y: 20, dir: 'sw', length: 4, dry_run: true });
  assert.deepEqual([sig.ok, sig.first_error, sig.at], [false, 'signal_at', { x: 18, y: 20 }]);
  const stn = await run('build-passing-loop', { x: 20, y: 20, dir: 'sw', length: 2, dry_run: true });
  assert.deepEqual([stn.first_error, stn.at], ['not_straight_at', { x: 24, y: 20 }]);
  assert.match(stn.error, /a station tile/);
  const short = await run('build-passing-loop', { x: 5, y: 30, length: 4, train_tiles: 5, dry_run: true });
  assert.equal(short.first_error, 'loop_too_short');
  const fit = await run('build-passing-loop', { x: 5, y: 30, for_vehicle: 11, dry_run: true });
  assert.deepEqual([fit.ok, fit.length, fit.train_tiles, fit.clear_tiles, fit.longest_train.vehicle], [true, 7, 5, 6, 11]);
  assert.equal(fit.site_check, 'ok');
  const built = await run('build-passing-loop', { x: 5, y: 30, length: 4 });
  assert.equal(built.ok, true);
  assert.ok(built.loop_check, 'a real build traces both directions');
  assert.match(built.route_after, /not_checked/);
  const rm = await run('build-passing-loop', { x: 5, y: 30, length: 4, remove: true });
  assert.equal(rm.removed, true);
  assert.deepEqual(lastExec().steps[0], ['signal_remove', 9, 30, 8, 30]);
});

test('find-cargo-pairs: default distance bounds and --near_x/--near_y/--radius', async () => {
  const res = await run('find-cargo-pairs', { cargo: 'passengers', with_effort: false });
  assert.deepEqual([res.distance_bounds.min, res.distance_bounds.max], [20, 200]);
  assert.ok(res.distance_bounds.defaulted);
  const near = await run('find-cargo-pairs', { cargo: 'passengers', with_effort: false, near_x: 10, near_y: 50, radius: 5 });
  assert.ok(near.pairs.length > 0);
  assert.ok(near.pairs.every((p) => p.source.name === 'Smallham'), JSON.stringify(near.pairs));
  const far = await run('find-cargo-pairs', { cargo: 'passengers', with_effort: false, min_distance: 0, max_distance: 10 });
  assert.equal(far.total_candidates, 0);
  assert.equal(far.distance_bounds.defaulted, undefined);
});
