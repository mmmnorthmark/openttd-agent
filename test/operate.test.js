// Operate commands (stations, vehicles, engines, groups, orders, vehicle actions,
// events) end-to-end against the fake admin server, in-process.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServer } from './fake-server.js';
import { encodeOrderFlags, decodeOrderFlags } from '../src/operate.js';

let fake, ctx, runCommand;
const run = (name, args) => runCommand(ctx, name, args);
const lastExec = () => fake.received.filter((r) => r.cmd === 'exec').at(-1).args;

before(async () => {
  fake = await startFakeServer({ password: 'pw' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-agent-op-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'pw', company: 0, tile_refresh_rows_per_sec: 0 }));
  process.env.OPENTTD_AGENT_HOME = home;
  process.env.OPENTTD_AGENT_LOG = 'error';
  ({ runCommand } = await import('../src/commands.js'));
  ctx = (await import('../src/context.js')).makeContext();
});

after(() => { ctx.close(); fake.server.close(); });

test('order flags round-trip and reject unknown names', () => {
  assert.equal(encodeOrderFlags('full_load_any, non_stop'), 97);
  assert.deepEqual(decodeOrderFlags(97, 'station'), ['non_stop', 'full_load_any']);
  assert.deepEqual(decodeOrderFlags(encodeOrderFlags('transfer,no_load'), 'station'), ['transfer', 'no_load']);
  assert.equal(encodeOrderFlags('service_if_needed', { depot: true }), 4);
  assert.deepEqual(decodeOrderFlags(4, 'depot'), ['service_if_needed']);
  assert.throws(() => encodeOrderFlags('fullload'), /unknown order flag/);
});

test('stations: decoded facilities and cargo, filtered by rating', async () => {
  const res = await run('stations', {});
  assert.deepEqual([res.ok, res.error, res.total, res.matched, res.truncated], [true, null, 4, 4, false]);
  const all = res.stations;
  assert.deepEqual(all[1].facilities, ['truck', 'bus']);
  assert.deepEqual(all[0].cargo[0], { cargo: 7, name: 'Wood', waiting: 240, rating_pct: 35 });
  const poor = await run('stations', { max_rating_pct: 50, min_waiting: 100 });
  assert.deepEqual(poor.stations.map((s) => s.id), [3]);
  assert.equal((await run('stations', { limit: 1 })).truncated, true);
});

test('vehicles: loss makers filter; vehicle detail decodes orders', async () => {
  const res = await run('vehicles', { max_profit_last_year: 0 });
  assert.equal(res.total, 2);
  assert.deepEqual(res.vehicles.map((v) => [v.id, v.type, v.state, v.age_pct, v.group]), [[11, 'rail', 'running', 55, 2]]);
  assert.equal((await run('vehicles', { type: 'road' })).vehicles[0].group, null);
  const v = await run('vehicle', { vehicle: 11 });
  assert.deepEqual(v.orders[0], { position: 0, kind: 'station', x: 12, y: 20, flags: ['non_stop', 'full_load_any'], station: 3, station_name: 'Bigton Woods' });
  assert.deepEqual(v.orders[1].flags, ['service_if_needed']);
  assert.deepEqual(v.capacity, [{ cargo: 7, name: 'Wood', capacity: 120, load: 40 }]);
  await assert.rejects(run('vehicle', { vehicle: 99 }), /does not exist/);
});

test('engines: cargo name resolved, newest first, wagons filter; groups; depots', async () => {
  const engines = await run('engines', { type: 'rail', cargo: 'wood' });
  assert.equal(fake.received.at(-1).args.cargo, 7);
  assert.deepEqual(engines.engines.map((e) => e.id), [6, 5, 27]);
  assert.deepEqual((await run('engines', { type: 'rail', wagons: true })).engines.map((e) => e.name), ['Wood Truck']);
  await assert.rejects(run('engines', { type: 'rail', cargo: 'unobtainium' }), /no cargo matching/);
  assert.equal((await run('groups', {})).groups[0].profit_last_year, -3000);
  assert.deepEqual((await run('depots', { type: 'rail' })).depots[0], { x: 13, y: 22, vehicles: 0 });
});

test('events: since filter and latest_seq', async () => {
  const first = await run('events', {});
  assert.equal(first.latest_seq, 2);
  const next = await run('events', { since: first.latest_seq });
  assert.deepEqual(next, { ok: true, error: null, latest_seq: 2, my_company: 0, events: [] });
  assert.equal((await run('events', { type: 'crash' })).events.length, 1);
});

test('vehicle-buy sends one step per vehicle and returns new ids; dry_run is passed on', async () => {
  const refused = await run('vehicle-buy', { depot_x: 13, depot_y: 22, engine: 27, attach_to: 11, dry_run: true });
  assert.deepEqual([refused.ok, refused.first_error], [false, 'train_not_in_depot']);
  assert.match(refused.error, /not stopped in a depot.*vehicle-depot --vehicles 11/);
  fake.state.trainInDepot = true;
  const res = await run('vehicle-buy', { depot_x: 13, depot_y: 22, engine: 27, cargo: 'wood', attach_to: 11, count: 3 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.vehicles, [100, 101, 102]);
  assert.equal(res.cost, 30);
  assert.deepEqual(lastExec().steps[0], ['veh_buy', 13, 22, 27, 7, 11]);
  assert.match((await run('vehicle-buy', { depot_x: 31, depot_y: 41, engine: 27, attach_to: 11 })).error, /stopped in the depot at \(13,22\), not at \(31,41\)/);
  fake.state.attachFails = true;
  try {
    const back = await run('vehicle-buy', { depot_x: 13, depot_y: 22, engine: 27, attach_to: 11 });
    assert.equal(back.ok, false);
    assert.deepEqual(back.sold_back.vehicles, [100]);
    assert.deepEqual(lastExec().steps, [['veh_sell', 100]]);
    assert.match(back.error, /could not attach.*sold the wagon back \(100\)/);
  } finally { fake.state.attachFails = false; fake.state.trainInDepot = false; }
  const dry = await run('vehicle-buy', { depot_x: 13, depot_y: 22, engine: 5, dry_run: true });
  assert.equal(dry.dry_run, true);
  assert.equal(lastExec().dry_run, true);
});

test('order-add resolves a station id to its tile; orders-copy shares', async () => {
  await run('order-add', { vehicle: 11, station: 3, flags: 'full_load_any,non_stop' });
  assert.deepEqual(lastExec().steps, [['order_add', 11, 12, 20, 97, -1]]);
  await assert.rejects(run('order-add', { vehicle: 11, station: 77 }), /not one of company 0's stations/);
  await assert.rejects(run('order-add', { vehicle: 11 }), /give a destination/);
  await run('orders-copy', { vehicles: '12,13', from: 11 });
  assert.deepEqual(lastExec().steps, [['orders_copy', 12, 11, true], ['orders_copy', 13, 11, true]]);
});

test('a failed step is reported with its error; group-create returns the id', async () => {
  const res = await run('vehicle-sell', { vehicles: '5,404,6' });
  assert.equal(res.ok, false);
  assert.equal(res.steps_done, 2);
  assert.equal(res.error, 'step 1 (veh_sell): Vehicle not available');
  assert.equal(res.first_error, 'failed');
  assert.equal(res.results[1].ok, false);
  const g = await run('group-create', { type: 'rail', name: 'Wood line' });
  assert.equal(g.group, 100);
  assert.deepEqual(lastExec().steps, [['group_create', 0, 'Wood line', -1]]);
  const ar = await run('group-autoreplace', { group: 2, old_engine: 5, new_engine: 6 });
  assert.equal(ar.ok, true);
  assert.equal((await run('autorenew', {})).months, 6);
});

test('goals: set with cargo labels, status with pct, done and failed, clear', async () => {
  assert.deepEqual(await run('goal-status', {}), { ok: true, error: null, company: 0, status: 'none', note: 'no goal set for this company (the host sets one with goal-set)' });
  const set = await run('goal-set', { deadline_year: 1954, targets: 'wood:3000, PASS:500,VALUE:100000' });
  assert.deepEqual(fake.received.at(-1).args, { company: 0, deadline_year: 1954, targets: [['WOOD', 3000], ['PASS', 500], ['VALUE', 100000]] });
  assert.equal(set.status, 'active');
  assert.deepEqual(set.targets[0], { cargo: 'WOOD', amount: 3000, progress: 0, pct: 0, done: false });
  fake.state.delivered = { WOOD: 1500, PASS: 800 };
  const mid = await run('goal-status', {});
  assert.deepEqual(mid.targets.map((t) => [t.cargo, t.pct, t.done]), [['WOOD', 50, false], ['PASS', 100, true], ['VALUE', 0, false]]);
  assert.equal(mid.days_left, 5 * 365);
  fake.state.year = 1955;
  assert.equal((await run('goal-status', {})).status, 'failed');
  fake.state.delivered = { WOOD: 3000, PASS: 800, VALUE: 100000 };
  assert.equal((await run('goal-status', {})).status, 'done');
  fake.state.year = 1950;
  fake.state.delivered = {};
  await assert.rejects(run('goal-set', { deadline_year: 1954, targets: 'COAL:10' }), /unknown goal cargo 'COAL'. Use a cargo label of this game \(PASS, GOOD, WOOD\) or VALUE/);
  await assert.rejects(run('goal-set', { deadline_year: 1954, targets: 'WOOD:lots' }), /whole number above 0/);
  await assert.rejects(run('goal-set', { deadline_year: 1940, targets: 'WOOD:10' }), /in the past/);
  assert.deepEqual(await run('goal-set', { deadline_year: 1951, targets: [{ cargo: 'pass', amount: 5 }], company: 3 }).then((g) => [g.company, g.targets.length]), [3, 1]);
  assert.deepEqual(await run('goal-clear', {}), { ok: true, error: null, company: 0, removed: true });
  assert.equal((await run('goal-status', {})).status, 'none');
  assert.equal((await run('goal-status', { company: 3 })).status, 'active');
});

test('pause / unpause go over the console and report what is allowed while paused', async () => {
  const paused = await run('pause', {});
  assert.deepEqual([paused.paused, paused.command_pause_level, paused.while_paused], [true, 3, 'everything']);
  assert.equal(fake.state.rcons.filter((c) => c === 'pause').length, 1);
  await run('pause', {});
  assert.equal(fake.state.rcons.filter((c) => c === 'pause').length, 1, 'already paused: no second console command');
  fake.state.pauseLevel = 1;
  assert.match((await run('pause', {})).while_paused, /no building/);
  fake.state.pauseLevel = 3;
  assert.equal((await run('unpause', {})).paused, false);
});

test('turn-advance runs the wanted number of days and leaves the game paused', async () => {
  await run('pause', {});
  const turn = await run('turn-advance', { days: 4 });
  assert.equal(turn.paused, true);
  assert.ok(turn.days_advanced >= 4 && turn.days_advanced <= 30, `advanced ${turn.days_advanced}`);
  assert.equal(turn.from, '1950-01-' + String(Number(turn.to.slice(-2)) - turn.days_advanced).padStart(2, '0'));
  assert.deepEqual([turn.latest_seq, turn.events], [2, []], 'events since the turn began');
  assert.equal(fake.state.paused, true);
  const again = await run('turn-advance', { days: 1 });
  assert.ok(again.days_advanced >= 1);
  assert.equal(again.from, turn.to, 'no time passed between turns');
});

test('loan: show, borrow rounds up, repay, max, dry run', async () => {
  fake.state.money = 100000; fake.state.loan = 300000;
  assert.deepEqual(await run('loan', {}), { ok: true, error: null, loan: 300000, max_loan: 500000, money: 100000 });
  const dry = await run('loan', { borrow: 15000, dry_run: true });
  assert.deepEqual(lastExec().steps, [['loan', 'add', 15000]]);
  assert.equal(lastExec().dry_run, true);
  assert.equal(dry.ok, true);
  assert.equal(dry.rounded_to, 320000);
  assert.deepEqual(dry.after, { loan: 320000, max_loan: 500000, money: 120000 });
  assert.equal(fake.state.loan, 300000, 'dry run changes nothing');
  const b = await run('loan', { borrow: 15000 });
  assert.equal(b.change, 20000);
  assert.deepEqual(b.before, { loan: 300000, max_loan: 500000, money: 100000 });
  assert.deepEqual(b.after, { loan: 320000, max_loan: 500000, money: 120000 });
  const r = await run('loan', { repay: 20000 });
  assert.equal(r.ok, true);
  assert.equal(r.rounded_to, undefined);
  assert.equal(r.after.loan, 300000);
  const m = await run('loan', { max: true });
  assert.deepEqual(lastExec().steps, [['loan', 'max', 0]]);
  assert.deepEqual(m.after, { loan: 500000, max_loan: 500000, money: 300000 });
  fake.state.money = 600000;
  const zero = await run('loan', { amount: 0 });
  assert.equal(zero.ok, true);
  assert.equal(zero.change, -500000);
  assert.deepEqual(zero.after, { loan: 0, max_loan: 500000, money: 100000 });
});

test('loan: refusals, one option only, and an older GameScript', async () => {
  fake.state.money = 5000; fake.state.loan = 300000;
  const over = await run('loan', { amount: 600000 });
  assert.equal(over.ok, false);
  assert.match(over.error, /over max_loan 500000/);
  assert.deepEqual(over.after, over.before);
  assert.match((await run('loan', { amount: -10 })).error, /below 0/);
  const poor = await run('loan', { repay: 100000 });
  assert.equal(poor.ok, false);
  assert.match(poor.error, /needs that much cash; bank balance is 5000/);
  assert.equal(fake.state.loan, 300000);
  await assert.rejects(run('loan', { borrow: 10000, repay: 10000 }), /one of --amount, --borrow, --repay, --max/);
  fake.state.gsVersion = 7;
  try {
    await assert.rejects(run('loan', { borrow: 10000 }), /older than v8.*install-gamescript/);
  } finally {
    fake.state.gsVersion = 9; fake.state.money = 100000;
  }
});

test('verify-route: stations joined, then a gap with the last reachable tile', async () => {
  const ok = await run('verify-route', { from_station: 'Bigton Woods', to_station: 5 });
  assert.equal(ok.method, 'rail_tracks');
  assert.equal(ok.connected, true);
  fake.state.railGap = '18,20';
  try {
    const broken = await run('verify-route', { from_station: 3, to_station: 5 });
    assert.equal(broken.connected, false);
    assert.deepEqual(broken.last_reachable, { x: 17, y: 20 });
    assert.deepEqual(broken.first_gap, { x: 18, y: 20, from: { x: 17, y: 20 }, reason: 'no_track' });
  } finally { fake.state.railGap = null; }
  const v = await run('verify-route', { vehicle: 11 });
  assert.equal(v.unit_number, 1);
  assert.equal(v.connected, true);
  assert.deepEqual(v.from_vehicle.map((r) => [r.station, r.connected]), [[3, true]]);
  await assert.rejects(run('verify-route', { from_station: 3 }), /both --from_station and --to_station/);
});

test('vehicle-problems: train on another line, losing money, then stuck; unit numbers', async () => {
  fake.state.lostTrain = true;
  await run('unpause', {}); // game days must pass between the two calls
  try {
    const first = await run('vehicle-problems', { stuck_days: 1 });
    assert.equal(first.trace_method, 'rail_tracks');
    assert.match(first.history.stuck_check, /needs another call/);
    const mine = first.problems.filter((p) => p.id === 13);
    assert.deepEqual(mine.map((p) => p.problem), ['wrong_network', 'no_income']);
    assert.equal(mine[0].unit_number, 2);
    assert.match(mine[0].evidence, /no rail path from \(30,40\) to Bigton Woods \(12,20\)/);
    await new Promise((r) => setTimeout(r, 60)); // a few fake game days
    const later = await run('vehicle-problems', { vehicle: 13, stuck_days: 1 });
    assert.equal(later.checked, 1);
    assert.deepEqual(later.problems.map((p) => p.problem), ['wrong_network', 'stuck_or_lost', 'no_income']);
    // An older GameScript: no rail_tiles, no current order in the vehicles rows; coarse mirror trace.
    fake.state.gsVersion = 8;
    const old = await run('vehicle-problems', { vehicle: 13 });
    assert.equal(old.trace_method, 'mirror_adjacency');
    assert.match(old.trace_note, /older than v9/);
    assert.match(old.problems[0].evidence, /coarse/);
    assert.ok(fake.received.some((r) => r.cmd === 'vehicle' && r.args.vehicle === 13), 'current order read per vehicle');
  } finally { fake.state.lostTrain = false; fake.state.gsVersion = 9; }
});

test('vehicle-clone: refuses a depot off the route, auto picks a joined one, skips checks off rail', async () => {
  await assert.rejects(run('vehicle-clone', { vehicle: 13, depot_x: 13, depot_y: 22, dry_run: true }), /does not exist/); // no lost train in this world
  fake.state.lostTrain = true;
  try {
    await assert.rejects(run('vehicle-clone', { vehicle: 13, depot_x: 31, depot_y: 41, dry_run: true }),
      /refused: depot \(31,41\) is not rail-connected to Bigton Woods \(12,20\).*--depot auto \(picks \(13,22\)/);
    const ok = await run('vehicle-clone', { vehicle: 13, depot_x: 13, depot_y: 22, dry_run: true });
    assert.equal(ok.route_check, 'connected');
    assert.deepEqual(lastExec().steps[0], ['veh_clone', 13, 22, 13, true]);
    // (12,22) is nearer Bigton Woods but faces away from the line, so auto skips it.
    const auto = await run('vehicle-clone', { vehicle: 13, depot: 'auto', count: 2, dry_run: true });
    assert.deepEqual(auto.depot, { x: 13, y: 22 });
    assert.deepEqual(auto.depot_auto.skipped.map((t) => t.depot), [{ x: 12, y: 22 }]);
    assert.equal(lastExec().steps.length, 2);
    assert.deepEqual((await run('vehicle-clone', { vehicle: 13, dry_run: true })).depot, { x: 13, y: 22 });
    await assert.rejects(run('vehicle-clone', { vehicle: 13, depot_x: 40, depot_y: 40, dry_run: true }), /no rail depot of company 0 at \(40,40\)/);
    await assert.rejects(run('vehicle-clone', { vehicle: 13, depot_x: 13, dry_run: true }), /both --depot_x and --depot_y/);
    await assert.rejects(run('vehicle-clone', { vehicle: 13, depot: 'auto', depot_x: 13, depot_y: 22, dry_run: true }), /not both/);
    const skip = await run('vehicle-clone', { vehicle: 13, depot_x: 31, depot_y: 41, check_route: false, dry_run: true });
    assert.match(skip.route_check, /skipped/);
    await assert.rejects(run('vehicle-buy', { depot_x: 31, depot_y: 41, engine: 5, route_of: 13, dry_run: true }), /refused: depot \(31,41\)/);
    assert.equal((await run('vehicle-buy', { depot_x: 13, depot_y: 22, engine: 5, route_of: 13, dry_run: true })).route_check, 'connected');
    // Older GameScript: the coarse mirror trace still refuses what it cannot join.
    fake.state.gsVersion = 8;
    await assert.rejects(run('vehicle-clone', { vehicle: 13, depot_x: 31, depot_y: 41, dry_run: true }), /refused:.*coarse trace/);
  } finally { fake.state.lostTrain = false; fake.state.gsVersion = 9; }
  // A road vehicle is not traced: explicit depots pass with a note.
  const road = await run('vehicle-clone', { vehicle: 12, depot_x: 41, depot_y: 8, dry_run: true });
  assert.match(road.route_check, /road vehicle/);
});

test('findExistingRoute: own rail stations at both ends, source handling the cargo; passengers both ways', async () => {
  const { findExistingRoute } = await import('../src/operate.js');
  const st = (id, x, y, cargo = [], facilities = ['rail']) => ({ id, name: `S${id}`, x, y, facilities, cargo: cargo.map((c) => ({ cargo: c })) });
  const a = { targets: [[10, 10]] }, b = { targets: [[40, 40]] };
  assert.deepEqual(findExistingRoute([st(1, 12, 11, [0]), st(2, 41, 38)], a, b, 0), { from_station: { id: 1, name: 'S1' }, to_station: { id: 2, name: 'S2' } });
  assert.equal(findExistingRoute([st(1, 12, 11, [5]), st(2, 41, 38)], a, b, 0), null, 'source station does not handle this cargo');
  assert.equal(findExistingRoute([st(1, 12, 11, [0], ['truck']), st(2, 41, 38)], a, b, 0), null, 'not a rail station');
  assert.equal(findExistingRoute([st(1, 30, 30, [0]), st(2, 41, 38)], a, b, 0), null, 'too far from the source');
  const rev = [st(1, 41, 38, [0]), st(2, 12, 11)];
  assert.equal(findExistingRoute(rev, a, b, 0), null, 'one-way cargo: a route the other way is a different route');
  assert.equal(findExistingRoute(rev, a, b, 0, { bothWays: true })?.from_station.id, 2, 'passengers: any rail stations at both towns, rating or not');
});

test('save runs the console save with a checked name and never a path', async () => {
  const r = await run('save', { name: 'game-night_1' });
  assert.deepEqual([r.saved, r.path], ['game-night_1.sav', 'save/game-night_1.sav']);
  assert.equal(fake.state.rcons.at(-1), 'save game-night_1');
  const before = fake.state.rcons.length;
  for (const bad of ['../x', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(65), 'a b']) {
    await assert.rejects(run('save', { name: bad }), /save name must be/, bad);
  }
  assert.equal(fake.state.rcons.length, before, 'refused names never reach the console');
});

test('argument aliases: --id and --vehicle/--vehicles; engines and depots default to rail; NaN echoes the value', async () => {
  const { aliasArgs } = await import('../src/commands.js');
  assert.deepEqual(aliasArgs(['vehicle'], { id: 5 }), { vehicle: 5 });
  assert.deepEqual(aliasArgs(['vehicles'], { vehicle: '5,6' }), { vehicles: '5,6' });
  assert.deepEqual(aliasArgs(['vehicles'], { id: 7 }), { vehicles: 7 });
  assert.deepEqual(aliasArgs(['vehicle'], { vehicles: '9' }), { vehicle: '9' });
  assert.deepEqual(aliasArgs(['vehicle', 'id'], { id: 1 }), { id: 1 }, 'a real --id is kept');
  assert.equal((await run('vehicle', { id: 11 })).id, 11);
  await run('vehicle-stop', { vehicle: 11 });
  assert.deepEqual(lastExec().steps, [['veh_start_stop', 11, 0]]);
  assert.equal((await run('depots', {})).type, 'rail');
  assert.equal((await run('engines', {})).engines.length, 3);
  await assert.rejects(run('vehicle', { vehicle: 'abc' }), /--vehicle: .*\(got "abc"\)/);
});

test('existing route: only a vehicle with orders at both stations blocks build-cargo-route', async () => {
  const { vehicleServing } = await import('../src/commands.js');
  const s = await ctx.session();
  const st = (id, vehicles) => ({ id, vehicles });
  // Train 11 has orders for station 3 and a depot only (fake `vehicle`), so 3 + 5 is not served by it.
  assert.equal(await vehicleServing(s, 0, [st(3, 2), st(5, 1)], 3, 5), null);
  assert.equal(await vehicleServing(s, 0, [st(3, 2), st(5, 0)], 3, 5), null, 'nobody has orders at station 5');
  fake.state.lostTrain = true; // train 13 heads for station 3 with orders 3 -> 5
  try { assert.equal(await vehicleServing(s, 0, [st(3, 2), st(5, 1)], 3, 5), 13); } finally { fake.state.lostTrain = false; }
});

test('status: versions, and a warning when the running AgentBridge is older than the bundled one', async () => {
  const { bundledGsVersion } = await import('../src/setup.js');
  const now = await run('status', {});
  assert.equal(now.versions.gamescript_bundled, bundledGsVersion());
  fake.state.gsVersion = bundledGsVersion() - 1;
  try {
    const old = await run('status', {});
    assert.match(old.warnings[0], /runs AgentBridge v\d+; this openttd-agent .* ships v\d+/);
  } finally { fake.state.gsVersion = 11; }
});

test('verify-route traces road vehicles and road stops (AgentBridge v11), refuses on older GameScripts', async () => {
  const ok = await run('verify-route', { vehicle: 12 });
  assert.deepEqual([ok.type, ok.method, ok.connected], ['road', 'road_tiles', true]);
  assert.equal(ok.legs.length, 2);
  const pair = await run('verify-route', { from_station: 4, to_station: 'Smallham Stop' });
  assert.deepEqual([pair.mode, pair.connected], ['road', true]);
  fake.state.roadGap = '44,9';
  try {
    const gap = await run('verify-route', { from_station: 4, to_station: 7 });
    assert.equal(gap.connected, false);
    assert.deepEqual([gap.first_gap.x, gap.first_gap.y, gap.first_gap.reason], [44, 9, 'no_road']);
    assert.deepEqual(gap.last_reachable, { x: 43, y: 9 });
  } finally { fake.state.roadGap = null; }
  fake.state.roadOneWay = '44,9';
  try {
    assert.equal((await run('verify-route', { from_station: 4, to_station: 7 })).connected, true, 'with the one-way direction');
    const back = await run('verify-route', { from_station: 7, to_station: 4 });
    assert.deepEqual([back.connected, back.first_gap.reason], [false, 'one_way_road']);
  } finally { fake.state.roadOneWay = null; }
  const probs = await run('vehicle-problems', {});
  assert.equal(probs.road_trace, 'road_tiles');
  assert.ok(!probs.problems.some((p) => p.id === 12 && /path/.test(p.evidence)));
  fake.state.gsVersion = 10;
  try {
    await assert.rejects(run('verify-route', { vehicle: 12 }), /refused: road vehicles .* AgentBridge v11/);
    assert.match((await run('vehicle-problems', {})).road_trace, /^off: /);
  } finally { fake.state.gsVersion = 11; }
});
