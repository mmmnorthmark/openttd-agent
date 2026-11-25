// Fake OpenTTD admin server + AgentBridge GS for tests. Speaks the real admin
// wire format and the GS reply protocol (including multi-part chunking).

import net from 'node:net';
import { PKT, PacketSplitter, Reader, encodePacket, cstr } from '../src/admin-client.js';

export const FAKE_MAP = 64;

// 64x64 world: flat clear land height 2, a water column at x=30 (y 0..63) except
// a land bridge at y=50..52, a "town" block of houses at 40..44,10..14.
export function fakeTileClass(x, y) {
  if (x === 30 && !(y >= 50 && y <= 52)) return 'w';
  if (x >= 40 && x <= 44 && y >= 10 && y <= 14) return 'o';
  return 'b';
}

function dumpRows({ y0, y1, x0 = 0, x1 = FAKE_MAP - 1 }) {
  const out = [];
  for (let y = y0; y <= y1; y++) {
    let s = `${y},${x0},`;
    for (let x = x0; x <= x1; x++) s += '02' + '0' + fakeTileClass(x, y);
    out.push(s);
  }
  return out;
}

const FAKE_CARGOS = [{ id: 0, label: 'PASS', name: 'Passengers', passengers: true, mail: false, town_effect: 1 },
  { id: 5, label: 'GOOD', name: 'Goods', passengers: false, mail: false, town_effect: 3 },
  { id: 7, label: 'WOOD', name: 'Wood', passengers: false, mail: false, town_effect: 0 }];
// Acceptance around a point: Bigton's centre (42,12) accepts passengers and goods, Smallham's (10,50) only
// passengers, the sawmill (50,20) wood. Station size is ignored.
function fakeAcceptance([x, y], cargo, radius) {
  const near = (cx, cy, r = radius) => Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= r;
  if (cargo === 7) return y >= 15 && near(50, 20, radius + 6) ? 8 : 0;
  if (near(42, 12)) return { 0: 30, 5: 12 }[cargo] ?? 0;
  if (near(10, 50)) return { 0: 9, 5: 4 }[cargo] ?? 0;
  return 0;
}

// Goal rows as CmdGoalStatus sends them. Progress comes from state.delivered[label] (tests set it).
function goalView(g, state) {
  const targets = g.targets.map(([label, amount]) => [label, amount, state.delivered[label] ?? 0, (state.delivered[label] ?? 0) >= amount]);
  const status = targets.every((t) => t[3]) ? 'done' : state.year > g.deadline_year ? 'failed' : 'active';
  return { company: g.company, status, deadline_year: g.deadline_year, days_left: Math.max(0, (g.deadline_year + 1 - state.year) * 365), set_date: '1950-1-1', targets };
}

const fakeDays = (state) => state.daysRun + (state.paused ? 0 : Math.floor((Date.now() - state.runningSince) / state.dayMs));

// Console commands the package uses. Returns the output lines.
function fakeRcon(cmd, state) {
  if (cmd === 'pause' || cmd === 'unpause') {
    const want = cmd === 'pause';
    if (state.paused !== want) {
      if (want) state.daysRun = fakeDays(state); else state.runningSince = Date.now();
      state.paused = want;
    }
    return [];
  }
  if (cmd === 'setting command_pause_level') return [`Current value for 'construction.command_pause_level' is '${state.pauseLevel}' (min: 0, max: 3, def: 1).`];
  return [`ran: ${cmd}`];
}

// Handlers get (args, state); state is per fake server (see startFakeServer).
const GS = {
  goal_set: (a, state) => {
    if (a.deadline_year < state.year) throw new Error(`deadline_year ${a.deadline_year} is in the past (it is ${state.year})`);
    for (const [label] of a.targets) if (label !== 'VALUE' && !FAKE_CARGOS.some((c) => c.label === label)) throw new Error(`unknown cargo label '${label}'; run: openttd-agent cargos`);
    state.goals = state.goals.filter((g) => g.company !== a.company);
    const g = { company: a.company, deadline_year: a.deadline_year, targets: a.targets };
    state.goals.push(g);
    return [goalView(g, state)];
  },
  goal_status: (a, state) => state.goals.filter((g) => a.company === undefined || g.company === a.company).map((g) => goalView(g, state)),
  goal_clear: (a, state) => {
    const had = state.goals.some((g) => g.company === a.company);
    state.goals = state.goals.filter((g) => g.company !== a.company);
    return { removed: had };
  },
  // The date runs at one game day per state.dayMs of real time while the game is not paused.
  info: (_a, state) => {
    const date = 1 + fakeDays(state);
    return { tick: 1, date, year: state.year, month: 1, day: date, map_x: FAKE_MAP, map_y: FAKE_MAP, landscape: 0, paused: state.paused, towns: 2, industries: 3, bridge_version: 7, event_seq: 2, goals: state.goals.length };
  },
  cargos: () => FAKE_CARGOS,
  industry_types: () => [{ id: 3, name: 'Forest', produces: [7], accepts: [], raw: true, processing: false },
    { id: 4, name: 'Sawmill', produces: [5], accepts: [7], raw: false, processing: true }],
  industries: () => [
    [1, 3, 10, 20, [[7, 120, 0]], 0],
    [2, 4, 50, 20, [[5, 0, 0]], 0],
    [3, 3, 5, 60, [[7, 80, 75]], 1],
  ],
  towns: () => [[1, 'Bigton', 42, 12, 5000, false, 800, 10, 200, 0, 6], [2, 'Smallham', 10, 50, 300, false, 40, 0, 10, 0, 2]],
  companies: () => [{ id: 0, name: 'Test Transport', money: 100000, loan: 300000 }],
  get_rate: () => ({ command_delay_ticks: 0, max_builds_per_day: 0 }),
  dump_tiles: dumpRows,
  acceptance: (a) => {
    const rows = [];
    a.points.forEach((p, i) => {
      for (const c of a.cargos ?? FAKE_CARGOS.map((k) => k.id)) {
        const v = fakeAcceptance(p, c, a.radius ?? 4);
        if (v > 0) rows.push([i, c, v]);
      }
    });
    return rows;
  },
  echo: (a) => a,
  build_road: (a) => ({ ok: true, cost: 1234, error: '', money: 98766, echoed_company: a.company }),
  // operate (row formats: see main.nut)
  stations: () => [
    [3, 'Bigton Woods', 12, 20, 1, [[7, 240, 35]], 2],
    [4, 'Bigton Central', 41, 9, 4 | 2, [[0, 15, 80]], 5],
  ],
  vehicles: () => [
    [11, 'Train 1', 0, 5, 'Kirby Paul Tank', 4000, 7300, 62, -1200, -3000, 9000, 0, 14, 20, 2, 2, 1, 800, false],
    [12, 'Road Vehicle 1', 1, 9, 'MPS Regal Bus', 100, 5475, 98, 400, 2500, 4000, 3, 41, 9, 0xFFFE, 2, 1, 300, true],
  ],
  vehicle: (a) => {
    if (a.vehicle !== 11) throw new Error(`vehicle ${a.vehicle} does not exist or is not owned by company ${a.company}; run: openttd-agent vehicles`);
    return [
      { id: 11, name: 'Train 1', type: 0, engine: 5, engine_name: 'Kirby Paul Tank', age_days: 4000, max_age_days: 7300, reliability_pct: 62,
        profit_this_year: -1200, profit_last_year: -3000, value: 9000, running_cost: 800, state: 0, x: 14, y: 20, speed: 60, group: 2,
        wagons: 5, length: 80, capacity: [[7, 120, 40]], shared_orders: false, order_count: 2, current_order: 1 },
      [0, 'station', 12, 20, 96 | 1, 3, 'Bigton Woods', -1],
      [1, 'depot', 13, 22, 4, -1, '', -1],
    ];
  },
  engines: (a) => [
    [5, 'Kirby Paul Tank', 0xFF, 0, 64, 8000, 800, 75, 7300, 1925, 300, 47, false, 0],
    [27, 'Wood Truck', 7, 30, 0, 1500, 0, 0, 0, 1925, 0, 18, true, 0],
    [6, 'SH 8P', 0xFF, 0, 128, 21000, 1800, 80, 7300, 1954, 1000, 85, false, 0],
  ].filter((r) => a.type === 0 && (a.cargo === undefined || a.cargo === 7)),
  groups: () => [[2, 'Wood line', 0, -1, 1, -1200, -3000, 40]],
  depots: (a) => (a.type === 0 ? [[13, 22, 0]] : []),
  autorenew: () => ({ enabled: false, months: 6, money: 100000 }),
  events: (a) => [
    { seq: 1, date: '1950-1-3', type: 'industry_open', industry: 9, industry_type: 3, x: 5, y: 5 },
    { seq: 2, date: '1950-2-1', type: 'vehicle_crashed', company: 0, vehicle: 11, x: 14, y: 20, reason: 0, victims: 2 },
  ].filter((e) => e.seq > (a.since ?? 0)),
  rail_types: () => [[0, 'Railway construction', 0, 60], [1, 'Electrified railway construction', 0, 75]],
  bridge_types: (a) => [[0, 'Wooden rail bridge', 32, 100 * a.length, 0, 16], [2, 'Steel girder bridge', 112, 300 * a.length, 0, 400]],
  airport_types: () => [{ type: 0, name: 'small', buildable_now: true, width: 4, height: 3, coverage_radius: 4, price: 5000, monthly_maintenance: 300 }],
  // exec: every step costs 10 and returns value 100+index; a step whose op is 'veh_sell'
  // on vehicle 404, any step with op 'bogus', and real (not dry-run) steps whose op is in
  // state.failOps (tests set it) fail.
  exec: (a, state) => {
    const rows = [];
    let stopped = '';
    for (const st of a.steps) {
      const bad = st[0] === 'bogus' || (st[0] === 'veh_sell' && st[1] === 404) || (!a.dry_run && state.failOps.includes(st[0]));
      rows.push(bad ? [false, 0, 'Vehicle not available', 0] : [true, 10, '', 100 + rows.length]);
      if (bad && !(a.keep_going ?? a.dry_run)) { stopped = `step ${rows.length - 1} failed`; break; }
    }
    const cost = rows.reduce((n, r) => n + r[1], 0);
    return [{ dry_run: !!a.dry_run, attempted: rows.length, failed: rows.filter((r) => !r[0]).length, cost, stopped, money: a.dry_run ? 100000 : 100000 - cost }, ...rows];
  },
};

export function startFakeServer({ password = 'pw' } = {}) {
  const received = [];
  const chats = []; // messages sent with ADMIN_CHAT
  const state = { year: 1950, goals: [], delivered: {}, paused: false, pauseLevel: 3, daysRun: 0, runningSince: Date.now(), dayMs: 15, rcons: [], failOps: [] };
  const server = net.createServer((sock) => {
    const splitter = new PacketSplitter();
    const send = (type, payload) => sock.write(encodePacket(type, payload));
    sock.on('data', (chunk) => {
      for (const [type, body] of splitter.push(chunk)) {
        const r = new Reader(body);
        if (type === PKT.ADMIN_JOIN) {
          if (r.str() !== password) { send(PKT.SERVER_ERROR, Buffer.from([9])); continue; }
          send(PKT.SERVER_PROTOCOL, Buffer.from([3, 0]));
          const tail = Buffer.alloc(4 + 1 + 4 + 2 + 2);
          tail.writeUInt32LE(42, 0); tail.writeUInt8(0, 4); tail.writeUInt32LE(0, 5); tail.writeUInt16LE(FAKE_MAP, 9); tail.writeUInt16LE(FAKE_MAP, 11);
          send(PKT.SERVER_WELCOME, Buffer.concat([cstr('fake'), cstr('15.3'), Buffer.from([1]), cstr(''), tail]));
        } else if (type === PKT.ADMIN_GAMESCRIPT) {
          const req = JSON.parse(r.str());
          received.push(req);
          const handler = GS[req.cmd];
          const base = { id: req.id, client: req.client };
          if (!handler) { send(PKT.SERVER_GAMESCRIPT, cstr(JSON.stringify({ ...base, ok: false, part: 0, last: true, error: `unknown cmd: ${req.cmd}` }))); continue; }
          let data;
          try { data = handler(req.args ?? {}, state); } catch (e) {
            send(PKT.SERVER_GAMESCRIPT, cstr(JSON.stringify({ ...base, ok: false, part: 0, last: true, error: `exception in ${req.cmd}: ${e.message}` })));
            continue;
          }
          // Also send a reply for some other client to prove filtering works.
          send(PKT.SERVER_GAMESCRIPT, cstr(JSON.stringify({ id: req.id, client: 'someone-else', ok: true, part: 0, last: true, data: 'not for you' })));
          if (Array.isArray(data) && data.length > 1) {
            const half = Math.ceil(data.length / 2);
            send(PKT.SERVER_GAMESCRIPT, cstr(JSON.stringify({ ...base, ok: true, part: 0, last: false, data: data.slice(0, half) })));
            send(PKT.SERVER_GAMESCRIPT, cstr(JSON.stringify({ ...base, ok: true, part: 1, last: true, data: data.slice(half) })));
          } else {
            send(PKT.SERVER_GAMESCRIPT, cstr(JSON.stringify({ ...base, ok: true, part: 0, last: true, data })));
          }
        } else if (type === PKT.ADMIN_CHAT) {
          chats.push(body.subarray(6, body.length - 1).toString('utf8'));
        } else if (type === PKT.ADMIN_RCON) {
          const cmd = r.str();
          state.rcons.push(cmd);
          for (const line of fakeRcon(cmd, state)) send(PKT.SERVER_RCON, Buffer.concat([Buffer.from([1, 0]), cstr(line)]));
          send(PKT.SERVER_RCON_END, cstr('x'));
        }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received, chats, state })));
}
