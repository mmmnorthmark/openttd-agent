// Buildable tile paths for rail and road over the TileMap, and their conversion
// into GS exec steps. Pure functions (unit-tested without a game).
//
// Geometry (OpenTTD): tile (x,y) has corners N (x,y), W (x+1,y), S (x+1,y+1),
// E (x,y+1). Slope bits: W=1, S=2, E=4, N=8, steep=16. The mirror stores the
// tile's MAX height, so on a sloped tile raised corners are at H and the others
// at H-1.
//
// Track model (a deliberate simplification of the game's rules; the GS dry run
// is the authority):
//  - flat tile: track at H, turns allowed
//  - sloped tile crossed straight between two level edges (an incline): track
//    follows the slope, no turn
//  - any other use of a sloped tile needs a foundation: track at H
//  - steep tiles, houses/objects, industries and stations are impassable
//  - water, coast and (for rail) existing rail can only be bridged; roads are
//    crossed straight on the level or bridged
//  - rail may not turn the same way on two consecutive tiles (a 90 degree corner)

import { MinHeap, manhattan } from './world.js';

export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // +x (SW), +y (SE), -x (NE), -y (NW)
export const DIR_NAMES = ['sw', 'se', 'ne', 'nw'];
const EDGE_CORNERS = [[2, 1], [2, 4], [8, 4], [8, 1]]; // corners of the edge crossed when leaving in DIRS[d]
const OPEN = new Set(['b', 't', 'f', 'k', 'h']);        // buildable after auto-clearing
const SOLID = new Set(['o', 'i', 's']);                 // never passable

export const RAIL_COSTS = { base: 1, turn: 0.6, foundation: 2, climb: 3, crossing: 8, bridge_base: 12, bridge_per_tile: 6, t: 0.2, f: 0.5, k: 0.3, h: 0.1, b: 0, reuse: 0 };
export const ROAD_COSTS = { base: 1, turn: 0.3, foundation: 1.5, climb: 1.5, crossing: 8, bridge_base: 10, bridge_per_tile: 5, t: 0.2, f: 0.5, k: 0.3, h: 0.1, b: 0, reuse: -0.7 };

/** 'sw' | 'se' | 'ne' | 'nw' (or +x/+y/-x/-y) -> index into DIRS; undefined passes through. */
export function dirIndex(name) {
  if (name === undefined || name === null || name === '') return undefined;
  const i = DIR_NAMES.indexOf(String(name).toLowerCase());
  if (i !== -1) return i;
  const j = ['+x', '+y', '-x', '-y'].indexOf(String(name));
  if (j === -1) throw new Error(`unknown direction '${name}'. Use sw (+x), se (+y), ne (-x) or nw (-y)`);
  return j;
}

/** Track level at the edge of (x,y) crossed in direction d if the edge is level, else null. */
function edgeLevel(map, x, y, d) {
  const H = map.heightAt(x, y), slope = map.slopeAt(x, y);
  if (slope === 0) return H;
  const [c1, c2] = EDGE_CORNERS[d];
  const r1 = (slope & c1) !== 0, r2 = (slope & c2) !== 0;
  return r1 === r2 ? (r1 ? H : H - 1) : null;
}

/** Levels at which track enters and leaves a tile entered moving `din` and left moving `dout`. */
function tileLevels(map, x, y, din, dout) {
  const H = map.heightAt(x, y), slope = map.slopeAt(x, y);
  if (slope === 0) return { in: H, out: H, kind: 'flat' };
  if (slope & 16) return null;
  if (din === dout) {
    const a = edgeLevel(map, x, y, (din + 2) % 4), b = edgeLevel(map, x, y, din);
    if (a !== null && b !== null && a !== b) return { in: a, out: b, kind: 'incline' };
  }
  return { in: H, out: H, kind: 'foundation' };
}

/**
 * Least-cost buildable path from anchor tile `a` to anchor tile `b`.
 * mode 'rail': track goes on the tiles strictly between the anchors (the anchors are
 *   where it connects: a station end, the tile in front of a depot, existing track).
 * mode 'road': road goes on every tile including both ends.
 * Options: startDir / endDir (index into DIRS) force the first step out of `a` and the
 * last step into `b`; maxBridge = longest bridge in tiles including both ends.
 * Returns { reachable, tiles: [[x,y],...], bridges: [index of the bridge start in tiles], stats }.
 */
export function planPath(map, a, b, { mode = 'rail', costs, margin = 20, startDir, endDir, maxBridge = 12 } = {}) {
  const rail = mode === 'rail';
  const C = { ...(rail ? RAIL_COSTS : ROAD_COSTS), ...costs };
  if (!map.inBounds(a.x, a.y) || !map.inBounds(b.x, b.y)) return { reachable: false, reason: 'an end point is outside the map' };
  if (a.x === b.x && a.y === b.y) return { reachable: false, reason: 'start and end are the same tile' };
  const minX = Math.max(1, Math.min(a.x, b.x) - margin), maxX = Math.min(map.sizeX - 2, Math.max(a.x, b.x) + margin);
  const minY = Math.max(1, Math.min(a.y, b.y) - margin), maxY = Math.min(map.sizeY - 2, Math.max(a.y, b.y) + margin);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const inBox = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  // state = tile, arrival direction (4), last turn (0 none, 1 right, 2 left), low (entered one below H)
  const sid = (x, y, d, turn, low) => ((((y - minY) * w + (x - minX)) * 4 + d) * 3 + turn) * 2 + low;
  const n = w * h * 24;
  const g = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const viaBridge = new Uint8Array(n);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const isGoal = (x, y) => x === b.x && y === b.y;
  const hDist = (x, y) => (Math.abs(x - b.x) + Math.abs(y - b.y)) * (C.base + Math.min(0, C.reuse));

  /** Can track at `level` enter tile (x,y)? Returns the `low` flag or -1. */
  const enter = (x, y, level) => {
    if (!inBox(x, y)) return -1;
    if (isGoal(x, y)) return 0;
    const cls = map.classAt(x, y);
    if (SOLID.has(cls) || cls === 'w' || cls === 'c') return -1;
    if (rail && cls === 'r') return -1;
    const H = map.heightAt(x, y), slope = map.slopeAt(x, y);
    if (slope & 16) return -1;
    if (level === H) return 0;
    return level === H - 1 && slope !== 0 ? 1 : -1;
  };
  const relax = (from, to, cost, bridge, x, y) => {
    if (closed[to] || cost >= g[to]) return;
    g[to] = cost; prev[to] = from; viaBridge[to] = bridge ? 1 : 0;
    heap.push(to, cost + hDist(x, y));
  };

  for (let d = 0; d < 4; d++) {
    if (startDir !== undefined && d !== startDir) continue;
    const x = a.x + DIRS[d][0], y = a.y + DIRS[d][1];
    if (!inBox(x, y)) continue;
    const H = map.heightAt(x, y);
    for (const level of [H, H - 1]) {
      const low = enter(x, y, level);
      if (low >= 0) relax(-1, sid(x, y, d, 0, low), C.base, false, x, y);
    }
  }

  let goal = -1;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    const low = cur % 2, turn = Math.floor(cur / 2) % 3, din = Math.floor(cur / 6) % 4, t = Math.floor(cur / 24);
    const x = (t % w) + minX, y = Math.floor(t / w) + minY;
    if (isGoal(x, y)) {
      if (endDir !== undefined && din !== endDir) continue;
      goal = cur;
      break;
    }
    const cls = map.classAt(x, y), H = map.heightAt(x, y), slope = map.slopeAt(x, y);
    const levelIn = H - low;
    const crossing = rail ? cls === 'd' : cls === 'r';
    for (const dTurn of [0, 1, 3]) {
      const dout = (din + dTurn) % 4;
      const turnId = dTurn === 0 ? 0 : (dTurn === 1 ? 1 : 2);
      if (rail && turnId !== 0 && turnId === turn) continue;      // 90 degree corner
      if (crossing && (turnId !== 0 || slope !== 0)) continue;     // level crossings: straight and flat
      const lv = tileLevels(map, x, y, din, dout);
      if (!lv || lv.in !== levelIn) continue;
      const nx = x + DIRS[dout][0], ny = y + DIRS[dout][1];
      const nLow = enter(nx, ny, lv.out);
      if (nLow < 0) continue;
      let step = C.base + (C[cls] ?? 0);
      if (!rail && cls === 'd') step += C.reuse;
      if (crossing) step += C.crossing;
      if (lv.kind === 'foundation') step += C.foundation;
      if (lv.kind === 'incline') step += C.climb;
      if (turnId !== 0 && (!rail || turn === 0)) step += C.turn;
      relax(cur, sid(nx, ny, dout, rail ? turnId : 0, nLow), g[cur] + step, false, nx, ny);
    }
    // Bridge: this tile is the near head; the far head is the first flat open tile at the same height.
    if (slope !== 0 || low !== 0 || !OPEN.has(cls)) continue;
    const [dx, dy] = DIRS[din];
    const first = inBox(x + dx, y + dy) ? map.classAt(x + dx, y + dy) : 'o';
    if (!(first === 'w' || first === 'c' || first === 'r' || first === 'd')) continue;
    for (let k = 1; k < maxBridge; k++) {
      const mx = x + dx * k, my = y + dy * k;
      if (!inBox(mx, my) || isGoal(mx, my)) break;
      const mc = map.classAt(mx, my), mH = map.heightAt(mx, my);
      if (SOLID.has(mc) || mH > H) break;
      if (k >= 2 && OPEN.has(mc) && mH === H && map.slopeAt(mx, my) === 0) {
        const bx = mx + dx, by = my + dy;
        const bLow = enter(bx, by, H);
        if (bLow >= 0) relax(cur, sid(bx, by, din, 0, bLow), g[cur] + C.bridge_base + C.bridge_per_tile * (k + 1), true, bx, by);
        break;
      }
    }
  }
  if (goal === -1) return { reachable: false, reason: `no buildable ${mode} path inside the search box (margin ${margin}); try a larger margin, other end points, or terraform` };

  // Walk back: tiles in order, with a marker where a bridge starts.
  const rev = [];
  const bridgeEnds = new Set(); // "x,y" of far bridge heads
  for (let s = goal; s !== -1; s = prev[s]) {
    const din = Math.floor(s / 6) % 4, t = Math.floor(s / 24);
    const x = (t % w) + minX, y = Math.floor(t / w) + minY;
    rev.push([x, y]);
    if (viaBridge[s]) {
      const ex = x - DIRS[din][0], ey = y - DIRS[din][1];
      rev.push([ex, ey]);
      bridgeEnds.add(`${ex},${ey}`);
    }
  }
  rev.push([a.x, a.y]);
  const tiles = rev.reverse();
  const bridges = [];
  tiles.forEach(([x, y], i) => { if (bridgeEnds.has(`${x},${y}`)) bridges.push(i - 1); });
  let turns = 0;
  for (let i = 2; i < tiles.length; i++) {
    if (tiles[i][0] - tiles[i - 1][0] !== tiles[i - 1][0] - tiles[i - 2][0] || tiles[i][1] - tiles[i - 1][1] !== tiles[i - 1][1] - tiles[i - 2][1]) turns++;
  }
  const bridgeTiles = bridges.reduce((sum, i) => sum + manhattan({ x: tiles[i][0], y: tiles[i][1] }, { x: tiles[i + 1][0], y: tiles[i + 1][1] }) + 1, 0);
  return { reachable: true, tiles, bridges,
    stats: { tiles: tiles.length, straight_distance: manhattan(a, b), turns, bridges: bridges.length, bridge_tiles: bridgeTiles, plan_cost: +g[goal].toFixed(1) } };
}

const collinear = (p, q, r) => (p[0] === q[0] && q[0] === r[0]) || (p[1] === q[1] && q[1] === r[1]);

/**
 * Exec steps for a rail plan: one `rail` step per straight run or single curve piece
 * (track on tiles[1..n-2]) and one `bridge` step per bridge. bridgeType: -1 cheapest, -2 fastest, or an id.
 */
export function railSteps({ tiles, bridges }, { bridgeType = -1 } = {}) {
  const head = new Set();
  for (const i of bridges) { head.add(i); head.add(i + 1); }
  const steps = [];
  for (let i = 1; i < tiles.length - 1; i++) {
    if (head.has(i)) {
      if (bridges.includes(i)) steps.push(['bridge', 0, ...tiles[i], ...tiles[i + 1], bridgeType]);
      continue;
    }
    let j = i; // extend over a straight run; a curve piece is always its own step
    if (collinear(tiles[i - 1], tiles[i], tiles[i + 1])) {
      while (j + 1 < tiles.length - 1 && !head.has(j + 1) && collinear(tiles[j], tiles[j + 1], tiles[j + 2])) j++;
    }
    steps.push(['rail', ...tiles[i - 1], ...tiles[i], ...tiles[j + 1]]);
    i = j;
  }
  return steps;
}

/** Exec steps for a road plan: straight `road` steps between corners (both ends included) and `bridge` steps. */
export function roadSteps({ tiles, bridges }, { bridgeType = -1 } = {}) {
  const steps = [];
  let from = 0;
  const flush = (to) => { if (to > from) steps.push(['road', ...tiles[from], ...tiles[to]]); from = to; };
  for (let i = 1; i < tiles.length; i++) {
    if (bridges.includes(i - 1)) {
      flush(i - 1);
      steps.push(['bridge', 1, ...tiles[i - 1], ...tiles[i], bridgeType]);
      from = i;
    } else if (i + 1 < tiles.length && !collinear(tiles[i - 1], tiles[i], tiles[i + 1])) {
      flush(i);
    }
  }
  flush(tiles.length - 1);
  return steps;
}

// ---- Templates (flat ground assumed; the dry run reports what does not fit) ----

/** Tile at `along` steps from origin in direction dir and `lane` steps sideways (DIRS[(dir+1)%4] * side). */
const frame = (x, y, dir, side = 1) => (along, lane) => [
  x + DIRS[dir][0] * along + DIRS[(dir + 1) % 4][0] * lane * side,
  y + DIRS[dir][1] * along + DIRS[(dir + 1) % 4][1] * lane * side,
];

export const SIGNAL_TYPES = { block: 0, entry: 1, exit: 2, combo: 3, path: 4, path_oneway: 5 };

/**
 * Terminus: a station of `platforms` x `length` at (x,y) (its lowest-x/y corner), platforms
 * along `axis`, with a ladder of points at one end joining every platform to a single track
 * and a path signal at each platform exit. exitHigh: the throat is at the high-coordinate end.
 * Returns { steps, connect_at: {x, y, dir} }: continue the line with build-rail from there.
 */
export function terminusSteps({ x, y, axis = 'x', platforms = 2, length = 5, exitHigh = true, join = -1 }) {
  const alongY = axis === 'y';
  const dir = (alongY ? 1 : 0) + (exitHigh ? 0 : 2);
  // Lane direction must be +x or +y (platform j sits at origin + j), whichever way the throat faces.
  const lane = alongY ? [1, 0] : [0, 1];
  const end0 = exitHigh ? (alongY ? [x, y + length - 1] : [x + length - 1, y]) : [x, y];
  const P = (a, l) => [end0[0] + DIRS[dir][0] * a + lane[0] * l, end0[1] + DIRS[dir][1] * a + lane[1] * l];
  const steps = [['rail_station', x, y, alongY, platforms, length, join]];
  const signals = [];
  for (let j = 0; j < platforms; j++) {
    const tiles = [P(0, j), P(1, j), P(2, j)];
    if (j === 0) for (let a = 3; a <= platforms + 2; a++) tiles.push(P(a, 0));
    for (let k = 1; k <= j; k++) tiles.push(P(1 + k, j - k), P(2 + k, j - k));
    steps.push(...railSteps({ tiles, bridges: [] }));
    signals.push(['signal', ...P(1, j), ...P(0, j), SIGNAL_TYPES.path]);
  }
  const [cx, cy] = P(platforms + 1, 0);
  return { steps: [...steps, ...signals], connect_at: { x: cx, y: cy, dir: DIR_NAMES[dir] } };
}

/**
 * Passing loop on a single line, `length` >= 2, in frame P(along, lane) from (x,y) in direction dir:
 * main track on P(-1..length+2, 0); points on P(0, 0) and P(length+1, 0); the loop track on
 * P(0..length+1, 1) (curves at both ends). Trains heading `dir` use the main track, trains heading
 * the other way the loop: one-way path signals on P(length, 0) (facing trains from P(length-1, 0))
 * and P(2, 1) (facing trains from P(3, 1)). Each side then has `length - 1` clear tiles between the
 * points a train comes in by and its exit signal, so a train of up to length - 2 tiles waits there
 * with a tile to spare, clear of both points. Track that already exists is kept.
 * Returns { steps, ends, clear_tiles, main: [[x,y]...], lane: [[x,y]...], signals: [[x,y,fx,fy]...], axis_bit }.
 */
export function passingLoopSteps({ x, y, dir = 0, length = 6, side = 1 }) {
  if (length < 2) throw new Error('passing loop length must be at least 2');
  const P = frame(x, y, dir, side);
  const main = [];
  for (let a = -1; a <= length + 2; a++) main.push(P(a, 0));
  const loop = [P(-1, 0), P(0, 0)];
  for (let a = 0; a <= length + 1; a++) loop.push(P(a, 1));
  loop.push(P(length + 1, 0), P(length + 2, 0));
  const signals = [[...P(length, 0), ...P(length - 1, 0)], [...P(2, 1), ...P(3, 1)]];
  const lane = [];
  for (let a = 0; a <= length + 1; a++) lane.push(P(a, 1));
  return {
    steps: [...railSteps({ tiles: main, bridges: [] }), ...railSteps({ tiles: loop, bridges: [] }),
      ...signals.map((g) => ['signal', ...g, SIGNAL_TYPES.path_oneway])],
    loopSteps: railSteps({ tiles: loop, bridges: [] }),
    ends: [{ x: P(0, 0)[0], y: P(0, 0)[1] }, { x: P(length + 1, 0)[0], y: P(length + 1, 0)[1] }],
    clear_tiles: length - 1, main, lane, signals,
    // GSRail track bit of a straight piece along dir: RAILTRACK_NE_SW (1) along x, RAILTRACK_NW_SE (2) along y.
    axis_bit: dir % 2 === 0 ? 1 : 2,
  };
}

/** Steps that take a passingLoopSteps() loop out again: both signals, then the loop track and its points. The main track stays. */
export function passingLoopRemoveSteps(loop) {
  return [...loop.signals.map((g) => ['signal_remove', ...g]), ...loop.loopSteps.slice().reverse().map((st) => ['rail_remove', ...st.slice(1)])];
}

const LOOP_OK_CLASSES = new Set(['b', 't', 'f', 'k', 'h']); // buildable after auto-clearing

/**
 * First reason a passing loop cannot go here, or null. Main tiles must be straight plain track
 * along the loop's axis (no points, crossings, stations or signals), or free land when the line is
 * not built yet; loop tiles must be free land. railAt(x, y) -> rail_tiles tile or null; classAt from
 * the map mirror. Returns { code, x, y, detail }.
 */
export function loopSiteProblem(loop, railAt, classAt) {
  for (const [tx, ty] of loop.main) {
    const t = railAt(tx, ty);
    if (t) {
      if (t.kind !== 't' || t.tracks !== loop.axis_bit) {
        return { code: 'not_straight_at', x: tx, y: ty, detail: t.kind === 't' ? `track bits ${t.tracks} (points, a curve or crossing track), not one straight piece along the loop` : `a ${{ s: 'station', d: 'depot', w: 'waypoint', x: 'level crossing', b: 'bridge head', u: 'tunnel portal' }[t.kind] ?? t.kind} tile` };
      }
      if (t.signals) return { code: 'signal_at', x: tx, y: ty, detail: 'the main line already has a signal under the loop; remove it or move the loop' };
      continue;
    }
    const c = classAt(tx, ty);
    if (c === 'r') return { code: 'not_straight_at', x: tx, y: ty, detail: 'rail of another shape here' };
    if (!LOOP_OK_CLASSES.has(c)) return { code: 'blocked_at', x: tx, y: ty, detail: `map class '${c}' (not free land or straight track)` };
  }
  for (const [tx, ty] of loop.lane) {
    if (railAt(tx, ty) || classAt(tx, ty) === 'r') return { code: 'loop_side_occupied_at', x: tx, y: ty, detail: 'track already there; pick the other --side or another place' };
  }
  return null;
}

// ---- terminus site search -------------------------------------------------------------------

const SITE_OK_CLASSES = new Set(['b', 't', 'f', 'h']); // clear, trees, farm, rough: buildable without demolishing

/**
 * Footprint of terminusSteps(): the station rectangle plus `platforms + 2` tiles of points beyond
 * the exit end, `platforms` wide. Returns { tiles: [[x,y]...], station: {x0,y0,x1,y1} }.
 */
export function terminusFootprint({ x, y, axis = 'x', platforms = 2, length = 4, exitHigh = true }) {
  const alongY = axis === 'y';
  const w = alongY ? platforms : length;
  const h = alongY ? length : platforms;
  const station = { x0: x, y0: y, x1: x + w - 1, y1: y + h - 1 };
  const tiles = [];
  for (let ty = station.y0; ty <= station.y1; ty++) for (let tx = station.x0; tx <= station.x1; tx++) tiles.push([tx, ty]);
  const throat = platforms + 2;
  for (let a = 1; a <= throat; a++) {
    for (let l = 0; l < platforms; l++) {
      if (alongY) tiles.push([x + l, exitHigh ? station.y1 + a : station.y0 - a]);
      else tiles.push([exitHigh ? station.x1 + a : station.x0 - a, y + l]);
    }
  }
  return { tiles, station };
}

/**
 * Candidate terminus placements near target tiles, best first, using only the map mirror:
 * every footprint tile buildable (clear/trees/farm/rough), flat and at one height; the station
 * within `catchment` tiles (Chebyshev) of some target tile. Ranked by distance from connect_at to
 * `toward` (the other end of the planned line) when given, else by closeness to the target.
 */
export function terminusCandidates(map, { targets, radius = 8, catchment = 3, platforms = 2, length = 4, toward = null, max = 40 }) {
  const out = [];
  const xs = targets.map((t) => t[0]); const ys = targets.map((t) => t[1]);
  const bx0 = Math.max(0, Math.min(...xs) - radius); const bx1 = Math.min(map.sizeX - 1, Math.max(...xs) + radius);
  const by0 = Math.max(0, Math.min(...ys) - radius); const by1 = Math.min(map.sizeY - 1, Math.max(...ys) + radius);
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    for (const axis of ['x', 'y']) for (const exitHigh of [true, false]) {
      const { tiles, station } = terminusFootprint({ x, y, axis, platforms, length, exitHigh });
      if (!tiles.every(([tx, ty]) => tx >= 1 && ty >= 1 && tx < map.sizeX - 1 && ty < map.sizeY - 1)) continue;
      const h0 = map.heightAt(tiles[0][0], tiles[0][1]);
      if (!tiles.every(([tx, ty]) => SITE_OK_CLASSES.has(map.classAt(tx, ty)) && map.slopeAt(tx, ty) === 0 && map.heightAt(tx, ty) === h0)) continue;
      let gap = Infinity;
      for (const [tx, ty] of targets) {
        const dx = Math.max(station.x0 - tx, 0, tx - station.x1); const dy = Math.max(station.y0 - ty, 0, ty - station.y1);
        gap = Math.min(gap, Math.max(dx, dy));
      }
      if (gap > catchment) continue;
      const { connect_at } = terminusSteps({ x, y, axis, platforms, length, exitHigh });
      const score = toward ? Math.abs(connect_at.x - toward[0]) + Math.abs(connect_at.y - toward[1]) : gap;
      const trees = tiles.filter(([tx, ty]) => map.classAt(tx, ty) === 't').length;
      out.push({ x, y, axis, exit: exitHigh ? 'high' : 'low', platforms, length, connect_at, gap, trees, score: score + trees * 0.1 });
    }
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, max);
}

/**
 * Depot spots beside a straight piece of existing rail near `near` [x,y], best first, using only
 * the map mirror. A line tile R is straight when both neighbours along one axis are rail and
 * neither neighbour across it is rail or station. The depot goes on a buildable flat tile across
 * from R at R's height, facing R. Tiles within 2 of a station tile are skipped (points live there).
 * `onLine` (Set of "x,y"): only rail tiles of that line, and only where both neighbours along it are
 * on it too. Without it any company's rail qualifies, so a depot may end up on another line.
 * Returns [{ depot:[x,y], front:[x,y], ends:[[x,y],[x,y]], dist }]; steps: depotSteps().
 */
export function depotCandidates(map, near, { radius = 12, max = 20, onLine = null } = {}) {
  const out = [];
  const inMap = (x, y) => x >= 1 && y >= 1 && x < map.sizeX - 1 && y < map.sizeY - 1;
  const isRail = (x, y) => inMap(x, y) && map.classAt(x, y) === 'r';
  const isTrack = (x, y) => inMap(x, y) && (map.classAt(x, y) === 'r' || map.classAt(x, y) === 's');
  const nearStation = (x, y) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (inMap(x + dx, y + dy) && map.classAt(x + dx, y + dy) === 's') return true;
    return false;
  };
  const [nx, ny] = near;
  for (let y = Math.max(1, ny - radius); y <= Math.min(map.sizeY - 2, ny + radius); y++) {
    for (let x = Math.max(1, nx - radius); x <= Math.min(map.sizeX - 2, nx + radius); x++) {
      if (!isRail(x, y) || nearStation(x, y) || map.slopeAt(x, y) !== 0) continue;
      if (onLine && !onLine.has(`${x},${y}`)) continue;
      for (const [ax, ay] of [[1, 0], [0, 1]]) {
        const [cx, cy] = [ay, ax]; // across the line
        if (!isTrack(x - ax, y - ay) || !isTrack(x + ax, y + ay)) continue;
        if (isTrack(x - cx, y - cy) || isTrack(x + cx, y + cy)) continue;
        if (onLine && (!onLine.has(`${x - ax},${y - ay}`) || !onLine.has(`${x + ax},${y + ay}`))) continue;
        for (const side of [-1, 1]) {
          const dx = x + side * cx; const dy = y + side * cy;
          if (!inMap(dx, dy) || !SITE_OK_CLASSES.has(map.classAt(dx, dy)) || map.slopeAt(dx, dy) !== 0 || map.heightAt(dx, dy) !== map.heightAt(x, y)) continue;
          const dist = Math.abs(x - nx) + Math.abs(y - ny) + (map.classAt(dx, dy) === 't' ? 0.5 : 0);
          out.push({ depot: [dx, dy], front: [x, y], ends: [[x - ax, y - ay], [x + ax, y + ay]], dist });
        }
      }
    }
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, max);
}

/** Steps for one depotCandidates() entry: the depot, then two track pieces joining it both ways along the line. */
export function depotSteps({ depot, front, ends }) {
  return [
    ['rail_depot', depot[0], depot[1], front[0], front[1]],
    ['rail', depot[0], depot[1], front[0], front[1], ends[0][0], ends[0][1]],
    ['rail', depot[0], depot[1], front[0], front[1], ends[1][0], ends[1][1]],
  ];
}
