// A live connection to one game: admin client + GS RPC + world mirror.
// Used in-process by the daemon and by the MCP server.

import { AdminClient, UPDATE, FREQ } from './admin-client.js';
import { GSRpc } from './gs-rpc.js';
import { TileMap, townsFromRows, industriesFromRows } from './world.js';
import { execSummary } from './operate.js';
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
  }

  async connect() {
    const { host, admin_port: port, admin_password: password } = this.cfg;
    if (!password) throw new Error('admin_password is not set. Run: openttd-agent configure --admin_password <password> (same as on the host)');
    this.admin = new AdminClient({ host, port, password, name: `openttd-agent-${process.pid}` });
    await this.admin.connect();
    this.admin.subscribe(UPDATE.CHAT, FREQ.AUTOMATIC);
    this.gs = new GSRpc(this.admin);
    this.info = await this.gs.call('info', {}, 10000).catch((e) => {
      throw new Error(`connected to admin port but the AgentBridge GameScript did not answer: ${e.message}. On the host, run: openttd-agent install-gamescript, then start the game with AgentBridge selected (openttd-agent launch does this).`);
    });
    const [cargos, types] = await Promise.all([this.gs.call('cargos'), this.gs.call('industry_types')]);
    this.cargos = new Map(cargos.map((c) => [c.id, c]));
    this.types = new Map(types.map((t) => [t.id, t]));
    this.map = new TileMap(this.info.map_x, this.info.map_y);
    this.admin.on('newgame', () => { log.warn('session', 'host started a new game; reconnect needed'); });
    log.info('session', 'ready', { map: [this.info.map_x, this.info.map_y], year: this.info.year, gs: this.info.bridge_version });
    return this;
  }

  close() {
    clearInterval(this._refreshTimer);
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
    if (c === null || c === undefined || Number.isNaN(c)) throw new Error('no company set. Run: openttd-agent companies, then openttd-agent configure --company <id>');
    return c;
  }

  /**
   * Run state-changing steps through the GS `exec` command (see main.nut ExecStep).
   * Steps go in batches that fit one admin packet; a failed batch stops the rest.
   */
  async exec(company, steps, { dryRun = false, keepGoing, railType, roadType } = {}) {
    const replies = [];
    for (let i = 0; i < steps.length;) {
      let n = 0, bytes = 0;
      while (i + n < steps.length && n < 150 && (bytes += JSON.stringify(steps[i + n]).length + 1) < 7000) n++;
      n = Math.max(1, n);
      const reply = await this.gs.call('exec', {
        company, steps: steps.slice(i, i + n), dry_run: dryRun,
        ...(keepGoing !== undefined ? { keep_going: keepGoing } : {}),
        ...(railType !== undefined ? { rail_type: railType } : {}), ...(roadType !== undefined ? { road_type: roadType } : {}),
      }, 30000 + n * 1000);
      replies.push(reply);
      if (reply[0].stopped) break;
      i += n;
    }
    this._economy.at = 0; // world changed; refresh on next read
    return execSummary(steps, replies, dryRun);
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
  return view;
}
