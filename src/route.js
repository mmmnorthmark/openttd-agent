// Pure parts of build-cargo-route: what the planned stations and line occupy (for planning on a
// map that does not have them yet), train choice, orders. No game access; unit-tested.

import { terminusFootprint } from './planner.js';
import { encodeOrderFlags } from './operate.js';

/**
 * Map view with some tiles reclassified (e.g. a planned station as 's', planned track as 'r'),
 * so planPath and depotCandidates treat them as built. `cells`: Map "x,y" -> class char.
 * Every other read goes to the underlying map.
 */
export function overlayMap(map, cells) {
  const view = Object.create(map);
  view.classAt = (x, y) => cells.get(`${x},${y}`) ?? map.classAt(x, y);
  return view;
}

/**
 * Cells a terminusSteps() build occupies: station tiles 's', points/throat tiles 'r'. The outermost
 * throat row (platforms+2 beyond the platforms) stays free: build-rail leaves connect_at through it.
 */
export function terminusCells(site, cells = new Map()) {
  const { x, y, axis, platforms, length } = site;
  const exitHigh = site.exit === 'high' || site.exitHigh === true;
  const { tiles, station } = terminusFootprint({ x, y, axis, platforms, length, exitHigh });
  const along = axis === 'y' ? 1 : 0;
  const outer = exitHigh ? (along ? station.y1 : station.x1) + platforms + 2 : (along ? station.y0 : station.x0) - platforms - 2;
  for (const [tx, ty] of tiles) {
    const inStation = tx >= station.x0 && tx <= station.x1 && ty >= station.y0 && ty <= station.y1;
    if (!inStation && (along ? ty : tx) === outer) continue;
    cells.set(`${tx},${ty}`, inStation ? 's' : 'r');
  }
  return cells;
}

/** Cells of a planned rail path: track on the tiles strictly between the anchors; bridge heads 'o' (no depot beside them). */
export function pathCells(plan, cells = new Map()) {
  const heads = new Set();
  for (const i of plan.bridges ?? []) { heads.add(i); heads.add(i + 1); }
  plan.tiles.forEach(([x, y], i) => {
    if (i === 0 || i === plan.tiles.length - 1) return;
    cells.set(`${x},${y}`, heads.has(i) ? 'o' : 'r');
  });
  return cells;
}

/** Wagons that fill a platform of `length` tiles behind one locomotive (original vehicles: 2 per tile). */
export const defaultWagons = (length) => Math.max(1, length * 2 - 1);

/**
 * Pick a locomotive and a wagon from `engines` rows (enginesFromRows, already filtered to the cargo
 * and rail type). engine/wagon ids force a choice. Locomotive: lowest running cost, then price,
 * among those with power. Wagon: carries the cargo without refit first, then largest capacity, then price.
 * Returns { loco, wagon } or throws with what is missing.
 */
export function pickTrain(engines, { cargoId, engine, wagon } = {}) {
  const locos = engines.filter((e) => !e.is_wagon && e.power > 0);
  const wagons = engines.filter((e) => e.is_wagon);
  const byId = (list, id, what) => {
    const hit = list.find((e) => e.id === id);
    if (!hit) throw new Error(`${what} ${id} is not buildable for this cargo and rail type; choose from: ${list.map((e) => `${e.id} ${e.name}`).join(', ') || 'none'}`);
    return hit;
  };
  const loco = engine !== undefined ? byId(locos, engine, 'locomotive')
    : [...locos].sort((a, b) => a.running_cost - b.running_cost || a.price - b.price)[0];
  const car = wagon !== undefined ? byId(wagons, wagon, 'wagon')
    : [...wagons].sort((a, b) => (b.cargo === cargoId) - (a.cargo === cargoId) || b.capacity - a.capacity || a.price - b.price)[0];
  if (!loco) throw new Error('no buildable locomotive can pull this cargo on this rail type (see engines --type rail --wagons false)');
  if (!car) throw new Error('no buildable wagon carries this cargo on this rail type (see engines --type rail --wagons true)');
  return { loco, wagon: car };
}

/**
 * Order flags for the two stations. Passengers/mail between two towns: plain orders both ways
 * (load and unload at each end). Otherwise: wait for a full load at the source, unload and leave
 * empty at the destination.
 */
export function routeOrderFlags({ passengerOrMail, fromTown, toTown }) {
  if (passengerOrMail && fromTown && toTown) return { source: 0, dest: 0, source_flags: '', dest_flags: '' };
  return { source: encodeOrderFlags('full_load_any'), dest: encodeOrderFlags('unload,no_load'), source_flags: 'full_load_any', dest_flags: 'unload,no_load' };
}

/** The opposite compass direction name (sw<->ne, se<->nw). */
export const oppositeDir = (d) => ({ sw: 'ne', ne: 'sw', se: 'nw', nw: 'se' })[d];
