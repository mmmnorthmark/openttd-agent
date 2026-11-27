// Rail connectivity tracing. Pure functions: tile data comes in through a getter, so they run on
// GameScript `rail_tiles` rows (exact track bits) or, as a coarse fallback, on the map mirror.
//
// Ideas ported, not code: the directed walk that a train cannot reverse out of mid-line, and the
// report of how far the walk got, come from nttd's trace_route (Apache-2.0); checking topology,
// orders and income per route comes from openttd-directorate-mcp's verify-route (MIT). See NOTICE.
//
// Directions and tile edges use one index: 0 +x (SW), 1 +y (SE), 2 -x (NE), 3 -y (NW), the same as
// DIRS in planner.js. Edge d of a tile is the side shared with the neighbour in direction d.

export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
// GSRail RAILTRACK bits -> the two edges each track piece joins.
const PIECES = [[1, [2, 0]], [2, [3, 1]], [4, [3, 2]], [8, [0, 1]], [16, [3, 0]], [32, [2, 1]]];
const opposite = (d) => (d + 2) % 4;
const key = (x, y) => `${x},${y}`;

/** Edges a set of track bits touches. */
export function trackEdges(tracks) {
  const out = new Set();
  for (const [bit, [a, b]] of PIECES) if (tracks & bit) { out.add(a); out.add(b); }
  return out;
}

/** Edges a train entering through `entry` can leave by. */
export function trackExits(tracks, entry) {
  const out = [];
  for (const [bit, [a, b]] of PIECES) {
    if (!(tracks & bit)) continue;
    if (a === entry) out.push(b); else if (b === entry) out.push(a);
  }
  return out;
}

/** Direction from (x,y) to an orthogonal tile (ax,ay), or -1. */
export function dirTo(x, y, ax, ay) {
  const dx = Math.sign(ax - x), dy = Math.sign(ay - y);
  if (dx !== 0 && dy !== 0) return -1;
  return DIRS.findIndex(([a, b]) => a === dx && b === dy);
}

/** GS `rail_tiles` row -> tile object. */
export function railTileFromRow([x, y, kind, tracks, station, a, b, owner, rail_type, signals]) {
  return { x, y, kind, tracks, station, a, b, owner, rail_type, signals };
}

/**
 * Why a train cannot enter tile `t` through its edge `edge`, or null when it can.
 * `company` (optional) keeps the walk on that company's track.
 */
export function entryRefusal(t, edge, company) {
  if (!t) return 'no_track';
  if (company !== undefined && company !== null && t.owner !== company) return 'other_company_track';
  if (t.kind === 'd') return dirTo(t.x, t.y, t.a, t.b) === edge ? null : 'depot_entrance_faces_away';
  if (t.kind === 'b' || t.kind === 'u') return opposite(dirTo(t.x, t.y, t.a, t.b)) === edge ? null : (t.kind === 'b' ? 'bridge_side' : 'tunnel_side');
  if (!trackEdges(t.tracks).has(edge)) return t.kind === 's' ? 'station_platform_side' : 'track_not_joined';
  // rail_tiles bit d: a one-way path signal facing trains that come from neighbour d (GSRail.GetSignalType
  // with front = that neighbour; OpenTTD's HasSignalOnTrackdir). A train entering through `edge` came
  // from neighbour `edge`, so it is against a signal facing trains from the other side.
  if (t.signals & (1 << opposite(edge))) return 'one_way_signal_against';
  return null;
}

/** Ways out of `t` for a train that came in through `entry` (null = placed there): [{ x, y, edge } of the next tile]. */
function moves(t, entry) {
  if (t.kind === 'd') {
    const d = dirTo(t.x, t.y, t.a, t.b);
    return [{ x: t.a, y: t.b, edge: opposite(d), from: t }];
  }
  if (t.kind === 'b' || t.kind === 'u') {
    const d = dirTo(t.x, t.y, t.a, t.b);
    const out = [];
    // Entered from the open side (or placed here): cross to the other end and leave it.
    if (entry === null || entry === opposite(d)) out.push({ x: t.a + DIRS[d][0], y: t.b + DIRS[d][1], edge: opposite(d), from: { x: t.a, y: t.b }, via: { x: t.a, y: t.b } });
    if (entry === null) out.push({ x: t.x + DIRS[opposite(d)][0], y: t.y + DIRS[opposite(d)][1], edge: d, from: t });
    return out;
  }
  const exits = entry === null ? [...trackEdges(t.tracks)] : trackExits(t.tracks, entry);
  return exits.map((e) => ({ x: t.x + DIRS[e][0], y: t.y + DIRS[e][1], edge: opposite(e), from: t }));
}

/**
 * Walk the rail network from `starts` ([{x, y}]) until a tile satisfies `isGoal(tile)`.
 * `getTile(x, y)` returns a tile object or null (may be async). A train may not reverse
 * mid-line, so the state is (tile, entry edge); it may reverse at a dead end and in a depot.
 * `goal` ({x, y}) only orders the "last reachable" report.
 * Returns { connected, reached, tiles_reached, steps, exhausted, last_reachable, first_gap }; when
 * connected, `path` = the tiles walked from a start to the goal, in order ([{x, y}]).
 */
export async function traceRail({ getTile, starts, isGoal, goal, company, maxSteps = 20000 }) {
  const seen = new Set();
  const reachedTiles = new Map();
  const gaps = [];
  const queue = [];
  const dist = (p) => (goal ? Math.abs(p.x - goal.x) + Math.abs(p.y - goal.y) : 0);
  for (const s of starts) {
    const t = await getTile(s.x, s.y);
    if (!t) { gaps.push({ from: s, to: s, reason: 'start_has_no_track' }); continue; }
    queue.push({ t, entry: null, prev: null });
  }
  let steps = 0, reached = null, reachedNode = null;
  while (queue.length && steps < maxSteps) {
    const node = queue.shift();
    const { t, entry } = node;
    const k = `${t.x},${t.y},${entry}`;
    if (seen.has(k)) continue;
    seen.add(k);
    steps++;
    reachedTiles.set(key(t.x, t.y), t);
    if (isGoal(t)) { reached = { x: t.x, y: t.y }; reachedNode = node; break; }
    let open = 0;
    for (const m of moves(t, entry)) {
      if (m.via) reachedTiles.set(key(m.via.x, m.via.y), { x: m.via.x, y: m.via.y });
      const n = await getTile(m.x, m.y);
      const why = entryRefusal(n, m.edge, company);
      if (why) { gaps.push({ from: { x: m.from.x, y: m.from.y }, to: { x: m.x, y: m.y }, reason: why }); continue; }
      open++;
      queue.push({ t: n, entry: m.edge, prev: node });
    }
    // Dead end of plain track: the train reverses and leaves the way it came.
    if (!open && entry !== null && (t.kind === 't' || t.kind === 's' || t.kind === 'w' || t.kind === 'x')) {
      const back = opposite(entry);
      const bx = t.x + DIRS[entry][0], by = t.y + DIRS[entry][1];
      const n = await getTile(bx, by);
      if (n && !entryRefusal(n, back, company)) queue.push({ t: n, entry: back, prev: node });
    }
  }
  const tiles = [...reachedTiles.values()];
  const path = [];
  for (let n = reachedNode; n; n = n.prev) path.push({ x: n.t.x, y: n.t.y });
  const out = { connected: !!reached, ...(reached ? { reached, path: path.reverse() } : {}), tiles_reached: tiles.length, steps, exhausted: !reached && steps >= maxSteps };
  if (reached || !tiles.length) return out;
  const last = tiles.reduce((best, p) => (dist(p) < dist(best) ? p : best), tiles[0]);
  const fromLast = gaps.filter((g) => g.from.x === last.x && g.from.y === last.y);
  const pool = fromLast.length ? fromLast : gaps;
  const gap = pool.length ? pool.reduce((best, g) => (dist(g.to) < dist(best.to) ? g : best), pool[0]) : null;
  return { ...out, last_reachable: { x: last.x, y: last.y }, ...(gap ? { first_gap: { x: gap.to.x, y: gap.to.y, from: gap.from, reason: gap.reason } } : {}) };
}

/**
 * Coarse fallback on the map mirror (classes only, no track direction): flood over rail 'r' and
 * station 's' tiles, 4-connected. Depots (`depots`: [{x, y}]) are never walked through (the mirror
 * does not know which side the entrance is), only started from. Bridge heads and
 * tunnel portals show as 'o': a straight run that enters an 'o' tile and comes out of another 'o'
 * tile onto rail within 16 tiles is followed as a bridge or tunnel (houses can fool this).
 * Not connected here almost always means not connected. Connected here may still be wrong:
 * parallel or crossing lines touch without joining, and track direction is unknown.
 */
export function adjacencyTrace(map, starts, goalTiles, goal, { depots = [], maxSteps = 50000 } = {}) {
  const depotSet = new Set(depots.map((d) => key(d.x, d.y)));
  const cls = (x, y) => (map.inBounds(x, y) ? map.classAt(x, y) : null);
  const ok = (x, y) => cls(x, y) === 'r' || cls(x, y) === 's';
  const goals = new Set(goalTiles.map((p) => key(p.x, p.y)));
  const seen = new Set();
  const queue = [];
  for (const s of starts) {
    if (ok(s.x, s.y)) queue.push(s);
    else for (const [dx, dy] of DIRS) if (ok(s.x + dx, s.y + dy)) queue.push({ x: s.x + dx, y: s.y + dy });
  }
  // Rail tile beyond a possible bridge or tunnel that starts at the 'o' tile (x, y), going (dx, dy).
  const across = (x, y, dx, dy) => {
    for (let k = 1; k <= 16; k++) {
      const ex = x + k * dx, ey = y + k * dy;
      if (!map.inBounds(ex, ey)) return null;
      if (cls(ex, ey) === 'o' && !depotSet.has(key(ex, ey)) && ok(ex + dx, ey + dy)) return { x: ex + dx, y: ey + dy };
    }
    return null;
  };
  const dist = (p) => (goal ? Math.abs(p.x - goal.x) + Math.abs(p.y - goal.y) : 0);
  let last = null, steps = 0;
  while (queue.length && steps < maxSteps) {
    const p = queue.shift();
    if (seen.has(key(p.x, p.y))) continue;
    seen.add(key(p.x, p.y));
    steps++;
    if (!last || dist(p) < dist(last)) last = p;
    if (goals.has(key(p.x, p.y))) return { connected: true, reached: p, tiles_reached: seen.size, steps };
    for (const [dx, dy] of DIRS) {
      const nx = p.x + dx, ny = p.y + dy;
      if (ok(nx, ny)) { if (!seen.has(key(nx, ny))) queue.push({ x: nx, y: ny }); continue; }
      if (cls(nx, ny) === 'o' && !depotSet.has(key(nx, ny))) {
        const far = across(nx, ny, dx, dy);
        if (far && !seen.has(key(far.x, far.y))) queue.push(far);
      }
    }
  }
  const out = { connected: false, tiles_reached: seen.size, steps };
  if (!last) return out;
  // First gap: the neighbour of the last reachable tile that lies toward the goal.
  const toward = DIRS.map(([dx, dy]) => ({ x: last.x + dx, y: last.y + dy })).filter((p) => map.inBounds(p.x, p.y))
    .reduce((best, p) => (!best || dist(p) < dist(best) ? p : best), null);
  return { ...out, last_reachable: last, ...(toward ? { first_gap: { x: toward.x, y: toward.y, from: last, reason: `mirror class '${map.classAt(toward.x, toward.y)}'` } } : {}) };
}

/** Station tiles in the mirror: the 's' tiles 4-connected to (x, y). */
export function mirrorStationTiles(map, x, y, limit = 200) {
  const out = [];
  const seen = new Set();
  const queue = [{ x, y }];
  while (queue.length && out.length < limit) {
    const p = queue.shift();
    if (seen.has(key(p.x, p.y)) || !map.inBounds(p.x, p.y) || map.classAt(p.x, p.y) !== 's') continue;
    seen.add(key(p.x, p.y));
    out.push(p);
    for (const [dx, dy] of DIRS) queue.push({ x: p.x + dx, y: p.y + dy });
  }
  return out;
}

// ---- road (AgentBridge v11 `road_tiles`) ------------------------------------------------------

/** GS `road_tiles` row -> tile object. links: bit d = a road vehicle can drive into the neighbour in direction d. */
export function roadTileFromRow([x, y, kind, links, station, a, b, owner]) {
  return { x, y, kind, links, station, a, b, owner, road: true };
}

const STOP_KINDS = new Set(['s', 't', 'd']);

/** Why a road vehicle on `t` cannot drive into direction d (no link). `n`: the neighbour tile or null. */
export function roadGapReason(t, d, n) {
  const front = t.a >= 0 && dirTo(t.x, t.y, t.a, t.b) === d;
  if (t.kind === 'd' && front) return 'depot_not_joined';
  if (t.kind === 's' && front) return 'stop_not_joined';
  if (!n) return 'no_road';
  if (n.links & (1 << opposite(d))) return 'one_way_road';
  if (n.kind === 'd') return dirTo(n.x, n.y, n.a, n.b) === opposite(d) ? 'depot_not_joined' : 'depot_entrance_faces_away';
  if (n.kind === 's') return dirTo(n.x, n.y, n.a, n.b) === opposite(d) ? 'stop_not_joined' : 'stop_entrance_faces_away';
  return 'road_not_joined';
}

/**
 * Walk the road network from `starts` ([{x, y}]) over `links` until isGoal(tile). Directed (one-way
 * roads count); road vehicles turn round at road ends, so no entry state is kept. Stops and depots of
 * another company (`company` given) are not entered. Bridges and tunnels join their two heads.
 * Returns the same shape as traceRail: { connected, reached, tiles_reached, steps, last_reachable, first_gap }.
 */
export async function traceRoad({ getTile, starts, isGoal, goal, company, maxSteps = 20000 }) {
  const seen = new Set();
  const reached = [];
  const gaps = [];
  const queue = [];
  const dist = (p) => (goal ? Math.abs(p.x - goal.x) + Math.abs(p.y - goal.y) : 0);
  for (const s of starts) {
    const t = await getTile(s.x, s.y);
    if (!t) { gaps.push({ from: s, to: s, reason: 'start_has_no_road' }); continue; }
    queue.push(t);
  }
  let steps = 0, hit = null;
  while (queue.length && steps < maxSteps) {
    const t = queue.shift();
    const k = key(t.x, t.y);
    if (seen.has(k)) continue;
    seen.add(k);
    steps++;
    reached.push(t);
    if (isGoal(t)) { hit = { x: t.x, y: t.y }; break; }
    if ((t.kind === 'b' || t.kind === 'u') && t.a >= 0) {
      const o = await getTile(t.a, t.b);
      if (o && !seen.has(key(o.x, o.y))) queue.push(o);
    }
    for (let d = 0; d < 4; d++) {
      const nx = t.x + DIRS[d][0], ny = t.y + DIRS[d][1];
      const n = await getTile(nx, ny);
      if (!(t.links & (1 << d))) { gaps.push({ from: t, to: { x: nx, y: ny }, reason: roadGapReason(t, d, n) }); continue; }
      if (!n) { gaps.push({ from: t, to: { x: nx, y: ny }, reason: 'no_road' }); continue; }
      if (company !== undefined && company !== null && STOP_KINDS.has(n.kind) && n.owner !== company && !isGoal(n)) {
        gaps.push({ from: t, to: { x: nx, y: ny }, reason: 'other_owner_road' });
        continue;
      }
      if (!seen.has(key(nx, ny))) queue.push(n);
    }
  }
  const out = { connected: !!hit, ...(hit ? { reached: hit } : {}), tiles_reached: reached.length, steps, exhausted: !hit && steps >= maxSteps };
  if (hit || !reached.length) return { ...out, ...(gaps.length && !reached.length ? { first_gap: { x: gaps[0].to.x, y: gaps[0].to.y, from: gaps[0].from, reason: gaps[0].reason } } : {}) };
  const last = reached.reduce((best, p) => (dist(p) < dist(best) ? p : best), reached[0]);
  const fromLast = gaps.filter((g) => g.from.x === last.x && g.from.y === last.y);
  const pool = fromLast.length ? fromLast : gaps;
  const gap = pool.length ? pool.reduce((best, g) => (dist(g.to) < dist(best.to) ? g : best), pool[0]) : null;
  return { ...out, last_reachable: { x: last.x, y: last.y }, ...(gap ? { first_gap: { x: gap.to.x, y: gap.to.y, from: { x: gap.from.x, y: gap.from.y }, reason: gap.reason } } : {}) };
}

// ---- passing loops on a traced line (real geometry) ----------------------------------------

const SIGNAL_BITS = 0xFF; // rail_tiles signals: bit d one-way, bit 4+d any signal facing trains from neighbour d
const LOOP_TILE_KINDS = new Set(['t', 's', 'w']);

/**
 * Walk a branch that leaves tile `from` through edge `d`, following the only track exit on each
 * tile, until it reaches a tile of the line (`index`: "x,y" -> path index). Signals are ignored
 * (a loop's one-way signals face one direction). Returns { to_index, tiles } or null (dead end,
 * a junction on the branch, a bridge/tunnel/depot, or longer than maxBranch).
 */
async function walkBranch(getTile, from, d, index, fromIndex, maxBranch) {
  const tiles = [];
  const seen = new Set();
  let x = from.x + DIRS[d][0], y = from.y + DIRS[d][1], entry = opposite(d);
  while (tiles.length <= maxBranch) {
    const k = key(x, y);
    const t = await getTile(x, y);
    if (!t || !LOOP_TILE_KINDS.has(t.kind) || !trackEdges(t.tracks).has(entry)) return null;
    const j = index.get(k);
    if (j !== undefined) return j > fromIndex + 1 ? { to_index: j, tiles } : null;
    if (seen.has(k)) return null;
    seen.add(k);
    tiles.push(t);
    const exits = trackExits(t.tracks, entry);
    if (exits.length !== 1) return null;
    x += DIRS[exits[0]][0]; y += DIRS[exits[0]][1]; entry = opposite(exits[0]);
  }
  return null;
}

/**
 * Passing loops on a traced line, from the track itself: a points tile on `path` (traceRail path,
 * [{x, y}] in order) where a second track leaves the line and joins it again further along. Not
 * loops: terminus throats (the branch ends in a platform), depot spurs and branches to other lines
 * (they never rejoin), crossings (no branch). getTile(x, y) -> rail_tiles tile (may be async).
 * clear_tiles = min(line tiles between the points, branch tiles minus its two curves) - 1, the
 * room a waiting train has (build-passing-loop's clear_tiles); signals_ok = both sides have a
 * signal (without one on each side the loop is one block and trains cannot pass there).
 * Returns [{ from_index, to_index, at: {x, y}, end: {x, y}, line_tiles, branch_tiles, clear_tiles,
 * line_signal, branch_signal, signals_ok }] in path order.
 */
export async function findLoops({ path, getTile, maxBranch = 80 }) {
  const index = new Map();
  path.forEach((p, i) => { if (!index.has(key(p.x, p.y))) index.set(key(p.x, p.y), i); });
  const loops = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const t = await getTile(path[i].x, path[i].y);
    if (!t || t.kind !== 't' || trackEdges(t.tracks).size < 3) continue;
    const next = dirTo(t.x, t.y, path[i + 1].x, path[i + 1].y);
    if (next < 0) continue;
    // Branches: other exits for a train that enters by the same edge as the line's way on (the stem of the points).
    const branches = new Set();
    for (let e = 0; e < 4; e++) {
      const ex = trackExits(t.tracks, e);
      if (ex.includes(next) && ex.length >= 2) for (const b of ex) if (b !== next) branches.add(b);
    }
    for (const b of branches) {
      const w = await walkBranch(getTile, t, b, index, i, maxBranch);
      if (!w) continue;
      const between = path.slice(i + 1, w.to_index);
      let lineSignal = false;
      for (const p of between) if (((await getTile(p.x, p.y))?.signals ?? 0) & SIGNAL_BITS) lineSignal = true;
      const branchSignal = w.tiles.some((q) => (q.signals ?? 0) & SIGNAL_BITS);
      const clear = Math.max(0, Math.min(between.length, w.tiles.length - 2) - 1);
      loops.push({ from_index: i, to_index: w.to_index, at: { x: t.x, y: t.y }, end: { x: path[w.to_index].x, y: path[w.to_index].y },
        line_tiles: between.length, branch_tiles: w.tiles.length, clear_tiles: clear, line_signal: lineSignal, branch_signal: branchSignal, signals_ok: lineSignal && branchSignal });
    }
  }
  return loops;
}
