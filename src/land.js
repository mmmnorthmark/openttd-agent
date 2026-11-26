// Owned land ("Purchase land for future use"): pure helpers for purchase-land, owned-land and
// airport-sites. The tile checks themselves run in the GameScript (BuyLandStep, IsOwnLand in main.nut)
// so the refusal and the purchase see the same game state.

/** Most tiles one purchase-land call buys (one DoCommand per tile; keeps the call well under its timeout). */
export const MAX_LAND_TILES = 400;

/** Any two opposite corners -> { x0, y0, x1, y1, width, height, tiles } with x0 <= x1, y0 <= y1. */
export function normaliseRect({ x0, y0, x1, y1 }) {
  const r = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  const width = r.x1 - r.x0 + 1, height = r.y1 - r.y0 + 1;
  return { ...r, width, height, tiles: width * height };
}

/** Throws when the rectangle is over the cap or off the map. Returns the rectangle. */
export function checkLandRect(r, { sizeX, sizeY } = {}) {
  if (r.tiles > MAX_LAND_TILES) {
    throw new Error(`area too large: ${r.width}x${r.height} = ${r.tiles} tiles; purchase-land buys at most ${MAX_LAND_TILES} tiles per call, split the rectangle. Nothing was bought.`);
  }
  if (r.x0 < 0 || r.y0 < 0 || (sizeX !== undefined && r.x1 >= sizeX) || (sizeY !== undefined && r.y1 >= sizeY)) {
    throw new Error(`rectangle ${r.x0},${r.y0}..${r.x1},${r.y1} is outside the map${sizeX ? ` (${sizeX}x${sizeY})` : ''}. Nothing was bought.`);
  }
  return r;
}

/**
 * The GS buys row by row from x0,y0. After `n` tiles: what was bought as at most two rectangles
 * [x0, y0, x1, y1], and the next tile (the one that failed), or null when all were bought.
 */
export function boughtRects(r, n) {
  const full = Math.floor(n / r.width), rest = n % r.width;
  const bought = [];
  if (full > 0) bought.push([r.x0, r.y0, r.x1, r.y0 + full - 1]);
  if (rest > 0) bought.push([r.x0, r.y0 + full, r.x0 + rest - 1, r.y0 + full]);
  const next = n < r.tiles ? { x: r.x0 + rest, y: r.y0 + full } : null;
  return { bought, next };
}

/**
 * Tiles [[x, y], ...] -> rectangles [x0, y0, x1, y1]: runs along x per row, then runs with the same
 * x range on consecutive rows are joined. Not a minimal cover, but exact and cheap. Sorted by y, x.
 */
export function mergeTiles(tiles) {
  const byRow = new Map();
  for (const [x, y] of tiles) {
    if (!byRow.has(y)) byRow.set(y, []);
    byRow.get(y).push(x);
  }
  const open = new Map(); // "x0,x1" -> rect still growing downwards
  const done = [];
  for (const y of [...byRow.keys()].sort((a, b) => a - b)) {
    const xs = [...new Set(byRow.get(y))].sort((a, b) => a - b);
    const runs = [];
    for (const x of xs) {
      const last = runs.at(-1);
      if (last && x === last[1] + 1) last[1] = x; else runs.push([x, x]);
    }
    const next = new Map();
    for (const [a, b] of runs) {
      const key = `${a},${b}`;
      const rect = open.get(key);
      if (rect && rect[3] === y - 1) { rect[3] = y; next.set(key, rect); open.delete(key); } else next.set(key, [a, y, b, y]);
    }
    done.push(...open.values());
    open.clear();
    for (const [k, v] of next) open.set(k, v);
  }
  done.push(...open.values());
  return done.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
}

/** Mirror tiles in the rectangle that could be owned land (class 'o': objects, houses, unknown). */
export function ownedLandCandidates(map, r) {
  const out = [];
  for (let y = Math.max(0, r.y0); y <= Math.min(map.sizeY - 1, r.y1); y++) {
    for (let x = Math.max(0, r.x0); x <= Math.min(map.sizeX - 1, r.x1); x++) if (map.classAt(x, y) === 'o') out.push([x, y]);
  }
  return out;
}
