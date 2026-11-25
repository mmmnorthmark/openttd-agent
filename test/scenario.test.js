// Pure parts of scenario-prepare: console output parsing and choosing the scenario.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContentLine, pickContent, parseScenarioList, pickScenarioEntry, saveSlug } from '../src/scenario.js';

const LINES = [
  'id, type, state, name',
  '2501712, Scenario, Not selected, China and Asia (mini), 00000D10, AE12445762F0371E3216CC42F1502C26',
  '15847807, Scenario, Installed, Mini Empire Builder on 64x64, 00001918, 0F2E22AA3AA3166101411842C87FD1F1',
  '15847808, Scenario, Not selected, Mini Empire Builder on 64x64, part 2, 00001919, 0F2E22AA3AA3166101411842C87FD1F2',
  '5724741, NewGRF, Not selected, U&RaTT: Mini, 55464988, FDEDA37F51092F1004F7459E75455A57',
];
const rows = LINES.map(parseContentLine).filter(Boolean);

test('parseContentLine reads console rows, including names with commas, and skips the header', () => {
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], { id: 15847807, type: 'Scenario', state: 'Installed', name: 'Mini Empire Builder on 64x64', unique_id: '00001918' });
  assert.equal(rows[2].name, 'Mini Empire Builder on 64x64, part 2');
});

test('pickContent: by id, by unique text, exact name wins, otherwise lists candidates', () => {
  assert.equal(pickContent(rows, { contentId: 2501712 }).name, 'China and Asia (mini)');
  assert.equal(pickContent(rows, { search: 'china' }).id, 2501712);
  assert.equal(pickContent(rows, { search: 'mini empire builder on 64x64' }).id, 15847807, 'exact name beats the longer one');
  assert.throws(() => pickContent(rows, { search: 'mini' }), /3 scenarios match 'mini'; pass --content_id <id>\. 2501712 China and Asia \(mini\); 15847807 Mini/);
  assert.throws(() => pickContent(rows, { search: 'zzz' }), /no scenario on BaNaNaS matches 'zzz'/);
  assert.throws(() => pickContent(rows, { contentId: 5724741 }), /no scenario with content id 5724741/, 'a NewGRF id is not a scenario');
});

test('pickScenarioEntry matches "<name> (<version>)" and prefers the entry the download added', () => {
  const list = parseScenarioList(['0) Europe (2.1)', '1) Mini Empire Builder on 64x64 (1.0)', 'noise']);
  assert.deepEqual(list[1], { index: 1, title: 'Mini Empire Builder on 64x64 (1.0)' });
  assert.equal(pickScenarioEntry(list, 'Mini Empire Builder on 64x64').index, 1);
  const two = parseScenarioList(['0) Alps (1.0)', '1) Alps (2.0)']);
  assert.equal(pickScenarioEntry(two, 'Alps', ['Alps (1.0)']).index, 1, 'the new version');
  assert.throws(() => pickScenarioEntry(two, 'Alps'), /cannot tell which scenario.*0\) Alps \(1\.0\); 1\) Alps \(2\.0\)/);
  assert.equal(pickScenarioEntry(parseScenarioList(['0) Europe (2.1)', '1) Odd title']), 'Renamed on BaNaNaS', ['Europe (2.1)']).index, 1, 'only new entry');
  assert.throws(() => pickScenarioEntry(list, 'Missing', list.map((e) => e.title)), /cannot tell/);
});

test('saveSlug makes console-safe save names', () => {
  assert.equal(saveSlug('Mini Empire Builder on 64x64'), 'mini_empire_builder_on_64x64');
  assert.equal(saveSlug('  Ünïcode & Co. (v2)  '), 'n_code_co_v2');
  assert.equal(saveSlug('!!!'), 'scenario');
});
