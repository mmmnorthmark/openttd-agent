// Single registry of every command. The CLI, the daemon, and the MCP server all
// expose exactly these, with the same names, schemas and JSON results.
//
// Command shape: { name, group, description, session: bool, args: zod object, run(ctx, args) }
// ctx: { cfg, session() -> Promise<Session> } — session() connects lazily.

import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as z from 'zod/v4';
import { doctor, installGamescript, launch, findExecutable, findPersonalDir, checkSaveName, bundledGsVersion, adminHostForBind, profileDir, TERRAIN_TYPES } from './setup.js';
import { serverTarget, serverStates, profilePorts, serverPids, waitReady, notReadyDetail, stopServer, withAdmin, loadSave, listSaves, companyNew, reloadGamescript, logTail, portOpen } from './host.js';
import { VERSION } from './version.js';
import { connectionHint, diagnoseAddress, hostCheck, playerCheck, listeners } from './netcheck.js';
import { installOpenGfx, findBasesets, freeBytes, diskWarning, keepAwakeHint, portHolderText, loadProblem, loadProblemText } from './preflight.js';
import { classifyVersion, versionRefusal, acceptUntested, detectInstalledVersion, compareHostClient, installHint } from './versions.js';
import { saveConfig, redacted, CONFIG_FILE } from './config.js';
import { callRelay } from './relay-client.js';
import { prepareScenario } from './scenario.js';
import { guide } from './guide.js';
import { addPlayer, listPlayers, removePlayer, updatePlayer, PLAYERS_FILE } from './relay-players.js';
import { readStats, statsView, RELAY_STATS_FILE } from './relay-stats.js';
import { ratingTable, vehicleLine, stationLine, vehicleTypeId, cargoId, cargoMatches, stationsFromRows, vehiclesFromRows, enginesFromRows, groupsFromRows, vehicleDetail,
  encodeOrderFlags, ORDER_FLAG_HELP, VEHICLE_TYPES, VEHICLE_STATES, FACILITIES, parseGoalTargets, goalFromRow, findExistingRoute } from './operate.js';
import { planPath, railSteps, roadSteps, terminusSteps, terminusCandidates, terminusFootprint, depotCandidates, depotSteps, passingLoopSteps, passingLoopRemoveSteps, loopSiteProblem, loopSites, spreadLoops, plannedRail, dirIndex, SIGNAL_TYPES, DIR_NAMES } from './planner.js';
import { overlayMap, terminusCells, pathCells, defaultWagons, pickTrain, routeOrderFlags, oppositeDir } from './route.js';
import { traceRail, traceRoad, trackExits, trackEdges, findLoops, adjacencyTrace, mirrorStationTiles, railTileFromRow, roadTileFromRow, DIRS as TRACE_DIRS } from './connectivity.js';
import { recordProgress, recordStall, deadlockPartners, vehicleProblems, manhattan as tileDistance } from './problems.js';
import { routeEffort, findCargoPairs, pairKey, townGaps, findFlatSites, manhattan, acceptanceFromRows, ACCEPTED, DEFAULT_COSTS } from './world.js';
import { envelope, errorCode, listResult } from './envelope.js';
import { takeOutputArgs, shapeResult } from './output.js';
import { dateString, meFromCompanies, companyProfit, tilesText, splitBox, tileBox, filterStations, wordList, filterEvents, eventLine,
  shortStationLine, shortVehicleLine, fleetLine, goalLine, problemGroups, depotsLine, rivalLine } from './observe.js';
import { commandClass, readOnlyGate } from './readonly.js';
import { truckStopCandidates, townStopCandidates, roadDepotCandidates, pickTruck, stopConnect } from './truck.js';
import { normaliseRect, checkLandRect, boughtRects, mergeTiles, ownedLandCandidates, MAX_LAND_TILES } from './land.js';
import { townRatingFromRow, authorityNeed, RATING_HINT, moneyDetail, soldText, loadsFromRows, waitMatch, WAIT_STATES, filterVehicles, sortVehicles, fleetBuckets, VEHICLE_SORTS, parseSelect } from './fleet.js';

// Strict numbers (0.8.0): plain z.number(); runCommand (parseArgs) turns a numeric string ("12", " -3 ")
// into its number. null, "", false and [] are no longer 0 (company 0 is a real company).
const toNumber = (v) => (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v);
const int = () => z.number().int();
const num = () => z.number();
const bool = () => z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const point = { x: int().describe('tile x'), y: int().describe('tile y') };
/** "1,2,3" | 5 | [1,2] -> [ints] */
const idList = (v) => {
  const list = Array.isArray(v) ? v : typeof v === 'number' || typeof v === 'string' ? String(v).split(',').filter((t) => t.trim() !== '') : v;
  return Array.isArray(list) ? list.map(toNumber) : list;
};
const ids = () => z.preprocess(idList, z.array(int()).min(1));
const who = { company: int().optional().describe('company id; default: your configured company') };
const serverArg = { server: z.string().optional().describe('launch profile of the server (launch --server NAME); default: the server at the configured admin_port') };
const act = { ...who, dry_run: bool().default(false).describe('true = cost/feasibility only, changes nothing') };
const borrow = { borrow_if_needed: bool().default(false).describe('when the game refuses for lack of money, borrow what the rest costs (within max_loan) and carry on') };
const lc = (v) => String(v).toLowerCase();
const PAIR_MIN_DIST = 20, PAIR_MAX_DIST = 200; // find-cargo-pairs defaults (tiles, Manhattan)
/** Non-loopback IPv4 addresses of this machine (what players put in their relay URL). */
const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

/** Is `company` another company than the caller's own (cfg.company; through the relay the player's)? */
const isRival = (s, company) => s.cfg.company !== null && s.cfg.company !== undefined && company !== s.cfg.company;

export { adminHostForBind } from './setup.js';

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
  const opts = { dryRun: a.dry_run, ...(a.rail_type !== undefined ? { railType: a.rail_type } : {}), ...(a.road_type !== undefined ? { roadType: a.road_type } : {}) };
  const res = await vehiclesInTheWay(s, company, steps, await execWaitClear(s, company, steps, opts, a.wait_clear_s ?? 0, a));
  if (!a.dry_run) await s.refreshArea(...box);
  return { ...out, ...res };
}
const pathArgs = {
  ...act, ...borrow, x1: int(), y1: int(), x2: int(), y2: int(),
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
/**
 * Town by id or exact name (case-insensitive); else (L13) the longest town name a station-style
 * name starts with ("Bigton Woods" -> Bigton), else the one town whose name starts with the text.
 * A fallback match carries matched_from (what was asked).
 */
export function findTown(towns, v) {
  const want = String(v).trim().toLowerCase();
  const exact = towns.find((t) => String(t.id) === want || t.name.toLowerCase() === want);
  if (exact || !want) return exact;
  const prefixOf = towns.filter((t) => want.startsWith(`${t.name.toLowerCase()} `)).sort((p, q) => q.name.length - p.name.length)[0];
  const startsWith = towns.filter((t) => t.name.toLowerCase().startsWith(want));
  const hit = prefixOf ?? (startsWith.length === 1 ? startsWith[0] : undefined);
  return hit ? { ...hit, matched_from: String(v) } : undefined;
}

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
    const matched = t.matched_from ? ` (matched_town: '${t.matched_from}' -> ${t.name})` : '';
    return { targets: [[t.x, t.y]], catchment: 4, what: `${t.name} centre ${t.x},${t.y}${matched}`, point: [t.x, t.y], kind: 'town', town: t };
  }
  if (end.x !== undefined && end.y !== undefined) return { targets: [[end.x, end.y]], catchment: 2, what: `tile ${end.x},${end.y}`, point: [end.x, end.y], kind: 'tile' };
  throw new Error('give --industry, --town, or --x and --y');
}

/**
 * station-sites: terminus spots near `end`, points facing `toward` (another end, or null), each
 * dry-run checked as `company`. opts: platforms, length, radius, limit. Used by station-sites and build-cargo-route.
 */
async function stationSites(s, company, end, toward, { platforms = 2, length = 4, radius = 8, limit = 3, railType, join = -1 } = {}) {
  const [economy] = await Promise.all([s.economy(), s.ensureTiles()]);
  const here = lineEnd(s, economy, end);
  const there = toward ? lineEnd(s, economy, toward).point : null;
  const cands = terminusCandidates(s.map, { targets: here.targets, radius, catchment: here.catchment, platforms, length, toward: there, max: 40 });
  const sites = []; let checked = 0;
  const rejected = {}; // first failing step's error code -> count (L4)
  for (const c of cands) {
    if (sites.length >= limit || checked >= limit * 4) break;
    checked++;
    const t = terminusSteps({ x: c.x, y: c.y, axis: c.axis, platforms: c.platforms, length: c.length, exitHigh: c.exit === 'high', join });
    const res = await s.exec(company, t.steps, { dryRun: true, ...(railType !== undefined ? { railType } : {}) });
    const bad = (res.results ?? []).filter((r) => !r.ok && r.op !== 'signal');
    if (bad.length) { const code = errorCode(bad[0].error ?? 'failed') ?? 'failed'; rejected[code] = (rejected[code] ?? 0) + 1; continue; }
    sites.push({ x: c.x, y: c.y, axis: c.axis, exit: c.exit, platforms: c.platforms, length: c.length, cost: res.cost, connect_at: t.connect_at,
      tiles_from_target: c.gap, build: `build-terminus --x ${c.x} --y ${c.y} --axis ${c.axis} --exit ${c.exit} --platforms ${c.platforms} --length ${c.length}` });
  }
  return { target: here.what, candidates_on_map: cands.length, dry_runs: checked, sites, ...(Object.keys(rejected).length ? { rejected } : {}),
    ...(sites.length ? {} : { hint: cands.length ? 'no site passed its dry run (see rejected): try --radius 12, --length 3, --platforms 1, or clear land with demolish/terraform'
      : 'no flat free spot of that size near the target on the map: try --radius 12, --length 3, --platforms 1, or clear land with demolish/terraform' }) };
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

/**
 * build-cargo-route --passing_loops: trace the built line between two stations and lay n loops
 * spread along it (non-fatal: a loop that fails is reported). Returns { built: [...], cost, warning? }.
 */
async function buildLineLoops(s, company, from, to, n, length, railType) {
  const out = { built: [], cost: 0 };
  const info = await s.gs.call('info');
  if ((info.bridge_version ?? 0) < 9) { out.warning = 'not built: needs AgentBridge v9 (rail_tiles) to find straight stretches'; return out; }
  const tracer = await makeTracer(s, company, info);
  const r = await tracer.trace(await tracer.stationStarts(from), to);
  if (!r.connected) { out.warning = 'not built: the new line does not trace from one station to the other'; return out; }
  const rail = new Map();
  for (const p of r.path) for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) { const t = await tracer.tileAt(p.x + dx, p.y + dy); if (t) rail.set(`${t.x},${t.y}`, t); }
  const railAt = (x, y) => rail.get(`${x},${y}`) ?? null;
  const picks = spreadLoops(loopSites(r.path, railAt, (x, y) => s.map.classAt(x, y), { length }), n, r.path.length, length);
  for (const c of picks) {
    const lp = passingLoopSteps({ x: c.x, y: c.y, dir: dirIndex(c.dir), length, side: c.side });
    s.throttleBuild();
    const res = await s.exec(company, lp.steps, { railType });
    out.cost += res.cost;
    out.built.push({ x: c.x, y: c.y, dir: c.dir, side: c.side, length, position_pct: Math.round((100 * c.path_index) / r.path.length), complete: res.ok, cost: res.cost, ...(res.ok ? {} : { error: res.error }) });
  }
  const ok = out.built.filter((l) => l.complete).length;
  if (ok < n) out.warning = `${ok} of ${n} passing loops built (each needs ${length + 4} straight tiles of plain track with free land beside it)${out.built.some((l) => !l.complete) ? '; a failed loop may have left partial track: check it with rail-tiles' : ''}`;
  return out;
}

/**
 * Passing loops on a traced line (findLoops: a second track that leaves the line at points and
 * rejoins it). Usable = signals on both sides and, with trainTiles, room for the train
 * (clear_tiles >= trainTiles + 1). Returns { count: usable loops, loops: [...], unusable_loops: [...] },
 * each { x, y (first points), end, clear_tiles, signals_ok, why? }.
 */
async function lineLoops(tracer, path, { trainTiles = null } = {}) {
  const out = { count: 0, loops: [], unusable_loops: [] };
  for (const l of await findLoops({ path, getTile: tracer.tileAt })) {
    const why = !l.signals_ok ? `no_signals: ${l.line_signal ? 'the loop side' : l.branch_signal ? 'the line side' : 'neither side'} has a signal, so trains cannot pass there`
      : trainTiles && l.clear_tiles < trainTiles + 1 ? `too_short: ${l.clear_tiles} clear tiles; a ${trainTiles}-tile train needs ${trainTiles + 1}` : null;
    const row = { x: l.at.x, y: l.at.y, end: l.end, clear_tiles: l.clear_tiles, signals_ok: l.signals_ok, ...(why ? { why } : {}) };
    (why ? out.unusable_loops : out.loops).push(row);
  }
  out.count = out.loops.length;
  return out;
}

/** Is `veh` (a vehicles row) losing money for a year or more? (vehicle-clone / add-train guard, L14) */
const unprofitable = (veh) => veh.age_days >= 365 && veh.profit_last_year < 0 && veh.profit_this_year < 0;

/** source_unprofitable refusal for cloning `veh`, or null. */
const unprofitableRefusal = (veh) => (unprofitable(veh)
  ? `source_unprofitable: vehicle ${veh.id} lost money last year (${veh.profit_last_year}) and this year (${veh.profit_this_year}); a clone copies a losing route. Check it with vehicle-problems --vehicles ${veh.id}, or pass --force true`
  : null);

/**
 * Can `count` more trains run on vehicle `id`'s line? Trains on the line (same order stations,
 * AgentBridge v12) against usable passing loops between its first two stations (v9 trace) and the
 * longest train there. Returns { check, refusal (needs_loop text or null), tracer, stops }.
 */
async function lineCapacity(s, company, id, count, { cmd = 'add-train' } = {}) {
  const info = await s.gs.call('info');
  const stops = await orderStations(s, company, id);
  if (stops.length < 2) return { check: null, refusal: null, tracer: null, stops };
  const ids = await stationVehicleIds(s, company);
  const sameLine = ids ? (ids.get(stops[0].id) ?? []).filter((v) => stops.every((st) => (ids.get(st.id) ?? []).includes(v))) : null;
  const tracer = (info.bridge_version ?? 0) >= 9 ? await makeTracer(s, company, info) : null;
  let loops = null, train = null;
  if (tracer) {
    const r = await tracer.trace(await tracer.stationStarts(stops[0]), stops[1]);
    if (r.connected) {
      train = await longestTrainOnLine(s, company, id);
      loops = await lineLoops(tracer, r.path, { trainTiles: train.tiles });
    }
  }
  const trains = sameLine ? sameLine.length : null;
  const check = { trains_on_line: trains, passing_loops: loops?.count ?? null, after: trains === null ? null : trains + count, allowed: loops === null ? null : loops.count + 1,
    ...(train ? { train_tiles: train.tiles } : {}), ...(loops ? { loops: loops.loops, unusable_loops: loops.unusable_loops } : {}) };
  let refusal = null;
  if (trains !== null && loops !== null && trains + count > loops.count + 1) {
    const unusable = loops.unusable_loops.length ? ` (${loops.unusable_loops.length} more loop${loops.unusable_loops.length === 1 ? ' is' : 's are'} unusable: see check.unusable_loops)` : '';
    refusal = `needs_loop: the line already runs ${trains} train${trains === 1 ? '' : 's'} with ${loops.count} usable passing loop${loops.count === 1 ? '' : 's'}${unusable}; ${trains + count} trains on single track need ${trains + count - 1} loops. Build one first: loop-sites --vehicle ${id}, or ${cmd} --force true`;
  }
  return { check, refusal, tracer, stops };
}

/** finishSales() result trimmed to one company (the relay serves several players from one session). */
const forCompany = (r, company) => Object.fromEntries(Object.entries(r).map(([k, list]) => [k, list.filter((e) => e.company === company).map(({ company: _c, ...rest }) => rest)]));

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
 * build-cargo-route --trains: clone `loco` up to `n` times in `depot` (shared orders) and start them,
 * but only as many as the built line's usable passing loops allow (loops + 1 trains in all).
 * Returns { vehicles, usable_loops, cost, warning?, error? }.
 */
async function cloneOnLine(s, company, from, to, depot, loco, n, trainTiles, exec) {
  const tracer = await makeTracer(s, company, await s.gs.call('info'));
  const r = await tracer.trace(await tracer.stationStarts(from), to);
  const loops = r.connected && tracer.tileAt ? await lineLoops(tracer, r.path, { trainTiles }) : { count: 0, loops: [], unusable_loops: [] };
  const k = Math.min(n, loops.count);
  const out = { vehicles: [], usable_loops: loops.count, cost: 0 };
  if (k < n) out.warning = `${1 + k} of ${1 + n} trains: the line has ${loops.count} usable passing loop${loops.count === 1 ? '' : 's'}${loops.unusable_loops.length ? ` (${loops.unusable_loops.length} unusable)` : ''} and single track takes loops + 1 trains; build more with loop-sites --vehicle ${loco}, then add-train --vehicle ${loco}`;
  if (!k) return out;
  const res = await exec(Array.from({ length: k }, () => ['veh_clone', depot.x, depot.y, loco, true]));
  out.cost = res.cost;
  out.vehicles = res.results.filter((q) => q.ok && q.value !== undefined).map((q) => q.value);
  if (out.vehicles.length) await exec(out.vehicles.map((v) => ['veh_start_stop', v, 1]), { keepGoing: true });
  if (!res.ok) out.error = res.error;
  return out;
}

/**
 * Why build-cargo-route found no terminus at one end (L4): candidates and dry runs over every option
 * set tried, rejected counts by error code, your stations near the end, and a hint that lists only
 * what was not tried yet. `tried`: [{ opts, res }] (res = stationSites result).
 */
function noSiteReport(tried, ownNear) {
  const rejected = {};
  for (const { res } of tried) for (const [k, n] of Object.entries(res.rejected ?? {})) rejected[k] = (rejected[k] ?? 0) + n;
  const opts = tried.map((t) => t.opts);
  const maxR = Math.max(...opts.map((o) => o.radius)), minL = Math.min(...opts.map((o) => o.length)), minP = Math.min(...opts.map((o) => o.platforms));
  const untried = [...(maxR < 24 ? [`--radius ${Math.min(24, maxR + 4)}`] : []), ...(minL > 2 ? ['--length 2'] : []), ...(minP > 1 ? ['--platforms 1'] : [])];
  const hint = [untried.length ? `not tried yet: ${untried.join(', ')}` : 'every size and radius was tried',
    ...(ownNear.length ? [`your station ${ownNear[0].name} (${ownNear[0].id}) is ${ownNear[0].tiles} tiles away: --reuse_stations auto joins a new platform to it`] : []),
    'or clear land with demolish/terraform, or pick another end'].join('; ');
  return { candidates_on_map: Math.max(...tried.map((t) => t.res.candidates_on_map)), dry_runs: tried.reduce((n, t) => n + t.res.dry_runs, 0), rejected,
    tried: opts.map((o) => ({ radius: o.radius, length: o.length, platforms: o.platforms })), own_station_near: ownNear, hint };
}

/**
 * build-cargo-route: plan everything as a dry run (both termini, the line between their connect_at
 * anchors, a depot beside the line near the source, a train), then, unless dryRun, build it step by
 * step. On a failure it stops and reports the step and everything already built; it never demolishes.
 */
async function buildCargoRoute(s, company, a, ctx) {
  const plan = { dry_run: a.dry_run, company };
  const built = [];
  const vehiclesBought = () => built.filter((b) => b.step === 'buy_locomotive').map((b) => b.vehicle);
  const fail = (step, error, extra = {}) => ({ ok: false, failed_step: step, error, first_error: errorCode(error), cost: extra.spent ?? 0, vehicles: vehiclesBought(), built, ...plan, ...extra,
    hint: extra.hint ?? (built.length ? 'nothing was demolished: continue from the failed step by hand (build-rail, build-line-depot, vehicle-buy, order-add, vehicle-start) using the ids and tiles in built' : 'nothing was built') });
  const from = a.from_industry !== undefined ? { industry: a.from_industry } : a.from_town !== undefined ? { town: a.from_town } : null;
  const to = a.to_industry !== undefined ? { industry: a.to_industry } : a.to_town !== undefined ? { town: a.to_town } : null;
  if (!from || !to) throw new Error('give one source (--from_industry <id> or --from_town <name>) and one destination (--to_industry <id> or --to_town <name>)');
  const cargo = cargoId(s.cargos, a.cargo);
  const cargoInfo = s.cargos.get(cargo);
  // L14: a source that makes nothing of this cargo (a sawmill before any wood arrives) gives an empty line.
  if (from.industry !== undefined && !a.force) {
    const ind = (await s.economy()).industries.find((i) => i.id === from.industry);
    const prod = ind?.produces.find((p) => p.cargo === cargo);
    const what = ind ? `${ind.type_name} ${ind.id}` : `industry ${from.industry}`;
    if (ind && !prod) {
      return fail('source', `source_produces_nothing: ${what} does not produce ${cargoInfo?.name ?? a.cargo} (it produces ${ind.produces.map((p) => p.cargo_name).join(', ') || 'nothing'})`,
        { first_error: 'source_produces_nothing', hint: `pick a producer of ${cargoInfo?.name ?? a.cargo}: find-cargo-pairs --cargo ${a.cargo}` });
    }
    if (ind?.secondary && prod.last_month === 0) {
      const inputs = ind.accepts.join(', ') || 'its input cargo';
      return fail('source', `source_produces_nothing: ${what} made no ${prod.cargo_name} last month; it makes it only from deliveries of ${inputs}`,
        { first_error: 'source_produces_nothing', feeder: { accepts: ind.accepts }, hint: `feed it first: find-cargo-pairs --cargo "${ind.accepts[0] ?? ''}" --dest_id ${ind.id} lists producers of its input; or pass --force true to build anyway` });
    }
  }
  const railTypes = await s.gs.call('rail_types', { company });
  // Default: the cheapest track (the plain build-rail default is the game's first listed type, often electrified).
  const railType = a.rail_type ?? [...railTypes].sort((p, q) => p[3] - q[3])[0]?.[0];
  if (railType === undefined) throw new Error('your company cannot build any rail type yet (see rail-types)');
  plan.rail_type = railType;

  // 0. Already running this route? A second line beside the first doubles the cost for little
  // more cargo; more trains on the first line is the usual answer (a live agent built one twice).
  // --if_exists (L2): refuse (default) | skip (ok, action exists) | add_train (add-train on the line) | build.
  const ifExists = a.allow_existing ? 'build' : a.if_exists;
  if (ifExists !== 'build') {
    const economy = await s.economy();
    const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
    const bothWays = !!(cargoInfo?.passengers || cargoInfo?.mail);
    const existing = findExistingRoute(stations, lineEnd(s, economy, from), lineEnd(s, economy, to), cargo, { radius: a.radius + 2, bothWays });
    const servedBy = existing ? await vehicleServing(s, company, stations, existing.from_station.id, existing.to_station.id) : null;
    if (existing && servedBy !== null) {
      const found = { ...existing, served_by: servedBy };
      if (ifExists === 'skip') {
        return { ok: true, action: 'exists', dry_run: a.dry_run, company, existing: found, cost: 0, vehicles: [], built: [],
          note: `you already run this route (vehicle ${servedBy}); nothing was built. --if_exists add_train adds a train to it` };
      }
      if (ifExists === 'add_train') {
        const res = await addTrain(ctx, s, company, { company, vehicle: servedBy, count: 1, force: false, dry_run: a.dry_run });
        return { ...res, action: 'add_train', existing: found };
      }
      return fail('existing_route', `refused: you already run this route: ${existing.from_station.name} (${existing.from_station.id}) and ${existing.to_station.name} (${existing.to_station.id}), served by vehicle ${servedBy}`,
        { existing: { ...existing, served_by: servedBy }, first_error: 'existing_route',
          hint: `add capacity instead: the same command with --if_exists add_train (or add-train --vehicle ${servedBy}); --if_exists skip returns ok; --if_exists build builds a second line anyway` });
    }
    if (existing) plan.existing_unserved = { ...existing, note: 'your stations there have no vehicle serving both, so a new line is built (with --reuse_stations auto the new termini join them where they fit)' };
  }

  // 1. Stations: best dry-run-checked site at each end, facing the other end, not overlapping.
  // A town end that has no site (houses everywhere) is retried wider, shorter and with one platform.
  const opts = { platforms: a.platforms, length: a.length, radius: a.radius, limit: 3, railType };
  // Every end (town or industry, C8) is retried wider, shorter and with one platform.
  const tries = () => siteFallbacks(opts);
  const economy0 = await s.economy();
  const ownRail = stationsFromRows(await s.gs.call('stations', { company }), s.cargos).filter((st) => st.facilities.includes('rail'));
  const ownNear = (end) => {
    const here = lineEnd(s, economy0, end);
    return ownRail.map((st) => ({ id: st.id, name: st.name, tiles: Math.min(...here.targets.map(([x, y]) => Math.max(Math.abs(st.x - x), Math.abs(st.y - y)))) }))
      .filter((st) => st.tiles <= a.radius + 8).sort((p, q) => p.tiles - q.tiles).slice(0, 3);
  };
  const accepts = new Map();
  const acceptOf = async (d) => {
    const along = d.axis === 'y';
    const lists = await acceptanceAt(s, [[d.x, d.y]], { w: along ? d.platforms : d.length, h: along ? d.length : d.platforms, radius: 4, cargos: [cargo] });
    return lists ? (lists[0][0]?.acceptance ?? 0) : null;
  };
  let srcSites = null, dstSites = null, accepting = [];
  const srcTried = [], dstTried = [];
  // L3: an end next to one of your rail stations joins a new platform group to it (join = its id;
  // the game needs the result within station_spread). Tried with the first two option sets, then a new station.
  const reuseAt = (end) => (a.reuse_stations === 'never' ? null : ownNear(end).find((st) => st.tiles <= a.radius) ?? null);
  const joinsFor = (reuse) => (reuse ? [...tries().slice(0, 2).map((o) => ({ o, join: reuse.id })), ...tries().map((o) => ({ o, join: -1 }))] : tries().map((o) => ({ o, join: -1 })));
  const reuseNote = (reuse, join) => (reuse ? (join >= 0 ? { reused_station: { id: reuse.id, name: reuse.name } } : { reuse_failed: { id: reuse.id, name: reuse.name, note: 'no terminus joined to it passed its dry run (too far apart for station_spread, or no room); a new station is built' } }) : {});
  const srcReuse = reuseAt(from), dstReuse = reuseAt(to);
  let srcJoin = -1, dstJoin = -1;
  for (const { o, join } of joinsFor(srcReuse)) {
    srcSites = await stationSites(s, company, from, to, { ...o, join });
    srcTried.push({ opts: o, res: srcSites });
    if (srcSites.sites.length) { srcJoin = join; if (o !== opts) plan.source_fallback = fallbackNote(opts, o); break; }
  }
  const noSite = (which, sites, tried, end) => {
    const report = noSiteReport(tried, ownNear(end));
    const rej = Object.entries(report.rejected).map(([k, n]) => `${k} ${n}`).join(', ');
    return fail(which, `no terminus site passed near ${sites.target}: ${report.candidates_on_map} candidate spots on the map, ${report.dry_runs} dry runs over ${tried.length} size/radius options${rej ? ` (rejected: ${rej})` : ''}`,
      { first_error: 'no_terminus_site', no_site: report, hint_sites: report.hint });
  };
  if (!srcSites.sites.length) return noSite('source_station', srcSites, srcTried, from);
  for (const { o, join } of joinsFor(dstReuse)) {
    dstSites = await stationSites(s, company, to, from, { ...o, join });
    dstTried.push({ opts: o, res: dstSites });
    // Destination sites must accept the cargo (AgentBridge v7; null = not checkable, kept with a note).
    for (const d of dstSites.sites) accepts.set(d, await acceptOf(d));
    accepting = dstSites.sites.filter((d) => accepts.get(d) === null || accepts.get(d) >= ACCEPTED);
    if (accepting.length) { dstJoin = join; if (o !== opts) plan.dest_fallback = fallbackNote(opts, o); break; }
  }
  if (!dstSites.sites.length) return noSite('dest_station', dstSites, dstTried, to);
  if (!accepting.length) {
    return fail('dest_station', `no terminus site near ${dstSites.target} accepts ${cargoInfo?.name ?? a.cargo} (acceptance ${[...accepts.values()].join(', ')}; ${ACCEPTED} needed)`);
  }
  let src = null, dst = null;
  for (const p of srcSites.sites) { const q = accepting.find((d) => !sitesOverlap(p, d)); if (q) { src = p; dst = q; break; } }
  if (!src) return fail('dest_station', 'every source and destination site overlap: the two ends are too close for two termini');
  src.join = srcJoin; dst.join = dstJoin;
  plan.source_site = { target: srcSites.target, ...src, ...reuseNote(srcReuse, srcJoin) };
  plan.dest_site = { target: dstSites.target, ...dst, acceptance: accepts.get(dst), ...reuseNote(dstReuse, dstJoin) };
  // Warn when a new terminus lands next to one of our stations: often a second line to the same place.
  const ownStations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
  const warnings = [];
  for (const [end, site] of [['source', src], ['dest', dst]]) {
    for (const st of ownStations) {
      if (st.id === site.join) continue;
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
  const wagons = a.wagons ?? defaultWagons(Math.min(src.length, dst.length)); // a fallback can shorten one end
  plan.train = { locomotive: { id: train.loco.id, name: train.loco.name, price: train.loco.price, running_cost: train.loco.running_cost },
    wagon: { id: train.wagon.id, name: train.wagon.name, price: train.wagon.price, capacity: train.wagon.capacity }, wagons,
    cost: train.loco.price + wagons * train.wagon.price };
  const orders = routeOrderFlags({ passengerOrMail: !!(cargoInfo?.passengers || cargoInfo?.mail), fromTown: !!from.town, toTown: !!to.town });
  plan.orders = { source: orders.source_flags || 'plain', dest: orders.dest_flags || 'plain' };
  const trainTiles = Math.ceil((wagons + 1) / 2);
  const loopLength = Math.min(30, trainTiles + 2);
  let loopCost = 0;
  if (a.passing_loops > 0) {
    const planned = plannedRail(line);
    const view = overlayMap(s.map, pathCells(line, cells));
    const picks = spreadLoops(loopSites(planned.path, planned.railAt, (x, y) => view.classAt(x, y), { length: loopLength }), a.passing_loops, planned.path.length, loopLength);
    plan.passing_loops = [];
    for (const c of picks) {
      const lp = passingLoopSteps({ x: c.x, y: c.y, dir: dirIndex(c.dir), length: loopLength, side: c.side });
      const dry = await s.exec(company, lp.loopSteps, { dryRun: true, railType });
      plan.passing_loops.push({ x: c.x, y: c.y, dir: c.dir, side: c.side, length: loopLength, position_pct: Math.round((100 * c.path_index) / planned.path.length), cost: dry.cost, ...(dry.ok ? {} : { dry_run_error: dry.error }) });
      loopCost += dry.cost;
    }
    plan.passing_loops_note = 'sites on the planned line; the real build picks them again on the built track (positions can move a few tiles); cost counts the loop track only';
    if (picks.length < a.passing_loops) (plan.warnings ??= []).push({ passing_loops: `only ${picks.length} of ${a.passing_loops} loops fit on straight stretches of the planned line (each needs ${loopLength + 4} straight tiles)` });
  }
  // C13: --trains K: more trains only as far as the loops allow (single track: loops + 1 trains).
  let extraTrains = 0;
  if (a.trains > 1) {
    const loopsPlanned = (plan.passing_loops ?? []).filter((l) => !l.dry_run_error).length;
    extraTrains = Math.min(a.trains - 1, loopsPlanned);
    plan.trains = { asked: a.trains, planned: 1 + extraTrains, passing_loops_planned: loopsPlanned, cost: (1 + extraTrains) * plan.train.cost,
      ...(extraTrains < a.trains - 1 ? { note: `single track takes one train per passing loop + 1: ${1 + extraTrains} of ${a.trains}; ${a.passing_loops >= a.trains - 1 ? 'only some of the --passing_loops fit on the planned line (see warnings)' : `add --passing_loops ${a.trains - 1}`}` } : {}) };
  }
  const estimate = src.cost + dst.cost + lineCheck.cost + depotCheck.cost + plan.train.cost * (1 + extraTrains) + loopCost;
  plan.estimated_cost = estimate;
  plan.money = lineCheck.money;
  plan.affordable = lineCheck.money === null || lineCheck.money >= estimate;
  if (a.dry_run) return { ok: true, ...plan, cost: estimate, vehicles: [], built: [], note: 'dry run: nothing was built. Depot joins and train purchase are estimated, not dry-run.' };
  if (!plan.affordable) return fail('money', `estimated cost ${estimate} is more than the company has (${lineCheck.money})`);

  // ---- build, step by step -------------------------------------------------------------
  const exec = async (steps, opts2 = {}) => { s.throttleBuild(); return s.exec(company, steps, { railType, ...opts2 }); };
  let spent = 0;
  const station = async (name, site) => {
    const t = terminusSteps({ x: site.x, y: site.y, axis: site.axis, platforms: site.platforms, length: site.length, exitHigh: site.exit === 'high', join: site.join ?? -1 });
    const res = await exec(t.steps);
    spent += res.cost;
    const placed = res.results.some((r) => r.op === 'rail_station' && r.ok);
    const st = !placed ? null : site.join >= 0 ? stationsFromRows(await s.gs.call('stations', { company }), s.cargos).find((q) => q.id === site.join) ?? null : await stationAt(s, company, site);
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
    if (a.passing_loops > 0 && A.st && B.st) {
      const loops = await buildLineLoops(s, company, A.st, B.st, a.passing_loops, loopLength, railType);
      spent += loops.cost;
      for (const l of loops.built) built.push({ step: 'passing_loop', ...l });
      if (loops.warning) (plan.warnings ??= []).push({ passing_loops: loops.warning });
    }
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
    // C1: trace the built line both ways (and the depot's first leg) instead of leaving it to the caller.
    let verify = { connected: null, note: 'not traced: a new station id was not found on its site' };
    if (A.st && B.st) {
      try { verify = await lineVerify(s, company, A.st, B.st, dep.depot); } catch (e) { verify = { connected: null, error: e.message }; }
    }
    if (verify.first_leg?.warning) (plan.warnings ??= []).push({ depot_exit_detour: verify.first_leg.warning });
    const vehicles = [loco];
    if (a.trains > 1 && verify.connected) {
      const more = await cloneOnLine(s, company, A.st, B.st, dep.depot, loco, a.trains - 1, trainTiles, exec);
      spent += more.cost;
      vehicles.push(...more.vehicles);
      built.push({ step: 'more_trains', vehicles: more.vehicles, usable_loops: more.usable_loops, complete: !more.error, cost: more.cost, ...(more.error ? { error: more.error } : {}) });
      if (more.warning) (plan.warnings ??= []).push({ trains: more.warning });
    } else if (a.trains > 1) {
      (plan.warnings ??= []).push({ trains: `only 1 of ${a.trains} trains: the line was not traced exactly (${verify.connected === false ? 'it is broken' : 'needs AgentBridge v9'}), so the passing loops were not counted` });
    }
    const done = { ...plan, dry_run: false, source_station: A.st?.id ?? null, dest_station: B.st?.id ?? null, depot: dep.depot, vehicle: loco, vehicles,
      cost: spent, total_cost: spent, built, verify, next: `add-train --vehicle ${loco} adds a train with the same orders (checks passing loops)` };
    if (verify.connected === false) {
      return { ok: false, ...done, failed_step: 'verify', first_error: 'route_broken',
        error: `route_broken: the new line does not trace ${verify.there ? `back from ${B.st.name} to ${A.st.name}` : `from ${A.st.name} to ${B.st.name}`}${verify.first_gap ? ` (first gap at (${verify.first_gap.x},${verify.first_gap.y}): ${verify.first_gap.reason})` : ''}; train ${loco} is running. Fix the gap with build-track, then verify-route --vehicle ${loco}` };
    }
    return { ok: true, ...done };
  } catch (e) {
    const last = built.at(-1)?.step ?? null;
    return fail(last ? `after ${last}` : 'source_station', e.message, { spent });
  }
}

// ---- build-truck-route ------------------------------------------------------------------

/**
 * Composite road route: a truck (or bus) stop at each end, a road between them (reusing roads),
 * a depot beside it near the source, road vehicles with orders, started, and a road trace.
 * Mirrors buildCargoRoute: every placement is dry-run first; a failure reports what was built.
 */
async function buildTruckRoute(s, company, a) {
  const plan = { dry_run: a.dry_run, company };
  const built = [];
  const fail = (step, error, extra = {}) => ({ ok: false, failed_step: step, error, first_error: errorCode(error), cost: extra.spent ?? 0, built, ...plan, ...extra,
    hint: built.length ? 'nothing was demolished: continue from the failed step by hand (build-road-path, build-road-depot, vehicle-buy) using the tiles in built' : 'nothing was built' });
  const cargo = cargoId(s.cargos, a.cargo);
  const cargoInfo = s.cargos.get(cargo);
  const bus = !!(cargoInfo?.passengers);
  const from = a.from_industry !== undefined ? { industry: a.from_industry } : { town: a.from_town };
  const to = a.to_industry !== undefined ? { industry: a.to_industry } : { town: a.to_town };
  const [economy] = await Promise.all([s.economy(), s.ensureTiles()]);
  const A = lineEnd(s, economy, from), B = lineEnd(s, economy, to);
  const box = [Math.min(A.point[0], B.point[0]) - a.margin, Math.min(A.point[1], B.point[1]) - a.margin, Math.max(A.point[0], B.point[0]) + a.margin, Math.max(A.point[1], B.point[1]) + a.margin];
  await s.refreshArea(...box);
  const stopSteps = (c) => [['road_station', c.x, c.y, c.front_x, c.front_y, !bus, c.drive_through, -1], ...(c.drive_through ? [] : [['road', c.front_x, c.front_y, c.x, c.y]])];
  const pickStop = async (end, other, needAccept) => {
    const cands = end.kind === 'town'
      ? [...townStopCandidates(s.map, { cx: end.point[0], cy: end.point[1], radius: a.radius }), ...truckStopCandidates(s.map, { targets: [end.point], catchment: Math.min(a.radius, 4), toward: other.point })]
      : truckStopCandidates(s.map, { targets: end.targets, catchment: 3, toward: other.point });
    let tried = 0;
    for (const c of cands) {
      if (tried >= 16) break;
      tried++;
      const dry = await s.exec(company, stopSteps(c), { dryRun: true });
      if (!dry.ok) continue;
      if (needAccept) {
        const lists = await acceptanceAt(s, [[c.x, c.y]], { radius: 3, cargos: [cargo] });
        const acc = lists ? (lists[0][0]?.acceptance ?? 0) : null;
        if (acc !== null && acc < ACCEPTED) continue;
        return { ...c, cost: dry.cost, acceptance: acc };
      }
      return { ...c, cost: dry.cost };
    }
    return { none: true, candidates: cands.length, tried };
  };
  const src = await pickStop(A, B, false);
  if (src.none) return fail('source_stop', `no ${bus ? 'bus' : 'truck'} stop site passed near ${A.what} (${src.candidates} candidates, ${src.tried} dry runs)`);
  const dst = await pickStop(B, A, true);
  if (dst.none) return fail('dest_stop', `no ${bus ? 'bus' : 'truck'} stop site near ${B.what} passed and accepts ${cargoInfo?.name ?? a.cargo} (${dst.candidates} candidates, ${dst.tried} dry runs)`);
  plan.source_stop = { target: A.what, ...src };
  plan.dest_stop = { target: B.what, ...dst };
  const cells = new Map();
  for (const c of [src, dst]) if (!c.drive_through) cells.set(`${c.x},${c.y}`, 's');
  const view = overlayMap(s.map, cells);
  const road = planPath(view, stopConnect(src), stopConnect(dst), { mode: 'road', margin: a.margin, maxBridge: a.max_bridge });
  if (!road.reachable) return fail('road', road.reason ?? 'no road path between the two stops');
  const roadPlan = roadSteps(road, { bridgeType: -1 });
  const roadCheck = await s.exec(company, roadPlan, { dryRun: true });
  plan.road = { ...road.stats, cost: roadCheck.cost };
  if (!roadCheck.ok) return fail('road', `road dry run failed: ${roadCheck.error}`);
  const pathCellsMap = new Map(cells);
  for (const [x, y] of road.tiles) pathCellsMap.set(`${x},${y}`, 'd');
  const depotView = overlayMap(s.map, pathCellsMap);
  let depot = null;
  for (const d of roadDepotCandidates(depotView, road.tiles, stopConnect(src), { skip: new Set([`${src.x},${src.y}`, `${dst.x},${dst.y}`]) })) {
    const dry = await s.exec(company, [['road_depot', d.x, d.y, d.front_x, d.front_y], ['road', d.front_x, d.front_y, d.x, d.y]], { dryRun: true });
    if (dry.ok) { depot = { ...d, cost: dry.cost }; break; }
  }
  if (!depot) return fail('depot', 'no depot spot beside the planned road passed its dry run');
  plan.depot = depot;
  const engines = enginesFromRows(await s.gs.call('engines', { company, type: 1, cargo }), s.cargos);
  let truck;
  try { truck = pickTruck(engines, { cargoId: cargo, engine: a.engine }); } catch (e) { return fail('engine', e.message); }
  plan.vehicle = { id: truck.id, name: truck.name, price: truck.price, capacity: truck.capacity, running_cost: truck.running_cost, count: a.vehicles };
  const orders = routeOrderFlags({ passengerOrMail: !!(cargoInfo?.passengers || cargoInfo?.mail), fromTown: from.town !== undefined, toTown: to.town !== undefined });
  plan.orders = { source: orders.source_flags || 'plain', dest: orders.dest_flags || 'plain' };
  const estimate = src.cost + dst.cost + roadCheck.cost + depot.cost + truck.price * a.vehicles;
  plan.estimated_cost = estimate;
  plan.money = roadCheck.money;
  plan.affordable = roadCheck.money === null || roadCheck.money >= estimate;
  if (a.dry_run) return { ok: true, ...plan, cost: estimate, vehicles: [], built: [], note: 'dry run: nothing was built' };
  if (!plan.affordable) return fail('money', `estimated cost ${estimate} is more than the company has (${roadCheck.money})`);

  const exec = async (steps) => { s.throttleBuild(); return s.exec(company, steps); };
  let spent = 0;
  try {
    const before = new Set(stationsFromRows(await s.gs.call('stations', { company }), s.cargos).map((st) => st.id));
    const stopIds = [];
    for (const [name, c] of [['source_stop', src], ['dest_stop', dst]]) {
      const res = await exec(stopSteps(c));
      spent += res.cost;
      if (!res.ok) return fail(name, res.error, { spent });
      const now = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
      const st = now.find((q) => !before.has(q.id) && !stopIds.includes(q.id)) ?? now.find((q) => tileDistance(q, c) <= 1);
      stopIds.push(st?.id ?? null);
      built.push({ step: name, station: st?.id ?? null, x: c.x, y: c.y, drive_through: c.drive_through, complete: true, cost: res.cost });
    }
    const roadRes = await exec(roadPlan);
    spent += roadRes.cost;
    built.push({ step: 'road', tiles: road.stats.tiles, complete: roadRes.ok, cost: roadRes.cost });
    if (!roadRes.ok) return fail('road', roadRes.error, { spent });
    const depRes = await exec([['road_depot', depot.x, depot.y, depot.front_x, depot.front_y], ['road', depot.front_x, depot.front_y, depot.x, depot.y]]);
    spent += depRes.cost;
    built.push({ step: 'depot', x: depot.x, y: depot.y, front: { x: depot.front_x, y: depot.front_y }, complete: depRes.ok, cost: depRes.cost });
    if (!depRes.ok) return fail('depot', depRes.error, { spent });
    const refit = truck.cargo === cargo ? -1 : cargo;
    const buy = await exec(Array.from({ length: a.vehicles }, () => ['veh_buy', depot.x, depot.y, truck.id, refit, -1]));
    spent += buy.cost;
    const ids = buy.results.filter((r) => r.ok && r.value !== undefined).map((r) => r.value);
    built.push({ step: 'buy_vehicles', vehicles: ids, of: a.vehicles, complete: buy.ok, cost: buy.cost });
    if (!ids.length) return fail('buy_vehicles', buy.error, { spent });
    const [first, ...rest] = ids;
    const ord = await exec([['order_add', first, src.x, src.y, orders.source, -1], ['order_add', first, dst.x, dst.y, orders.dest, -1],
      ...rest.map((v) => ['orders_copy', v, first, true]), ...ids.map((v) => ['veh_start_stop', v, 1])]);
    built.push({ step: 'orders_and_start', vehicles: ids, complete: ord.ok });
    if (!ord.ok) return fail('orders', ord.error, { spent, vehicles: ids });
    let verify = null;
    const tracer = makeRoadTracer(s, company, await s.gs.call('info'));
    if (tracer && stopIds.every((id) => id !== null)) {
      const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
      const [sa, sb] = stopIds.map((id) => stations.find((q) => q.id === id));
      const there = await tracer.trace(await tracer.stationStarts(sa), sb);
      const back = await tracer.trace(await tracer.stationStarts(sb), sa);
      verify = { connected: there.connected && back.connected, there: there.connected, back: back.connected, ...(there.connected ? {} : { first_gap: there.first_gap ?? null }) };
    }
    const ok = !verify || verify.connected;
    return { ok, ...(ok ? {} : { error: `route_broken: the road does not join both stops (see verify)`, first_error: 'route_broken' }), ...plan, dry_run: false,
      source_station: stopIds[0], dest_station: stopIds[1], depot: { x: depot.x, y: depot.y }, vehicles: ids, cost: spent, built, verify: verify ?? 'not checked (needs AgentBridge v11)',
      next: `vehicle-clone --vehicle ${first} --depot_x ${depot.x} --depot_y ${depot.y} --start true adds vehicles with the same orders` };
  } catch (e) {
    const last = built.at(-1)?.step ?? null;
    return fail(last ? `after ${last}` : 'source_stop', e.message, { spent });
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

/**
 * Longest train on the line through track tile (x, y): trace to the nearest station of `company`
 * and on to a second one, then the trains with orders at both (AgentBridge v12 counts, v9 trace).
 * Returns { tiles, vehicle, stations: [{ id }], trains_checked } or { reason } when unknown.
 */
async function longestTrainAt(s, company, x, y) {
  const info = await s.gs.call('info');
  if ((info.bridge_version ?? 0) < 9) return { reason: 'the running AgentBridge is older than v9 (no rail_tiles)' };
  const tracer = await makeTracer(s, company, info);
  const t = await tracer.tileAt(x, y);
  if (!t || t.kind !== 't') return { reason: `(${x},${y}) has no track yet, so no line or train is known` };
  const stationOf = async (skip) => {
    const r = await traceRail({ getTile: tracer.tileAt, starts: [{ x, y }], isGoal: (q) => q.kind === 's' && q.owner === company && q.station >= 0 && q.station !== skip, company });
    return r.connected ? (await tracer.tileAt(r.reached.x, r.reached.y)).station : null;
  };
  const a = await stationOf(-1);
  const b = a === null ? null : await stationOf(a);
  if (a === null || b === null) return { reason: `the track at (${x},${y}) does not lead to two of your stations` };
  const ids = await stationVehicleIds(s, company);
  if (!ids) return { reason: 'the running AgentBridge is older than v12 (no station_vehicles)' };
  const trains = (ids.get(a) ?? []).filter((v) => (ids.get(b) ?? []).includes(v));
  for (const v of trains) {
    const veh = vehiclesFromRows(await s.gs.call('vehicles', { company })).find((q) => q.id === v);
    if (veh?.type === 'rail') return { ...(await longestTrainOnLine(s, company, v)), stations: [{ id: a }, { id: b }] };
  }
  return { reason: `no train of yours has orders at both stations ${a} and ${b} of this line` };
}

/**
 * First leg of a new train (C9): trace from the depot to its first station. detour_ratio = path tiles
 * / straight-line tiles; a big one means the depot exit faces away and every new or serviced train
 * runs to the far end first (warning depot_exit_detour). null when the tracer is not exact (< v9).
 */
async function firstLeg(tracer, depot, station) {
  if (!tracer || tracer.method !== 'rail_tracks' || !depot || !station) return null;
  const r = await tracer.trace([{ x: depot.x, y: depot.y }], station);
  if (!r.connected) return { connected: false, to: station.name ?? station.id, first_gap: r.first_gap ?? null };
  const direct = Math.max(1, tileDistance(depot, station));
  const ratio = Math.round((10 * r.path.length) / direct) / 10;
  const detour = ratio >= 2.5 && r.path.length - direct >= 12;
  return { connected: true, to: station.name ?? station.id, tiles: r.path.length, direct_tiles: direct, detour_ratio: ratio,
    ...(detour ? { warning: `depot_exit_detour: a train leaving the depot at (${depot.x},${depot.y}) runs ${r.path.length} tiles to reach ${station.name ?? `station ${station.id}`} (${direct} tiles away): the depot exit leads away from it, so every new or serviced train goes the long way first. Join the depot front toward the station (build-track) or build the depot on the other side` } : {}) };
}

/**
 * Trace a built two-station line both ways and its depot's first leg (build-cargo-route, C1).
 * Returns { connected (null when only a coarse trace was possible), there, back, first_gap, first_leg?, method, note? }.
 */
async function lineVerify(s, company, from, to, depot) {
  const tracer = await makeTracer(s, company, await s.gs.call('info'));
  const there = await tracer.trace(await tracer.stationStarts(from), to);
  const back = await tracer.trace(await tracer.stationStarts(to), from);
  const coarse = tracer.method !== 'rail_tracks';
  const bad = !there.connected ? there : !back.connected ? back : null;
  const leg = await firstLeg(tracer, depot, from);
  return { connected: coarse && !bad ? null : !bad, there: there.connected, back: back.connected, first_gap: bad?.first_gap ?? null, method: tracer.method,
    ...(leg ? { first_leg: leg } : {}), ...(coarse ? { note: OLD_GS_TRACE } : {}) };
}

// ---- depot guard (vehicle-clone, vehicle-buy --route_of) ---------------------------------

/** Source vehicle row (type, position) of this company. A sold vehicle's error says when and who serves its stations now (L10). */
async function vehicleOf(s, company, id) {
  const veh = vehiclesFromRows(await s.gs.call('vehicles', { company })).find((v) => v.id === id);
  if (!veh) throw new Error((await soldNote(s, company, id)) ?? `vehicle ${id} does not exist or is not owned by company ${company}; run: openttd-agent vehicles`);
  return veh;
}

/** Ledger text (L10) for a vehicle id this session sold, or null: sale date, replacement, vehicles now serving its stations. */
async function soldNote(s, company, id) {
  const e = s.soldVehicles?.get(`${company}:${id}`);
  if (!e) return null;
  const ids = e.stations?.length ? await stationVehicleIds(s, company) : null;
  const serving = ids ? [...new Set(e.stations.flatMap((st) => ids.get(st) ?? []))].sort((p, q) => p - q) : [];
  return soldText(e, serving);
}

/** Map vehicle -> { load, capacity, pct, cargo } from GS vehicle_loads (v13), or null on an older GameScript. */
async function vehicleLoads(s, company, vehicles) {
  try { return loadsFromRows(await s.gs.call('vehicle_loads', { company, ...(vehicles ? { vehicles } : {}) })); } catch (e) {
    if (/unknown cmd/.test(e.message)) return null;
    throw e;
  }
}

/**
 * --select FILTER (parseSelect) over the company's vehicles, minus vehicles queued for sale, at most `max`.
 * Returns { ids, matched, skipped_queued }.
 */
async function selectVehicles(s, company, text, max) {
  const f = parseSelect(text);
  const hit = filterVehicles(vehiclesFromRows(await s.gs.call('vehicles', { company })), f);
  const free = hit.filter((v) => !s.pendingSales.has(`${company}:${v.id}`));
  return { ids: free.slice(0, max).map((v) => v.id), matched: hit.length, skipped_queued: hit.length - free.length };
}
const selectArgs = (what, max) => ({
  select: z.string().optional().describe(`instead of --vehicles: ${what} the vehicles matching key=value filters, comma-separated (keys as vehicles: ids=1|2, type, group, state, engine, name, max_profit_last_year, max_profit_this_year, min_age_pct, min_age_days, max_reliability_pct); e.g. "type=road,min_age_pct=100"`),
  max: int().min(1).max(100).default(max).describe('with --select: at most this many vehicles'),
});

/**
 * vehicle-clone --station (R11): the best vehicle to copy among those with an order for `station`:
 * not queued for sale, not crashed, carrying `cargo` when given (vehicle_loads, v13), highest profit last year.
 * Returns { vehicle, unit_number, profit_last_year, candidates } or throws a refusal.
 */
async function cloneSourceAt(s, company, station, cargo) {
  const st = findStation(stationsFromRows(await s.gs.call('stations', { company }), s.cargos), station);
  const ids = await stationVehicleIds(s, company, st.id);
  if (!ids) throw new Error('refused: vehicle-clone --station needs AgentBridge v12; give --vehicle ID instead');
  const serving = new Set(ids.get(st.id) ?? []);
  let cands = vehiclesFromRows(await s.gs.call('vehicles', { company })).filter((v) => serving.has(v.id) && v.state !== 'crashed' && !s.pendingSales.has(`${company}:${v.id}`));
  if (cargo !== undefined) {
    const want = cargoId(s.cargos, cargo);
    const loads = await vehicleLoads(s, company, cands.map((v) => v.id));
    if (!loads) throw new Error('refused: --cargo with --station needs AgentBridge v13; give --vehicle ID instead');
    cands = cands.filter((v) => loads.get(v.id)?.cargo.some((c) => c.cargo === want));
  }
  if (!cands.length) throw new Error(`refused: no vehicle of yours with an order for ${st.name} (${st.id})${cargo !== undefined ? ` carries ${cargo}` : ''} that is not queued for sale; build one with vehicle-buy --orders`);
  const best = [...cands].sort((p, q) => q.profit_last_year - p.profit_last_year || q.profit_this_year - p.profit_this_year)[0];
  return { vehicle: best.id, unit_number: best.unit_number, profit_last_year: best.profit_last_year, station: { id: st.id, name: st.name }, candidates: cands.length };
}

/** Station ids in a vehicle's orders (for the sale ledger); [] when it cannot be read. */
async function orderStationIds(s, company, id) {
  try { return [...new Set((await currentOrderOf(s, company, id)).orders.filter((o) => o.kind === 'station').map((o) => o.station))]; } catch { return []; }
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
/** airport-sites for one town name: flat, noise-checked and (with your company) dry-run checked sites. */
async function airportSitesNear(s, towns, name, at, a) {
  const town = towns.find((t) => t.name.toLowerCase().includes(name.toLowerCase()));
  if (!town) throw new Error(`no town matching '${name}'`);
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
  return { town: { name: town.name, x: town.x, y: town.y, population: town.population, pax_unserved: town.pax_unserved, allowed_noise: town.allowed_noise }, sites: checked };
}

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
    // A copied order list may restart at order 0: point it back at the order it was heading for.
    if (d.current_order >= 0) oldSteps.push(['order_skip', id, d.current_order < pos ? d.current_order : d.current_order + 1]);
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
 * The passing loop whose track holds the signal tile (x, y), or null: walk the track both ways to
 * the nearest points, then findLoops on that stretch (AgentBridge v9). Used to refuse removing a
 * loop's signal (without it both trains enter the loop from opposite ends and crash or jam).
 */
async function loopOfTile(s, x, y) {
  const getTile = railTileSource(s);
  const t = await getTile(x, y);
  if (!t || t.kind !== 't') return null;
  const edges = [...trackEdges(t.tracks)];
  if (edges.length !== 2) return null;
  const toPoints = async (edge) => {
    const out = [];
    let cx = x + TRACE_DIRS[edge][0], cy = y + TRACE_DIRS[edge][1], entry = (edge + 2) % 4;
    for (let n = 0; n < 60; n++) {
      const u = await getTile(cx, cy);
      if (!u || !['t', 's', 'w'].includes(u.kind) || !trackEdges(u.tracks).has(entry)) return null;
      out.push({ x: u.x, y: u.y });
      if (trackEdges(u.tracks).size >= 3) return out;
      const ex = trackExits(u.tracks, entry);
      if (ex.length !== 1) return null;
      cx += TRACE_DIRS[ex[0]][0]; cy += TRACE_DIRS[ex[0]][1]; entry = (ex[0] + 2) % 4;
    }
    return null;
  };
  const back = await toPoints(edges[0]), ahead = await toPoints(edges[1]);
  if (!back || !ahead) return null;
  const path = [...back.reverse(), { x, y }, ...ahead];
  return (await findLoops({ path, getTile })).find((l) => l.from_index === 0 && l.to_index === path.length - 1) ?? null;
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

/**
 * The station a build just made or joined at tile x,y (R1): rail_tiles (v9) / road_tiles (v11) give the
 * station id on that tile; else the nearest of the company's stations within `reach` tiles. { id, name } or null.
 */
async function builtStationAt(s, company, x, y, kind, reach = 2) {
  const v = (await s.gs.call('info')).bridge_version ?? 0;
  let id = -1;
  if (kind === 'rail' && v >= 9) id = (await s.gs.call('rail_tiles', { x0: x, y0: y, x1: x, y1: y }))[0]?.[4] ?? -1;
  if (kind === 'road' && v >= 11) id = (await s.gs.call('road_tiles', { company, x0: x, y0: y, x1: x, y1: y }))[0]?.[4] ?? -1;
  const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
  const hit = id >= 0 ? stations.find((st) => st.id === id)
    : stations.map((st) => ({ st, d: tileDistance(st, { x, y }) })).filter((e) => e.d <= reach).sort((p, q) => p.d - q.d)[0]?.st;
  return hit ? { id: hit.id, name: hit.name } : null;
}

/** Run exec steps as the company (client throttle + GS rate gate apply; failures explained, see execExplained). */
async function run(ctx, a, steps, opts = {}) {
  const { s, company } = await mine(ctx, a);
  return execExplained(s, company, steps, { dryRun: a.dry_run, ...opts }, a);
}

/** The tile a step acts on: [op, x, y, ...] for most ops; rail [op, fx, fy, x, y, ...]; bridge/tunnel [op, type, x, y, ...]. */
function stepTile(step) {
  if (step[0] === 'rail' || step[0] === 'rail_remove') return { x: step[3], y: step[4] };
  if (step[0] === 'bridge' || step[0] === 'tunnel') return { x: step[2], y: step[3] };
  return typeof step[1] === 'number' && typeof step[2] === 'number' ? { x: step[1], y: step[2] } : null;
}

/** Tiles from (x1,y1) to (x2,y2) in a straight line (a road step), at most 200. */
function lineTiles(x1, y1, x2, y2) {
  const out = [];
  const dx = Math.sign(x2 - x1), dy = Math.sign(y2 - y1);
  for (let x = x1, y = y1; out.length < 200; x += dx, y += dy) { out.push({ x, y }); if (x === x2 && y === y2) break; if (!dx && !dy) break; }
  return out;
}

/** Local-authority detail for a refused step at `tile` (GS v13 town_rating), or a note on an older GameScript. */
async function authorityDetail(s, company, step, tile) {
  const need = authorityNeed(step[0]);
  let row;
  try { [row] = await s.gs.call('town_rating', { company, points: [[tile.x, tile.y]] }); } catch (e) {
    if (/unknown cmd/.test(e.message)) return { ...need, note: 'the running AgentBridge is older than v13: it cannot read town ratings; the host re-runs install-gamescript and loads the game again' };
    throw e;
  }
  const r = townRatingFromRow(row);
  if (r.town < 0) return { ...need, town: null };
  const { towns } = await s.economy();
  const name = towns.find((t) => t.id === r.town)?.name ?? `town ${r.town}`;
  return { town: r.town, town_name: name, rating: r.rating, rating_value: r.rating_value, ...need, hint: RATING_HINT };
}

/**
 * s.exec plus what a failure means (0.8.0):
 * - ERR_LOCAL_AUTHORITY_REFUSES (R8): local_authority { town, town_name, rating, rating_value, needed }.
 * - ERR_NOT_ENOUGH_CASH (L8): needed, money, loan, max_loan, loan_headroom, next; with a.borrow_if_needed
 *   the loan is raised by what the rest of the steps cost (dry run) and the rest is run once more.
 * - a dry run that costs more than the bank balance: the same money fields and a warning.
 * - a road step refused on a slope (R15): first_error sloped_tile, at, hint.
 */
async function execExplained(s, company, steps, opts, a = {}) {
  if (!opts.dryRun) s.throttleBuild();
  let res = await s.exec(company, steps, opts);
  const failed = (res.results ?? []).find((r) => !r.ok);
  if (opts.dryRun) {
    if (res.ok && res.money !== null && res.money !== undefined && res.cost > res.money) {
      const m = moneyDetail({ cost: res.cost, ...(await loanState(s, company)), money: res.money });
      res = { ...res, ...m, warnings: [...(res.warnings ?? []), `not_enough_money: this costs ${res.cost}, the bank has ${res.money}${m.next ? `; ${m.next}` : ''}`] };
    }
    return res;
  }
  if (!failed) return res;
  const step = steps[failed.step];
  const tile = stepTile(step);
  const err = String(failed.error ?? '');
  if (/ERR_NOT_ENOUGH_CASH/.test(err)) {
    const rest = steps.slice(failed.step);
    const est = await s.exec(company, rest, { ...opts, dryRun: true, keepGoing: true });
    const loan = await loanState(s, company);
    const m = moneyDetail({ cost: est.cost > 0 ? est.cost : null, ...loan });
    if (a.borrow_if_needed && m.needed && m.needed <= m.loan_headroom) {
      const lr = await s.exec(company, [['loan', 'add', m.needed]]);
      if (lr.ok) {
        const again = await s.exec(company, rest, opts);
        const done = res.results.slice(0, failed.step);
        const results = [...done, ...again.results.map((r) => ({ ...r, step: r.step + failed.step }))];
        return { ...again, borrowed: lr.results[0]?.value !== undefined ? lr.results[0].value - loan.loan : m.needed, cost: res.cost + again.cost,
          steps_total: steps.length, steps_done: done.filter((r) => r.ok).length + again.steps_done, results };
      }
      return { ...res, ...m, borrow_failed: lr.error };
    }
    return { ...res, ...m };
  }
  if (/ERR_LOCAL_AUTHORITY_REFUSES/.test(err) && tile) {
    const la = await authorityDetail(s, company, step, tile);
    const who = la.town_name ? `${la.town_name} rates you ${la.rating} (${la.rating_value}); ` : '';
    return { ...res, error: `${res.error}: local authority refuses: ${who}${la.needed_text}`, local_authority: la };
  }
  if (/ERR_LAND_SLOPED_WRONG|ERR_FLAT_LAND_REQUIRED/.test(err) && ['road', 'road_station', 'road_depot'].includes(step[0])) {
    const line = step[0] === 'road' ? lineTiles(step[1], step[2], step[3], step[4]) : [tile];
    const xs = line.map((t) => t.x), ys = line.map((t) => t.y);
    await s.refreshArea(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    const at = line.find((t) => s.map.inBounds(t.x, t.y) && s.map.slopeAt(t.x, t.y)) ?? tile;
    return { ...res, error: `sloped_tile: (${at.x},${at.y}) is sloped the wrong way for ${step[0] === 'road' ? 'this road' : 'a stop or depot'} (game: ${err})`, first_error: 'sloped_tile', at,
      hint: step[0] === 'road' ? `level it first (terraform --op level --x0 ${at.x} --y0 ${at.y}), or plan round it with build-road-path (it reuses roads and goes round obstacles)` : `pick a flat tile (road-stop-sites finds dry-run-checked spots), or terraform --op level --x0 ${at.x} --y0 ${at.y}` };
  }
  return res;
}

/**
 * OpenTTD versions for status: the server's (admin welcome) and, when this process runs on a
 * machine with OpenTTD, the local one. A mismatch matters to anyone joining from here.
 */
function openttdVersions(s, warnings) {
  const server = s.admin?.welcome?.revision ?? null;
  const cls = s.openttd ?? classifyVersion(server);
  let local = null;
  try { local = detectInstalledVersion(findExecutable()).version; } catch { /* no local OpenTTD */ }
  const cmp = compareHostClient(server, local);
  if (!cls.tested && cls.class !== 'unknown') warnings.push(cls.message);
  if (cmp.match === false) warnings.push(cmp.message);
  return { server, server_class: cls.class, local, match: cmp.match };
}

// ---- vehicles in the way (C5) ------------------------------------------------------------

const IN_THE_WAY = /ERR_VEHICLE_IN_THE_WAY/;
const blockedByVehicle = (res) => (res.results ?? []).some((r) => !r.ok && IN_THE_WAY.test(r.error ?? ''));

/** Tile box an exec step works on: { x0, y0, x1, y1 }. */
function stepBox(st) {
  const box = (ax, ay, bx = ax, by = ay) => ({ x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) });
  if (st[0] === 'rail' || st[0] === 'rail_remove') return box(st[3], st[4], st[5], st[6]);
  if (st[0] === 'road' || st[0] === 'road_remove') return box(st[1], st[2], st[3], st[4]);
  if (st[0] === 'bridge') return box(st[2], st[3], st[4], st[5]);
  if (st[0] === 'tunnel') return box(st[2], st[3]);
  return box(st[1], st[2]);
}

/**
 * ERR_VEHICLE_IN_THE_WAY on an exec result: add transient: true, blocked_at (the failed steps' tiles),
 * vehicles_in_the_way (your vehicles within 6 tiles of them; a train's position is its front) and,
 * in a dry run, blocked_by_vehicle: true. Other results come back unchanged.
 */
async function vehiclesInTheWay(s, company, steps, res) {
  if (!blockedByVehicle(res)) return res;
  const boxes = res.results.filter((r) => !r.ok && IN_THE_WAY.test(r.error ?? '')).map((r) => stepBox(steps[r.step]));
  const off = (v, b) => Math.max(b.x0 - v.x, 0, v.x - b.x1) + Math.max(b.y0 - v.y, 0, v.y - b.y1);
  let near = [];
  try {
    near = vehiclesFromRows(await s.gs.call('vehicles', { company }))
      .map((v) => ({ id: v.id, type: v.type, state: v.state, x: v.x, y: v.y, ...(v.speed !== undefined ? { speed: v.speed } : {}), tiles_away: Math.min(...boxes.map((b) => off(v, b))) }))
      .filter((v) => v.tiles_away <= 6).sort((p, q) => p.tiles_away - q.tiles_away).slice(0, 8);
  } catch { near = []; }
  return { ...res, transient: true, ...(res.dry_run ? { blocked_by_vehicle: true } : {}), blocked_at: boxes, vehicles_in_the_way: near,
    hint: 'a vehicle is on the tiles: wait until it has passed and run the same command again (or pass --wait_clear_s 30); a dry run cannot reserve the tiles' };
}

/**
 * s.exec that, when a step fails with ERR_VEHICLE_IN_THE_WAY, waits up to waitS seconds (real
 * time, game running) and retries from the failed step every 2 s; earlier steps are not repeated.
 * Returns an exec result over all steps, plus waited_s (and wait_note when the game is paused).
 */
async function execWaitClear(s, company, steps, opts, waitS, a = {}) {
  let res = await execExplained(s, company, steps, opts, a);
  if (opts.dryRun || !waitS || res.ok || !blockedByVehicle(res)) return res;
  if ((await s.gs.call('info')).paused) return { ...res, waited_s: 0, wait_note: 'the game is paused, so the vehicle will not move: unpause (or turn-advance) and run it again' };
  const t0 = Date.now();
  const done = [];
  let offset = 0, rest = steps;
  while (!res.ok && blockedByVehicle(res) && Date.now() - t0 < waitS * 1000) {
    const failed = res.results.find((r) => !r.ok);
    done.push(...res.results.filter((r) => r.step < failed.step).map((r) => ({ ...r, step: r.step + offset })));
    offset += failed.step;
    rest = rest.slice(failed.step);
    await sleep(2000);
    res = await execExplained(s, company, rest, opts, a);
  }
  const results = [...done, ...res.results.map((r) => ({ ...r, step: r.step + offset }))];
  const bad = results.find((r) => !r.ok);
  return { ...res, results, cost: done.reduce((n, r) => n + (r.cost ?? 0), 0) + res.cost, steps_total: steps.length, steps_done: results.filter((r) => r.ok).length,
    error: bad ? `step ${bad.step} (${bad.op}): ${bad.error ?? 'failed'}` : res.error, waited_s: Math.round((Date.now() - t0) / 1000) };
}

/** run() for track builds: --wait_clear_s and the vehicles-in-the-way report. */
async function runClear(ctx, a, steps, opts = {}) {
  const { s, company } = await mine(ctx, a);
  const res = await execWaitClear(s, company, steps, { dryRun: a.dry_run, ...opts }, a.wait_clear_s ?? 0, a);
  return vehiclesInTheWay(s, company, steps, res);
}

const waitClear = { wait_clear_s: int().min(0).max(300).default(0).describe('when a vehicle is in the way (ERR_VEHICLE_IN_THE_WAY), wait up to this many seconds for it to pass and retry from that step') };

/**
 * add-train (also build-cargo-route --if_exists add_train): line capacity and profit checks, clone at a
 * depot on the route, start, verify. `a`: { company, vehicle, count, force, dry_run }.
 */
async function addTrain(ctx, s, company, a) {
  const cap = await lineCapacity(s, company, a.vehicle, a.count, { cmd: 'add-train' });
  if (cap.stops.length < 2) throw new Error(`refused: vehicle ${a.vehicle} has fewer than two station orders`);
  const { check, tracer } = cap;
  if (!a.force && cap.refusal) return { ok: false, dry_run: a.dry_run, error: cap.refusal, first_error: 'needs_loop', check };
  const why = a.force ? null : unprofitableRefusal(await vehicleOf(s, company, a.vehicle));
  if (why) return { ok: false, dry_run: a.dry_run, error: why, first_error: 'source_unprofitable', check };
  const { depot, ...routeCheck } = await depotForRoute(s, company, { depot: 'auto', check_route: true }, a.vehicle, { cmd: 'vehicle-clone' });
  const res = await run(ctx, a, Array.from({ length: a.count }, () => ['veh_clone', depot.x, depot.y, a.vehicle, true]));
  const vehicles = res.results.filter((r) => r.ok && r.value !== undefined).map((r) => r.value);
  const out = { ...res, check, depot, ...routeCheck, vehicles };
  if (a.dry_run || !vehicles.length) return out;
  const started = await s.exec(company, vehicles.map((v) => ['veh_start_stop', v, 1]), { keepGoing: true });
  out.started = started.ok;
  if (tracer) {
    let leg = null;
    try { leg = await firstLeg(tracer, depot, cap.stops[0]); } catch { leg = null; }
    if (leg?.warning) out.warnings = [...(out.warnings ?? []), { depot_exit_detour: leg.warning }];
    try {
      const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
      const legs = await routeLegs(s, company, tracer, stations, await vehicleOf(s, company, vehicles[0]));
      out.verify = { connected: legs.connected, ...(legs.connected ? {} : { legs: legs.legs.filter((l) => !l.connected) }), ...(leg ? { first_leg: leg } : {}) };
      if (!legs.connected) { out.ok = false; out.error = `route_broken: the new train ${vehicles[0]} has no path to all its stations; see verify`; out.first_error = 'route_broken'; }
    } catch (e) { out.verify = { connected: null, error: e.message, ...(leg ? { first_leg: leg } : {}) }; }
  }
  return out;
}

/** "Wood: Forest 1 (10,20) -> Sawmill 2 (50,20) ..." for find-cargo-pairs --format lines. */
function pairLine(pr) {
  const end = (e) => `${e.kind === 'town' ? e.name : e.type} ${e.id} (${e.x},${e.y})`;
  const dry = pr.dry_run ? (pr.dry_run.ok ? `; dry run ok, cost ${pr.dry_run.estimated_cost}, ${pr.dry_run.line_tiles} tiles of track` : `; dry run failed at ${pr.dry_run.failed_step}: ${pr.dry_run.error}`) : '';
  const yours = pr.yours ? `; yours: ${pr.yours.from_station.name} -> ${pr.yours.to_station.name}${pr.yours.served_by !== null ? ` served by ${pr.yours.served_by}` : ' (unserved)'}` : '';
  const effort = pr.route?.reachable ? `, effort ${pr.route.effort_per_tile}/tile` : pr.route ? ', no route' : '';
  return `${pr.cargo}: ${end(pr.source)} -> ${end(pr.dest)}, ${pr.distance} tiles, ${pr.source_last_month}/month ${pr.source_transported_pct}% moved${effort}${yours}${dry} | ${pr.build}`;
}

/** build-cargo-route arguments for a find-cargo-pairs pair. */
const pairRouteArgs = (pr) => ({ ...(pr.source.kind === 'town' ? { from_town: pr.source.name } : { from_industry: pr.source.id }),
  ...(pr.dest.kind === 'town' ? { to_town: pr.dest.name } : { to_industry: pr.dest.id }), cargo: pr.cargo });

const quoteArg = (v) => (typeof v === 'string' && /\s/.test(v) ? `"${v}"` : String(v));

/** Why an empty find-cargo-pairs found nothing (L17): the biggest exclusion first, with the flag that loosens it. */
function pairsHint(excluded, a) {
  const fix = { distance: `--min_distance / --max_distance (now ${a.min_distance ?? PAIR_MIN_DIST}..${a.max_distance ?? PAIR_MAX_DIST})`, transported_pct: `--max_transported_pct (now ${a.max_transported_pct})`,
    min_production: `--min_production (now ${a.min_production})`, town_acceptance: '--dest_kind industry, or bigger towns', near: `--radius (now ${a.radius})`, region: 'a bigger --x0 --y0 --x1 --y1 box',
    yours: '--exclude_yours false (you already serve them)' };
  const parts = Object.entries(excluded).sort((p, q) => q[1] - p[1]).map(([k, n]) => `${n} by ${k} (${fix[k] ?? k})`);
  return parts.length ? `no pair left: ${parts.join('; ')}` : 'no producer of that cargo matched (check --cargo / --source_type / --source_id against industries)';
}

/**
 * find-cargo-pairs: findCargoPairs over the economy, plus your stations (yours / --exclude_yours),
 * --dry_run_top (build-cargo-route dry runs) and --format lines.
 */
async function findCargoPairsCommand(ctx, a) {
  const s = await ctx.session();
  const economy = await s.economy();
  const { industries, towns } = economy;
  if (a.with_effort) await s.ensureTiles();
  let townAcceptance = new Map();
  if (a.dest_kind !== 'industry' && towns.length) {
    const lists = await acceptanceAt(s, towns.map((t) => [t.x, t.y]), { radius: 4 });
    townAcceptance = lists && new Map(towns.map((t, i) => [t.id, Object.fromEntries(lists[i].map((c) => [c.cargo, c.acceptance]))]));
  }
  const townCargoFallback = new Set([...s.cargos.values()].filter((c) => c.town_effect > 0).map((c) => c.id));
  if ((a.near_x === undefined) !== (a.near_y === undefined)) throw new Error('give both --near_x and --near_y');
  const box = [a.x0, a.y0, a.x1, a.y1];
  if (box.some((v) => v !== undefined) && box.some((v) => v === undefined)) throw new Error('a region needs all four of --x0 --y0 --x1 --y1');
  const region = a.x0 !== undefined ? { x0: Math.min(a.x0, a.x1), y0: Math.min(a.y0, a.y1), x1: Math.max(a.x0, a.x1), y1: Math.max(a.y0, a.y1) } : null;
  const minDist = a.min_distance ?? PAIR_MIN_DIST, maxDist = a.max_distance ?? PAIR_MAX_DIST;
  const query = { industries, types: s.types, towns, cargos: s.cargos, townAcceptance, townCargoFallback, map: s.map, cargo: a.cargo, sourceType: a.source_type,
    destType: a.dest_type, destKind: a.dest_kind, minDist, maxDist, maxTransportedPct: a.max_transported_pct, minProduction: a.min_production,
    near: a.near_x !== undefined ? { x: a.near_x, y: a.near_y, radius: a.radius } : null, sourceId: a.source_id, destId: a.dest_id, region, sort: a.sort };
  // L1: pairs where your rail stations already sit at both ends, and whether a vehicle serves them.
  // No company arg: this stays a world query; the configured company is "you" (the relay sets it per player).
  const company = s.cfg.company ?? null;
  const yours = new Map();
  if (company !== null) {
    const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos).filter((st) => st.facilities.includes('rail'));
    if (stations.length) {
      const ends = new Map();
      const endOf = (e) => { const k = `${e.kind ?? 'industry'}:${e.id}`; if (!ends.has(k)) ends.set(k, lineEnd(s, economy, e.kind === 'town' ? { town: String(e.id) } : { industry: e.id })); return ends.get(k); };
      const served = new Map();
      for (const pr of findCargoPairs({ ...query, limit: 1e6, withEffort: false }).pairs) {
        const c = [...s.cargos.values()].find((q) => q.name === pr.cargo);
        const existing = findExistingRoute(stations, endOf(pr.source), endOf(pr.dest), c?.id, { radius: 10, bothWays: !!(c?.passengers || c?.mail) });
        if (!existing) continue;
        const sk = `${existing.from_station.id}>${existing.to_station.id}`;
        if (!served.has(sk)) served.set(sk, await vehicleServing(s, company, stations, existing.from_station.id, existing.to_station.id));
        yours.set(pairKey(pr), { ...existing, served_by: served.get(sk) });
      }
    }
  }
  const exclude = a.exclude_yours ? new Set([...yours].filter(([, y]) => y.served_by !== null).map(([k]) => k)) : null;
  const res = findCargoPairs({ ...query, limit: a.limit, withEffort: a.with_effort, exclude });
  for (const pr of res.pairs) {
    const y = yours.get(pairKey(pr));
    if (y) pr.yours = y;
    pr.build = `build-cargo-route ${Object.entries(pairRouteArgs(pr)).map(([k, v]) => `--${k} ${quoteArg(v)}`).join(' ')}`;
  }
  if (a.dry_run_top > 0) {
    const me = s.companyOrThrow();
    const schema = COMMANDS_BY_NAME.get('build-cargo-route').args;
    for (const pr of res.pairs.slice(0, a.dry_run_top)) {
      try {
        const r = await buildCargoRoute(s, me, schema.parse({ ...pairRouteArgs(pr), company: me, dry_run: true }), ctx);
        pr.dry_run = { ok: r.ok, estimated_cost: r.estimated_cost ?? null, line_tiles: r.line?.tiles ?? null, failed_step: r.failed_step ?? null,
          ...(r.ok ? { affordable: r.affordable } : { error: r.first_error ?? errorCode(r.error ?? 'failed') ?? r.error }) };
      } catch (e) { pr.dry_run = { ok: false, estimated_cost: null, line_tiles: null, failed_step: 'arguments', error: e.message }; }
    }
  }
  const head = { distance_bounds: { min: minDist, max: maxDist, ...(a.min_distance === undefined || a.max_distance === undefined ? { defaulted: 'pass --min_distance / --max_distance to change' } : {}) },
    ...(a.near_x !== undefined ? { near: { x: a.near_x, y: a.near_y, radius: a.radius } } : {}), ...(region ? { region } : {}),
    ...(yours.size ? { yours_found: yours.size } : {}), ...(company === null ? { yours_note: 'no company set, so your own routes are not marked or excluded' } : {}) };
  const out = { ...head, ...res, ...(res.excluded ? { hint: pairsHint(res.excluded, a) } : {}) };
  if (a.format === 'lines') { const { pairs, ...rest } = out; return { ...rest, lines: pairs.map(pairLine) }; }
  return out;
}

export const COMMANDS = [
  // ---- setup ------------------------------------------------------------------
  {
    name: 'doctor', group: 'setup', session: false,
    description: 'Check this machine: OpenTTD install (and macOS quarantine), personal dir, original graphics/music, GameScript version, and each launch profile\'s server (running, ports, whether its log shows the GameScript died). Run first.',
    args: z.object({}),
    run: () => {
      const report = doctor();
      report.servers = serverStates();
      for (const sv of report.servers) if (sv.running && sv.gamescript_in_log === 'died') report.next_steps.push(`server '${sv.server}': its log says the GameScript died; load the game again (load${sv.server === 'dedicated' ? '' : ` --server ${sv.server}`} --name <save>) and see server-log --errors true`);
      return report;
    },
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
    args: z.object({
      reload: bool().default(false).describe('true = also make the running server use it: rescan, save the game, load that save (it starts the newest AgentBridge), wait for the new bridge_version and restore the pause state'),
      server: serverArg.server,
      save_name: z.string().optional().describe('--reload: name of the save it makes and loads (default gs-reload-<date>-<time>)'),
    }),
    run: async (ctx, a) => (a.reload ? reloadGamescript(serverTarget(ctx.cfg, a.server), { saveName: a.save_name !== undefined ? checkSaveName(a.save_name) : undefined }) : installGamescript()),
  },
  {
    name: 'install-opengfx', group: 'setup', session: false,
    description: 'Download the free OpenGFX base graphics (official release from cdn.openttd.org, sha256 checked against its manifest) into your OpenTTD baseset folder. Needed when OpenTTD has no base graphics (doctor: base_graphics.found false); a dedicated server does not start without one. Does nothing when OpenGFX is already there. --dry_run true says what it would download.',
    args: z.object({ dry_run: bool().default(false).describe('true = only say what it would download and where') }),
    run: (_ctx, a) => installOpenGfx(findPersonalDir(), { dryRun: a.dry_run }),
  },
  {
    name: 'configure', group: 'setup', session: false,
    description: `Save settings to ${CONFIG_FILE} (with the global --profile NAME or OPENTTD_AGENT_PROFILE: to ~/.openttd-agent/players/NAME.json instead, so several players or agents on one machine each keep their own relay token). PLAYER: relay (http://<host-LAN-IP>:<port>) and token, both from the host; game commands then go through the host's relay as the company the host bound you to. HOST: admin_password (stays on this machine), admin_port, relay_port. Either: max_builds_per_minute (0 = unlimited). relay "" switches back to the admin port directly.`,
    args: z.object({
      relay: z.string().optional().describe('player: relay URL, e.g. http://192.0.2.20:47978 ("" = off)'),
      token: z.string().optional().describe('player: token from the host (relay-add-player)'),
      host: z.string().optional(), admin_port: int().optional(), admin_password: z.string().optional().describe('host only'),
      relay_port: int().min(1).max(65535).optional().describe('host: port the relay listens on'),
      company: int().optional().describe('direct mode only; with a relay the host decides your company'),
      max_builds_per_minute: int().min(0).optional(), tile_refresh_rows_per_sec: int().min(0).optional(),
      accept_untested: bool().optional().describe('true = connect to / launch an OpenTTD version openttd-agent was not tested with (beta, nightly, newer release); also OPENTTD_AGENT_ACCEPT_UNTESTED=1'),
    }),
    run: (_ctx, { token, ...a }) => {
      if (a.relay) {
        let url;
        try { url = new URL(a.relay); } catch { throw new Error(`relay must be a URL like http://192.0.2.20:47978, got '${a.relay}'`); }
        if (url.protocol !== 'http:') throw new Error('relay must be an http:// URL (the relay speaks plain HTTP on the LAN)');
        a.relay = url.origin;
      }
      const saved = redacted(saveConfig({ ...a, ...(token !== undefined ? { relay_token: token } : {}) }));
      const net = a.relay ? diagnoseAddress(a.relay) : null;
      return net?.hint ? { ...saved, network: net, hint: net.hint } : saved;
    },
  },
  {
    name: 'net-check', group: 'setup', session: false,
    description: "Network diagnosis, read-only and without admin rights. --role player (default when a relay is configured): classifies the host address (loopback, private LAN, CGNAT/mesh VPN, link-local, public) against this machine's subnets and test-connects the relay and game ports; a private address on another network gets hint + options (OpenTTD invite codes for the game; a mesh VPN or tunnel for the relay, links only). --role host: who listens on the game/admin/relay ports and on which address (lsof), a self-connect on the LAN address, the firewall state (macOS socketfilterfw incl. whether OpenTTD and node are blocked; Linux ufw/firewalld; Windows netsh) and `fixes`: allow the app or port on private networks, never turn the firewall off.",
    args: z.object({
      role: z.enum(['host', 'player']).optional().describe('default: player when a relay is configured, else host'),
      target: z.string().optional().describe('player: host address or relay URL to check (default: the configured relay, else host)'),
      ...serverArg,
      game_port: int().min(1).max(65535).optional().describe('default: the server profile\'s, else 3979'),
      relay_port: int().min(1).max(65535).optional().describe('default: the port in the relay URL, else the configured relay_port'),
      probe: bool().optional().describe('player: also test-connect a private address that is on none of this machine\'s subnets (skipped by default: it is almost always another LAN)'),
    }),
    run: async (ctx, a) => {
      const role = a.role ?? (ctx.cfg.relay ? 'player' : 'host');
      if (role === 'player') {
        const target = a.target ?? (ctx.cfg.relay || ctx.cfg.host);
        let relayPort = a.relay_port;
        if (relayPort === undefined) { try { relayPort = Number(new URL(/^[a-z]+:\/\//i.test(target) ? target : `http://${target}`).port) || ctx.cfg.relay_port; } catch { relayPort = ctx.cfg.relay_port; } }
        return playerCheck({ target, probe: a.probe, ports: [{ port: relayPort, role: 'relay' }, { port: a.game_port ?? 3979, role: 'game' }] });
      }
      let t = null;
      try { t = serverTarget(ctx.cfg, a.server); } catch (e) { if (a.server) throw e; }
      const ports = [{ port: a.game_port ?? t?.game_port ?? 3979, role: 'game' }, { port: t?.admin_port ?? ctx.cfg.admin_port, role: 'admin' }, { port: a.relay_port ?? ctx.cfg.relay_port, role: 'relay' }];
      return { server: t?.server ?? null, ...(await hostCheck({ ports, exe: findExecutable() })) };
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
    description: 'Start OpenTTD with the right settings. mode=dedicated: headless LAN server with AgentBridge (everyone joins as a client); waits until the admin port and AgentBridge answer (ready, bridge_version, seconds; not_ready with the process state and log tail otherwise). A server already running from this profile is reported (already_running) and left alone unless --restart true. mode=host: GUI with server settings preset; then Multiplayer > Start Server. mode=join: GUI client joining join_host. --server NAME --game_port --admin_port runs another server beside the first (its own profile; host commands take the same --server). Never edits your own openttd.cfg (uses a profile in ~/.openttd-agent/profiles/<server>); rotates the profile\'s openttd.log (keeps 3). --dry_run true writes nothing.',
    args: z.object({
      mode: z.enum(['dedicated', 'host', 'join']).default('dedicated'),
      server: z.string().optional().describe('launch profile name (default: the mode). A second name with its own --game_port/--admin_port runs a second server on this machine; later host commands pick it with --server NAME'),
      game_port: int().min(1).max(65535).optional().describe('default 3979, or what this --server used last time'),
      admin_port: int().min(1).max(65535).optional().describe('default: the configured admin_port (3977), or what this --server used last time'),
      admin_password: z.string().optional().describe('dedicated/host: defaults to the configured admin_password; if there is none, a random one is generated and saved in the config (it never needs to leave this machine)'),
      join_host: z.string().optional().describe('host LAN IP for mode=join; defaults to configured host'),
      seed: int().optional(), map_bits: int().min(6).max(12).default(8).describe('map size as power of two: 8=256, 9=512, 10=1024'),
      load: z.string().optional().describe('savegame to load instead of generating a new map: a path, or a save name from the profile\'s save/ folder (e.g. the one scenario-prepare printed)'),
      command_delay_ticks: int().min(0).max(74).default(0).describe('GameScript rate limit: extra ticks after each build command (0 = full speed)'),
      max_builds_per_day: int().min(0).default(0).describe('GameScript rate limit per company per game day (0 = unlimited)'),
      terrain: z.enum(TERRAIN_TYPES).optional().describe('new maps only; default: whatever your openttd.cfg says (OpenTTD default flat)'),
      script_opcodes: int().min(500).max(250000).default(100000).describe('host: opcodes the GameScript may run per tick (OpenTTD default 10000); higher = faster map mirror and replies'),
      bind: z.string().default('0.0.0.0'),
      restart: bool().default(false).describe('true = stop a server already running from this profile (console quit, then SIGTERM by its cfg path) and start again'),
      wait: bool().optional().describe('wait until ready (default true for mode=dedicated; host/join open a window and are not waited for)'),
      wait_s: int().min(1).max(280).default(60).describe('how long to wait for ready'),
      accept_untested: bool().optional().describe('true = start an OpenTTD version openttd-agent was not tested with (beta, nightly, newer release); default: config accept_untested or OPENTTD_AGENT_ACCEPT_UNTESTED=1'),
      dry_run: bool().default(false).describe('true = show the command line and the files it would write; writes and starts nothing'),
    }),
    run: async (ctx, a) => {
      const hosting = a.mode !== 'join';
      const exe = findExecutable();
      const ottd = classifyVersion(exe ? detectInstalledVersion(exe).version : null);
      const refusal = exe ? versionRefusal(ottd, acceptUntested({ arg: a.accept_untested, cfg: ctx.cfg.accept_untested }), `installed OpenTTD (${exe})`) : null;
      if (!exe && !a.dry_run) throw new Error(`openttd_not_found: ${installHint()}`);
      if (refusal && !a.dry_run) throw new Error(refusal);
      const server = a.server ?? a.mode;
      const dir = profileDir(server);
      const prev = a.server ? profilePorts(dir) : {};
      const adminPort = a.admin_port ?? prev.admin_port ?? ctx.cfg.admin_port;
      const gamePort = a.game_port ?? prev.game_port ?? 3979;
      const host = hosting ? adminHostForBind(a.bind) : null;
      const primary = hosting && adminPort === ctx.cfg.admin_port;
      let adminPassword = a.admin_password ?? ctx.cfg.admin_password;
      const generated = hosting && !adminPassword;
      if (generated) adminPassword = randomBytes(24).toString('base64url');
      const cfgPath = path.join(dir, 'openttd.cfg');
      const target = { server, dir, cfgPath, host, admin_port: adminPort, game_port: gamePort, password: adminPassword, local: true };
      const running = serverPids(cfgPath);
      const opts = {
        mode: a.mode, server, adminPassword, joinHost: a.join_host ?? ctx.cfg.host, adminPort, gamePort,
        seed: a.seed, mapBits: a.map_bits, load: a.load, commandDelayTicks: a.command_delay_ticks,
        maxBuildsPerDay: a.max_builds_per_day, scriptOpcodes: a.script_opcodes, terrain: a.terrain, bind: a.bind, dryRun: a.dry_run,
      };
      if (a.dry_run) {
        const { result } = launch(opts);
        return { ...result, openttd: { version: ottd.version, class: ottd.class, ...(refusal ? { would_refuse: refusal } : {}) }, ...(running?.length ? { running_now: running } : {}), ...(generated ? { admin_password: 'would be generated' } : {}),
          ...(primary && host !== ctx.cfg.host ? { admin_host: `would be saved as host: ${host}` } : {}) };
      }
      let restarted = null;
      if (hosting && running?.length) {
        if (!a.restart) {
          const probe = await waitReady({ ...target, password: ctx.cfg.admin_password || adminPassword }, { timeoutMs: 4000 });
          return { already_running: true, server, pids: running, admin_port: adminPort, game_port: gamePort, ready: probe.ready,
            ...(probe.ready ? { bridge_version: probe.bridge_version, paused: probe.paused } : { stage: probe.stage }),
            note: `a server from profile '${server}' is already running; nothing was started. Use it, or: launch --restart true (or server-stop${a.server ? ` --server ${server}` : ''})` };
        }
        restarted = await stopServer({ ...target, password: ctx.cfg.admin_password || adminPassword });
      }
      if (hosting) {
        const busy = [];
        for (const p of [adminPort, gamePort]) if (await portOpen(host, p)) busy.push(p);
        if (busy.length) throw new Error(`port_in_use: ${busy.map((p) => portHolderText(p, listeners(p))).join(' and ')} on ${host} is taken by another program or server (not profile '${server}'). Pick others: launch --server ${server === a.mode ? 'NAME' : server} --game_port N --admin_port M`);
      }
      const { result, child } = launch(opts);
      result.openttd = { version: ottd.version, class: ottd.class };
      const notes = [];
      if (hosting && !findBasesets(findPersonalDir()).length) notes.push('no base graphics found: a dedicated server will not start without one. Run openttd-agent install-opengfx, then launch again');
      const low = diskWarning(freeBytes(dir), `saves in ${dir}`);
      if (low) notes.push(low);
      if (hosting) { const awake = keepAwakeHint(result.pid); if (awake) result.keep_awake = awake; }
      if (notes.length) result.warnings = notes;
      let exitCode;
      child.on('exit', (code, signal) => { exitCode = code ?? signal; });
      // The relay and the CLI on this machine read the password and admin address from the config, so keep them in step
      // for the server the config points at (a side server on other ports leaves the config alone).
      const updates = {
        ...(hosting && (primary || generated) && adminPassword !== ctx.cfg.admin_password ? { admin_password: adminPassword } : {}),
        ...(primary && host !== ctx.cfg.host ? { host } : {}),
      };
      if (Object.keys(updates).length) saveConfig(updates);
      const out = { ...result, ...(restarted ? { restarted } : {}), ...(generated ? { admin_password: 'generated and saved in the config' } : {}),
        ...(updates.host ? { admin_host: `saved as host: ${host} (the server listens only there)` } : {}),
        ...(hosting && !primary ? { side_server: `the config still points at admin port ${ctx.cfg.admin_port}. Host commands: --server ${server}. Game commands: OPENTTD_AGENT_ADMIN_PORT=${adminPort} openttd-agent <command> --no-daemon` } : {}) };
      if (!(a.wait ?? a.mode === 'dedicated')) return out;
      const ready = await waitReady(target, { timeoutMs: a.wait_s * 1000, exited: () => exitCode });
      if (ready.ready) return { ...out, ...ready };
      const detail = notReadyDetail(target, { pid: result.pid, exitCode });
      // launch --load with a save it cannot read: the server logs why and exits (verified on 14.1 with a 15.3 save).
      const why = a.load ? loadProblem(detail.log_tail.join('\n')) : null;
      if (why) return { ...out, ok: false, error: `${loadProblemText(why)} (${a.load}); the server exited`, ...ready, ...detail };
      return { ...out, ok: false, error: `not_ready: server '${server}' was not ready within ${a.wait_s}s (stage: ${ready.stage}${ready.last_error ? `: ${ready.last_error}` : ''}). See process and log_tail; server-log${a.server ? ` --server ${server}` : ''} shows more`,
        ...ready, ...detail };
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

  // ---- host server control (session: false: own admin connection; refused through the relay) ----
  {
    name: 'saves', group: 'host', session: false,
    description: "HOST ONLY: savegames in the server's save folder (the launch profile's save/), newest first: name (what load --name and launch --load take), bytes, modified.",
    args: z.object({ ...serverArg, match: z.string().optional().describe('only names containing this text'), limit: int().min(1).max(1000).default(50) }),
    run: (ctx, a) => {
      const t = serverTarget(ctx.cfg, a.server);
      const { folder, saves } = listSaves(t.dir);
      const matched = a.match ? saves.filter((x) => x.name.toLowerCase().includes(a.match.toLowerCase())) : saves;
      return { server: t.server, folder, ...listResult('saves', saves, matched, a.limit) };
    },
  },
  {
    name: 'load', group: 'host', session: false,
    description: "HOST ONLY: load a save on the running server (console ls, then load by its index) and wait until AgentBridge answers in the new game. Returns loaded, map, date, paused, bridge_version, seconds. --pause true/false sets the pause state after loading (default: as saved; a game saved paused loads paused). Every player's session reconnects on its next call. A save runs the GameScript stored in it: one made without AgentBridge will not answer (scenario-prepare makes a copy that does).",
    args: z.object({ ...serverArg, name: z.string().describe('save name as `saves` lists it (with or without .sav)'), pause: bool().optional().describe('true = pause after loading, false = unpause; default as saved') }),
    run: async (ctx, a) => {
      const t = serverTarget(ctx.cfg, a.server);
      return { server: t.server, ...(await withAdmin(t, (admin, gs) => loadSave(admin, gs, checkSaveName(a.name), { pause: a.pause, dir: t.dir }))) };
    },
  },
  {
    name: 'server-stop', group: 'host', session: false,
    description: "HOST ONLY: stop the server (console quit; if it does not exit, SIGTERM to the processes started with this profile's openttd.cfg, and nothing else). --save NAME saves first and waits for the file; without the save it does not quit. Returns was_running, stopped, method.",
    args: z.object({ ...serverArg, save: z.string().optional().describe('save under this name before quitting') }),
    run: async (ctx, a) => stopServer(serverTarget(ctx.cfg, a.server), { save: a.save !== undefined ? checkSaveName(a.save) : undefined }),
  },
  {
    name: 'console', group: 'host', session: false,
    description: 'HOST ONLY escape hatch: run one server console command over the admin port (rcon) and return its output lines, e.g. "setting command_pause_level", "list_ai", "companies". Prefer the dedicated commands (load, saves, pause, company-new, server-stop). Console `companies` numbers from 1; every other openttd-agent command from 0.',
    args: z.object({ ...serverArg, command: z.string().min(1).describe('console command line') }),
    run: async (ctx, a) => {
      const t = serverTarget(ctx.cfg, a.server);
      const lines = await withAdmin(t, (admin) => admin.rcon(a.command, 30000), { name: 'openttd-agent-console' });
      return { server: t.server, command: a.command, lines };
    },
  },
  {
    name: 'company-new', group: 'host', session: false,
    description: 'HOST ONLY: start an AI company on the server (console start_ai) and return its company id (0-based, as every other command uses). IdleAI (installed by install-gamescript) builds nothing: a test company to act as with --company.',
    args: z.object({ ...serverArg, ai: z.string().default('IdleAI').describe('AI name as `console --command list_ai` shows it') }),
    run: async (ctx, a) => {
      const t = serverTarget(ctx.cfg, a.server);
      return { server: t.server, ...(await withAdmin(t, (admin, gs) => companyNew(admin, gs, a.ai))) };
    },
  },
  {
    name: 'server-log', group: 'host', session: false,
    description: "HOST ONLY: the end of the server's openttd.log (the launch profile's; launch rotates it, keeping 3). --errors true keeps only error lines (script errors, crashes); --grep TEXT only lines containing TEXT. `gs` says whether AgentBridge started and whether a script died after that (state started / died / not_started).",
    args: z.object({ ...serverArg, lines: int().min(1).max(500).default(40), errors: bool().default(false), grep: z.string().optional() }),
    run: (ctx, a) => {
      const t = serverTarget(ctx.cfg, a.server);
      const tail = logTail(t.dir, { lines: a.lines, errors: a.errors, grep: a.grep });
      if (!tail.exists) return { ok: false, error: `no_log: ${tail.file} does not exist (start the server with openttd-agent launch)`, server: t.server };
      const pids = serverPids(t.cfgPath);
      return { server: t.server, running: pids === null ? null : pids.length > 0, ...tail };
    },
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
    description: 'Game date (`date` "YYYY-MM-DD"; raw in info), map size, pause state, your company (`me`: money, loan, max_loan, value, cargo_delivered, performance, profit of the last full quarter; never read companies[0], it is not necessarily you), rate limits, tile-mirror progress, versions (openttd-agent, running and bundled AgentBridge), background_jobs (queued vehicle sales and wagon jobs, the periodic save; kept in ~/.openttd-agent/jobs-<host>-<port>.json per game, so they survive a daemon restart) and warnings (an outdated GameScript or, through a relay, a different openttd-agent version on the host).',
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
      return { date: dateString(info), info, my_company: s.cfg.company, me: meFromCompanies(companies, s.cfg.company), companies, rate, client_max_builds_per_minute: s.cfg.max_builds_per_minute,
        tile_mirror: { rows_loaded: loaded, rows_total: s.map.sizeY, load_ms: s.tileLoadMs ?? null },
        versions: { openttd_agent: VERSION, gamescript_running: running, gamescript_bundled: bundled }, openttd: openttdVersions(s, warnings), background_jobs: s.backgroundJobs(), warnings };
    },
  },
  {
    name: 'companies', group: 'game', session: true,
    description: 'All companies (and the game `date`): money, loan, and for the last full quarter (`period`, e.g. "1951 Q2") income, expenses (negative), profit (income + expenses), company value, cargo delivered and performance rating; station_count and vehicles_by_type {rail, road, water, air} (AgentBridge v12; the company window shows both to anyone). --history N adds the last N quarters per company (`history`: period, value, income, expenses, profit, delivered, performance; newest first; AgentBridge v12). Use for competitor assessment.',
    args: z.object({ history: int().min(0).max(24).default(0).describe('quarters of history per company (0 = none)') }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const [info, rows] = await Promise.all([s.gs.call('info'), s.gs.call('companies')]);
      const out = [];
      for (const c of rows) {
        const { vehicles_by_type: vt, ...rest } = c;
        const row = { ...rest, profit: companyProfit(c), period: quarterLabel(info, 1), ...(vt ? { vehicles_by_type: { rail: vt[0], road: vt[1], water: vt[2], air: vt[3] } } : {}) };
        if (a.history > 0) {
          try {
            const h = await s.gs.call('company_history', { company: c.id, quarters: a.history });
            row.history = h.filter((r) => r[0] >= 1).sort((p, q) => p[0] - q[0])
              .map(([q, value, income, expenses, delivered, performance]) => ({ period: quarterLabel(info, q), value, income, expenses, profit: income + expenses, delivered, performance }));
          } catch (e) {
            if (!/unknown cmd/.test(e.message)) throw e;
            row.history = null;
            row.history_note = 'needs AgentBridge v12; the host re-runs install-gamescript and loads the game again';
          }
        }
        out.push(row);
      }
      return { date: dateString(info), ...listResult('companies', out, out) };
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
    description: "HOST ONLY: save the running server game over the console (`save <name>`). OpenTTD writes it to the launch profile's save folder (save/<name>.sav next to the profile's openttd.cfg); load it again with launch --load <name>. Name: letters, digits, _ . - only (no paths). Periodic saves: --every_months N --prefix P makes the daemon save P-YYYY-MM every N game months (checked every 20 s while the game runs; also once now); --every_months 0 stops; with neither name nor every_months it shows the schedule. The daemon (or MCP server) runs the schedule; it is kept in ~/.openttd-agent/jobs-<host>-<port>.json for this game and resumes when the daemon reconnects to the same game.",
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
    description: 'Towns with population and last-month passenger/mail production and transported %. Filter by min_population, name, id, near_x/near_y within radius (each row then has distance); sorted by population (by distance with near_x/near_y). With a company (yours by default): my_rating {rating, value, rated} = what the town\'s local authority thinks of the company (the town window\'s word: none, appalling, very_poor, poor, mediocre, good, very_good, excellent, outstanding; value -1000..1000; a new station needs more than -200). AgentBridge v13.',
    args: z.object({ ...who, min_population: int().default(0), limit: int().default(50), name: z.string().optional(), id: int().optional(),
      near_x: int().optional(), near_y: int().optional(), radius: int().min(1).default(50) }),
    run: async (ctx, a) => {
      if ((a.near_x === undefined) !== (a.near_y === undefined)) throw new Error('give both --near_x and --near_y');
      const s = await ctx.session();
      const { towns } = await s.economy();
      const near = a.near_x !== undefined ? { x: a.near_x, y: a.near_y } : null;
      let hits = towns.filter((t) => t.population >= a.min_population && (!a.name || t.name.toLowerCase().includes(a.name.toLowerCase())) && (a.id === undefined || t.id === a.id))
        .map((t) => (near ? { ...t, distance: manhattan(t, near) } : t)).filter((t) => !near || t.distance <= a.radius)
        .sort((x, y) => (near ? x.distance - y.distance : y.population - x.population));
      const company = a.company ?? s.cfg.company;
      let note = null;
      if (company !== null && company !== undefined && hits.length) {
        const shown = hits.slice(0, a.limit);
        try {
          const rows = new Map((await s.gs.call('town_rating', { company, towns: shown.map((t) => t.id) })).map((r) => [r[0], townRatingFromRow(r)]));
          hits = [...shown.map((t) => { const r = rows.get(t.id); return r ? { ...t, my_rating: { rating: r.rating, value: r.rating_value, rated: r.rated } } : t; }), ...hits.slice(a.limit)];
        } catch (e) {
          if (!/unknown cmd/.test(e.message)) throw e;
          note = 'my_rating needs AgentBridge v13; the host re-runs install-gamescript and loads the game again';
        }
      }
      return { ...(company !== null && company !== undefined ? { company } : {}), ...listResult('towns', towns, hits, a.limit), ...(note ? { my_rating_note: note } : {}) };
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
    description: `Opportunity finder: under-served producers of a cargo paired with destinations min_distance..max_distance tiles away: industries that accept it, and towns whose centre area accepts it (acceptance >= ${ACCEPTED} within radius 4; goods, passengers, mail, food...). Ranked by terrain effort of the route (water, hills, towns, existing track). Each dest has kind industry|town. Passengers and mail pair town with town (source kind town, source_last_month = the town's last-month production); feed both names to build-cargo-route --from_town --to_town. Secondary producers (sawmill, factory, refinery...) are marked secondary: true; they show last_month 0 until supplied. Distance defaults to ${PAIR_MIN_DIST}..${PAIR_MAX_DIST} tiles (distance_bounds says which applied); --near_x/--near_y/--radius keeps sources near a tile (e.g. your network). Example: cargo=goods, dest_kind=town, min_distance=20. Filters: --source_id / --dest_id (industry or town id), a region box --x0 --y0 --x1 --y1 (both ends inside), --sort effort|revenue|distance|production. yours {from_station, to_station, served_by} marks pairs where your rail stations already sit at both ends; --exclude_yours true (default) drops the ones a vehicle of yours serves. When nothing is left, excluded counts each reason (distance, transported_pct, min_production, town_acceptance, near, region, yours) with a hint. --dry_run_top N dry-runs build-cargo-route for the first N pairs (dry_run {ok, estimated_cost, line_tiles, failed_step, error}). --format lines gives one line per pair (lines[]) instead of pairs[]. Each pair has build (the build-cargo-route command).`,
    args: z.object({
      cargo: z.string().optional(), source_type: z.string().optional(), dest_type: z.string().optional().describe("industry type name, or 'town' / a town name"),
      dest_kind: z.enum(['any', 'industry', 'town']).default('any'),
      min_distance: int().optional().describe(`default ${PAIR_MIN_DIST}`), max_distance: int().optional().describe(`default ${PAIR_MAX_DIST} (a train route of 900 tiles takes years per trip)`), max_transported_pct: int().default(100),
      near_x: int().optional(), near_y: int().optional(), radius: int().min(1).default(60).describe('with near_x/near_y: sources within this many tiles'),
      min_production: int().default(0).describe('primary sources only; secondary ones are kept'), limit: int().default(10), with_effort: bool().default(true),
      source_id: int().optional().describe('only this source (industry id; town id for passengers/mail)'), dest_id: int().optional().describe('only this destination (industry or town id)'),
      x0: int().optional(), y0: int().optional(), x1: int().optional(), y1: int().optional().describe('region box x0,y0..x1,y1: both ends inside'),
      sort: z.enum(['effort', 'revenue', 'distance', 'production']).default('effort').describe('effort: easiest terrain per tile (default); revenue: unserved volume x distance; distance: shortest first; production: biggest source first'),
      exclude_yours: bool().default(true).describe('drop pairs one of your vehicles already serves (your rail stations at both ends)'),
      dry_run_top: int().min(0).max(5).default(0).describe('dry-run build-cargo-route for the first N pairs: dry_run {ok, estimated_cost, line_tiles, failed_step}'),
      format: z.enum(['json', 'lines']).default('json').describe('lines: one text line per pair instead of pairs[]'),
    }),
    run: (ctx, a) => findCargoPairsCommand(ctx, a),
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
    description: 'Find places to build an airport near a town: flat buildable rectangles of the airport size within radius, each checked for town noise limit and (with your company) a dry-run build with cost. With your company (AgentBridge v10), your owned land counts as buildable and each site has owned: true when its whole footprint is your owned land; those sites come first. --towns A,B checks several towns in one call.',
    args: z.object({
      town: z.string().optional().describe('town name (substring)'),
      towns: z.string().optional().describe('comma-separated town names: one call checks several towns (result: towns[{town, sites}])'),
      airport: z.string().default('small').describe('airport type name, see airport-types'),
      radius: int().default(20), max_height_spread: int().default(0), limit: int().default(5).describe('sites per town'),
    }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const names = a.towns !== undefined ? a.towns.split(',').map((t) => t.trim()).filter(Boolean) : a.town !== undefined ? [a.town] : [];
      if (!names.length) throw new Error('bad_arguments: give --town NAME or --towns A,B');
      const [{ towns }, types] = await Promise.all([s.economy(), s.gs.call('airport_types'), s.ensureTiles()]);
      const at = types.find((t) => t.name === a.airport.toLowerCase());
      if (!at) throw new Error(`unknown airport '${a.airport}'. Available: ${types.map((t) => t.name).join(', ')}`);
      if (a.towns === undefined) return { ...(await airportSitesNear(s, towns, names[0], at, a)), airport: at };
      const out = [];
      for (const name of names) {
        try { out.push(await airportSitesNear(s, towns, name, at, a)); } catch (e) { out.push({ town: { name }, error: e.message, sites: [] }); }
      }
      return { airport: at, towns: out };
    },
  },
  {
    name: 'tiles', group: 'world', session: true,
    description: 'Terrain mirror for a rectangle (--x0 --y0 --x1 --y1, or --x --y --radius R): --format json (default, max 40x40): height, slope and class per tile (water, clear, trees, other=houses/objects, rail, road, station, industry...), and (AgentBridge v12) who owns it: "*" = your company, "#" = another company (rail rows in an area are not necessarily yours). --format text (max 80x80): one character per tile (the class letter, UPPER case = owned by your company), an x ruler (one line per digit, read downwards) and rows "y|chars"; heights are left out.',
    args: z.object({ ...who, x0: int().optional(), y0: int().optional(), x1: int().optional(), y1: int().optional(),
      x: int().optional().describe('centre x (with --y and --radius, instead of x0..y1)'), y: int().optional(), radius: int().min(0).max(40).optional().describe('tiles around x,y (default 5)'),
      format: z.enum(['json', 'text']).default('json').describe('text = one character per tile with rulers (max 80x80)'),
      refresh: bool().default(true) }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const box = tileBox(a, s.map.sizeX, s.map.sizeY);
      const max = a.format === 'text' ? 80 : 40;
      if (box.x1 - box.x0 + 1 > max || box.y1 - box.y0 + 1 > max) throw new Error(`area too large; max ${max}x${max} tiles${a.format === 'text' ? '' : ' (--format text takes up to 80x80)'}`);
      const me = a.company ?? s.cfg.company;
      if (a.refresh) await s.refreshArea(box.x0, box.y0, box.x1, box.y1); else await s.ensureTiles();
      let owners = new Map();
      try {
        for (const part of splitBox(box, 40)) for (const [x, y, o] of await s.gs.call('tile_owners', part)) owners.set(`${x},${y}`, o);
      } catch (e) { if (!/unknown cmd/.test(e.message)) throw e; owners = null; }
      const ownerAt = owners ? (x, y) => owners.get(`${x},${y}`) : null;
      const oldGs = owners ? {} : { owners: 'not shown: the running AgentBridge is older than v12' };
      const classes = 'w water c coast i industry s station r rail d road t trees f farm k rocks h rough b clear o other(houses/objects)';
      if (a.format === 'text') {
        const text = tilesText(box, (x, y) => s.map.classAt(x, y), ownerAt, me);
        return { legend: `one character per tile: ${classes}${owners ? '; UPPER case = owned by your company' : ''}. x ruler: one line per digit, read downwards; rows: "y|tiles"`,
          ...oldGs, ...box, ...text };
      }
      const mark = (x, y) => { const o = ownerAt?.(x, y); return o === undefined ? '' : o === me ? '*' : '#'; };
      const rows = [];
      for (let y = box.y0; y <= box.y1; y++) {
        const r = [];
        for (let x = box.x0; x <= box.x1; x++) r.push(`${s.map.classAt(x, y)}${s.map.heightAt(x, y)}${s.map.slopeAt(x, y) ? '/' : ''}${mark(x, y)}`);
        rows.push({ y, tiles: r.join(' ') });
      }
      return { legend: `class letter + height, "/" = sloped${owners ? ', "*" = owned by your company, "#" = by another company' : ''}. ${classes}`,
        ...oldGs, x0: box.x0, rows };
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
      const mineSigns = (await s.gs.call('signs', { company })).map(([id, x, y, owner, text]) => ({ id, x, y, owner, text })).filter((g) => g.owner === company);
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
      const all = (await s.gs.call('signs', { company })).filter((r) => r[3] === company).map(([id, x, y, , text]) => ({ id, x, y, text }));
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
    description: 'Your stations: location, facilities (rail/truck/bus/airport/dock), per-cargo waiting amount and rating %, vehicles serving (count, and vehicle_ids with AgentBridge v12: vehicles with an order for it). Filter with facility, cargo (name), min_waiting, max_rating_pct (e.g. find poorly served stations), ids, near_x/near_y/radius (nearest first, with distance), unserved (no vehicle has an order for it), max_vehicles. --company X shows another company\'s stations as the game window shows them to anyone (location, facilities, waiting cargo, ratings; no vehicle counts); also through the relay. Returns {total, matched, stations, truncated}.',
    args: z.object({ ...who, facility: z.enum(FACILITIES).optional(), cargo: z.string().optional(), min_waiting: int().default(0),
      max_rating_pct: int().default(100), name: z.string().optional(),
      ids: ids().optional().describe('only these station ids'),
      near_x: int().optional().describe('with near_y: only stations within --radius tiles (Manhattan) of this tile, nearest first, each with distance'), near_y: int().optional(),
      radius: int().min(0).default(20).describe('tiles around near_x,near_y'),
      unserved: bool().default(false).describe('only stations no vehicle has an order for (your company)'),
      max_vehicles: int().min(0).optional().describe('only stations served by at most this many vehicles (your company)'),
      limit: int().min(1).optional().describe('most stations to return (default 1000 for your company, 100 for another)') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const cargoFilter = a.cargo !== undefined || a.min_waiting > 0 || a.max_rating_pct < 100;
      const rival = isRival(s, company);
      if (rival && (a.unserved || a.max_vehicles !== undefined)) throw new Error('refused: --unserved and --max_vehicles need vehicle counts, which another company\'s stations do not show');
      if ((a.near_x === undefined) !== (a.near_y === undefined)) throw new Error('bad_arguments: give --near_x and --near_y together');
      let all = stationsFromRows(await s.gs.call('stations', { company }), s.cargos).map((st) => (rival ? (({ vehicles, ...rest }) => rest)(st) : st));
      if (!rival) {
        const ids = await stationVehicleIds(s, company);
        if (ids) all = all.map((st) => ({ ...st, vehicle_ids: ids.get(st.id) ?? [] }));
      }
      const hits = all.filter((st) => (!a.facility || st.facilities.includes(a.facility)) && (!a.name || lc(st.name).includes(lc(a.name)))
        && (!cargoFilter || st.cargo.some((c) => (!a.cargo || cargoMatches(c.name, a.cargo)) && c.waiting >= a.min_waiting && c.rating_pct <= a.max_rating_pct)));
      const picked = filterStations(hits, a);
      return { company, ...(rival ? { view: 'other company: what the game shows anyone' } : {}), ...listResult('stations', all, picked, a.limit ?? (rival ? 100 : 1000)) };
    },
  },
  {
    name: 'vehicles', group: 'operate', session: true,
    description: `Your vehicles (summary=true or another --company: counts per type and state only, as the company window shows anyone): type, engine, age (days and % of max age), reliability, profit this/last year, value, running cost, state, location, group, order count. Filters: ids (A,B), type, group, state, engine, max_profit_last_year (e.g. 0 = loss makers), max_profit_this_year, min_age_pct (e.g. 90 = due for replacement), min_age_days (e.g. 365: old enough to judge its profit), max_reliability_pct, name, station (vehicles with an order for it; AgentBridge v12). --sort ${VEHICLE_SORTS.join('|')} (a leading - sorts high first, e.g. -profit_last_year). Breakdown counts and service intervals are not exposed by the game to scripts.`,
    args: z.object({ ...who, ids: ids().optional().describe('only these vehicle ids'), type: z.enum(VEHICLE_TYPES).optional(), group: int().optional(), state: z.enum(VEHICLE_STATES).optional(),
      engine: int().optional(), max_profit_this_year: int().optional(), min_age_days: int().optional(),
      sort: z.enum([...VEHICLE_SORTS, ...VEHICLE_SORTS.map((k) => `-${k}`)]).optional().describe('sort key; leading - = descending'),
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
      let vehicles = filterVehicles(all, a).filter((v) => !atStation || atStation.has(v.id));
      if (a.sort) vehicles = sortVehicles(vehicles, a.sort);
      return { company, ...listResult('vehicles', all, vehicles, a.limit) };
    },
  },
  {
    name: 'vehicle', group: 'operate', session: true,
    description: 'One vehicle in detail: status, capacity and load per cargo, load {load, capacity, pct} over all cargo, wagons, and the full order list with decoded flags. A vehicle sold through openttd-agent answers already_sold with the sale date.',
    args: z.object({ ...who, vehicle: int() }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      let rows;
      try { rows = await s.gs.call('vehicle', { company, vehicle: a.vehicle }); } catch (e) {
        const note = /does not exist/.test(e.message) ? await soldNote(s, company, a.vehicle) : null;
        if (note) return { ok: false, error: note, first_error: 'already_sold', vehicle: a.vehicle, sold: s.soldVehicles.get(`${company}:${a.vehicle}`) };
        throw e;
      }
      const d = vehicleDetail(rows, s.cargos);
      const load = d.capacity.reduce((n, c) => n + c.load, 0), capacity = d.capacity.reduce((n, c) => n + c.capacity, 0);
      return { ...d, load: { load, capacity, pct: capacity ? Math.round((100 * load) / capacity) : 0 } };
    },
  },
  {
    name: 'summary', group: 'operate', session: true,
    description: 'One compact text line per vehicle and per station, for a quick look without big JSON. Header: date and me (money, loan, max_loan, value, performance, profit of the last quarter). Lines: vehicles "#unit id N name [type] profit this/last yr, age (years, % of max), reliability, state, (x,y) -> destination, spd, load now/capacity (AgentBridge v13), order i/n", plus age_buckets, reliability_buckets and low_reliability (below 50%: id, reliability_pct, age_pct); stations "id name [facilities] N veh: cargo waiting rating%". Pick with --group G, --vehicles A,B, --stations A,B (ids or names) or --what vehicles|stations; with none, all your vehicles and stations. Sorted: vehicles by profit last year (worst first), stations by lowest rating.',
    args: z.object({ ...who, group: int().optional(), vehicles: ids().optional(), stations: z.string().optional().describe('comma-separated station ids or names'),
      what: z.enum(['all', 'vehicles', 'stations']).default('all'), limit: int().min(1).default(200) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const [stationRows, info, companyRows] = await Promise.all([s.gs.call('stations', { company }), s.gs.call('info'), s.gs.call('companies')]);
      const stations = stationsFromRows(stationRows, s.cargos);
      const names = new Map(stations.map((st) => [st.id, st.name]));
      const picked = a.group !== undefined || a.vehicles || a.stations;
      const wantV = a.what !== 'stations' && (!picked || a.group !== undefined || a.vehicles);
      const wantS = a.what !== 'vehicles' && (!picked || a.stations);
      const out = { company, date: dateString(info), me: meFromCompanies(companyRows, company) };
      if (wantV) {
        const all = vehiclesFromRows(await s.gs.call('vehicles', { company }));
        const hit = all.filter((v) => (a.group === undefined || v.group === a.group) && (!a.vehicles || a.vehicles.includes(v.id))).sort((p, q) => p.profit_last_year - q.profit_last_year);
        const loads = hit.length ? await vehicleLoads(s, company, a.vehicles) : null;
        const lines = hit.map((v) => vehicleLine(v, names, loads?.get(v.id) ?? null));
        Object.assign(out, { vehicles_total: hit.length, vehicles: lines.slice(0, a.limit),
          vehicles_profit: `this year ${hit.reduce((n, v) => n + v.profit_this_year, 0)}, last year ${hit.reduce((n, v) => n + v.profit_last_year, 0)}`, ...fleetBuckets(hit) });
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
    description: 'Vehicles with problems, one row per problem: problem, severity (action = it cannot earn until fixed; info = worth knowing, leave a running train alone), evidence, suggested_fix, plus id and unit_number (the "Train #4" the game window shows). Checks: wrong_network / unreachable_destination (no rail path, or for road vehicles no road path (AgentBridge v11), to the current order\'s station), stuck_or_lost (same order for stuck_days game days without getting closer; needs two calls that many days apart, the daemon keeps the history), stalled_on_line (speed 0 on the same tile for stall_days, not at a station or broken down; the daemon samples every 15 s once vehicle-problems has run), deadlock (two such trains within 16 tiles: reverse one with vehicle-reverse), pending_sale (queued by vehicle-sell or vehicle-replace; nothing else is reported for it), no_income (lost money last year at age > 1 year), no_orders, stopped_in_depot (with how long it has been parked), loose_wagons (wagons without a locomotive in a depot), stopped, old, broken_down, low_reliability, crashed. Every row has as_of (game date of this sample) and days_watched (how long the history behind it is); --fresh true starts the history again. Filters: --vehicles A,B, --type, --problem a,b. Run it every turn. The game does not tell scripts when a vehicle is lost; this infers it.',
    args: z.object({ ...who, vehicle: int().optional().describe('check only this vehicle id'), vehicles: ids().optional().describe('check only these vehicle ids'),
      type: z.enum(VEHICLE_TYPES).optional().describe('only vehicles of this type'), problem: z.string().optional().describe('only these problems, comma-separated (e.g. stuck_or_lost,no_income)'),
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
        if (!vehicles.length) throw new Error((await soldNote(s, company, a.vehicle)) ?? `vehicle ${a.vehicle} does not exist or is not owned by company ${company}; run: openttd-agent vehicles`);
      }
      if (a.vehicles) vehicles = vehicles.filter((v) => a.vehicles.includes(v.id));
      if (a.type) vehicles = vehicles.filter((v) => v.type === a.type);
      const wanted = a.problem ? new Set(a.problem.split(',').map((t) => t.trim()).filter(Boolean)) : null;
      const stations = stationsFromRows(await s.gs.call('stations', { company }), s.cargos);
      const stationById = new Map(stations.map((st) => [st.id, st]));
      s.vehicleHistory ??= new Map();
      s.stallHistory ??= new Map();
      if (a.fresh) for (const h of [s.vehicleHistory, s.stallHistory, s.depotHistory]) for (const k of [...h.keys()]) if (k.startsWith(`${company}:`)) h.delete(k);
      for (const v of vehicles) {
        const k = `${company}:${v.id}`;
        if (v.state !== 'in_depot') s.depotHistory.delete(k); else if (!s.depotHistory.has(k)) s.depotHistory.set(k, info.date);
      }
      const stalls = new Map(vehicles.map((v) => [v.id, recordStall(s.stallHistory, `${company}:${v.id}`, { date: info.date, x: v.x, y: v.y, speed: v.speed, state: v.state })]));
      // Trains queued just before their destination (behind one loading) are not a deadlock.
      const nearDest = (v) => v.dest && tileDistance(v, v.dest) <= 4;
      const longStalled = vehicles.filter((v) => { const e = stalls.get(v.id); return e && info.date - e.since >= a.stall_days && e.samples >= 2 && !nearDest(v); });
      const partners = deadlockPartners(longStalled);
      s.watchVehicles?.(company);
      const railTracer = a.trace ? await makeTracer(s, company, info) : null;
      const roadTracer = a.trace && vehicles.some((v) => v.type === 'road') ? makeRoadTracer(s, company, info) : null;
      const tracer = railTracer;
      const lineCache = new Map();
      const rows = [];
      for (const v of vehicles) {
        // L6: a vehicle queued for sale is reported as that alone (not stopped_in_depot or stuck).
        const sale = s.pendingSales.get(`${company}:${v.id}`);
        if (sale) {
          if ((a.severity === 'all' || a.severity === 'info') && (!wanted || wanted.has('pending_sale'))) {
            rows.push({ id: v.id, unit_number: v.unit_number, name: v.name, type: v.type, problem: 'pending_sale', severity: 'info',
              evidence: `queued for sale since ${sale.since ?? '?'}${sale.replaced_by !== undefined && sale.replaced_by !== null ? ` (replaced by ${sale.replaced_by})` : ''}; ${v.state === 'in_depot' ? 'in a depot: sold at the next check (20 s)' : sale.send && !sale.sent ? 'no depot found yet: sent again every 20 s' : 'heading to a depot'}`,
              suggested_fix: `nothing: it is sold when it stops in a depot (vehicle-start --vehicles ${v.id} --cancel_sale true keeps it instead)`, as_of: gameDate(info), days_watched: 0 });
          }
          continue;
        }
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
          if ((a.severity === 'all' || a.severity === p.severity) && (!wanted || wanted.has(p.problem))) rows.push({ id: v.id, unit_number: v.unit_number, name: v.name, type: v.type, ...p, as_of: gameDate(info), days_watched: seen.length ? info.date - Math.min(...seen) : 0 });
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
    description: 'Is there a rail or road path? --vehicle ID traces from the vehicle to each of its order stations and between consecutive order stations (rail for trains, road for road vehicles); --from_station A --to_station B (id or name) traces A to B and B back to A (both_ways, default; there/back, connected = both; --both_ways false = A to B only; mode auto: rail when both have rail, road when both have truck or bus stops). legs_connected[] has one true/false per leg (vehicle: its order legs; pair: there, back). Reports connected and, if not, the last reachable tile and the first gap with a reason. Rail (AgentBridge v9; coarse map-mirror trace before): no_track, track_not_joined, station_platform_side, depot_entrance_faces_away, one_way_signal_against, other_company_track, bridge_side, tunnel_side. Road (AgentBridge v11; refused before): no_road, road_not_joined, one_way_road, depot_not_joined, depot_entrance_faces_away, stop_not_joined, stop_entrance_faces_away, other_owner_road (another company\'s stop or depot).',
    args: z.object({ ...who, vehicle: int().optional(), from_station: z.coerce.string().optional().describe('station id or name'), to_station: z.coerce.string().optional().describe('station id or name'),
      mode: z.enum(['auto', 'rail', 'road']).default('auto').describe('station pair only: which network to trace'),
      both_ways: bool().default(true).describe('station pair only: also trace B back to A (a train must get back; one-way signals can block one direction)') }),
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
          ...(tracer.method === 'mirror_adjacency' ? { note: OLD_GS_TRACE } : {}), legs_connected: legs.legs.map((l) => l.connected), from_vehicle: legs.from_vehicle, legs: legs.legs };
      }
      if (a.from_station === undefined || a.to_station === undefined) throw new Error('give --vehicle ID, or both --from_station and --to_station (id or name)');
      const from = findStation(stations, a.from_station), to = findStation(stations, a.to_station);
      const roadish = (st) => st.facilities.includes('truck') || st.facilities.includes('bus');
      const mode = a.mode !== 'auto' ? a.mode : (from.facilities.includes('rail') && to.facilities.includes('rail')) || !(roadish(from) && roadish(to)) ? 'rail' : 'road';
      const tracer = await pick(mode);
      const r = await tracer.trace(await tracer.stationStarts(from), to);
      const head = { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, mode, method: tracer.method, ...(tracer.method === 'mirror_adjacency' ? { note: OLD_GS_TRACE } : {}) };
      if (!a.both_ways) return { ...head, ...brief(r), legs_connected: [r.connected] };
      const back = await tracer.trace(await tracer.stationStarts(to), from);
      const bad = !r.connected ? r : back;
      return { ...head, ...brief(bad), connected: r.connected && back.connected, tiles_reached: r.tiles_reached, legs_connected: [r.connected, back.connected],
        there: brief(r), back: brief(back), ...(r.connected && !back.connected ? { note_back: `${to.name} -> ${from.name} is not connected: trains get there but not back` } : {}) };
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
    description: 'Game events since sequence number `since` (keep latest_seq and pass it next time): vehicle_crashed, subsidy_offer/awarded/expired, industry_open/close, company_new/in_trouble/bankrupt/merger, station_first_vehicle, town_founded, exclusive_transport_rights, road_reconstruction. The game does not send scripts vehicle-lost/unprofitable or production-change events: poll `vehicles` and `industries` for those. The buffer holds the last 300 events and restarts when the game is loaded. Filters: --type a,b (any), --exclude a,b, --companies A,B (or --company N).',
    // Not `company`: events are public news, and the relay would force `company` to the player's own.
    args: z.object({ since: int().default(0), type: z.string().optional().describe('comma-separated substrings of the event type (any matches), e.g. crash,subsidy'),
      exclude: z.string().optional().describe('comma-separated substrings of event types to leave out, e.g. industry,town_founded'),
      companies: ids().optional().describe('only events about these companies (event company or old_company); --company N works too') }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const events = await s.gs.call('events', { since: a.since });
      return { latest_seq: events.length ? events.at(-1).seq : a.since, my_company: s.cfg.company,
        events: filterEvents(events, { types: wordList(a.type), exclude: wordList(a.exclude), companies: a.companies }) };
    },
  },

  {
    name: 'overview', group: 'operate', session: true,
    description: 'One small per-turn snapshot instead of status + goal-status + companies + stations + vehicles + depots + events + vehicle-problems: date, paused, money/loan/max_loan/value/profit (last quarter), goal (one line), fleet (one line: counts per type and state, profit, loss makers), vehicle_lines (worst by profit last year), station_lines (lowest rating first), depots, problems (vehicle-problems rows with severity action, one line per problem kind with the vehicle ids), rivals (one line per other company), events since --since (yours, world news and company news; one line each) and latest_seq (pass it as --since next turn). Lines are capped (*_total says how many there are); use the full commands for detail.',
    args: z.object({ ...who, since: int().min(0).default(0).describe('events after this seq (latest_seq of the last overview); 0 = the newest only'),
      vehicle_lines: int().min(0).default(5), station_lines: int().min(0).default(6), event_lines: int().min(0).default(5), problem_lines: int().min(0).default(6).describe('most problem kinds shown (one line per kind with the vehicle ids)'),
      problems: bool().default(true).describe('run the vehicle-problems checks (rail/road traces; about 1 s on a mid-size company)') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const [info, companyRows, goalRows, stationRows, vehicleRows, events, ...depotRows] = await Promise.all([
        s.gs.call('info'), s.gs.call('companies'), s.gs.call('goal_status', { company }), s.gs.call('stations', { company }), s.gs.call('vehicles', { company }),
        s.gs.call('events', { since: a.since }), ...VEHICLE_TYPES.map((t) => s.gs.call('depots', { company, type: vehicleTypeId(t) })),
      ]);
      const me = meFromCompanies(companyRows, company);
      const stations = stationsFromRows(stationRows, s.cargos);
      const names = new Map(stations.map((st) => [st.id, st.name]));
      const vehicles = vehiclesFromRows(vehicleRows);
      const minRating = (st) => Math.min(101, ...st.cargo.map((c) => c.rating_pct));
      // Vehicles inside from the vehicle list: the GS depots count (GSVehicleList_Depot) read 0 for stopped trains in a live 15.3 game.
      const depots = depotsLine(VEHICLE_TYPES.map((t, i) => [t, depotRows[i]]), vehicles);
      let problems = null;
      if (a.problems) {
        const vp = COMMANDS_BY_NAME.get('vehicle-problems');
        problems = (await vp.run(ctx, vp.args.parse({ company, severity: 'action' }))).problems;
      }
      const COMPANY_NEWS = /^company_/;
      const seen = events.filter((e) => e.company === undefined || e.company === company || COMPANY_NEWS.test(e.type));
      const cap = (list, n) => list.slice(Math.max(0, list.length - n));
      return {
        company, date: dateString(info), paused: info.paused,
        ...(me ? { money: me.money, loan: me.loan, max_loan: me.max_loan, value: me.value, profit_last_quarter: me.profit, performance: me.performance } : {}),
        goal: goalRows.length ? goalLine(goalFromRow(goalRows[0])) : null,
        fleet: fleetLine(vehicles),
        vehicles_total: vehicles.length,
        vehicle_lines: [...vehicles].sort((p, q) => p.profit_last_year - q.profit_last_year).slice(0, a.vehicle_lines).map((v) => shortVehicleLine(v, names)),
        stations_total: stations.length,
        station_lines: [...stations].sort((p, q) => minRating(p) - minRating(q)).slice(0, a.station_lines).map(shortStationLine),
        depots,
        ...(problems ? { problems_total: problems.length, problems: problemGroups(problems).slice(0, a.problem_lines) } : {}),
        rivals: companyRows.filter((c) => c.id !== company).slice(0, 8).map(rivalLine),
        events_new: seen.length, events: cap(seen, a.since === 0 ? Math.min(3, a.event_lines) : a.event_lines).map(eventLine),
        latest_seq: events.length ? events.at(-1).seq : a.since,
      };
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
    description: 'Show or change your company loan. Give one of: amount (set the loan to this), borrow (add this much), repay (pay back this much; needs the cash), max true (borrow up to max_loan). The new loan is rounded up to the loan interval; refused below 0; more than max_loan borrows up to max_loan (clamped). No arguments = show. Returns loan, max_loan and money before and after (dry_run: predicted). Needs AgentBridge v8.',
    args: z.object({ ...act, amount: int().optional().describe('set the loan to this amount'), borrow: int().min(1).optional().describe('add this much to the loan'),
      repay: int().min(1).optional().describe('pay back this much of the loan'), max: bool().optional().describe('true = borrow up to max_loan') }),
    run: async (ctx, a) => {
      const given = ['amount', 'borrow', 'repay', 'max'].filter((k) => a[k] !== undefined && a[k] !== false);
      if (given.length > 1) throw new Error(`loan takes one of --amount, --borrow, --repay, --max; got ${given.map((k) => `--${k}`).join(', ')}. Nothing was run.`);
      const { s, company } = await mine(ctx, a);
      const before = await loanState(s, company);
      if (!given.length) return before;
      let step = a.max ? ['loan', 'max', 0] : a.amount !== undefined ? ['loan', 'set', a.amount] : ['loan', 'add', a.borrow ?? -a.repay];
      let requested = a.max ? before.max_loan : a.amount ?? before.loan + (a.borrow ?? -a.repay);
      // L8: asking for more than max_loan borrows up to it (a weak model asks "borrow 1000000" and loops on the refusal).
      const overMax = requested > before.max_loan ? { asked: requested, clamped_to_max_loan: before.max_loan } : null;
      if (overMax) { step = ['loan', 'max', 0]; requested = before.max_loan; }
      if (!a.dry_run) s.throttleBuild();
      const res = await s.exec(company, [step], { dryRun: a.dry_run });
      const r = res.results[0];
      if (r?.error?.startsWith('unknown exec op')) throw new Error(OLD_GS_LOAN);
      if (!res.ok) return { ok: false, dry_run: a.dry_run, error: r?.error ?? res.stopped ?? 'failed', requested_loan: requested, before, after: before };
      const target = r.value ?? 0; // execSummary drops a 0 value
      const after = a.dry_run ? { loan: target, max_loan: before.max_loan, money: before.money + target - before.loan } : await loanState(s, company);
      return { ok: true, dry_run: a.dry_run, requested_loan: requested, ...(overMax ? { clamped: overMax } : {}), ...(target !== requested ? { rounded_to: target, note: 'rounded up to a multiple of the loan interval' } : {}),
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
    description: 'Buy `count` vehicles of an engine id (see engines) at your depot tile (see depots). cargo (name) refits on purchase. For trains buy the locomotive first, then wagons with attach_to=<train id>; the train must be stopped in that depot (checked first, also in a dry run; a wagon the game will not couple is sold back). New ids are in `vehicles`. Vehicles start stopped in the depot: add orders, then vehicle-start. route_of=<train id>: refuse unless the depot is rail-connected to that train\'s order stations (use it before copying that train\'s orders onto the new one). One call for a whole train: --wagon W --wagons N attaches N wagons of engine W to each new locomotive (refitted to cargo); --orders A,B (station ids or names) gives the new vehicles those orders (the first gets them, the others share them; with attach_to, the train attach_to gets them), --order_flags sets flags per order separated by ";" (e.g. "full_load_any;unload,no_load"; one set applies to every order), --start true starts them. --routes "A,B;C,D" buys one vehicle per route (bus networks: many small routes), each with its own orders, and starts them (routes: vehicle + orders).',
    args: z.object({ ...act, ...borrow, depot_x: int(), depot_y: int(), engine: int(), cargo: z.string().optional(), attach_to: int().default(-1), count: int().min(1).max(50).default(1),
      route_of: int().optional().describe('rail: check the depot is joined to this vehicle\'s order stations first'),
      wagon: int().optional().describe('wagon engine id to attach to each new locomotive'), wagons: int().min(0).max(60).default(0),
      orders: z.string().optional().describe('comma-separated station ids or names, in order'), order_flags: z.string().default('').describe('flags per order separated by ";", or one set for all'),
      routes: z.string().optional().describe('one vehicle per route, routes separated by ";" and stations by ",": "A,B;C,D" buys 2 vehicles, each with its own orders, started unless --start false'),
      start: bool().optional().describe('start the new vehicles (default false; true with --routes)') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const cargo = cargoId(s.cargos, a.cargo) ?? -1;
      if (a.wagons > 0 && a.wagon === undefined) throw new Error('give --wagon ENGINE_ID with --wagons N (see engines --wagons true)');
      if (a.routes !== undefined && (a.orders !== undefined || a.attach_to >= 0)) throw new Error('--routes gives each new vehicle its own orders: not with --orders or --attach_to');
      const stationRows = a.orders || a.routes ? stationsFromRows(await s.gs.call('stations', { company }), s.cargos) : null;
      const routePlans = a.routes !== undefined ? a.routes.split(';').map((t) => t.trim()).filter(Boolean).map((r) => orderPlan(stationRows, r, a.order_flags)) : null;
      if (routePlans && !routePlans.length) throw new Error('--routes needs at least one route, e.g. "A,B;C,D"');
      if (routePlans && a.count !== 1 && a.count !== routePlans.length) throw new Error(`--routes has ${routePlans.length} routes but --count is ${a.count}: one vehicle per route (leave --count out)`);
      if (routePlans) a = { ...a, count: routePlans.length };
      a = { ...a, start: a.start ?? !!routePlans };
      const plan = a.orders ? orderPlan(stationRows, a.orders, a.order_flags) : null;
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
      if (res.ok && !a.dry_run && (plan || routePlans || a.start || a.wagons > 0)) {
        const heads = a.attach_to >= 0 ? [a.attach_to] : bought;
        const steps = [];
        if (a.attach_to < 0) for (const v of heads) for (let i = 0; i < a.wagons; i++) steps.push(['veh_buy', a.depot_x, a.depot_y, a.wagon, cargo, v]);
        if (plan && heads.length) {
          for (const o of plan) steps.push(['order_add', heads[0], o.x, o.y, o.flags, -1]);
          for (const v of heads.slice(1)) steps.push(['orders_copy', v, heads[0], true]);
        }
        if (routePlans) heads.forEach((v, i) => { for (const o of routePlans[i]) steps.push(['order_add', v, o.x, o.y, o.flags, -1]); });
        if (a.start) for (const v of heads) steps.push(['veh_start_stop', v, 1]);
        setup = await s.exec(company, steps);
        Object.assign(res, { cost: res.cost + setup.cost, ok: setup.ok, error: setup.ok ? res.error : `bought ${bought.join(', ')}; then: ${setup.error} (the vehicles are stopped in the depot)`, ...(setup.ok ? {} : { first_error: setup.first_error }) });
      }
      return { ...res, vehicles: bought, ...(check ? { route_check: check.route_check } : {}),
        ...(plan ? { orders: plan.map((o) => ({ station: o.station, name: o.name, flags: o.flag_names })) } : {}),
        ...(routePlans ? { routes: routePlans.map((r, i) => ({ vehicle: bought[i] ?? null, orders: r.map((o) => ({ station: o.station, name: o.name, flags: o.flag_names })) })) } : {}), ...(setup ? { setup: { ok: setup.ok, steps: setup.steps_total ?? setup.results?.length } , started: a.start && setup.ok } : {}),
        ...(soldBack ? { sold_back: soldBack, error: `${res.error}; ${soldBack.ok ? `sold the wagon${stray.length > 1 ? 's' : ''} back (${stray.join(', ')})` : `selling ${stray.join(', ')} back failed too: sell ${stray.length > 1 ? 'them' : 'it'} with vehicle-sell`}` } : {}) };
    },
  },
  {
    name: 'vehicle-clone', group: 'operate', session: true,
    description: 'Clone a vehicle `count` times, sharing its orders by default (--share is the same flag); start=true starts the clones. New ids are in `vehicles`. Depot: --depot auto (or no depot) picks your depot nearest the vehicle\'s first order station that is rail-connected to all its order stations; --depot_x/--depot_y is refused for a train when that depot is not rail-connected to its order stations (a clone there would get lost). check_route=false skips the check. --station ID [--cargo C] instead of --vehicle clones the best-earning vehicle with an order there (source says which). A sold vehicle id is refused with already_sold, the sale date and the vehicles serving its stations now. Trains: refused with needs_loop when the line would run more trains than its usable passing loops + 1 (as add-train; line_check says why); any vehicle that lost money last year and this year is refused with source_unprofitable. --force true skips both.',
    args: z.object({ ...act, ...borrow, depot: z.enum(['auto']).optional().describe('auto = pick a depot on the vehicle\'s own route'),
      depot_x: int().optional(), depot_y: int().optional(), vehicle: int().optional(), share_orders: bool().default(true), count: int().min(1).max(50).default(1), start: bool().default(false),
      station: z.string().optional().describe('instead of --vehicle: clone the best-earning vehicle with an order for this station (id or name; AgentBridge v12)'),
      cargo: z.string().optional().describe('with --station: only a vehicle that carries this cargo'),
      check_route: bool().default(true).describe('rail: refuse a depot not joined to the vehicle\'s order stations'),
      force: bool().default(false).describe('skip the passing-loop (needs_loop) and source_unprofitable checks') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      if ((a.vehicle === undefined) === (a.station === undefined)) throw new Error('give --vehicle ID or --station ID (clone a vehicle serving it), not both');
      const source = a.station !== undefined ? await cloneSourceAt(s, company, a.station, a.cargo) : null;
      const vehicle = source ? source.vehicle : a.vehicle;
      const { depot, ...check } = await depotForRoute(s, company, a, vehicle, { cmd: 'vehicle-clone' });
      const veh = await vehicleOf(s, company, vehicle);
      let lineCheck = null;
      if (!a.force) {
        if (veh.type === 'rail') {
          const cap = await lineCapacity(s, company, vehicle, a.count, { cmd: 'vehicle-clone' });
          lineCheck = cap.check;
          if (cap.refusal) return { ok: false, dry_run: a.dry_run, error: cap.refusal, first_error: 'needs_loop', ...(source ? { source } : {}), depot, ...check, line_check: lineCheck };
        }
        const why = unprofitableRefusal(veh);
        if (why) return { ok: false, dry_run: a.dry_run, error: why, first_error: 'source_unprofitable', ...(source ? { source } : {}), depot, ...check };
      }
      const res = await run(ctx, a, Array.from({ length: a.count }, () => ['veh_clone', depot.x, depot.y, vehicle, a.share_orders]));
      const vehicles = res.results.filter((r) => r.ok && r.value !== undefined).map((r) => r.value);
      const out = { ...res, ...(source ? { source } : {}), depot, ...check, ...(lineCheck ? { line_check: lineCheck } : {}), vehicles };
      if (!a.start || a.dry_run || !vehicles.length) return out;
      const started = await s.exec(company, vehicles.map((v) => ['veh_start_stop', v, 1]), { keepGoing: true });
      return { ...out, started: started.ok };
    },
  },
  {
    name: 'vehicle-replace', group: 'operate', session: true,
    description: 'Replace vehicles (comma-separated ids) in one call: buy the replacement at a depot on the vehicle\'s own route (--depot auto, the default, or --depot_x/--depot_y), share the old vehicle\'s orders, start it; the old vehicle gets its own copy of the orders, loads nothing more at its next unloading stop (no_load) and gets a "stop in depot" order right after it (--when unloaded, the default; --when now sends it to a depot at once), and is sold when it stops there. The daemon (or relay) checks every 20 s and sells it; --finish true sells any that have arrived now and lists the rest (pending_sales). Without --engine the replacement is a clone (same engine and wagons). --engine N buys that engine instead; for trains also --wagons N (default: as many as the old train) of --wagon ID (default: the old train\'s wagon type; AgentBridge v12) refitted to the old cargo. --select "min_age_pct=100,type=road" --max 5 picks the vehicles by filter instead of --vehicles (selected: ids, matched). For age-based replacement of whole fleets, group-autoreplace or autorenew is cheaper in calls.',
    args: z.object({ ...act, vehicles: ids().optional(), engine: int().optional(), wagon: int().optional(), wagons: int().min(0).max(60).optional(),
      depot: z.enum(['auto']).optional(), depot_x: int().optional(), depot_y: int().optional(),
      when: z.enum(['unloaded', 'now']).default('unloaded').describe('when the old vehicle heads for the depot'),
      finish: bool().default(false).describe('only sell replaced vehicles that have stopped in a depot; no new replacements'), ...selectArgs('replace', 5) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      if (a.finish) return { ...forCompany(await s.finishSales(), company), pending_sales: [...s.pendingSales.values()].filter((p) => p.company === company) };
      if (a.vehicles && a.select) throw new Error('give --vehicles A,B or --select FILTER, not both');
      const picked = a.select ? await selectVehicles(s, company, a.select, a.max) : null;
      const list = picked ? picked.ids : a.vehicles;
      if (!list) throw new Error('give --vehicles A,B, --select FILTER (or --finish true)');
      if (picked && !list.length) return { ok: true, dry_run: a.dry_run, replaced: [], selected: picked, note: 'no vehicle matches --select (vehicles queued for sale are left out)' };
      const v12 = ((await s.gs.call('info')).bridge_version ?? 0) >= 12;
      const replaced = [];
      for (const id of list) replaced.push(await replaceOne(s, company, a, id, v12));
      if (!a.dry_run) s.watchSales();
      const bad = replaced.filter((r) => !r.ok);
      return { ok: !bad.length, dry_run: a.dry_run, error: bad.length ? bad.map((r) => `vehicle ${r.vehicle}: ${r.error}`).join('; ') : null,
        ...(bad.length ? { first_error: bad[0].first_error ?? errorCode(bad[0].error) } : {}),
        cost: replaced.reduce((n, r) => n + (r.cost ?? 0), 0), replaced, ...(picked ? { selected: picked } : {}), pending_sales: [...s.pendingSales.values()].filter((p) => p.company === company) };
    },
  },
  {
    name: 'add-train', group: 'operate', session: true,
    description: 'Add a train to a running line safely, in one call: counts the trains on the line of --vehicle (same order stations) and the usable passing loops on its track between its first two stations (a second track that leaves the line at points and rejoins it, with a signal on each side and room for the longest train: check.loops / check.unusable_loops), refuses when the trains would outnumber the loops + 1 (single track: each loop lets one more train run; first_error needs_loop with the loop-sites command), refuses to copy a train that lost money last year and this year (source_unprofitable), then clones the train at a depot on its own route (sharing orders), starts it and traces the new train\'s route (verify; first_leg.detour_ratio = depot-to-first-station tiles / straight distance, warning depot_exit_detour when the depot exit leads the long way). --force true skips both checks. AgentBridge v12 (counts) and v9 (trace).',
    args: z.object({ ...act, vehicle: int(), count: int().min(1).max(10).default(1), force: bool().default(false) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      return addTrain(ctx, s, company, a);
    },
  },
  {
    name: 'train-add-wagons', group: 'operate', session: true,
    description: 'Lengthen a train by N wagons in one call: if it is stopped in a depot the wagons are bought and attached at once; otherwise it is sent to a depot (vehicle-depot) and the daemon (or relay) attaches them when it arrives and starts it again (checked every 20 s; --finish true does it now and lists what is pending). --wagon defaults to the train\'s own wagon type (AgentBridge v12), refitted to its cargo. Check the platforms and passing loops still fit the longer train (loop-sites --train_tiles N).',
    args: z.object({ ...act, vehicle: int().optional(), wagons: int().min(1).max(60).optional(), wagon: int().optional(), finish: bool().default(false) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      if (a.finish) {
        const done = forCompany(await s.finishSales(), company);
        return { wagons_added: done.wagons_added, pending: [...s.pendingWagons.values()].filter((p) => p.company === company), recent: s.jobLog.filter((j) => j.company === company && j.kind === 'add_wagons').slice(-10) };
      }
      if (a.vehicle === undefined || a.wagons === undefined) throw new Error('give --vehicle ID and --wagons N (or --finish true)');
      const d = vehicleDetail(await s.gs.call('vehicle', { company, vehicle: a.vehicle }), s.cargos);
      if (d.type !== 'rail') throw new Error(`refused: vehicle ${a.vehicle} is not a train`);
      const cargo = d.capacity.find((c) => c.capacity > 0)?.cargo ?? -1;
      let wagon = a.wagon;
      if (wagon === undefined) {
        if (((await s.gs.call('info')).bridge_version ?? 0) < 12) throw new Error('refused: give --wagon ENGINE_ID (the running AgentBridge is older than v12 and cannot read the train\'s wagon type)');
        const parts = (await s.gs.call('vehicle_wagons', { company, vehicle: a.vehicle })).filter((r) => r[0] > 0);
        if (!parts.length) throw new Error(`refused: train ${a.vehicle} has no wagons to copy; give --wagon ENGINE_ID (engines --wagons true)`);
        const freq = new Map();
        for (const r of parts) freq.set(r[1], (freq.get(r[1]) ?? 0) + 1);
        wagon = [...freq.entries()].sort((p, q) => q[1] - p[1])[0][0];
      }
      const tiles = Math.ceil((d.length ?? 0) / 16);
      const job = { company, vehicle: a.vehicle, wagon, cargo, count: a.wagons, since: new Date().toISOString() };
      const now = await vehicleOf(s, company, a.vehicle);
      if (now.state === 'in_depot') {
        const res = await run(ctx, a, [...Array.from({ length: a.wagons }, () => ['veh_buy', now.x, now.y, wagon, cargo, a.vehicle]), ['veh_start_stop', a.vehicle, 1]]);
        return { ...res, vehicle: a.vehicle, wagon, added_now: true, train_tiles_before: tiles };
      }
      const sent = await run(ctx, a, [['veh_depot', a.vehicle, false]]);
      // no_depot: the game finds no depot ahead (a train does not look behind it); retry until it turns.
      const retry = !sent.ok && sent.first_error === 'no_depot';
      if (!sent.ok && !retry) return { ...sent, vehicle: a.vehicle };
      if (a.dry_run) return { ...sent, vehicle: a.vehicle, wagon, would: `send to a depot, then attach ${a.wagons} wagons of engine ${wagon} and restart` };
      // The depot it stops in is known only on arrival: read it then from the vehicle position.
      s.pendingWagons.set(`${company}:${a.vehicle}`, { ...job, depot: null, sent: !retry });
      s.watchSales();
      return { ...sent, ...(retry ? { ok: true, error: null, first_error: undefined, note: 'no depot ahead of the train yet: the daemon sends it again every 20 s (after it turns at a station it finds one)' } : {}),
        vehicle: a.vehicle, wagon, heading_to_depot: !retry, pending: [...s.pendingWagons.values()].filter((p) => p.company === company), train_tiles_before: tiles };
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
    name: 'wait', group: 'operate', session: true,
    description: `Wait in one call instead of polling: --vehicles A,B --until ${WAIT_STATES.join('|')} returns when every listed vehicle is there (--any true: the first one); loaded = cargo on board >= --load_pct (default 100) of capacity (AgentBridge v13); stopped includes stopped in a depot; sold = gone after a queued sale (vehicle-sell). --days N waits N game days (about 2 s each) instead. Checks once a second; --timeout_s (default 60, max 280: one call must answer within 5 minutes) ends it with first_error wait_timeout and where each vehicle is. A paused game refuses at once (paused: game days do not pass; the host runs turn-advance). Changes nothing.`,
    args: z.object({ ...who, vehicles: ids().optional(), until: z.enum(WAIT_STATES).optional(), days: int().min(1).max(120).optional(),
      any: bool().default(false).describe('done when any one vehicle matches'), load_pct: int().min(1).max(100).default(100).describe('until loaded: share of capacity'),
      timeout_s: int().min(1).max(280).default(60) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      if ((a.vehicles === undefined) !== (a.until === undefined)) throw new Error('give --vehicles A,B with --until STATE, or --days N');
      if (a.days === undefined && a.until === undefined) throw new Error('give --vehicles A,B --until STATE, or --days N');
      const started = Date.now();
      const first = await s.gs.call('info');
      const check = async () => {
        if (a.until === 'sold') await s.finishSales();
        const rows = new Map(vehiclesFromRows(await s.gs.call('vehicles', { company })).map((v) => [v.id, v]));
        let loads = null;
        if (a.until === 'loaded') {
          try { loads = loadsFromRows(await s.gs.call('vehicle_loads', { company, vehicles: a.vehicles })); } catch (e) {
            if (/unknown cmd/.test(e.message)) throw new Error('refused: wait --until loaded needs AgentBridge v13; the host re-runs install-gamescript and loads the game again');
            throw e;
          }
        }
        return a.vehicles.map((id) => {
          const v = rows.get(id) ?? null;
          const load = loads?.get(id) ?? null;
          const matched = waitMatch(v, a.until, { load, loadPct: a.load_pct, sold: !!s.soldVehicles?.get(`${company}:${id}`) });
          return { id, state: v ? v.state : s.soldVehicles?.get(`${company}:${id}`) ? 'sold' : 'gone', matched, ...(v ? { x: v.x, y: v.y } : {}), ...(load ? { load_pct: load.pct } : {}) };
        });
      };
      let info = first, vehicles = a.vehicles ? await check() : [];
      const met = () => (a.days !== undefined ? info.date - first.date >= a.days : a.any ? vehicles.some((v) => v.matched) : vehicles.every((v) => v.matched));
      const out = () => ({ until: a.until ?? null, ...(a.days !== undefined ? { days: a.days } : {}), waited_s: Math.round((Date.now() - started) / 100) / 10,
        game_days: info.date - first.date, date: gameDate(info), ...(a.vehicles ? { vehicles } : {}) });
      if (met()) return { ok: true, done: true, ...out() };
      if (info.paused) return { ok: false, done: false, error: 'paused: the game is paused, so vehicles do not move and no game days pass; the host runs turn-advance (or unpause)', first_error: 'paused', ...out() };
      while (Date.now() - started < a.timeout_s * 1000) {
        await sleep(1000);
        info = await s.gs.call('info');
        if (a.vehicles) vehicles = await check();
        if (met()) return { ok: true, done: true, ...out() };
        if (info.paused) return { ok: false, done: false, error: 'paused: the game was paused while waiting', first_error: 'paused', ...out() };
      }
      return { ok: false, done: false, error: `wait_timeout: not done after ${a.timeout_s} s (${info.date - first.date} game days)${a.vehicles ? `; not yet: ${vehicles.filter((v) => !v.matched).map((v) => `${v.id} ${v.state}`).join(', ')}` : ''}`, first_error: 'wait_timeout', ...out() };
    },
  },
  {
    name: 'vehicle-start', group: 'operate', session: true,
    description: 'Start vehicles (comma-separated ids). Already running ones are left alone. A vehicle queued for sale (vehicle-sell, vehicle-replace) is refused with queued_for_sale: starting it would only send it round again; --cancel_sale true takes it off the queue and starts it.',
    args: z.object({ ...act, vehicles: ids(), cancel_sale: bool().default(false).describe('take vehicles off the sale queue and start them') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const queued = a.vehicles.filter((v) => s.pendingSales.has(`${company}:${v}`));
      if (queued.length && !a.cancel_sale) {
        return { ok: false, dry_run: a.dry_run, error: `queued_for_sale: vehicle${queued.length > 1 ? 's' : ''} ${queued.join(', ')} ${queued.length > 1 ? 'are' : 'is'} queued for sale and will be sold in the depot; nothing was started. To keep ${queued.length > 1 ? 'them' : 'it'}: vehicle-start --vehicles ${queued.join(',')} --cancel_sale true`,
          first_error: 'queued_for_sale', queued_for_sale: queued, results: [] };
      }
      if (queued.length && !a.dry_run) for (const v of queued) s.pendingSales.delete(`${company}:${v}`);
      const res = await run(ctx, a, a.vehicles.map((v) => ['veh_start_stop', v, 1]), { keepGoing: true });
      const sold = [];
      for (const r of res.results.filter((x) => !x.ok)) { const note = await soldNote(s, company, a.vehicles[r.step]); if (note) sold.push(note); }
      return { ...res, ...(queued.length ? { sale_cancelled: a.dry_run ? [] : queued } : {}), ...(sold.length ? { already_sold: sold } : {}) };
    },
  },
  {
    name: 'vehicle-stop', group: 'operate', session: true,
    description: 'Stop vehicles (comma-separated ids).',
    args: z.object({ ...act, vehicles: ids() }),
    run: (ctx, a) => run(ctx, a, a.vehicles.map((v) => ['veh_start_stop', v, 0]), { keepGoing: true }),
  },
  {
    name: 'vehicle-depot', group: 'operate', session: true,
    description: 'Send vehicles (comma-separated ids) to a depot: they stop there (needed before vehicle-sell). service=true = service only and carry on. Safe to repeat: vehicles already heading to a depot are left alone (already_heading; sending again would cancel their depot order in OpenTTD) and ones already stopped in a depot are reported (already_in_depot). Failures say why (failed[].error: not_found, broken_down, loading_full_load, no_depot). --select "max_reliability_pct=50" --service true services the vehicles matching a filter (at most --max, default 20; selected lists them). AgentBridge v11; older ones only skip vehicles already in a depot.',
    args: z.object({ ...act, vehicles: ids().optional(), service: bool().default(false), ...selectArgs('send', 20) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      if (a.vehicles && a.select) throw new Error('give --vehicles A,B or --select FILTER, not both');
      const picked = a.select ? await selectVehicles(s, company, a.select, a.max) : null;
      if (!a.vehicles && !picked) throw new Error('give --vehicles A,B or --select FILTER');
      const v11 = ((await s.gs.call('info')).bridge_version ?? 0) >= 11;
      let send = picked ? picked.ids : a.vehicles;
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
      return { ...res, ...(picked ? { selected: picked } : {}), sent: by(1), already_heading: by(2), already_in_depot: [...inDepot, ...by(3)],
        failed: res.results.filter((r) => !r.ok).map((r) => ({ vehicle: send[r.step], error: r.error ?? 'failed' })),
        ...(v11 ? {} : { note: 'the running AgentBridge is older than v11: a vehicle already heading to a depot cannot be detected, and sending it again cancels its depot order' }) };
    },
  },
  {
    name: 'vehicle-sell', group: 'operate', session: true,
    description: 'Sell vehicles (comma-separated ids) in one call: ones stopped in a depot are sold now (sold, income); the others are sent to a depot and queued (queued): the daemon (or relay) sells each when it stops there (checked every 20 s; status background_jobs, vehicle-problems pending_sale; kept in the jobs file). --send false sells only the ones in a depot and fails the rest (not_in_depot). A vehicle already sold through openttd-agent is already_sold (ok) with the sale date. The negative cost is the sale income.',
    args: z.object({ ...act, vehicles: ids(), send: bool().default(true).describe('send vehicles that are not in a depot there and sell them on arrival (false = refuse them)') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const rows = new Map(vehiclesFromRows(await s.gs.call('vehicles', { company })).map((v) => [v.id, v]));
      const now = [], toQueue = [], alreadyQueued = [], alreadySold = [], failed = [];
      for (const id of [...new Set(a.vehicles)]) {
        const v = rows.get(id);
        if (!v) {
          const note = await soldNote(s, company, id);
          if (note) alreadySold.push({ vehicle: id, note }); else failed.push({ vehicle: id, error: `not_found: vehicle ${id} does not exist or is not yours` });
        } else if (v.state === 'in_depot') now.push(v);
        else if (s.pendingSales.has(`${company}:${id}`)) alreadyQueued.push(id);
        else if (a.send) toQueue.push(v);
        else failed.push({ vehicle: id, error: `not_in_depot: vehicle ${id} is ${v.state.replace('_', ' ')}; send it with vehicle-depot or use --send true` });
      }
      const info = { stations: new Map() };
      for (const v of [...now, ...toQueue]) info.stations.set(v.id, a.dry_run ? [] : await orderStationIds(s, company, v.id));
      const sell = now.length ? await run(ctx, a, now.map((v) => ['veh_sell', v.id]), { keepGoing: true }) : null;
      const sold = [];
      for (const r of sell?.results ?? []) {
        const v = now[r.step];
        if (!r.ok) { failed.push({ vehicle: v.id, error: r.error ?? 'failed' }); continue; }
        sold.push(v.id);
        if (!a.dry_run) await s.recordSold({ company, vehicle: v.id, income: -r.cost, unit_number: v.unit_number, name: v.name, stations: info.stations.get(v.id) });
      }
      const queued = [];
      if (toQueue.length) {
        const sent = await run(ctx, a, toQueue.map((v) => ['veh_depot', v.id, false]), { keepGoing: true });
        for (const r of sent.results) {
          const v = toQueue[r.step];
          if (!r.ok && /^not_found/.test(r.error ?? '')) { failed.push({ vehicle: v.id, error: r.error }); continue; }
          queued.push({ vehicle: v.id, sent: r.ok, ...(r.ok ? {} : { retrying: r.error ?? 'failed' }) });
          if (!a.dry_run) s.pendingSales.set(`${company}:${v.id}`, { company, vehicle: v.id, send: true, sent: r.ok, since: new Date().toISOString(), unit_number: v.unit_number, name: v.name, stations: info.stations.get(v.id) });
        }
        if (!a.dry_run) s.watchSales();
      }
      const income = -(sell?.cost ?? 0);
      return { ok: !failed.length, dry_run: a.dry_run, error: failed.length ? failed.map((f) => `vehicle ${f.vehicle}: ${f.error}`).join('; ') : null,
        ...(failed.length ? { first_error: errorCode(failed[0].error) } : {}), cost: sell?.cost ?? 0, income,
        sold, [a.dry_run ? 'would_queue' : 'queued']: queued, ...(alreadyQueued.length ? { already_queued: alreadyQueued } : {}),
        ...(alreadySold.length ? { already_sold: alreadySold } : {}), failed, results: sell?.results ?? [],
        ...(queued.length && !a.dry_run ? { note: 'queued vehicles are sold when they stop in a depot (the daemon checks every 20 s); wait --vehicles ... --until sold waits for it' } : {}) };
    },
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
    description: 'Plan and build a rail line between two anchor tiles. Anchors are where the line connects (a station end tile, the tile in front of a depot, existing track, or connect_at from build-terminus): track is laid on every tile strictly between them. The planner prefers flat and straight, avoids houses, industries and stations, crosses roads on the level and bridges water, rail and roads where it must. Use dry_run=true first for the cost; each step reports ok/error. On failure nothing after the failed step is built: fix (terraform, demolish, other anchors) and run again; already-built track is kept. A vehicle on the tiles (ERR_VEHICLE_IN_THE_WAY) gives transient: true and vehicles_in_the_way (blocked_by_vehicle in a dry run); --wait_clear_s N waits for it to pass and retries from that step.',
    args: z.object({ ...pathArgs, rail_type: int().optional().describe('see rail-types; default: first available'), ...waitClear }),
    run: (ctx, a) => buildPath(ctx, a, 'rail'),
  },
  {
    name: 'build-rail-station', group: 'build', session: true,
    description: 'Build a rail station with its lowest-x/y corner at x,y. axis=x: platforms run along x and are stacked along y (axis=y: the reverse). Trains enter at either end of a platform. A real build returns station {id, name} (the new or joined station).',
    args: z.object({ ...act, ...borrow, ...point, axis: z.enum(['x', 'y']).default('x'), platforms: int().min(1).max(20).default(1), length: int().min(1).max(20).default(4), ...join, rail_type: int().optional() }),
    run: async (ctx, a) => {
      const res = await run(ctx, a, [['rail_station', a.x, a.y, a.axis === 'y', a.platforms, a.length, joinArg(a.join)]], { railType: a.rail_type });
      if (!res.ok || a.dry_run) return res;
      const { s, company } = await mine(ctx, a);
      return { ...res, station: await builtStationAt(s, company, a.x, a.y, 'rail', a.platforms + a.length) };
    },
  },
  {
    name: 'build-rail-depot', group: 'build', session: true,
    description: 'Build a rail depot at x,y with its entrance facing front (a tile next to it that has or will get track). Connect it with build-rail using the front tile as an anchor. The result has exit_dir and (AgentBridge v9) front_joined: whether track on the front tile reaches the entrance, and front_leads (the ways a train leaving the depot can go from there); a warning when nothing joins it yet or when trains can leave in one direction only (every new train then runs that way first, e.g. to the far end of the line to turn).',
    args: z.object({ ...act, ...borrow, ...point, ...front, rail_type: int().optional() }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const res = await run(ctx, a, [['rail_depot', a.x, a.y, a.front_x, a.front_y]], { railType: a.rail_type });
      const dir = TRACE_DIRS.findIndex(([dx, dy]) => a.x + dx === a.front_x && a.y + dy === a.front_y);
      const out = { ...res, exit_dir: DIR_NAMES[dir] ?? null, ...(res.ok && !a.dry_run ? { depot: { x: a.x, y: a.y }, next: `vehicle-buy --depot_x ${a.x} --depot_y ${a.y} --engine <id>` } : {}) };
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
    description: 'Composite: a whole rail route in one call. Terminus at each end (station-sites logic, each facing the other end), rail between their connect_at anchors, a depot beside the line near the source, one train (cheapest-to-run locomotive that can pull the cargo unless --engine; wagons that carry it, --wagons default fills the platform), orders (full_load_any at the source, unload,no_load at the destination; passengers/mail between two towns: plain orders both ways), started. dry_run=true checks every placement and the rail path and returns estimated_cost without building. --passing_loops N lays N passing loops on straight stretches spread along the line, each sized for the train (length = train tiles + 2), so more trains can run on the single track (passing_loops in the result; a loop that does not fit is a warning, not a failure). --trains K then runs up to K trains: clones of the first, only as many as the built line has usable loops + 1 (warning trains when fewer). An end (town or industry) with no room is retried automatically with a wider search, a shorter platform and one platform (source_fallback / dest_fallback say what worked); when nothing fits, first_error no_terminus_site with no_site {candidates_on_map, dry_runs, rejected (counts by error), tried, own_station_near, hint (only what was not tried)}. warnings[] lists your stations within 8 tiles of a new terminus (near_own_station, tiles). When your rail stations near both ends are already served by one of your vehicles, --if_exists decides: refuse (default; failed_step existing_route), skip (ok, action exists), add_train (runs add-train on that line), build. Stations nobody serves (e.g. after selling the fleet) do not block it. Refused with source_produces_nothing when --from_industry does not produce the cargo, or is a secondary industry (sawmill, factory...) that made none last month (feed it first; --force true builds anyway). A real build ends by tracing the line both ways: verify {connected, there, back, first_gap, first_leg (depot to source: detour_ratio, warning depot_exit_detour)}; failed_step verify with first_error route_broken when it does not trace (the train is already running). A failure stops at that step and reports failed_step and everything already built (nothing is demolished). Example: --from_industry 6 --to_industry 9 --cargo iron --dry_run true',
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
      allow_existing: bool().default(false).describe('same as --if_exists build'),
      if_exists: z.enum(['refuse', 'skip', 'add_train', 'build']).default('refuse').describe('when one of your vehicles already serves your stations at both ends: refuse (failed_step existing_route), skip (ok: true, action: exists), add_train (add-train on that line: loop and profit checks, clone, start), build (a second line anyway)'),
      passing_loops: int().min(0).max(6).default(0).describe('passing loops to build on the line, spread along it on straight stretches (loop-sites logic), sized for the train'),
      trains: int().min(1).max(10).default(1).describe('trains to run on the new line: the first, then clones (shared orders) only while the built line has a usable passing loop for each; use with --passing_loops'),
      force: bool().default(false).describe('build from a source that produces none of the cargo now (source_produces_nothing: a secondary industry before its input arrives)'),
      reuse_stations: z.enum(['auto', 'never']).default('auto').describe('auto: at an end within --radius of one of your rail stations, the new terminus joins that station (reused_station; reuse_failed when it does not fit); never: always a new station'),
    }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      if ((a.from_industry !== undefined) === (a.from_town !== undefined)) throw new Error('give exactly one of --from_industry, --from_town');
      if ((a.to_industry !== undefined) === (a.to_town !== undefined)) throw new Error('give exactly one of --to_industry, --to_town');
      return buildCargoRoute(s, company, a, ctx);
    },
  },
  {
    name: 'build-truck-route', group: 'build', session: true,
    description: 'Composite: a whole road route in one call, the road twin of build-cargo-route. A truck stop (bus stop for passengers) at each end: a bay stop within 3 tiles of an industry, or a drive-through stop on a straight town road near the centre (else a bay stop); the destination stop must accept the cargo. A road between them (reusing existing roads, bridging where it must), a depot beside it near the source, --vehicles road vehicles (cheapest to run per capacity unless --engine; refitted to the cargo), orders (full_load_any at the source, unload,no_load at the destination; passengers between towns plain), started, and a road trace both ways (verify, AgentBridge v11). dry_run=true checks every placement and returns estimated_cost. Example: --from_industry 6 --to_industry 9 --cargo coal --dry_run true',
    args: z.object({
      ...act,
      from_industry: int().optional(), from_town: z.string().optional(), to_industry: int().optional(), to_town: z.string().optional(),
      cargo: z.string().describe('cargo name or label (see cargos)'), engine: int().optional().describe('road vehicle engine id (engines --type road --cargo <c>)'),
      vehicles: int().min(1).max(20).default(2), radius: int().min(2).max(12).default(4).describe('town ends: how far from the centre to look for a stop'),
      margin: int().min(2).max(80).default(20), max_bridge: int().min(3).max(40).default(12),
    }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      if ((a.from_industry !== undefined) === (a.from_town !== undefined)) throw new Error('give exactly one of --from_industry, --from_town');
      if ((a.to_industry !== undefined) === (a.to_town !== undefined)) throw new Error('give exactly one of --to_industry, --to_town');
      return buildTruckRoute(s, company, a);
    },
  },
  {
    name: 'build-track', group: 'build', session: true,
    description: 'Lay (or with remove=true, remove) one rail piece on tile x,y joining its neighbour from_x,from_y to its neighbour to_x,to_y. Existing track on the tile is kept, so this makes junctions: e.g. connect a depot or a branch onto an existing line. Neighbours may be straight across (straight piece) or at right angles (curve). A vehicle on the tiles (ERR_VEHICLE_IN_THE_WAY) gives transient: true and vehicles_in_the_way (blocked_by_vehicle in a dry run); --wait_clear_s N waits for it to pass and retries from that step.',
    args: z.object({ ...act, ...point, from_x: int(), from_y: int(), to_x: int(), to_y: int(), remove: bool().default(false), rail_type: int().optional(), ...waitClear }),
    run: (ctx, a) => runClear(ctx, a, [[a.remove ? 'rail_remove' : 'rail', a.from_x, a.from_y, a.x, a.y, a.to_x, a.to_y]], { railType: a.rail_type }),
  },
  {
    name: 'build-signal', group: 'build', session: true,
    description: 'Build a signal on the track tile x,y facing trains that come from the neighbouring tile `front`. type: path (default; trains may pass it from behind), path_oneway, block, entry, exit, combo. two_way applies to block/entry/exit/combo. remove=true removes it (refused with no_signal_here when there is none facing that way, and with loop_signal when the tile is on a passing loop: without that signal two trains can enter the loop from both ends; --force true removes it anyway). The track must exist; in a template\'s dry run, signals on track it lays show skipped_in_dry_run.',
    args: z.object({ ...act, ...point, ...front, type: z.enum(Object.keys(SIGNAL_TYPES)).default('path'), two_way: bool().default(false), remove: bool().default(false),
      force: bool().default(false).describe('remove: also remove a passing loop\'s signal') }),
    run: async (ctx, a) => {
      if (a.remove) {
        const { s } = await mine(ctx, a);
        const why = await signalRemoveRefusal(s, a);
        if (why) return { ok: false, dry_run: a.dry_run, error: why, first_error: why.split(':')[0], steps_done: 0, results: [] };
        const loop = a.force ? null : await loopOfTile(s, a.x, a.y);
        if (loop) {
          return { ok: false, dry_run: a.dry_run, first_error: 'loop_signal', steps_done: 0, results: [], loop: { x: loop.at.x, y: loop.at.y, end: loop.end, clear_tiles: loop.clear_tiles },
            error: `loop_signal: (${a.x},${a.y}) is on the passing loop between the points at (${loop.at.x},${loop.at.y}) and (${loop.end.x},${loop.end.y}); without this signal trains from both ends can enter the loop and crash or jam. Nothing was removed. To take the whole loop out use build-passing-loop --remove true; to remove only this signal pass --force true` };
        }
        return run(ctx, a, [['signal_remove', a.x, a.y, a.front_x, a.front_y]]);
      }
      return runClear(ctx, a, [['signal', a.x, a.y, a.front_x, a.front_y, SIGNAL_TYPES[a.type] + (a.two_way && SIGNAL_TYPES[a.type] < 4 ? 8 : 0)]]);
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
    description: 'Template: passing loop for a single-track line. The main track runs length+2 tiles from x,y in direction dir (sw=+x, se=+y, ne=-x, nw=-y); a second track is laid beside it (side=1 or -1) with one-way path signals: trains heading dir use the main track, the others the loop. Both sides have length-1 clear tiles between the points and the exit signal (fits trains up to length-2 tiles). Give --train_tiles N or --for_vehicle ID (the longest train on that vehicle\'s line is used); without either, the longest of your trains serving the line through x,y is used (train_from_line), else a train_length_unknown warning. Length then defaults to train+2, and a loop with fewer than train+1 clear tiles is refused (loop_too_short). Checked first (AgentBridge v9): every main-line tile must be straight track along dir, or free land (not_straight_at / blocked_at / signal_at {x,y}); loop tiles must be free (loop_side_occupied_at). After a real build: loop_check (both directions through the loop) and, with --for_vehicle, route_after (connected|broken with first_gap). remove=true with the same x,y,dir,length,side takes the loop track and both signals (including the one on the main track) out again; the main track stays. A vehicle on the tiles (ERR_VEHICLE_IN_THE_WAY) gives transient: true and vehicles_in_the_way (blocked_by_vehicle in a dry run); --wait_clear_s N waits for it to pass and retries from that step.',
    args: z.object({ ...act, ...point, dir: z.enum(DIR_NAMES).default('sw').describe('sw=+x, se=+y, ne=-x, nw=-y'), length: int().min(2).max(30).optional().describe('default: train tiles + 2, else 6'),
      side: int().default(1), rail_type: int().optional(),
      train_tiles: int().min(1).max(40).optional().describe('longest train that must wait in the loop, in tiles'),
      for_vehicle: int().optional().describe('a train of this line: its longest train sets train_tiles; also traces its route after the build'),
      remove: bool().default(false).describe('take out a loop built with the same arguments'), ...waitClear }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const info = await s.gs.call('info');
      const train = a.for_vehicle !== undefined ? await longestTrainOnLine(s, company, a.for_vehicle) : null;
      // C6: no train flags: the longest train already serving the line through x,y sets the size.
      const onLine = a.train_tiles === undefined && !train && !a.remove ? await longestTrainAt(s, company, a.x, a.y) : null;
      const trainTiles = a.train_tiles ?? train?.tiles ?? (onLine?.tiles || null);
      const length = a.length ?? (trainTiles ? trainTiles + 2 : 6);
      const lineNote = onLine ? (onLine.tiles ? { train_from_line: onLine } : { warnings: [{ train_length_unknown: `${onLine.reason}; the loop is sized ${length} (fits trains up to ${length - 2} tiles). Pass --train_tiles N or --for_vehicle ID` }] }) : {};
      if (length > 30) return { ok: false, dry_run: a.dry_run, error: `loop_too_long: trains of ${trainTiles} tiles need length ${length}; the template allows 30`, first_error: 'loop_too_long' };
      const t = passingLoopSteps({ x: a.x, y: a.y, dir: dirIndex(a.dir), length, side: a.side < 0 ? -1 : 1 });
      const geometry = { length, clear_tiles: t.clear_tiles, fits_trains_up_to_tiles: t.clear_tiles - 1, ends: t.ends, ...(trainTiles ? { train_tiles: trainTiles } : {}), ...(train ? { longest_train: train } : {}), ...lineNote };
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
      const res = await runClear(ctx, a, t.steps, { railType: a.rail_type });
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
    name: 'road-stop-sites', group: 'build', session: true,
    description: 'Where a bus or truck stop fits near a town (drive-through stops on straight town roads near the centre, then bay stops), an industry (bay stops within --radius, default 3, of its tiles) or a tile: each site dry-run checked as your company, with cost and build (the build-road-station command to run). --count N (default 3) sites at least --spacing tiles apart (Manhattan; e.g. 6 for a bus network across a town); --cargo C keeps only sites whose catchment accepts it (acceptance, radius 3); --with_depot true adds a depot spot beside a road near the first site (depot.build). rejected counts failed candidates by reason. Changes nothing. Example: --town Bigton --count 4 --spacing 5 --with_depot true',
    args: z.object({ ...who, town: z.string().optional().describe('town id or name'), industry: int().optional(), x: int().optional(), y: int().optional(),
      kind: z.enum(['bus', 'truck']).optional().describe('default: bus at a town, truck otherwise'), cargo: z.string().optional().describe('only sites that accept this cargo'),
      count: int().min(1).max(10).default(3), spacing: int().min(0).max(30).default(0).describe('least tiles between two returned sites'),
      radius: int().min(1).max(12).optional().describe('search radius; default 4 at a town, 3 at an industry or tile'),
      with_depot: bool().default(false).describe('also find a road depot spot near the first site') }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const [economy] = await Promise.all([s.economy(), s.ensureTiles()]);
      const end = lineEnd(s, economy, { town: a.town, industry: a.industry, x: a.x, y: a.y });
      const r = a.radius ?? (end.kind === 'town' ? 4 : 3);
      const kind = a.kind ?? (end.kind === 'town' ? 'bus' : 'truck');
      const xs = end.targets.map((t) => t[0]), ys = end.targets.map((t) => t[1]);
      await s.refreshArea(Math.min(...xs) - r - 8, Math.min(...ys) - r - 8, Math.max(...xs) + r + 8, Math.max(...ys) + r + 8);
      const cands = end.kind === 'town'
        ? [...townStopCandidates(s.map, { cx: end.point[0], cy: end.point[1], radius: r, max: 40 }), ...truckStopCandidates(s.map, { targets: [end.point], catchment: r, max: 40 })]
        : truckStopCandidates(s.map, { targets: end.targets, catchment: r, max: 40 });
      const want = a.cargo !== undefined ? cargoId(s.cargos, a.cargo) : undefined;
      const sites = [], rejected = {};
      const reject = (why) => { rejected[why] = (rejected[why] ?? 0) + 1; };
      let dryRuns = 0;
      for (const c of cands) {
        if (sites.length >= a.count || dryRuns >= Math.max(16, a.count * 8)) break;
        if (sites.some((p) => p.x === c.x && p.y === c.y)) continue;
        if (a.spacing && sites.some((p) => tileDistance(p, c) < a.spacing)) { reject('too_close'); continue; }
        dryRuns++;
        const steps = [['road_station', c.x, c.y, c.front_x, c.front_y, kind === 'truck', c.drive_through, -1], ...(c.drive_through ? [] : [['road', c.front_x, c.front_y, c.x, c.y]])];
        const dry = await s.exec(company, steps, { dryRun: true });
        if (!dry.ok) { reject(dry.first_error ?? 'failed'); continue; }
        let acceptance;
        if (want !== undefined) {
          const lists = await acceptanceAt(s, [[c.x, c.y]], { radius: 3, cargos: [want] });
          acceptance = lists ? (lists[0][0]?.acceptance ?? 0) : null;
          if (acceptance !== null && acceptance < ACCEPTED) { reject('not_accepted'); continue; }
        }
        sites.push({ x: c.x, y: c.y, front_x: c.front_x, front_y: c.front_y, drive_through: c.drive_through, cost: dry.cost, ...(acceptance !== undefined ? { acceptance } : {}),
          tiles_from_target: Math.min(...end.targets.map(([tx, ty]) => tileDistance(c, { x: tx, y: ty }))),
          build: `build-road-station --x ${c.x} --y ${c.y} --front_x ${c.front_x} --front_y ${c.front_y} --kind ${kind}${c.drive_through ? ' --drive_through true' : ''}` });
      }
      let depot;
      if (a.with_depot && sites.length) {
        const f = sites[0];
        const roads = [];
        for (let y = f.y - 6; y <= f.y + 6; y++) for (let x = f.x - 6; x <= f.x + 6; x++) if (s.map.inBounds(x, y) && s.map.classAt(x, y) === 'd') roads.push([x, y]);
        const skip = new Set(sites.map((p) => `${p.x},${p.y}`));
        depot = null;
        for (const d of roadDepotCandidates(s.map, roads, { x: f.x, y: f.y }, { skip })) {
          const dry = await s.exec(company, [['road_depot', d.x, d.y, d.front_x, d.front_y], ['road', d.front_x, d.front_y, d.x, d.y]], { dryRun: true });
          if (dry.ok) { depot = { x: d.x, y: d.y, front_x: d.front_x, front_y: d.front_y, cost: dry.cost, build: `build-road-depot --x ${d.x} --y ${d.y} --front_x ${d.front_x} --front_y ${d.front_y}` }; break; }
        }
      }
      // Every candidate refused by the town: say who and why once (R8), not just a count.
      const la = !sites.length && rejected.ERR_LOCAL_AUTHORITY_REFUSES ? await authorityDetail(s, company, ['road_station'], { x: end.point[0], y: end.point[1] }) : null;
      return { target: end.what, kind, candidates_on_map: cands.length, dry_runs: dryRuns, rejected, ...listResult('sites', sites, sites), ...(la ? { local_authority: la } : {}),
        ...(depot !== undefined ? { depot } : {}),
        ...(sites.length < a.count ? { hint: `${sites.length} of ${a.count} sites found: try --radius ${Math.min(12, r + 3)}${a.spacing ? ', a smaller --spacing' : ''}${a.cargo ? ', or no --cargo' : ''}` } : {}) };
    },
  },
  {
    name: 'build-road-path', group: 'build', session: true,
    description: 'Plan and build a road between two tiles (both included), reusing existing roads where that is cheaper, going round houses and industries, bridging water and rail where it must. dry_run=true for the cost first. road_type (see road-types) lays that road or tram type (tram track can go on existing roads).',
    args: z.object({ ...pathArgs, road_type: int().optional().describe('road type id from road-types (trams: a tram type); default plain road') }),
    run: (ctx, a) => buildPath(ctx, a, 'road'),
  },
  {
    name: 'build-road-station', group: 'build', session: true,
    description: 'Build a bus or truck stop at x,y with its entrance facing front (a neighbouring road tile). drive_through=true builds on a straight road tile (front picks the axis; not on junctions). A normal (bay) stop also gets the road piece on front that joins its entrance. Returns station {id, name} (the new or joined station) and connected (AgentBridge v11): true when the entrance (or one end of a drive-through stop) joins a road beyond it. connect=auto builds a road from the entrance to the nearest road when it does not. A refused drive-through stop says why where it can tell (junction, one_way_road, other_owner_road, slope).',
    args: z.object({ ...act, ...borrow, ...point, ...front, kind: z.enum(['bus', 'truck']).default('truck'), drive_through: bool().default(false), ...join,
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
      const out = await withRoadJoin(s, company, a, res, a.drive_through ? 'drive_through' : 'bay');
      if (!out.ok || a.dry_run) return out;
      return { ...out, station: await builtStationAt(s, company, a.x, a.y, 'road') };
    },
  },
  {
    name: 'build-road-depot', group: 'build', session: true,
    description: 'Build a road vehicle depot at x,y with its entrance facing front (a neighbouring road tile), plus the road piece on front that joins the entrance. Returns depot {x, y} and front for vehicle-buy, and connected (AgentBridge v11): true when the front tile joins a road beyond it. connect=auto builds a road from the front tile to the nearest road when it does not.',
    args: z.object({ ...act, ...borrow, ...point, ...front,
      connect: z.enum(['none', 'auto']).default('none').describe('auto = when the front tile does not join a road, build a road path from it to the nearest road'), road_type: int().optional().describe('road type id from road-types (trams: a tram type); default plain road') }),
    run: async (ctx, a) => {
      const res = await run(ctx, a, [['road_depot', a.x, a.y, a.front_x, a.front_y], ['road', a.front_x, a.front_y, a.x, a.y]], a.road_type !== undefined ? { roadType: a.road_type } : {});
      const { s, company } = await mine(ctx, a);
      const out = await withRoadJoin(s, company, a, res, 'depot');
      if (!out.ok || a.dry_run) return out;
      return { ...out, depot: { x: a.x, y: a.y }, front: { x: a.front_x, y: a.front_y }, next: `vehicle-buy --depot_x ${a.x} --depot_y ${a.y} --engine <id> (engines --type road)` };
    },
  },

  // ---- build: bridges, tunnels, land ------------------------------------------------------
  {
    name: 'build-bridge', group: 'build', session: true,
    description: 'Build a rail, road or water (aqueduct) bridge between two tiles in a straight line (the ramps go on those tiles).',
    args: z.object({ ...act, ...borrow, type: z.enum(['rail', 'road', 'water']).default('rail'), x1: int(), y1: int(), x2: int(), y2: int(), ...bridgeArg, rail_type: int().optional() }),
    run: (ctx, a) => run(ctx, a, [['bridge', transport(a.type), a.x1, a.y1, a.x2, a.y2, bridgeType(a.bridge)]], { railType: a.rail_type }),
  },
  {
    name: 'build-tunnel', group: 'build', session: true,
    description: 'Build a rail or road tunnel starting at x,y, a tile at the foot of a slope; the game finds the other end straight through the hill.',
    args: z.object({ ...act, ...borrow, type: z.enum(['rail', 'road']).default('rail'), ...point, rail_type: int().optional() }),
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
    args: z.object({ ...act, ...borrow, ...point, ...join }),
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
    args: z.object({ ...act, ...borrow, ...point, airport: z.string().default('small'), ...join }),
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
 * Forgiving argument names: --id for --vehicle, --vehicle for --vehicles and back (one id), --share and
 * --share_orders for each other.
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
  move('share', 'share_orders'); // vehicle-clone --share (C12)
  move('share_orders', 'share'); // orders-copy --share_orders
  move('company', 'companies'); // events --company N (events take no `company`: see events)
  return out;
}

/** zod issues -> "--key: message (got 'raw')" lines; a missing key says "required". */
function argErrors(error, raw) {
  return error.issues.map((i) => {
    const key = i.path[0];
    if (key !== undefined && i.path.length === 1 && i.code === 'invalid_type' && raw[key] === undefined) return `--${key}: required`;
    const got = key !== undefined && key in raw ? ` (got ${JSON.stringify(raw[key])})` : '';
    return `${key !== undefined ? `--${i.path.join('.')}` : 'arguments'}: ${i.message}${got}`;
  }).join('; ');
}

/** Drop keys whose value is null or undefined: JSON callers send null for "not given". */
const dropNulls = (raw) => Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined));

/**
 * Validate `args` against the command schema, repairing what has one obvious meaning (zod issue
 * driven, so it covers every argument): a numeric string for a number arg becomes the number (CLI
 * flags are text); a JSON number for a string arg becomes its text (P4); ""
 * for a number counts as not given; an out-of-range number is clamped to the bound (L13) in read
 * commands and dry runs only (a real build must not silently do something else). Returns
 * { data, args (repaired raw), clamped } or throws bad_arguments.
 */
function parseArgs(cmd, name, args, cls) {
  const a = { ...args };
  const clamped = {};
  const mayClamp = cls === 'read' || a.dry_run === true || a.dry_run === 'true';
  for (let round = 0; round < 4; round++) {
    const parsed = cmd.args.safeParse(a);
    if (parsed.success) return { data: parsed.data, args: a, clamped };
    let fixed = false;
    for (const i of parsed.error.issues) {
      if (i.path.length !== 1) continue;
      const k = i.path[0];
      const v = a[k];
      if (i.code === 'invalid_type' && i.expected === 'number' && typeof toNumber(v) === 'number') { a[k] = toNumber(v); fixed = true; }
      else if (i.code === 'invalid_type' && i.expected === 'string' && typeof v === 'number') { a[k] = String(v); fixed = true; }
      else if (i.code === 'invalid_type' && i.expected === 'number' && typeof v === 'string' && v.trim() === '') { delete a[k]; fixed = true; }
      else if (mayClamp && (i.code === 'too_big' || i.code === 'too_small') && i.origin === 'number' && i.inclusive !== false && typeof toNumber(v) === 'number') {
        const to = Number(i.code === 'too_big' ? i.maximum : i.minimum);
        clamped[k] = { from: toNumber(v), to };
        a[k] = to;
        fixed = true;
      }
    }
    if (!fixed) throw new Error(`bad_arguments: bad arguments for ${name}: ${argErrors(parsed.error, a)}`);
  }
  throw new Error(`bad_arguments: bad arguments for ${name}: could not repair them`);
}

/** A failed admin connection (direct mode) -> { hint, network } for its address, or null. */
function adminConnectHint(message) {
  const m = /admin connect to (\[[^\]]+\]|[^\s:]+):(\d+) failed: (\S+?)[.)]?(\s|$)/.exec(message) ?? /no welcome from (\[[^\]]+\]|[^\s:]+):(\d+) within/.exec(message);
  if (!m) return null;
  return connectionHint(m[1], m[3] ?? 'timeout', { kind: 'admin' });
}

/**
 * Validate and run one command; the full enveloped result (no output shaping). The daemon and the
 * relay serve this; callers shape it once (runCommand / dispatch). opts.readOnly: L12 gate.
 * Throws with a readable `code: text` message on bad arguments.
 */
export async function executeCommand(ctx, name, rawArgs = {}, { readOnly = false } = {}) {
  const cmd = COMMANDS_BY_NAME.get(name);
  if (!cmd) throw new Error(`unknown_command: unknown command '${name}'. Run: openttd-agent help`);
  const known = Object.keys(cmd.args.shape ?? {});
  const cls = commandClass(name, known);
  let args = aliasArgs(known, dropNulls(rawArgs));
  // L13: flags that cannot mean anything here are dropped with a note instead of failing the call.
  const ignored = [];
  const ignore = (k) => { delete args[k]; ignored.push(k); };
  if (cls === 'read') for (const k of ['dry_run', 'list']) if (k in args && !known.includes(k)) ignore(k);
  if (name === 'vehicle-depot' && args.depot === 'auto' && !known.includes('depot')) ignore('depot');
  // Refuse unknown keys: a mistyped or `--help` flag must never run the command with defaults
  // (`turn-advance --help` once advanced the game 30 days).
  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length) {
    throw new Error(`unknown_argument: unknown argument${unknown.length > 1 ? 's' : ''} for ${name}: ${unknown.map((k) => `--${k}`).join(', ')}. Valid: ${known.map((k) => `--${k}`).join(' ') || '(none)'} (and on every command: --fields --brief --compact --steps). Nothing was run.`);
  }
  let forced = false;
  if (readOnly) ({ args, forced } = readOnlyGate(name, known, args));
  const parsed = parseArgs(cmd, name, args, cls);
  const notes = {
    ...(forced ? { forced_dry_run: true } : {}),
    ...(Object.keys(parsed.clamped).length ? { clamped: parsed.clamped } : {}),
    ...(ignored.length ? { ignored_args: ignored } : {}),
  };
  const withNotes = (res) => (Object.keys(notes).length ? { ...res, ...notes } : res);
  // Player with a relay configured: the host's relay runs every game command (it holds the admin connection and the map mirror).
  if (cmd.session && ctx.cfg.relay) {
    let res;
    try { res = envelope(await callRelay(ctx.cfg, name, parsed.args)); } catch (e) {
      const h = e.netCode ? connectionHint(ctx.cfg.relay, e.netCode, { kind: 'relay' }) : null;
      if (!h) throw e;
      return withNotes({ ok: false, error: e.message, first_error: errorCode(e.message), hint: h.hint, network: h.network });
    }
    const host = res.versions?.openttd_agent;
    if (name === 'status' && host && host !== VERSION) {
      res.warnings = [...(res.warnings ?? []), `the host's relay runs openttd-agent ${host}, you run ${VERSION}: use the same version (npx -y github:mmmnorthmark/openttd-agent#v${host} ...)`];
    }
    return withNotes(res);
  }
  // G20: every game action (a command with dry_run) answers with the bank balance after it.
  const wantMoney = cmd.session && cls === 'dry_run';
  const mark = wantMoney ? (await ctx.session()).lastExec?.n ?? 0 : 0;
  let res;
  try { res = envelope(await cmd.run(ctx, parsed.data)); } catch (e) {
    const h = cmd.session ? adminConnectHint(e.message) : null;
    if (!h) throw e;
    return withNotes({ ok: false, error: e.message, first_error: errorCode(e.message), hint: h.hint, network: h.network });
  }
  if (wantMoney && res.money_after === undefined) {
    const m = await moneyAfter(ctx, parsed.data.company, mark, res);
    if (m !== undefined) res.money_after = m;
  }
  return withNotes(res);
}

/**
 * Bank balance of `company` (default: the configured one) after a call: from the call's last
 * exec reply when it ran one for that company, else the result's own top-level `money` (GS
 * replies give the balance after the action), else from GS `companies` (one extra call).
 * undefined when unknown (no company, the game did not answer).
 */
async function moneyAfter(ctx, company, mark, res) {
  try {
    const s = await ctx.session();
    const c = company ?? s.cfg.company;
    if (c === null || c === undefined) return undefined;
    const last = s.lastExec;
    if (last && last.n > mark && last.company === c && typeof last.money === 'number') return last.money;
    if (typeof res.money === 'number') return res.money;
    return (await s.gs.call('companies')).find((r) => r.id === c)?.money;
  } catch {
    return undefined;
  }
}

/**
 * Validate, run and shape one command: the library and in-process entry. Takes the reserved
 * output args (fields, brief, compact, steps; see src/output.js) besides the command's own.
 */
export async function runCommand(ctx, name, rawArgs = {}, opts = {}) {
  const cmd = COMMANDS_BY_NAME.get(name);
  const { args, output } = takeOutputArgs(rawArgs, cmd ? Object.keys(cmd.args.shape ?? {}) : []);
  return shapeResult(await executeCommand(ctx, name, args, opts), output);
}

/** JSON schema of a command's arguments as callers send them (io: 'input', as MCP tools/list shows). */
export const argsJsonSchema = (cmd) => z.toJSONSchema(cmd.args, { io: 'input' });

export function describeCommands() {
  return COMMANDS.map((c) => ({ name: c.name, group: c.group, description: c.description, needs_game: c.session, args: argsJsonSchema(c) }));
}
