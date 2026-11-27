// Observation and output (0.8.0 batch 6): status/summary headers, companies profit, tiles text,
// stations and events filters, airport-sites --towns, money_after, overview. Pure helpers from
// src/observe.js plus end-to-end runs against the fake admin server, in-process.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeServer } from './fake-server.js';
import { meFromCompanies, tilesText, splitBox, tileBox, filterStations, filterEvents, eventLine, shortMoney } from '../src/observe.js';

let fake, ctx, runCommand;
const run = (name, args) => runCommand(ctx, name, args);

before(async () => {
  fake = await startFakeServer({ password: 'pw' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-agent-obs-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'pw', company: 0, tile_refresh_rows_per_sec: 0 }));
  process.env.OPENTTD_AGENT_HOME = home;
  process.env.OPENTTD_AGENT_LOG = 'error';
  ({ runCommand } = await import('../src/commands.js'));
  ctx = (await import('../src/context.js')).makeContext();
});

after(() => { ctx.close(); fake.server.close(); });

test('meFromCompanies picks the row by id, never row [0]', () => {
  const rows = [{ id: 1, name: 'Rival', money: 5 }, { id: 3, name: 'Me', money: 9, loan: 1, max_loan: 2, value: 3, cargo_delivered: 4, performance: 5, income: 10, expenses: -4 }];
  assert.deepEqual(meFromCompanies(rows, 3), { id: 3, name: 'Me', money: 9, loan: 1, max_loan: 2, value: 3, cargo_delivered: 4, performance: 5, profit: 6 });
  assert.equal(meFromCompanies(rows, 7), null);
  assert.equal(meFromCompanies(rows, null), null);
  assert.equal(shortMoney(2500000), '2.5M');
  assert.equal(shortMoney(-1234), '-1.2k');
});

test('status and summary carry date and me', async () => {
  const st = await run('status', {});
  assert.match(st.date, /^\d{4}-\d\d-\d\d$/);
  assert.equal(st.me.id, 0);
  assert.equal(st.me.money, fake.state.money);
  assert.equal(st.me.profit, 5000);
  const sum = await run('summary', { what: 'stations' });
  assert.equal(sum.date, st.date);
  assert.equal(sum.me.max_loan, st.me.max_loan);
});

test('companies rows and history carry profit; the list carries date', async () => {
  const res = await run('companies', { history: 2 });
  assert.match(res.date, /^\d{4}-\d\d-\d\d$/);
  const me = res.companies.find((c) => c.id === 0);
  assert.equal(me.profit, me.income + me.expenses);
  assert.ok(me.history.length >= 1);
  for (const h of me.history) assert.equal(h.profit, h.income + h.expenses);
});

test('tilesText: one char per tile, rulers, upper case for own tiles', () => {
  const t = tilesText({ x0: 8, y0: 9, x1: 11, y1: 10 }, (x, y) => (x === 10 ? 'r' : 'b'), (x, y) => (x === 10 && y === 9 ? 0 : x === 10 ? 1 : undefined), 0);
  assert.deepEqual(t.x_ruler, ['     11', '   8901']);
  assert.deepEqual(t.rows, [' 9|bbRb', '10|bbrb']);
  assert.equal(splitBox({ x0: 0, y0: 0, x1: 79, y1: 50 }, 40).length, 4);
  assert.deepEqual(tileBox({ x: 2, y: 3, radius: 4 }, 64, 64), { x0: 0, y0: 0, x1: 6, y1: 7 });
  assert.throws(() => tileBox({ x0: 1 }, 64, 64), /bad_arguments/);
});

test('tiles --format text and --radius', async () => {
  const t = await run('tiles', { x: 13, y: 20, radius: 1, format: 'text' });
  assert.equal(t.ok, true, JSON.stringify(t));
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[1].length, '20|'.length + 3);
  assert.match(t.rows[1], /[A-Z]/, 'own tiles upper case');
  assert.match(t.legend, /UPPER case/);
  const big = await run('tiles', { x0: 0, y0: 0, x1: 63, y1: 63, format: 'text' });
  assert.equal(big.rows.length, 64);
  await assert.rejects(run('tiles', { x0: 0, y0: 0, x1: 63, y1: 63 }), /max 40x40/);
  const json = await run('tiles', { x: 13, y: 20, radius: 1 });
  assert.equal(json.rows.length, 3);
});

test('filterStations: ids, near (sorted, distance), unserved, max_vehicles', () => {
  const st = [{ id: 1, x: 10, y: 10, vehicles: 0 }, { id: 2, x: 12, y: 10, vehicles: 3 }, { id: 3, x: 40, y: 40, vehicles: 1 }];
  assert.deepEqual(filterStations(st, { ids: [1, 3] }).map((s) => s.id), [1, 3]);
  const near = filterStations(st, { near_x: 13, near_y: 10, radius: 5 });
  assert.deepEqual(near.map((s) => [s.id, s.distance]), [[2, 1], [1, 3]]);
  assert.deepEqual(filterStations(st, { unserved: true }).map((s) => s.id), [1]);
  assert.deepEqual(filterStations(st, { max_vehicles: 1 }).map((s) => s.id), [1, 3]);
});

test('stations --ids --near_x --near_y --unserved --max_vehicles', async () => {
  assert.deepEqual((await run('stations', { ids: '3,7' })).stations.map((s) => s.id), [3, 7]);
  const near = await run('stations', { near_x: 45, near_y: 9, radius: 5 });
  assert.deepEqual(near.stations.map((s) => [s.id, s.distance]), [[7, 2], [4, 4]]);
  assert.deepEqual((await run('stations', { max_vehicles: 1 })).stations.map((s) => s.id).sort(), [5, 7]);
  assert.equal((await run('stations', { unserved: true })).matched, 0);
  await assert.rejects(run('stations', { near_x: 3 }), /near_x and --near_y together/);
});

test('filterEvents and eventLine', () => {
  const ev = [{ seq: 1, date: '1950-1-3', type: 'industry_open', industry: 9 }, { seq: 2, date: '1950-2-1', type: 'vehicle_crashed', company: 0, vehicle: 11 },
    { seq: 3, date: '1950-2-2', type: 'company_merger', company: 2, old_company: 1 }, { seq: 4, date: '1950-3-1', type: 'subsidy_offer', subsidy: 1 }];
  assert.deepEqual(filterEvents(ev, { types: ['crash', 'subsidy'] }).map((e) => e.seq), [2, 4]);
  assert.deepEqual(filterEvents(ev, { exclude: ['industry', 'subsidy'] }).map((e) => e.seq), [2, 3]);
  assert.deepEqual(filterEvents(ev, { companies: [1] }).map((e) => e.seq), [3]);
  assert.equal(eventLine(ev[1]), 'seq 2 1950-2-1 vehicle_crashed company 0 vehicle 11');
});

test('events --type list, --exclude, --company', async () => {
  assert.equal((await run('events', { type: 'crash,industry' })).events.length, 2);
  assert.deepEqual((await run('events', { exclude: 'industry' })).events.map((e) => e.type), ['vehicle_crashed']);
  assert.deepEqual((await run('events', { company: 0 })).events.map((e) => e.seq), [2]);
  assert.equal((await run('events', { companies: '5' })).events.length, 0);
});

test('airport-sites --towns checks several towns in one call', async () => {
  const res = await run('airport-sites', { towns: 'Smallham,Bigton,Nowhere', limit: 1 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.towns.map((t) => t.town.name), ['Smallham', 'Bigton', 'Nowhere']);
  assert.ok(res.towns[0].sites.length >= 1);
  assert.match(res.towns[2].error, /no town matching/);
  await assert.rejects(run('airport-sites', {}), /--town NAME or --towns/);
});
