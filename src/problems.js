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

const fmtTile = (p) => `(${p.x},${p.y})`;

/**
 * Problems of one vehicle. `v`: decoded vehicle row plus current_order, dest {x, y} | null,
 * dest_station, dest_name, speed. `progress`: entry from recordProgress (or null).
 * `reach`: trace from the vehicle to its destination ({ connected, method, last_reachable, first_gap }) or null.
 * `line`: trace between the vehicle's own order stations, or null.
 * Returns [{ problem, evidence, suggested_fix }].
 */
export function vehicleProblems(v, { today, stuckDays = 30, progress = null, reach = null, line = null } = {}) {
  const out = [];
  const add = (problem, evidence, suggested_fix) => out.push({ problem, evidence, suggested_fix });
  const dest = v.dest_name ? `${v.dest_name} ${v.dest ? fmtTile(v.dest) : ''}`.trim() : v.dest ? fmtTile(v.dest) : 'its destination';
  if (v.state === 'crashed') add('crashed', 'state crashed', 'nothing to do: the wreck disappears; replace the train if the line needs it');
  if (v.order_count === 0) add('no_orders', 'order_count 0', `give it orders: order-add --vehicle ${v.id} (or orders-copy from a working vehicle of the same line)`);
  if (v.state === 'in_depot') add('stopped_in_depot', `in depot at ${fmtTile(v)}, not started`, `vehicle-start --vehicles ${v.id}, or vehicle-sell --vehicles ${v.id} if it is not needed`);
  if (v.state === 'stopped') add('stopped', `stopped outside a depot at ${fmtTile(v)}`, `vehicle-start --vehicles ${v.id}`);

  if (reach && !reach.connected && v.order_count > 0 && v.state !== 'in_depot') {
    const gap = reach.first_gap ? `; first gap at ${fmtTile(reach.first_gap)} (${reach.first_gap.reason})` : '';
    const where = reach.last_reachable ? `; track from ${fmtTile(v)} ends at ${fmtTile(reach.last_reachable)}` : '';
    const coarse = reach.method === 'mirror_adjacency' ? ' [coarse: map mirror without track directions]' : '';
    if (line && line.connected) {
      add('wrong_network', `no rail path from ${fmtTile(v)} to ${dest}, although its order stations are joined to each other${where}${gap}${coarse}`,
        `it runs on another line's track (bought or cloned at a depot of another line?): vehicle-depot --vehicles ${v.id}, then vehicle-sell once it is in the depot, and clone a train at a depot of its own line instead`);
    } else {
      add('unreachable_destination', `no rail path from ${fmtTile(v)} to ${dest}${where}${gap}${coarse}`,
        `run verify-route --vehicle ${v.id}; join the gap with build-track or build-rail, or give the vehicle orders for stations on its own track`);
    }
  }

  if (progress && v.order_count > 0 && v.state !== 'in_depot' && v.state !== 'stopped' && v.state !== 'crashed') {
    const stalled = today - progress.since;
    if (stalled >= stuckDays) {
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
  if (v.age_pct >= 100) add('old', `age ${v.age_days} days is ${v.age_pct}% of its max age`, `replace it: group-autoreplace, or vehicle-sell and buy a newer engine (engines --type ${v.type})`);
  if (v.state === 'broken') add('broken_down', 'broken down now', `reliability ${v.reliability_pct}%: replace old engines and keep servicing on (breakdown counts are not exposed to scripts)`);
  else if (v.reliability_pct < 40 && v.state !== 'crashed') add('low_reliability', `reliability ${v.reliability_pct}%`, `it will break down often: send it for servicing (vehicle-depot --vehicles ${v.id} --service true) or replace it`);
  return out;
}

export { manhattan };
