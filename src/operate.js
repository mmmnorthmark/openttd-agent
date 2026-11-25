// Decoders for the "operate" GS rows (stations, vehicles, engines, groups, orders)
// and order-flag helpers. Pure functions; row formats are documented next to the
// GS handlers in gamescript/AgentBridge/main.nut.

export const VEHICLE_TYPES = ['rail', 'road', 'water', 'air'];
export const VEHICLE_STATES = ['running', 'stopped', 'in_depot', 'at_station', 'broken', 'crashed'];
export const FACILITIES = ['rail', 'truck', 'bus', 'airport', 'dock'];

/** 'rail' | 'road' | 'water' | 'air' -> 0..3 (GSVehicle.VT_*). */
export function vehicleTypeId(name) {
  const i = VEHICLE_TYPES.indexOf(String(name).toLowerCase());
  if (i === -1) throw new Error(`unknown vehicle type '${name}'. Use one of: ${VEHICLE_TYPES.join(', ')}`);
  return i;
}

const cargoName = (cargos, id) => cargos?.get(id)?.name ?? `cargo ${id}`;

/** Resolve a cargo given as id or name/label substring to its id. */
export function cargoId(cargos, ref) {
  if (ref === undefined || ref === null || ref === '') return undefined;
  if (/^\d+$/.test(String(ref))) return Number(ref);
  const lc = String(ref).toLowerCase();
  const hit = [...cargos.values()].find((c) => c.name.toLowerCase().includes(lc) || c.label.toLowerCase() === lc);
  if (!hit) throw new Error(`no cargo matching '${ref}'. Run: openttd-agent cargos`);
  return hit.id;
}

export function stationsFromRows(rows, cargos) {
  return rows.map(([id, name, x, y, fac, cargo, vehicles]) => ({
    id, name, x, y, facilities: FACILITIES.filter((_, i) => fac & (1 << i)), vehicles,
    cargo: cargo.map(([c, waiting, rating]) => ({ cargo: c, name: cargoName(cargos, c), waiting, rating_pct: rating })),
  }));
}

export function vehiclesFromRows(rows) {
  return rows.map(([id, name, type, engine, engine_name, age_days, max_age_days, reliability_pct, profit_this_year, profit_last_year,
    value, state, x, y, group, order_count, unit_number, running_cost, shared_orders]) => ({
    id, name, type: VEHICLE_TYPES[type] ?? type, engine, engine_name, age_days, max_age_days,
    age_pct: max_age_days > 0 ? Math.round(100 * age_days / max_age_days) : 0, reliability_pct,
    profit_this_year, profit_last_year, value, running_cost, state: VEHICLE_STATES[state] ?? state, x, y,
    group: group === 0xFFFF || group === 0xFFFE ? null : group, order_count, unit_number, shared_orders,
  }));
}

export function enginesFromRows(rows, cargos) {
  return rows.map(([id, name, cargo, capacity, max_speed, price, running_cost, reliability_pct, max_age_days, design_year, power, weight, is_wagon, track_type]) => ({
    id, name, cargo, cargo_name: cargo === 0xFF || cargo < 0 ? null : cargoName(cargos, cargo), capacity, max_speed, price, running_cost,
    reliability_pct, max_age_years: Math.round(max_age_days / 365), design_year, power, weight, is_wagon, track_type,
  }));
}

export function groupsFromRows(rows) {
  return rows.map(([id, name, type, parent, vehicles, profit_this_year, profit_last_year, usage_pct]) => ({
    id, name, type: VEHICLE_TYPES[type] ?? type, parent: parent < 0 ? null : parent, vehicles, profit_this_year, profit_last_year, usage_pct,
  }));
}

// ---- order flags (values of GSOrder.OF_* in OpenTTD 15.x) --------------------

const STATION_FLAGS = { non_stop: 1, via: 2, unload: 4, transfer: 8, no_unload: 16, full_load: 64, full_load_any: 96, no_load: 128 };
const DEPOT_FLAGS = { non_stop: 1, service_if_needed: 4, stop_in_depot: 8 };
export const ORDER_FLAG_HELP = `station orders: ${Object.keys(STATION_FLAGS).join(', ')}; depot orders: ${Object.keys(DEPOT_FLAGS).join(', ')}`;

/** 'full_load,non_stop' -> integer for GSOrder. depot=true uses the depot meanings. */
export function encodeOrderFlags(text, { depot = false } = {}) {
  const table = depot ? DEPOT_FLAGS : STATION_FLAGS;
  let flags = 0;
  for (const name of String(text ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!(name in table)) throw new Error(`unknown order flag '${name}'. Valid for ${ORDER_FLAG_HELP}`);
    flags |= table[name];
  }
  return flags;
}

export function decodeOrderFlags(flags, kind) {
  const out = [];
  if (flags & 1) out.push('non_stop');
  if (kind === 'depot') {
    if (flags & 4) out.push('service_if_needed');
    if (flags & 8) out.push('stop_in_depot');
    return out;
  }
  if (flags & 2) out.push('via');
  if (flags & 4) out.push('unload');
  if (flags & 8) out.push('transfer');
  if (flags & 16) out.push('no_unload');
  const load = flags & 224;
  if (load === 64) out.push('full_load');
  if (load === 96) out.push('full_load_any');
  if (load === 128) out.push('no_load');
  return out;
}

/** GS `vehicle` reply ([info, ...order rows]) -> one object with decoded orders. */
export function vehicleDetail([info, ...orderRows], cargos) {
  return {
    ...info,
    type: VEHICLE_TYPES[info.type] ?? info.type,
    state: VEHICLE_STATES[info.state] ?? info.state,
    capacity: info.capacity.map(([c, capacity, load]) => ({ cargo: c, name: cargoName(cargos, c), capacity, load })),
    orders: orderRows.map(([position, kind, x, y, flags, station, name, jump_to]) => ({
      position, kind, x, y, flags: decodeOrderFlags(flags, kind),
      ...(station >= 0 ? { station, station_name: name } : {}), ...(jump_to >= 0 ? { jump_to } : {}),
    })),
  };
}

/** Summarise GS `exec` replies (one per batch) against the steps that were sent. */
export function execSummary(steps, replies, dryRun) {
  const results = [];
  let cost = 0, money = null, stopped = '';
  for (const [summary, ...rows] of replies) {
    for (const [ok, c, error, value] of rows) {
      const step = steps[results.length];
      results.push({ step: results.length, op: step[0], ok, cost: c, ...(error ? { error } : {}), ...(value ? { value } : {}) });
    }
    cost += summary.cost; money = summary.money; stopped = summary.stopped;
  }
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0 && results.length === steps.length, dry_run: !!dryRun, steps_total: steps.length, steps_done: results.length - failed.length,
    cost, money, ...(stopped ? { stopped } : {}), ...(failed.length ? { first_error: failed[0].error ?? 'failed' } : {}), results,
  };
}

// ---- goals (GS rows: see CmdGoalStatus in main.nut) -----------------------------------------

/** "COAL:3000,pass:3000,VALUE:500000" | [["COAL", 3000]] | [{cargo, amount}] -> [[LABEL, amount], ...]; VALUE = company value. */
export function parseGoalTargets(input, cargoLabels) {
  const raw = typeof input === 'string'
    ? input.split(',').filter((p) => p.trim() !== '').map((p) => p.split(':'))
    : (input ?? []).map((t) => (Array.isArray(t) ? t : [t.cargo, t.amount]));
  if (!raw.length) throw new Error("no targets given; use e.g. --targets COAL:3000,PASS:3000 ('VALUE:<amount>' = company value)");
  const known = ['VALUE', ...cargoLabels];
  return raw.map(([label, amount]) => {
    const l = String(label ?? '').trim().toUpperCase();
    const n = Number(String(amount ?? '').trim());
    if (!known.includes(l)) throw new Error(`unknown goal cargo '${label}'. Use a cargo label of this game (${cargoLabels.join(', ')}) or VALUE`);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`goal amount for ${l} must be a whole number above 0, got '${amount}'`);
    return [l, n];
  });
}

/** One GS goal row -> readable goal. */
export function goalFromRow(g) {
  return { company: g.company, status: g.status, deadline_year: g.deadline_year, days_left: g.days_left, set_date: g.set_date,
    targets: g.targets.map(([cargo, amount, progress, done]) => ({ cargo, amount, progress, pct: Math.min(100, Math.floor((progress * 100) / amount)), done })) };
}
