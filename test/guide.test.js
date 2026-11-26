// guide: pure step logic (buildGuide) with fake probe results. No network, no game.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGuide, inferRole, nextStep } from '../src/guide.js';

const doctorOk = { ok: true, openttd_found: true, openttd_version: '15.3', gamescript_installed: 9, gamescript_bundled: 9 };
const byId = (g) => Object.fromEntries(g.steps.map((s) => [s.id, s.done]));

test('role is inferred from the config', () => {
  assert.equal(inferRole({ relay: true, admin_password: true }), 'player');
  assert.equal(inferRole({ admin_password: true }), 'host');
  assert.equal(inferRole({ launch_profile: true }), 'host');
  assert.equal(inferRole({}), 'unknown');
});

test('fresh machine: both parts, next is doctor when OpenTTD is missing, else the role choice', () => {
  const missing = buildGuide(undefined, { config: {}, doctor: { ...doctorOk, openttd_found: false } });
  assert.equal(missing.role, 'unknown');
  assert.equal(missing.next.id, 'doctor');
  assert.ok(missing.steps.some((s) => s.part === 'host') && missing.steps.some((s) => s.part === 'player'));
  assert.equal(buildGuide(undefined, { config: {}, doctor: doctorOk }).next.id, 'role');
});

test('host: walks launch -> relay -> players -> binding', () => {
  const base = { config: { admin_password: true, relay_port: 47978 }, doctor: doctorOk, lan_ips: ['192.0.2.10'] };
  const down = buildGuide('host', { ...base, game: { ok: false, error: 'admin connect failed' }, relay_local: { ok: false }, players: [] });
  assert.equal(down.next.id, 'launch');
  assert.equal(down.next.detail, 'admin connect failed');
  assert.match(down.steps.find((s) => s.id === 'network').command, /192\.0\.2\.10:3979/);

  const up = { ...base, game: { ok: true, companies: [0], goals: { 0: 'none' } } };
  assert.equal(buildGuide('host', { ...up, relay_local: { ok: false }, players: [] }).next.id, 'relay');
  assert.equal(buildGuide('host', { ...up, relay_local: { ok: true }, players: [] }).next.id, 'relay-add-player');

  const pending = buildGuide('host', { ...up, relay_local: { ok: true }, players: [{ name: 'joe', company: 'pending' }] });
  assert.equal(pending.next.id, 'relay-set-company');
  assert.match(pending.next.command, /--name joe/);

  const wrongId = buildGuide('host', { ...up, relay_local: { ok: true }, players: [{ name: 'joe', company: 3 }] });
  assert.equal(byId(wrongId)['relay-set-company'], false, 'bound to a company that does not exist');

  const two = { ...base, game: { ok: true, companies: [0, 1], goals: { 0: 'active', 1: 'none' } }, relay_local: { ok: true } };
  const bound = buildGuide('host', { ...two, players: [{ name: 'joe', company: 1 }, { name: 'ann', company: 0 }] });
  assert.equal(bound.next.id, 'goal-set', 'only the optional goal is left');
  assert.equal(byId(bound).join, true);
  const allGoals = buildGuide('host', { ...two, game: { ...two.game, goals: { 0: 'active', 1: 'done' } }, players: [{ name: 'joe', company: 1 }] });
  assert.equal(allGoals.next, null);
  assert.ok(allGoals.note);
});

test('host: more players registered than companies means someone has not joined yet', () => {
  const g = buildGuide('host', { config: { admin_password: true }, doctor: doctorOk, game: { ok: true, companies: [0], goals: {} },
    relay_local: { ok: true }, players: [{ name: 'a', company: 0 }, { name: 'b', company: 'pending' }] });
  assert.equal(byId(g).join, false);
  assert.equal(g.next.id, 'join');
});

test('host: unknown probes stay null, not false', () => {
  const g = buildGuide('host', { config: { admin_password: true }, players: [] });
  const d = byId(g);
  assert.equal(d.doctor, null);
  assert.equal(d.launch, null);
  assert.equal(d.join, null);
  assert.equal(d['goal-set'], null);
  assert.equal(d.network, null);
});

test('player: configure -> relay -> version -> token -> company', () => {
  const p = (extra) => buildGuide('player', { doctor: doctorOk, ...extra }, '1.2.3');
  assert.equal(p({ config: { relay: false, token: false } }).next.id, 'configure');
  const unreachable = p({ config: { relay: true, token: true }, relay: { ok: false, error: 'cannot reach the relay' } });
  assert.equal(unreachable.next.id, 'relay');
  assert.equal(unreachable.next.detail, 'cannot reach the relay');
  const old = p({ config: { relay: true, token: true }, relay: { ok: true, version: '1.2.4' } });
  assert.equal(old.next.id, 'version');
  assert.match(old.next.command, /openttd-agent#v1\.2\.4 guide/);
  const badToken = p({ config: { relay: true, token: true }, relay: { ok: true, version: '1.2.3' }, status: { ok: false, error: 'relay: missing or unknown token' } });
  assert.equal(badToken.next.id, 'status');
  const unbound = p({ config: { relay: true, token: true }, relay: { ok: true, version: '1.2.3' }, status: { ok: true, my_company: null } });
  assert.equal(unbound.next.id, 'company');
  const ready = p({ config: { relay: true, token: true }, relay: { ok: true, version: '1.2.3' }, status: { ok: true, my_company: 1 } });
  assert.equal(ready.next, null);
  assert.match(ready.steps.at(-1).command, /^claude mcp add openttd -- npx -y github:mmmnorthmark\/openttd-agent#v1\.2\.3 mcp$/);
});

test('nextStep prefers a required step over an optional one', () => {
  assert.equal(nextStep([{ id: 'a', done: false, optional: true }, { id: 'b', done: null }, { id: 'c', done: false }]).id, 'c');
  assert.equal(nextStep([{ id: 'a', done: false, optional: true }]).id, 'a');
  assert.equal(nextStep([{ id: 'a', done: true }, { id: 'b', done: null }]), null);
});

test('guide output never carries secrets', () => {
  const g = buildGuide(undefined, { config: { relay: true, token: true, admin_password: true }, doctor: doctorOk, relay: { ok: true, version: '0.0.0' }, status: { ok: true, my_company: 0 } });
  const text = JSON.stringify(g);
  assert.doesNotMatch(text, /admin_password"|relay_token|Bearer/);
});
