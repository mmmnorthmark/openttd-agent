// CLI/MCP parity (P16): every registry command runs through the CLI (--no-daemon --args JSON) and
// through MCP (stdio JSON-RPC) against two identical fake servers, in the same order, and the
// results must be deep-equal (paths and ports of the two test homes normalised). Also: generated
// negative cases (bogus key, {} for required args, null for optional args, aliases), output
// controls, tools/list = registry (names and schemas), a --profile case, a daemon-path case, and
// every command named in the README.
//
// A new command fails 'every registry command has a parity case' until it gets an entry in CASES.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { startFakeServer } from './fake-server.js';
import { COMMANDS, describeCommands } from '../src/commands.js';

const BIN = path.resolve('bin/openttd-agent.js');

// One case per command: args that run against the fake world (dry runs for builds, so both
// servers stay identical), or a refusal where a real run would leave the machine.
const CASES = {
  doctor: {}, guide: {}, 'install-gamescript': {}, configure: { max_builds_per_minute: 0 }, 'show-config': {},
  launch: { mode: 'dedicated', admin_password: 'pw', dry_run: true },
  'scenario-prepare': {},                       // refused: needs --content_id or --search (never downloads here)
  'relay-add-player': { name: 'bad name!' },    // refused: a real one prints a random token
  'relay-list-players': {}, 'relay-set-company': { name: 'nobody', company: '0' }, 'relay-stats': {}, 'relay-remove-player': { name: 'nobody' },
  status: {}, companies: {}, rating: {}, chat: { message: 'hello' }, rate: {}, 'goal-status': {},
  'goal-set': { deadline_year: 1954, targets: 'wood:3000,VALUE:100000' }, pause: {}, unpause: {}, 'turn-advance': { days: 1 }, 'goal-clear': {},
  save: { name: 'parity' },
  // Host server control (session: false, own admin connection to the configured admin port).
  saves: {}, 'server-log': {}, console: { command: 'setting command_pause_level' }, load: { name: 'nope' },
  'company-new': { ai: 'NoSuchAI' }, 'server-stop': { server: 'nope' },  // refusals: never quit the fake
  cargos: {}, 'industry-types': {}, towns: {}, industries: { id: 2 }, 'find-cargo-pairs': { cargo: 'wood', min_distance: 10, max_distance: 200 },
  acceptance: { x: 42, y: 12 }, 'town-gaps': { min_population: 0 }, 'route-effort': { x1: 10, y1: 20, x2: 50, y2: 20 },
  'airport-types': {}, 'airport-sites': { town: 'Smallham', limit: 2 }, tiles: { x0: 12, y0: 20, x1: 14, y1: 20 }, 'rail-tiles': { x0: 12, y0: 19, x1: 19, y1: 22 },
  'build-hq': { x: 20, y: 30, dry_run: true }, sign: { x: 5, y: 6, text: 'plot A', dry_run: true }, 'sign-remove': { x: 5, y: 6, dry_run: true }, signs: {},
  'test-build-road': { x1: 1, y1: 1, x2: 5, y2: 1 }, 'build-road': { x1: 1, y1: 1, x2: 3, y2: 1, dry_run: true },
  stations: {}, vehicles: {}, vehicle: { vehicle: 11 }, summary: {}, 'vehicle-problems': {}, 'verify-route': { from_station: 'Bigton Woods', to_station: 5 },
  engines: { type: 'rail', cargo: 'wood' }, groups: {}, depots: {}, events: {}, overview: {},
  'group-create': { type: 'rail', name: 'Wood line', dry_run: true }, 'group-rename': { group: 2, name: 'x', dry_run: true }, 'group-delete': { group: 2, dry_run: true },
  'group-move': { group: 2, vehicles: '11', dry_run: true }, 'group-autoreplace': { group: 2, old_engine: 5, new_engine: 6, dry_run: true },
  autorenew: {}, loan: {},
  'order-add': { vehicle: 11, station: 3, flags: 'full_load_any,non_stop', dry_run: true }, 'order-remove': { vehicle: 11, position: 0, dry_run: true },
  'order-flags': { vehicle: 11, position: 0, flags: 'non_stop', dry_run: true }, 'order-skip': { vehicle: 11, position: 0, dry_run: true },
  'orders-copy': { vehicles: '12,13', from: 11, dry_run: true },
  'vehicle-buy': { depot_x: 5, depot_y: 5, engine: 1, dry_run: true }, 'vehicle-clone': { vehicle: 11, dry_run: true },
  'vehicle-replace': { vehicles: '11', dry_run: true }, 'add-train': { vehicle: 11, dry_run: true }, 'train-add-wagons': { vehicle: 11, wagons: 2, dry_run: true },
  'vehicle-reverse': { vehicles: '11,12', dry_run: true }, 'vehicle-start': { vehicles: '11', dry_run: true }, 'vehicle-stop': { vehicles: '11', dry_run: true },
  'vehicle-depot': { vehicles: '5', dry_run: true }, 'vehicle-sell': { vehicles: '5,404,6', dry_run: true }, 'vehicle-refit': { vehicle: 11, cargo: 'wood', dry_run: true },
  'vehicle-rename': { vehicle: 11, name: 'Woody', dry_run: true },
  'rail-types': {}, 'road-types': {}, 'bridge-types': { length: 5 },
  'build-rail': { x1: 24, y1: 20, x2: 36, y2: 20, dry_run: true, margin: 5 }, 'build-rail-station': { x: 10, y: 10, axis: 'y', platforms: 2, length: 5, dry_run: true },
  'build-rail-depot': { x: 9, y: 9, front_x: 10, front_y: 9, dry_run: true }, 'build-line-depot': { station: 3, dry_run: true },
  'build-cargo-route': { from_industry: 1, to_industry: 2, cargo: 'wood', dry_run: true }, 'build-truck-route': { from_industry: 1, to_industry: 2, cargo: 'wood', dry_run: true },
  'build-track': { x: 30, y: 11, from_x: 30, from_y: 12, to_x: 31, to_y: 11, dry_run: true }, 'build-signal': { x: 14, y: 10, front_x: 13, front_y: 10, dry_run: true },
  'station-sites': { industry: 1 }, 'build-terminus': { x: 10, y: 30, platforms: 2, length: 4, dry_run: true },
  'build-passing-loop': { x: 20, y: 40, dir: 'se', length: 5, dry_run: true }, 'loop-sites': { from_station: 3, to_station: 'Sawmill Halt', train_tiles: 2 },
  'build-road-path': { x1: 3, y1: 3, x2: 9, y2: 6, dry_run: true }, 'build-road-station': { x: 4, y: 4, front_x: 4, front_y: 5, dry_run: true },
  'build-road-depot': { x: 38, y: 12, front_x: 38, front_y: 11, dry_run: true }, 'build-bridge': { type: 'road', x1: 29, y1: 5, x2: 31, y2: 5, dry_run: true },
  'build-tunnel': { x: 8, y: 8, dry_run: true }, terraform: { x0: 5, y0: 5, x1: 8, y1: 7, dry_run: true }, demolish: { x0: 9, y0: 9, dry_run: true },
  'purchase-land': { x0: 13, y0: 32, x1: 10, y1: 30, dry_run: true }, 'owned-land': {},
  'build-dock': { x: 29, y: 30, dry_run: true }, 'build-buoy': { x: 30, y: 30, dry_run: true }, 'build-water-depot': { x: 30, y: 20, front_x: 30, front_y: 21, dry_run: true },
  'build-airport': { x: 50, y: 50, airport: 'small', dry_run: true },
};

// Output controls and forgiving input, the same on both surfaces.
const EXTRA_CASES = [
  ['towns', { fields: 'name,population' }],
  ['towns', { fields: 'total,towns.id' }],
  ['vehicle-sell', { vehicles: '5,404,6', dry_run: true, brief: true }],
  ['build-rail', { x1: 24, y1: 20, x2: 36, y2: 20, dry_run: true, margin: 5, steps: 'all' }],
  ['vehicles', { company: null, limit: null }],                       // null = not given
  ['vehicles', { company: '' }],                                       // "" = not given
  ['vehicles', { limit: 0 }],                                          // clamped in a read
  ['vehicle', { id: 11 }],                                             // alias id -> vehicle
  ['vehicle-sell', { vehicle: 404, dry_run: true }],                   // alias vehicle -> vehicles
  ['vehicle-stop', { vehicles: 11, dry_run: true }],                   // a number for a list
  ['towns', { name: 5 }],                                              // a number for a text arg
  ['towns', { dry_run: true }],                                        // ignored in a read
  ['route-effort', { x1: '10', y1: '20', x2: 50, y2: 20 }],            // numeric strings
  ['route-effort', { x1: false, y1: 20, x2: 50, y2: 20 }],             // false is not 0
  ['vehicles', { fields: '' }],                                        // bad reserved value
  ['launch', { server: 'side', game_port: 4979, admin_port: 4977, mode: 'dedicated', admin_password: 'pw', dry_run: true }],
  ['install-gamescript', { reload: true }],
];

const isRequired = (name) => (describeCommands().find((d) => d.name === name).args.required ?? []).length > 0;

// Fields that follow the wall clock, not the command (turn-advance races the fake's game clock).
const VOLATILE = { 'turn-advance': ['to', 'days_advanced', 'real_seconds', 'events', 'latest_seq'] };

/** The fake game clock stands still between cases (paused at day 0) so dates are the same on both. */
function freezeClocks() {
  for (const f of [fakeA, fakeB]) Object.assign(f.state, { paused: true, daysRun: 0, runningSince: Date.now() });
}

let fakeA, fakeB, homeA, homeB, envA, envB, mcp, daemonPort;

function makeHome(fake, name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ottd-parity-${name}-`));
  const personal = path.join(home, 'personal');
  fs.mkdirSync(personal);
  fs.writeFileSync(path.join(personal, 'openttd.cfg'), '[network]\nserver_name = x\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'pw', company: 0, tile_refresh_rows_per_sec: 0, daemon_port: daemonPort }));
  fs.mkdirSync(path.join(home, 'players'));
  fs.writeFileSync(path.join(home, 'players', 'pp.json'), JSON.stringify({ company: 0 }));
  const env = { ...process.env, OPENTTD_AGENT_HOME: home, OPENTTD_AGENT_LOG: 'error', OPENTTD_EXE: process.execPath, OPENTTD_PERSONAL_DIR: personal };
  for (const k of ['OPENTTD_AGENT_PROFILE', 'OPENTTD_AGENT_PLAYER_FILE', 'OPENTTD_AGENT_COMPANY', 'OPENTTD_AGENT_READ_ONLY', 'OPENTTD_AGENT_TOOLS', 'OPENTTD_AGENT_COMPACT']) delete env[k];
  return { home, env };
}

/** A running MCP server: call(method, params) -> JSON-RPC response. */
function startMcpClient(env, flags = []) {
  const child = spawn(process.execPath, [BIN, 'mcp', ...flags], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  let buf = '', id = 0;
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) { const m = JSON.parse(line); if (m.id !== undefined) replies.set(m.id, m); }
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const call = async (method, params) => {
    const my = ++id;
    send({ jsonrpc: '2.0', id: my, method, params });
    for (let t = 0; t < 2400 && !replies.has(my); t++) await new Promise((r) => setTimeout(r, 25));
    if (!replies.has(my)) throw new Error(`MCP ${method} timed out`);
    return replies.get(my);
  };
  const ready = (async () => {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity', version: '1' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  })();
  return { call, ready, close: () => child.kill() };
}

function cli(env, name, args, { daemon = false, pre = [] } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...pre, name, ...(daemon ? [] : ['--no-daemon']), '--args', JSON.stringify(args)], { env, maxBuffer: 1 << 26 }, (err, stdout) => {
      resolve({ code: err ? err.code : 0, result: JSON.parse(stdout) });
    });
  });
}

async function mcpCall(client, name, args) {
  const m = await client.call('tools/call', { name: name.replaceAll('-', '_'), arguments: args });
  if (!m.result) return { rpcError: m.error };
  return { isError: m.result.isError === true, result: JSON.parse(m.result.content[0].text) };
}

/** Same JSON with the per-home paths and ports replaced. */
function normalise(value, side) {
  const { home, port } = side === 'A' ? { home: homeA, port: fakeA.port } : { home: homeB, port: fakeB.port };
  const text = JSON.stringify(value).split(home).join('<HOME>').split(fs.realpathSync(home)).join('<HOME>').replace(new RegExp(`\\b${port}\\b`, 'g'), '99999');
  return JSON.parse(text);
}

async function compare(name, args, { clientB = mcp, cliOpts = {} } = {}) {
  const [c, m] = await Promise.all([cli(envA, name, args, cliOpts), mcpCall(clientB, name, args)]);
  freezeClocks();
  for (const k of VOLATILE[name] ?? []) { delete c.result[k]; delete m.result?.[k]; }
  const label = `${name} ${JSON.stringify(args)}`;
  assert.equal(m.rpcError, undefined, `${label}: MCP answered with a JSON-RPC error ${JSON.stringify(m.rpcError)}`);
  assert.deepEqual(normalise(c.result, 'A'), normalise(m.result, 'B'), `${label}: CLI and MCP results differ`);
  assert.equal(c.code === 1, c.result.ok !== true, `${label}: CLI exit code follows ok`);
  assert.equal(m.isError, m.result.ok !== true, `${label}: MCP isError follows ok`);
  return c.result;
}

before(async () => {
  daemonPort = 45000 + Math.floor(Math.random() * 900);
  fakeA = await startFakeServer({ password: 'pw' });
  fakeB = await startFakeServer({ password: 'pw' });
  ({ home: homeA, env: envA } = makeHome(fakeA, 'a'));
  ({ home: homeB, env: envB } = makeHome(fakeB, 'b'));
  freezeClocks();
  mcp = startMcpClient(envB, ['--no-daemon']);
  await mcp.ready;
});

after(async () => {
  mcp?.close();
  await new Promise((r) => execFile(process.execPath, [BIN, 'daemon-stop'], { env: envA }, r));
  fakeA.server.close();
  fakeB.server.close();
});

test('every registry command has a parity case', () => {
  assert.deepEqual(COMMANDS.map((c) => c.name).filter((n) => !(n in CASES)), []);
  assert.deepEqual(Object.keys(CASES).filter((n) => !COMMANDS.some((c) => c.name === n)), [], 'no case for a removed command');
});

test('tools/list: the registry, with the same schemas as `commands`', async () => {
  const list = (await mcp.call('tools/list', {})).result.tools;
  const described = describeCommands();
  assert.deepEqual(list.map((t) => t.name).sort(), described.map((c) => c.name.replaceAll('-', '_')).sort());
  for (const c of described) {
    const tool = list.find((t) => t.name === c.name.replaceAll('-', '_'));
    assert.deepEqual(tool.inputSchema, { type: 'object', ...c.args }, `${c.name}: schema`);
  }
});

test('every command: CLI and MCP give the same result', async () => {
  for (const c of COMMANDS) await compare(c.name, CASES[c.name]);
});

test('output controls and forgiving input: the same on both surfaces', async () => {
  for (const [name, args] of EXTRA_CASES) await compare(name, args);
  const projected = await compare('towns', { fields: 'name' });
  assert.deepEqual(Object.keys(projected.towns[0]), ['name']);
});

test('negative cases: a bogus key on every command and {} where arguments are required', async () => {
  const bogus = await Promise.all(COMMANDS.map(async (c) => [c.name, await compare(c.name, { ...CASES[c.name], bogus_key: 1 })]));
  for (const [name, r] of bogus) assert.equal(r.first_error, 'unknown_argument', `${name}: a bogus key is refused, nothing runs`);
  const empty = await Promise.all(COMMANDS.filter((c) => isRequired(c.name)).map(async (c) => [c.name, await compare(c.name, {})]));
  for (const [name, r] of empty) assert.equal(r.first_error, 'bad_arguments', `${name}: {} names the required arguments`);
  assert.match(empty.find(([n]) => n === 'route-effort')[1].error, /--x1: required/);
});

test('a --profile case and a daemon-path case', async () => {
  const profiled = startMcpClient({ ...envB, OPENTTD_AGENT_PROFILE: 'pp' }, ['--no-daemon']);
  await profiled.ready;
  try {
    const r = await compare('show-config', {}, { clientB: profiled, cliOpts: { pre: ['--profile', 'pp'] } });
    assert.equal(r.profile, 'pp');
  } finally { profiled.close(); }
  const viaDaemon = await compare('towns', { fields: 'name' }, { cliOpts: { daemon: true } });
  assert.equal(viaDaemon.ok, true);
});

test('every command is named in the README', () => {
  const readme = fs.readFileSync(path.resolve('README.md'), 'utf8');
  const missing = COMMANDS.map((c) => c.name).filter((n) => !new RegExp(`(?<![\\w-])${n}(?![\\w-])`).test(readme));
  assert.deepEqual(missing, []);
});
