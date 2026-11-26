// A live connection to one game: admin client + GS RPC + world mirror.
// Used in-process by the daemon and by the MCP server.

import { AdminClient, UPDATE, FREQ } from './admin-client.js';
import { GSRpc } from './gs-rpc.js';
import { TileMap, townsFromRows, industriesFromRows } from './world.js';
import { execSummary, VEHICLE_STATES } from './operate.js';
import { recordStall } from './problems.js';
import { log } from './log.js';

const ECONOMY_TTL_MS = 60_000; // towns/industries refresh at most once a minute (~1 game month)

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
    this.pendingSales = new Map(); // "company:vehicle" -> { company, vehicle, replaced_by, since } (vehicle-replace)
    this._salesTimer = null;
    this.pendingWagons = new Map(); // "company:vehicle" -> { company, vehicle, depot, wagon, cargo, count } (train-add-wagons)
    this.jobLog = [];               // finished pending jobs, last 50
    this.vehicleHistory = new Map(); // vehicle-problems progress samples
    this.stallHistory = new Map();   // vehicle-problems standstill samples
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
    this.info = await this.gs.call('info', {}, 10000).catch((e) => {
      // Close at once: a daemon retrying every call must not pile up admin connections (the
      // server refuses new ones once its admin slots are full: "read ECONNRESET").
      this.close();
      throw new Error(`connected to admin port but the AgentBridge GameScript did not answer: ${e.message}. The game is running without AgentBridge. `
        + 'On the host: openttd-agent install-gamescript, then start the game again with openttd-agent launch (it writes [game_scripts] so AgentBridge is the only game script; '
        + 'an entry copied from your own openttd.cfg, e.g. "none =", used to win). A loaded save runs the GameScript stored in it: prepare it with scenario-prepare. Then run: openttd-agent guide');
    });
    const [cargos, types] = await Promise.all([this.gs.call('cargos'), this.gs.call('industry_types')]).catch((e) => { this.close(); throw e; });
    this.cargos = new Map(cargos.map((c) => [c.id, c]));
    this.types = new Map(types.map((t) => [t.id, t]));
    this.map = new TileMap(this.info.map_x, this.info.map_y);
    this.admin.on('newgame', () => { log.warn('session', 'host started or loaded a game; this session is stale'); });
    log.info('session', 'ready', { map: [this.info.map_x, this.info.map_y], year: this.info.year, gs: this.info.bridge_version });
    return this;
  }

  close() {
    clearInterval(this._refreshTimer);
    clearInterval(this._salesTimer);
    for (const t of this._watchTimers.values()) clearInterval(t);
    this.stopAutoSave();
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
        if (!state.has(p.vehicle)) { this.pendingSales.delete(k); out.gone.push(p.vehicle); continue; }
        if (state.get(p.vehicle) !== 2) { out.waiting.push(p.vehicle); continue; }
        const res = await this.exec(company, [['veh_sell', p.vehicle]]);
        if (res.ok) { this.pendingSales.delete(k); out.sold.push({ vehicle: p.vehicle, income: -res.cost, replaced_by: p.replaced_by }); log.info('session', 'sold replaced vehicle', { company, vehicle: p.vehicle, income: -res.cost }); } else out.waiting.push(p.vehicle);
      }
      for (const [k, p] of this.pendingWagons) {
        if (p.company !== company) continue;
        if (!state.has(p.vehicle)) { this.pendingWagons.delete(k); out.gone.push(p.vehicle); continue; }
        if (state.get(p.vehicle) !== 2) {
          if (!p.sent) { const r = await this.exec(company, [['veh_depot', p.vehicle, false]]); if (r.ok) p.sent = true; }
          out.waiting.push(p.vehicle);
          continue;
        }
        this.pendingWagons.delete(k);
        const depot = p.depot ?? where.get(p.vehicle); // a vehicle in a depot is on the depot tile
        const res = await this.exec(company, [...Array.from({ length: p.count }, () => ['veh_buy', depot.x, depot.y, p.wagon, p.cargo, p.vehicle]), ['veh_start_stop', p.vehicle, 1]], { keepGoing: true });
        const added = res.results.filter((r) => r.op === 'veh_buy' && r.ok).length;
        const entry = { vehicle: p.vehicle, wagons_added: added, of: p.count, cost: res.cost, restarted: res.results.at(-1)?.ok ?? false, ...(res.ok ? {} : { error: res.error }) };
        out.wagons_added.push(entry);
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
    this.stopAutoSave();
    this._autoSave = { everyMonths, prefix, lastMonth: 0, last: null, errors: 0, timer: null };
    const first = await this._autoSaveNow(await this.gs.call('info'));
    let busy = false;
    this._autoSave.timer = setInterval(async () => {
      const a = this._autoSave;
      if (busy || !a) return;
      busy = true;
      try {
        const info = await this.gs.call('info');
        if (info.year * 12 + info.month - a.lastMonth >= a.everyMonths) await this._autoSaveNow(info);
      } catch (e) { a.errors++; log.warn('session', 'periodic save failed', { error: e.message }); }
      busy = false;
    }, 20_000);
    this._autoSave.timer.unref?.();
    return first;
  }

  stopAutoSave() {
    if (this._autoSave?.timer) clearInterval(this._autoSave.timer);
    this._autoSave = null;
  }

  autoSaveStatus() {
    const a = this._autoSave;
    return a ? { every_months: a.everyMonths, prefix: a.prefix, last: a.last, errors: a.errors } : null;
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
