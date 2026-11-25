// Single registry of every command. The CLI, the daemon, and the MCP server all
// expose exactly these, with the same names, schemas and JSON results.
//
// Command shape: { name, group, description, session: bool, args: zod object, run(ctx, args) }
// ctx: { cfg, session() -> Promise<Session> } — session() connects lazily.

import * as z from 'zod/v4';
import { doctor, installGamescript, launch } from './setup.js';
import { saveConfig, redacted, CONFIG_FILE } from './config.js';
import { vehicleTypeId, cargoId, stationsFromRows, vehiclesFromRows, enginesFromRows, groupsFromRows, vehicleDetail,
  encodeOrderFlags, ORDER_FLAG_HELP, VEHICLE_TYPES, VEHICLE_STATES, FACILITIES } from './operate.js';
import { routeEffort, findCargoPairs, townGaps, findFlatSites, manhattan, DEFAULT_COSTS } from './world.js';

const int = () => z.coerce.number().int();
const num = () => z.coerce.number();
const bool = () => z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const point = { x: int().describe('tile x'), y: int().describe('tile y') };
/** "1,2,3" | 5 | [1,2] -> [ints] */
const ids = () => z.preprocess((v) => (Array.isArray(v) ? v : String(v).split(',').filter((t) => t.trim() !== '')), z.array(int()).min(1));
const who = { company: int().optional().describe('company id; default: your configured company') };
const act = { ...who, dry_run: bool().default(false).describe('true = cost/feasibility only, changes nothing') };
const lc = (v) => String(v).toLowerCase();

/** Session + company for read commands. */
async function mine(ctx, a) {
  const s = await ctx.session();
  return { s, company: s.companyOrThrow(a.company) };
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
    name: 'install-gamescript', group: 'setup', session: false,
    description: 'HOST ONLY: copy the bundled AgentBridge GameScript (and IdleAI test AI) into the OpenTTD personal dir. Re-run after updating openttd-agent.',
    args: z.object({}),
    run: () => installGamescript(),
  },
  {
    name: 'configure', group: 'setup', session: false,
    description: `Save connection settings to ${CONFIG_FILE}: host (LAN IP of the game host), admin_port, admin_password, company (your company id), max_builds_per_minute (0 = unlimited).`,
    args: z.object({
      host: z.string().optional(), admin_port: int().optional(), admin_password: z.string().optional(),
      company: int().optional(), max_builds_per_minute: int().min(0).optional(), tile_refresh_rows_per_sec: int().min(0).optional(),
    }),
    run: (_ctx, a) => redacted(saveConfig(a)),
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
      admin_password: z.string().optional().describe('required for dedicated/host; defaults to configured admin_password'),
      join_host: z.string().optional().describe('host LAN IP for mode=join; defaults to configured host'),
      seed: int().optional(), map_bits: int().min(6).max(12).default(8).describe('map size as power of two: 8=256, 9=512, 10=1024'),
      load: z.string().optional().describe('savegame path to load instead of generating a new map'),
      command_delay_ticks: int().min(0).max(74).default(0).describe('GameScript rate limit: extra ticks after each build command (0 = full speed)'),
      max_builds_per_day: int().min(0).default(0).describe('GameScript rate limit per company per game day (0 = unlimited)'),
      bind: z.string().default('0.0.0.0'), dry_run: bool().default(false),
    }),
    run: (ctx, a) => launch({
      mode: a.mode, adminPassword: a.admin_password ?? ctx.cfg.admin_password, joinHost: a.join_host ?? ctx.cfg.host,
      seed: a.seed, mapBits: a.map_bits, load: a.load, commandDelayTicks: a.command_delay_ticks,
      maxBuildsPerDay: a.max_builds_per_day, bind: a.bind, adminPort: ctx.cfg.admin_port, dryRun: a.dry_run,
    }),
  },

  // ---- game -------------------------------------------------------------------
  {
    name: 'status', group: 'game', session: true,
    description: 'Game date, map size, pause state, your company, rate limits, tile-mirror progress.',
    args: z.object({}),
    run: async (ctx) => {
      const s = await ctx.session();
      const [info, companies, rate] = await Promise.all([s.gs.call('info'), s.gs.call('companies'), s.gs.call('get_rate')]);
      const loaded = s.map.rowsLoaded.reduce((n, v) => n + v, 0);
      return { info, my_company: s.cfg.company, companies, rate, client_max_builds_per_minute: s.cfg.max_builds_per_minute,
        tile_mirror: { rows_loaded: loaded, rows_total: s.map.sizeY, load_ms: s.tileLoadMs ?? null } };
    },
  },
  {
    name: 'companies', group: 'game', session: true,
    description: 'All companies: money, loan, last-quarter income/expenses/value/cargo delivered/performance. Use for competitor assessment.',
    args: z.object({}),
    run: async (ctx) => (await ctx.session()).gs.call('companies'),
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

  // ---- world (analysis; read-only) ---------------------------------------------
  {
    name: 'cargos', group: 'world', session: true,
    description: 'Cargo types in this game (ids, names, passenger/mail flags).',
    args: z.object({}),
    run: async (ctx) => [...(await ctx.session()).cargos.values()],
  },
  {
    name: 'industry-types', group: 'world', session: true,
    description: 'Industry types with produced and accepted cargo ids.',
    args: z.object({}),
    run: async (ctx) => [...(await ctx.session()).types.values()],
  },
  {
    name: 'towns', group: 'world', session: true,
    description: 'Towns with population and last-month passenger/mail production and transported %. Filter by min_population; sorted by population.',
    args: z.object({ min_population: int().default(0), limit: int().default(50), name: z.string().optional() }),
    run: async (ctx, a) => {
      const { towns } = await (await ctx.session()).economy();
      return towns.filter((t) => t.population >= a.min_population && (!a.name || t.name.toLowerCase().includes(a.name.toLowerCase())))
        .sort((x, y) => y.population - x.population).slice(0, a.limit);
    },
  },
  {
    name: 'industries', group: 'world', session: true,
    description: 'Industries with location, last-month production per cargo and % transported ("unexploited" = low %). Filter by type name / cargo name substring, max_transported_pct, near x,y within radius.',
    args: z.object({
      type: z.string().optional(), cargo: z.string().optional(), max_transported_pct: int().default(100),
      min_production: int().default(0), near_x: int().optional(), near_y: int().optional(), radius: int().optional(), limit: int().default(50),
    }),
    run: async (ctx, a) => {
      const { industries } = await (await ctx.session()).economy();
      const lc = (s) => String(s).toLowerCase();
      return industries.filter((i) => (!a.type || lc(i.type_name).includes(lc(a.type)))
        && (a.near_x === undefined || manhattan(i, { x: a.near_x, y: a.near_y }) <= (a.radius ?? 50))
        && (!a.cargo && a.max_transported_pct >= 100 && a.min_production <= 0
          ? true
          : i.produces.some((p) => (!a.cargo || lc(p.cargo_name).includes(lc(a.cargo))) && p.transported_pct <= a.max_transported_pct && p.last_month >= a.min_production)))
        .slice(0, a.limit);
    },
  },
  {
    name: 'find-cargo-pairs', group: 'world', session: true,
    description: 'Opportunity finder: under-served producers of a cargo paired with accepting industries min_distance..max_distance tiles away, ranked by terrain effort of the route between them (water, hills, towns, existing track). Example: cargo=wood, source_type=forest, dest_type=sawmill, min_distance=100, max_distance=200, max_transported_pct=20.',
    args: z.object({
      cargo: z.string().optional(), source_type: z.string().optional(), dest_type: z.string().optional(),
      min_distance: int().default(0), max_distance: int().default(1000), max_transported_pct: int().default(100),
      min_production: int().default(0), limit: int().default(10), with_effort: bool().default(true),
    }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      const { industries } = await s.economy();
      if (a.with_effort) await s.ensureTiles();
      return findCargoPairs({ industries, types: s.types, map: s.map, cargo: a.cargo, sourceType: a.source_type, destType: a.dest_type,
        minDist: a.min_distance, maxDist: a.max_distance, maxTransportedPct: a.max_transported_pct, minProduction: a.min_production,
        limit: a.limit, withEffort: a.with_effort });
    },
  },
  {
    name: 'town-gaps', group: 'world', session: true,
    description: 'Towns ranked by passengers produced last month that nobody transported (unexploited passenger base).',
    args: z.object({ min_population: int().default(500), max_transported_pct: int().default(100), limit: int().default(15) }),
    run: async (ctx, a) => townGaps((await (await ctx.session()).economy()).towns,
      { minPopulation: a.min_population, maxTransportedPct: a.max_transported_pct, limit: a.limit }),
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
    run: async (ctx) => (await ctx.session()).gs.call('airport_types'),
  },
  {
    name: 'airport-sites', group: 'world', session: true,
    description: 'Find places to build an airport near a town: flat buildable rectangles of the airport size within radius, each checked for town noise limit and (with your company) a dry-run build with cost.',
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
      const sites = findFlatSites(s.map, { cx: town.x, cy: town.y, width: at.width, height: at.height, radius: a.radius, maxHeightSpread: a.max_height_spread, limit: a.limit * 3 });
      const company = s.cfg.company;
      const checked = [];
      for (const site of sites) {
        const chk = await s.gs.call('check_airport', { x: site.x, y: site.y, type: at.type, ...(company !== null && company !== undefined ? { company } : {}) });
        checked.push({ ...site, ...chk, noise_ok: chk.noise_increase <= chk.town_allowed_noise });
        if (checked.filter((c) => c.noise_ok && c.buildable !== false).length >= a.limit) break;
      }
      return { town: { name: town.name, x: town.x, y: town.y, population: town.population, pax_unserved: town.pax_unserved, allowed_noise: town.allowed_noise },
        airport: at, sites: checked };
    },
  },
  {
    name: 'tiles', group: 'world', session: true,
    description: 'Raw terrain mirror for a small rectangle: height, slope and class per tile (water, clear, trees, other=houses/objects, rail, road, station, industry...). Max 40x40.',
    args: z.object({ x0: int(), y0: int(), x1: int(), y1: int(), refresh: bool().default(true) }),
    run: async (ctx, a) => {
      if ((a.x1 - a.x0 + 1) * (a.y1 - a.y0 + 1) > 1600) throw new Error('area too large; max 40x40 tiles');
      const s = await ctx.session();
      if (a.refresh) await s.refreshArea(a.x0, a.y0, a.x1, a.y1); else await s.ensureTiles();
      const rows = [];
      for (let y = a.y0; y <= a.y1; y++) {
        const r = [];
        for (let x = a.x0; x <= a.x1; x++) r.push(`${s.map.classAt(x, y)}${s.map.heightAt(x, y)}${s.map.slopeAt(x, y) ? '/' : ''}`);
        rows.push({ y, tiles: r.join(' ') });
      }
      return { legend: 'class letter + height, "/" = sloped. w water c coast i industry s station r rail d road t trees f farm k rocks h rough b clear o other(houses/objects)', x0: a.x0, rows };
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
    description: 'Build a straight road from (x1,y1) to (x2,y2) as your company. Subject to client and GameScript rate limits.',
    args: z.object({ x1: int(), y1: int(), x2: int(), y2: int(), company: int().optional() }),
    run: async (ctx, a) => {
      const s = await ctx.session();
      s.throttleBuild();
      return s.gs.call('build_road', { ...a, company: s.companyOrThrow(a.company) });
    },
  },

  // ---- operate (read) -------------------------------------------------------------
  {
    name: 'stations', group: 'operate', session: true,
    description: 'Your stations (or --company X): location, facilities (rail/truck/bus/airport/dock), per-cargo waiting amount and rating %, vehicles serving. Filter with facility, cargo (name), min_waiting, max_rating_pct (e.g. find poorly served stations).',
    args: z.object({ ...who, facility: z.enum(FACILITIES).optional(), cargo: z.string().optional(), min_waiting: int().default(0),
      max_rating_pct: int().default(100), name: z.string().optional(), limit: int().default(100) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const cargoFilter = a.cargo !== undefined || a.min_waiting > 0 || a.max_rating_pct < 100;
      return stationsFromRows(await s.gs.call('stations', { company }), s.cargos)
        .filter((st) => (!a.facility || st.facilities.includes(a.facility)) && (!a.name || lc(st.name).includes(lc(a.name)))
          && (!cargoFilter || st.cargo.some((c) => (!a.cargo || lc(c.name).includes(lc(a.cargo))) && c.waiting >= a.min_waiting && c.rating_pct <= a.max_rating_pct)))
        .slice(0, a.limit);
    },
  },
  {
    name: 'vehicles', group: 'operate', session: true,
    description: 'Your vehicles: type, engine, age (days and % of max age), reliability, profit this/last year, value, running cost, state, location, group, order count. Filters: type, group, state, max_profit_last_year (e.g. 0 = loss makers), min_age_pct (e.g. 90 = due for replacement), max_reliability_pct, name. Breakdown counts and service intervals are not exposed by the game to scripts.',
    args: z.object({ ...who, type: z.enum(VEHICLE_TYPES).optional(), group: int().optional(), state: z.enum(VEHICLE_STATES).optional(),
      max_profit_last_year: int().optional(), min_age_pct: int().default(0), max_reliability_pct: int().default(100), name: z.string().optional(), limit: int().default(200) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const all = vehiclesFromRows(await s.gs.call('vehicles', { company }));
      const vehicles = all.filter((v) => (!a.type || v.type === a.type) && (a.group === undefined || v.group === a.group) && (!a.state || v.state === a.state)
        && (a.max_profit_last_year === undefined || v.profit_last_year <= a.max_profit_last_year) && v.age_pct >= a.min_age_pct
        && v.reliability_pct <= a.max_reliability_pct && (!a.name || lc(v.name).includes(lc(a.name))));
      return { total: all.length, matched: vehicles.length, vehicles: vehicles.slice(0, a.limit) };
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
    name: 'engines', group: 'operate', session: true,
    description: 'Engines/wagons/vehicles your company can buy now: price, capacity, max speed, reliability, running cost per year, lifespan, design year, power. type is required; cargo (name) keeps wagons/vehicles refittable to it and locomotives that can pull it; rail_type keeps trains for that track (see rail-types). Newest design first: compare with your fleet to decide replacements.',
    args: z.object({ ...who, type: z.enum(VEHICLE_TYPES), cargo: z.string().optional(), rail_type: int().optional(), wagons: bool().optional().describe('rail only: true = wagons only, false = locomotives only'), limit: int().default(60) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      const cargo = cargoId(s.cargos, a.cargo);
      const rows = await s.gs.call('engines', { company, type: vehicleTypeId(a.type), ...(cargo !== undefined ? { cargo } : {}), ...(a.rail_type !== undefined ? { rail_type: a.rail_type } : {}) });
      return enginesFromRows(rows, s.cargos).filter((e) => a.wagons === undefined || e.is_wagon === a.wagons)
        .sort((x, y) => y.design_year - x.design_year).slice(0, a.limit);
    },
  },
  {
    name: 'groups', group: 'operate', session: true,
    description: 'Your vehicle groups with vehicle count and profit this/last year. Use one group per strategy to account for it.',
    args: z.object({ ...who }),
    run: async (ctx, a) => { const { s, company } = await mine(ctx, a); return groupsFromRows(await s.gs.call('groups', { company })); },
  },
  {
    name: 'depots', group: 'operate', session: true,
    description: 'Your depots (or hangars) of one type with the number of vehicles inside. Vehicles are bought and cloned at a depot tile.',
    args: z.object({ ...who, type: z.enum(VEHICLE_TYPES) }),
    run: async (ctx, a) => {
      const { s, company } = await mine(ctx, a);
      return (await s.gs.call('depots', { company, type: vehicleTypeId(a.type) })).map(([x, y, vehicles]) => ({ x, y, vehicles }));
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
    description: 'Buy `count` vehicles of an engine id (see engines) at your depot tile (see depots). cargo (name) refits on purchase. For trains buy the locomotive first, then wagons with attach_to=<train id>. New ids are in `vehicles`. Vehicles start stopped in the depot: add orders, then vehicle-start.',
    args: z.object({ ...act, depot_x: int(), depot_y: int(), engine: int(), cargo: z.string().optional(), attach_to: int().default(-1), count: int().min(1).max(50).default(1) }),
    run: async (ctx, a) => {
      const { s } = await mine(ctx, a);
      const cargo = cargoId(s.cargos, a.cargo) ?? -1;
      const res = await run(ctx, a, Array.from({ length: a.count }, () => ['veh_buy', a.depot_x, a.depot_y, a.engine, cargo, a.attach_to]));
      return { ...res, vehicles: res.results.filter((r) => r.ok && r.value !== undefined).map((r) => r.value) };
    },
  },
  {
    name: 'vehicle-clone', group: 'operate', session: true,
    description: 'Clone a vehicle `count` times at a depot tile, sharing its orders by default; start=true starts the clones. New ids are in `vehicles`.',
    args: z.object({ ...act, depot_x: int(), depot_y: int(), vehicle: int(), share_orders: bool().default(true), count: int().min(1).max(50).default(1), start: bool().default(false) }),
    run: async (ctx, a) => {
      const res = await run(ctx, a, Array.from({ length: a.count }, () => ['veh_clone', a.depot_x, a.depot_y, a.vehicle, a.share_orders]));
      const vehicles = res.results.filter((r) => r.ok && r.value !== undefined).map((r) => r.value);
      if (!a.start || a.dry_run || !vehicles.length) return { ...res, vehicles };
      const { s, company } = await mine(ctx, a);
      const started = await s.exec(company, vehicles.map((v) => ['veh_start_stop', v, 1]), { keepGoing: true });
      return { ...res, vehicles, started: started.ok };
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
    description: 'Send vehicles (comma-separated ids) to a depot: they stop there (needed before vehicle-sell). service=true = service only and carry on.',
    args: z.object({ ...act, vehicles: ids(), service: bool().default(false) }),
    run: (ctx, a) => run(ctx, a, a.vehicles.map((v) => ['veh_depot', v, a.service]), { keepGoing: true }),
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
];

export const COMMANDS_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** Validate args and run. Throws with a readable message on bad args. */
export async function runCommand(ctx, name, rawArgs = {}) {
  const cmd = COMMANDS_BY_NAME.get(name);
  if (!cmd) throw new Error(`unknown command '${name}'. Run: openttd-agent help`);
  const parsed = cmd.args.safeParse(rawArgs);
  if (!parsed.success) throw new Error(`bad arguments for ${name}: ${z.prettifyError(parsed.error)}`);
  return cmd.run(ctx, parsed.data);
}

export function describeCommands() {
  return COMMANDS.map((c) => ({ name: c.name, group: c.group, description: c.description, needs_game: c.session, args: z.toJSONSchema(c.args) }));
}
