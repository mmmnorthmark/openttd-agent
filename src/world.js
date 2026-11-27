// In-memory mirror of the map plus analytic queries. Pure functions over plain
// data so they can be unit-tested without a game.
//
// Tile encoding from GS dump_tiles: per tile 4 chars = 2 hex height, 1 base32
// slope, 1 class char (see gamescript main.nut CmdDumpTiles).

export const TILE_CLASS = {
  w: 'water', c: 'coast', i: 'industry', s: 'station', r: 'rail', d: 'road', t: 'trees',
  f: 'farm', k: 'rocks', h: 'rough', b: 'clear', o: 'other',
};
const CLASS_CODES = Object.keys(TILE_CLASS);
const CLASS_INDEX = Object.fromEntries(CLASS_CODES.map((c, i) => [c, i]));
const B32 = '0123456789abcdefghijklmnopqrstuv';

export class TileMap {
  constructor(sizeX, sizeY) {
    this.sizeX = sizeX;
    this.sizeY = sizeY;
    this.height = new Uint8Array(sizeX * sizeY);
    this.slope = new Uint8Array(sizeX * sizeY);
    this.cls = new Uint8Array(sizeX * sizeY).fill(CLASS_INDEX.o);
    this.rowsLoaded = new Uint8Array(sizeY);
    this.loadedAt = new Float64Array(sizeY); // ms timestamp per row
  }

  idx(x, y) { return y * this.sizeX + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.sizeX && y < this.sizeY; }
  classAt(x, y) { return CLASS_CODES[this.cls[this.idx(x, y)]]; }
  heightAt(x, y) { return this.height[this.idx(x, y)]; }
  slopeAt(x, y) { return this.slope[this.idx(x, y)]; }
  isComplete() { return this.rowsLoaded.every((v) => v === 1); }

  /** Apply one dump_tiles row string "y,x0,<payload>". */
  applyRow(rowStr, now = Date.now()) {
    const c1 = rowStr.indexOf(',');
    const c2 = rowStr.indexOf(',', c1 + 1);
    const y = Number(rowStr.slice(0, c1));
    const x0 = Number(rowStr.slice(c1 + 1, c2));
    const payload = rowStr.slice(c2 + 1);
    for (let k = 0; k * 4 < payload.length; k++) {
      const x = x0 + k;
      if (!this.inBounds(x, y)) continue;
      const p = k * 4;
      const i = this.idx(x, y);
      this.height[i] = parseInt(payload.slice(p, p + 2), 16);
      this.slope[i] = B32.indexOf(payload[p + 2]);
      this.cls[i] = CLASS_INDEX[payload[p + 3]] ?? CLASS_INDEX.o;
    }
    if (x0 === 0 || payload.length / 4 + x0 >= this.sizeX) {
      this.rowsLoaded[y] = 1;
      this.loadedAt[y] = now;
    }
  }
}

export const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

// ---- Route effort -----------------------------------------------------------

/**
 * Per-step cost model for a future rail/road line. Tunable; returned in results
 * so agents can explain rankings.
 */
export const DEFAULT_COSTS = {
  base: 1,
  climb_per_level: 6,      // each height level changed between neighbours
  water: 10,               // needs a bridge
  coast: 4,
  other: 40,               // houses, objects: demolition / town anger
  industry: 1000,          // effectively impassable
  station: 1000,
  rail: 6,                 // crossing someone's rail
  road: 3,
  trees: 0.3,
  farm: 0.5,
  rocks: 0.6,
  rough: 0.4,
  clear: 0,
};

/**
 * A* over the tile grid between two points, 4-connected.
 * Returns { path_len, effort, effort_per_tile, detour, obstacles: {...}, max_height_delta }.
 * `margin` limits the search box around the two points to keep it fast.
 */
export function routeEffort(map, a, b, { costs = DEFAULT_COSTS, margin = 24, ignoreEndpoints = true } = {}) {
  const minX = Math.max(0, Math.min(a.x, b.x) - margin), maxX = Math.min(map.sizeX - 1, Math.max(a.x, b.x) + margin);
  const minY = Math.max(0, Math.min(a.y, b.y) - margin), maxY = Math.min(map.sizeY - 1, Math.max(a.y, b.y) + margin);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const local = (x, y) => (y - minY) * w + (x - minX);
  const g = new Float64Array(w * h).fill(Infinity);
  const prev = new Int32Array(w * h).fill(-1);
  const closed = new Uint8Array(w * h);
  const heap = new MinHeap();
  const start = local(a.x, a.y), goal = local(b.x, b.y);
  g[start] = 0;
  heap.push(start, manhattan(a, b));
  const stepCost = (fx, fy, tx, ty) => {
    const endpoint = ignoreEndpoints && ((tx === b.x && ty === b.y));
    const cls = TILE_CLASS[map.classAt(tx, ty)];
    let c = costs.base + (endpoint ? 0 : (costs[cls] ?? 0));
    c += costs.climb_per_level * Math.abs(map.heightAt(tx, ty) - map.heightAt(fx, fy));
    return c;
  };
  while (heap.size) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = (cur % w) + minX, cy = Math.floor(cur / w) + minY;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      const n = local(nx, ny);
      if (closed[n]) continue;
      const ng = g[cur] + stepCost(cx, cy, nx, ny);
      if (ng < g[n]) {
        g[n] = ng;
        prev[n] = cur;
        heap.push(n, ng + Math.abs(nx - b.x) + Math.abs(ny - b.y));
      }
    }
  }
  if (!Number.isFinite(g[goal])) return { reachable: false };
  const obstacles = {};
  let len = 0, maxDelta = 0, lo = 255, hi = 0;
  for (let n = goal; n !== -1; n = prev[n]) {
    const x = (n % w) + minX, y = Math.floor(n / w) + minY;
    const cls = TILE_CLASS[map.classAt(x, y)];
    if (!['clear', 'trees', 'farm', 'rough', 'rocks'].includes(cls)) obstacles[cls] = (obstacles[cls] ?? 0) + 1;
    const ht = map.heightAt(x, y);
    lo = Math.min(lo, ht); hi = Math.max(hi, ht);
    const p = prev[n];
    if (p !== -1) {
      const px = (p % w) + minX, py = Math.floor(p / w) + minY;
      maxDelta = Math.max(maxDelta, Math.abs(ht - map.heightAt(px, py)));
      len++;
    }
  }
  const straight = manhattan(a, b);
  return {
    reachable: true,
    straight_tiles: straight,
    path_tiles: len,
    detour: +(len / Math.max(1, straight)).toFixed(2),
    effort: +g[goal].toFixed(1),
    effort_per_tile: +(g[goal] / Math.max(1, len)).toFixed(2),
    height_range: hi - lo,
    max_step_delta: maxDelta,
    obstacles,
  };
}

export class MinHeap {
  constructor() { this.items = []; this.prios = []; }
  get size() { return this.items.length; }
  push(item, prio) {
    const it = this.items, pr = this.prios;
    it.push(item); pr.push(prio);
    let i = it.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (pr[p] <= pr[i]) break;
      [it[p], it[i]] = [it[i], it[p]]; [pr[p], pr[i]] = [pr[i], pr[p]];
      i = p;
    }
  }
  pop() {
    const it = this.items, pr = this.prios;
    const top = it[0];
    const lastI = it.pop(), lastP = pr.pop();
    if (it.length) {
      it[0] = lastI; pr[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < it.length && pr[l] < pr[m]) m = l;
        if (r < it.length && pr[r] < pr[m]) m = r;
        if (m === i) break;
        [it[m], it[i]] = [it[i], it[m]]; [pr[m], pr[i]] = [pr[i], pr[m]];
        i = m;
      }
    }
    return top;
  }
}

// ---- Economy views ----------------------------------------------------------

/** Normalise GS `towns` rows into objects. */
export function townsFromRows(rows) {
  return rows.map(([id, name, x, y, population, is_city, pax, pax_pct, mail, mail_pct, allowed_noise]) => ({
    id, name, x, y, population, is_city, pax_produced: pax, pax_transported_pct: pax_pct,
    pax_unserved: Math.round(pax * (100 - pax_pct) / 100), mail_produced: mail, mail_transported_pct: mail_pct, allowed_noise,
  }));
}

/** A producer that makes its cargo from deliveries (sawmill, factory, refinery...): output is 0 until it is supplied. */
const isSecondary = (type) => !!type && (type.processing === true || (type.raw === false && (type.accepts?.length ?? 0) > 0));

/** Normalise GS `industries` rows, resolving type and cargo names. Secondary (processing) industries get secondary: true. */
export function industriesFromRows(rows, typesById, cargosById) {
  return rows.map(([id, type, x, y, prod, stations_around]) => {
    const t = typesById.get(type);
    return {
      id, type, type_name: t?.name ?? `type ${type}`, x, y, stations_around, ...(isSecondary(t) ? { secondary: true } : {}),
      produces: prod.map(([cargo, amount, pct]) => ({
        cargo, cargo_name: cargosById.get(cargo)?.name ?? `cargo ${cargo}`, last_month: amount, transported_pct: pct,
        unserved: Math.round(amount * (100 - pct) / 100),
      })),
      accepts: (t?.accepts ?? []).map((c) => cargosById.get(c)?.name ?? `cargo ${c}`),
    };
  });
}

// Case, '_', '-' and spaces do not matter: iron_ore, Iron Ore and iron-ore all match "Iron Ore".
const norm = (v) => String(v).toLowerCase().replace(/[\s_-]+/g, ' ').trim();
const matches = (needle, hay) => !needle || norm(hay).includes(norm(needle));

/** Acceptance at or above this means a station there accepts the cargo (GSTile.GetCargoAcceptance). */
export const ACCEPTED = 8;

/**
 * Decode GS `acceptance` rows [point_index, cargo, value] into one list per point:
 * [{ cargo, label, name, acceptance, accepted }], highest acceptance first.
 */
export function acceptanceFromRows(rows, cargosById, nPoints) {
  const out = Array.from({ length: nPoints }, () => []);
  for (const [i, cargo, value] of rows) {
    const c = cargosById.get(cargo);
    out[i]?.push({ cargo, label: c?.label ?? null, name: c?.name ?? `cargo ${cargo}`, acceptance: value, accepted: value >= ACCEPTED });
  }
  for (const list of out) list.sort((a, b) => b.acceptance - a.acceptance);
  return out;
}

/**
 * Source industries producing `cargo` (name substring) with transported% <= maxTransportedPct,
 * paired with destinations `minDist..maxDist` tiles away (Manhattan): industries whose type accepts
 * the cargo, and towns. `townAcceptance` maps town id -> { cargo id: acceptance around the centre };
 * towns below ACCEPTED are left out. Without it (null, an older GameScript) towns are listed unchecked
 * (acceptance null) for cargos in `townCargoFallback` (ids of cargos with a town effect) only.
 * destKind 'industry' | 'town' | 'any'. Secondary (processing) sources are marked `secondary: true`:
 * their last_month is 0 between deliveries, so minProduction does not drop them.
 * Towns are sources too, for cargos that `cargos` (id -> { name, passengers, mail }) marks as passenger or
 * mail: see townToTownPairs. Optionally ranks each pair by routeEffort on `map`.
 */
export function findCargoPairs({ industries, types, towns = [], cargos = new Map(), townAcceptance = null, townCargoFallback = new Set(), map, cargo, sourceType, destType, destKind = 'any',
  minDist = 0, maxDist = 1e9, maxTransportedPct = 100, minProduction = 0, limit = 10, withEffort = true, near = null }) {
  const pairs = [];
  for (const src of industries) {
    if (!matches(sourceType, src.type_name)) continue;
    const secondary = isSecondary(types.get(src.type));
    for (const p of src.produces) {
      if (!matches(cargo, p.cargo_name)) continue;
      if (p.transported_pct > maxTransportedPct || (!secondary && p.last_month < minProduction)) continue;
      const base = { cargo: p.cargo_name, source_last_month: p.last_month, source_transported_pct: p.transported_pct };
      const srcBrief = { ...brief(src), ...(secondary ? { secondary: true } : {}) };
      if (destKind !== 'town') {
        for (const dst of industries) {
          if (dst.id === src.id) continue;
          const dt = types.get(dst.type);
          if (!dt?.accepts.includes(p.cargo)) continue;
          if (!matches(destType, dst.type_name)) continue;
          const dist = manhattan(src, dst);
          if (dist < minDist || dist > maxDist) continue;
          pairs.push({ source: srcBrief, dest: { kind: 'industry', ...brief(dst) }, ...base, distance: dist });
        }
      }
      if (destKind !== 'industry' && (townAcceptance || townCargoFallback.has(p.cargo))) {
        for (const town of towns) {
          if (destType && !matches(destType, 'town') && !matches(destType, town.name)) continue;
          const acc = townAcceptance ? (townAcceptance.get(town.id)?.[p.cargo] ?? 0) : null;
          if (acc !== null && acc < ACCEPTED) continue;
          const dist = manhattan(src, town);
          if (dist < minDist || dist > maxDist) continue;
          pairs.push({ source: srcBrief, dest: { kind: 'town', id: town.id, name: town.name, x: town.x, y: town.y, population: town.population, acceptance: acc },
            ...base, distance: dist });
        }
      }
    }
  }
  if (destKind !== 'industry') pairs.push(...townToTownPairs({ towns, cargos, townAcceptance, townCargoFallback, cargo, sourceType, destType, minDist, maxDist, maxTransportedPct, minProduction }));
  // near = { x, y, radius }: keep pairs whose source is within radius of that tile.
  if (near) {
    for (let i = pairs.length - 1; i >= 0; i--) if (manhattan(pairs[i].source, near) > near.radius) pairs.splice(i, 1);
  }
  // Pre-rank by unserved volume * distance (revenue proxy) before the costlier effort pass.
  pairs.sort((x, y) => y.source_last_month * (100 - y.source_transported_pct) * y.distance
    - x.source_last_month * (100 - x.source_transported_pct) * x.distance);
  const shortlist = pairs.slice(0, Math.max(limit * 3, limit));
  if (withEffort && map?.isComplete()) {
    for (const pr of shortlist) pr.route = routeEffort(map, pr.source, pr.dest);
    shortlist.sort((x, y) => (x.route.reachable ? x.route.effort_per_tile : 1e9) - (y.route.reachable ? y.route.effort_per_tile : 1e9));
  }
  const notes = [];
  if (shortlist.some((pr) => pr.source.secondary && pr.source_last_month === 0)) {
    notes.push('secondary sources (secondary: true) produce only while supplied, so last_month 0 is normal before their input arrives');
  }
  if (townAcceptance === null && pairs.some((pr) => pr.dest.kind === 'town')) {
    notes.push('town acceptance was not checked (the running AgentBridge is older than v7): verify with `acceptance --x --y` before building');
  }
  return { total_candidates: pairs.length, map_complete: !!map?.isComplete(), pairs: shortlist.slice(0, limit), ...(notes.length ? { notes } : {}) };
}

const brief = (ind) => ({ id: ind.id, type: ind.type_name, x: ind.x, y: ind.y });
const townBrief = (town) => ({ kind: 'town', id: town.id, name: town.name, x: town.x, y: town.y, population: town.population });

/**
 * Town -> town pairs for passenger and mail cargos (a `cargos` entry with passengers or mail true).
 * Source production is the town's last-month passenger or mail production (GS `towns`); the dest is
 * another town whose centre accepts the cargo (same acceptance rule as industry -> town pairs).
 * sourceType / destType, when given, must match 'town' or the town name.
 */
function townToTownPairs({ towns, cargos, townAcceptance, townCargoFallback, cargo, sourceType, destType, minDist, maxDist, maxTransportedPct, minProduction }) {
  const pairs = [];
  for (const c of cargos.values()) {
    if (!(c.passengers || c.mail) || !matches(cargo, c.name)) continue;
    if (!townAcceptance && !townCargoFallback.has(c.id)) continue;
    for (const src of towns) {
      if (sourceType && !matches(sourceType, 'town') && !matches(sourceType, src.name)) continue;
      const produced = c.passengers ? src.pax_produced : src.mail_produced;
      const pct = c.passengers ? src.pax_transported_pct : src.mail_transported_pct;
      if (produced === undefined || pct > maxTransportedPct || produced < minProduction) continue;
      const base = { cargo: c.name, source_last_month: produced, source_transported_pct: pct };
      for (const dst of towns) {
        if (dst.id === src.id) continue;
        if (destType && !matches(destType, 'town') && !matches(destType, dst.name)) continue;
        const acc = townAcceptance ? (townAcceptance.get(dst.id)?.[c.id] ?? 0) : null;
        if (acc !== null && acc < ACCEPTED) continue;
        const dist = manhattan(src, dst);
        if (dist < minDist || dist > maxDist) continue;
        pairs.push({ source: townBrief(src), dest: { ...townBrief(dst), acceptance: acc }, ...base, distance: dist });
      }
    }
  }
  return pairs;
}

/** Towns ranked by passengers not yet transported. */
export function townGaps(towns, { minPopulation = 0, maxTransportedPct = 100, limit = 15 } = {}) {
  return towns
    .filter((t) => t.population >= minPopulation && t.pax_transported_pct <= maxTransportedPct)
    .sort((a, b) => b.pax_unserved - a.pax_unserved)
    .slice(0, limit);
}

/**
 * Flat, buildable w x h rectangles within `radius` of (cx, cy), nearest first.
 * "Flat" = every tile slope 0 and the same height; allow `maxHeightSpread` to
 * accept sites that need a little terraforming.
 */
// owned: optional Set of "x,y" (the company's owned land): those tiles count as buildable, each site
// gets owned (whole footprint owned), and owned sites sort first.
export function findFlatSites(map, { cx, cy, width, height, radius = 20, maxHeightSpread = 0, limit = 5, buildable = ['b', 't', 'f', 'h', 'k'], owned = null }) {
  const ok = new Set(buildable);
  const sites = [];
  for (let y = Math.max(0, cy - radius); y <= Math.min(map.sizeY - height, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(map.sizeX - width, cx + radius); x++) {
      let lo = 255, hi = 0, good = true, slopes = 0, ownedTiles = 0;
      for (let dy = 0; dy < height && good; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const tx = x + dx, ty = y + dy;
          const mine = owned?.has(`${tx},${ty}`) ?? false;
          if (mine) ownedTiles++;
          if (!mine && !ok.has(map.classAt(tx, ty))) { good = false; break; }
          const ht = map.heightAt(tx, ty);
          lo = Math.min(lo, ht); hi = Math.max(hi, ht);
          if (map.slopeAt(tx, ty) !== 0) slopes++;
        }
      }
      if (!good || hi - lo > maxHeightSpread || (maxHeightSpread === 0 && slopes > 0)) continue;
      sites.push({ x, y, width, height, distance: Math.abs(x + width / 2 - cx) + Math.abs(y + height / 2 - cy), height_spread: hi - lo, sloped_tiles: slopes,
        ...(owned ? { owned: ownedTiles === width * height } : {}) });
    }
  }
  sites.sort((a, b) => (b.owned === true) - (a.owned === true) || a.distance - b.distance);
  // Drop heavily overlapping candidates so results are distinct places.
  const picked = [];
  for (const s of sites) {
    if (picked.every((p) => Math.abs(p.x - s.x) >= width || Math.abs(p.y - s.y) >= height)) picked.push(s);
    if (picked.length >= limit) break;
  }
  return picked;
}
