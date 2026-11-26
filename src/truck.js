// build-truck-route helpers: truck stop and depot sites, truck choice. Pure functions over the map
// mirror (TileMap or an overlayMap view) and decoded engine rows; the command dry-runs every pick.

import { DIRS } from './planner.js';

const FREE = new Set(['b', 't', 'f', 'h']); // clear, trees, farm, rough: buildable without demolishing
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const manh = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * Bay truck stops near an industry: free tiles within `catchment` (Chebyshev) of a target tile, each
 * with a free or road front tile. The front points toward `toward` when it can. Sorted by the front's
 * distance to `toward`. Returns [{ x, y, front_x, front_y, drive_through: false }].
 */
export function truckStopCandidates(map, { targets, catchment = 3, toward = null, max = 30 }) {
  const seen = new Set();
  const out = [];
  for (const [tx, ty] of targets) {
    for (let y = ty - catchment; y <= ty + catchment; y++) {
      for (let x = tx - catchment; x <= tx + catchment; x++) {
        const k = `${x},${y}`;
        if (seen.has(k) || !map.inBounds(x, y) || !FREE.has(map.classAt(x, y))) continue;
        seen.add(k);
        for (const [dx, dy] of DIRS) {
          const fx = x + dx, fy = y + dy;
          if (!map.inBounds(fx, fy)) continue;
          const c = map.classAt(fx, fy);
          if (!FREE.has(c) && c !== 'd') continue;
          out.push({ x, y, front_x: fx, front_y: fy, drive_through: false });
        }
      }
    }
  }
  const ref = toward ? { x: toward[0], y: toward[1] } : null;
  const score = (c) => (ref ? manh({ x: c.front_x, y: c.front_y }, ref) - manh(c, ref) * 0.5 : 0);
  return out.sort((p, q) => score(p) - score(q)).slice(0, max);
}

/**
 * Drive-through stops on straight town roads near a town centre: road tiles whose two neighbours
 * along one axis are road and the two across it are not. Sorted by distance to the centre.
 * Returns [{ x, y, front_x, front_y, drive_through: true, axis }].
 */
export function townStopCandidates(map, { cx, cy, radius = 4, max = 20 }) {
  const out = [];
  const road = (x, y) => map.inBounds(x, y) && map.classAt(x, y) === 'd';
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (!road(x, y)) continue;
      if (road(x + 1, y) && road(x - 1, y) && !road(x, y + 1) && !road(x, y - 1)) out.push({ x, y, front_x: x + 1, front_y: y, drive_through: true, axis: 'x' });
      if (road(x, y + 1) && road(x, y - 1) && !road(x + 1, y) && !road(x - 1, y)) out.push({ x, y, front_x: x, front_y: y + 1, drive_through: true, axis: 'y' });
    }
  }
  return out.sort((p, q) => cheb(p, { x: cx, y: cy }) - cheb(q, { x: cx, y: cy })).slice(0, max);
}

/** Where the road from a stop starts: a bay stop's front tile; for a drive-through stop the stop tile itself. */
export const stopConnect = (site) => (site.drive_through ? { x: site.x, y: site.y } : { x: site.front_x, y: site.front_y });

/**
 * Depot spots beside a planned road path (tiles [[x, y]...]): free tiles next to a path tile
 * (not on the path), nearest `near` first. Returns [{ x, y, front_x, front_y }].
 */
export function roadDepotCandidates(map, pathTiles, near, { skip = new Set(), max = 12 } = {}) {
  const onPath = new Set(pathTiles.map(([x, y]) => `${x},${y}`));
  const out = [];
  const seen = new Set();
  for (const [px, py] of pathTiles) {
    for (const [dx, dy] of DIRS) {
      const x = px + dx, y = py + dy;
      const k = `${x},${y}`;
      if (seen.has(k) || onPath.has(k) || skip.has(k) || !map.inBounds(x, y) || !FREE.has(map.classAt(x, y))) continue;
      seen.add(k);
      out.push({ x, y, front_x: px, front_y: py });
    }
  }
  return out.sort((p, q) => manh(p, near) - manh(q, near)).slice(0, max);
}

/**
 * Truck for a cargo from road `engines` rows (enginesFromRows, filtered by the game to vehicles that
 * can carry it, maybe after a refit): carries it without refit first, then the most capacity per
 * running cost, then price. engine forces a choice. Throws when there is none.
 */
export function pickTruck(engines, { cargoId, engine } = {}) {
  if (engine !== undefined) {
    const hit = engines.find((e) => e.id === engine);
    if (!hit) throw new Error(`road vehicle ${engine} cannot carry this cargo; choose from: ${engines.map((e) => `${e.id} ${e.name}`).join(', ') || 'none'}`);
    return hit;
  }
  const best = [...engines].sort((a, b) => (b.cargo === cargoId) - (a.cargo === cargoId) || (b.capacity / Math.max(1, b.running_cost)) - (a.capacity / Math.max(1, a.running_cost)) || a.price - b.price)[0];
  if (!best) throw new Error('no buildable road vehicle carries this cargo (see engines --type road --cargo <name>)');
  return best;
}
