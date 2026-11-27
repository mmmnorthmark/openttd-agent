// Output contract (src/output.js): reserved args, failed-only exec results, fields, brief, compact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeOutputArgs, shapeResult, projectFields, briefResult, formatResult, compactDefault } from '../src/output.js';

const exec = () => ({ ok: false, error: 'step 1 (veh_sell): no', first_error: 'failed', dry_run: false, steps_total: 3, steps_done: 2, cost: 5, money: 90,
  results: [{ step: 0, op: 'veh_sell', ok: true, cost: 2 }, { step: 1, op: 'veh_sell', ok: false, cost: 0, error: 'no', value: 1048575 }, { step: 2, op: 'veh_sell', ok: true, cost: 3, value: 7 }] });

test('takeOutputArgs: strips reserved keys, keeps a command\'s own key of the same name, refuses bad values', () => {
  const { args, output } = takeOutputArgs({ x: 1, fields: 'a, b.c', brief: 'true', compact: false, steps: 'all' });
  assert.deepEqual(args, { x: 1 });
  assert.deepEqual(output, { fields: ['a', 'b.c'], brief: true, compact: false, steps: 'all' });
  assert.deepEqual(takeOutputArgs({ compact: 'true' }, ['compact']).args, { compact: 'true' }, 'the command defines compact itself');
  assert.deepEqual(takeOutputArgs({ fields: null }).output.fields, null);
  assert.throws(() => takeOutputArgs({ steps: 'some' }), /^Error: bad_arguments: --steps/);
  assert.throws(() => takeOutputArgs({ brief: 'maybe' }), /bad_arguments: --brief must be true or false/);
});

test('shapeResult: exec results list only failed steps (without value) unless steps=all', () => {
  const r = shapeResult(exec());
  assert.equal(r.results, undefined);
  assert.deepEqual(r.results_failed, [{ step: 1, op: 'veh_sell', ok: false, cost: 0, error: 'no' }]);
  assert.deepEqual([r.steps_done, r.steps_total], [2, 3]);
  const all = shapeResult(exec(), { steps: 'all' });
  assert.equal(all.results.length, 3);
  assert.equal(all.results[1].value, undefined, 'L9: a failed row has no value');
  assert.equal(all.results[2].value, 7);
  assert.deepEqual(shapeResult({ ok: true, error: null, n: 1 }), { ok: true, error: null, n: 1 }, 'no results list: unchanged');
});

test('projectFields: top-level paths, dotted paths into lists, item fields on every list, unknown names', () => {
  const res = { ok: true, error: null, total: 2, towns: [{ id: 1, name: 'A', pop: 5, at: { x: 1, y: 2 } }, { id: 2, name: 'B', pop: 9, at: { x: 3, y: 4 } }] };
  assert.deepEqual(projectFields(res, ['total', 'towns.name']), { ok: true, error: null, total: 2, towns: [{ name: 'A' }, { name: 'B' }] });
  assert.deepEqual(projectFields(res, ['id', 'at.x']), { ok: true, error: null, towns: [{ id: 1, at: { x: 1 } }, { id: 2, at: { x: 3 } }] });
  assert.deepEqual(projectFields(res, ['nope']).fields_unknown, ['nope']);
  const failed = { ok: false, error: 'x', first_error: 'failed', hint: 'do y' };
  assert.deepEqual(shapeResult(failed, { fields: ['total'] }), failed, 'failures are not projected');
});

test('briefResult: ok, cost, money, ids; failures keep error and first_error', () => {
  assert.deepEqual(briefResult({ ok: true, error: null, cost: 10, money: 5, vehicles: [3, 4], group: 7, stations: [{ id: 1 }], extra: 'x' }),
    { ok: true, cost: 10, money: 5, ids: { vehicles: [3, 4], group: 7 } });
  assert.deepEqual(shapeResult(exec(), { brief: true }), { ok: false, error: 'step 1 (veh_sell): no', first_error: 'failed', cost: 5, money: 90 });
  assert.deepEqual(briefResult({ ok: true, error: null, station: { id: 9, name: 'S' } }).ids, { station: 9 });
});

test('formatResult and compactDefault', () => {
  assert.equal(formatResult({ a: 1 }, true), '{"a":1}');
  assert.equal(formatResult({ a: 1 }, false), '{\n  "a": 1\n}');
  assert.equal(compactDefault({}, false), true, 'piped: compact');
  assert.equal(compactDefault({}, true), false, 'terminal: indented');
  assert.equal(compactDefault({ OPENTTD_AGENT_COMPACT: '0' }, false), false);
  assert.equal(compactDefault({ OPENTTD_AGENT_COMPACT: 'true' }, true), true);
});
