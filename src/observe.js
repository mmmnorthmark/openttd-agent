// Observation helpers (0.8.0 batch 6): pure functions over decoded GS rows for status/summary
// headers, companies profit, tiles --format text, stations/events filters and the one-call
// `overview` turn snapshot. Unit-tested in test/observe.test.js.

/** Game date string "YYYY-MM-DD" from GS info. */
export const dateString = (i) => `${i.year}-${String(i.month).padStart(2, '0')}-${String(i.day).padStart(2, '0')}`;

/** Short money text: 1234 -> "1.2k", 2500000 -> "2.5M", -300 -> "-300". */
export function shortMoney(n) {
  if (typeof n !== 'number') return String(n);
  const a = Math.abs(n);
  if (a >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (a >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

/** Last full quarter's profit of a GS companies row (expenses are negative). */
export const companyProfit = (c) => (typeof c.income === 'number' && typeof c.expenses === 'number' ? c.income + c.expenses : null);

/**
 * The caller's own company row from GS `companies` (never "row [0]": company ids need not start
 * at 0 and the list holds every company). Returns null when there is no such company.
 */
export function meFromCompanies(rows, company) {
  if (company === null || company === undefined) return null;
  const c = rows.find((r) => r.id === company);
  if (!c) return null;
  return { id: c.id, name: c.name, money: c.money, loan: c.loan, max_loan: c.max_loan, value: c.value,
    cargo_delivered: c.cargo_delivered, performance: c.performance, profit: companyProfit(c) };
}

// ---- tiles --format text ---------------------------------------------------------------------

/**
 * One character per tile: the class letter, upper case when your company owns the tile.
 * `classAt(x, y)` -> letter; `ownerAt(x, y)` -> company id or undefined (null when owners are
 * unknown). Returns { x_ruler: [lines], rows: ["  y|chars"] }: the x ruler has one line per digit
 * of the largest x (read top to bottom), each row starts with its y.
 */
export function tilesText({ x0, y0, x1, y1 }, classAt, ownerAt, me) {
  const width = String(Math.max(x1, 0)).length;
  const yWidth = String(Math.max(y1, 0)).length;
  const pad = ' '.repeat(yWidth + 1);
  const xRuler = [];
  for (let d = width - 1; d >= 0; d--) {
    let line = '';
    for (let x = x0; x <= x1; x++) {
      const digits = String(x).padStart(width, ' ');
      line += digits[width - 1 - d];
    }
    xRuler.push(pad + line);
  }
  const rows = [];
  for (let y = y0; y <= y1; y++) {
    let line = '';
    for (let x = x0; x <= x1; x++) {
      const c = String(classAt(x, y) ?? '?');
      line += ownerAt && ownerAt(x, y) === me && me !== null && me !== undefined ? c.toUpperCase() : c;
    }
    rows.push(`${String(y).padStart(yWidth, ' ')}|${line}`);
  }
  return { x_ruler: xRuler, rows };
}

/** Split a box into pieces of at most `max` x `max` tiles (GS queries cap their area). */
export function splitBox({ x0, y0, x1, y1 }, max = 40) {
  const out = [];
  for (let y = y0; y <= y1; y += max) for (let x = x0; x <= x1; x += max) out.push({ x0: x, y0: y, x1: Math.min(x1, x + max - 1), y1: Math.min(y1, y + max - 1) });
  return out;
}

/** --x/--y/--radius or --x0..--y1 -> a box clipped to the map. Throws bad_arguments when neither is complete. */
export function tileBox(a, mapX, mapY) {
  let box;
  if ([a.x0, a.y0, a.x1, a.y1].every((v) => v !== undefined)) {
    box = { x0: Math.min(a.x0, a.x1), y0: Math.min(a.y0, a.y1), x1: Math.max(a.x0, a.x1), y1: Math.max(a.y0, a.y1) };
  } else if (a.x !== undefined && a.y !== undefined) {
    const r = a.radius ?? 5;
    box = { x0: a.x - r, y0: a.y - r, x1: a.x + r, y1: a.y + r };
  } else {
    throw new Error('bad_arguments: give --x0 --y0 --x1 --y1, or --x --y [--radius R]');
  }
  const clip = (v, max) => Math.max(0, Math.min(max - 1, v));
  if (mapX && mapY) box = { x0: clip(box.x0, mapX), y0: clip(box.y0, mapY), x1: clip(box.x1, mapX), y1: clip(box.y1, mapY) };
  return box;
}

// ---- stations filters ----------------------------------------------------------------------

const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * stations --ids --near_x --near_y --radius --unserved --max_vehicles (on decoded stations).
 * With near_x/near_y each hit gets `distance` (Manhattan) and the list is sorted nearest first.
 * unserved / max_vehicles use the `vehicles` count (stations with an order for them).
 */
export function filterStations(stations, f) {
  const near = f.near_x !== undefined && f.near_y !== undefined ? { x: f.near_x, y: f.near_y } : null;
  let out = stations;
  if (f.ids) out = out.filter((st) => f.ids.includes(st.id));
  if (near) out = out.map((st) => ({ ...st, distance: manhattan(st, near) })).filter((st) => st.distance <= (f.radius ?? 20));
  if (f.unserved) out = out.filter((st) => (st.vehicles ?? 0) === 0);
  if (f.max_vehicles !== undefined) out = out.filter((st) => (st.vehicles ?? 0) <= f.max_vehicles);
  if (near) out = [...out].sort((p, q) => p.distance - q.distance || p.id - q.id);
  return out;
}

// ---- events filters --------------------------------------------------------------------------

/** "a,b" | ["a","b"] -> lower-case words; undefined stays undefined. */
export const wordList = (v) => (v === undefined ? undefined : (Array.isArray(v) ? v : String(v).split(',')).map((t) => String(t).trim().toLowerCase()).filter(Boolean));

/**
 * events filters: `types` (substrings, any matches), `exclude` (substrings, none may match),
 * `companies` (ids; the event's company or old_company must be one of them).
 */
export function filterEvents(events, { types, exclude, companies } = {}) {
  return events.filter((e) => (!types?.length || types.some((t) => e.type.includes(t)))
    && (!exclude?.length || !exclude.some((t) => e.type.includes(t)))
    && (!companies?.length || companies.includes(e.company) || companies.includes(e.old_company)));
}

/** One short line per event: "seq 2 1950-2-1 vehicle_crashed company 0 vehicle 11". */
export function eventLine(e) {
  const skip = new Set(['seq', 'date', 'type']);
  const rest = Object.entries(e).filter(([k, v]) => !skip.has(k) && v !== null && typeof v !== 'object').map(([k, v]) => `${k} ${v}`);
  return [`seq ${e.seq}`, e.date, e.type, ...rest].join(' ');
}

// ---- overview lines ------------------------------------------------------------------------

/** "3 Bigton Woods rail 2v: Wood 240@35%" */
export function shortStationLine(st) {
  const cargo = st.cargo.length ? st.cargo.map((c) => `${c.name} ${c.waiting}@${c.rating_pct}%`).join(', ') : 'no rating';
  return `${st.id} ${st.name} ${st.facilities.join('+')}${st.vehicles !== undefined ? ` ${st.vehicles}v` : ''}: ${cargo}`;
}

/** "11 #1 rail -1.2k/-3k rel62% running ->Sawmill Halt" (profit this/last year). */
export function shortVehicleLine(v, stationNames = new Map()) {
  const dest = v.dest_station >= 0 && stationNames.has(v.dest_station) ? ` ->${stationNames.get(v.dest_station)}` : '';
  return `${v.id} #${v.unit_number} ${v.type} ${shortMoney(v.profit_this_year)}/${shortMoney(v.profit_last_year)} rel${v.reliability_pct}% ${v.state}${dest}`;
}

/** One line for the whole fleet: counts per type and state, profit, loss makers. */
export function fleetLine(vehicles) {
  if (!vehicles.length) return 'no vehicles';
  const count = (key) => Object.entries(vehicles.reduce((m, v) => ({ ...m, [v[key]]: (m[v[key]] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(', ');
  const sum = (key) => vehicles.reduce((n, v) => n + v[key], 0);
  const losing = vehicles.filter((v) => v.profit_last_year < 0 && v.age_days > 365).length;
  return `${vehicles.length} (${count('type')}); ${count('state')}; profit ${shortMoney(sum('profit_this_year'))} this yr, ${shortMoney(sum('profit_last_year'))} last yr${losing ? `; ${losing} lost money last yr` : ''}`;
}

/** Goal (goalFromRow shape) -> one line, or null when there is none. */
export function goalLine(g) {
  if (!g || g.status === 'none') return null;
  const targets = g.targets.map((t) => `${t.cargo} ${shortMoney(t.progress)}/${shortMoney(t.amount)} (${t.pct}%)`).join(', ');
  return `${g.status}: ${targets}; deadline ${g.deadline_year}${typeof g.days_left === 'number' ? `, ${g.days_left} days left` : ''}`;
}

/**
 * Problem rows grouped by problem: "stopped_in_depot x4: 50 42 34 26; e.g. vehicle-start ..."
 * (one line per problem kind, the first row's suggested fix cut to `max` characters).
 */
export function problemGroups(rows, max = 90) {
  const groups = new Map();
  for (const p of rows) {
    if (!groups.has(p.problem)) groups.set(p.problem, []);
    if (!groups.get(p.problem).includes(p.id)) groups.get(p.problem).push(p.id);
  }
  return [...groups].map(([problem, idList]) => {
    const first = rows.find((p) => p.problem === problem);
    const fix = String(first.suggested_fix ?? first.evidence ?? '');
    const shown = idList.length > 12 ? `${idList.slice(0, 12).join(' ')} +${idList.length - 12}` : idList.join(' ');
    return `${problem} x${idList.length}: ${shown}${fix ? `; e.g. ${fix.length > max ? `${fix.slice(0, max - 3)}...` : fix}` : ''}`;
  });
}

/** Depot rows per type + decoded vehicles -> "rail 2 (4 vehicles inside), road 1" (inside = vehicles in_depot on a depot tile). */
export function depotsLine(byType, vehicles) {
  const parts = [];
  for (const [type, rows] of byType) {
    if (!rows.length) continue;
    const tiles = new Set(rows.map((r) => `${r[0]},${r[1]}`));
    const inside = vehicles.filter((v) => v.type === type && v.state === 'in_depot' && tiles.has(`${v.x},${v.y}`)).length;
    parts.push(`${type} ${rows.length}${inside ? ` (${inside} vehicles inside)` : ''}`);
  }
  return parts.join(', ') || 'none';
}

/** Rival company row -> "1 Name: money 100k value 50k perf 210 profit 3k". */
export function rivalLine(c) {
  const p = companyProfit(c);
  return `${c.id} ${c.name}: money ${shortMoney(c.money)} value ${shortMoney(c.value)} perf ${c.performance}${p !== null ? ` profit ${shortMoney(p)}` : ''}`
    + `${c.station_count !== undefined ? ` st ${c.station_count}` : ''}${Array.isArray(c.vehicles_by_type) ? ` veh ${c.vehicles_by_type.reduce((n, k) => n + k, 0)}` : ''}`;
}
