// Vehicle problem checks for `vehicle-problems`. Pure functions over decoded `vehicles` rows,
// a per-vehicle progress history and connectivity results.
//
// The game does not tell GameScripts that a vehicle is lost (ScriptEventVehicleLost is AI-only),
// so "lost" is inferred: a vehicle that keeps the same order for `stuckDays` game days without
// ever getting closer to that order's destination than it already was.
//
// The history lives in the client (daemon or relay session), not in the GameScript: it works with
// any AgentBridge version, needs no save/load handling and costs the game nothing. It restarts
// when the daemon does, so the stuck check needs two calls `stuckDays` game days apart.

const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * Record one sample. `history` is a Map key -> entry; returns the updated entry
 * { order, best, since, first, samples, last }. Progress = a new current order, or a new
 * closest distance to the destination. Waiting at a station also counts (loading is not being lost).
 */
export function recordProgress(history, k, { date, order, dist, atStation }) {
  const prev = history.get(k);
  if (!prev || prev.order !== order || dist === null || atStation || (prev.best !== null && dist < prev.best)) {
    const e = { order, best: dist, since: date, first: prev?.first ?? date, samples: (prev?.samples ?? 0) + 1, last: date };
    history.set(k, e);
    return e;
  }
  const e = { ...prev, samples: prev.samples + 1, last: date };
  history.set(k, e);
  return e;
}

/**
 * Record one standstill sample. `history`: Map key -> { x, y, since, last, samples } while the vehicle
 * stands on one tile at speed 0 outside stations and depots, not broken down; any movement deletes
 * it. Returns the entry or null.
 */
export function recordStall(history, k, { date, x, y, speed, state }) {
  const standing = speed === 0 && (state === 'running');
  const prev = history.get(k);
  if (!standing) { history.delete(k); return null; }
  if (prev && prev.x === x && prev.y === y) {
    const e = { ...prev, last: date, samples: prev.samples + 1 };
    history.set(k, e);
    return e;
  }
  const e = { x, y, since: date, last: date, samples: 1 };
  history.set(k, e);
  return e;
}

/**
 * Pairs of stalled trains that block each other: both stalled >= stallDays and within `radius`
 * tiles. stalled: [{ id, x, y, type }]. Returns Map id -> [partner ids].
 */
export function deadlockPartners(stalled, { radius = 16 } = {}) {
  const out = new Map();
  const rail = stalled.filter((v) => v.type === 'rail');
  for (const a of rail) {
    for (const b of rail) {
      if (a.id === b.id || manhattan(a, b) > radius) continue;
      out.set(a.id, [...(out.get(a.id) ?? []), b.id]);
    }
  }
  return out;
}

const fmtTile = (p) => `(${p.x},${p.y})`;

/**
 * Problems of one vehicle. `v`: decoded vehicle row plus current_order, dest {x, y} | null,
 * dest_station, dest_name, speed. `progress`: entry from recordProgress (or null).
 * `reach`: trace from the vehicle to its destination ({ connected, method, last_reachable, first_gap }) or null.
 * `line`: trace between the vehicle's own order stations, or null.
 * Returns [{ problem, severity, evidence, suggested_fix }]. severity 'action': the vehicle cannot
 * earn until fixed; 'info': worth knowing, no command needed now (do not stop a working train for it).
 */
export const INFO_PROBLEMS = new Set(['crashed', 'old', 'broken_down', 'low_reliability']);

export function vehicleProblems(v, { today, stuckDays = 30, progress = null, reach = null, line = null, stall = null, stallDays = 10, partners = null, parkedDays = null } = {}) {
  const out = [];
  const add = (problem, evidence, suggested_fix) => out.push({ problem, severity: INFO_PROBLEMS.has(problem) ? 'info' : 'action', evidence, suggested_fix });
  const dest = v.dest_name ? `${v.dest_name} ${v.dest ? fmtTile(v.dest) : ''}`.trim() : v.dest ? fmtTile(v.dest) : 'its destination';
  if (v.state === 'crashed') add('crashed', 'state crashed', 'nothing to do: the wreck disappears; replace the train if the line needs it');
  if (v.order_count === 0) add('no_orders', 'order_count 0', `give it orders: order-add --vehicle ${v.id} (or orders-copy from a working vehicle of the same line)`);
  if (v.state === 'in_depot' && v.type === 'rail' && v.unit_number !== undefined && v.unit_number < 1) {
    add('loose_wagons', `wagons without a locomotive in the depot at ${fmtTile(v)}${parkedDays !== null ? ` for ${parkedDays} days` : ''}`, `vehicle-sell --vehicles ${v.id} (they earn nothing), or attach them to a train in that depot`);
  } else if (v.state === 'in_depot') {
    add('stopped_in_depot', `in depot at ${fmtTile(v)}, not started${parkedDays !== null ? `; parked for ${parkedDays} days` : ''}`, `vehicle-start --vehicles ${v.id}, or vehicle-sell --vehicles ${v.id} if it is not needed (parked vehicles earn nothing and lower the rating's min_profit at 2 years old)`);
  }
  if (v.state === 'stopped') add('stopped', `stopped outside a depot at ${fmtTile(v)}`, `vehicle-start --vehicles ${v.id}`);

  const net = v.type === 'road' ? 'road' : 'rail';
  if (reach && !reach.connected && v.order_count > 0 && v.state !== 'in_depot') {
    const gap = reach.first_gap ? `; first gap at ${fmtTile(reach.first_gap)} (${reach.first_gap.reason})` : '';
    const where = reach.last_reachable ? `; ${v.type === 'road' ? 'road' : 'track'} from ${fmtTile(v)} ends at ${fmtTile(reach.last_reachable)}` : '';
    const coarse = reach.method === 'mirror_adjacency' ? ' [coarse: map mirror without track directions]' : '';
    if (line && line.connected) {
      add('wrong_network', `no ${net} path from ${fmtTile(v)} to ${dest}, although its order stations are joined to each other${where}${gap}${coarse}`,
        net === 'road' ? `it is on a road network its stops are not on (bought at another depot?): vehicle-depot --vehicles ${v.id}, then vehicle-sell, and buy one at a depot joined to its stops`
          : `it runs on another line's track (bought or cloned at a depot of another line?): vehicle-depot --vehicles ${v.id}, then vehicle-sell once it is in the depot, and clone a train at a depot of its own line instead`);
    } else {
      add('unreachable_destination', `no ${net} path from ${fmtTile(v)} to ${dest}${where}${gap}${coarse}`,
        net === 'road' ? `run verify-route --vehicle ${v.id}; join the gap with build-road-path (or turn the stop or depot to face the road), or give it orders for stops on its own roads`
          : `run verify-route --vehicle ${v.id}; join the gap with build-track or build-rail, or give the vehicle orders for stations on its own track`);
    }
  }

  const stalledFor = stall ? today - stall.since : 0;
  if (stall && stalledFor >= stallDays && stall.samples >= 2) {
    if (partners && partners.length) {
      add('deadlock', `standing at ${fmtTile(v)} at speed 0 for ${stalledFor} days, as are train${partners.length > 1 ? 's' : ''} ${partners.join(', ')} nearby: they block each other (often two trains meeting in a loop or single track too short for them)`,
        `vehicle-reverse --vehicles ${v.id} (one of them is enough; the other then gets its path), then check the loop: loop-sites / build-passing-loop --train_tiles N for longer trains, or remove the short loop (build-passing-loop ... --remove true) with the trains in depots`);
    } else {
      add('stalled_on_line', `standing at ${fmtTile(v)} at speed 0 for ${stalledFor} days (not at a station, not broken down)`,
        `probably waiting at a red signal for a path that never frees: run verify-route --vehicle ${v.id}; look for a train or a wagon in the way ahead; vehicle-reverse --vehicles ${v.id} turns it round`);
    }
  }

  if (progress && v.order_count > 0 && v.state !== 'in_depot' && v.state !== 'stopped' && v.state !== 'crashed') {
    const stalled = today - progress.since;
    if (stalled >= stuckDays && !(stall && stalledFor >= stallDays && stall.samples >= 2)) {
      add('stuck_or_lost', `order ${v.current_order} (to ${dest}) for ${stalled} days without getting closer than ${progress.best} tiles; now ${v.dist ?? '?'} tiles away, speed ${v.speed ?? '?'}`,
        v.speed === 0
          ? 'standing still: probably waiting at a red signal or behind another train; check the track ahead and the number of trains on the line'
          : `probably lost (the game shows "cannot reach"): run verify-route --vehicle ${v.id} and fix the gap it reports`);
    }
  }

  if (v.profit_last_year < 0 && v.age_days > 365) {
    add('no_income', `profit_last_year ${v.profit_last_year} at age ${Math.floor(v.age_days / 365)} years`,
      out.length ? 'fix the problems above first; they stop it earning' : 'check that it loads (stations: cargo waiting, rating) and delivers to a station that accepts the cargo; sell it if the line cannot pay');
  }
  if (v.age_pct >= 100) add('old', `age ${v.age_days} days is ${v.age_pct}% of its max age`, `when convenient: group-autoreplace, or buy a newer engine (engines --type ${v.type}) for its line and sell this one; it keeps running meanwhile`);
  if (v.state === 'broken') add('broken_down', 'broken down now', `none now: it moves again by itself in a few days (reliability ${v.reliability_pct}%); do not send it to a depot. If it happens often, replace old engines`);
  else if (v.reliability_pct < 40 && v.state !== 'crashed') add('low_reliability', `reliability ${v.reliability_pct}%`, `none needed while it runs: trains service at depots on their route automatically. Optional: vehicle-depot --vehicles ${v.id} --service true (service and carry on; without --service true it stops in the depot), or replace it when old`);
  return out;
}

export { manhattan };
