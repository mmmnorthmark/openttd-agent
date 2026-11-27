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
