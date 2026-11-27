// Road and fleet operations (0.8.0 batch 5): pure helpers in src/fleet.js and the commands that use
// them, end-to-end against the fake admin server, in-process.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServer } from './fake-server.js';
import { moneyDetail, authorityNeed, townRatingFromRow } from '../src/fleet.js';

let fake, ctx, runCommand;
const run = (name, args) => runCommand(ctx, name, args);

before(async () => {
  fake = await startFakeServer({ password: 'pw' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-agent-fleet-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'pw', company: 0, tile_refresh_rows_per_sec: 0, vehicle_watch: false }));
  process.env.OPENTTD_AGENT_HOME = home;
  process.env.OPENTTD_AGENT_LOG = 'error';
  ({ runCommand } = await import('../src/commands.js'));
  ctx = (await import('../src/context.js')).makeContext();
});

after(() => { ctx.close(); fake.server.close(); });

// ---- R8: town ratings -------------------------------------------------------------------------

test('townRatingFromRow and authorityNeed', () => {
  assert.deepEqual(townRatingFromRow([1, 'poor', -120, 42, 12]), { town: 1, rating: 'poor', rating_value: -120, rated: true, x: 42, y: 12 });
  assert.equal(townRatingFromRow([2, 'none', 500, 10, 50]).rated, false);
  assert.equal(authorityNeed('road_station').needed, -199);
  assert.equal(authorityNeed('road_remove').needed, null);
});

test('towns: my_rating per town (GS v13); an older GameScript says so', async () => {
  const res = await run('towns', {});
  assert.equal(res.company, 0);
  assert.deepEqual(res.towns.find((t) => t.name === 'Bigton').my_rating, { rating: 'good', value: 450, rated: true });
  assert.deepEqual(res.towns.find((t) => t.name === 'Smallham').my_rating, { rating: 'none', value: 500, rated: false });
  fake.state.gsVersion = 12;
  try {
    const old = await run('towns', {});
    assert.equal(old.ok, true);
    assert.equal(old.towns[0].my_rating, undefined);
    assert.match(old.my_rating_note, /v13/);
  } finally { fake.state.gsVersion = 13; }
});

test('a local-authority refusal names the town, the rating and what is needed', async () => {
  fake.state.refuseOps = ['road_station'];
  fake.state.townRatings[1] = ['very_poor', -250];
  try {
    const res = await run('build-road-station', { x: 43, y: 15, front_x: 43, front_y: 16 });
    assert.equal(res.ok, false);
    assert.equal(res.first_error, 'ERR_LOCAL_AUTHORITY_REFUSES');
    assert.deepEqual([res.local_authority.town_name, res.local_authority.rating, res.local_authority.rating_value, res.local_authority.needed], ['Bigton', 'very_poor', -250, -199]);
    assert.match(res.error, /Bigton rates you very_poor \(-250\)/);
  } finally { fake.state.refuseOps = []; fake.state.townRatings[1] = ['good', 450]; }
});

// ---- L8: money ----------------------------------------------------------------------------------

test('moneyDetail: needed, headroom and the next command', () => {
  assert.deepEqual(moneyDetail({ cost: 5000, money: 1000, loan: 100000, max_loan: 300000 }),
    { needed: 4000, money: 1000, loan: 100000, max_loan: 300000, loan_headroom: 200000, next: 'loan --borrow 4000, or rerun with --borrow_if_needed true' });
  assert.match(moneyDetail({ cost: 500000, money: 0, loan: 290000, max_loan: 300000 }).next, /can add only 10000/);
  assert.equal(moneyDetail({ cost: null, money: 0, loan: 0, max_loan: 100 }).needed, null);
});

test('not enough cash: the failure carries needed and next; --borrow_if_needed borrows and finishes', async () => {
  const saved = { money: fake.state.money, loan: fake.state.loan };
  Object.assign(fake.state, { money: 5, cashNeed: 20 });
  try {
    const res = await run('build-rail-station', { x: 10, y: 10 });
    assert.equal(res.ok, false);
    assert.equal(res.first_error, 'ERR_NOT_ENOUGH_CASH');
    assert.deepEqual([res.needed, res.money, res.loan_headroom], [5, 5, 200000]);
    assert.match(res.next, /^loan --borrow 5/);
    const again = await run('build-rail-station', { x: 10, y: 10, borrow_if_needed: true });
    assert.equal(again.ok, true);
    assert.equal(again.borrowed, 10000);
    assert.equal(fake.state.loan, saved.loan + 10000);
  } finally { Object.assign(fake.state, saved, { cashNeed: 0 }); }
});

test('a dry run that costs more than the bank balance warns with the money fields', async () => {
  fake.state.dryMoney = 5;
  try {
    const res = await run('build-rail-station', { x: 10, y: 10, dry_run: true });
    assert.equal(res.ok, true);
    assert.equal(res.needed, 5);
    assert.match(res.warnings[0], /^not_enough_money/);
  } finally { fake.state.dryMoney = null; }
});

test('loan --borrow over max_loan borrows up to max_loan', async () => {
  const saved = { money: fake.state.money, loan: fake.state.loan };
  try {
    const res = await run('loan', { borrow: 9000000 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.clamped, { asked: saved.loan + 9000000, clamped_to_max_loan: 500000 });
    assert.equal(res.after.loan, 500000);
  } finally { Object.assign(fake.state, saved); }
});

// ---- R15: road on a slope ---------------------------------------------------------------------

test('a road refused on a slope: sloped_tile with at and a hint', async () => {
  fake.state.slopeOps = ['road'];
  try {
    const res = await run('build-road', { x1: 2, y1: 2, x2: 6, y2: 2, road_type: 0 });
    assert.equal(res.ok, false);
    assert.equal(res.first_error, 'sloped_tile');
    assert.deepEqual(res.at, { x: 2, y: 2 });
    assert.match(res.hint, /terraform --op level/);
  } finally { fake.state.slopeOps = []; }
});

// ---- R1 / G8: ids in build results ------------------------------------------------------------

test('build results carry the station id and the depot tile', async () => {
  const rs = await run('build-rail-station', { x: 10, y: 20 });
  assert.deepEqual(rs.station, { id: 3, name: 'Bigton Woods' });
  const bus = await run('build-road-station', { x: 41, y: 9, front_x: 42, front_y: 9, kind: 'bus', drive_through: true });
  assert.deepEqual(bus.station, { id: 4, name: 'Bigton Central' });
  const rd = await run('build-road-depot', { x: 36, y: 8, front_x: 36, front_y: 9 });
  assert.deepEqual([rd.depot, rd.front], [{ x: 36, y: 8 }, { x: 36, y: 9 }]);
  const dd = await run('build-rail-depot', { x: 13, y: 22, front_x: 13, front_y: 21 });
  assert.deepEqual(dd.depot, { x: 13, y: 22 });
  assert.equal((await run('build-rail-station', { x: 10, y: 20, dry_run: true })).station, undefined);
});

// ---- G6 / L5 / L6 / L10: selling --------------------------------------------------------------

test('vehicle-sell: sells what is in a depot, queues the rest; the queue shows in vehicle-problems and blocks vehicle-start', async () => {
  const s = await ctx.session();
  try {
    const res = await run('vehicle-sell', { vehicles: '11' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.sold, []);
    assert.deepEqual(res.queued, [{ vehicle: 11, sent: true }]);
    assert.ok(s.pendingSales.has('0:11'));
    const probs = await run('vehicle-problems', { vehicles: '11', trace: false });
    assert.deepEqual(probs.problems.map((p) => p.problem), ['pending_sale']);
    const start = await run('vehicle-start', { vehicles: '11' });
    assert.equal(start.first_error, 'queued_for_sale');
    assert.equal((await run('vehicle-sell', { vehicles: '11' })).already_queued[0], 11);
    fake.state.trainInDepot = true;
    const done = await s.finishSales();
    assert.deepEqual(done.sold.map((x) => x.vehicle), [11]);
    assert.equal(s.soldVehicles.get('0:11').stations[0], 3);
    assert.equal((await run('vehicle-problems', { vehicles: '11', trace: false })).problems.some((p) => p.problem === 'pending_sale'), false);
  } finally { fake.state.trainInDepot = false; s.pendingSales.clear(); s.soldVehicles.clear(); }
});

test('vehicle-sell --send false refuses vehicles outside a depot; a sold vehicle is already_sold', async () => {
  const s = await ctx.session();
  fake.state.lostTrain = true;
  try {
    const refused = await run('vehicle-sell', { vehicles: '13', send: false });
    assert.equal(refused.first_error, 'not_in_depot');
    s.pendingSales.set('0:13', { company: 0, vehicle: 13, send: true, sent: true });
    const start = await run('vehicle-start', { vehicles: '13', cancel_sale: true });
    assert.equal(start.ok, true);
    assert.deepEqual(start.sale_cancelled, [13]);
    assert.equal(s.pendingSales.has('0:13'), false);
    await s.recordSold({ company: 0, vehicle: 13, income: 5000, stations: [3, 5] });
    fake.state.lostTrain = false;
    const again = await run('vehicle-sell', { vehicles: '13' });
    assert.equal(again.ok, true);
    assert.match(again.already_sold[0].note, /^already_sold: vehicle 13 was sold on .* vehicles with orders for its stations now: 11/);
    const detail = await run('vehicle', { vehicle: 13 });
    assert.equal(detail.first_error, 'already_sold');
    await assert.rejects(run('vehicle-clone', { vehicle: 13, dry_run: true }), /already_sold: vehicle 13/);
  } finally { fake.state.lostTrain = false; s.pendingSales.clear(); s.soldVehicles.clear(); }
});

test('vehicle-problems: --type and --problem filters', async () => {
  const res = await run('vehicle-problems', { type: 'road', trace: false });
  assert.ok(res.problems.every((p) => p.type === 'road'));
  const only = await run('vehicle-problems', { problem: 'no_income', trace: false });
  assert.deepEqual([...new Set(only.problems.map((p) => p.problem))], ['no_income']);
});

// ---- G5 / C11: wait -----------------------------------------------------------------------

test('wait: until a state, until loaded, game days, timeout and a paused game', async () => {
  fake.state.trainInDepot = true;
  try {
    const d = await run('wait', { vehicles: '11', until: 'in_depot' });
    assert.deepEqual([d.ok, d.done, d.vehicles[0].matched], [true, true, true]);
  } finally { fake.state.trainInDepot = false; }
  const l = await run('wait', { vehicles: '12', until: 'loaded', load_pct: 30 });
  assert.deepEqual([l.ok, l.vehicles[0].load_pct], [true, 32]);
  const days = await run('wait', { days: 2 });
  assert.equal(days.ok, true);
  assert.ok(days.game_days >= 2);
  const t = await run('wait', { vehicles: '11', until: 'at_station', timeout_s: 1 });
  assert.deepEqual([t.ok, t.first_error], [false, 'wait_timeout']);
  assert.match(t.error, /not yet: 11 running/);
  await assert.rejects(run('wait', { vehicles: '11' }), /--until/);
  Object.assign(fake.state, { paused: true });
  try { assert.equal((await run('wait', { days: 1 })).first_error, 'paused'); } finally { fake.state.paused = false; fake.state.runningSince = Date.now(); }
});

// ---- G3 / G4 / R5 / G13: vehicles, summary, vehicle -------------------------------------------

test('vehicles: --ids, --min_age_days, --max_profit_this_year, --sort', async () => {
  assert.deepEqual((await run('vehicles', { ids: '12' })).vehicles.map((v) => v.id), [12]);
  assert.deepEqual((await run('vehicles', { min_age_days: 1000 })).vehicles.map((v) => v.id), [11]);
  assert.deepEqual((await run('vehicles', { max_profit_this_year: 0 })).vehicles.map((v) => v.id), [11]);
  assert.deepEqual((await run('vehicles', { sort: '-profit_last_year' })).vehicles.map((v) => v.id), [12, 11]);
  assert.deepEqual((await run('vehicles', { sort: 'reliability' })).vehicles.map((v) => v.id), [11, 12]);
});

test('summary vehicle lines: speed, load and order; buckets; vehicle has a top-level load', async () => {
  const res = await run('summary', { what: 'vehicles' });
  const line = res.vehicles.find((l) => l.includes('id 11 '));
  assert.match(line, /spd 60 load 40\/120 order 2\/2$/);
  assert.equal(res.age_buckets['10-20y'], 1);
  assert.deepEqual(res.reliability_buckets, { '<40%': 0, '40-60%': 0, '60-80%': 1, '80%+': 1 });
  assert.deepEqual(res.low_reliability, []);
  assert.deepEqual((await run('vehicle', { vehicle: 11 })).load, { load: 40, capacity: 120, pct: 33 });
});
