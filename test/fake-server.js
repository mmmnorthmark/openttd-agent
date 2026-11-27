// Fake OpenTTD admin server + AgentBridge GS for tests. Speaks the real admin
// wire format and the GS reply protocol (including multi-part chunking).

import net from 'node:net';
import { PKT, PacketSplitter, Reader, encodePacket, cstr } from '../src/admin-client.js';

export const FAKE_MAP = 64;

// 64x64 world: flat clear land height 2, a water column at x=30 (y 0..63) except
// a land bridge at y=50..52, a "town" block of houses at 40..44,10..14, a road at y=9 (35..47).
export function fakeTileClass(x, y) {
  if (x === 30 && !(y >= 50 && y <= 52)) return 'w';
  if (y === 9 && x >= 35 && x <= 47) return x === 41 || x === 47 ? 's' : 'd'; // the road world of fakeRoadRows
  if (x >= 40 && x <= 44 && y >= 10 && y <= 14) return 'o';
  return 'b';
}

// Owned land (any company) shows as 'o' in the mirror, like objects in the real TileClass.
function dumpRows({ y0, y1, x0 = 0, x1 = FAKE_MAP - 1 }, state) {
  const out = [];
  for (let y = y0; y <= y1; y++) {
    let s = `${y},${x0},`;
    for (let x = x0; x <= x1; x++) s += '02' + '0' + (fakeLandOwner(x, y, state) !== null ? 'o' : fakeTileClass(x, y));
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

// Loan step as LoanStep in main.nut: interval 10000, max 500000. Changes state only for real runs.
// state.gsVersion < 8 behaves like an older AgentBridge without the step.
const FAKE_MAX_LOAN = 500000, FAKE_LOAN_INTERVAL = 10000;
function fakeLoanStep([, kind, n], dry, state) {
  if (state.gsVersion < 8) return [false, 0, 'unknown exec op: loan', 0];
  let want = kind === 'max' ? FAKE_MAX_LOAN : kind === 'add' ? state.loan + n : n;
  if (want < 0) return [false, 0, `refused: loan would be ${want}, below 0 (current loan ${state.loan})`, 0];
  if (want % FAKE_LOAN_INTERVAL) want += FAKE_LOAN_INTERVAL - (want % FAKE_LOAN_INTERVAL);
  if (want > FAKE_MAX_LOAN) return [false, 0, `refused: loan ${want} is over max_loan ${FAKE_MAX_LOAN} (loan interval ${FAKE_LOAN_INTERVAL})`, want];
  if (want - state.loan + state.money < 0) return [false, 0, `refused: repaying ${state.loan - want} needs that much cash; bank balance is ${state.money}`, want];
  if (!dry) { state.money += want - state.loan; state.loan = want; }
  return [true, 0, '', want];
}

// Owned land as BuyLandStep / CmdOwnedLand in main.nut (AgentBridge v10). state.land maps "x,y" -> owning
// company. Tiles with class 'o' (houses) are town buildings, 'w' water, state.landOwnedBy["x,y"] another
// company's property. Each tile costs 50. state.landFailAt ("x,y") makes the real purchase fail there.
const FAKE_LAND_PRICE = 50;
function fakeLandOwner(x, y, state) { return state?.land.get(`${x},${y}`) ?? null; }
function fakeLandRefusal(company, x, y, state) {
  if (x < 0 || y < 0 || x >= FAKE_MAP || y >= FAKE_MAP) return 'is outside the map';
  const owner = fakeLandOwner(x, y, state);
  if (owner === company) return 'is already your owned land';
  if (owner !== null) return `belongs to company ${owner}`;
  if (state.landOwnedBy[`${x},${y}`] !== undefined) return `belongs to company ${state.landOwnedBy[`${x},${y}`]}`;
  if (fakeTileClass(x, y) === 'o') return 'is a town building';
  if (fakeTileClass(x, y) === 'w') return 'is water';
  return null;
}
function fakeBuyLand([, x0, y0, x1, y1], company, dry, state) {
  if (state.gsVersion < 10) return [false, 0, 'unknown exec op: buy_land', 0];
  const total = (x1 - x0 + 1) * (y1 - y0 + 1);
  const bad = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const why = fakeLandRefusal(company, x, y, state);
    if (why) bad.push(`${x},${y} ${why}`);
  }
  if (bad.length) return [false, 0, `refused: ${bad.length} of ${total} tiles cannot be bought, nothing was bought: ${bad.slice(0, 6).join('; ')}${bad.length > 6 ? '; ...' : ''}`, 0];
  if (!dry && total * FAKE_LAND_PRICE > state.money) return [false, 0, `refused: ${total} tiles cost about ${total * FAKE_LAND_PRICE}, bank balance is ${state.money}; nothing was bought`, 0];
  let done = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!dry && state.landFailAt === `${x},${y}`) return [false, done * FAKE_LAND_PRICE, `tile ${x},${y}: ERR_NOT_ENOUGH_CASH (${done} tiles bought before it)`, done];
    if (!dry) { state.land.set(`${x},${y}`, company); state.money -= FAKE_LAND_PRICE; }
    done++;
  }
  return [true, done * FAKE_LAND_PRICE, '', done];
}

// Goal rows as CmdGoalStatus sends them. Progress comes from state.delivered[label] (tests set it).
function goalView(g, state) {
  const targets = g.targets.map(([label, amount]) => [label, amount, state.delivered[label] ?? 0, (state.delivered[label] ?? 0) >= amount]);
  const status = targets.every((t) => t[3]) ? 'done' : state.year > g.deadline_year ? 'failed' : 'active';
  return { company: g.company, status, deadline_year: g.deadline_year, days_left: Math.max(0, (g.deadline_year + 1 - state.year) * 365), set_date: '1950-1-1', targets };
}

// Rail world for rail_tiles (AgentBridge v9), as [x, y, kind, tracks, station, a, b, owner, rail_type, signals]:
// station 3 "Bigton Woods" (10..12,20) - track (13..23,20) - station 5 "Sawmill Halt" (24..26,20), and a
// separate line (28..34,40) where train 13 runs when state.lostTrain is set. state.railGap ("x,y") removes a tile.
// Depots: (13,22) joined to the main line by a branch (13,21) onto a junction at (13,20); (12,22) facing
// south onto nothing; (31,41) joined to the separate line at (31,40).
function fakeRailRows(state) {
  const rows = [];
  for (let x = 10; x <= 12; x++) rows.push([x, 20, 's', 1, 3, -1, -1, 0, 0, 0]);
  for (let x = 13; x <= 23; x++) rows.push([x, 20, 't', x === 13 ? 1 | 8 | 32 : 1, -1, -1, -1, 0, 0, x === 18 ? 1 << 4 : 0]); // (18,20): a path signal facing trains from (19,20)
  for (let x = 24; x <= 26; x++) rows.push([x, 20, 's', 1, 5, -1, -1, 0, 0, 0]);
  for (let x = 28; x <= 34; x++) rows.push([x, 40, 't', x === 31 ? 1 | 8 | 32 : 1, -1, -1, -1, 0, 0, 0]);
  rows.push([13, 21, 't', 2, -1, -1, -1, 0, 0, 0], [13, 22, 'd', 0, -1, 13, 21, 0, 0, 0],
    [12, 22, 'd', 0, -1, 12, 23, 0, 0, 0], [31, 41, 'd', 0, -1, 31, 40, 0, 0, 0]);
  // state.railLoop: a short passing loop beside the main line, points (15,20) and (20,20), loop track (15..20,19)
  // with a signal at (17,19): 3 clear tiles (too short for a 5-tile train).
  if (state.railLoop) {
    const at = (x, y) => rows.find((r) => r[0] === x && r[1] === y);
    at(15, 20)[3] = 1 | 4; at(20, 20)[3] = 1 | 16;
    rows.push([15, 19, 't', 8, -1, -1, -1, 0, 0, 0], [20, 19, 't', 32, -1, -1, -1, 0, 0, 0]);
    for (let x = 16; x <= 19; x++) rows.push([x, 19, 't', 1, -1, -1, -1, 0, 0, x === 17 ? 1 << 6 : 0]);
  }
  return rows.filter((r) => `${r[0]},${r[1]}` !== state.railGap);
}

// Road world for road_tiles (AgentBridge v11), as [x, y, kind, links, station, a, b, owner]: road (35..46,9)
// through drive-through stop 4 "Bigton Central" at (41,9), to bay stop 7 "Smallham Stop" at (47,9)
// (front (46,9)); depot (36,8) facing (36,9). Bus 12 runs 4 -> 7. state.roadGap ("x,y") removes a
// tile; state.roadOneWay ("x,y") lets vehicles on that tile drive only toward +x.
function fakeRoadRows(state) {
  const tiles = new Map(); // "x,y" -> { kind, edges, station, a, b }
  const put = (x, y, kind, edges, extra = {}) => tiles.set(`${x},${y}`, { x, y, kind, edges: new Set(edges), station: -1, a: -1, b: -1, ...extra });
  for (let x = 35; x <= 46; x++) put(x, 9, 'r', x === 35 ? [0] : [0, 2]);
  tiles.get('36,9').edges.add(3);
  put(41, 9, 't', [0, 2], { station: 4 });
  put(47, 9, 's', [2], { station: 7, a: 46, b: 9 });
  put(36, 8, 'd', [1], { a: 36, b: 9 });
  if (state.roadGap) tiles.delete(state.roadGap);
  const DX = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const rows = [];
  for (const t of tiles.values()) {
    let links = 0;
    for (let d = 0; d < 4; d++) {
      const n = tiles.get(`${t.x + DX[d][0]},${t.y + DX[d][1]}`);
      if (!t.edges.has(d) || !n || !n.edges.has((d + 2) % 4)) continue;
      if (state.roadOneWay === `${n.x},${n.y}` && d === 2) continue; // entering the one-way tile against it
      links |= 1 << d;
    }
    rows.push([t.x, t.y, t.kind, links, t.station, t.a, t.b, 0]);
  }
  return rows;
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
  // Host tools (0.8.0): the console's save list, save, load by index, start_ai, rescan_game, quit.
  if (cmd === 'ls') return ['0) .. (Parent directory)', '1) autosave/ (Directory)', ...state.saves.map((n, i) => `${i + 2}) ${n}.sav`)];
  if (cmd.startsWith('save ')) { const n = cmd.slice(5); if (!state.saves.includes(n)) state.saves.push(n); return ['Saving map...', `Map successfully saved to '${n}.sav'.`]; }
  if (/^load \d+$/.test(cmd)) return Number(cmd.slice(5)) - 2 in state.saves ? [] : ['That file cannot be found.'];
  if (cmd.startsWith('start_ai ')) {
    if (cmd.slice(9) !== 'IdleAI') return ['Failed to load the specified AI.'];
    state.extraCompanies.push(state.extraCompanies.length + 1);
    return [];
  }
  if (cmd === 'rescan_game' || cmd === 'quit') return [];
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
    return { tick: 1, date, year: state.year, month: 1, day: date, map_x: FAKE_MAP, map_y: FAKE_MAP, landscape: 0, paused: state.paused, towns: 2, industries: 3, bridge_version: state.gsVersion, event_seq: 2, goals: state.goals.length };
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
  companies: (_a, state) => [{ id: 0, name: 'Test Transport', money: state.money, loan: state.loan, max_loan: FAKE_MAX_LOAN, value: 50000, income: 9000, expenses: -4000, cargo_delivered: 300, performance: 210, hq: -1,
    ...(state.gsVersion >= 12 ? { station_count: 4, vehicles_by_type: [state.lostTrain ? 2 : 1, 1, 0, 0] } : {}) },
  ...state.extraCompanies.map((id) => ({ id, name: 'Unnamed', money: 100000, loan: 100000, max_loan: FAKE_MAX_LOAN, value: 1, income: 0, expenses: 0, cargo_delivered: 0, performance: 0, hq: -1 }))],
  // v12 queries (see main.nut). Older versions answer "unknown cmd" through v12only.
  company_history: (a) => Array.from({ length: (a.quarters ?? 4) + 1 }, (_, q) => [q, 50000 - q * 1000, 9000 - q * 500, -4000, 300 - q * 10, q === 0 ? -1 : 210 - q]),
  rating_parts: (_a, state) => ({ profitable_vehicles: 1, vehicles_over_2_years: 1, min_profit: -3000, station_facilities: 5, station_facilities_served: 5, money: state.money, loan: state.loan }),
  station_vehicles: (a) => [[3, [11]], [4, [12]], [5, [11]], [7, [12]]].filter(([st]) => a.station === undefined || st === a.station),
  tile_owners: (a, state) => [...fakeRailRows(state), ...fakeRoadRows(state)].filter(([x, y]) => x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1).map(([x, y]) => [x, y, 0]),
  vehicle_wagons: (a) => (a.vehicle === 11 ? [[0, 5, 0xFF, 0], [1, 27, 7, 30], [2, 27, 7, 30], [3, 27, 7, 30], [4, 27, 7, 30]] : [[0, 9, 0, 31]]),
  signs: (_a, state) => state.signs.map((g) => [g.id, g.x, g.y, 0, g.text]),
  road_types: () => [[0, 'Road', false, 0, 61, true], [1, 'Tramway', true, 0, 70, true]],
  get_rate: () => ({ command_delay_ticks: 0, max_builds_per_day: 0 }),
  dump_tiles: dumpRows,
  // owned_land (v10): indices of the points that are a.company's owned land.
  owned_land: (a, state) => a.points.map(([x, y], i) => (fakeLandOwner(x, y, state) === a.company ? i : -1)).filter((i) => i >= 0),
  check_airport: (a) => ({ noise_increase: 1, nearest_town: 0, town_allowed_noise: 4,
    ...(a.company !== undefined ? { buildable: true, cost: 5000, error: '' } : {}) }),
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
  test_build_road: (a) => ({ ok: true, cost: 1234, error: '', money: 100000, echoed_company: a.company }),
  // operate (row formats: see main.nut)
  // state.newStations (an array, tests set it): real rail_station steps add a station there (no track in rail_tiles).
  stations: (_a, state) => [
    [3, 'Bigton Woods', 12, 20, 1, [[7, 240, 35]], 2],
    [4, 'Bigton Central', 41, 9, 4 | 2, [[0, 15, 80]], 5],
    [5, 'Sawmill Halt', 24, 20, 1, [], 1],
    [7, 'Smallham Stop', 47, 9, 2, [[0, 5, 60]], 1],
    ...(state.newStations ?? []),
  ],
  // v9 rows end with [current_order, dest_x, dest_y, dest_station, speed].
  vehicles: (_a, state) => [
    // state.trainInDepot: train 11 is stopped in the depot at (13,22).
    [11, 'Train 1', 0, 5, 'Kirby Paul Tank', 4000, 7300, 62, -1200, -3000, 9000, ...(state.trainInDepot ? [2, 13, 22] : [0, 14, 20]), 2, 2, 1, 800, false, 1, 13, 22, -1, state.trainInDepot ? 0 : 60],
    [12, 'Road Vehicle 1', 1, 9, 'MPS Regal Bus', 100, 5475, 98, 400, 2500, 4000, 3, 41, 9, 0xFFFE, 2, 1, 300, true, 0, 41, 9, 4, 0],
    ...(state.lostTrain ? [[13, 'Train 2', 0, 5, 'Kirby Paul Tank', 800, 7300, 90, -200, -900, 9000, 0, 30, 40, 2, 2, 2, 800, false, 0, 12, 20, 3, 40]] : []),
  ].map((r) => (state.gsVersion >= 9 ? r : r.slice(0, 19))),
  rail_tiles: (a, state) => {
    if (state.gsVersion < 9) throw new Error('unknown cmd: rail_tiles');
    return fakeRailRows(state).filter(([x, y]) => x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1);
  },
  road_tiles: (a, state) => {
    if (state.gsVersion < 11) throw new Error('unknown cmd: road_tiles');
    return fakeRoadRows(state).filter(([x, y]) => x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1);
  },
  vehicle: (a, state) => {
    if (a.vehicle === 12) {
      return [
        { id: 12, name: 'Road Vehicle 1', type: 1, engine: 9, engine_name: 'MPS Regal Bus', age_days: 100, max_age_days: 5475, reliability_pct: 98,
          profit_this_year: 400, profit_last_year: 2500, value: 4000, running_cost: 300, state: 3, x: 41, y: 9, speed: 0, group: 0xFFFE,
          wagons: 1, length: 8, capacity: [[0, 31, 10]], shared_orders: true, order_count: 2, current_order: 0, unit_number: 1 },
        [0, 'station', 41, 9, 0, 4, 'Bigton Central', -1],
        [1, 'station', 47, 9, 0, 7, 'Smallham Stop', -1],
      ];
    }
    if (a.vehicle === 13 && state.lostTrain) {
      return [
        { id: 13, name: 'Train 2', type: 0, engine: 5, engine_name: 'Kirby Paul Tank', age_days: 800, max_age_days: 7300, reliability_pct: 90,
          profit_this_year: -200, profit_last_year: -900, value: 9000, running_cost: 800, state: 0, x: 30, y: 40, speed: 40, group: 2,
          wagons: 5, length: 80, capacity: [[7, 120, 0]], shared_orders: false, order_count: 2, current_order: 0, unit_number: 2, rail_type: 0 },
        [0, 'station', 12, 20, 96, 3, 'Bigton Woods', -1],
        [1, 'station', 24, 20, 4, 5, 'Sawmill Halt', -1],
      ];
    }
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
  ].filter((r) => a.type === 0 && (a.cargo === undefined || a.cargo === 7))
    .concat(a.type === 1 && (a.cargo === undefined || a.cargo === 7) ? [[40, 'Wood Truck R', 7, 20, 48, 4000, 400, 80, 5475, 1935, 0, 0, false, 0]] : []),
  groups: () => [[2, 'Wood line', 0, -1, 1, -1200, -3000, 40]],
  depots: (a, state) => (a.type === 0 ? [[13, 22, 0, 13, 21], [12, 22, 0, 12, 23], [31, 41, 0, 31, 40]] : a.type === 1 ? [[36, 8, 0, 36, 9]] : []).map((r) => (state.gsVersion >= 12 ? r : r.slice(0, 3))),
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
      if (st[0] === 'buy_land') {
        rows.push(fakeBuyLand(st, a.company, a.dry_run, state));
        if (!rows.at(-1)[0] && !(a.keep_going ?? a.dry_run)) { stopped = `step ${rows.length - 1} failed`; break; }
        continue;
      }
      if (st[0] === 'loan') {
        rows.push(fakeLoanStep(st, a.dry_run, state));
        if (!rows.at(-1)[0] && !(a.keep_going ?? a.dry_run)) { stopped = `step ${rows.length - 1} failed`; break; }
        continue;
      }
      if (st[0] === 'veh_depot' && state.gsVersion >= 11) {
        // As DepotStep in main.nut: 404 unknown, state.headingDepot ids already on their way, 11 in depot with trainInDepot, state.brokenDown ids broken.
        if (st[1] === 404) rows.push([false, 0, `not_found: vehicle 404 does not exist or is not yours`, 0]);
        else if (st[1] === 11 && state.trainInDepot) rows.push([true, 0, '', 3]);
        else if (state.headingDepot.includes(st[1])) rows.push([true, 0, '', 2]);
        else if (state.brokenDown.includes(st[1])) rows.push([false, 0, `broken_down: vehicle ${st[1]} is broken down; send it again once it moves (a few days) (ERR_UNKNOWN)`, 0]);
        else rows.push([true, 0, '', 1]);
        continue;
      }
      if (['veh_reverse', 'sign', 'sign_remove', 'hq'].includes(st[0]) && state.gsVersion < 12) {
        rows.push([false, 0, `unknown exec op: ${st[0]}`, 0]);
        if (!(a.keep_going ?? a.dry_run)) { stopped = `step ${rows.length - 1} failed`; break; }
        continue;
      }
      if (st[0] === 'sign' && !a.dry_run) { const id = 50 + state.signs.length; state.signs.push({ id, x: st[1], y: st[2], text: st[3] }); rows.push([true, 0, '', id]); continue; }
      if (st[0] === 'sign_remove') {
        const i = state.signs.findIndex((g) => g.id === st[1]);
        if (i < 0) rows.push([false, 0, `not_found: sign ${st[1]} does not exist or is not yours`, 0]); else { if (!a.dry_run) state.signs.splice(i, 1); rows.push([true, 0, '', 0]); }
        continue;
      }
      if (st[0] === 'veh_buy' && st[5] >= 0 && state.attachFails && !a.dry_run) {
        rows.push([false, 10, `bought vehicle ${100 + rows.length} but could not attach it to train ${st[5]}: ERR_UNKNOWN`, 100 + rows.length]);
        if (!(a.keep_going ?? a.dry_run)) { stopped = `step ${rows.length - 1} failed`; break; }
        continue;
      }
      // state.inTheWay = { x, y, times }: a rail step over that tile fails with ERR_VEHICLE_IN_THE_WAY (real runs count down).
      const w = state.inTheWay;
      if (w && w.times > 0 && st[0] === 'rail' && Math.min(st[3], st[5]) <= w.x && w.x <= Math.max(st[3], st[5]) && Math.min(st[4], st[6]) <= w.y && w.y <= Math.max(st[4], st[6])) {
        if (!a.dry_run) w.times--;
        rows.push([false, 0, 'ERR_VEHICLE_IN_THE_WAY', 0]);
        if (!(a.keep_going ?? a.dry_run)) { stopped = `step ${rows.length - 1} failed`; break; }
        continue;
      }
      // state.stationError: every rail_station step (dry run too) fails with that text.
      if (st[0] === 'rail_station' && state.stationError) {
        rows.push([false, 0, state.stationError, 0]);
        if (!(a.keep_going ?? a.dry_run)) { stopped = `step ${rows.length - 1} failed`; break; }
        continue;
      }
      if (st[0] === 'rail_station' && !a.dry_run && state.newStations) state.newStations.push([20 + state.newStations.length, `New ${state.newStations.length}`, st[1], st[2], 1, [], 0]);
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
  const state = { year: 1950, goals: [], delivered: {}, paused: false, pauseLevel: 3, daysRun: 0, runningSince: Date.now(), dayMs: 15, rcons: [], failOps: [], trainInDepot: false, attachFails: false, noGs: false, openConnections: 0, headingDepot: [], brokenDown: [], roadGap: null, roadOneWay: null, money: 100000, loan: 300000, gsVersion: 12, lostTrain: false, railGap: null, railLoop: false, inTheWay: null, stationError: null, newStations: null, land: new Map(), landOwnedBy: {}, landFailAt: null, signs: [], history: null, stalled: [], saves: ['fake-game'], extraCompanies: [], loads: 0, versionAfterLoad: null };
  const server = net.createServer((sock) => {
    state.openConnections++;
    sock.on('close', () => { state.openConnections--; });
    const splitter = new PacketSplitter();
    const send = (type, payload) => sock.write(encodePacket(type, payload));
    const welcome = () => {
      const tail = Buffer.alloc(4 + 1 + 4 + 2 + 2);
      tail.writeUInt32LE(state.seed ?? 42, 0); tail.writeUInt8(0, 4); tail.writeUInt32LE(0, 5); tail.writeUInt16LE(FAKE_MAP, 9); tail.writeUInt16LE(FAKE_MAP, 11);
      send(PKT.SERVER_WELCOME, Buffer.concat([cstr('fake'), cstr('15.3'), Buffer.from([1]), cstr(''), tail]));
    };
    sock.on('data', (chunk) => {
      for (const [type, body] of splitter.push(chunk)) {
        const r = new Reader(body);
        if (type === PKT.ADMIN_JOIN) {
          if (r.str() !== password) { send(PKT.SERVER_ERROR, Buffer.from([9])); continue; }
          send(PKT.SERVER_PROTOCOL, Buffer.from([3, 0]));
          welcome();
        } else if (type === PKT.ADMIN_GAMESCRIPT) {
          const req = JSON.parse(r.str());
          received.push(req);
          const v12only = ['company_history', 'rating_parts', 'station_vehicles', 'tile_owners', 'vehicle_wagons', 'signs', 'road_types'];
          const handler = (req.cmd === 'owned_land' && state.gsVersion < 10) || (v12only.includes(req.cmd) && state.gsVersion < 12) || (req.cmd === 'info' && state.noGs) ? undefined : GS[req.cmd];
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
          if (/^load \d+$/.test(cmd) && Number(cmd.slice(5)) - 2 in state.saves) {
            state.loads++;
            if (state.versionAfterLoad !== null) state.gsVersion = state.versionAfterLoad;
            send(PKT.SERVER_NEWGAME);
            welcome();
          }
          if (cmd === 'quit') sock.destroy();
        }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received, chats, state })));
}
