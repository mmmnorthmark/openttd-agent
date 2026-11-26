// Single registry of every command. The CLI, the daemon, and the MCP server all
// expose exactly these, with the same names, schemas and JSON results.
//
// Command shape: { name, group, description, session: bool, args: zod object, run(ctx, args) }
// ctx: { cfg, session() -> Promise<Session> } — session() connects lazily.

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import * as z from 'zod/v4';
import { doctor, installGamescript, launch, checkSaveName, bundledGsVersion, TERRAIN_TYPES } from './setup.js';
import { VERSION } from './version.js';
import { saveConfig, redacted, CONFIG_FILE } from './config.js';
import { callRelay } from './relay-client.js';
import { prepareScenario } from './scenario.js';
import { guide } from './guide.js';
import { addPlayer, listPlayers, removePlayer, updatePlayer, PLAYERS_FILE } from './relay-players.js';
import { readStats, statsView, RELAY_STATS_FILE } from './relay-stats.js';
import { ratingTable, vehicleLine, stationLine, vehicleTypeId, cargoId, cargoMatches, stationsFromRows, vehiclesFromRows, enginesFromRows, groupsFromRows, vehicleDetail,
  encodeOrderFlags, ORDER_FLAG_HELP, VEHICLE_TYPES, VEHICLE_STATES, FACILITIES, parseGoalTargets, goalFromRow, findExistingRoute } from './operate.js';
import { planPath, railSteps, roadSteps, terminusSteps, terminusCandidates, terminusFootprint, depotCandidates, depotSteps, passingLoopSteps, passingLoopRemoveSteps, loopSiteProblem, loopSites, dirIndex, SIGNAL_TYPES, DIR_NAMES } from './planner.js';
import { overlayMap, terminusCells, pathCells, defaultWagons, pickTrain, routeOrderFlags, oppositeDir } from './route.js';
import { traceRail, traceRoad, trackExits, adjacencyTrace, mirrorStationTiles, railTileFromRow, roadTileFromRow, DIRS as TRACE_DIRS } from './connectivity.js';
import { recordProgress, recordStall, deadlockPartners, vehicleProblems, manhattan as tileDistance } from './problems.js';
import { routeEffort, findCargoPairs, townGaps, findFlatSites, manhattan, acceptanceFromRows, ACCEPTED, DEFAULT_COSTS } from './world.js';
import { envelope, errorCode, listResult } from './envelope.js';
import { normaliseRect, checkLandRect, boughtRects, mergeTiles, ownedLandCandidates, MAX_LAND_TILES } from './land.js';

const int = () => z.coerce.number().int();
const num = () => z.coerce.number();
const bool = () => z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const point = { x: int().describe('tile x'), y: int().describe('tile y') };
/** "1,2,3" | 5 | [1,2] -> [ints] */
const ids = () => z.preprocess((v) => (Array.isArray(v) ? v : String(v).split(',').filter((t) => t.trim() !== '')), z.array(int()).min(1));
const who = { company: int().optional().describe('company id; default: your configured company') };
const act = { ...who, dry_run: bool().default(false).describe('true = cost/feasibility only, changes nothing') };
const lc = (v) => String(v).toLowerCase();
const PAIR_MIN_DIST = 20, PAIR_MAX_DIST = 200; // find-cargo-pairs defaults (tiles, Manhattan)
/** Non-loopback IPv4 addresses of this machine (what players put in their relay URL). */
const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

/** Is `company` another company than the caller's own (cfg.company; through the relay the player's)? */
const isRival = (s, company) => s.cfg.company !== null && s.cfg.company !== undefined && company !== s.cfg.company;

/**
 * Where this machine's CLI reaches the admin port of a server bound to `bind`: 127.0.0.1 for a
 * wildcard or loopback bind, else the bound address itself (a server on 10.0.0.5 only does not
 * answer on 127.0.0.1). Several addresses: the first.
 */
export function adminHostForBind(bind) {
  const first = String(bind ?? '').split(',')[0].trim().replace(/^\[|\]$/g, '');
  if (!first || first === '0.0.0.0' || first === '::' || /^127\./.test(first) || first === 'localhost' || first === '::1') return '127.0.0.1';
  return first;
}

/** Session + company for read commands. */
async function mine(ctx, a) {
  const s = await ctx.session();
  return { s, company: s.companyOrThrow(a.company) };
}

const joinArg = (v) => {
  if (v === 'new') return -1;
  if (v === 'adjacent') return -2;
  if (!/^\d+$/.test(String(v))) throw new Error(`join must be 'new', 'adjacent' or a station id (see stations), got '${v}'`);
  return Number(v);
};
const join = { join: z.string().default('new').describe("'new' station, 'adjacent' = join a touching station, or a station id to join (may be a few tiles away)") };
const front = { front_x: int().describe('tile the entrance faces (next to x,y)'), front_y: int() };
const bridgeArg = { bridge: z.string().default('cheapest').describe("'cheapest', 'fastest' or a bridge type id (see bridge-types)") };
const bridgeType = (v) => (v === 'cheapest' ? -1 : v === 'fastest' ? -2 : Number(v));
const transport = (v) => ({ rail: 0, road: 1, water: 2 })[v];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gameDate = (i) => `${i.year}-${String(i.month).padStart(2, '0')}-${String(i.day).padStart(2, '0')}`;

/** Pause or unpause over the server console and wait until the game reports it. Returns the fresh GS info. */
/** Throw a clear refusal when the running AgentBridge is older than v12. */
async function needV12(s, cmd) {
  if (((await s.gs.call('info')).bridge_version ?? 0) < 12) throw new Error(`refused: ${cmd} needs AgentBridge v12 (the running GameScript is older); the host re-runs install-gamescript and loads the game again`);
}

/** Console save of the running game (host). Returns the reply for `save`. */
export async function saveGame(s, name) {
  const out = await s.admin.rcon(`save ${name}`, 30000);
  if (out.some((l) => /failed|error/i.test(l))) throw new Error(`server could not save '${name}': ${out.join(' ')}`);
  return { saved: `${name}.sav`, path: `save/${name}.sav`, relative_to: 'the launch profile folder (launch printed it as profile_dir)', console: out,
    load_with: `openttd-agent launch --mode dedicated --load ${name}` };
}

async function setPaused(s, want) {
  let info = await s.gs.call('info');
  if (info.paused === want) return info;
  await s.admin.rcon(want ? 'pause' : 'unpause');
  const deadline = Date.now() + 10000;
  while (info.paused !== want) {
    if (Date.now() > deadline) {
      throw new Error(want ? 'the game did not pause within 10s' : 'the game is still paused 10s after `unpause`: something else holds it (network.min_active_clients waiting for players, or a GameScript pause)');
    }
    await sleep(100);
    info = await s.gs.call('info');
  }
  return info;
}

/** What players may do while paused: construction.command_pause_level (3 = everything). Fixed for a running network game. */
async function pauseLevel(s) {
  const line = (await s.admin.rcon('setting command_pause_level')).join(' ');
  const level = Number(/is '(\d)'/.exec(line)?.[1] ?? NaN);
  return { command_pause_level: level, while_paused: ['nothing', 'orders and vehicle management only (no building)', 'everything except terraforming', 'everything'][level] ?? 'unknown' };
}

/** Plan a rail or road path on fresh tiles, then dry-run or build it. */
async function buildPath(ctx, a, mode) {
  const { s, company } = await mine(ctx, a);
  const box = [Math.min(a.x1, a.x2) - a.margin, Math.min(a.y1, a.y2) - a.margin, Math.max(a.x1, a.x2) + a.margin, Math.max(a.y1, a.y2) + a.margin];
  await s.refreshArea(...box);
  const plan = planPath(s.map, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 },
    { mode, margin: a.margin, startDir: dirIndex(a.start_dir), endDir: dirIndex(a.end_dir), maxBridge: a.max_bridge });
  if (!plan.reachable) return plan;
  const steps = (mode === 'rail' ? railSteps : roadSteps)(plan, { bridgeType: bridgeType(a.bridge) });
  const out = { reachable: true, ...plan.stats, ...(a.show_path ? { path: plan.tiles } : {}) };
  if (a.plan_only) return { ...out, steps_total: steps.length, steps };
  if (!a.dry_run) s.throttleBuild();
  const res = await s.exec(company, steps, { dryRun: a.dry_run, ...(a.rail_type !== undefined ? { railType: a.rail_type } : {}), ...(a.road_type !== undefined ? { roadType: a.road_type } : {}) });
  if (!a.dry_run) await s.refreshArea(...box);
  return { ...out, ...res };
}
const pathArgs = {
  ...act, x1: int(), y1: int(), x2: int(), y2: int(),
  start_dir: z.enum(DIR_NAMES).optional().describe('force the first step out of x1,y1: sw=+x, se=+y, ne=-x, nw=-y'),
  end_dir: z.enum(DIR_NAMES).optional().describe('force the direction of the last step into x2,y2'),
  margin: int().min(2).max(80).default(20).describe('how far outside the two points the path may wander'),
  max_bridge: int().min(3).max(40).default(12), ...bridgeArg,
  plan_only: bool().default(false).describe('return the planned steps without contacting the game'),
  show_path: bool().default(false).describe('include the tile list'),
};

/**
 * Cargo acceptance around each point (GS `acceptance`, AgentBridge v7+): one list per point, see
 * acceptanceFromRows. Returns null when the running GameScript is older and lacks the command.
 */
async function acceptanceAt(s, points, { w = 1, h = 1, radius = 4, cargos } = {}) {
  const rows = [];
  try {
    for (let i = 0; i < points.length; i += 40) {
      const part = await s.gs.call('acceptance', { points: points.slice(i, i + 40), w, h, radius, ...(cargos ? { cargos } : {}) });
      rows.push(...part.map(([k, c, v]) => [k + i, c, v]));
    }
  } catch (e) {
    if (/unknown cmd/.test(e.message)) return null;
    throw e;
  }
  return acceptanceFromRows(rows, s.cargos, points.length);
}
const OLD_GS = 'the running AgentBridge is older than v7 and has no acceptance query; the host runs install-gamescript and reloads the game';

const OLD_GS_LOAN = 'the running AgentBridge is older than v8 and has no loan step; the host re-runs install-gamescript and loads the game again';

const OLD_GS_LAND = 'the running AgentBridge is older than v10 and has no owned-land support; the host re-runs install-gamescript and loads the game again';

/**
 * Which of these tiles are the company's owned land (GS `owned_land`, AgentBridge v10), as a Set of
 * "x,y". Returns null when the running GameScript is older and lacks the command.
 */
async function ownedLandAt(s, company, points) {
  const owned = new Set();
  try {
    for (let i = 0; i === 0 || i < points.length; i += 400) { // at least one call, so an older GS is noticed
      const part = points.slice(i, i + 400);
      for (const k of await s.gs.call('owned_land', { company, points: part })) owned.add(`${part[k][0]},${part[k][1]}`);
    }
  } catch (e) {
    if (/unknown cmd/.test(e.message)) return null;
    throw e;
  }
  return owned;
}

/** Loan, max_loan and bank balance of one company (GS `companies`). */
async function loanState(s, company) {
  const c = (await s.gs.call('companies')).find((r) => r.id === company);
  if (!c) throw new Error(`company ${company} not found; run: openttd-agent companies`);
  return { loan: c.loan, max_loan: c.max_loan, money: c.money };
}

/** Town by id or exact name (case-insensitive). */
const findTown = (towns, v) => towns.find((t) => String(t.id) === String(v) || t.name.toLowerCase() === String(v).toLowerCase());

/**
 * One end of a line: { industry } | { town } | { x, y } -> { targets: tiles to be near, catchment, what, point: [x,y] }.
 * Industry targets are its industry tiles (searched in a 5x5 box from its north tile).
 */
function lineEnd(s, { towns, industries }, end) {
  if (end.industry !== undefined) {
    const ind = industries.find((i) => i.id === end.industry);
    if (!ind) throw new Error(`industry ${end.industry} not found; run: openttd-agent industries`);
    const tiles = [];
    for (let y = ind.y; y < ind.y + 5; y++) for (let x = ind.x; x < ind.x + 5; x++) if (s.map.classAt(x, y) === 'i') tiles.push([x, y]);
    return { targets: tiles.length ? tiles : [[ind.x, ind.y]], catchment: 3, what: `${ind.type_name} ${ind.id} at ${ind.x},${ind.y}`, point: [ind.x + 1, ind.y + 1], kind: 'industry', industry: ind };
  }
  if (end.town !== undefined) {
    const t = findTown(towns, end.town);
    if (!t) throw new Error(`town '${end.town}' not found; run: openttd-agent towns`);
    return { targets: [[t.x, t.y]], catchment: 4, what: `${t.name} centre ${t.x},${t.y}`, point: [t.x, t.y], kind: 'town', town: t };
  }
  if (end.x !== undefined && end.y !== undefined) return { targets: [[end.x, end.y]], catchment: 2, what: `tile ${end.x},${end.y}`, point: [end.x, end.y], kind: 'tile' };
  throw new Error('give --industry, --town, or --x and --y');
}

/**
 * station-sites: terminus spots near `end`, points facing `toward` (another end, or null), each
 * dry-run checked as `company`. opts: platforms, length, radius, limit. Used by station-sites and build-cargo-route.
 */
async function stationSites(s, company, end, toward, { platforms = 2, length = 4, radius = 8, limit = 3, railType } = {}) {
  const [economy] = await Promise.all([s.economy(), s.ensureTiles()]);
  const here = lineEnd(s, economy, end);
  const there = toward ? lineEnd(s, economy, toward).point : null;
  const cands = terminusCandidates(s.map, { targets: here.targets, radius, catchment: here.catchment, platforms, length, toward: there, max: 40 });
  const sites = []; let checked = 0;
  for (const c of cands) {
    if (sites.length >= limit || checked >= limit * 4) break;
    checked++;
    const t = terminusSteps({ x: c.x, y: c.y, axis: c.axis, platforms: c.platforms, length: c.length, exitHigh: c.exit === 'high', join: -1 });
    const res = await s.exec(company, t.steps, { dryRun: true, ...(railType !== undefined ? { railType } : {}) });
    const bad = (res.results ?? []).filter((r) => !r.ok && r.op !== 'signal');
    if (bad.length) continue;
    sites.push({ x: c.x, y: c.y, axis: c.axis, exit: c.exit, platforms: c.platforms, length: c.length, cost: res.cost, connect_at: t.connect_at,
      tiles_from_target: c.gap, build: `build-terminus --x ${c.x} --y ${c.y} --axis ${c.axis} --exit ${c.exit} --platforms ${c.platforms} --length ${c.length}` });
  }
  return { target: here.what, candidates_on_map: cands.length, dry_runs: checked, sites,
    ...(sites.length ? {} : { hint: `no site passed: try --radius 12, --length 3, --platforms 1, or clear land with demolish/terraform` }) };
}

/**
 * Does track on a depot's front tile reach the depot entrance? `front`: rail_tiles tile or null;
 * `dir`: direction from the depot to its front. Returns { front_joined, front_leads: [dir names], warning? }.
 */
export function depotFrontCheck(front, dir, company) {
  const back = (dir + 2) % 4; // the front tile's edge that faces the depot
  if (!front || front.kind !== 't' || (company !== undefined && front.owner !== company)) {
    return { front_joined: false, front_leads: [], warning: `nothing joins the depot yet: lay track on the front tile and connect it (build-track / build-rail from the front)` };
  }
  const exits = trackExits(front.tracks, back);
  const leads = exits.map((e) => DIR_NAMES[e]);
  if (!exits.length) return { front_joined: false, front_leads: [], warning: 'the track on the front tile does not reach the depot entrance (it runs past it): add a piece from the entrance with build-track' };
  return { front_joined: true, front_leads: leads, ...(leads.length === 1 ? { warning: `trains leaving the depot can only head ${leads[0]}: a new train runs that way first (to the next station or line end to turn round). Add a piece the other way for both directions` } : {}) };
}

/** Terminus search options to try in order for a town end: as asked, wider, shorter, one platform, all three. */
export function siteFallbacks(o) {
  const out = [o, { ...o, radius: o.radius + 4 }, { ...o, radius: o.radius + 4, length: Math.max(2, o.length - 1) },
    { ...o, radius: o.radius + 4, length: Math.max(2, o.length - 1), platforms: 1 }, { ...o, radius: o.radius + 8, length: Math.max(2, o.length - 1), platforms: 1 }];
  return out.filter((q, i) => i === 0 || out.slice(0, i).every((p) => p.radius !== q.radius || p.length !== q.length || p.platforms !== q.platforms));
}

const fallbackNote = (asked, used) => ({ asked: { radius: asked.radius, length: asked.length, platforms: asked.platforms }, used: { radius: used.radius, length: used.length, platforms: used.platforms },
  note: 'no terminus fitted as asked; this smaller or wider one did' });

/**
 * build-line-depot: depot beside a straight piece of rail near `near` on `map` (default the mirror;
 * build-cargo-route passes a view with its planned line). Dry run checks the depot step only.
 */
async function lineDepot(s, company, near, { radius = 12, railType, dryRun = false, map = s.map, onLine = null } = {}) {
  const rt = railType !== undefined ? { railType } : {};
  const cands = depotCandidates(map, near, { radius, onLine });
  const tried = [];
  for (const c of cands.slice(0, 8)) {
    const steps = depotSteps(c);
    const check = await s.exec(company, [steps[0]], { dryRun: true, ...rt });
    if (!(check.results ?? []).every((r) => r.ok)) { tried.push({ depot: c.depot, error: check.results?.[0]?.error }); continue; }
    const depot = { x: c.depot[0], y: c.depot[1] };
    if (dryRun) return { ok: true, dry_run: true, depot, front: { x: c.front[0], y: c.front[1] }, cost: check.cost, tried };
    s.throttleBuild();
    const res = await s.exec(company, steps, rt);
    await s.refreshArea(c.depot[0] - 1, c.depot[1] - 1, c.depot[0] + 1, c.depot[1] + 1);
    const ok = (res.results ?? []).every((r) => r.ok);
    return { ok, depot, front: { x: c.front[0], y: c.front[1] }, cost: res.cost, results: res.results, tried,
      ...(ok ? { next: `vehicle-buy --depot_x ${depot.x} --depot_y ${depot.y} --engine <id>` } : { hint: 'a join failed: run build-track on the front tile toward each end, or try another --station' }) };
  }
  return { ok: false, candidates_on_map: cands.length, tried, hint: cands.length ? 'every spot failed its dry run; try --radius 20' : 'no straight piece of rail with free flat land beside it near there; try --radius 20 or another station' };
}

/** "x,y" keys of a planned route's own track: the line's tiles and both termini (terminusCells). */
function routeTiles(line, cells) {
  return new Set([...line.tiles.map(([x, y]) => `${x},${y}`), ...cells.keys()]);
}

/** Do two terminus sites (station-sites entries) share a tile? */
function sitesOverlap(a, b) {
  const tiles = (site) => terminusFootprint({ x: site.x, y: site.y, axis: site.axis, platforms: site.platforms, length: site.length, exitHigh: site.exit === 'high' }).tiles;
  const seen = new Set(tiles(a).map((t) => t.join(',')));
  return tiles(b).some((t) => seen.has(t.join(',')));
}

/** Your station whose sign tile lies on a just-built terminus site. */
async function stationAt(s, company, site) {
  const { station: r } = terminusFootprint({ x: site.x, y: site.y, axis: site.axis, platforms: site.platforms, length: site.length, exitHigh: site.exit === 'high' });
  const rows = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
  return rows.find((st) => st.x >= r.x0 && st.x <= r.x1 && st.y >= r.y0 && st.y <= r.y1) ?? null;
}

/**
 * A vehicle of `company` with orders at both stations, or null. Station rows count vehicles with
 * orders there (GSVehicleList_Station); 0 at either end = nobody serves the pair. Otherwise the
 * order lists of likely vehicles (current destination one of the two, AgentBridge v9; else all
 * trains) are read, at most 30.
 */
export async function vehicleServing(s, company, stations, aId, bId) {
  const count = (id) => stations.find((st) => st.id === id)?.vehicles ?? 0;
  if (!count(aId) || !count(bId)) return null;
  const all = vehiclesFromRows(await s.gs.call('vehicles', { company }));
  const likely = all.filter((v) => (v.dest_station === undefined ? v.type === 'rail' : v.dest_station === aId || v.dest_station === bId));
  for (const v of likely.slice(0, 30)) {
    const { orders } = await currentOrderOf(s, company, v.id);
    const at = new Set(orders.filter((o) => o.kind === 'station').map((o) => o.station));
    if (at.has(aId) && at.has(bId)) return v.id;
  }
  return null;
}

/**
 * build-cargo-route: plan everything as a dry run (both termini, the line between their connect_at
 * anchors, a depot beside the line near the source, a train), then, unless dryRun, build it step by
 * step. On a failure it stops and reports the step and everything already built; it never demolishes.
 */
async function buildCargoRoute(s, company, a) {
  const plan = { dry_run: a.dry_run, company };
  const built = [];
  const vehiclesBought = () => built.filter((b) => b.step === 'buy_locomotive').map((b) => b.vehicle);
  const fail = (step, error, extra = {}) => ({ ok: false, failed_step: step, error, first_error: errorCode(error), cost: extra.spent ?? 0, vehicles: vehiclesBought(), built, ...plan, ...extra,
    hint: built.length ? 'nothing was demolished: continue from the failed step by hand (build-rail, build-line-depot, vehicle-buy, order-add, vehicle-start) using the ids and tiles in built' : 'nothing was built' });
  const from = a.from_industry !== undefined ? { industry: a.from_industry } : a.from_town !== undefined ? { town: a.from_town } : null;
  const to = a.to_industry !== undefined ? { industry: a.to_industry } : a.to_town !== undefined ? { town: a.to_town } : null;
  if (!from || !to) throw new Error('give one source (--from_industry <id> or --from_town <name>) and one destination (--to_industry <id> or --to_town <name>)');
  const cargo = cargoId(s.cargos, a.cargo);
  const cargoInfo = s.cargos.get(cargo);
  const railTypes = await s.gs.call('rail_types', { company });
  // Default: the cheapest track (the plain build-rail default is the game's first listed type, often electrified).
  const railType = a.rail_type ?? [...railTypes].sort((p, q) => p[3] - q[3])[0]?.[0];
  if (railType === undefined) throw new Error('your company cannot build any rail type yet (see rail-types)');
  plan.rail_type = railType;

  // 0. Already running this route? A second line beside the first doubles the cost for little
  // more cargo; more trains on the first line is the usual answer (a live agent built one twice).
  if (!a.allow_existing) {
    const economy = await s.economy();
    const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
    const bothWays = !!(cargoInfo?.passengers || cargoInfo?.mail);
    const existing = findExistingRoute(stations, lineEnd(s, economy, from), lineEnd(s, economy, to), cargo, { radius: a.radius + 2, bothWays });
    const servedBy = existing ? await vehicleServing(s, company, stations, existing.from_station.id, existing.to_station.id) : null;
    if (existing && servedBy !== null) {
      return fail('existing_route', `refused: you already run this route: ${existing.from_station.name} (${existing.from_station.id}) and ${existing.to_station.name} (${existing.to_station.id}), served by vehicle ${servedBy}`,
        { existing: { ...existing, served_by: servedBy }, first_error: 'existing_route',
          hint: `add capacity instead: vehicle-clone --vehicle ${servedBy} --depot auto --start true; or pass --allow_existing true to build a second line anyway` });
    }
    if (existing) plan.existing_unserved = { ...existing, note: 'your stations there have no vehicle serving both, so a new line is built (they are not reused)' };
  }

  // 1. Stations: best dry-run-checked site at each end, facing the other end, not overlapping.
  // A town end that has no site (houses everywhere) is retried wider, shorter and with one platform.
  const opts = { platforms: a.platforms, length: a.length, radius: a.radius, limit: 3, railType };
  const tries = (end) => (end.town === undefined ? [opts] : siteFallbacks(opts));
  const accepts = new Map();
  const acceptOf = async (d) => {
    const along = d.axis === 'y';
    const lists = await acceptanceAt(s, [[d.x, d.y]], { w: along ? d.platforms : d.length, h: along ? d.length : d.platforms, radius: 4, cargos: [cargo] });
    return lists ? (lists[0][0]?.acceptance ?? 0) : null;
  };
  let srcSites = null, dstSites = null, accepting = [];
  for (const o of tries(from)) {
    srcSites = await stationSites(s, company, from, to, o);
    if (srcSites.sites.length) { if (o !== opts) plan.source_fallback = fallbackNote(opts, o); break; }
  }
  if (!srcSites.sites.length) return fail('source_station', `no terminus site passed near ${srcSites.target}${from.town !== undefined ? ' (also tried wider, shorter and single-platform termini)' : ''}`, { hint_sites: srcSites.hint });
  for (const o of tries(to)) {
    dstSites = await stationSites(s, company, to, from, o);
    // Destination sites must accept the cargo (AgentBridge v7; null = not checkable, kept with a note).
    for (const d of dstSites.sites) accepts.set(d, await acceptOf(d));
    accepting = dstSites.sites.filter((d) => accepts.get(d) === null || accepts.get(d) >= ACCEPTED);
    if (accepting.length) { if (o !== opts) plan.dest_fallback = fallbackNote(opts, o); break; }
  }
  if (!dstSites.sites.length) return fail('dest_station', `no terminus site passed near ${dstSites.target}${to.town !== undefined ? ' (also tried wider, shorter and single-platform termini)' : ''}`, { hint_sites: dstSites.hint });
  if (!accepting.length) {
    return fail('dest_station', `no terminus site near ${dstSites.target} accepts ${cargoInfo?.name ?? a.cargo} (acceptance ${[...accepts.values()].join(', ')}; ${ACCEPTED} needed)`);
  }
  let src = null, dst = null;
  for (const p of srcSites.sites) { const q = accepting.find((d) => !sitesOverlap(p, d)); if (q) { src = p; dst = q; break; } }
  if (!src) return fail('dest_station', 'every source and destination site overlap: the two ends are too close for two termini');
  plan.source_site = { target: srcSites.target, ...src };
  plan.dest_site = { target: dstSites.target, ...dst, acceptance: accepts.get(dst) };
  // Warn when a new terminus lands next to one of our stations: often a second line to the same place.
  const ownStations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
  const warnings = [];
  for (const [end, site] of [['source', src], ['dest', dst]]) {
    for (const st of ownStations) {
      const d = tileDistance(st, site);
      if (d <= 8) warnings.push({ near_own_station: { id: st.id, name: st.name, x: st.x, y: st.y }, end, tiles: d });
    }
  }
  if (warnings.length) plan.warnings = warnings;
  if (accepts.get(dst) === null) plan.warning = `destination acceptance not checked: ${OLD_GS}`;

  // 2. Line between the anchors, planned on a view that already has both termini.
  const lineArgs = (map) => planPath(map, src.connect_at, dst.connect_at, { mode: 'rail', margin: a.margin, startDir: dirIndex(src.connect_at.dir),
    endDir: dirIndex(oppositeDir(dst.connect_at.dir)), maxBridge: a.max_bridge });
  const box = [Math.min(src.connect_at.x, dst.connect_at.x) - a.margin, Math.min(src.connect_at.y, dst.connect_at.y) - a.margin,
    Math.max(src.connect_at.x, dst.connect_at.x) + a.margin, Math.max(src.connect_at.y, dst.connect_at.y) + a.margin];
  await s.refreshArea(...box);
  const cells = terminusCells(dst, terminusCells(src));
  const line = lineArgs(overlayMap(s.map, cells));
  if (!line.reachable) return fail('rail_line', line.reason ?? 'no rail path between the two stations');
  const lineSteps = railSteps(line, { bridgeType: -1 });
  const lineCheck = await s.exec(company, lineSteps, { dryRun: true, railType });
  plan.line = { ...line.stats, cost: lineCheck.cost };
  if (!lineCheck.ok) return fail('rail_line', `rail dry run failed: ${lineCheck.error}`, { line_results: lineCheck.results.filter((r) => !r.ok).slice(0, 5) });

  // 3. Depot beside the planned line near the source.
  const near = [src.connect_at.x, src.connect_at.y];
  // Only beside this route's own track: other lines nearby are rail too, and a train bought in a
  // depot on another line can never reach this route's stations.
  const depotCheck = await lineDepot(s, company, near, { radius: 12, railType, dryRun: true, map: overlayMap(s.map, pathCells(line, cells)), onLine: routeTiles(line, cells) });
  if (!depotCheck.ok) return fail('depot', depotCheck.hint ?? 'no depot spot passed its dry run', { tried: depotCheck.tried });
  plan.depot = { ...depotCheck.depot, cost: depotCheck.cost };

  // 4. Train.
  const engines = enginesFromRows(await s.gs.call('engines', { company, type: 0, cargo, rail_type: railType }), s.cargos);
  let train;
  try { train = pickTrain(engines, { cargoId: cargo, engine: a.engine, wagon: a.wagon }); } catch (e) { return fail('engine', e.message); }
  const wagons = a.wagons ?? defaultWagons(src.length);
  plan.train = { locomotive: { id: train.loco.id, name: train.loco.name, price: train.loco.price, running_cost: train.loco.running_cost },
    wagon: { id: train.wagon.id, name: train.wagon.name, price: train.wagon.price, capacity: train.wagon.capacity }, wagons,
    cost: train.loco.price + wagons * train.wagon.price };
  const orders = routeOrderFlags({ passengerOrMail: !!(cargoInfo?.passengers || cargoInfo?.mail), fromTown: !!from.town, toTown: !!to.town });
  plan.orders = { source: orders.source_flags || 'plain', dest: orders.dest_flags || 'plain' };
  const estimate = src.cost + dst.cost + lineCheck.cost + depotCheck.cost + plan.train.cost;
  plan.estimated_cost = estimate;
  plan.money = lineCheck.money;
  plan.affordable = lineCheck.money === null || lineCheck.money >= estimate;
  if (a.dry_run) return { ok: true, ...plan, cost: estimate, vehicles: [], built: [], note: 'dry run: nothing was built. Depot joins and train purchase are estimated, not dry-run.' };
  if (!plan.affordable) return fail('money', `estimated cost ${estimate} is more than the company has (${lineCheck.money})`);

  // ---- build, step by step -------------------------------------------------------------
  const exec = async (steps, opts2 = {}) => { s.throttleBuild(); return s.exec(company, steps, { railType, ...opts2 }); };
  let spent = 0;
  const station = async (name, site) => {
    const t = terminusSteps({ x: site.x, y: site.y, axis: site.axis, platforms: site.platforms, length: site.length, exitHigh: site.exit === 'high', join: -1 });
    const res = await exec(t.steps);
    spent += res.cost;
    const st = res.results.some((r) => r.op === 'rail_station' && r.ok) ? await stationAt(s, company, site) : null;
    if (st || res.results.some((r) => r.ok)) built.push({ step: name, station: st?.id ?? null, x: site.x, y: site.y, connect_at: site.connect_at, complete: res.ok, cost: res.cost });
    return { res, st };
  };
  try {
    const A = await station('source_station', src);
    if (!A.res.ok) return fail('source_station', A.res.error, { spent });
    const B = await station('dest_station', dst);
    if (!B.res.ok) return fail('dest_station', B.res.error, { spent });
    await s.refreshArea(...box);
    const realLine = lineArgs(s.map);
    if (!realLine.reachable) return fail('rail_line', realLine.reason ?? 'no rail path after building the stations', { spent });
    const lineRes = await exec(railSteps(realLine, { bridgeType: -1 }));
    spent += lineRes.cost;
    built.push({ step: 'rail_line', from: src.connect_at, to: dst.connect_at, tiles: realLine.stats.tiles, steps_done: lineRes.steps_done, steps_total: lineRes.steps_total, complete: lineRes.ok, cost: lineRes.cost });
    if (!lineRes.ok) {
      const bad = lineRes.results.find((r) => !r.ok);
      return fail('rail_line', lineRes.error, { spent, failed_rail_step: bad ? railSteps(realLine, { bridgeType: -1 })[bad.step] : null });
    }
    await s.refreshArea(...box);
    // The overlay marks what was just built in case the mirror rows lag behind.
    const realCells = terminusCells(dst, terminusCells(src));
    const dep = await lineDepot(s, company, near, { radius: 12, railType, map: overlayMap(s.map, pathCells(realLine, realCells)), onLine: routeTiles(realLine, realCells) });
    spent += dep.cost ?? 0;
    if (dep.depot) built.push({ step: 'depot', x: dep.depot.x, y: dep.depot.y, front: dep.front, complete: dep.ok, cost: dep.cost });
    if (!dep.ok) return fail('depot', dep.hint ?? 'depot failed', { spent, depot_results: dep.results });
    const locoRes = await exec([['veh_buy', dep.depot.x, dep.depot.y, train.loco.id, -1, -1]]);
    spent += locoRes.cost;
    const loco = locoRes.ok ? locoRes.results[0].value : null;
    if (loco === null || loco === undefined) return fail('buy_locomotive', locoRes.error, { spent });
    built.push({ step: 'buy_locomotive', vehicle: loco, engine: train.loco.id, complete: true, cost: locoRes.cost });
    const refit = train.wagon.cargo === cargo ? -1 : cargo;
    const wagRes = await exec(Array.from({ length: wagons }, () => ['veh_buy', dep.depot.x, dep.depot.y, train.wagon.id, refit, loco]));
    spent += wagRes.cost;
    built.push({ step: 'buy_wagons', attached_to: loco, wagons: wagRes.steps_done, of: wagons, wagon_ids: wagRes.results.filter((r) => r.ok).map((r) => r.value), complete: wagRes.ok, cost: wagRes.cost });
    if (!wagRes.ok) return fail('buy_wagons', wagRes.error, { spent, vehicle: loco });
    const ordRes = await exec([['order_add', loco, src.x, src.y, orders.source, -1], ['order_add', loco, dst.x, dst.y, orders.dest, -1]]);
    built.push({ step: 'orders', vehicle: loco, done: ordRes.steps_done, complete: ordRes.ok });
    if (!ordRes.ok) return fail('orders', ordRes.error, { spent, vehicle: loco });
    const startRes = await exec([['veh_start_stop', loco, 1]]);
    if (!startRes.ok) return fail('start', startRes.error, { spent, vehicle: loco });
    built.push({ step: 'start', vehicle: loco, complete: true });
    return { ok: true, ...plan, dry_run: false, source_station: A.st?.id ?? null, dest_station: B.st?.id ?? null, depot: dep.depot, vehicle: loco, vehicles: [loco],
      cost: spent, total_cost: spent, built, next: `vehicle-clone --depot_x ${dep.depot.x} --depot_y ${dep.depot.y} --vehicle ${loco} --start true adds trains with the same orders` };
  } catch (e) {
    const last = built.at(-1)?.step ?? null;
    return fail(last ? `after ${last}` : 'source_station', e.message, { spent });
  }
}

// ---- connectivity (verify-route, vehicle-problems) ---------------------------------

const OLD_GS_TRACE = 'the running AgentBridge is older than v9 and has no rail_tiles query, so this is a coarse trace over the map mirror (rail and station tiles touching, no track directions; bridges and tunnels guessed from straight runs). For an exact trace the host re-runs install-gamescript and loads the game again';
const TRACE_BLOCK = 16;

/** Tile getter over GS `rail_tiles` (v9), loading 16x16 blocks on first use; cached for one command. */
function railTileSource(s) {
  const blocks = new Map();
  const tiles = new Map();
  return async (x, y) => {
    if (!s.map.inBounds(x, y)) return null;
    const bx = Math.floor(x / TRACE_BLOCK), by = Math.floor(y / TRACE_BLOCK);
    const bk = `${bx},${by}`;
    if (!blocks.has(bk)) {
      blocks.set(bk, s.gs.call('rail_tiles', { x0: bx * TRACE_BLOCK, y0: by * TRACE_BLOCK, x1: bx * TRACE_BLOCK + TRACE_BLOCK - 1, y1: by * TRACE_BLOCK + TRACE_BLOCK - 1 })
        .then((rows) => { for (const r of rows) tiles.set(`${r[0]},${r[1]}`, railTileFromRow(r)); }));
    }
    await blocks.get(bk);
    return tiles.get(`${x},${y}`) ?? null;
  };
}

/** Tiles of one station, flooding from (x, y) over tiles with the same station id. */
async function stationTiles(getTile, x, y, station, limit = 200) {
  const out = [];
  const seen = new Set();
  const queue = [{ x, y }];
  while (queue.length && out.length < limit) {
    const p = queue.shift();
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const t = await getTile(p.x, p.y);
    if (!t || t.station !== station) continue;
    out.push({ x: p.x, y: p.y });
    for (const [dx, dy] of TRACE_DIRS) queue.push({ x: p.x + dx, y: p.y + dy });
  }
  return out;
}

/**
 * Tracer for one command: trace(starts, goalStation) -> result with `method`.
 * goalStation: { id, x, y } (x, y = the station's location tile). Exact on GS v9, mirror fallback before.
 * `info` is a fresh GS `info` reply (its bridge_version says which).
 */
async function makeTracer(s, company, info) {
  if ((info.bridge_version ?? 0) >= 9) {
    const getTile = railTileSource(s);
    return {
      method: 'rail_tracks',
      tileAt: getTile,
      stationStarts: (st) => stationTiles(getTile, st.x, st.y, st.id),
      trace: async (starts, goal) => ({ method: 'rail_tracks',
        ...await traceRail({ getTile, starts, isGoal: (t) => t.station === goal.id, goal, company }) }),
    };
  }
  await s.ensureTiles();
  const depots = (await s.gs.call('depots', { company, type: 0 })).map(([x, y]) => ({ x, y }));
  return {
    method: 'mirror_adjacency',
    stationStarts: async (st) => mirrorStationTiles(s.map, st.x, st.y),
    trace: async (starts, goal) => ({ method: 'mirror_adjacency',
      ...adjacencyTrace(s.map, starts, mirrorStationTiles(s.map, goal.x, goal.y), goal, { depots }) }),
  };
}

const OLD_GS_ROAD = 'road vehicles and road stops are traced with the road_tiles query of AgentBridge v11; the running GameScript is older, so there is no road answer (rather than a wrong rail one). The host re-runs install-gamescript and loads the game again';

/** Tile getter over GS `road_tiles` (v11), 16x16 blocks loaded on first use; cached for one command. */
function roadTileSource(s, company) {
  const blocks = new Map();
  const tiles = new Map();
  return async (x, y) => {
    if (!s.map.inBounds(x, y)) return null;
    const bx = Math.floor(x / TRACE_BLOCK), by = Math.floor(y / TRACE_BLOCK);
    const bk = `${bx},${by}`;
    if (!blocks.has(bk)) {
      blocks.set(bk, s.gs.call('road_tiles', { company, x0: bx * TRACE_BLOCK, y0: by * TRACE_BLOCK, x1: bx * TRACE_BLOCK + TRACE_BLOCK - 1, y1: by * TRACE_BLOCK + TRACE_BLOCK - 1 })
        .then((rows) => { for (const r of rows) tiles.set(`${r[0]},${r[1]}`, roadTileFromRow(r)); }));
    }
    await blocks.get(bk);
    return tiles.get(`${x},${y}`) ?? null;
  };
}

/** Road stop tiles of station `st`: flood from its sign tile, else the stop tiles within 6 tiles of it. */
async function roadStopTiles(getTile, st) {
  const out = await stationTiles(getTile, st.x, st.y, st.id);
  if (out.length) return out;
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
    const t = await getTile(st.x + dx, st.y + dy);
    if (t && t.station === st.id) out.push({ x: t.x, y: t.y });
  }
  return out;
}

/** Road tracer (AgentBridge v11), the same interface as makeTracer's; null when the GS is older. */
function makeRoadTracer(s, company, info) {
  if ((info.bridge_version ?? 0) < 11) return null;
  const getTile = roadTileSource(s, company);
  return {
    method: 'road_tiles',
    tileAt: getTile,
    stationStarts: (st) => roadStopTiles(getTile, st),
    trace: async (starts, goal) => ({ method: 'road_tiles', ...await traceRoad({ getTile, starts, isGoal: (t) => t.station === goal.id, goal, company }) }),
  };
}

const findStation = (stations, v) => {
  const hit = stations.find((st) => String(st.id) === String(v)) ?? stations.find((st) => lc(st.name) === lc(v));
  if (!hit) throw new Error(`no station '${v}' of this company; run: openttd-agent stations`);
  return hit;
};

/** Current order of a vehicle as { current_order, dest, dest_station, speed } from GS `vehicle` (any version). */
async function currentOrderOf(s, company, id) {
  const d = vehicleDetail(await s.gs.call('vehicle', { company, vehicle: id }), s.cargos);
  const o = d.orders.find((r) => r.position === d.current_order);
  return { current_order: d.current_order, dest: o && o.x >= 0 ? { x: o.x, y: o.y } : null, dest_station: o?.station ?? -1, speed: d.speed, orders: d.orders };
}

/**
 * Trace a vehicle's route: from its position to each order station, and between consecutive order
 * stations. Returns { connected, from_vehicle: [...], legs: [...] }.
 */
async function routeLegs(s, company, tracer, stations, veh) {
  const brief = (r) => ({ connected: r.connected, ...(r.connected ? {} : { last_reachable: r.last_reachable ?? null, first_gap: r.first_gap ?? null }), tiles_reached: r.tiles_reached });
  const { orders, current_order } = await currentOrderOf(s, company, veh.id);
  const stops = orders.filter((o) => o.kind === 'station' && stations.some((st) => st.id === o.station));
  if (!stops.length) throw new Error(`vehicle ${veh.id} has no station orders; add some with order-add`);
  const fromVehicle = [];
  for (const o of stops) {
    const st = stations.find((x) => x.id === o.station);
    fromVehicle.push({ order: o.position, station: st.id, station_name: st.name, current: o.position === current_order, ...brief(await tracer.trace([{ x: veh.x, y: veh.y }], st)) });
  }
  const legs = [];
  for (let i = 0; i < stops.length && stops.length > 1; i++) {
    const from = stations.find((x) => x.id === stops[i].station), to = stations.find((x) => x.id === stops[(i + 1) % stops.length].station);
    legs.push({ from: from.name, to: to.name, ...brief(await tracer.trace(await tracer.stationStarts(from), to)) });
  }
  return { connected: fromVehicle.every((r) => r.connected) && legs.every((r) => r.connected), from_vehicle: fromVehicle, legs };
}

/**
 * Longest train on vehicle `id`'s line (same set of order stations), in tiles (GSVehicle.GetLength
 * is in 1/16 tile). Looks at trains heading for one of its stations (AgentBridge v9), at most 20.
 * Returns { tiles, vehicle, trains_checked }.
 */
async function longestTrainOnLine(s, company, id) {
  const veh = await vehicleOf(s, company, id);
  if (veh.type !== 'rail') throw new Error(`refused: vehicle ${id} is not a train`);
  const detail = async (vid) => vehicleDetail(await s.gs.call('vehicle', { company, vehicle: vid }), s.cargos);
  const own = await detail(id);
  const stops = new Set(own.orders.filter((o) => o.kind === 'station').map((o) => o.station));
  const same = (d) => { const st = new Set(d.orders.filter((o) => o.kind === 'station').map((o) => o.station)); return st.size === stops.size && [...st].every((x) => stops.has(x)); };
  let best = { tiles: Math.ceil((own.length ?? 0) / 16), vehicle: id };
  const others = vehiclesFromRows(await s.gs.call('vehicles', { company }))
    .filter((v) => v.type === 'rail' && v.id !== id && (v.dest_station === undefined || stops.has(v.dest_station))).slice(0, 20);
  for (const v of others) {
    const d = await detail(v.id);
    const tiles = Math.ceil((d.length ?? 0) / 16);
    if (same(d) && tiles > best.tiles) best = { tiles, vehicle: v.id };
  }
  return { ...best, trains_checked: others.length + 1 };
}

// ---- depot guard (vehicle-clone, vehicle-buy --route_of) ---------------------------------

/** Source vehicle row (type, position) of this company. */
async function vehicleOf(s, company, id) {
  const veh = vehiclesFromRows(await s.gs.call('vehicles', { company })).find((v) => v.id === id);
  if (!veh) throw new Error(`vehicle ${id} does not exist or is not owned by company ${company}; run: openttd-agent vehicles`);
  return veh;
}

/** A vehicle's order stations, in order, as rows from `stations`. */
async function orderStations(s, company, id) {
  const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
  const { orders } = await currentOrderOf(s, company, id);
  const ids = [...new Set(orders.filter((o) => o.kind === 'station').map((o) => o.station))];
  return ids.map((sid) => stations.find((st) => st.id === sid)).filter(Boolean);
}

/**
 * Is rail depot `depot` ({x, y}) joined to every station in `stops`? Exact on GS v9 (also checks a
 * rail depot of this company is there); with the mirror trace only "not connected" is trusted.
 * Returns { connected, method, failed?: { station, station_name, first_gap, last_reachable }, error? }.
 */
async function depotServes(s, company, tracer, depot, stops, mirrorDepots) {
  if (tracer.method === 'rail_tracks') {
    const t = await tracer.tileAt(depot.x, depot.y);
    if (!t || t.kind !== 'd' || t.owner !== company) return { connected: false, method: tracer.method, error: `no rail depot of company ${company} at (${depot.x},${depot.y}); run: openttd-agent depots --type rail` };
  } else if (!mirrorDepots.some((d) => d.x === depot.x && d.y === depot.y)) {
    return { connected: false, method: tracer.method, error: `no rail depot of company ${company} at (${depot.x},${depot.y}); run: openttd-agent depots --type rail` };
  }
  for (const st of stops) {
    const r = await tracer.trace([depot], st);
    if (!r.connected) return { connected: false, method: tracer.method, failed: { station: st.id, station_name: st.name, at: { x: st.x, y: st.y }, last_reachable: r.last_reachable ?? null, first_gap: r.first_gap ?? null } };
  }
  return { connected: true, method: tracer.method };
}

/**
 * Depot for a vehicle of `veh`'s type on its own route: the company's depots nearest the first order
 * station (else the vehicle), rail ones only if depotServes says connected. Tries up to `tries`.
 * Returns { depot, distance, checked, tried } or { depot: null, tried }.
 */
async function routeDepot(s, company, tracer, veh, stops, { tries = 8 } = {}) {
  const ref = stops[0] ?? veh;
  const rows = (await s.gs.call('depots', { company, type: vehicleTypeId(veh.type) })).map(([x, y]) => ({ x, y }));
  const cands = rows.map((d) => ({ ...d, distance: tileDistance(d, ref) })).sort((p, q) => p.distance - q.distance);
  if (veh.type !== 'rail' || !tracer) return { depot: cands[0] ?? null, distance: cands[0]?.distance, checked: false, tried: [] };
  const tried = [];
  for (const c of cands.slice(0, tries)) {
    const r = await depotServes(s, company, tracer, c, stops, rows);
    if (r.connected) return { depot: { x: c.x, y: c.y }, distance: c.distance, checked: true, tried };
    tried.push({ depot: { x: c.x, y: c.y }, not_connected_to: r.failed?.station_name ?? null, ...(r.error ? { error: r.error } : {}) });
  }
  return { depot: null, tried, depots_total: cands.length };
}

/**
 * Resolve and check the depot for a clone (or a buy for vehicle `id`'s route). `a` has depot_x/depot_y
 * or depot 'auto'. Throws a refusal when an explicit rail depot is not joined to the route.
 * Returns { depot, route_check } for the reply.
 */
async function depotForRoute(s, company, a, id, { cmd }) {
  const explicit = a.depot_x !== undefined || a.depot_y !== undefined;
  if (explicit && (a.depot_x === undefined || a.depot_y === undefined)) throw new Error('give both --depot_x and --depot_y, or --depot auto');
  if (explicit && a.depot === 'auto') throw new Error('give --depot auto or --depot_x/--depot_y, not both');
  const veh = await vehicleOf(s, company, id);
  const rail = veh.type === 'rail';
  const stops = !explicit || (rail && a.check_route) ? await orderStations(s, company, id) : [];
  if (explicit && (!a.check_route || !rail || !stops.length)) {
    const why = !a.check_route ? 'skipped (--check_route false)' : !rail ? `not checked (${veh.type} vehicle; only rail is traced)` : `not checked (vehicle ${id} has no station orders)`;
    return { depot: { x: a.depot_x, y: a.depot_y }, route_check: why };
  }
  const tracer = rail && stops.length ? await makeTracer(s, company, await s.gs.call('info')) : null;
  const coarse = tracer?.method === 'mirror_adjacency';
  const note = coarse ? { route_check_note: OLD_GS_TRACE } : {};
  if (!explicit) {
    const pick = await routeDepot(s, company, tracer, veh, stops);
    if (!pick.depot) {
      const first = stops[0];
      throw new Error(`no depot of company ${company} for ${veh.type} vehicle ${id} is ${rail ? `rail-connected to its order stations (tried ${pick.tried.length} of ${pick.depots_total} nearest ${first ? `${first.name}` : 'the vehicle'})` : 'there'}; `
        + (rail && first ? `build one on its line: openttd-agent build-line-depot --station ${first.id}` : 'build a depot first'));
    }
    return { depot: pick.depot, route_check: pick.checked ? (coarse ? 'coarse_not_refuted' : 'connected') : `not checked (${!rail ? `${veh.type} vehicle; only rail is traced` : `vehicle ${id} has no station orders`})`,
      depot_auto: { nearest_to: stops[0] ? { station: stops[0].id, station_name: stops[0].name } : { vehicle: id }, distance: pick.distance, skipped: pick.tried }, ...note };
  }
  const depot = { x: a.depot_x, y: a.depot_y };
  const mirrorDepots = coarse ? (await s.gs.call('depots', { company, type: 0 })).map(([x, y]) => ({ x, y })) : [];
  const r = await depotServes(s, company, tracer, depot, stops, mirrorDepots);
  if (!r.connected) {
    let alt = null;
    try { alt = (await routeDepot(s, company, tracer, veh, stops)).depot; } catch { alt = null; }
    const where = r.error ?? `depot (${depot.x},${depot.y}) is not rail-connected to ${r.failed.station_name} (${r.failed.at.x},${r.failed.at.y}), an order station of vehicle ${id}`
      + (r.failed.first_gap ? ` (first gap at (${r.failed.first_gap.x},${r.failed.first_gap.y}): ${r.failed.first_gap.reason})` : '')
      + `; a ${cmd === 'vehicle-clone' ? 'clone' : 'train'} there would get lost`;
    const fix = alt ? `Use --depot auto (picks (${alt.x},${alt.y}) on its route) or --depot_x ${alt.x} --depot_y ${alt.y}` : `Build a depot on its line: openttd-agent build-line-depot --station ${stops[0].id}`;
    throw new Error(`refused: ${where}. ${fix}${coarse ? ' (coarse trace: the running AgentBridge is older than v9)' : ''}`);
  }
  return { depot, route_check: coarse ? 'coarse_not_refuted' : 'connected', ...note };
}

/** "1951 Q2" for the quarter `back` quarters before the running one (GS quarter numbering: 0 = running). */
export function quarterLabel(info, back) {
  const idx = info.year * 4 + Math.floor((info.month - 1) / 3) - back;
  return `${Math.floor(idx / 4)} Q${(idx % 4) + 1}`;
}

/** Map station id -> [vehicle ids with an order for it] (GS v12 station_vehicles), or null on an older GameScript. */
async function stationVehicleIds(s, company, station) {
  let rows;
  try { rows = await s.gs.call('station_vehicles', { company, ...(station !== undefined ? { station } : {}) }); } catch (e) {
    if (/unknown cmd/.test(e.message)) return null;
    throw e;
  }
  const out = new Map();
  for (const [st, ids] of rows) out.set(st, [...(out.get(st) ?? []), ...ids]);
  return out;
}

/** --orders "A,B" + --order_flags "f1;f2" -> [{ station, name, x, y, flags, flag_names }]. Pure over decoded stations. */
export function orderPlan(stations, ordersText, flagsText = '') {
  const refs = String(ordersText).split(',').map((t) => t.trim()).filter(Boolean);
  if (!refs.length) throw new Error('--orders needs at least one station id or name');
  const sets = String(flagsText).split(';').map((t) => t.trim());
  if (sets.length > 1 && sets.length !== refs.length) throw new Error(`--order_flags has ${sets.length} sets for ${refs.length} orders; give one set per order separated by ";", or one set for all`);
  return refs.map((ref, i) => {
    const st = findStation(stations, ref);
    const names = sets.length > 1 ? sets[i] : sets[0];
    return { station: st.id, name: st.name, x: st.x, y: st.y, flags: encodeOrderFlags(names), flag_names: names.split(',').map((t) => t.trim()).filter(Boolean) };
  });
}

const KIND_NAMES = { t: 'track', s: 'station', w: 'waypoint', d: 'depot', x: 'crossing', b: 'bridge', u: 'tunnel' };
const PIECE_NAMES = [[1, 'x'], [2, 'y'], [4, 'n'], [8, 's'], [16, 'w'], [32, 'e']];
const FROM_NAMES = ['from_sw', 'from_se', 'from_ne', 'from_nw']; // neighbour d: 0 +x (SW), 1 +y (SE), 2 -x (NE), 3 -y (NW)

/** rail_tiles tile -> readable row for rail-tiles. Pure. */
export function describeRailTile(t, company) {
  const signals = [];
  for (let d = 0; d < 4; d++) if (t.signals & (1 << (4 + d))) signals.push({ facing: FROM_NAMES[d], one_way: !!(t.signals & (1 << d)) });
  return { x: t.x, y: t.y, kind: KIND_NAMES[t.kind] ?? t.kind, ...(t.tracks ? { tracks: PIECE_NAMES.filter(([b]) => t.tracks & b).map(([, n]) => n) } : {}),
    ...(signals.length ? { signals } : {}), ...(t.kind === 'd' ? { front: { x: t.a, y: t.b } } : {}), ...(t.kind === 'b' || t.kind === 'u' ? { other_end: { x: t.a, y: t.b } } : {}),
    ...(t.station >= 0 ? { station: t.station } : {}), rail_type: t.rail_type, owner: t.owner, mine: t.owner === company };
}

/**
 * Position for the "stop in depot" order of a vehicle being replaced: right after the next order
 * (from its current one) at which it unloads (unload, transfer or no_load flags), else after the
 * next station order. Pure; orders as vehicleDetail decodes them.
 */
export function depotOrderPosition(orders, current) {
  const n = orders.length;
  if (!n) return 0;
  const start = Math.max(0, current);
  const at = (i) => orders[(start + i) % n];
  for (let i = 0; i < n; i++) {
    const o = at(i);
    if (o.kind === 'station' && o.flags.some((f) => f === 'unload' || f === 'transfer' || f === 'no_load')) return ((start + i) % n) + 1;
  }
  for (let i = 0; i < n; i++) if (at(i).kind === 'station') return ((start + i) % n) + 1;
  return start + 1;
}

/** One vehicle of vehicle-replace. Returns { ok, vehicle, new_vehicle, depot, cost, old: {...}, error? }. */
async function replaceOne(s, company, a, id, v12) {
  const fail = (error, extra = {}) => ({ ok: false, vehicle: id, error, first_error: errorCode(error), ...extra });
  let place;
  try {
    place = await depotForRoute(s, company, { depot: a.depot_x === undefined ? 'auto' : a.depot, depot_x: a.depot_x, depot_y: a.depot_y, check_route: true }, id, { cmd: 'vehicle-clone' });
  } catch (e) { return fail(e.message); }
  const { depot } = place;
  const d = vehicleDetail(await s.gs.call('vehicle', { company, vehicle: id }), s.cargos);
  const cargo = d.capacity.find((c) => c.capacity > 0)?.cargo ?? -1;
  // Steps that make the new vehicle; its id is the value of the first step.
  let buy;
  let wagonPlan = null;
  if (a.engine === undefined) {
    buy = [['veh_clone', depot.x, depot.y, id, true]];
  } else {
    buy = [['veh_buy', depot.x, depot.y, a.engine, d.type === 'rail' ? -1 : cargo, -1]];
    if (d.type === 'rail') {
      let wagon = a.wagon, count = a.wagons;
      if ((wagon === undefined || count === undefined) && v12) {
        const parts = (await s.gs.call('vehicle_wagons', { company, vehicle: id })).filter((r) => r[0] > 0);
        const freq = new Map();
        for (const r of parts) freq.set(r[1], (freq.get(r[1]) ?? 0) + 1);
        wagon ??= [...freq.entries()].sort((p, q) => q[1] - p[1])[0]?.[0];
        count ??= parts.length;
      }
      if (count === undefined) count = Math.max(0, (d.wagons ?? 1) - 1);
      if (count > 0 && wagon === undefined) return fail('refused: give --wagon ENGINE_ID (the running AgentBridge is older than v12 and cannot read the old train\'s wagon type)');
      wagonPlan = { wagon: wagon ?? null, count };
    }
  }
  if (a.dry_run) {
    const res = await s.exec(company, buy, { dryRun: true });
    return { ok: res.ok, vehicle: id, dry_run: true, depot, ...(place.route_check ? { route_check: place.route_check } : {}), cost: res.cost, would: { buy: a.engine === undefined ? 'clone' : `engine ${a.engine}`, ...(wagonPlan ? { wagons: wagonPlan } : {}), old_vehicle: a.when === 'now' ? 'to depot now, sold there' : 'stop in depot after its next unloading stop, sold there' }, ...(res.ok ? {} : { error: res.error, first_error: res.first_error }) };
  }
  s.throttleBuild();
  const bought = await s.exec(company, buy);
  if (!bought.ok) return fail(bought.error, { depot, cost: bought.cost });
  const nv = bought.results[0].value;
  let cost = bought.cost;
  const follow = [];
  if (wagonPlan && wagonPlan.count > 0) for (let i = 0; i < wagonPlan.count; i++) follow.push(['veh_buy', depot.x, depot.y, wagonPlan.wagon, cargo, nv]);
  if (a.engine !== undefined) follow.push(['orders_copy', nv, id, true]);
  follow.push(['veh_start_stop', nv, 1]);
  const setup = await s.exec(company, follow);
  cost += setup.cost;
  if (!setup.ok) return fail(`bought vehicle ${nv} at (${depot.x},${depot.y}) but setting it up failed: ${setup.error}; it is stopped in the depot (finish by hand or vehicle-sell it)`, { new_vehicle: nv, depot, cost });
  // The old vehicle: own copy of the orders, then a stop-in-depot order after its next unloading stop.
  const oldSteps = [];
  // The new vehicle shares the old one's orders now (clone or orders_copy with share). Unsharing leaves
  // the old vehicle with no orders (OpenTTD CO_UNSHARE), so copy them back from the new one, unshared.
  oldSteps.push(['orders_unshare', id], ['orders_copy', id, nv, false]);
  if (a.when === 'now') oldSteps.push(['veh_depot', id, false]);
  else {
    // Unload there but load nothing (its own copy of the orders), then stop in the depot.
    const pos = depotOrderPosition(d.orders, d.current_order);
    const stop = d.orders[pos - 1];
    if (stop?.kind === 'station' && !stop.flags.includes('no_load') && !stop.flags.includes('no_unload')) {
      const keep = stop.flags.filter((f) => !f.startsWith('full_load'));
      oldSteps.push(['order_flags', id, pos - 1, encodeOrderFlags([...keep, 'no_load'].join(','))]);
    }
    oldSteps.push(['order_add', id, depot.x, depot.y, 8, pos]);
  }
  let oldRes = { ok: true };
  if (d.state !== 'in_depot') oldRes = await s.exec(company, oldSteps);
  s.pendingSales.set(`${company}:${id}`, { company, vehicle: id, replaced_by: nv, since: new Date().toISOString() });
  const sold = d.state === 'in_depot' ? await s.finishSales() : null;
  return { ok: oldRes.ok, vehicle: id, new_vehicle: nv, depot, cost, started: true,
    old: d.state === 'in_depot' ? { state: 'in_depot', sold: sold.sold.some((x) => x.vehicle === id) } : { heading: a.when === 'now' ? 'depot now' : `depot (${depot.x},${depot.y}) after unloading at order ${depotOrderPosition(d.orders, d.current_order) - 1} (no_load there)`, sold_on_arrival: true },
    ...(oldRes.ok ? {} : { error: `new vehicle ${nv} runs, but sending old vehicle ${id} to the depot failed: ${oldRes.error}; send it with vehicle-depot and sell it`, first_error: oldRes.first_error }) };
}

/**
 * Why `build-signal --remove` would fail, from GS `rail_tiles` (v9+): no rail, or no signal facing
 * trains from front. null = go ahead (also when the running GameScript is too old to tell).
 */
async function signalRemoveRefusal(s, a) {
  const d = TRACE_DIRS.findIndex(([dx, dy]) => a.x + dx === a.front_x && a.y + dy === a.front_y);
  if (d < 0) return `front_not_adjacent: front (${a.front_x},${a.front_y}) must be a neighbour of (${a.x},${a.y})`;
  if (((await s.gs.call('info')).bridge_version ?? 0) < 9) return null;
  const [row] = await s.gs.call('rail_tiles', { x0: a.x, y0: a.y, x1: a.x, y1: a.y });
  const t = row ? railTileFromRow(row) : null;
  if (!t || t.kind !== 't') return `no_signal_here: (${a.x},${a.y}) is ${t ? 'not plain track (a station, depot, crossing, bridge or tunnel)' : 'not rail'}, so it has no signal`;
  if (t.signals & (1 << (4 + d))) return null;
  const others = [0, 1, 2, 3].filter((k) => t.signals & (1 << (4 + k))).map((k) => `(${a.x + TRACE_DIRS[k][0]},${a.y + TRACE_DIRS[k][1]})`);
  return `no_signal_here: no signal on (${a.x},${a.y}) facing trains from (${a.front_x},${a.front_y})${others.length ? `; it has one facing trains from ${others.join(' and ')}: give that as --front_x/--front_y` : '; the tile has no signals'}`;
}

/**
 * vehicle-buy --attach_to: the train must be stopped inside the depot the wagon is bought in, or the
 * game sells the wagon and then refuses to couple it. Returns the refusal text, or null.
 */
async function attachRefusal(s, company, a) {
  const train = vehiclesFromRows(await s.gs.call('vehicles', { company })).find((v) => v.id === a.attach_to);
  if (!train) return `refused: train ${a.attach_to} does not exist or is not yours (run: openttd-agent vehicles --type rail); nothing was bought`;
  if (train.type !== 'rail') return `refused: vehicle ${a.attach_to} is a ${train.type} vehicle; only trains take wagons; nothing was bought`;
  if (train.state !== 'in_depot') {
    return `refused: train ${a.attach_to} is ${train.state.replace('_', ' ')} at (${train.x},${train.y}), not stopped in a depot, so a wagon cannot be attached; nothing was bought. `
      + `Fix: vehicle-depot --vehicles ${a.attach_to}, wait until vehicles --state in_depot lists it, then buy the wagons at that depot`;
  }
  if (train.x !== a.depot_x || train.y !== a.depot_y) {
    return `refused: train ${a.attach_to} is stopped in the depot at (${train.x},${train.y}), not at (${a.depot_x},${a.depot_y}); nothing was bought. Fix: vehicle-buy --depot_x ${train.x} --depot_y ${train.y} --attach_to ${a.attach_to} ...`;
  }
  return null;
}

const oppDir = (d) => (d + 2) % 4;

/**
 * Does a just-built road stop or depot join the road network? `shape`: 'depot' | 'bay' |
 * 'drive_through'. An end joins when the stop links into it and it links on to another tile.
 * Returns { connected, ends: [{ x, y, joined }] } or null when the GameScript is older than v11.
 */
async function roadJoin(s, company, a, shape) {
  if (((await s.gs.call('info')).bridge_version ?? 0) < 11) return null;
  const getTile = roadTileSource(s, company);
  const d = TRACE_DIRS.findIndex(([dx, dy]) => a.x + dx === a.front_x && a.y + dy === a.front_y);
  if (d < 0) return { connected: false, ends: [], error: 'front is not next to x,y' };
  const dirs = shape === 'drive_through' ? [d, oppDir(d)] : [d];
  const t = await getTile(a.x, a.y);
  const ends = [];
  for (const k of dirs) {
    const ex = a.x + TRACE_DIRS[k][0], ey = a.y + TRACE_DIRS[k][1];
    const e = await getTile(ex, ey);
    const into = !!t && !!(t.links & (1 << k));
    const onward = !!e && (e.links & ~(1 << oppDir(k)) & 15) !== 0;
    ends.push({ x: ex, y: ey, joined: into && onward, ...(into ? {} : { reason: t ? 'stop_or_depot_not_joined' : 'not_built' }), ...(into && !onward ? { reason: e ? 'dead_end' : 'no_road' } : {}) });
  }
  return { connected: ends.some((e) => e.joined), ends };
}

/** Nearest road tile in the map mirror to (x, y) within `radius`, skipping `skip` ("x,y" keys). */
function nearestRoad(map, x, y, skip, radius = 30) {
  let best = null;
  for (let ty = y - radius; ty <= y + radius; ty++) for (let tx = x - radius; tx <= x + radius; tx++) {
    if (!map.inBounds(tx, ty) || map.classAt(tx, ty) !== 'd' || skip.has(`${tx},${ty}`)) continue;
    const dist = Math.abs(tx - x) + Math.abs(ty - y);
    if (dist > 1 && (!best || dist < best.dist)) best = { x: tx, y: ty, dist };
  }
  return best;
}

/** Add `connected` to a road stop/depot build result and, with connect=auto, join it to the nearest road. */
async function withRoadJoin(s, company, a, res, shape) {
  if (!res.ok || a.dry_run) return res;
  if (a.road_type !== undefined && a.road_type !== 0) return { ...res, connected: null, connected_note: 'not checked: the road trace (road_tiles) follows plain road only, not other road or tram types' };
  const join = await roadJoin(s, company, a, shape);
  if (!join) return { ...res, connected: null, connected_note: OLD_GS_ROAD };
  if (join.connected || a.connect !== 'auto') {
    return { ...res, connected: join.connected, ends: join.ends, ...(join.connected ? {} : { hint: `the entrance does not reach a road: build-road-path --x1 ${join.ends[0].x} --y1 ${join.ends[0].y} --x2 <a road tile> --y2 <y>, or rerun with --connect auto` }) };
  }
  const end = join.ends.find((e) => e.reason !== 'stop_or_depot_not_joined') ?? join.ends[0];
  await s.refreshArea(end.x - 30, end.y - 30, end.x + 30, end.y + 30);
  const target = nearestRoad(s.map, end.x, end.y, new Set([`${a.x},${a.y}`, `${end.x},${end.y}`]));
  if (!target) return { ...res, connected: false, ends: join.ends, connect: { ok: false, error: 'no road within 30 tiles in the map mirror' } };
  const plan = planPath(s.map, end, target, { mode: 'road', margin: 10 });
  if (!plan.reachable) return { ...res, connected: false, ends: join.ends, connect: { ok: false, to: target, error: plan.reason ?? 'no road path found' } };
  s.throttleBuild();
  const built = await s.exec(company, roadSteps(plan, { bridgeType: -1 }));
  await s.refreshArea(Math.min(end.x, target.x) - 10, Math.min(end.y, target.y) - 10, Math.max(end.x, target.x) + 10, Math.max(end.y, target.y) + 10);
  const after = await roadJoin(s, company, a, shape);
  return { ...res, cost: res.cost + built.cost, connected: after?.connected ?? null, ends: after?.ends ?? join.ends,
    connect: { ok: built.ok, from: { x: end.x, y: end.y }, to: { x: target.x, y: target.y }, tiles: plan.stats.tiles, cost: built.cost, ...(built.ok ? {} : { error: built.error }) } };
}

/** Likely reasons a drive-through stop at a.x,a.y was refused, from road_tiles (v11) and the mirror. */
async function driveThroughRefusal(s, company, a) {
  const why = [];
  const d = TRACE_DIRS.findIndex(([dx, dy]) => a.x + dx === a.front_x && a.y + dy === a.front_y);
  if (d < 0) return ['front is not next to x,y'];
  await s.refreshArea(a.x, a.y, a.x, a.y);
  if (s.map.slopeAt(a.x, a.y)) why.push('slope: the tile is sloped; drive-through stops need flat road (or a slope the game can put a foundation under)');
  if (((await s.gs.call('info')).bridge_version ?? 0) < 11) return why;
  const t = await roadTileSource(s, company)(a.x, a.y);
  if (!t) return why;
  const along = (1 << d) | (1 << oppDir(d));
  if (t.kind !== 'r') why.push(`not_plain_road: (${a.x},${a.y}) is a ${{ d: 'depot', s: 'road stop', t: 'drive-through stop', b: 'bridge head', u: 'tunnel portal' }[t.kind] ?? t.kind}`);
  if (t.links & ~along & 15) why.push(`junction: road leaves (${a.x},${a.y}) sideways; pick a straight piece without side roads`);
  if (((t.links & (1 << d)) !== 0) !== ((t.links & (1 << oppDir(d))) !== 0)) why.push('one_way_road: the road there is one-way');
  if (t.owner !== company && t.owner >= 0 && t.owner < 15) why.push(`other_owner_road: the road belongs to company ${t.owner}`);
  return why;
}

/** Run exec steps as the company (client throttle + GS rate gate apply). */
async function run(ctx, a, steps, opts = {}) {
  const { s, company } = await mine(ctx, a);
  if (!a.dry_run) s.throttleBuild();
  return s.exec(company, steps, { dryRun: a.dry_run, ...opts });
}

export const COMMANDS = [
  // ---- setup ------------------------------------------------------------------
  {
    name: 'doctor', group: 'setup', session: false,
    description: 'Check this machine: OpenTTD install, personal dir, original graphics/music, GameScript version. Run first.',
    args: z.object({}),
    run: () => doctor(),
  },
  {
    name: 'guide', group: 'setup', session: false,
    description: "Read-only checklist for game night: role, ordered steps (done true/false/null = can't tell), and next = the first step still to do. Run it first when you are not connected or have no company yet, and follow next. Probes are quick and change nothing; no secrets in the output.",
    args: z.object({ role: z.enum(['host', 'player']).optional().describe('default: player if a relay is configured, host if an admin password or launch profile exists, else both') }),
    run: (ctx, a) => guide(ctx, a.role),
  },
  {
    name: 'install-gamescript', group: 'setup', session: false,
    description: 'HOST ONLY: copy the bundled AgentBridge GameScript (and IdleAI test AI) into the OpenTTD personal dir. Re-run after updating openttd-agent.',
    args: z.object({}),
    run: () => installGamescript(),
  },
  {
    name: 'configure', group: 'setup', session: false,
    description: `Save settings to ${CONFIG_FILE} (with the global --profile NAME or OPENTTD_AGENT_PROFILE: to ~/.openttd-agent/players/NAME.json instead, so several players or agents on one machine each keep their own relay token). PLAYER: relay (http://<host-LAN-IP>:<port>) and token, both from the host; game commands then go through the host's relay as the company the host bound you to. HOST: admin_password (stays on this machine), admin_port, relay_port. Either: max_builds_per_minute (0 = unlimited). relay "" switches back to the admin port directly.`,
    args: z.object({
      relay: z.string().optional().describe('player: relay URL, e.g. http://192.168.1.20:47978 ("" = off)'),
      token: z.string().optional().describe('player: token from the host (relay-add-player)'),
      host: z.string().optional(), admin_port: int().optional(), admin_password: z.string().optional().describe('host only'),
      relay_port: int().min(1).max(65535).optional().describe('host: port the relay listens on'),
      company: int().optional().describe('direct mode only; with a relay the host decides your company'),
      max_builds_per_minute: int().min(0).optional(), tile_refresh_rows_per_sec: int().min(0).optional(),
    }),
    run: (_ctx, { token, ...a }) => {
      if (a.relay) {
        let url;
        try { url = new URL(a.relay); } catch { throw new Error(`relay must be a URL like http://192.168.1.20:47978, got '${a.relay}'`); }
        if (url.protocol !== 'http:') throw new Error('relay must be an http:// URL (the relay speaks plain HTTP on the LAN)');
        a.relay = url.origin;
      }
      return redacted(saveConfig({ ...a, ...(token !== undefined ? { relay_token: token } : {}) }));
    },
  },
  {
    name: 'show-config', group: 'setup', session: false,
    description: 'Show the effective config (password redacted).',
    args: z.object({}),
    run: (ctx) => redacted(ctx.cfg),
  },
  {
    name: 'launch', group: 'setup', session: false,
    description: 'Start OpenTTD with the right settings. mode=dedicated: headless LAN server with AgentBridge (everyone joins as a client). mode=host: GUI with server settings preset; then Multiplayer > Start Server. mode=join: GUI client joining join_host. Never edits your own openttd.cfg (uses a profile in ~/.openttd-agent/profiles).',
    args: z.object({
      mode: z.enum(['dedicated', 'host', 'join']).default('dedicated'),
      admin_password: z.string().optional().describe('dedicated/host: defaults to the configured admin_password; if there is none, a random one is generated and saved in the config (it never needs to leave this machine)'),
      join_host: z.string().optional().describe('host LAN IP for mode=join; defaults to configured host'),
      seed: int().optional(), map_bits: int().min(6).max(12).default(8).describe('map size as power of two: 8=256, 9=512, 10=1024'),
      load: z.string().optional().describe('savegame to load instead of generating a new map: a path, or a save name from the profile\'s save/ folder (e.g. the one scenario-prepare printed)'),
      command_delay_ticks: int().min(0).max(74).default(0).describe('GameScript rate limit: extra ticks after each build command (0 = full speed)'),
      max_builds_per_day: int().min(0).default(0).describe('GameScript rate limit per company per game day (0 = unlimited)'),
      terrain: z.enum(TERRAIN_TYPES).optional().describe('new maps only; default: whatever your openttd.cfg says (OpenTTD default flat)'),
      script_opcodes: int().min(500).max(250000).default(100000).describe('host: opcodes the GameScript may run per tick (OpenTTD default 10000); higher = faster map mirror and replies'),
      bind: z.string().default('0.0.0.0'), dry_run: bool().default(false),
    }),
    run: (ctx, a) => {
      let adminPassword = a.admin_password ?? ctx.cfg.admin_password;
      const hosting = a.mode !== 'join';
      const generated = hosting && !adminPassword;
      if (generated) adminPassword = randomBytes(24).toString('base64url');
      const result = launch({
        mode: a.mode, adminPassword, joinHost: a.join_host ?? ctx.cfg.host,
        seed: a.seed, mapBits: a.map_bits, load: a.load, commandDelayTicks: a.command_delay_ticks,
        maxBuildsPerDay: a.max_builds_per_day, scriptOpcodes: a.script_opcodes, terrain: a.terrain, bind: a.bind, adminPort: ctx.cfg.admin_port, dryRun: a.dry_run,
      });
      // The relay and the CLI on this machine read the password and admin address from the config, so keep them in step.
      const host = hosting ? adminHostForBind(a.bind) : null;
      const updates = {
        ...(hosting && adminPassword !== ctx.cfg.admin_password ? { admin_password: adminPassword } : {}),
        ...(host && host !== ctx.cfg.host ? { host } : {}),
      };
      if (!a.dry_run && Object.keys(updates).length) saveConfig(updates);
      return { ...result, ...(generated ? { admin_password: a.dry_run ? 'would be generated' : 'generated and saved in the config' } : {}),
        ...(updates.host ? { admin_host: a.dry_run ? `would be saved as host: ${host}` : `saved as host: ${host} (the server listens only there)` } : {}) };
    },
  },
  {
    name: 'scenario-prepare', group: 'setup', session: false,
    description: 'HOST ONLY: download a scenario from BaNaNaS (OpenTTD\'s content service) into the running server and write a copy that runs AgentBridge (<name>_agent.sav in the server\'s save folder). A scenario loaded as-is would not start AgentBridge. Needs a server started by `launch` with AgentBridge running. The server briefly loads the scenario, so run it before players join; without --load true the game that was running is restored afterwards.',
    args: z.object({
      search: z.string().min(2).optional().describe('text in the scenario name; must match exactly one (the error lists the candidates with their ids)'),
      content_id: int().optional().describe('numeric BaNaNaS content id, as listed by --search or by the console\'s `content state`'),
      name: z.string().optional().describe('save name prefix; default: made from the scenario name'),
      load: bool().default(false).describe('true = leave the server running the prepared scenario'),
      script_opcodes: int().min(500).max(250000).default(100000).describe('GameScript opcodes per tick stored in the copy (a scenario brings its own, usually 10000)'),
    }),
    run: (ctx, a) => prepareScenario(ctx.cfg, { search: a.search, contentId: a.content_id, name: a.name, load: a.load, scriptOpcodes: a.script_opcodes }),
  },

  // ---- relay (host only: who may play which company) ---------------------------
  {
    name: 'relay-add-player', group: 'relay', session: false,
    description: `HOST ONLY: register a player for the relay and print their token ONCE (only a hash is kept, in ${PLAYERS_FILE}). company = a company id, or 'pending' to bind later with relay-set-company. Give the player the printed configure line.`,
    args: z.object({
      name: z.string().describe('player name, 1-32 of A-Z a-z 0-9 _ . -'),
      company: z.string().default('pending').describe("company id (see companies) or 'pending'"),
      max_builds_per_minute: int().min(0).optional().describe("this player's build limit on the relay (0 = unlimited; default: the host's configured max_builds_per_minute)"),
    }),
    run: (ctx, a) => {
      const p = addPlayer({ name: a.name, company: a.company, maxBuildsPerMinute: a.max_builds_per_minute });
      const urls = lanAddresses().map((ip) => `http://${ip}:${ctx.cfg.relay_port}`);
      return { ...p, relay_urls: urls,
        give_to_player: `openttd-agent configure --relay ${urls[0] ?? `http://<host-LAN-IP>:${ctx.cfg.relay_port}`} --token ${p.token}`,
        or_as_profile: `openttd-agent --profile ${p.name} configure --relay ${urls[0] ?? `http://<host-LAN-IP>:${ctx.cfg.relay_port}`} --token ${p.token}  (then: openttd-agent --profile ${p.name} <command>, or OPENTTD_AGENT_PROFILE=${p.name})`,
        note: 'The token is shown only now. It is sent in clear text over the LAN (plain HTTP).' };
    },
  },
  {
    name: 'relay-list-players', group: 'relay', session: false,
    description: 'HOST ONLY: registered relay players and the company each is bound to (no tokens).',
    args: z.object({}),
    run: () => { const players = listPlayers(); return listResult('players', players, players); },
  },
  {
    name: 'relay-set-company', group: 'relay', session: false,
    description: "HOST ONLY: bind a registered player to a company (or 'pending' to unbind), and/or change their build limit. Applies to their next request; the relay need not restart.",
    args: z.object({ name: z.string(), company: z.string().optional().describe("company id or 'pending'"), max_builds_per_minute: int().min(0).optional() }),
    run: (_ctx, a) => updatePlayer(a.name, { company: a.company, maxBuildsPerMinute: a.max_builds_per_minute }),
  },
  {
    name: 'relay-stats', group: 'relay', session: false,
    description: `HOST ONLY: is each relay player still active? Per player: last_call, seconds_since_last_call, last_command, calls_last_minute, calls_per_min_10min, calls_total, refused_total, errors_total, last_refusal (since the relay started). Read from ${RELAY_STATS_FILE}, which the running relay updates every few seconds; never served through the relay.`,
    args: z.object({}),
    run: () => {
      const snap = readStats();
      if (!snap) return { ok: true, error: null, running: false, note: 'no stats yet: the relay has not started or has had no calls (openttd-agent relay)', players: [] };
      return { started: snap.started ?? null, ...statsView(snap) };
    },
  },
  {
    name: 'relay-remove-player', group: 'relay', session: false,
    description: 'HOST ONLY: remove a player; their token stops working at once.',
    args: z.object({ name: z.string() }),
    run: (_ctx, a) => removePlayer(a.name),
  },

  // ---- game -------------------------------------------------------------------
  {
    name: 'status', group: 'game', session: true,
    description: 'Game date, map size, pause state, your company, rate limits, tile-mirror progress, versions (openttd-agent, running and bundled AgentBridge) and warnings (an outdated GameScript or, through a relay, a different openttd-agent version on the host).',
    args: z.object({}),
    run: async (ctx) => {
      const s = await ctx.session();
      const [info, companies, rate] = await Promise.all([s.gs.call('info'), s.gs.call('companies'), s.gs.call('get_rate')]);
      const loaded = s.map.rowsLoaded.reduce((n, v) => n + v, 0);
      const bundled = bundledGsVersion();
      const running = info.bridge_version ?? null;
      const warnings = [];
      if (bundled !== null && running !== null && running < bundled) {
        warnings.push(`the game runs AgentBridge v${running}; this openttd-agent ${VERSION} ships v${bundled}. Host: openttd-agent install-gamescript, then load or launch the game again (a running game keeps its GameScript); until then newer features say so or fall back`);
      }
      return { info, my_company: s.cfg.company, companies, rate, client_max_builds_per_minute: s.cfg.max_builds_per_minute,
        tile_mirror: { rows_loaded: loaded, rows_total: s.map.sizeY, load_ms: s.tileLoadMs ?? null },
        versions: { openttd_agent: VERSION, gamescript_running: running, gamescript_bundled: bundled }, warnings };
    },
  },
  {
    name: 'companies', group: 'game', session: true,
    description: 'All companies: money, loan, and for the last full quarter (`period`, e.g. "1951 Q2") income, expenses (negative), company value, cargo delivered and performance rating; station_count and vehicles_by_type {rail, road, water, air} (AgentBridge v12; the company window shows both to anyone). --history N adds the last N quarters per company (`history`: period, value, income, expenses, delivered, performance; newest first; AgentBridge v12). Use for competitor assessment.',
    args: z.object({ history: int().min(0).max(24).default(0).describe('quarters of history per company (0 = none)') }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const [info, rows] = await Promise.all([s.gs.call('info'), s.gs.call('companies')]);
      const out = [];
      for (const c of rows) {
        const { vehicles_by_type: vt, ...rest } = c;
        const row = { ...rest, period: quarterLabel(info, 1), ...(vt ? { vehicles_by_type: { rail: vt[0], road: vt[1], water: vt[2], air: vt[3] } } : {}) };
        if (a.history > 0) {
          try {
            const h = await s.gs.call('company_history', { company: c.id, quarters: a.history });
            row.history = h.filter((r) => r[0] >= 1).sort((p, q) => p[0] - q[0])
              .map(([q, value, income, expenses, delivered, performance]) => ({ period: quarterLabel(info, q), value, income, expenses, delivered, performance }));
          } catch (e) {
            if (!/unknown cmd/.test(e.message)) throw e;
            row.history = null;
            row.history_note = 'needs AgentBridge v12; the host re-runs install-gamescript and loads the game again';
          }
        }
        out.push(row);
      }
      return listResult('companies', out, out);
    },
  },
  {
    name: 'rating', group: 'game', session: true,
    description: 'Your performance rating broken down the way the game computes it (out of 1000): per component the value now, what is needed for full points, points and max: vehicles (profitable last year, 120 for 100 points), stations (served station parts, 80 for 100), min_profit (worst vehicle over 2 years old, 10000 for 100), min_income / max_income (worst/best quarter of the last 12, 50000 for 50 / 100000 for 100), delivered (last 4 quarters, 40000 for 400), cargo_types (8 for 50; scripts cannot read it: null), money (10M for 50), loan (no loan = 50). Sorted by missing points, so the first rows are where points are easiest to find. stations counts parts with a vehicle order (the game counts those served in the last 20 days). AgentBridge v12.',
    args: z.object({ ...who }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      let parts, history;
      try { [parts, history] = await Promise.all([s.gs.call('rating_parts', { company }), s.gs.call('company_history', { company, quarters: 12 })]); } catch (e) {
        if (/unknown cmd/.test(e.message)) throw new Error('refused: rating needs AgentBridge v12; the host re-runs install-gamescript and loads the game again');
        throw e;
      }
      const t = ratingTable(parts, history);
      const last = history.find((r) => r[0] === 1);
      return { company, game_rating_last_quarter: last ? last[5] : null, estimate_now: t.points_known, estimate_note: `out of ${t.max_known} known points; cargo_types (max 50) is not readable by scripts`,
        quarters_used: t.quarters_used, components: [...t.components].sort((p, q) => (q.missing ?? -1) - (p.missing ?? -1)) };
    },
  },
  {
    name: 'chat', group: 'game', session: true,
    description: 'Broadcast a chat message to all players in the game.',
    args: z.object({ message: z.string().min(1) }),
    run: async (ctx, a) => { (await ctx.session()).admin.chat(a.message); return { sent: true }; },
  },
  {
    name: 'rate', group: 'game', session: true,
    description: 'Get or set the GameScript build rate limit for everyone (host decision). command_delay_ticks 0 = full speed; max_builds_per_day 0 = unlimited; -1 = back to the setting chosen at launch.',
    args: z.object({ command_delay_ticks: int().min(-1).max(74).optional(), max_builds_per_day: int().min(-1).optional() }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      return Object.keys(a).length ? s.gs.call('set_rate', a) : s.gs.call('get_rate');
    },
  },
  {
    name: 'goal-status', group: 'game', session: true,
    description: "Your company's goal, with fresh progress: per target the amount, progress so far, pct and done; status active/done/failed (or none), deadline_year and days_left. Cargo progress counts deliveries since the goal was set; VALUE is the current company value. The same goal shows in the game's goal window.",
    args: z.object({ ...who }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const rows = await s.gs.call('goal_status', { company });
      return rows.length ? goalFromRow(rows[0]) : { company, status: 'none', note: 'no goal set for this company (the host sets one with goal-set)' };
    },
  },

  // ---- host (needs the game; refused through the relay) --------------------------
  {
    name: 'goal-set', group: 'host', session: true,
    description: "HOST ONLY: set (or replace) a company's goal: deliver amounts of cargo and/or reach a company value by the end of deadline_year. Counting starts now. AgentBridge tracks it (a game runs one GameScript, so a goal script cannot run next to it), shows it in the goal window and settles it: done when every target was reached, failed when the deadline year ends first (events goal_done / goal_failed).",
    args: z.object({
      ...who, deadline_year: int().describe('the goal must be met by 31 December of this year'),
      targets: z.union([z.string(), z.array(z.any())]).describe("'COAL:3000,PASS:3000,VALUE:500000': cargo labels as `cargos` lists them, VALUE = company value"),
    }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const targets = parseGoalTargets(a.targets, [...s.cargos.values()].map((c) => c.label));
      return goalFromRow((await s.gs.call('goal_set', { company, deadline_year: a.deadline_year, targets }))[0]);
    },
  },
  {
    name: 'pause', group: 'host', session: true,
    description: 'HOST ONLY: pause the game for everyone (--save NAME also saves it then). The GameScript keeps answering, so agents can look and plan; whether they can also build while paused is `while_paused` in the result (games started or prepared by openttd-agent allow everything).',
    args: z.object({ save: z.string().optional().describe('also save the game under this name once paused') }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const name = a.save !== undefined ? checkSaveName(a.save) : null;
      const info = await setPaused(s, true);
      return { paused: info.paused, date: gameDate(info), ...(await pauseLevel(s)), ...(name ? { save: await saveGame(s, name) } : {}) };
    },
  },
  {
    name: 'unpause', group: 'host', session: true,
    description: 'HOST ONLY: let the game run again.',
    args: z.object({}),
    run: async (ctx) => {
      const info = await setPaused(await ctx.session(), false);
      return { paused: info.paused, date: gameDate(info) };
    },
  },
  {
    name: 'turn-advance', group: 'host', session: true,
    description: 'HOST ONLY: turn-based play. Unpause, let `days` game days pass (about 2 s each; multiplayer has no fast-forward), pause again, and return the new date and the events that happened. Use it in a loop: think and build while paused, then advance. The game ends paused even if the wait fails.',
    args: z.object({ days: int().min(1).max(120).default(30).describe('game days to run; a month is ~30 (about 60 s of real time). Max 120 per call (4 minutes): one CLI call must answer within 5 minutes') }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const started = Date.now();
      const before = await s.gs.call('info');
      let now = before;
      let stalled = '';
      try {
        now = await setPaused(s, false);
        const deadline = Date.now() + a.days * 4000 + 20000;
        while (now.date < before.date + a.days) {
          if (Date.now() > deadline) { stalled = `only ${now.date - before.date} of ${a.days} days passed in ${Math.round((Date.now() - started) / 1000)}s; is the server overloaded?`; break; }
          await sleep(200);
          now = await s.gs.call('info');
        }
      } finally {
        now = await setPaused(s, true);
      }
      if (stalled) throw new Error(`turn-advance: ${stalled} The game is paused at ${gameDate(now)}.`);
      const events = await s.gs.call('events', { since: before.event_seq });
      s._economy.at = 0; // a turn passed: towns and industries changed
      return { from: gameDate(before), to: gameDate(now), days_advanced: now.date - before.date, paused: now.paused,
        real_seconds: Math.round((Date.now() - started) / 100) / 10, latest_seq: events.length ? events.at(-1).seq : before.event_seq, events };
    },
  },
  {
    name: 'goal-clear', group: 'host', session: true,
    description: "HOST ONLY: remove a company's goal and its goal window entries.",
    args: z.object({ ...who }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      return { company, ...(await s.gs.call('goal_clear', { company })) };
    },
  },

  {
    name: 'save', group: 'host', session: true,
    description: "HOST ONLY: save the running server game over the console (`save <name>`). OpenTTD writes it to the launch profile's save folder (save/<name>.sav next to the profile's openttd.cfg); load it again with launch --load <name>. Name: letters, digits, _ . - only (no paths). Periodic saves: --every_months N --prefix P makes the daemon save P-YYYY-MM every N game months (checked every 20 s while the game runs; also once now); --every_months 0 stops; with neither name nor every_months it shows the schedule. The schedule lives in the daemon (or MCP server) and ends when it restarts.",
    args: z.object({ name: z.string().optional().describe('save name without extension, e.g. game-night-1'),
      every_months: int().min(0).max(120).optional().describe('periodic save every N game months (0 = stop)'), prefix: z.string().default('autosave').describe('periodic save name prefix') }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      if (a.every_months !== undefined) {
        const prefix = checkSaveName(a.prefix);
        if (a.every_months === 0) { s.stopAutoSave(); return { periodic: null, stopped: true }; }
        const first = await s.startAutoSave({ everyMonths: a.every_months, prefix });
        return { periodic: s.autoSaveStatus(), first_save: first };
      }
      if (a.name === undefined) return { periodic: s.autoSaveStatus() };
      return saveGame(s, checkSaveName(a.name));
    },
  },

  // ---- world (analysis; read-only) ---------------------------------------------
  {
    name: 'cargos', group: 'world', session: true,
    description: 'Cargo types in this game (ids, names, passenger/mail flags).',
    args: z.object({}),
    run: async (ctx) => { const rows = [...(await ctx.session()).cargos.values()]; return listResult('cargos', rows, rows); },
  },
  {
    name: 'industry-types', group: 'world', session: true,
    description: 'Industry types with produced and accepted cargo ids.',
    args: z.object({}),
    run: async (ctx) => { const rows = [...(await ctx.session()).types.values()]; return listResult('industry_types', rows, rows); },
  },
  {
    name: 'towns', group: 'world', session: true,
    description: 'Towns with population and last-month passenger/mail production and transported %. Filter by min_population, name, id, near_x/near_y within radius (each row then has distance); sorted by population (by distance with near_x/near_y).',
    args: z.object({ min_population: int().default(0), limit: int().default(50), name: z.string().optional(), id: int().optional(),
      near_x: int().optional(), near_y: int().optional(), radius: int().min(1).default(50) }),
    run: async (ctx, a) => {
      if ((a.near_x === undefined) !== (a.near_y === undefined)) throw new Error('give both --near_x and --near_y');
      const { towns } = await (await ctx.session()).economy();
      const near = a.near_x !== undefined ? { x: a.near_x, y: a.near_y } : null;
      const hits = towns.filter((t) => t.population >= a.min_population && (!a.name || t.name.toLowerCase().includes(a.name.toLowerCase())) && (a.id === undefined || t.id === a.id))
        .map((t) => (near ? { ...t, distance: manhattan(t, near) } : t)).filter((t) => !near || t.distance <= a.radius)
        .sort((x, y) => (near ? x.distance - y.distance : y.population - x.population));
      return listResult('towns', towns, hits, a.limit);
    },
  },
  {
    name: 'industries', group: 'world', session: true,
    description: 'Industries with location, last-month production per cargo and % transported ("unexploited" = low %). Filter by id, type name / cargo name substring, max_transported_pct, min_production, near x,y within radius. Secondary (processing) industries are marked secondary: true and kept by min_production: they produce only after deliveries, so last_month 0 is normal.',
    args: z.object({
      type: z.string().optional(), cargo: z.string().optional(), max_transported_pct: int().default(100),
      min_production: int().default(0), near_x: int().optional(), near_y: int().optional(), radius: int().optional(), limit: int().default(50),
      id: int().optional().describe('one industry by id'),
    }),
    run: async (ctx, a) => {
      const { industries } = await (await ctx.session()).economy();
      const lc = (s) => String(s).toLowerCase();
      const hits = industries.filter((i) => (a.id === undefined || i.id === a.id) && (!a.type || lc(i.type_name).includes(lc(a.type)))
        && (a.near_x === undefined || manhattan(i, { x: a.near_x, y: a.near_y }) <= (a.radius ?? 50))
        && (!a.cargo && a.max_transported_pct >= 100 && a.min_production <= 0
          ? true
          : i.produces.some((p) => (!a.cargo || cargoMatches(p.cargo_name, a.cargo)) && p.transported_pct <= a.max_transported_pct && (i.secondary || p.last_month >= a.min_production))));
      return listResult('industries', industries, hits, a.limit);
    },
  },
  {
    name: 'find-cargo-pairs', group: 'world', session: true,
    description: `Opportunity finder: under-served producers of a cargo paired with destinations min_distance..max_distance tiles away: industries that accept it, and towns whose centre area accepts it (acceptance >= ${ACCEPTED} within radius 4; goods, passengers, mail, food...). Ranked by terrain effort of the route (water, hills, towns, existing track). Each dest has kind industry|town. Passengers and mail pair town with town (source kind town, source_last_month = the town's last-month production); feed both names to build-cargo-route --from_town --to_town. Secondary producers (sawmill, factory, refinery...) are marked secondary: true; they show last_month 0 until supplied. Distance defaults to ${PAIR_MIN_DIST}..${PAIR_MAX_DIST} tiles (distance_bounds says which applied); --near_x/--near_y/--radius keeps sources near a tile (e.g. your network). Example: cargo=goods, dest_kind=town, min_distance=20.`,
    args: z.object({
      cargo: z.string().optional(), source_type: z.string().optional(), dest_type: z.string().optional().describe("industry type name, or 'town' / a town name"),
      dest_kind: z.enum(['any', 'industry', 'town']).default('any'),
      min_distance: int().optional().describe(`default ${PAIR_MIN_DIST}`), max_distance: int().optional().describe(`default ${PAIR_MAX_DIST} (a train route of 900 tiles takes years per trip)`), max_transported_pct: int().default(100),
      near_x: int().optional(), near_y: int().optional(), radius: int().min(1).default(60).describe('with near_x/near_y: sources within this many tiles'),
      min_production: int().default(0).describe('primary sources only; secondary ones are kept'), limit: int().default(10), with_effort: bool().default(true),
    }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const { industries, towns } = await s.economy();
      if (a.with_effort) await s.ensureTiles();
      let townAcceptance = new Map();
      if (a.dest_kind !== 'industry' && towns.length) {
        const lists = await acceptanceAt(s, towns.map((t) => [t.x, t.y]), { radius: 4 });
        townAcceptance = lists && new Map(towns.map((t, i) => [t.id, Object.fromEntries(lists[i].map((c) => [c.cargo, c.acceptance]))]));
      }
      const townCargoFallback = new Set([...s.cargos.values()].filter((c) => c.town_effect > 0).map((c) => c.id));
      if ((a.near_x === undefined) !== (a.near_y === undefined)) throw new Error('give both --near_x and --near_y');
      const minDist = a.min_distance ?? PAIR_MIN_DIST, maxDist = a.max_distance ?? PAIR_MAX_DIST;
      const res = findCargoPairs({ industries, types: s.types, towns, cargos: s.cargos, townAcceptance, townCargoFallback, map: s.map, cargo: a.cargo, sourceType: a.source_type,
        destType: a.dest_type, destKind: a.dest_kind, minDist, maxDist, maxTransportedPct: a.max_transported_pct,
        minProduction: a.min_production, limit: a.limit, withEffort: a.with_effort, near: a.near_x !== undefined ? { x: a.near_x, y: a.near_y, radius: a.radius } : null });
      return { distance_bounds: { min: minDist, max: maxDist, ...(a.min_distance === undefined || a.max_distance === undefined ? { defaulted: 'pass --min_distance / --max_distance to change' } : {}) },
        ...(a.near_x !== undefined ? { near: { x: a.near_x, y: a.near_y, radius: a.radius } } : {}), ...res };
    },
  },
  {
    name: 'acceptance', group: 'world', session: true,
    description: `Which cargos a station at x,y would accept: per-cargo acceptance summed over the catchment (radius; rail stations 4, truck/bus stops 3). ${ACCEPTED} or more = accepted. width/height = station size in tiles. cargo (name) checks one cargo. Needs AgentBridge v7.`,
    args: z.object({ ...point, radius: int().min(0).max(10).default(4), width: int().min(1).max(20).default(1), height: int().min(1).max(20).default(1),
      cargo: z.string().optional() }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const cargo = cargoId(s.cargos, a.cargo);
      const lists = await acceptanceAt(s, [[a.x, a.y]], { w: a.width, h: a.height, radius: a.radius, ...(cargo !== undefined ? { cargos: [cargo] } : {}) });
      if (!lists) throw new Error(OLD_GS);
      let list = lists[0];
      if (cargo !== undefined && !list.length) {
        const c = s.cargos.get(cargo);
        list = [{ cargo, label: c?.label ?? null, name: c?.name ?? `cargo ${cargo}`, acceptance: 0, accepted: false }];
      }
      return { x: a.x, y: a.y, width: a.width, height: a.height, radius: a.radius, accepted_at: ACCEPTED, cargo: list };
    },
  },
  {
    name: 'town-gaps', group: 'world', session: true,
    description: 'Towns ranked by passengers produced last month that nobody transported (unexploited passenger base).',
    args: z.object({ min_population: int().default(500), max_transported_pct: int().default(100), limit: int().default(15) }),
    run: async (ctx, a) => {
      const { towns } = await (await ctx.session()).economy();
      const hits = townGaps(towns, { minPopulation: a.min_population, maxTransportedPct: a.max_transported_pct, limit: Infinity });
      return listResult('towns', towns, hits, a.limit);
    },
  },
  {
    name: 'route-effort', group: 'world', session: true,
    description: 'Estimate construction effort between two tiles: least-effort path over the terrain mirror with counts of water/town/rail/road tiles crossed and height change. Lower effort_per_tile = easier.',
    args: z.object({ x1: int(), y1: int(), x2: int(), y2: int(), margin: int().default(24) }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      await s.ensureTiles();
      return { ...routeEffort(s.map, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { margin: a.margin }), cost_model: DEFAULT_COSTS };
    },
  },
  {
    name: 'airport-types', group: 'world', session: true,
    description: 'Airport types available now with size, price, maintenance and catchment radius.',
    args: z.object({}),
    run: async (ctx) => { const rows = await (await ctx.session()).gs.call('airport_types'); return listResult('airport_types', rows, rows); },
  },
  {
    name: 'airport-sites', group: 'world', session: true,
    description: 'Find places to build an airport near a town: flat buildable rectangles of the airport size within radius, each checked for town noise limit and (with your company) a dry-run build with cost. With your company (AgentBridge v10), your owned land counts as buildable and each site has owned: true when its whole footprint is your owned land; those sites come first.',
    args: z.object({
      town: z.string().describe('town name (substring)'), airport: z.string().default('small').describe('airport type name, see airport-types'),
      radius: int().default(20), max_height_spread: int().default(0), limit: int().default(5),
    }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const [{ towns }, types] = await Promise.all([s.economy(), s.gs.call('airport_types'), s.ensureTiles()]);
      const town = towns.find((t) => t.name.toLowerCase().includes(a.town.toLowerCase()));
      if (!town) throw new Error(`no town matching '${a.town}'`);
      const at = types.find((t) => t.name === a.airport.toLowerCase());
      if (!at) throw new Error(`unknown airport '${a.airport}'. Available: ${types.map((t) => t.name).join(', ')}`);
      const company = s.cfg.company;
      const hasCompany = company !== null && company !== undefined;
      // Own owned land counts as buildable (airports clear it); company from the config, so the relay binds it.
      const pad = Math.max(at.width, at.height);
      const box = { x0: town.x - a.radius, y0: town.y - a.radius, x1: town.x + a.radius + pad, y1: town.y + a.radius + pad };
      const owned = hasCompany ? await ownedLandAt(s, company, ownedLandCandidates(s.map, box)) : null;
      const sites = findFlatSites(s.map, { cx: town.x, cy: town.y, width: at.width, height: at.height, radius: a.radius, maxHeightSpread: a.max_height_spread, limit: a.limit * 3, owned });
      const checked = [];
      for (const site of sites) {
        const chk = await s.gs.call('check_airport', { x: site.x, y: site.y, type: at.type, ...(hasCompany ? { company } : {}) });
        checked.push({ ...site, ...chk, noise_ok: chk.noise_increase <= chk.town_allowed_noise });
        if (checked.filter((c) => c.noise_ok && c.buildable !== false).length >= a.limit) break;
      }
      return { town: { name: town.name, x: town.x, y: town.y, population: town.population, pax_unserved: town.pax_unserved, allowed_noise: town.allowed_noise },
        airport: at, sites: checked };
    },
  },
  {
    name: 'tiles', group: 'world', session: true,
    description: 'Raw terrain mirror for a small rectangle: height, slope and class per tile (water, clear, trees, other=houses/objects, rail, road, station, industry...), and (AgentBridge v12) who owns it: "*" = your company, "#" = another company (rail rows in an area are not necessarily yours). Max 40x40.',
    args: z.object({ ...who, x0: int(), y0: int(), x1: int(), y1: int(), refresh: bool().default(true) }),
    run: async (ctx, a) => {
      if ((a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1) > 1600) throw new Error('area too large; max 40x40 tiles');
      const s = await ctx.session();
      const me = a.company ?? s.cfg.company;
      if (a.refresh) await s.refreshArea(a.x0, a.y0, a.x1, a.y1); else await s.ensureTiles();
      let owners = null;
      try { owners = new Map((await s.gs.call('tile_owners', { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 })).map(([x, y, o]) => [`${x},${y}`, o])); } catch (e) { if (!/unknown cmd/.test(e.message)) throw e; }
      const mark = (x, y) => { const o = owners?.get(`${x},${y}`); return o === undefined ? '' : o === me ? '*' : '#'; };
      const rows = [];
      for (let y = a.y0; y <= a.y1; y++) {
        const r = [];
        for (let x = a.x0; x <= a.x1; x++) r.push(`${s.map.classAt(x, y)}${s.map.heightAt(x, y)}${s.map.slopeAt(x, y) ? '/' : ''}${mark(x, y)}`);
        rows.push({ y, tiles: r.join(' ') });
      }
      return { legend: `class letter + height, "/" = sloped${owners ? ', "*" = owned by your company, "#" = by another company' : ''}. w water c coast i industry s station r rail d road t trees f farm k rocks h rough b clear o other(houses/objects)`,
        ...(owners ? {} : { owners: 'not shown: the running AgentBridge is older than v12' }), x0: a.x0, rows };
    },
  },

  {
    name: 'rail-tiles', group: 'world', session: true,
    description: 'Exact rail on a small rectangle (max 32x32), one row per tile with rail: kind (track, station, waypoint, depot, crossing, bridge, tunnel), track pieces (x = along x, y = along y, n/s/e/w = the corner pieces), signals (facing trains that come from which side: from_sw/from_se/from_ne/from_nw, one_way true for one-way path signals), depot front, bridge/tunnel other end, station id, rail type and owner (mine true/false). --mine true keeps only your tiles. AgentBridge v9.',
    args: z.object({ ...who, x0: int(), y0: int(), x1: int(), y1: int(), mine: bool().optional().describe('true: only your tiles; false: only other companies\' tiles') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      if ((a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1) > 1024) throw new Error('area too large; max 32x32 tiles');
      let rows;
      try { rows = await s.gs.call('rail_tiles', { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 }); } catch (e) {
        if (/unknown cmd/.test(e.message)) throw new Error('refused: rail-tiles needs AgentBridge v9; the host re-runs install-gamescript and loads the game again');
        throw e;
      }
      const tiles = rows.map(railTileFromRow).map((t) => describeRailTile(t, company)).filter((t) => a.mine === undefined || t.mine === a.mine);
      return { company, ...listResult('tiles', tiles, tiles, 1024) };
    },
  },

  {
    name: 'build-hq', group: 'build', session: true,
    description: 'Build (or move) your company headquarters: 2x2 tiles with x,y the north corner, on flat clear land. Building it again elsewhere moves it (the old one goes). dry_run=true = cost only. AgentBridge v12.',
    args: z.object({ ...act, ...point }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      await needV12(s, 'build-hq');
      const res = await run(ctx, a, [['hq', a.x, a.y]]);
      if (a.dry_run || !res.ok) return res;
      const me = (await s.gs.call('companies')).find((c) => c.id === company);
      const hq = me && me.hq >= 0 ? { x: me.hq % s.map.sizeX, y: Math.floor(me.hq / s.map.sizeX) } : null;
      await s.refreshArea(a.x - 1, a.y - 1, a.x + 2, a.y + 2);
      return { ...res, hq };
    },
  },
  {
    name: 'sign', group: 'build', session: true,
    description: 'Put a sign on the map as your company (free, visible to everyone in the game; use it to mark planned plots and lines instead of placing track). Text up to 31 characters. The sign id is in `sign`. AgentBridge v12.',
    args: z.object({ ...act, ...point, text: z.string().min(1).max(31) }),
    run: async (ctx, a) => {
      const { s } = await mine(ctx, a);
      await needV12(s, 'sign');
      const res = await run(ctx, a, [['sign', a.x, a.y, a.text]]);
      return { ...res, ...(res.ok && !a.dry_run ? { sign: res.results[0].value } : {}) };
    },
  },
  {
    name: 'sign-remove', group: 'build', session: true,
    description: 'Remove your company\'s signs: --ids A,B, or --x/--y (every sign of yours on that tile), or --text (signs whose text contains it). AgentBridge v12.',
    args: z.object({ ...act, ids: ids().optional(), x: int().optional(), y: int().optional(), text: z.string().optional() }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      await needV12(s, 'sign-remove');
      const mineSigns = (await s.gs.call('signs', { company })).map(([id, x, y, owner, text]) => ({ id, x, y, owner, text }));
      let pick;
      if (a.ids) pick = a.ids;
      else if (a.x !== undefined && a.y !== undefined) pick = mineSigns.filter((g) => g.x === a.x && g.y === a.y).map((g) => g.id);
      else if (a.text) pick = mineSigns.filter((g) => lc(g.text).includes(lc(a.text))).map((g) => g.id);
      else throw new Error('give --ids A,B, or --x and --y, or --text');
      if (!pick.length) return { ok: false, error: 'not_found: no sign of yours matches; run: openttd-agent signs', first_error: 'not_found', removed: [] };
      const res = await run(ctx, a, pick.map((id) => ['sign_remove', id]), { keepGoing: true });
      return { ...res, removed: res.results.filter((r) => r.ok).map((r) => pick[r.step]) };
    },
  },
  {
    name: 'signs', group: 'world', session: true,
    description: 'Your company\'s signs: id, x, y, text. Filter with --text. AgentBridge v12.',
    args: z.object({ ...who, text: z.string().optional(), limit: int().default(200) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      await needV12(s, 'signs');
      const all = (await s.gs.call('signs', { company })).map(([id, x, y, , text]) => ({ id, x, y, text }));
      return listResult('signs', all, all.filter((g) => !a.text || lc(g.text).includes(lc(a.text))), a.limit);
    },
  },

  // ---- build (as your company; rate limited) ------------------------------------
  {
    name: 'test-build-road', group: 'build', session: true,
    description: 'Dry run: can your company build a straight road from (x1,y1) to (x2,y2), and what would it cost? Builds nothing.',
    args: z.object({ x1: int(), y1: int(), x2: int(), y2: int(), company: int().optional() }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      return s.gs.call('test_build_road', { ...a, company: s.companyOrThrow(a.company) });
    },
  },
  {
    name: 'build-road', group: 'build', session: true,
    description: 'Build a straight road from (x1,y1) to (x2,y2) as your company. dry_run=true = cost only (same as test-build-road). road_type (see road-types) builds that road or tram type instead. Subject to client and GameScript rate limits.',
    args: z.object({ ...act, x1: int(), y1: int(), x2: int(), y2: int(), road_type: int().optional().describe('road type id from road-types (trams: a tram type); default plain road') }),
    run: async (ctx, { dry_run, ...a }) => {
      if (a.road_type !== undefined) return run(ctx, { ...a, dry_run }, [['road', a.x1, a.y1, a.x2, a.y2]], { roadType: a.road_type });
      const s = await ctx.session();
      const args = { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, company: s.companyOrThrow(a.company) };
      if (dry_run) return { ...(await s.gs.call('test_build_road', args)), dry_run: true };
      s.throttleBuild();
      return { ...(await s.gs.call('build_road', args)), dry_run: false };
    },
  },

  // ---- operate (read) -------------------------------------------------------------
  {
    name: 'stations', group: 'operate', session: true,
    description: 'Your stations: location, facilities (rail/truck/bus/airport/dock), per-cargo waiting amount and rating %, vehicles serving (count, and vehicle_ids with AgentBridge v12: vehicles with an order for it). Filter with facility, cargo (name), min_waiting, max_rating_pct (e.g. find poorly served stations). --company X shows another company\'s stations as the game window shows them to anyone (location, facilities, waiting cargo, ratings; no vehicle counts); also through the relay. Returns {total, matched, stations, truncated}.',
    args: z.object({ ...who, facility: z.enum(FACILITIES).optional(), cargo: z.string().optional(), min_waiting: int().default(0),
      max_rating_pct: int().default(100), name: z.string().optional(), limit: int().default(100) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const cargoFilter = a.cargo !== undefined || a.min_waiting > 0 || a.max_rating_pct < 100;
      const rival = isRival(s, company);
      let all = stationsFromRows(await s.gs.call('stations', { company }), s.cargos).map((st) => (rival ? (({ vehicles, ...rest }) => rest)(st) : st));
      if (!rival) {
        const ids = await stationVehicleIds(s, company);
        if (ids) all = all.map((st) => ({ ...st, vehicle_ids: ids.get(st.id) ?? [] }));
      }
      const hits = all.filter((st) => (!a.facility || st.facilities.includes(a.facility)) && (!a.name || lc(st.name).includes(lc(a.name)))
        && (!cargoFilter || st.cargo.some((c) => (!a.cargo || cargoMatches(c.name, a.cargo)) && c.waiting >= a.min_waiting && c.rating_pct <= a.max_rating_pct)));
      return { company, ...(rival ? { view: 'other company: what the game shows anyone' } : {}), ...listResult('stations', all, hits, a.limit) };
    },
  },
  {
    name: 'vehicles', group: 'operate', session: true,
    description: 'Your vehicles (summary=true or another --company: counts per type and state only, as the company window shows anyone): type, engine, age (days and % of max age), reliability, profit this/last year, value, running cost, state, location, group, order count. Filters: type, group, state, max_profit_last_year (e.g. 0 = loss makers), min_age_pct (e.g. 90 = due for replacement), max_reliability_pct, name, station (vehicles with an order for it; AgentBridge v12). Breakdown counts and service intervals are not exposed by the game to scripts.',
    args: z.object({ ...who, type: z.enum(VEHICLE_TYPES).optional(), group: int().optional(), state: z.enum(VEHICLE_STATES).optional(),
      max_profit_last_year: int().optional(), min_age_pct: int().default(0), max_reliability_pct: int().default(100), name: z.string().optional(), limit: int().min(1).default(1000),
      station: z.coerce.string().optional().describe('only vehicles with an order for this station (id or name; AgentBridge v12)'),
      summary: bool().default(false).describe('counts per type and state only (always so for another company)') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const all = vehiclesFromRows(await s.gs.call('vehicles', { company }));
      if (a.summary || isRival(s, company)) {
        const count = (key) => all.reduce((m, v) => ({ ...m, [v[key]]: (m[v[key]] ?? 0) + 1 }), {});
        return { company, ...(isRival(s, company) ? { view: 'other company: counts only, as the company window shows them' } : {}), total: all.length, by_type: count('type'),
          ...(isRival(s, company) ? {} : { by_state: count('state') }) };
      }
      let atStation = null;
      if (a.station !== undefined) {
        const st = findStation(stationsFromRows(await s.gs.call('stations', { company }), s.cargos), a.station);
        const ids = await stationVehicleIds(s, company, st.id);
        if (!ids) throw new Error('refused: vehicles --station needs AgentBridge v12; the host re-runs install-gamescript and loads the game again');
        atStation = new Set(ids.get(st.id) ?? []);
      }
      const vehicles = all.filter((v) => (!atStation || atStation.has(v.id)) && (!a.type || v.type === a.type) && (a.group === undefined || v.group === a.group) && (!a.state || v.state === a.state)
        && (a.max_profit_last_year === undefined || v.profit_last_year <= a.max_profit_last_year) && v.age_pct >= a.min_age_pct
        && v.reliability_pct <= a.max_reliability_pct && (!a.name || lc(v.name).includes(lc(a.name))));
      return { company, ...listResult('vehicles', all, vehicles, a.limit) };
    },
  },
  {
    name: 'vehicle', group: 'operate', session: true,
    description: 'One vehicle in detail: status, capacity and load per cargo, wagons, and the full order list with decoded flags.',
    args: z.object({ ...who, vehicle: int() }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      return vehicleDetail(await s.gs.call('vehicle', { company, vehicle: a.vehicle }), s.cargos);
    },
  },
  {
    name: 'summary', group: 'operate', session: true,
    description: 'One compact text line per vehicle and per station, for a quick look without big JSON: vehicles "#unit id N name [type] profit this/last yr, age (years, % of max), reliability, state, (x,y) -> destination"; stations "id name [facilities] N veh: cargo waiting rating%". Pick with --group G, --vehicles A,B, --stations A,B (ids or names) or --what vehicles|stations; with none, all your vehicles and stations. Sorted: vehicles by profit last year (worst first), stations by lowest rating.',
    args: z.object({ ...who, group: int().optional(), vehicles: ids().optional(), stations: z.string().optional().describe('comma-separated station ids or names'),
      what: z.enum(['all', 'vehicles', 'stations']).default('all'), limit: int().min(1).default(200) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
      const names = new Map(stations.map((st) => [st.id, st.name]));
      const picked = a.group !== undefined || a.vehicles || a.stations;
      const wantV = a.what !== 'stations' && (!picked || a.group !== undefined || a.vehicles);
      const wantS = a.what !== 'vehicles' && (!picked || a.stations);
      const out = { company };
      if (wantV) {
        const all = vehiclesFromRows(await s.gs.call('vehicles', { company }));
        const hit = all.filter((v) => (a.group === undefined || v.group === a.group) && (!a.vehicles || a.vehicles.includes(v.id))).sort((p, q) => p.profit_last_year - q.profit_last_year);
        const lines = hit.map((v) => vehicleLine(v, names));
        Object.assign(out, { vehicles_total: hit.length, vehicles: lines.slice(0, a.limit),
          vehicles_profit: `this year ${hit.reduce((n, v) => n + v.profit_this_year, 0)}, last year ${hit.reduce((n, v) => n + v.profit_last_year, 0)}` });
      }
      if (wantS) {
        const sel = a.stations ? a.stations.split(',').map((t) => findStation(stations, t.trim())) : stations;
        const minRating = (st) => Math.min(101, ...st.cargo.map((c) => c.rating_pct));
        const lines = [...sel].sort((p, q) => minRating(p) - minRating(q)).map(stationLine);
        Object.assign(out, { stations_total: sel.length, stations: lines.slice(0, a.limit) });
      }
      out.truncated = (out.vehicles_total ?? 0) > a.limit || (out.stations_total ?? 0) > a.limit;
      return out;
    },
  },
  {
    name: 'vehicle-problems', group: 'operate', session: true,
    description: 'Vehicles with problems, one row per problem: problem, severity (action = it cannot earn until fixed; info = worth knowing, leave a running train alone), evidence, suggested_fix, plus id and unit_number (the "Train #4" the game window shows). Checks: wrong_network / unreachable_destination (no rail path, or for road vehicles no road path (AgentBridge v11), to the current order\'s station), stuck_or_lost (same order for stuck_days game days without getting closer; needs two calls that many days apart, the daemon keeps the history), stalled_on_line (speed 0 on the same tile for stall_days, not at a station or broken down; the daemon samples every 15 s once vehicle-problems has run), deadlock (two such trains within 16 tiles: reverse one with vehicle-reverse), no_income (lost money last year at age > 1 year), no_orders, stopped_in_depot (with how long it has been parked), loose_wagons (wagons without a locomotive in a depot), stopped, old, broken_down, low_reliability, crashed. Every row has as_of (game date of this sample) and days_watched (how long the history behind it is); --fresh true starts the history again. Run it every turn. The game does not tell scripts when a vehicle is lost; this infers it.',
    args: z.object({ ...who, vehicle: int().optional().describe('check only this vehicle id'),
      stuck_days: int().min(1).default(30).describe('game days without progress before a vehicle counts as stuck or lost'),
      stall_days: int().min(1).default(10).describe('game days standing still on one tile (speed 0, not at a station) before stalled_on_line / deadlock'),
      trace: bool().default(true).describe('check rail (and, AgentBridge v11, road) connectivity to each vehicle\'s destination'),
      severity: z.enum(['all', 'action', 'info']).default('all').describe('action = only problems that need a command'),
      fresh: bool().default(false).describe('forget the history kept for your vehicles first and judge on this sample only (after a fix, so old samples do not report it again)') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const info = await s.gs.call('info');
      let vehicles = vehiclesFromRows(await s.gs.call('vehicles', { company }));
      if (a.vehicle !== undefined) {
        vehicles = vehicles.filter((v) => v.id === a.vehicle);
        if (!vehicles.length) throw new Error(`vehicle ${a.vehicle} does not exist or is not owned by company ${company}; run: openttd-agent vehicles`);
      }
      const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
      const stationById = new Map(stations.map((st) => [st.id, st]));
      s.vehicleHistory ??= new Map();
      s.stallHistory ??= new Map();
      s.depotHistory ??= new Map();
      if (a.fresh) for (const h of [s.vehicleHistory, s.stallHistory, s.depotHistory]) for (const k of [...h.keys()]) if (k.startsWith(`${company}:`)) h.delete(k);
      for (const v of vehicles) {
        const k = `${company}:${v.id}`;
        if (v.state !== 'in_depot') s.depotHistory.delete(k); else if (!s.depotHistory.has(k)) s.depotHistory.set(k, info.date);
      }
      const stalls = new Map(vehicles.map((v) => [v.id, recordStall(s.stallHistory, `${company}:${v.id}`, { date: info.date, x: v.x, y: v.y, speed: v.speed, state: v.state })]));
      const longStalled = vehicles.filter((v) => { const e = stalls.get(v.id); return e && info.date - e.since >= a.stall_days && e.samples >= 2; });
      const partners = deadlockPartners(longStalled);
      s.watchVehicles?.(company);
      const railTracer = a.trace ? await makeTracer(s, company, info) : null;
      const roadTracer = a.trace && vehicles.some((v) => v.type === 'road') ? makeRoadTracer(s, company, info) : null;
      const tracer = railTracer;
      const lineCache = new Map();
      const rows = [];
      for (const v of vehicles) {
        let orders = null;
        if (v.current_order === undefined && v.order_count > 0) { // AgentBridge before v9: one `vehicle` call each
          const cur = await currentOrderOf(s, company, v.id);
          orders = cur.orders;
          Object.assign(v, { current_order: cur.current_order, dest: cur.dest, dest_station: cur.dest_station, speed: cur.speed });
        }
        if (v.order_count === 0) Object.assign(v, { current_order: -1, dest: null, dest_station: -1 });
        const st = stationById.get(v.dest_station);
        v.dest_name = st?.name;
        v.dist = v.dest ? tileDistance(v, v.dest) : null;
        const progress = v.order_count > 0
          ? recordProgress(s.vehicleHistory, `${company}:${v.id}`, { date: info.date, order: v.current_order, dist: v.dist, atStation: v.state === 'at_station' })
          : null;
        let reach = null, line = null;
        const vt = v.type === 'rail' ? railTracer : v.type === 'road' ? roadTracer : null;
        if (vt && st && v.state !== 'in_depot' && v.state !== 'crashed') {
          const tracer = vt;
          reach = await tracer.trace([{ x: v.x, y: v.y }], st);
          if (!reach.connected) {
            orders ??= (await currentOrderOf(s, company, v.id)).orders;
            const ids = [...new Set(orders.filter((o) => o.kind === 'station').map((o) => o.station))];
            if (ids.length >= 2 && ids.every((id) => stationById.has(id))) {
              const lk = `${v.type}:${ids.join('>')}`;
              if (!lineCache.has(lk)) {
                let ok = true;
                for (let i = 0; i < ids.length && ok; i++) {
                  const from = stationById.get(ids[i]), to = stationById.get(ids[(i + 1) % ids.length]);
                  ok = (await tracer.trace(await tracer.stationStarts(from), to)).connected;
                }
                lineCache.set(lk, { connected: ok });
              }
              line = lineCache.get(lk);
            }
          }
        }
        for (const p of vehicleProblems(v, { today: info.date, stuckDays: a.stuck_days, progress, reach, line, stall: stalls.get(v.id), stallDays: a.stall_days, partners: partners.get(v.id), parkedDays: s.depotHistory.has(`${company}:${v.id}`) ? info.date - s.depotHistory.get(`${company}:${v.id}`) : null })) {
          const seen = [s.vehicleHistory.get(`${company}:${v.id}`)?.first, s.stallHistory.get(`${company}:${v.id}`)?.since, s.depotHistory.get(`${company}:${v.id}`)].filter((d) => d !== undefined);
          if (a.severity === 'all' || a.severity === p.severity) rows.push({ id: v.id, unit_number: v.unit_number, name: v.name, type: v.type, ...p, as_of: gameDate(info), days_watched: seen.length ? info.date - Math.min(...seen) : 0 });
        }
      }
      const samples = vehicles.map((v) => s.vehicleHistory.get(`${company}:${v.id}`)).filter(Boolean);
      const watched = samples.length ? info.date - Math.min(...samples.map((e) => e.first)) : 0;
      return {
        date: gameDate(info), checked: vehicles.length, vehicles_with_problems: new Set(rows.map((r) => r.id)).size,
        vehicles_needing_action: new Set(rows.filter((r) => r.severity === 'action').map((r) => r.id)).size,
        trace_method: tracer?.method ?? 'off', ...(tracer?.method === 'mirror_adjacency' ? { trace_note: OLD_GS_TRACE } : {}),
        ...(a.trace && vehicles.some((v) => v.type === 'road') ? { road_trace: roadTracer ? 'road_tiles' : `off: ${OLD_GS_ROAD}` } : {}),
        history: { days_watched: watched, stuck_check: watched >= a.stuck_days ? 'active' : `needs another call in ${a.stuck_days - watched} game days` },
        problems: rows,
      };
    },
  },
  {
    name: 'verify-route', group: 'operate', session: true,
    description: 'Is there a rail or road path? --vehicle ID traces from the vehicle to each of its order stations and between consecutive order stations (rail for trains, road for road vehicles); --from_station A --to_station B (id or name) traces A to B (mode auto: rail when both have rail, road when both have truck or bus stops). Reports connected and, if not, the last reachable tile and the first gap with a reason. Rail (AgentBridge v9; coarse map-mirror trace before): no_track, track_not_joined, station_platform_side, depot_entrance_faces_away, one_way_signal_against, other_company_track, bridge_side, tunnel_side. Road (AgentBridge v11; refused before): no_road, road_not_joined, one_way_road, depot_not_joined, depot_entrance_faces_away, stop_not_joined, stop_entrance_faces_away, other_owner_road (another company\'s stop or depot).',
    args: z.object({ ...who, vehicle: int().optional(), from_station: z.coerce.string().optional().describe('station id or name'), to_station: z.coerce.string().optional().describe('station id or name'),
      mode: z.enum(['auto', 'rail', 'road']).default('auto').describe('station pair only: which network to trace') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
      const info = await s.gs.call('info');
      const brief = (r) => ({ connected: r.connected, ...(r.connected ? {} : { last_reachable: r.last_reachable ?? null, first_gap: r.first_gap ?? null }), tiles_reached: r.tiles_reached });
      const pick = async (mode) => {
        if (mode === 'road') {
          const t = makeRoadTracer(s, company, info);
          if (!t) throw new Error(`refused: ${OLD_GS_ROAD}`);
          return t;
        }
        return makeTracer(s, company, info);
      };
      if (a.vehicle !== undefined) {
        const veh = vehiclesFromRows(await s.gs.call('vehicles', { company })).find((v) => v.id === a.vehicle);
        if (!veh) throw new Error(`vehicle ${a.vehicle} does not exist or is not owned by company ${company}; run: openttd-agent vehicles`);
        if (veh.type !== 'rail' && veh.type !== 'road') throw new Error(`refused: vehicle ${a.vehicle} is a ${veh.type === 'air' ? 'aircraft' : 'ship'}; verify-route traces rail and road only`);
        const tracer = await pick(veh.type);
        const legs = await routeLegs(s, company, tracer, stations, veh);
        return { vehicle: veh.id, unit_number: veh.unit_number, type: veh.type, at: { x: veh.x, y: veh.y }, connected: legs.connected, method: tracer.method,
          ...(tracer.method === 'mirror_adjacency' ? { note: OLD_GS_TRACE } : {}), from_vehicle: legs.from_vehicle, legs: legs.legs };
      }
      if (a.from_station === undefined || a.to_station === undefined) throw new Error('give --vehicle ID, or both --from_station and --to_station (id or name)');
      const from = findStation(stations, a.from_station), to = findStation(stations, a.to_station);
      const roadish = (st) => st.facilities.includes('truck') || st.facilities.includes('bus');
      const mode = a.mode !== 'auto' ? a.mode : (from.facilities.includes('rail') && to.facilities.includes('rail')) || !(roadish(from) && roadish(to)) ? 'rail' : 'road';
      const tracer = await pick(mode);
      const r = await tracer.trace(await tracer.stationStarts(from), to);
      return { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, mode, method: tracer.method, ...(tracer.method === 'mirror_adjacency' ? { note: OLD_GS_TRACE } : {}), ...brief(r) };
    },
  },
  {
    name: 'engines', group: 'operate', session: true,
    description: 'Engines/wagons/vehicles your company can buy now: price, capacity, max speed, reliability, running cost per year, lifespan, design year, power. type defaults to rail; cargo (name) keeps wagons/vehicles refittable to it and locomotives that can pull it; rail_type keeps trains for that track (see rail-types). Newest design first: compare with your fleet to decide replacements.',
    args: z.object({ ...who, type: z.enum(VEHICLE_TYPES).default('rail'), cargo: z.string().optional(), rail_type: int().optional(), wagons: bool().optional().describe('rail only: true = wagons only, false = locomotives only'), limit: int().default(60),
      road_type: int().optional().describe('road only: vehicles for this road type (see road-types; trams have tram types)') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const cargo = cargoId(s.cargos, a.cargo);
      const rows = await s.gs.call('engines', { company, type: vehicleTypeId(a.type), ...(cargo !== undefined ? { cargo } : {}), ...(a.rail_type !== undefined ? { rail_type: a.rail_type } : {}) });
      const all = enginesFromRows(rows, s.cargos);
      const hits = all.filter((e) => (a.wagons === undefined || e.is_wagon === a.wagons) && (a.road_type === undefined || e.track_type === a.road_type)).sort((x, y) => y.design_year - x.design_year);
      return listResult('engines', all, hits, a.limit);
    },
  },
  {
    name: 'groups', group: 'operate', session: true,
    description: 'Your vehicle groups with vehicle count and profit this/last year. Use one group per strategy to account for it.',
    args: z.object({ ...who }),
    run: async (ctx, a) => { const { s, company } = await mine(ctx, a); const rows = groupsFromRows(await s.gs.call('groups', { company })); return listResult('groups', rows, rows); },
  },
  {
    name: 'depots', group: 'operate', session: true,
    description: 'Your depots (or hangars) of one type with the number of vehicles inside and, for rail and road depots (AgentBridge v12), front (the tile vehicles leave onto) and exit_dir (sw/se/ne/nw). Vehicles are bought and cloned at a depot tile.',
    args: z.object({ ...who, type: z.enum(VEHICLE_TYPES).default('rail') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const rows = (await s.gs.call('depots', { company, type: vehicleTypeId(a.type) })).map(([x, y, vehicles, fx, fy]) => {
        const d = fx === undefined || fx < 0 ? -1 : TRACE_DIRS.findIndex(([dx, dy]) => x + dx === fx && y + dy === fy);
        return { x, y, vehicles, ...(d >= 0 ? { front: { x: fx, y: fy }, exit_dir: DIR_NAMES[d] } : {}) };
      });
      return { type: a.type, ...listResult('depots', rows, rows) };
    },
  },
  {
    name: 'events', group: 'operate', session: true,
    description: 'Game events since sequence number `since` (keep latest_seq and pass it next time): vehicle_crashed, subsidy_offer/awarded/expired, industry_open/close, company_new/in_trouble/bankrupt/merger, station_first_vehicle, town_founded, exclusive_transport_rights, road_reconstruction. The game does not send scripts vehicle-lost/unprofitable or production-change events: poll `vehicles` and `industries` for those. The buffer holds the last 300 events and restarts when the game is loaded.',
    args: z.object({ since: int().default(0), type: z.string().optional().describe('substring of the event type') }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const events = await s.gs.call('events', { since: a.since });
      return { latest_seq: events.length ? events.at(-1).seq : a.since, my_company: s.cfg.company,
        events: events.filter((e) => !a.type || e.type.includes(lc(a.type))) };
    },
  },

  // ---- operate (change; rate limited like builds) ----------------------------------
  {
    name: 'group-create', group: 'operate', session: true,
    description: 'Create a vehicle group for one vehicle type; returns its id in `group`.',
    args: z.object({ ...act, type: z.enum(VEHICLE_TYPES), name: z.string().default(''), parent: int().default(-1) }),
    run: async (ctx, a) => {
      const res = await run(ctx, a, [['group_create', vehicleTypeId(a.type), a.name, a.parent]]);
      return { ...res, group: res.results[0]?.value ?? null };
    },
  },
  {
    name: 'group-rename', group: 'operate', session: true,
    description: 'Rename a vehicle group.',
    args: z.object({ ...act, group: int(), name: z.string().min(1) }),
    run: (ctx, a) => run(ctx, a, [['group_rename', a.group, a.name]]),
  },
  {
    name: 'group-delete', group: 'operate', session: true,
    description: 'Delete a vehicle group (its vehicles go back to the default group).',
    args: z.object({ ...act, group: int() }),
    run: (ctx, a) => run(ctx, a, [['group_delete', a.group]]),
  },
  {
    name: 'group-move', group: 'operate', session: true,
    description: 'Move vehicles (comma-separated ids) into a group; group -1 = back to the default group.',
    args: z.object({ ...act, group: int(), vehicles: ids() }),
    run: (ctx, a) => run(ctx, a, a.vehicles.map((v) => ['group_move', a.group, v]), { keepGoing: true }),
  },
  {
    name: 'group-autoreplace', group: 'operate', session: true,
    description: 'Autoreplace old_engine with new_engine (ids from `engines`) for a group; group -1 = all vehicles. Omit new_engine to stop replacing old_engine. Vehicles are replaced when they next visit a depot.',
    args: z.object({ ...act, group: int().default(-1), old_engine: int(), new_engine: int().default(-1) }),
    run: (ctx, a) => run(ctx, a, [['autoreplace', a.group, a.old_engine, a.new_engine]]),
  },
  {
    name: 'autorenew', group: 'operate', session: true,
    description: 'Show or set company autorenew: enabled, months (renew this many months before/after max age; negative = before), money (minimum bank balance needed). No arguments = show.',
    args: z.object({ ...who, enabled: bool().optional(), months: int().optional(), money: int().optional() }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      if (a.enabled === undefined && a.months === undefined && a.money === undefined) return s.gs.call('autorenew', { company });
      s.throttleBuild();
      const res = await s.exec(company, [['autorenew', a.enabled ?? null, a.months ?? null, a.money ?? null]]);
      return { ...res, autorenew: await s.gs.call('autorenew', { company }) };
    },
  },
  {
    name: 'loan', group: 'operate', session: true,
    description: 'Show or change your company loan. Give one of: amount (set the loan to this), borrow (add this much), repay (pay back this much; needs the cash), max true (borrow up to max_loan). The new loan is rounded up to the loan interval; refused below 0 or over max_loan. No arguments = show. Returns loan, max_loan and money before and after (dry_run: predicted). Needs AgentBridge v8.',
    args: z.object({ ...act, amount: int().optional().describe('set the loan to this amount'), borrow: int().min(1).optional().describe('add this much to the loan'),
      repay: int().min(1).optional().describe('pay back this much of the loan'), max: bool().optional().describe('true = borrow up to max_loan') }),
    run: async (ctx, a) => {
      const given = ['amount', 'borrow', 'repay', 'max'].filter((k) => a[k] !== undefined && a[k] !== false);
      if (given.length > 1) throw new Error(`loan takes one of --amount, --borrow, --repay, --max; got ${given.map((k) => `--${k}`).join(', ')}. Nothing was run.`);
      const { s, company } = await mine(ctx, a);
      const before = await loanState(s, company);
      if (!given.length) return before;
      const step = a.max ? ['loan', 'max', 0] : a.amount !== undefined ? ['loan', 'set', a.amount] : ['loan', 'add', a.borrow ?? -a.repay];
      const requested = a.max ? before.max_loan : a.amount ?? before.loan + (a.borrow ?? -a.repay);
      if (!a.dry_run) s.throttleBuild();
      const res = await s.exec(company, [step], { dryRun: a.dry_run });
      const r = res.results[0];
      if (r?.error?.startsWith('unknown exec op')) throw new Error(OLD_GS_LOAN);
      if (!res.ok) return { ok: false, dry_run: a.dry_run, error: r?.error ?? res.stopped ?? 'failed', requested_loan: requested, before, after: before };
      const target = r.value ?? 0; // execSummary drops a 0 value
      const after = a.dry_run ? { loan: target, max_loan: before.max_loan, money: before.money + target - before.loan } : await loanState(s, company);
      return { ok: true, dry_run: a.dry_run, requested_loan: requested, ...(target !== requested ? { rounded_to: target, note: 'rounded up to a multiple of the loan interval' } : {}),
        change: target - before.loan, before, after };
    },
  },
  {
    name: 'order-add', group: 'operate', session: true,
    description: `Add an order to a vehicle: destination is a station id (see stations) or a tile x,y (station tile, depot tile or waypoint). Appends unless position is given (insert before that position). flags, comma-separated: ${ORDER_FLAG_HELP}. Example: --vehicle 12 --station 3 --flags full_load_any,non_stop`,
    args: z.object({ ...act, vehicle: int(), station: int().optional(), x: int().optional(), y: int().optional(), flags: z.string().default(''), position: int().default(-1) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      let { x, y } = a;
      if (a.station !== undefined) {
        const st = stationsFromRows(await s.gs.call('stations', { company }), s.cargos).find((t) => t.id === a.station);
        if (!st) throw new Error(`station ${a.station} is not one of company ${company}'s stations. Run: openttd-agent stations`);
        ({ x, y } = st);
      }
      if (x === undefined || y === undefined) throw new Error('give a destination: --station <id> or --x <tile x> --y <tile y>');
      const depot = /service_if_needed|stop_in_depot/.test(a.flags);
      return run(ctx, a, [['order_add', a.vehicle, x, y, encodeOrderFlags(a.flags, { depot }), a.position]]);
    },
  },
  {
    name: 'order-remove', group: 'operate', session: true,
    description: 'Remove the order at a position (0-based, see `vehicle`).',
    args: z.object({ ...act, vehicle: int(), position: int().min(0) }),
    run: (ctx, a) => run(ctx, a, [['order_remove', a.vehicle, a.position]]),
  },
  {
    name: 'order-flags', group: 'operate', session: true,
    description: `Replace the flags of an existing order. flags, comma-separated: ${ORDER_FLAG_HELP}. Empty = plain order.`,
    args: z.object({ ...act, vehicle: int(), position: int().min(0), flags: z.string().default('') }),
    run: (ctx, a) => run(ctx, a, [['order_flags', a.vehicle, a.position, encodeOrderFlags(a.flags, { depot: /service_if_needed|stop_in_depot/.test(a.flags) })]]),
  },
  {
    name: 'order-skip', group: 'operate', session: true,
    description: 'Make a vehicle head for the order at this position now.',
    args: z.object({ ...act, vehicle: int(), position: int().min(0) }),
    run: (ctx, a) => run(ctx, a, [['order_skip', a.vehicle, a.position]]),
  },
  {
    name: 'orders-copy', group: 'operate', session: true,
    description: 'Give vehicles (comma-separated ids) the orders of vehicle `from`. share=true (default) shares the list, so later edits apply to all; share=false copies it.',
    args: z.object({ ...act, vehicles: ids(), from: int(), share: bool().default(true) }),
    run: (ctx, a) => run(ctx, a, a.vehicles.map((v) => ['orders_copy', v, a.from, a.share]), { keepGoing: true }),
  },
  {
    name: 'vehicle-buy', group: 'operate', session: true,
    description: 'Buy `count` vehicles of an engine id (see engines) at your depot tile (see depots). cargo (name) refits on purchase. For trains buy the locomotive first, then wagons with attach_to=<train id>; the train must be stopped in that depot (checked first, also in a dry run; a wagon the game will not couple is sold back). New ids are in `vehicles`. Vehicles start stopped in the depot: add orders, then vehicle-start. route_of=<train id>: refuse unless the depot is rail-connected to that train\'s order stations (use it before copying that train\'s orders onto the new one). One call for a whole train: --wagon W --wagons N attaches N wagons of engine W to each new locomotive (refitted to cargo); --orders A,B (station ids or names) gives the new vehicles those orders (the first gets them, the others share them; with attach_to, the train attach_to gets them), --order_flags sets flags per order separated by ";" (e.g. "full_load_any;unload,no_load"; one set applies to every order), --start true starts them.',
    args: z.object({ ...act, depot_x: int(), depot_y: int(), engine: int(), cargo: z.string().optional(), attach_to: int().default(-1), count: int().min(1).max(50).default(1),
      route_of: int().optional().describe('rail: check the depot is joined to this vehicle\'s order stations first'),
      wagon: int().optional().describe('wagon engine id to attach to each new locomotive'), wagons: int().min(0).max(60).default(0),
      orders: z.string().optional().describe('comma-separated station ids or names, in order'), order_flags: z.string().default('').describe('flags per order separated by ";", or one set for all'),
      start: bool().default(false) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const cargo = cargoId(s.cargos, a.cargo) ?? -1;
      if (a.wagons > 0 && a.wagon === undefined) throw new Error('give --wagon ENGINE_ID with --wagons N (see engines --wagons true)');
      const plan = a.orders ? orderPlan(stationsFromRows(await s.gs.call('stations', { company }), s.cargos), a.orders, a.order_flags) : null;
      const check = a.route_of !== undefined ? await depotForRoute(s, company, { ...a, check_route: true }, a.route_of, { cmd: 'vehicle-buy' }) : null;
      if (a.attach_to >= 0) {
        const why = await attachRefusal(s, company, a);
        if (why) return { ok: false, dry_run: a.dry_run, error: why, first_error: 'train_not_in_depot', vehicles: [], cost: 0, results: [] };
      }
      const res = await run(ctx, a, Array.from({ length: a.count }, () => ['veh_buy', a.depot_x, a.depot_y, a.engine, cargo, a.attach_to]));
      // A wagon the game sold us but would not couple: sell it back at once (it is stopped in the depot).
      const stray = res.results.filter((r) => !r.ok && r.value && /^bought vehicle \d+ but could not attach/.test(r.error ?? '')).map((r) => r.value);
      let soldBack = null;
      if (stray.length && !a.dry_run) {
        const sale = await s.exec(company, stray.map((v) => ['veh_sell', v]), { keepGoing: true });
        soldBack = { vehicles: stray, ok: sale.ok, income: -sale.cost, ...(sale.ok ? {} : { error: sale.error }) };
      }
      const bought = res.results.filter((r) => r.ok && r.value !== undefined).map((r) => r.value);
      let setup = null;
      if (res.ok && !a.dry_run && (plan || a.start || a.wagons > 0)) {
        const heads = a.attach_to >= 0 ? [a.attach_to] : bought;
        const steps = [];
        if (a.attach_to < 0) for (const v of heads) for (let i = 0; i < a.wagons; i++) steps.push(['veh_buy', a.depot_x, a.depot_y, a.wagon, cargo, v]);
        if (plan && heads.length) {
          for (const o of plan) steps.push(['order_add', heads[0], o.x, o.y, o.flags, -1]);
          for (const v of heads.slice(1)) steps.push(['orders_copy', v, heads[0], true]);
        }
        if (a.start) for (const v of heads) steps.push(['veh_start_stop', v, 1]);
        setup = await s.exec(company, steps);
        Object.assign(res, { cost: res.cost + setup.cost, ok: setup.ok, error: setup.ok ? res.error : `bought ${bought.join(', ')}; then: ${setup.error} (the vehicles are stopped in the depot)`, ...(setup.ok ? {} : { first_error: setup.first_error }) });
      }
      return { ...res, vehicles: bought, ...(check ? { route_check: check.route_check } : {}),
        ...(plan ? { orders: plan.map((o) => ({ station: o.station, name: o.name, flags: o.flag_names })) } : {}), ...(setup ? { setup: { ok: setup.ok, steps: setup.steps_total ?? setup.results?.length } , started: a.start && setup.ok } : {}),
        ...(soldBack ? { sold_back: soldBack, error: `${res.error}; ${soldBack.ok ? `sold the wagon${stray.length > 1 ? 's' : ''} back (${stray.join(', ')})` : `selling ${stray.join(', ')} back failed too: sell ${stray.length > 1 ? 'them' : 'it'} with vehicle-sell`}` } : {}) };
    },
  },
  {
    name: 'vehicle-clone', group: 'operate', session: true,
    description: 'Clone a vehicle `count` times, sharing its orders by default; start=true starts the clones. New ids are in `vehicles`. Depot: --depot auto (or no depot) picks your depot nearest the vehicle\'s first order station that is rail-connected to all its order stations; --depot_x/--depot_y is refused for a train when that depot is not rail-connected to its order stations (a clone there would get lost). check_route=false skips the check.',
    args: z.object({ ...act, depot: z.enum(['auto']).optional().describe('auto = pick a depot on the vehicle\'s own route'),
      depot_x: int().optional(), depot_y: int().optional(), vehicle: int(), share_orders: bool().default(true), count: int().min(1).max(50).default(1), start: bool().default(false),
      check_route: bool().default(true).describe('rail: refuse a depot not joined to the vehicle\'s order stations') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const { depot, ...check } = await depotForRoute(s, company, a, a.vehicle, { cmd: 'vehicle-clone' });
      const res = await run(ctx, a, Array.from({ length: a.count }, () => ['veh_clone', depot.x, depot.y, a.vehicle, a.share_orders]));
      const vehicles = res.results.filter((r) => r.ok && r.value !== undefined).map((r) => r.value);
      const out = { ...res, depot, ...check, vehicles };
      if (!a.start || a.dry_run || !vehicles.length) return out;
      const started = await s.exec(company, vehicles.map((v) => ['veh_start_stop', v, 1]), { keepGoing: true });
      return { ...out, started: started.ok };
    },
  },
  {
    name: 'vehicle-replace', group: 'operate', session: true,
    description: 'Replace vehicles (comma-separated ids) in one call: buy the replacement at a depot on the vehicle\'s own route (--depot auto, the default, or --depot_x/--depot_y), share the old vehicle\'s orders, start it; the old vehicle gets its own copy of the orders, loads nothing more at its next unloading stop (no_load) and gets a "stop in depot" order right after it (--when unloaded, the default; --when now sends it to a depot at once), and is sold when it stops there. The daemon (or relay) checks every 20 s and sells it; --finish true sells any that have arrived now and lists the rest (pending_sales). Without --engine the replacement is a clone (same engine and wagons). --engine N buys that engine instead; for trains also --wagons N (default: as many as the old train) of --wagon ID (default: the old train\'s wagon type; AgentBridge v12) refitted to the old cargo. For age-based replacement of whole fleets, group-autoreplace or autorenew is cheaper in calls.',
    args: z.object({ ...act, vehicles: ids().optional(), engine: int().optional(), wagon: int().optional(), wagons: int().min(0).max(60).optional(),
      depot: z.enum(['auto']).optional(), depot_x: int().optional(), depot_y: int().optional(),
      when: z.enum(['unloaded', 'now']).default('unloaded').describe('when the old vehicle heads for the depot'),
      finish: bool().default(false).describe('only sell replaced vehicles that have stopped in a depot; no new replacements') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      if (a.finish) return { ...(await s.finishSales()), pending_sales: [...s.pendingSales.values()].filter((p) => p.company === company) };
      if (!a.vehicles) throw new Error('give --vehicles A,B (or --finish true)');
      const v12 = ((await s.gs.call('info')).bridge_version ?? 0) >= 12;
      const replaced = [];
      for (const id of a.vehicles) replaced.push(await replaceOne(s, company, a, id, v12));
      if (!a.dry_run) s.watchSales();
      const bad = replaced.filter((r) => !r.ok);
      return { ok: !bad.length, dry_run: a.dry_run, error: bad.length ? bad.map((r) => `vehicle ${r.vehicle}: ${r.error}`).join('; ') : null,
        ...(bad.length ? { first_error: bad[0].first_error ?? errorCode(bad[0].error) } : {}),
        cost: replaced.reduce((n, r) => n + (r.cost ?? 0), 0), replaced, pending_sales: [...s.pendingSales.values()].filter((p) => p.company === company) };
    },
  },
  {
    name: 'vehicle-reverse', group: 'operate', session: true,
    description: 'Turn trains or road vehicles (comma-separated ids) round so they drive the other way (the game\'s "reverse" button). Frees a deadlock: when vehicle-problems reports deadlock, reverse one of the two trains. Road vehicles must be moving and outside a depot. AgentBridge v12.',
    args: z.object({ ...act, vehicles: ids() }),
    run: async (ctx, a) => {
      const { s } = await mine(ctx, a);
      if (((await s.gs.call('info')).bridge_version ?? 0) < 12) throw new Error('refused: vehicle-reverse needs AgentBridge v12 (the running GameScript is older); the host re-runs install-gamescript and loads the game again. Meanwhile vehicle-depot also turns a train round');
      const res = await run(ctx, a, a.vehicles.map((v) => ['veh_reverse', v]), { keepGoing: true });
      return { ...res, reversed: res.results.filter((r) => r.ok).map((r) => a.vehicles[r.step]), failed: res.results.filter((r) => !r.ok).map((r) => ({ vehicle: a.vehicles[r.step], error: r.error ?? 'failed' })) };
    },
  },
  {
    name: 'vehicle-start', group: 'operate', session: true,
    description: 'Start vehicles (comma-separated ids). Already running ones are left alone.',
    args: z.object({ ...act, vehicles: ids() }),
    run: (ctx, a) => run(ctx, a, a.vehicles.map((v) => ['veh_start_stop', v, 1]), { keepGoing: true }),
  },
  {
    name: 'vehicle-stop', group: 'operate', session: true,
    description: 'Stop vehicles (comma-separated ids).',
    args: z.object({ ...act, vehicles: ids() }),
    run: (ctx, a) => run(ctx, a, a.vehicles.map((v) => ['veh_start_stop', v, 0]), { keepGoing: true }),
  },
  {
    name: 'vehicle-depot', group: 'operate', session: true,
    description: 'Send vehicles (comma-separated ids) to a depot: they stop there (needed before vehicle-sell). service=true = service only and carry on. Safe to repeat: vehicles already heading to a depot are left alone (already_heading; sending again would cancel their depot order in OpenTTD) and ones already stopped in a depot are reported (already_in_depot). Failures say why (failed[].error: not_found, broken_down, loading_full_load, no_depot). AgentBridge v11; older ones only skip vehicles already in a depot.',
    args: z.object({ ...act, vehicles: ids(), service: bool().default(false) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const v11 = ((await s.gs.call('info')).bridge_version ?? 0) >= 11;
      let send = a.vehicles;
      const inDepot = [];
      if (!v11) {
        const rows = vehiclesFromRows(await s.gs.call('vehicles', { company }));
        const parked = new Set(rows.filter((v) => v.state === 'in_depot').map((v) => v.id));
        inDepot.push(...send.filter((v) => parked.has(v)));
        send = send.filter((v) => !parked.has(v));
      }
      const res = send.length ? await run(ctx, a, send.map((v) => ['veh_depot', v, a.service]), { keepGoing: true })
        : { ok: true, error: null, dry_run: a.dry_run, steps_total: 0, steps_done: 0, cost: 0, results: [] };
      const by = (code) => res.results.filter((r) => r.ok && (v11 ? (r.value ?? 0) === code : code === 1)).map((r) => send[r.step]);
      return { ...res, sent: by(1), already_heading: by(2), already_in_depot: [...inDepot, ...by(3)],
        failed: res.results.filter((r) => !r.ok).map((r) => ({ vehicle: send[r.step], error: r.error ?? 'failed' })),
        ...(v11 ? {} : { note: 'the running AgentBridge is older than v11: a vehicle already heading to a depot cannot be detected, and sending it again cancels its depot order' }) };
    },
  },
  {
    name: 'vehicle-sell', group: 'operate', session: true,
    description: 'Sell vehicles (comma-separated ids). Each must be stopped inside a depot (vehicle-depot, then check `vehicles --state in_depot`). The negative cost is the sale income.',
    args: z.object({ ...act, vehicles: ids() }),
    run: (ctx, a) => run(ctx, a, a.vehicles.map((v) => ['veh_sell', v]), { keepGoing: true }),
  },
  {
    name: 'vehicle-refit', group: 'operate', session: true,
    description: 'Refit a vehicle stopped in a depot to a cargo (name).',
    args: z.object({ ...act, vehicle: int(), cargo: z.string() }),
    run: async (ctx, a) => { const { s } = await mine(ctx, a); return run(ctx, a, [['veh_refit', a.vehicle, cargoId(s.cargos, a.cargo)]]); },
  },
  {
    name: 'vehicle-rename', group: 'operate', session: true,
    description: 'Rename a vehicle.',
    args: z.object({ ...act, vehicle: int(), name: z.string().min(1) }),
    run: (ctx, a) => run(ctx, a, [['veh_rename', a.vehicle, a.name]]),
  },

  // ---- build: rail -------------------------------------------------------------------
  {
    name: 'rail-types', group: 'build', session: true,
    description: 'Rail types your company can build: id, name, max speed (0 = unlimited), track cost per tile. Pass the id as rail_type.',
    args: z.object({ ...who }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const rows = (await s.gs.call('rail_types', { company })).map(([id, name, max_speed, track_cost]) => ({ id, name, max_speed, track_cost }));
      return listResult('rail_types', rows, rows);
    },
  },
  {
    name: 'road-types', group: 'build', session: true,
    description: 'Road and tram types: id, name, tram (true = tram track), max speed (0 = unlimited), build cost per piece, available (your company can build it now). Pass the id as --road_type to build-road, build-road-path, build-road-station, build-road-depot, and to engines --type road to find trams. AgentBridge v12.',
    args: z.object({ ...who }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      await needV12(s, 'road-types');
      const rows = (await s.gs.call('road_types', { company })).map(([id, name, tram, max_speed, build_cost, available]) => ({ id, name, tram, max_speed, build_cost, available }));
      return listResult('road_types', rows, rows);
    },
  },
  {
    name: 'bridge-types', group: 'build', session: true,
    description: 'Bridge types that can span `length` tiles (both ends included): id, name, max speed, price.',
    args: z.object({ length: int().min(2), type: z.enum(['rail', 'road']).default('rail') }),
    run: async (ctx, a) => {
      const rows = (await (await ctx.session()).gs.call('bridge_types', { length: a.length, vehicle_type: transport(a.type) }))
        .map(([id, name, max_speed, price, min_length, max_length]) => ({ id, name, max_speed, price, min_length, max_length }));
      return listResult('bridge_types', rows, rows);
    },
  },
  {
    name: 'build-rail', group: 'build', session: true,
    description: 'Plan and build a rail line between two anchor tiles. Anchors are where the line connects (a station end tile, the tile in front of a depot, existing track, or connect_at from build-terminus): track is laid on every tile strictly between them. The planner prefers flat and straight, avoids houses, industries and stations, crosses roads on the level and bridges water, rail and roads where it must. Use dry_run=true first for the cost; each step reports ok/error. On failure nothing after the failed step is built: fix (terraform, demolish, other anchors) and run again; already-built track is kept.',
    args: z.object({ ...pathArgs, rail_type: int().optional().describe('see rail-types; default: first available') }),
    run: (ctx, a) => buildPath(ctx, a, 'rail'),
  },
  {
    name: 'build-rail-station', group: 'build', session: true,
    description: 'Build a rail station with its lowest-x/y corner at x,y. axis=x: platforms run along x and are stacked along y (axis=y: the reverse). Trains enter at either end of a platform.',
    args: z.object({ ...act, ...point, axis: z.enum(['x', 'y']).default('x'), platforms: int().min(1).max(20).default(1), length: int().min(1).max(20).default(4), ...join, rail_type: int().optional() }),
    run: (ctx, a) => run(ctx, a, [['rail_station', a.x, a.y, a.axis === 'y', a.platforms, a.length, joinArg(a.join)]], { railType: a.rail_type }),
  },
  {
    name: 'build-rail-depot', group: 'build', session: true,
    description: 'Build a rail depot at x,y with its entrance facing front (a tile next to it that has or will get track). Connect it with build-rail using the front tile as an anchor. The result has exit_dir and (AgentBridge v9) front_joined: whether track on the front tile reaches the entrance, and front_leads (the ways a train leaving the depot can go from there); a warning when nothing joins it yet or when trains can leave in one direction only (every new train then runs that way first, e.g. to the far end of the line to turn).',
    args: z.object({ ...act, ...point, ...front, rail_type: int().optional() }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const res = await run(ctx, a, [['rail_depot', a.x, a.y, a.front_x, a.front_y]], { railType: a.rail_type });
      const dir = TRACE_DIRS.findIndex(([dx, dy]) => a.x + dx === a.front_x && a.y + dy === a.front_y);
      const out = { ...res, exit_dir: DIR_NAMES[dir] ?? null };
      if (dir < 0 || !res.ok) return out;
      let t = null;
      try { t = (await s.gs.call('rail_tiles', { x0: a.front_x, y0: a.front_y, x1: a.front_x, y1: a.front_y }))[0]; } catch { return out; }
      const front = t ? railTileFromRow(t) : null;
      const { warning, ...joined } = depotFrontCheck(front, dir, company);
      Object.assign(out, joined, warning ? { warnings: [warning] } : {});
      return out;
    },
  },
  {
    name: 'build-line-depot', group: 'build', session: true,
    description: 'Find a spot beside a straight piece of your existing rail line near a station (or a tile), build a rail depot there and join it to the line both ways, in one call. Use this instead of choosing a depot spot by hand. dry_run=true checks the depot only. Returns depot {x,y} for vehicle-buy --depot_x --depot_y. Example: --station 4',
    args: z.object({ ...act, station: int().optional().describe('one of your stations (see stations): search near it'), x: int().optional(), y: int().optional(),
      radius: int().min(3).max(30).default(12), rail_type: int().optional() }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      let near;
      if (a.station !== undefined) {
        const st = stationsFromRows(await s.gs.call('stations', { company }), s.cargos).find((t) => t.id === a.station);
        if (!st) throw new Error(`station ${a.station} is not one of company ${company}'s stations. Run: openttd-agent stations`);
        near = [st.x, st.y];
      } else if (a.x !== undefined && a.y !== undefined) near = [a.x, a.y];
      else throw new Error('give --station, or --x and --y');
      await s.ensureTiles();
      await s.refreshArea(Math.max(0, near[0] - a.radius - 1), Math.max(0, near[1] - a.radius - 1), near[0] + a.radius + 1, near[1] + a.radius + 1);
      return lineDepot(s, company, near, { radius: a.radius, railType: a.rail_type, dryRun: a.dry_run });
    },
  },
  {
    name: 'build-cargo-route', group: 'build', session: true,
    description: 'Composite: a whole rail route in one call. Terminus at each end (station-sites logic, each facing the other end), rail between their connect_at anchors, a depot beside the line near the source, one train (cheapest-to-run locomotive that can pull the cargo unless --engine; wagons that carry it, --wagons default fills the platform), orders (full_load_any at the source, unload,no_load at the destination; passengers/mail between two towns: plain orders both ways), started. dry_run=true checks every placement and the rail path and returns estimated_cost without building. A town end with no room is retried automatically with a wider search, a shorter platform and one platform (source_fallback / dest_fallback say what worked). warnings[] lists your stations within 8 tiles of a new terminus (near_own_station, tiles). Refused (failed_step existing_route) when your rail stations near both ends are already served by one of your vehicles: clone that train instead, or --allow_existing true. Stations nobody serves (e.g. after selling the fleet) do not block it. A failure stops at that step and reports failed_step and everything already built (nothing is demolished). Example: --from_industry 6 --to_industry 9 --cargo iron --dry_run true',
    args: z.object({
      ...act,
      from_industry: int().optional().describe('source industry id (see industries / find-cargo-pairs)'), from_town: z.string().optional().describe('source town id or name'),
      to_industry: int().optional(), to_town: z.string().optional(),
      cargo: z.string().describe('cargo name or label (see cargos)'),
      engine: int().optional().describe('locomotive engine id (see engines --type rail --cargo <c>)'), wagon: int().optional().describe('wagon engine id'),
      wagons: int().min(1).max(60).optional().describe('default: fill the platform length (2 per tile, minus the locomotive)'),
      platforms: int().min(1).max(4).default(2), length: int().min(2).max(10).default(4),
      radius: int().min(2).max(20).default(8).describe('station search box around each end'),
      margin: int().min(2).max(80).default(20).describe('how far the line may wander outside the two stations'),
      max_bridge: int().min(3).max(40).default(12), rail_type: int().optional().describe('see rail-types; default: the one with the cheapest track'),
      allow_existing: bool().default(false).describe('build even when one of your vehicles already serves your stations at both ends (refused by default: clone trains instead)'),
    }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      if ((a.from_industry !== undefined) === (a.from_town !== undefined)) throw new Error('give exactly one of --from_industry, --from_town');
      if ((a.to_industry !== undefined) === (a.to_town !== undefined)) throw new Error('give exactly one of --to_industry, --to_town');
      return buildCargoRoute(s, company, a);
    },
  },
  {
    name: 'build-track', group: 'build', session: true,
    description: 'Lay (or with remove=true, remove) one rail piece on tile x,y joining its neighbour from_x,from_y to its neighbour to_x,to_y. Existing track on the tile is kept, so this makes junctions: e.g. connect a depot or a branch onto an existing line. Neighbours may be straight across (straight piece) or at right angles (curve).',
    args: z.object({ ...act, ...point, from_x: int(), from_y: int(), to_x: int(), to_y: int(), remove: bool().default(false), rail_type: int().optional() }),
    run: (ctx, a) => run(ctx, a, [[a.remove ? 'rail_remove' : 'rail', a.from_x, a.from_y, a.x, a.y, a.to_x, a.to_y]], { railType: a.rail_type }),
  },
  {
    name: 'build-signal', group: 'build', session: true,
    description: 'Build a signal on the track tile x,y facing trains that come from the neighbouring tile `front`. type: path (default; trains may pass it from behind), path_oneway, block, entry, exit, combo. two_way applies to block/entry/exit/combo. remove=true removes it (refused with no_signal_here when there is none facing that way). The track must exist; in a template\'s dry run, signals on track it lays show skipped_in_dry_run.',
    args: z.object({ ...act, ...point, ...front, type: z.enum(Object.keys(SIGNAL_TYPES)).default('path'), two_way: bool().default(false), remove: bool().default(false) }),
    run: async (ctx, a) => {
      if (a.remove) {
        const { s } = await mine(ctx, a);
        const why = await signalRemoveRefusal(s, a);
        if (why) return { ok: false, dry_run: a.dry_run, error: why, first_error: why.split(':')[0], steps_done: 0, results: [] };
        return run(ctx, a, [['signal_remove', a.x, a.y, a.front_x, a.front_y]]);
      }
      return run(ctx, a, [['signal', a.x, a.y, a.front_x, a.front_y, SIGNAL_TYPES[a.type] + (a.two_way && SIGNAL_TYPES[a.type] < 4 ? 8 : 0)]]);
    },
  },
  {
    name: 'station-sites', group: 'build', session: true,
    description: 'Find where a rail terminus (build-terminus) fits next to an industry, a town or a tile: flat buildable land, station within reach of the target (industries: 3 tiles), points facing toward the other end of your planned line. Each site is dry-run checked as your company and returned with its cost and connect_at, ready for build-terminus and then build-rail. Use this instead of reading tiles by hand. Example: --industry 0 --toward_industry 1',
    args: z.object({
      ...who,
      industry: int().optional().describe('industry id (see industries)'), town: z.string().optional().describe('town id or name: station near the centre'),
      x: int().optional(), y: int().optional(),
      toward_industry: int().optional().describe('industry at the other end of the line: points face it'), toward_town: z.string().optional(),
      toward_x: int().optional(), toward_y: int().optional(),
      platforms: int().min(1).max(4).default(2), length: int().min(2).max(10).default(4),
      radius: int().min(2).max(20).default(8).describe('search box around the target'), limit: int().min(1).max(10).default(3),
    }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const toward = a.toward_industry !== undefined ? { industry: a.toward_industry } : a.toward_town !== undefined ? { town: a.toward_town }
        : a.toward_x !== undefined && a.toward_y !== undefined ? { x: a.toward_x, y: a.toward_y } : null;
      return stationSites(s, company, { industry: a.industry, town: a.town, x: a.x, y: a.y }, toward, a);
    },
  },
  {
    name: 'build-terminus', group: 'build', session: true,
    description: 'Template: terminus station (platforms x length, lowest corner at x,y, platforms along axis) with points joining all platforms to one track and a path signal at every platform exit. exit=high puts the points at the high-coordinate end. Needs flat land: the station plus platforms+2 tiles beyond the exit end. Returns connect_at {x,y,dir}: continue with build-rail --x1 <x> --y1 <y> --start_dir <dir>. In a dry run the signal steps show skipped_in_dry_run (the track is not there yet) and do not count against ok.',
    args: z.object({ ...act, ...point, axis: z.enum(['x', 'y']).default('x'), platforms: int().min(1).max(8).default(2), length: int().min(1).max(20).default(5),
      exit: z.enum(['high', 'low']).default('high'), ...join, rail_type: int().optional() }),
    run: async (ctx, a) => {
      const t = terminusSteps({ x: a.x, y: a.y, axis: a.axis, platforms: a.platforms, length: a.length, exitHigh: a.exit === 'high', join: joinArg(a.join) });
      return { ...(await run(ctx, a, t.steps, { railType: a.rail_type })), connect_at: t.connect_at };
    },
  },
  {
    name: 'build-passing-loop', group: 'build', session: true,
    description: 'Template: passing loop for a single-track line. The main track runs length+2 tiles from x,y in direction dir (sw=+x, se=+y, ne=-x, nw=-y); a second track is laid beside it (side=1 or -1) with one-way path signals: trains heading dir use the main track, the others the loop. Both sides have length-1 clear tiles between the points and the exit signal (fits trains up to length-2 tiles). Give --train_tiles N or --for_vehicle ID (the longest train on that vehicle\'s line is used): length then defaults to train+2, and a loop with fewer than train+1 clear tiles is refused (loop_too_short). Checked first (AgentBridge v9): every main-line tile must be straight track along dir, or free land (not_straight_at / blocked_at / signal_at {x,y}); loop tiles must be free (loop_side_occupied_at). After a real build: loop_check (both directions through the loop) and, with --for_vehicle, route_after (connected|broken with first_gap). remove=true with the same x,y,dir,length,side takes the loop track and both signals (including the one on the main track) out again; the main track stays.',
    args: z.object({ ...act, ...point, dir: z.enum(DIR_NAMES).default('sw').describe('sw=+x, se=+y, ne=-x, nw=-y'), length: int().min(2).max(30).optional().describe('default: train tiles + 2, else 6'),
      side: int().default(1), rail_type: int().optional(),
      train_tiles: int().min(1).max(40).optional().describe('longest train that must wait in the loop, in tiles'),
      for_vehicle: int().optional().describe('a train of this line: its longest train sets train_tiles; also traces its route after the build'),
      remove: bool().default(false).describe('take out a loop built with the same arguments') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const info = await s.gs.call('info');
      const train = a.for_vehicle !== undefined ? await longestTrainOnLine(s, company, a.for_vehicle) : null;
      const trainTiles = a.train_tiles ?? train?.tiles ?? null;
      const length = a.length ?? (trainTiles ? trainTiles + 2 : 6);
      if (length > 30) return { ok: false, dry_run: a.dry_run, error: `loop_too_long: trains of ${trainTiles} tiles need length ${length}; the template allows 30`, first_error: 'loop_too_long' };
      const t = passingLoopSteps({ x: a.x, y: a.y, dir: dirIndex(a.dir), length, side: a.side < 0 ? -1 : 1 });
      const geometry = { length, clear_tiles: t.clear_tiles, fits_trains_up_to_tiles: t.clear_tiles - 1, ends: t.ends, ...(trainTiles ? { train_tiles: trainTiles } : {}), ...(train ? { longest_train: train } : {}) };
      if (a.remove) {
        const res = await run(ctx, a, passingLoopRemoveSteps(t), { keepGoing: true });
        if (!a.dry_run) await s.refreshArea(a.x - length - 3, a.y - length - 3, a.x + length + 3, a.y + length + 3);
        return { ...res, removed: !a.dry_run && res.ok, ...geometry };
      }
      if (trainTiles && t.clear_tiles < trainTiles + 1) {
        return { ok: false, dry_run: a.dry_run, error: `loop_too_short: length ${length} leaves ${t.clear_tiles} clear tiles per side; a ${trainTiles}-tile train needs ${trainTiles + 1}. Use --length ${trainTiles + 2} (or leave --length out)`, first_error: 'loop_too_short', ...geometry };
      }
      let siteCheck = 'skipped: the running AgentBridge is older than v9 (no rail_tiles)';
      if ((info.bridge_version ?? 0) >= 9) {
        const tiles = [...t.main, ...t.lane];
        const xs = tiles.map((p) => p[0]), ys = tiles.map((p) => p[1]);
        const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        await s.refreshArea(...box);
        const rows = await s.gs.call('rail_tiles', { x0: box[0], y0: box[1], x1: box[2], y1: box[3] });
        const rail = new Map(rows.map((r) => [`${r[0]},${r[1]}`, railTileFromRow(r)]));
        const problem = loopSiteProblem(t, (x, y) => rail.get(`${x},${y}`) ?? null, (x, y) => s.map.classAt(x, y));
        if (problem) {
          return { ok: false, dry_run: a.dry_run, error: `${problem.code}: (${problem.x},${problem.y}) ${problem.detail}. Nothing was built. A loop needs a straight, flat stretch of length+4 tiles of the line (no points, curves or signals) with free land beside it`,
            first_error: problem.code, at: { x: problem.x, y: problem.y }, ...geometry };
        }
        siteCheck = 'ok';
      }
      const res = await run(ctx, a, t.steps, { railType: a.rail_type });
      const out = { ...res, ...geometry, site_check: siteCheck };
      if (a.dry_run || !res.ok) return out;
      await s.refreshArea(a.x - length - 3, a.y - length - 3, a.x + length + 3, a.y + length + 3);
      const tracer = await makeTracer(s, company, await s.gs.call('info'));
      if (tracer.method === 'rail_tracks') {
        const [m0, m1] = [t.main[0], t.main.at(-1)];
        const through = async (from, to) => (await traceRail({ getTile: tracer.tileAt, starts: [{ x: from[0], y: from[1] }], isGoal: (q) => q.x === to[0] && q.y === to[1], goal: { x: to[0], y: to[1] }, company })).connected;
        out.loop_check = { [`heading_${a.dir}`]: await through(m0, m1), heading_back: await through(m1, m0) };
        out.loop_check.ok = out.loop_check[`heading_${a.dir}`] && out.loop_check.heading_back;
      }
      if (a.for_vehicle !== undefined) {
        const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
        const veh = await vehicleOf(s, company, a.for_vehicle);
        const legs = await routeLegs(s, company, tracer, stations, veh);
        const bad = [...legs.legs, ...legs.from_vehicle].find((r) => !r.connected);
        out.route_after = legs.connected ? { status: 'connected', method: tracer.method } : { status: 'broken', method: tracer.method, first_gap: bad?.first_gap ?? null, leg: bad?.from ? `${bad.from} -> ${bad.to}` : bad?.station_name ?? null };
        if (!legs.connected) { out.ok = false; out.error = `route_broken: the line of vehicle ${a.for_vehicle} is broken after the loop was built${bad?.first_gap ? ` (first gap at (${bad.first_gap.x},${bad.first_gap.y}): ${bad.first_gap.reason})` : ''}; undo with the same command and --remove true`; out.first_error = 'route_broken'; }
      } else {
        out.route_after = 'not_checked: give --for_vehicle ID to trace a train\'s route through the loop';
      }
      return out;
    },
  },

  {
    name: 'loop-sites', group: 'build', session: true,
    description: 'Where a passing loop fits on one of your lines: walks your own track from one station to the other (--vehicle ID: its first two order stations; or --from_station A --to_station B), finds straight plain stretches long enough for build-passing-loop (length + 4 tiles, no points, curves or signals), puts the loop in the middle of each, checks the lane beside it and dry-runs the best ones. Each site has x, y, dir, side, length, gap (straight tiles left between the loop and the nearest bend, points, signal or station on each side; min_gap_from_bend, default 8, ranks sites that keep that gap first), distance_from_station, position_pct along the line, cost and build (the command to run). length defaults to train_tiles + 2 (train_tiles: --train_tiles, else the longest train on --vehicle\'s line, else 4). Needs AgentBridge v9.',
    args: z.object({ ...who, vehicle: int().optional(), from_station: z.coerce.string().optional().describe('station id or name'), to_station: z.coerce.string().optional(),
      train_tiles: int().min(1).max(28).optional(), length: int().min(2).max(30).optional().describe('loop length; default train_tiles + 2'),
      min_gap_from_bend: int().min(0).default(8).describe('straight tiles wanted between the loop and a bend/points/station on each side'),
      limit: int().min(1).max(20).default(5).describe('sites returned (each is dry-run)') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const info = await s.gs.call('info');
      if ((info.bridge_version ?? 0) < 9) throw new Error(`refused: ${OLD_GS_TRACE}`);
      const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
      let from, to, train = null;
      if (a.vehicle !== undefined) {
        const stops = await orderStations(s, company, a.vehicle);
        if (stops.length < 2) throw new Error(`refused: vehicle ${a.vehicle} has fewer than two station orders; give --from_station and --to_station`);
        [from, to] = stops;
        if (a.train_tiles === undefined) train = await longestTrainOnLine(s, company, a.vehicle);
      } else {
        if (a.from_station === undefined || a.to_station === undefined) throw new Error('give --vehicle ID, or both --from_station and --to_station (id or name)');
        from = findStation(stations, a.from_station); to = findStation(stations, a.to_station);
      }
      const trainTiles = a.train_tiles ?? train?.tiles ?? 4;
      const length = a.length ?? Math.min(30, trainTiles + 2);
      await s.ensureTiles();
      const tracer = await makeTracer(s, company, info);
      const r = await tracer.trace(await tracer.stationStarts(from), to);
      if (!r.connected) return { ok: false, error: `not_connected: no rail path from ${from.name} to ${to.name}; run verify-route first`, first_error: 'not_connected', first_gap: r.first_gap ?? null };
      const rail = new Map();
      for (const p of r.path) {
        for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const t = await tracer.tileAt(p.x + dx, p.y + dy);
          if (t) rail.set(`${t.x},${t.y}`, t);
        }
      }
      const railAt = (x, y) => rail.get(`${x},${y}`) ?? null;
      const cands = loopSites(r.path, railAt, (x, y) => s.map.classAt(x, y), { length, minGap: a.min_gap_from_bend });
      const sites = [];
      for (const c of cands.filter((q) => !q.problem).slice(0, a.limit)) {
        const loop = passingLoopSteps({ x: c.x, y: c.y, dir: dirIndex(c.dir), length, side: c.side });
        const dry = await s.exec(company, loop.steps, { dryRun: true, railType: railAt(c.x, c.y)?.rail_type });
        const dist = Math.min(tileDistance(c, from), tileDistance(c, to));
        sites.push({ x: c.x, y: c.y, dir: c.dir, side: c.side, length, gap: c.gap, meets_min_gap: c.gap >= a.min_gap_from_bend, distance_from_station: dist,
          position_pct: Math.round((100 * c.path_index) / r.path.length), cost: dry.cost, buildable: dry.ok, ...(dry.ok ? {} : { dry_run_error: dry.error }),
          build: `build-passing-loop --x ${c.x} --y ${c.y} --dir ${c.dir} --side ${c.side} --length ${length}${a.vehicle !== undefined ? ` --for_vehicle ${a.vehicle}` : ` --train_tiles ${trainTiles}`}` });
      }
      sites.sort((p, q) => (q.buildable - p.buildable) || (q.meets_min_gap - p.meets_min_gap));
      const blocked = cands.filter((q) => q.problem);
      return { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, line_tiles: r.path.length, train_tiles: trainTiles, ...(train ? { longest_train: train } : {}), length,
        min_gap_from_bend: a.min_gap_from_bend, straight_stretches_long_enough: new Set(cands.map((q) => `${q.x},${q.y}`)).size,
        ...listResult('sites', sites, sites, a.limit),
        ...(sites.length ? {} : { note: blocked.length ? `no free stretch: ${blocked.slice(0, 4).map((q) => `(${q.x},${q.y}) side ${q.side}: ${q.problem.code} at (${q.problem.x},${q.problem.y})`).join('; ')}` : `no straight stretch of ${length + 4} tiles on this line; build a straight section (or a shorter --length for shorter trains)` }) };
    },
  },

  // ---- build: road ---------------------------------------------------------------------
  {
    name: 'build-road-path', group: 'build', session: true,
    description: 'Plan and build a road between two tiles (both included), reusing existing roads where that is cheaper, going round houses and industries, bridging water and rail where it must. dry_run=true for the cost first. road_type (see road-types) lays that road or tram type (tram track can go on existing roads).',
    args: z.object({ ...pathArgs, road_type: int().optional().describe('road type id from road-types (trams: a tram type); default plain road') }),
    run: (ctx, a) => buildPath(ctx, a, 'road'),
  },
  {
    name: 'build-road-station', group: 'build', session: true,
    description: 'Build a bus or truck stop at x,y with its entrance facing front (a neighbouring road tile). drive_through=true builds on a straight road tile (front picks the axis; not on junctions). A normal (bay) stop also gets the road piece on front that joins its entrance. Returns connected (AgentBridge v11): true when the entrance (or one end of a drive-through stop) joins a road beyond it. connect=auto builds a road from the entrance to the nearest road when it does not. A refused drive-through stop says why where it can tell (junction, one_way_road, other_owner_road, slope).',
    args: z.object({ ...act, ...point, ...front, kind: z.enum(['bus', 'truck']).default('truck'), drive_through: bool().default(false), ...join,
      connect: z.enum(['none', 'auto']).default('none').describe('auto = when the entrance does not join a road, build a road path from it to the nearest road'), road_type: int().optional().describe('road type id from road-types (trams: a tram type); default plain road') }),
    run: async (ctx, a) => {
      const res = await run(ctx, a, [
        ['road_station', a.x, a.y, a.front_x, a.front_y, a.kind === 'truck', a.drive_through, joinArg(a.join)],
        // A bay stop's entrance is useless until the front tile has a road piece pointing into it.
        ...(a.drive_through ? [] : [['road', a.front_x, a.front_y, a.x, a.y]]),
      ], a.road_type !== undefined ? { roadType: a.road_type } : {});
      const { s, company } = await mine(ctx, a);
      if (!res.ok && a.drive_through && res.results[0] && !res.results[0].ok) {
        const why = await driveThroughRefusal(s, company, a);
        if (why.length) return { ...res, error: `drive_through_refused: ${why.join('; ')} (game: ${res.results[0].error ?? 'failed'})`, first_error: 'drive_through_refused', reasons: why };
      }
      return withRoadJoin(s, company, a, res, a.drive_through ? 'drive_through' : 'bay');
    },
  },
  {
    name: 'build-road-depot', group: 'build', session: true,
    description: 'Build a road vehicle depot at x,y with its entrance facing front (a neighbouring road tile), plus the road piece on front that joins the entrance. Returns connected (AgentBridge v11): true when the front tile joins a road beyond it. connect=auto builds a road from the front tile to the nearest road when it does not.',
    args: z.object({ ...act, ...point, ...front,
      connect: z.enum(['none', 'auto']).default('none').describe('auto = when the front tile does not join a road, build a road path from it to the nearest road'), road_type: int().optional().describe('road type id from road-types (trams: a tram type); default plain road') }),
    run: async (ctx, a) => {
      const res = await run(ctx, a, [['road_depot', a.x, a.y, a.front_x, a.front_y], ['road', a.front_x, a.front_y, a.x, a.y]], a.road_type !== undefined ? { roadType: a.road_type } : {});
      const { s, company } = await mine(ctx, a);
      return withRoadJoin(s, company, a, res, 'depot');
    },
  },

  // ---- build: bridges, tunnels, land ------------------------------------------------------
  {
    name: 'build-bridge', group: 'build', session: true,
    description: 'Build a rail, road or water (aqueduct) bridge between two tiles in a straight line (the ramps go on those tiles).',
    args: z.object({ ...act, type: z.enum(['rail', 'road', 'water']).default('rail'), x1: int(), y1: int(), x2: int(), y2: int(), ...bridgeArg, rail_type: int().optional() }),
    run: (ctx, a) => run(ctx, a, [['bridge', transport(a.type), a.x1, a.y1, a.x2, a.y2, bridgeType(a.bridge)]], { railType: a.rail_type }),
  },
  {
    name: 'build-tunnel', group: 'build', session: true,
    description: 'Build a rail or road tunnel starting at x,y, a tile at the foot of a slope; the game finds the other end straight through the hill.',
    args: z.object({ ...act, type: z.enum(['rail', 'road']).default('rail'), ...point, rail_type: int().optional() }),
    run: (ctx, a) => run(ctx, a, [['tunnel', transport(a.type), a.x, a.y]], { railType: a.rail_type }),
  },
  {
    name: 'terraform', group: 'build', session: true,
    description: 'Change land. op=level: flatten the rectangle x0,y0..x1,y1 to the height of the north corner of tile x0,y0. op=raise / lower: move the given corners of every tile in the rectangle one level (corners: 1 west, 2 south, 4 east, 8 north; 15 = whole tile). dry_run=true first: terraforming is expensive.',
    args: z.object({ ...act, op: z.enum(['level', 'raise', 'lower']).default('level'), x0: int(), y0: int(), x1: int().optional(), y1: int().optional(), corners: int().min(1).max(15).default(15) }),
    run: (ctx, a) => {
      const x1 = a.x1 ?? a.x0, y1 = a.y1 ?? a.y0;
      if (a.op === 'level') return run(ctx, a, [['level', a.x0, a.y0, x1 + 1, y1 + 1]]);
      if ((Math.abs(x1 - a.x0) + 1) * (Math.abs(y1 - a.y0) + 1) > 100) throw new Error('area too large for raise/lower; max 100 tiles per call');
      const steps = [];
      for (let y = Math.min(a.y0, y1); y <= Math.max(a.y0, y1); y++) for (let x = Math.min(a.x0, x1); x <= Math.max(a.x0, x1); x++) steps.push([a.op, x, y, a.corners]);
      return run(ctx, a, steps);
    },
  },
  {
    name: 'demolish', group: 'build', session: true,
    description: "Clear the rectangle x0,y0..x1,y1 (trees, rough land, your own track/road/buildings). Refuses the whole rectangle, clearing nothing, if any tile belongs to another company, an industry, a town road, or is a town building; allow_houses=true permits town buildings (the town's opinion of you drops).",
    args: z.object({ ...act, x0: int(), y0: int(), x1: int().optional(), y1: int().optional(), allow_houses: bool().default(false) }),
    run: async (ctx, a) => {
      const xs = [a.x0, a.x1 ?? a.x0].sort((p, q) => p - q), ys = [a.y0, a.y1 ?? a.y0].sort((p, q) => p - q);
      if ((xs[1] - xs[0] + 1) * (ys[1] - ys[0] + 1) > 400) throw new Error('area too large; max 400 tiles per call');
      const res = await run(ctx, a, [['demolish', xs[0], ys[0], xs[1], ys[1], a.allow_houses]]);
      return { ...res, tiles_cleared: res.results[0]?.value ?? 0 };
    },
  },

  {
    name: 'purchase-land', group: 'build', session: true,
    description: `Buy the rectangle x0,y0..x1,y1 (any two opposite corners) as owned land ("Purchase land for future use"), so nobody else builds there; your own airports, stations and track can still be built on it. At most ${MAX_LAND_TILES} tiles per call. Refuses the whole rectangle, buying nothing, if any tile belongs to another company, is an industry, a town building, road/rail/station, water or an object, is already yours, or the money is short; the error lists the tiles and why. dry_run=true returns the tile count and estimated_cost and changes nothing. A failure while buying reports bought (rectangles) and failed_tile. Needs AgentBridge v10. Example: --x0 10 --y0 20 --x1 13 --y1 22 --dry_run true`,
    args: z.object({ ...act, x0: int(), y0: int(), x1: int(), y1: int() }),
    run: async (ctx, a) => {
      const r = normaliseRect(a);
      checkLandRect(r);
      const { s, company } = await mine(ctx, a);
      checkLandRect(r, { sizeX: s.info.map_x, sizeY: s.info.map_y });
      if (!a.dry_run) s.throttleBuild();
      // One DoCommand per tile, each waiting about a tick for the server: allow ~150 ms a tile.
      const res = await s.exec(company, [['buy_land', r.x0, r.y0, r.x1, r.y1]], { dryRun: a.dry_run, timeoutMs: 30000 + r.tiles * 150 });
      const row = res.results[0];
      if (row?.error?.startsWith('unknown exec op')) throw new Error(OLD_GS_LAND);
      const area = [r.x0, r.y0, r.x1, r.y1];
      const error = row?.error ?? res.stopped ?? (res.ok ? undefined : 'failed');
      if (a.dry_run) {
        return res.ok ? { ok: true, dry_run: true, company, area, tiles: r.tiles, estimated_cost: res.cost, money: res.money, affordable: res.cost <= res.money }
          : { ok: false, dry_run: true, company, area, tiles: r.tiles, error };
      }
      const n = row?.value ?? 0;
      if (n > 0) await s.refreshArea(r.x0, r.y0, r.x1, r.y1);
      if (res.ok) return { ok: true, dry_run: false, company, area, tiles_bought: n, cost: res.cost, money: res.money };
      if (n === 0) return { ok: false, dry_run: false, company, area, tiles: r.tiles, tiles_bought: 0, error };
      const { bought, next } = boughtRects(r, n);
      return { ok: false, dry_run: false, company, area, tiles: r.tiles, tiles_bought: n, bought, failed_tile: next, not_bought: r.tiles - n, cost: res.cost, money: res.money, error,
        hint: 'the bought tiles stay yours; fix the cause and run purchase-land again on the rest (already-owned tiles are refused, so give only the unbought part)' };
    },
  },
  {
    name: 'owned-land', group: 'world', session: true,
    description: 'Your owned land (bought with purchase-land or in the game window): count and rectangles [x0,y0,x1,y1]. Whole map by default (from the map mirror, which can lag a few seconds behind the game); give x0,y0,x1,y1 to check a rectangle fresh. Needs AgentBridge v10.',
    args: z.object({ ...who, x0: int().optional(), y0: int().optional(), x1: int().optional(), y1: int().optional(),
      limit: int().min(1).default(50).describe('most rectangles to return') }),
    run: async (ctx, a) => {
      const corners = ['x0', 'y0', 'x1', 'y1'].filter((k) => a[k] !== undefined);
      if (corners.length && corners.length < 4) throw new Error('give all of --x0 --y0 --x1 --y1, or none for the whole map');
      const { s, company } = await mine(ctx, a);
      let r;
      if (corners.length) {
        r = normaliseRect(a);
        await s.refreshArea(r.x0, r.y0, r.x1, r.y1);
      } else {
        await s.ensureTiles();
        r = normaliseRect({ x0: 0, y0: 0, x1: s.map.sizeX - 1, y1: s.map.sizeY - 1 });
      }
      const owned = await ownedLandAt(s, company, ownedLandCandidates(s.map, r));
      if (!owned) throw new Error(OLD_GS_LAND);
      const rects = mergeTiles([...owned].map((k) => k.split(',').map(Number)));
      return { company, area: [r.x0, r.y0, r.x1, r.y1], tiles: owned.size, rects: rects.slice(0, a.limit),
        ...(rects.length > a.limit ? { rects_total: rects.length, truncated: true } : {}) };
    },
  },

  // ---- build: water and air -----------------------------------------------------------------
  {
    name: 'build-dock', group: 'build', session: true,
    description: 'Build a ship dock on the sloped coast tile x,y (the land half; the water half extends into the sea).',
    args: z.object({ ...act, ...point, ...join }),
    run: (ctx, a) => run(ctx, a, [['dock', a.x, a.y, joinArg(a.join)]]),
  },
  {
    name: 'build-buoy', group: 'build', session: true,
    description: 'Place a buoy on the water tile x,y (a waypoint for ship orders; ships get lost on long legs without them).',
    args: z.object({ ...act, ...point }),
    run: (ctx, a) => run(ctx, a, [['buoy', a.x, a.y]]),
  },
  {
    name: 'build-water-depot', group: 'build', session: true,
    description: 'Build a ship depot on water at x,y; it covers two tiles along the axis towards front.',
    args: z.object({ ...act, ...point, ...front }),
    run: (ctx, a) => run(ctx, a, [['water_depot', a.x, a.y, a.front_x, a.front_y]]),
  },
  {
    name: 'build-airport', group: 'build', session: true,
    description: 'Build an airport with its lowest-x/y corner at x,y. airport = type name (see airport-types); find a spot with airport-sites.',
    args: z.object({ ...act, ...point, airport: z.string().default('small'), ...join }),
    run: async (ctx, a) => {
      const types = await (await ctx.session()).gs.call('airport_types');
      const at = types.find((t) => t.name === lc(a.airport));
      if (!at) throw new Error(`unknown airport '${a.airport}'. Available: ${types.map((t) => t.name).join(', ')}`);
      return run(ctx, a, [['airport', a.x, a.y, at.type, joinArg(a.join)]]);
    },
  },
];

export const COMMANDS_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/**
 * Forgiving argument names: --id for --vehicle, --vehicle for --vehicles and back (one id).
 * Returns a new args object; keys the command really has always win.
 */
export function aliasArgs(known, raw) {
  const out = { ...raw };
  const has = (k) => known.includes(k);
  const move = (from, to, fn = (v) => v) => {
    if (from in out && !has(from) && has(to) && !(to in out)) { out[to] = fn(out[from]); delete out[from]; }
  };
  move('id', 'vehicle');
  move('vehicle', 'vehicles');
  move('id', 'vehicles');
  const single = (v) => (Array.isArray(v) && v.length === 1 ? v[0] : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? v.trim() : v);
  move('vehicles', 'vehicle', single);
  return out;
}

/** zod issues -> "--key: message (got 'raw')" lines, so a bad number shows what was received. */
function argErrors(error, raw) {
  return error.issues.map((i) => {
    const key = i.path[0];
    const got = key !== undefined && key in raw ? ` (got ${JSON.stringify(raw[key])})` : '';
    return `${key !== undefined ? `--${i.path.join('.')}` : 'arguments'}: ${i.message}${got}`;
  }).join('; ');
}

/** Validate args and run. Throws with a readable message on bad args. */
export async function runCommand(ctx, name, rawArgs = {}) {
  const cmd = COMMANDS_BY_NAME.get(name);
  if (!cmd) throw new Error(`unknown command '${name}'. Run: openttd-agent help`);
  // Refuse unknown keys: a mistyped or `--help` flag must never run the command with defaults
  // (`turn-advance --help` once advanced the game 30 days).
  const known = Object.keys(cmd.args.shape ?? {});
  const args = aliasArgs(known, rawArgs ?? {});
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length) {
    throw new Error(`unknown argument${unknown.length > 1 ? 's' : ''} for ${name}: ${unknown.map((k) => `--${k}`).join(', ')}. Valid: ${known.map((k) => `--${k}`).join(' ') || '(none)'}. Nothing was run.`);
  }
  const parsed = cmd.args.safeParse(args);
  if (!parsed.success) throw new Error(`bad arguments for ${name}: ${argErrors(parsed.error, args)}`);
  // Player with a relay configured: the host's relay runs every game command (it holds the admin connection and the map mirror).
  if (cmd.session && ctx.cfg.relay) {
    const res = envelope(await callRelay(ctx.cfg, name, args));
    const host = res.versions?.openttd_agent;
    if (name === 'status' && host && host !== VERSION) {
      res.warnings = [...(res.warnings ?? []), `the host's relay runs openttd-agent ${host}, you run ${VERSION}: use the same version (npx -y github:mmmnorthmark/openttd-agent#v${host} ...)`];
    }
    return res;
  }
  return envelope(await cmd.run(ctx, parsed.data));
}

export function describeCommands() {
  return COMMANDS.map((c) => ({ name: c.name, group: c.group, description: c.description, needs_game: c.session, args: z.toJSONSchema(c.args) }));
}
