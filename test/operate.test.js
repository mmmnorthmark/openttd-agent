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
  const all = await run('stations', {});
  assert.deepEqual(all[1].facilities, ['truck', 'bus']);
  assert.deepEqual(all[0].cargo[0], { cargo: 7, name: 'Wood', waiting: 240, rating_pct: 35 });
  const poor = await run('stations', { max_rating_pct: 50, min_waiting: 100 });
  assert.deepEqual(poor.map((s) => s.id), [3]);
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
  assert.deepEqual(engines.map((e) => e.id), [6, 5, 27]);
  assert.deepEqual((await run('engines', { type: 'rail', wagons: true })).map((e) => e.name), ['Wood Truck']);
  await assert.rejects(run('engines', { type: 'rail', cargo: 'unobtainium' }), /no cargo matching/);
  assert.equal((await run('groups', {}))[0].profit_last_year, -3000);
  assert.deepEqual(await run('depots', { type: 'rail' }), [{ x: 13, y: 22, vehicles: 0 }]);
});

test('events: since filter and latest_seq', async () => {
  const first = await run('events', {});
  assert.equal(first.latest_seq, 2);
  const next = await run('events', { since: first.latest_seq });
  assert.deepEqual(next, { latest_seq: 2, my_company: 0, events: [] });
  assert.equal((await run('events', { type: 'crash' })).events.length, 1);
});

test('vehicle-buy sends one step per vehicle and returns new ids; dry_run is passed on', async () => {
  const res = await run('vehicle-buy', { depot_x: 13, depot_y: 22, engine: 27, cargo: 'wood', attach_to: 11, count: 3 });
  assert.equal(res.ok, true);
  assert.deepEqual(res.vehicles, [100, 101, 102]);
  assert.equal(res.cost, 30);
  assert.deepEqual(lastExec().steps[0], ['veh_buy', 13, 22, 27, 7, 11]);
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
  assert.equal(res.first_error, 'Vehicle not available');
  assert.equal(res.results[1].ok, false);
  const g = await run('group-create', { type: 'rail', name: 'Wood line' });
  assert.equal(g.group, 100);
  assert.deepEqual(lastExec().steps, [['group_create', 0, 'Wood line', -1]]);
  const ar = await run('group-autoreplace', { group: 2, old_engine: 5, new_engine: 6 });
  assert.equal(ar.ok, true);
  assert.equal((await run('autorenew', {})).months, 6);
});
