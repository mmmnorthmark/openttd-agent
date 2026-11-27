// Host relay against the fake admin server: token auth, company forcing,
// host-only refusals, per-player rate limit, audit log, and the player-side CLI.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startFakeServer } from './fake-server.js';

const run = promisify(execFile);
const BIN = path.resolve('bin/openttd-agent.js');
let fake, relay, url, hostHome, playerHome, tokens, players, relayMod, COMMANDS;

before(async () => {
  fake = await startFakeServer({ password: 'host-only-pw' });
  hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-relay-host-'));
  playerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-relay-player-'));
  fs.writeFileSync(path.join(hostHome, 'config.json'), JSON.stringify({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'host-only-pw', tile_refresh_rows_per_sec: 0 }));
  process.env.OPENTTD_AGENT_HOME = hostHome; // must be set before config.js is first imported
  process.env.OPENTTD_AGENT_LOG = 'error';
  players = await import('../src/relay-players.js');
  relayMod = await import('../src/relay.js');
  ({ COMMANDS } = await import('../src/commands.js'));
  tokens = {
    alice: players.addPlayer({ name: 'alice', company: '0' }).token,
    bob: players.addPlayer({ name: 'bob', company: 'pending' }).token,
    carol: players.addPlayer({ name: 'carol', company: 1, maxBuildsPerMinute: 1 }).token,
  };
  relay = await relayMod.startRelay({ port: 0, bind: '127.0.0.1' });
  url = `http://127.0.0.1:${relay.port}`;
});

after(() => {
  relay.close();
  fake.server.close();
});

async function call(token, name, args = {}) {
  const res = await fetch(`${url}/call`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ name, args }),
  });
  return { status: res.status, ...(await res.json()) };
}
const auditLines = () => fs.readFileSync(relayMod.AUDIT_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('player file keeps only a hash, mode 0600', () => {
  const text = fs.readFileSync(players.PLAYERS_FILE, 'utf8');
  for (const t of Object.values(tokens)) assert.ok(!text.includes(t), 'token must not be stored');
  assert.match(JSON.parse(text).players[0].token_sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(players.PLAYERS_FILE).mode & 0o777, 0o600);
  assert.deepEqual(players.listPlayers().map((p) => [p.name, p.company]), [['alice', 0], ['bob', 'pending'], ['carol', 1]]);
  assert.throws(() => players.addPlayer({ name: 'alice', company: 2 }), /already exists/);
  assert.throws(() => players.addPlayer({ name: 'bad name', company: 2 }), /name must be/);
});

test('token auth: missing and unknown tokens get 401, a valid one works', async () => {
  const before = fake.received.length;
  assert.equal((await call(null, 'status')).status, 401);
  const bad = await call('not-a-real-token', 'status');
  assert.equal(bad.status, 401);
  assert.match(bad.error, /unknown token/);
  assert.equal(fake.received.length, before, 'nothing reaches the game without a token');
  const ok = await call(tokens.alice, 'status');
  assert.equal(ok.ok, true);
  assert.equal(ok.result.my_company, 0);
  assert.equal((await fetch(`${url}/health`).then((r) => r.json())).service, 'openttd-agent-relay');
});

test('company is forced to the player\'s; an explicit other company is refused', async () => {
  const mine = await call(tokens.alice, 'build-road', { x1: 1, y1: 1, x2: 5, y2: 1 });
  assert.equal(mine.ok, true);
  assert.equal(fake.received.at(-1).args.company, 0);
  const same = await call(tokens.alice, 'build-road', { x1: 1, y1: 1, x2: 5, y2: 1, company: '0' });
  assert.equal(same.ok, true);
  const carol = await call(tokens.carol, 'build-road', { x1: 1, y1: 1, x2: 5, y2: 1 });
  assert.equal(carol.ok, true);
  assert.equal(fake.received.at(-1).args.company, 1);
  const before = fake.received.length;
  const other = await call(tokens.alice, 'build-road', { x1: 1, y1: 1, x2: 5, y2: 1, company: 1 });
  assert.equal(other.status, 403);
  assert.match(other.error, /bound to company 0 and cannot act as company 1/);
  const steal = await call(tokens.alice, 'vehicle', { vehicle: 11, company: 1 });
  assert.equal(steal.status, 403);
  assert.match(steal.error, /only be read with: stations, vehicles/);
  assert.equal(fake.received.length, before, 'refused requests never reach the game');
  // Rival reads: what the game window shows anyone.
  const rv = await call(tokens.alice, 'vehicles', { company: 1 });
  assert.equal(rv.ok, true);
  assert.equal(rv.result.vehicles, undefined, 'no per-vehicle detail of another company');
  assert.deepEqual([rv.result.company, rv.result.total, rv.result.by_state], [1, 2, undefined]);
  assert.equal(fake.received.at(-1).args.company, 1);
  const rs = await call(tokens.alice, 'stations', { company: '1' });
  assert.equal(rs.result.company, 1);
  assert.equal(rs.result.stations[0].vehicles, undefined);
  assert.equal(rs.result.stations[0].cargo[0].rating_pct, 35);
  const own = await call(tokens.alice, 'stations', {});
  assert.equal(own.result.stations[0].vehicles, 2);
});

test('every command that changes the game or reads company data takes a company (so the relay can force it)', () => {
  const noCompany = COMMANDS.filter((c) => c.session && ['build', 'operate'].includes(c.group) && !('company' in c.args.shape)).map((c) => c.name);
  assert.deepEqual(noCompany.sort(), ['bridge-types', 'events'], 'new company-less build/operate commands need a relay policy decision');
  for (const c of COMMANDS) if ('dry_run' in c.args.shape && c.session) assert.ok('company' in c.args.shape, `${c.name} has dry_run but no company`);
});

test('every host and setup command is host-only in the relay policy', () => {
  for (const c of COMMANDS.filter((x) => ['host', 'setup', 'relay'].includes(x.group))) {
    assert.throws(() => relayMod.authorize({ name: 'p', company: 0 }, c.name, {}), relayMod.Refused, c.name);
  }
});

test('host-only commands are refused for players', async () => {
  for (const [name, args] of [['launch', { mode: 'dedicated', admin_password: 'sent-by-player' }], ['install-gamescript', {}], ['configure', { admin_password: 'x' }],
    ['show-config', {}], ['relay-add-player', { name: 'eve', company: 0 }], ['relay-list-players', {}], ['relay-stats', {}], ['rate', { max_builds_per_day: 1 }], ['rcon', { command: 'quit' }], ['scenario-prepare', { search: 'mini' }], ['goal-set', { deadline_year: 1960, targets: 'PASS:1' }], ['goal-clear', {}], ['pause', {}], ['unpause', {}], ['turn-advance', { days: 1 }], ['save', { name: 'x' }],
    ['load', { name: 'x' }], ['saves', {}], ['company-new', {}], ['server-stop', {}], ['console', { command: 'quit' }], ['server-log', {}], ['install-gamescript', { reload: true }]]) {
    const r = await call(tokens.alice, name, args);
    assert.equal(r.status, 403, name);
    assert.match(r.error, /relay refused/, name);
  }
  assert.equal(fake.received.some((q) => q.cmd === 'set_rate'), false);
  assert.equal((await call(tokens.alice, 'rate')).ok, true, 'reading the rate is allowed');
  assert.equal(players.listPlayers().some((p) => p.name === 'eve'), false);
});

test('owned land through the relay: purchase-land, owned-land and airport-sites act as the player\'s company', async () => {
  const buy = await call(tokens.carol, 'purchase-land', { x0: 3, y0: 3, x1: 2, y1: 2, dry_run: true });
  assert.equal(buy.ok, true);
  assert.equal(buy.result.company, 1);
  assert.deepEqual(fake.received.at(-1).args.steps, [['buy_land', 2, 2, 3, 3]]);
  assert.equal(fake.received.at(-1).args.company, 1);
  assert.equal((await call(tokens.alice, 'purchase-land', { x0: 2, y0: 2, x1: 3, y1: 3, company: 1 })).status, 403);
  const owned = await call(tokens.carol, 'owned-land', {});
  assert.equal(owned.ok, true);
  assert.equal(owned.result.company, 1);
  assert.equal((await call(tokens.alice, 'owned-land', { company: 1 })).status, 403);
  await call(tokens.carol, 'airport-sites', { town: 'Smallham', limit: 1 });
  const checks = fake.received.filter((q) => q.cmd === 'check_airport' || q.cmd === 'owned_land').slice(-2);
  assert.ok(checks.length === 2 && checks.every((q) => q.args.company === 1), 'airport-sites uses the player\'s company');
});

test('goal-status is served, as the player\'s own company only', async () => {
  const mine = await call(tokens.alice, 'goal-status');
  assert.equal(mine.ok, true);
  assert.equal(mine.result.company, 0);
  assert.equal(fake.received.at(-1).args.company, 0);
  assert.equal((await call(tokens.alice, 'goal-status', { company: 1 })).status, 403);
});

test('pending player: world queries work, company commands wait for the host to bind', async () => {
  const pairs = await call(tokens.bob, 'find-cargo-pairs', { cargo: 'wood', min_distance: 10, max_distance: 200, max_transported_pct: 50 });
  assert.equal(pairs.ok, true);
  assert.equal(pairs.result.pairs[0].route.reachable, true, 'analysis runs on the relay\'s map mirror');
  const build = await call(tokens.bob, 'build-road', { x1: 1, y1: 1, x2: 5, y2: 1 });
  assert.equal(build.status, 403);
  assert.match(build.error, /not bound to a company yet/);
  players.updatePlayer('bob', { company: '2' });
  assert.equal((await call(tokens.bob, 'build-road', { x1: 1, y1: 1, x2: 5, y2: 1 })).ok, true);
  assert.equal(fake.received.at(-1).args.company, 2);
  players.removePlayer('bob');
  assert.equal((await call(tokens.bob, 'status')).status, 401, 'removed player is locked out at once');
});

test('per-player rate limit on the relay', async () => {
  // carol (limit 1/min) already built once above
  const again = await call(tokens.carol, 'build-road', { x1: 1, y1: 1, x2: 5, y2: 1 });
  assert.equal(again.ok, false);
  assert.match(again.error, /rate limit: 1 builds\/minute/);
  assert.equal((await call(tokens.carol, 'build-road-path', { x1: 1, y1: 1, x2: 5, y2: 1, dry_run: true })).ok, true, 'dry runs are free');
  assert.equal((await call(tokens.alice, 'build-road', { x1: 1, y1: 1, x2: 5, y2: 1 })).ok, true, 'other players are unaffected');
});

test('chat is prefixed with the player name', async () => {
  assert.equal((await call(tokens.alice, 'chat', { message: 'hello' })).ok, true);
  await call(tokens.alice, 'companies'); // round trip so the chat packet has been read
  assert.deepEqual(fake.chats, ['[alice] hello']);
});

test('audit log: who ran what, as which company, and refusals', () => {
  const lines = auditLines();
  const built = lines.find((l) => l.outcome === 'ok' && l.name === 'build-road' && l.player === 'carol');
  assert.equal(built.company, 1);
  assert.equal(built.args.company, 1);
  assert.ok(built.t && built.ms >= 0);
  assert.ok(lines.some((l) => l.outcome === 'refused' && l.player === 'alice' && l.name === 'build-road' && /company 1/.test(l.error)));
  assert.ok(lines.some((l) => l.outcome === 'refused' && l.name === 'launch'));
  assert.ok(lines.some((l) => l.outcome === 'auth_failed'));
  assert.ok(lines.some((l) => l.outcome === 'error' && l.player === 'carol' && /rate limit/.test(l.error)));
  assert.equal(lines.some((l) => l.name === 'find-cargo-pairs'), false, 'read-only world queries are not audited');
  const text = fs.readFileSync(relayMod.AUDIT_FILE, 'utf8');
  for (const t of Object.values(tokens)) assert.ok(!text.includes(t));
  assert.ok(!text.includes('host-only-pw'));
  assert.ok(!text.includes('sent-by-player'), 'secret-looking args are redacted');
});

test('player CLI: configure --relay/--token, then commands go through the relay (no admin password, no daemon)', async () => {
  const env = { ...process.env, OPENTTD_AGENT_HOME: playerHome, OPENTTD_AGENT_LOG: 'error' };
  const cli = async (...args) => JSON.parse((await run(process.execPath, [BIN, ...args], { env })).stdout);
  const cfg = await cli('configure', '--relay', `${url}/`, '--token', tokens.alice);
  assert.equal(cfg.relay, url);
  assert.equal(cfg.relay_token, '***');
  assert.equal(cfg.admin_password, '');
  assert.equal((await cli('status')).my_company, 0);
  const pairs = await cli('find-cargo-pairs', '--cargo', 'wood', '--min_distance', '10', '--max_distance', '200', '--max_transported_pct', '50');
  assert.equal(pairs.pairs[0].source.id, 1);
  const dry = await cli('build-road-path', '--x1', '1', '--y1', '1', '--x2', '6', '--y2', '1', '--dry_run', 'true');
  assert.equal(dry.dry_run, true);
  assert.equal(fake.received.at(-1).args.company, 0);
  await assert.rejects(run(process.execPath, [BIN, 'vehicle', '--vehicle', '11', '--company', '1'], { env }), (e) => {
    assert.match(JSON.parse(e.stdout).error, /relay refused: player 'alice' is bound to company 0/);
    return true;
  });
  await assert.rejects(run(process.execPath, [BIN, 'status'], { env: { ...env, OPENTTD_AGENT_RELAY_TOKEN: 'wrong' } }), (e) => {
    assert.match(JSON.parse(e.stdout).error, /unknown token/);
    return true;
  });
  await assert.rejects(run(process.execPath, [BIN, 'route-effort', '--x1', 'abc'], { env }), (e) => {
    assert.match(JSON.parse(e.stdout).error, /bad arguments/);
    return true;
  });
});

test('authorize is pure and leaves the caller\'s args alone', () => {
  const raw = { x1: 1 };
  const out = relayMod.authorize({ name: 'p', company: 3 }, 'build-road', raw);
  assert.equal(out.company, 3);
  assert.equal(raw.company, undefined);
  assert.throws(() => relayMod.authorize({ name: 'p', company: 3 }, 'build-road', { company: '4' }), relayMod.Refused);
  assert.equal(relayMod.authorize({ name: 'p', company: 3 }, 'build-road', { company: '3' }).company, 3);
});

test('relay-stats (host): per player last call, calls per minute and refusals', async () => {
  const { makeStatsRecorder, statsView, recordCall } = await import('../src/relay-stats.js');
  const st = { players: {} };
  recordCall(st, { player: 'p', outcome: 'ok', name: 'stations', now: 1_000_000 });
  recordCall(st, { player: 'p', outcome: 'refused', name: 'launch', now: 1_030_000 });
  const v = statsView(st, 1_050_000);
  assert.deepEqual([v.players[0].calls_last_minute, v.players[0].refused_total, v.players[0].seconds_since_last_call, v.players[0].last_command], [2, 1, 20, 'launch']);
  assert.equal(statsView(st, 1_000_000 + 11 * 60_000).players[0].calls_last_minute, 0);
  // The running relay recorded the calls above; flush it and read it as the host would.
  relay.close();
  const { runCommand } = await import('../src/commands.js');
  const res = await runCommand({ cfg: {} }, 'relay-stats', {});
  const alice = res.players.find((p) => p.player === 'alice');
  assert.ok(alice.calls_total > 0 && alice.refused_total > 0, JSON.stringify(alice));
  assert.ok(makeStatsRecorder);
  relay = await relayMod.startRelay({ port: 0, bind: '127.0.0.1' }); // for the tests after this one
  url = `http://127.0.0.1:${relay.port}`;
});
