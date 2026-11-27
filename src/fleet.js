// Road and fleet operations (0.8.0 batch 5): pure helpers for vehicle filters and sorting, summary
// buckets, wait conditions, the sold-vehicle ledger, money and local-authority failure details.
// Unit-tested in test/fleet.test.js; the commands that use them are in commands.js.

// ---- town ratings (R8; GS v13 town_rating) ------------------------------------------------------

/** GS town_rating row -> { town, rating, rating_value, rated, x, y }. */
export function townRatingFromRow([town, rating, detailed, x, y]) {
  return { town, rating, rating_value: detailed, rated: rating !== 'none' && rating !== '', x, y };
}

/**
 * What a company needs from the local authority for the step that was refused (OpenTTD 15.3
 * station_cmd.cpp / town_cmd.cpp). Station-type ops need a rating above Very Poor (-200);
 * removing town roads, bridges and tunnels needs more, by difficulty.town_council_tolerance.
 */
export function authorityNeed(op) {
  if (['rail_station', 'road_station', 'airport', 'dock'].includes(op)) {
    return { needed: -199, needed_text: 'a new station needs a rating above -200 (better than very_poor)' };
  }
  if (op === 'road_remove' || op === 'demolish') {
    return { needed: null, needed_text: 'removing town road needs 16 / 64 / 112 (lenient / neutral / hostile town_council_tolerance); town buildings lower the rating when removed' };
  }
  return { needed: null, needed_text: 'removing a town bridge or tunnel needs 144 / 208 / 400 (lenient / neutral / hostile town_council_tolerance)' };
}

export const RATING_HINT = 'ratings rise while your stations near the town are served well (each town growth step) and when you plant trees there; '
  + 'they fall when you cut trees or remove town buildings and roads. Build outside the town\'s local-authority radius, or later';

// ---- money failures (L8) -------------------------------------------------------------------------

/**
 * Money detail for a failure or a dry run that costs more than the bank balance. needed = what is
 * missing (null when the cost is unknown). Returns { needed, money, loan, max_loan, loan_headroom, next }.
 */
export function moneyDetail({ cost, money, loan, max_loan }) {
  const headroom = Math.max(0, max_loan - loan);
  const needed = cost === null || cost === undefined ? null : Math.max(0, cost - money);
  const next = needed === null ? `loan --borrow <amount> (headroom ${headroom}), or rerun with --borrow_if_needed true`
    : needed === 0 ? null
      : needed <= headroom ? `loan --borrow ${needed}, or rerun with --borrow_if_needed true`
        : `the loan can add only ${headroom} of the ${needed} needed: sell loss-making vehicles (vehicles --max_profit_last_year 0) or wait for income`;
  return { needed, money, loan, max_loan, loan_headroom: headroom, ...(next ? { next } : {}) };
}

// ---- vehicle filters, sorting, buckets (R5, G3, G13) -------------------------------------------

/** Filter keys shared by vehicles, vehicle-replace --select and vehicle-depot --select. */
export const VEHICLE_FILTER_KEYS = ['ids', 'type', 'group', 'state', 'engine', 'name', 'max_profit_last_year', 'max_profit_this_year',
  'min_age_pct', 'min_age_days', 'max_reliability_pct'];
const NUMERIC_FILTERS = new Set(['group', 'engine', 'max_profit_last_year', 'max_profit_this_year', 'min_age_pct', 'min_age_days', 'max_reliability_pct']);

/** Vehicles matching filter `f` (any subset of VEHICLE_FILTER_KEYS; undefined = no limit). Pure. */
export function filterVehicles(all, f) {
  const ids = f.ids ? new Set(f.ids) : null;
  const lc = (v) => String(v).toLowerCase();
  return all.filter((v) => (!ids || ids.has(v.id)) && (!f.type || v.type === f.type) && (f.group === undefined || v.group === f.group)
    && (!f.state || v.state === f.state) && (f.engine === undefined || v.engine === f.engine)
    && (f.max_profit_last_year === undefined || v.profit_last_year <= f.max_profit_last_year)
    && (f.max_profit_this_year === undefined || v.profit_this_year <= f.max_profit_this_year)
    && (f.min_age_pct === undefined || v.age_pct >= f.min_age_pct) && (f.min_age_days === undefined || v.age_days >= f.min_age_days)
    && (f.max_reliability_pct === undefined || v.reliability_pct <= f.max_reliability_pct)
    && (!f.name || lc(v.name).includes(lc(f.name))));
}

/**
 * --select "min_age_pct=90,type=road" -> filter object for filterVehicles. Keys as VEHICLE_FILTER_KEYS
 * (ids as "ids=1|2|3"). Throws bad_arguments on an unknown key or a bad number.
 */
export function parseSelect(text) {
  const out = {};
  for (const part of String(text).split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^([a-z_]+)\s*[=:]\s*(.+)$/.exec(part);
    if (!m || !VEHICLE_FILTER_KEYS.includes(m[1])) throw new Error(`bad_arguments: --select takes key=value pairs separated by commas; keys: ${VEHICLE_FILTER_KEYS.join(', ')} (got '${part}')`);
    const [, k, v] = m;
    if (k === 'ids') out.ids = v.split('|').map((t) => Number(t.trim()));
    else if (NUMERIC_FILTERS.has(k)) out[k] = Number(v);
    else out[k] = v.trim();
    if ((k === 'ids' && out.ids.some((n) => !Number.isInteger(n))) || (NUMERIC_FILTERS.has(k) && !Number.isFinite(out[k]))) throw new Error(`bad_arguments: --select ${k} needs a number, got '${v}'`);
  }
  if (!Object.keys(out).length) throw new Error('bad_arguments: --select needs at least one key=value, e.g. --select min_age_pct=90,type=road');
  return out;
}

export const VEHICLE_SORTS = ['profit_last_year', 'profit_this_year', 'age', 'reliability', 'value', 'id', 'unit_number'];
const SORT_KEY = { age: 'age_days', reliability: 'reliability_pct' };

/** Sort by one VEHICLE_SORTS key, ascending; a leading '-' sorts descending. Pure (returns a new array). */
export function sortVehicles(list, sort) {
  const desc = sort.startsWith('-');
  const key = SORT_KEY[sort.replace(/^-/, '')] ?? sort.replace(/^-/, '');
  return [...list].sort((p, q) => (desc ? -1 : 1) * ((p[key] ?? 0) - (q[key] ?? 0)) || p.id - q.id);
}

/** summary: counts per age band (years) and reliability band (%), and the vehicles below 50 % reliability. */
export function fleetBuckets(list) {
  const age = { '<1y': 0, '1-5y': 0, '5-10y': 0, '10-20y': 0, '20y+': 0, over_max_age: 0 };
  const rel = { '<40%': 0, '40-60%': 0, '60-80%': 0, '80%+': 0 };
  for (const v of list) {
    const y = v.age_days / 365;
    age[y < 1 ? '<1y' : y < 5 ? '1-5y' : y < 10 ? '5-10y' : y < 20 ? '10-20y' : '20y+']++;
    if (v.age_pct >= 100) age.over_max_age++;
    const r = v.reliability_pct;
    rel[r < 40 ? '<40%' : r < 60 ? '40-60%' : r < 80 ? '60-80%' : '80%+']++;
  }
  const low = list.filter((v) => v.reliability_pct < 50).sort((p, q) => p.reliability_pct - q.reliability_pct).map((v) => ({ id: v.id, reliability_pct: v.reliability_pct, age_pct: v.age_pct }));
  return { age_buckets: age, reliability_buckets: rel, low_reliability: low };
}

/** GS vehicle_loads rows -> Map vehicle -> { load, capacity, pct, cargo: [{ cargo, load, capacity }] }. */
export function loadsFromRows(rows) {
  const out = new Map();
  for (const [v, cargo, capacity, load] of rows) {
    const e = out.get(v) ?? { load: 0, capacity: 0, cargo: [] };
    e.load += load; e.capacity += capacity; e.cargo.push({ cargo, load, capacity });
    out.set(v, e);
  }
  for (const e of out.values()) e.pct = e.capacity ? Math.round((100 * e.load) / e.capacity) : 0;
  return out;
}

// ---- wait (G5 / C11) ----------------------------------------------------------------------------

export const WAIT_STATES = ['in_depot', 'at_station', 'loaded', 'moving', 'stopped', 'sold'];

/**
 * Does vehicle row `v` (null = gone) meet `until`? `load`: { pct } from loadsFromRows or null;
 * loadPct: the share of capacity that counts as loaded. `sold`: it is in the sold-vehicle ledger.
 */
export function waitMatch(v, until, { load = null, loadPct = 100, sold = false } = {}) {
  if (!v) return until === 'sold' ? sold : false;
  switch (until) {
    case 'in_depot': return v.state === 'in_depot';
    case 'at_station': return v.state === 'at_station';
    case 'moving': return v.state === 'running' && (v.speed === undefined || v.speed > 0);
    case 'stopped': return v.state === 'stopped' || v.state === 'in_depot';
    case 'loaded': return !!load && load.capacity > 0 && load.pct >= loadPct;
    default: return false;
  }
}

// ---- sold-vehicle ledger (L10) ---------------------------------------------------------------

/** Text for a vehicle id that no longer exists but is in the ledger: when it was sold, by what replaced, who serves its stations now. */
export function soldText(entry, servingNow = []) {
  const by = entry.replaced_by !== undefined && entry.replaced_by !== null ? ` (replaced by ${entry.replaced_by})` : '';
  const now = entry.stations?.length ? `; vehicles with orders for its stations now: ${servingNow.length ? servingNow.join(', ') : 'none'}` : '';
  return `already_sold: vehicle ${entry.vehicle} was sold on ${entry.sold_on}${by} for ${entry.income}${now}`;
}
