// vehicle-problems checks (src/problems.js): progress history and the problem rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordProgress, vehicleProblems } from '../src/problems.js';

const train = (over = {}) => ({ id: 31, unit_number: 4, type: 'rail', state: 'running', x: 22, y: 7, order_count: 2, current_order: 0,
  dest: { x: 10, y: 10 }, dest_station: 4, dest_name: 'North', dist: 15, speed: 50, age_days: 400, age_pct: 20,
  reliability_pct: 80, profit_last_year: 500, ...over });

test('recordProgress: same order and no closer for N days = no progress; a new order or a new best resets', () => {
  const h = new Map();
  recordProgress(h, 'v', { date: 100, order: 0, dist: 20 });
  assert.equal(recordProgress(h, 'v', { date: 110, order: 0, dist: 25 }).since, 100, 'further away: no progress');
  assert.equal(recordProgress(h, 'v', { date: 120, order: 0, dist: 18 }).since, 120, 'closer than ever: progress');
  assert.equal(recordProgress(h, 'v', { date: 130, order: 0, dist: 19 }).since, 120);
  assert.equal(recordProgress(h, 'v', { date: 140, order: 1, dist: 40 }).since, 140, 'next order: progress');
  assert.equal(recordProgress(h, 'v', { date: 150, order: 1, dist: 40, atStation: true }).since, 150, 'loading at a station is not lost');
  const e = h.get('v');
  assert.equal(e.first, 100);
  assert.equal(e.samples, 6);
});

test('vehicleProblems: a healthy train has none', () => {
  assert.deepEqual(vehicleProblems(train(), { today: 200, progress: { since: 190, best: 15 } }), []);
});

test('vehicleProblems: lost train on another line, without income', () => {
  const v = train({ profit_last_year: -863, age_days: 1000 });
  const reach = { connected: false, method: 'rail_tracks', last_reachable: { x: 22, y: 10 }, first_gap: { x: 21, y: 10, reason: 'depot_entrance_faces_away' } };
  const out = vehicleProblems(v, { today: 300, stuckDays: 30, progress: { since: 250, best: 12 }, reach, line: { connected: true } });
  assert.deepEqual(out.map((p) => p.problem), ['wrong_network', 'stuck_or_lost', 'no_income']);
  assert.match(out[0].evidence, /North \(10,10\).*ends at \(22,10\).*\(21,10\) \(depot_entrance_faces_away\)/);
  assert.match(out[0].suggested_fix, /vehicle-depot --vehicles 31/);
  assert.match(out[1].evidence, /50 days without getting closer than 12 tiles/);
  assert.match(out[2].suggested_fix, /fix the problems above first/);
});

test('vehicleProblems: broken line, idle and old vehicles', () => {
  const broken = vehicleProblems(train(), { today: 10, reach: { connected: false, method: 'mirror_adjacency' }, line: { connected: false } });
  assert.deepEqual(broken.map((p) => p.problem), ['unreachable_destination']);
  assert.match(broken[0].evidence, /coarse/);
  assert.deepEqual(vehicleProblems(train({ order_count: 0, state: 'in_depot' }), { today: 10 }).map((p) => p.problem), ['no_orders', 'stopped_in_depot']);
  assert.deepEqual(vehicleProblems(train({ age_pct: 104, reliability_pct: 30 }), { today: 10 }).map((p) => p.problem), ['old', 'low_reliability']);
  assert.deepEqual(vehicleProblems(train({ state: 'broken' }), { today: 10 }).map((p) => p.problem), ['broken_down']);
  const waiting = vehicleProblems(train({ speed: 0 }), { today: 100, stuckDays: 30, progress: { since: 40, best: 3 } });
  assert.match(waiting[0].suggested_fix, /red signal/);
});

test('breakdowns, low reliability and old age are info; the fix does not stop a running train', () => {
  const info = vehicleProblems(train({ state: 'broken', age_pct: 104 }), { today: 10 });
  assert.deepEqual(info.map((p) => [p.problem, p.severity]), [['old', 'info'], ['broken_down', 'info']]);
  const low = vehicleProblems(train({ reliability_pct: 30 }), { today: 10 });
  assert.equal(low[0].severity, 'info');
  assert.match(low[0].suggested_fix, /^none needed.*--vehicles 31 --service true/);
  assert.equal(vehicleProblems(train({ state: 'in_depot' }), { today: 10 })[0].severity, 'action');
});

test('stall samples: standing still on one tile builds up, moving clears; two near each other = deadlock', async () => {
  const { recordStall, deadlockPartners } = await import('../src/problems.js');
  const h = new Map();
  assert.equal(recordStall(h, 'a', { date: 100, x: 5, y: 5, speed: 0, state: 'at_station' }), null);
  recordStall(h, 'a', { date: 100, x: 5, y: 5, speed: 0, state: 'running' });
  const e = recordStall(h, 'a', { date: 115, x: 5, y: 5, speed: 0, state: 'running' });
  assert.deepEqual([e.since, e.samples], [100, 2]);
  assert.equal(recordStall(h, 'a', { date: 116, x: 6, y: 5, speed: 30, state: 'running' }), null);
  assert.equal(h.has('a'), false);
  const v = { id: 7, x: 5, y: 5, type: 'rail', state: 'running', order_count: 2, profit_last_year: 0, age_days: 10, age_pct: 1, reliability_pct: 90, speed: 0 };
  const stalled = vehicleProblems(v, { today: 115, stall: { x: 5, y: 5, since: 100, samples: 2 }, stallDays: 10 });
  assert.deepEqual(stalled.map((p) => p.problem), ['stalled_on_line']);
  const partners = deadlockPartners([{ id: 7, x: 5, y: 5, type: 'rail' }, { id: 8, x: 9, y: 6, type: 'rail' }, { id: 9, x: 60, y: 60, type: 'rail' }]);
  assert.deepEqual([partners.get(7), partners.get(8), partners.get(9)], [[8], [7], undefined]);
  const dl = vehicleProblems(v, { today: 115, stall: { x: 5, y: 5, since: 100, samples: 2 }, stallDays: 10, partners: [8] });
  assert.equal(dl[0].problem, 'deadlock');
  assert.match(dl[0].suggested_fix, /vehicle-reverse --vehicles 7/);
  // Too short a stall: nothing.
  assert.deepEqual(vehicleProblems(v, { today: 105, stall: { x: 5, y: 5, since: 100, samples: 2 }, stallDays: 10 }), []);
});

test('parked days in stopped_in_depot; loose wagons', () => {
  const parked = vehicleProblems(train({ state: 'in_depot' }), { today: 50, parkedDays: 40 });
  assert.match(parked.find((p) => p.problem === 'stopped_in_depot').evidence, /parked for 40 days/);
  const loose = vehicleProblems(train({ state: 'in_depot', unit_number: -1 }), { today: 50 });
  assert.deepEqual(loose.map((p) => p.problem), ['loose_wagons']);
});

test('stuck_or_lost on a connected trace says not lost and never suggests a depot (L7)', async () => {
  const { vehicleProblems } = await import('../src/problems.js');
  const v = { id: 4, type: 'rail', state: 'running', order_count: 2, current_order: 1, dest: { x: 50, y: 5 }, dest_name: 'B', dist: 40, speed: 30, profit_last_year: 0, age_days: 10, age_pct: 1, reliability_pct: 90, x: 10, y: 5 };
  const [p] = vehicleProblems(v, { today: 100, stuckDays: 30, progress: { since: 10, best: 40 }, reach: { connected: true } });
  assert.equal(p.problem, 'stuck_or_lost');
  assert.match(p.evidence, /not lost/);
  assert.doesNotMatch(p.suggested_fix, /vehicle-depot/);
  assert.match(p.suggested_fix, /loop-sites/);
});
