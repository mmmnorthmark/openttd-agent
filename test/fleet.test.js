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
