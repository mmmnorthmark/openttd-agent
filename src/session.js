// A live connection to one game: admin client + GS RPC + world mirror.
// Used in-process by the daemon and by the MCP server.

import fs from 'node:fs';
import path from 'node:path';
import { AdminClient, UPDATE, FREQ } from './admin-client.js';
import { CONFIG_DIR } from './config.js';
import { GSRpc } from './gs-rpc.js';
import { TileMap, townsFromRows, industriesFromRows } from './world.js';
import { execSummary, VEHICLE_STATES } from './operate.js';
import { recordStall } from './problems.js';
import { diagnoseGs } from './host.js';
import { log } from './log.js';

const ECONOMY_TTL_MS = 60_000; // towns/industries refresh at most once a minute (~1 game month)
const JOB_GAMES_KEPT = 10;      // games remembered per jobs file

/** A Map that calls onChange after every set/delete/clear (pending job queues are persisted on change). */
export class WatchedMap extends Map {
  constructor(onChange) { super(); this.onChange = onChange; }
  set(k, v) { super.set(k, v); this.onChange?.(); return this; }
  delete(k) { const had = super.delete(k); if (had) this.onChange?.(); return had; }
  clear() { const had = this.size > 0; super.clear(); if (had) this.onChange?.(); }
}

/** ~/.openttd-agent/jobs-<host>-<port>.json: background jobs per game on that server (D2). */
export function jobsFile(cfg) {
  return path.join(CONFIG_DIR, `jobs-${String(cfg.host ?? '127.0.0.1').replace(/[^A-Za-z0-9.-]/g, '_')}-${cfg.admin_port}.json`);
}

/** Stable identity of the running game from the admin welcome: generation seed + start date (both kept in saves). */
export const gameKeyOf = (welcome) => (welcome ? `${welcome.seed}-${welcome.startDate}` : null);

function readJobs(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j.games === 'object' ? j : { version: 1, games: {} }; } catch { return { version: 1, games: {} }; }
}

export class Session {
  constructor(cfg) {
    this.cfg = cfg;
    this.admin = null;
    this.gs = null;
    this.info = null;
    this.cargos = null;      // Map id -> cargo
    this.types = null;       // Map id -> industry type
    this.map = null;         // TileMap
    this._economy = { at: 0, towns: null, industries: null };
    this._buildTimes = [];   // timestamps of recent builds (client-side throttle)
    this._tileLoad = null;   // promise of the initial full dump
    this._refreshTimer = null;
    this._refreshRow = 0;
    // Background jobs (pendingSales, pendingWagons, _autoSave) are saved to jobsFile(cfg) under the game's key on every
    // change and restored on connect to the same game, so they survive a daemon restart (D2).
    this.gameKey = null;
    this.jobsRestored = null;
    this._restoring = false;
    this.pendingSales = new WatchedMap(() => this.persistJobs()); // "company:vehicle" -> { company, vehicle, replaced_by, since } (vehicle-replace)
    this._salesTimer = null;
    this.pendingWagons = new WatchedMap(() => this.persistJobs()); // "company:vehicle" -> { company, vehicle, depot, wagon, cargo, count } (train-add-wagons)
    this.jobLog = [];               // finished pending jobs, last 50
    this.vehicleHistory = new Map(); // vehicle-problems progress samples
    this.stallHistory = new Map();   // vehicle-problems standstill samples
    this.depotHistory = new Map();   // vehicle-problems: since when a vehicle stands in a depot
    this._watchTimers = new Map();   // company -> interval sampling vehicles for stall detection
    this._autoSave = null;           // { everyMonths, prefix, lastMonth, last, timer } (save --every_months)
  }

  async connect() {
    const { host, admin_port: port, admin_password: password } = this.cfg;
    if (!password) throw new Error('no relay and no admin_password configured. Player: openttd-agent configure --relay http://<host-LAN-IP>:47978 --token <token from the host>. Host: openttd-agent launch (generates and saves the admin password). Not sure which? run: openttd-agent guide');
    this.admin = new AdminClient({ host, port, password, name: `openttd-agent-${process.pid}` });
    await this.admin.connect().catch((e) => {
      throw new Error(`${e.message}. Is the server running (openttd-agent launch) and are host/admin_port right? run: openttd-agent guide`);
    });
    this.admin.subscribe(UPDATE.CHAT, FREQ.AUTOMATIC);
    this.gs = new GSRpc(this.admin);
    this.gs.diagnose = () => diagnoseGs(this.cfg);
    this.info = await this.gs.call('info', {}, 10000).catch((e) => {
      // Close at once: a daemon retrying every call must not pile up admin connections (the
      // server refuses new ones once its admin slots are full: "read ECONNRESET").
      this.close();
      const code = /^(gs_died|gs_timeout):/.exec(e.message)?.[1] ?? 'no_gamescript';
      throw new Error(`${code}: connected to admin port but the AgentBridge GameScript did not answer: ${e.message}. The game is running without AgentBridge (or it died). `
        + 'On the host: openttd-agent install-gamescript, then start the game again with openttd-agent launch (it writes [game_scripts] so AgentBridge is the only game script; '
        + 'an entry copied from your own openttd.cfg, e.g. "none =", used to win). A loaded save runs the GameScript stored in it: prepare it with scenario-prepare. Then run: openttd-agent guide');
    });
    const [cargos, types] = await Promise.all([this.gs.call('cargos'), this.gs.call('industry_types')]).catch((e) => { this.close(); throw e; });
    this.cargos = new Map(cargos.map((c) => [c.id, c]));
    this.types = new Map(types.map((t) => [t.id, t]));
    this.map = new TileMap(this.info.map_x, this.info.map_y);
    this.admin.on('newgame', () => { log.warn('session', 'host started or loaded a game; this session is stale'); });
    this.gameKey = gameKeyOf(this.admin.welcome);
    try { this.jobsRestored = this.restoreJobs(); } catch (e) { log.warn('session', 'could not restore background jobs', { file: jobsFile(this.cfg), error: e.message }); }
    log.info('session', 'ready', { map: [this.info.map_x, this.info.map_y], year: this.info.year, gs: this.info.bridge_version });
    return this;
  }

  close() {
    clearInterval(this._refreshTimer);
    clearInterval(this._salesTimer);
    for (const t of this._watchTimers.values()) clearInterval(t);
    this.stopAutoSave({ persist: false }); // the schedule stays in the jobs file for the next session
    this.admin?.close();
  }

  // ---- economy (cached briefly) ---------------------------------------------

  async economy({ fresh = false } = {}) {
    if (fresh || !this._economy.towns || Date.now() - this._economy.at > ECONOMY_TTL_MS) {
      const [townRows, indRows] = await Promise.all([this.gs.call('towns'), this.gs.call('industries')]);
      this._economy = {
        at: Date.now(),
        towns: townsFromRows(townRows),
        industries: industriesFromRows(indRows, this.types, this.cargos),
      };
    }
    return this._economy;
  }

  // ---- tile mirror -----------------------------------------------------------

  /** Resolves when every row has been loaded once. Starts background refresh after. */
  ensureTiles() {
    if (!this._tileLoad) this._tileLoad = this._loadAllTiles();
    return this._tileLoad;
  }

  async _loadAllTiles() {
    const started = Date.now();
    const rowsPerCall = Math.max(1, Math.floor(4096 / this.map.sizeX));
    for (let y = 0; y < this.map.sizeY; y += rowsPerCall) {
      const rows = await this.gs.call('dump_tiles', { y0: y, y1: Math.min(this.map.sizeY - 1, y + rowsPerCall - 1) }, 120000);
      for (const r of rows) this.map.applyRow(r);
    }
    const ms = Date.now() - started;
    log.info('session', 'tile mirror loaded', { tiles: this.map.sizeX * this.map.sizeY, ms });
    this.tileLoadMs = ms;
    this._startRefresh();
    return ms;
  }

  _startRefresh() {
    const perSec = this.cfg.tile_refresh_rows_per_sec;
    if (!perSec) return;
    let busy = false;
    this._refreshTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      const y0 = this._refreshRow;
      const y1 = Math.min(this.map.sizeY - 1, y0 + perSec - 1);
      try {
        for (const r of await this.gs.call('dump_tiles', { y0, y1 })) this.map.applyRow(r);
        this._refreshRow = y1 + 1 >= this.map.sizeY ? 0 : y1 + 1;
      } catch (e) { log.warn('session', 'tile refresh failed', { error: e.message }); }
      busy = false;
    }, 1000);
    this._refreshTimer.unref?.();
  }

  /** Re-dump a rectangle now (e.g. right before planning a build there). */
  async refreshArea(x0, y0, x1, y1) {
    const rows = await this.gs.call('dump_tiles', {
      y0: Math.max(0, y0), y1: Math.min(this.map.sizeY - 1, y1), x0: Math.max(0, x0), x1: Math.min(this.map.sizeX - 1, x1),
    });
    for (const r of rows) this.map.applyRow(r);
  }

  // ---- building ----------------------------------------------------------------

  companyOrThrow(company) {
    const c = company ?? this.cfg.company;
    if (c === null || c === undefined || Number.isNaN(c)) throw new Error('no company set. Run: openttd-agent companies, then openttd-agent configure --company <id> (or run: openttd-agent guide)');
    return c;
  }

  /**
   * Run state-changing steps through the GS `exec` command (see main.nut ExecStep).
   * Steps go in batches that fit one admin packet; a failed batch stops the rest.
   */
  async exec(company, steps, { dryRun = false, keepGoing, railType, roadType, timeoutMs } = {}) {
    const replies = [];
    for (let i = 0; i < steps.length;) {
      let n = 0, bytes = 0;
      while (i + n < steps.length && n < 150 && (bytes += JSON.stringify(steps[i + n]).length + 1) < 7000) n++;
      n = Math.max(1, n);
      const reply = await this.gs.call('exec', {
        company, steps: steps.slice(i, i + n), dry_run: dryRun,
        ...(keepGoing !== undefined ? { keep_going: keepGoing } : {}),
        ...(railType !== undefined ? { rail_type: railType } : {}), ...(roadType !== undefined ? { road_type: roadType } : {}),
      }, timeoutMs ?? 30000 + n * 1000);
      replies.push(reply);
      if (reply[0].stopped) break;
      i += n;
    }
    this._economy.at = 0; // world changed; refresh on next read
    // money_after (G20): executeCommand reads the bank balance of the last exec of a call.
    this.lastExec = { n: (this.lastExec?.n ?? 0) + 1, company, money: replies.at(-1)?.[0]?.money };
    return execSummary(steps, replies, dryRun);
  }

  // ---- vehicle-replace: sell old vehicles once they stop in a depot ------------------

  /**
   * Finish pending vehicle jobs whose vehicle is stopped in a depot: sell replaced vehicles
   * (pendingSales) and attach wagons, then restart (pendingWagons, train-add-wagons).
   * Returns { sold, waiting, gone, wagons_added }.
   */
  async finishSales() {
    const out = { sold: [], waiting: [], gone: [], wagons_added: [] };
    const all = [...this.pendingSales.values(), ...this.pendingWagons.values()];
    for (const company of new Set(all.map((p) => p.company))) {
      const rows = await this.gs.call('vehicles', { company });
      const state = new Map(rows.map((r) => [r[0], r[11]])); // id -> GS state (2 = in depot)
      const where = new Map(rows.map((r) => [r[0], { x: r[12], y: r[13] }]));
      for (const [k, p] of this.pendingSales) {
        if (p.company !== company) continue;
        if (!state.has(p.vehicle)) { this.pendingSales.delete(k); out.gone.push({ company, vehicle: p.vehicle }); continue; }
        if (state.get(p.vehicle) !== 2) { out.waiting.push({ company, vehicle: p.vehicle }); continue; }
        const res = await this.exec(company, [['veh_sell', p.vehicle]]);
        if (res.ok) { this.pendingSales.delete(k); out.sold.push({ company, vehicle: p.vehicle, income: -res.cost, replaced_by: p.replaced_by }); log.info('session', 'sold replaced vehicle', { company, vehicle: p.vehicle, income: -res.cost }); } else out.waiting.push({ company, vehicle: p.vehicle });
      }
      for (const [k, p] of this.pendingWagons) {
        if (p.company !== company) continue;
        if (!state.has(p.vehicle)) { this.pendingWagons.delete(k); out.gone.push({ company, vehicle: p.vehicle }); continue; }
        if (state.get(p.vehicle) !== 2) {
          if (!p.sent) { const r = await this.exec(company, [['veh_depot', p.vehicle, false]]); if (r.ok) { p.sent = true; this.persistJobs(); } }
          out.waiting.push({ company, vehicle: p.vehicle });
          continue;
        }
        const depot = p.depot ?? where.get(p.vehicle); // a vehicle in a depot is on the depot tile
        const res = await this.exec(company, [...Array.from({ length: p.count }, () => ['veh_buy', depot.x, depot.y, p.wagon, p.cargo, p.vehicle]), ['veh_start_stop', p.vehicle, 1]], { keepGoing: true });
        this.pendingWagons.delete(k); // only once the request answered: a timeout keeps the job for the next check
        const added = res.results.filter((r) => r.op === 'veh_buy' && r.ok).length;
        // A wagon the game sold but would not couple (the train was not stopped there after all): sell it back.
        const stray = res.results.filter((r) => r.op === 'veh_buy' && !r.ok && r.value && /could not attach/.test(r.error ?? '')).map((r) => r.value);
        const soldBack = stray.length ? await this.exec(company, stray.map((v) => ['veh_sell', v]), { keepGoing: true }) : null;
        const entry = { vehicle: p.vehicle, wagons_added: added, of: p.count, cost: res.cost + (soldBack?.cost ?? 0), restarted: res.results.at(-1)?.ok ?? false,
          ...(res.ok ? {} : { error: res.error }), ...(stray.length ? { sold_back: stray, sold_back_ok: soldBack.ok } : {}) };
        out.wagons_added.push({ company, ...entry });
        this.jobLog.push({ t: new Date().toISOString(), company, kind: 'add_wagons', ...entry });
        log.info('session', 'added wagons', { company, ...entry });
      }
    }
    if (this.jobLog.length > 50) this.jobLog.splice(0, this.jobLog.length - 50);
    return out;
  }

  /** Check pending vehicle jobs every 20 s while there are any (the daemon or relay keeps running). */
  watchSales() {
    if (this._salesTimer || !(this.pendingSales.size || this.pendingWagons.size)) return;
    let busy = false;
    this._salesTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await this.finishSales(); } catch (e) { log.warn('session', 'pending vehicle job check failed', { error: e.message }); }
      if (!this.pendingSales.size && !this.pendingWagons.size) { clearInterval(this._salesTimer); this._salesTimer = null; }
      busy = false;
    }, 20_000);
    this._salesTimer.unref?.();
  }

  /**
   * Sample a company's vehicles every 15 s (about 7 game days) for stall detection, so a stall is
   * seen without the agent calling twice. One `vehicles` call per sample; runs while the session lives.
   */
  watchVehicles(company) {
    if (this._watchTimers.has(company) || this.cfg.vehicle_watch === false) return;
    let busy = false;
    const t = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const info = await this.gs.call('info');
        if (!info.paused) {
          for (const r of await this.gs.call('vehicles', { company })) {
            recordStall(this.stallHistory, `${company}:${r[0]}`, { date: info.date, x: r[12], y: r[13], speed: r[23], state: VEHICLE_STATES[r[11]] });
          }
        }
      } catch (e) { log.warn('session', 'vehicle sample failed', { error: e.message }); }
      busy = false;
    }, 15_000);
    t.unref?.();
    this._watchTimers.set(company, t);
  }

  // ---- periodic saves (host: save --every_months) ----------------------------------------

  async _autoSaveNow(info) {
    const a = this._autoSave;
    const name = `${a.prefix}-${info.year}-${String(info.month).padStart(2, '0')}`;
    const out = await this.admin.rcon(`save ${name}`, 30000);
    if (out.some((l) => /failed|error/i.test(l))) throw new Error(`server could not save '${name}': ${out.join(' ')}`);
    a.lastMonth = info.year * 12 + info.month;
    a.last = { name: `${name}.sav`, at: new Date().toISOString() };
    log.info('session', 'periodic save', { name });
    return a.last;
  }

  /** Save now and then every `everyMonths` game months. Returns the first save. */
  async startAutoSave({ everyMonths, prefix }) {
    this.stopAutoSave({ persist: false });
    this._autoSave = { everyMonths, prefix, lastMonth: 0, last: null, errors: 0, timer: null };
    const first = await this._autoSaveNow(await this.gs.call('info'));
    this._armAutoSave();
    this.persistJobs();
    return first;
  }

  /** The 20 s check for the periodic save in this._autoSave (started, or restored from the jobs file). */
  _armAutoSave() {
    let busy = false;
    this._autoSave.timer = setInterval(async () => {
      const a = this._autoSave;
      if (busy || !a) return;
      busy = true;
      try {
        const info = await this.gs.call('info');
        if (info.year * 12 + info.month - a.lastMonth >= a.everyMonths) { await this._autoSaveNow(info); this.persistJobs(); }
      } catch (e) { a.errors++; log.warn('session', 'periodic save failed', { error: e.message }); }
      busy = false;
    }, 20_000);
    this._autoSave.timer.unref?.();
  }

  stopAutoSave({ persist = true } = {}) {
    if (this._autoSave?.timer) clearInterval(this._autoSave.timer);
    const had = this._autoSave !== null;
    this._autoSave = null;
    if (persist && had) this.persistJobs();
  }

  autoSaveStatus() {
    const a = this._autoSave;
    return a ? { every_months: a.everyMonths, prefix: a.prefix, last: a.last, errors: a.errors } : null;
  }

  // ---- persisted background jobs (D2) ------------------------------------------------------

  /** Write this game's jobs to the jobs file (an empty entry is removed). No-op before connect and while restoring. */
  persistJobs() {
    if (!this.gameKey || this._restoring) return;
    const file = jobsFile(this.cfg);
    const data = readJobs(file);
    const a = this._autoSave;
    const entry = { updated: new Date().toISOString(), map: this.info ? [this.info.map_x, this.info.map_y] : null,
      pending_sales: [...this.pendingSales.values()], pending_wagons: [...this.pendingWagons.values()],
      auto_save: a ? { every_months: a.everyMonths, prefix: a.prefix, last_month: a.lastMonth, last: a.last } : null };
    const empty = !entry.pending_sales.length && !entry.pending_wagons.length && !entry.auto_save;
    if (empty && !(this.gameKey in data.games)) return;
    if (empty) delete data.games[this.gameKey]; else data.games[this.gameKey] = entry;
    const keys = Object.keys(data.games).sort((p, q) => String(data.games[q].updated).localeCompare(String(data.games[p].updated)));
    for (const k of keys.slice(JOB_GAMES_KEPT)) delete data.games[k];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { log.warn('session', 'could not save background jobs', { file, error: e.message }); }
  }

  /** Load this game's jobs from the jobs file and restart their timers. Returns what was restored, or null. */
  restoreJobs() {
    const entry = this.gameKey ? readJobs(jobsFile(this.cfg)).games[this.gameKey] : null;
    if (!entry) return null;
    this._restoring = true;
    try {
      for (const p of entry.pending_sales ?? []) this.pendingSales.set(`${p.company}:${p.vehicle}`, p);
      for (const p of entry.pending_wagons ?? []) this.pendingWagons.set(`${p.company}:${p.vehicle}`, p);
      const a = entry.auto_save;
      if (a && a.every_months > 0 && a.prefix) {
        this._autoSave = { everyMonths: a.every_months, prefix: a.prefix, lastMonth: a.last_month ?? 0, last: a.last ?? null, errors: 0, timer: null };
        this._armAutoSave();
      }
    } finally { this._restoring = false; }
    this.watchSales();
    const out = { pending_sales: this.pendingSales.size, pending_wagons: this.pendingWagons.size, periodic_save: this._autoSave !== null, saved_at: entry.updated };
    log.info('session', 'restored background jobs', { game: this.gameKey, ...out });
    return out;
  }

  /** status.background_jobs: queued vehicle jobs (own company only when one is set), the periodic save, where they are kept. */
  backgroundJobs() {
    const mineOnly = (m) => {
      const all = [...m.values()];
      const c = this.cfg.company;
      return c === null || c === undefined ? all : all.filter((p) => p.company === c);
    };
    const sales = mineOnly(this.pendingSales), wagons = mineOnly(this.pendingWagons);
    return {
      pending_sales: sales.map((p) => ({ company: p.company, vehicle: p.vehicle, replaced_by: p.replaced_by ?? null, since: p.since ?? null })),
      pending_wagons: wagons.map((p) => ({ company: p.company, vehicle: p.vehicle, count: p.count, sent: p.sent ?? false })),
      other_companies_jobs: this.pendingSales.size + this.pendingWagons.size - sales.length - wagons.length,
      periodic_save: this.autoSaveStatus(),
      vehicle_watch_companies: [...this._watchTimers.keys()],
      persisted_to: jobsFile(this.cfg), game_key: this.gameKey, restored_on_connect: this.jobsRestored,
    };
  }

  /** Client-side throttle (max_builds_per_minute, 0 = off). Throws when over the limit. */
  throttleBuild() {
    const cap = this.cfg.max_builds_per_minute;
    if (!cap) return;
    const now = Date.now();
    this._buildTimes = this._buildTimes.filter((t) => now - t < 60_000);
    if (this._buildTimes.length >= cap) {
      const waitS = Math.ceil((60_000 - (now - this._buildTimes[0])) / 1000);
      throw new Error(`client rate limit: ${cap} builds/minute reached; retry in ${waitS}s (configure max_builds_per_minute to change)`);
    }
    this._buildTimes.push(now);
  }
}

/**
 * A per-player face of one shared Session (used by the relay): its own cfg
 * (company, max_builds_per_minute) and build throttle; the admin connection,
 * map mirror and caches stay on `base`. Methods that write session state are
 * pinned to `base` so two players never load the mirror twice.
 * `throttle` is { times: [] }, kept by the caller so it outlives the view.
 */
export function playerView(base, cfg, throttle) {
  const view = Object.create(base);
  view.cfg = cfg;
  Object.defineProperty(view, '_buildTimes', { get: () => throttle.times, set: (v) => { throttle.times = v; } });
  view.ensureTiles = () => base.ensureTiles();
  view.refreshArea = (...a) => base.refreshArea(...a);
  view.economy = (o) => base.economy(o);
  view.exec = (...a) => base.exec(...a);
  view.finishSales = () => base.finishSales();
  view.watchSales = () => base.watchSales();
  view.watchVehicles = (c) => base.watchVehicles(c);
  return view;
}
