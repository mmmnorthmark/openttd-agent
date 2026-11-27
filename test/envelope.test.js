// Result envelope (src/envelope.js) and dry-run signal skips (execSummary).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope, errorCode, listResult, errorResult } from '../src/envelope.js';
import { execSummary, railStepTiles, markDryRunSkips } from '../src/operate.js';
import { passingLoopSteps, terminusSteps } from '../src/planner.js';

test('errorCode: ERR_ codes, own snake_case codes, refusals', () => {
  assert.equal(errorCode('ERR_AREA_NOT_CLEAR'), 'ERR_AREA_NOT_CLEAR');
  assert.equal(errorCode('step 3 (rail): ERR_LAND_SLOPED_WRONG'), 'ERR_LAND_SLOPED_WRONG');
  assert.equal(errorCode('no_signal_here: tile 4,5 has no signal'), 'no_signal_here');
  assert.equal(errorCode('refused: depot is far'), 'refused');
  assert.equal(errorCode('something odd'), 'failed');
});

test('envelope: ok and error on every result; failures get first_error', () => {
  assert.deepEqual(envelope({ a: 1 }), { ok: true, error: null, a: 1 });
  assert.deepEqual(envelope({ ok: true, error: '', a: 1 }), { ok: true, error: null, a: 1 });
  assert.deepEqual(envelope({ ok: false, error: 'refused: no' }), { ok: false, error: 'refused: no', first_error: 'refused' });
  assert.deepEqual(envelope({ error: 'ERR_X' }), { ok: false, error: 'ERR_X', first_error: 'ERR_X' });
  assert.deepEqual(envelope([1, 2]), { ok: true, error: null, total: 2, matched: 2, items: [1, 2], truncated: false });
  assert.deepEqual(listResult('towns', [1, 2, 3], [1, 2], 1), { ok: true, error: null, total: 3, matched: 2, towns: [1], truncated: true });
  assert.deepEqual(errorResult('refused: x'), { ok: false, error: 'refused: x', first_error: 'refused' });
});

test('railStepTiles: straight runs exclude the end anchor; curves are one tile', () => {
  assert.deepEqual(railStepTiles(['rail', 0, 0, 1, 0, 4, 0]), [[1, 0], [2, 0], [3, 0]]);
  assert.deepEqual(railStepTiles(['rail', 0, 0, 1, 0, 1, 1]), [[1, 0]]);
});

test('dry run: signals on track the same list lays are skipped, not failures', () => {
  const t = terminusSteps({ x: 10, y: 10, axis: 'x', platforms: 2, length: 4 });
  const reply = [{ cost: 100, money: 5000, stopped: '' }, ...t.steps.map((st) => (st[0] === 'signal' ? [false, 0, 'ERR_PRECONDITION_FAILED', 0] : [true, 10, '', 0]))];
  const res = execSummary(t.steps, [reply], true);
  assert.equal(res.ok, true);
  assert.equal(res.error, null);
  assert.equal(res.skipped_in_dry_run, 2);
  assert.ok(res.results.filter((r) => r.op === 'signal').every((r) => r.skipped_in_dry_run && r.dry_run_error === 'ERR_PRECONDITION_FAILED'));
  // A real failure still fails the dry run.
  reply[2] = [false, 0, 'ERR_AREA_NOT_CLEAR', 0];
  const bad = execSummary(t.steps, [reply], true);
  assert.equal(bad.ok, false);
  assert.equal(bad.first_error, 'ERR_AREA_NOT_CLEAR');
  // A signal on track that already exists elsewhere (not laid by this list) is a real failure.
  const lone = [['signal', 50, 50, 51, 50, 4]];
  const r2 = markDryRunSkips(lone, [{ step: 0, op: 'signal', ok: false, error: 'ERR_PRECONDITION_FAILED' }]);
  assert.equal(r2[0].ok, false);
  // Passing loop: both signals sit on track the template lays.
  const loop = passingLoopSteps({ x: 5, y: 5, dir: 0, length: 6 });
  const lr = [{ cost: 0, money: 0, stopped: '' }, ...loop.steps.map((st) => (st[0] === 'signal' ? [false, 0, 'ERR_PRECONDITION_FAILED', 0] : [true, 1, '', 0]))];
  assert.equal(execSummary(loop.steps, [lr], true).ok, true);
});

test('real run: a stop by the rate gate is an error even without a failed row', () => {
  const res = execSummary([['rail', 0, 0, 1, 0, 2, 0], ['rail', 0, 0, 1, 0, 2, 0]], [[{ cost: 1, money: 1, stopped: 'rate limit: 5 build commands per game day reached for company 0' }, [true, 1, '', 0]]], false);
  assert.equal(res.ok, false);
  assert.match(res.error, /rate limit/);
});
