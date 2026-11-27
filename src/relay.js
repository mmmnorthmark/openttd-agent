// Host relay: the only admin-port client. Players' openttd-agent instances send
// commands here over HTTP with a per-player token; the relay decides which
// company each request acts as. The admin password never leaves the host.
//
// API: GET /health -> { ok, service, version }
//      POST /call  { name, args }   header  Authorization: Bearer <token>
//        -> { ok: true, result } | { ok: false, error }   (401 bad token, 403 refused)
//
// Why here and not in the GameScript: the GS cannot tell which admin connection
// sent a request, so anyone holding the admin password can act as any company.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeContext } from './context.js';
import { COMMANDS_BY_NAME, executeCommand } from './commands.js';
import { CONFIG_DIR, loadConfig } from './config.js';
import { loadPlayers, playerForToken } from './relay-players.js';
import { playerView } from './session.js';
import { makeStatsRecorder } from './relay-stats.js';
import { log } from './log.js';
import { VERSION } from './version.js';

export const RELAY_SERVICE = 'openttd-agent-relay';
export const AUDIT_FILE = path.join(CONFIG_DIR, 'relay-audit.jsonl');
const PLAYER_GROUPS = new Set(['game', 'world', 'build', 'operate']); // anything else (setup, relay, future groups) is host-only
const UNAUDITED_GROUPS = new Set(['world']);                         // read-only map/economy queries, called constantly
const MAX_BODY_BYTES = 1_000_000;
// Read-only commands a player may run for another company: what the game window shows anyone
// (a rival's station list with waiting cargo and ratings; its vehicle counts per type in the
// company window). The commands themselves trim a rival's view (stations: no vehicle counts;
// vehicles: counts only). Everything else stays bound to the player's own company.
export const RIVAL_READS = new Set(['stations', 'vehicles']);

export class Refused extends Error {}

/**
 * Policy for one player request. Returns the args to run with (company forced
 * to the player's), or throws Refused. Pure: no I/O.
 */
export function authorize(player, name, rawArgs = {}) {
  const cmd = COMMANDS_BY_NAME.get(name);
  if (!cmd) throw new Refused(`unknown command '${name}' (relay runs openttd-agent ${VERSION}; update to the same version as the host)`);
  if (!cmd.session || !PLAYER_GROUPS.has(cmd.group)) {
    throw new Refused(`'${name}' is host-only and cannot be run through the relay${cmd.session ? '' : ' (setup commands run on your own machine, without the relay)'}`);
  }
  const args = { ...rawArgs };
  if (name === 'rate' && Object.keys(args).length > 0) throw new Refused('changing the rate limit is host-only; `rate` without arguments shows it');
  if ('company' in cmd.args.shape) {
    if (player.company === null || player.company === undefined) {
      throw new Refused(`player '${player.name}' is not bound to a company yet. Ask the host to run: openttd-agent relay-set-company --name ${player.name} --company <id>. run: openttd-agent guide`);
    }
    const asked = args.company;
    const other = asked !== undefined && asked !== null && asked !== '' && Number(asked) !== player.company;
    if (other && !RIVAL_READS.has(name)) {
      throw new Refused(`player '${player.name}' is bound to company ${player.company} and cannot act as company ${asked}${RIVAL_READS.size ? ` (other companies can only be read with: ${[...RIVAL_READS].join(', ')}; companies lists all)` : ''}`);
    }
    if (other && !/^\d+$/.test(String(asked))) throw new Refused(`company must be a company id, got '${asked}'`);
    args.company = other ? Number(asked) : player.company;
  }
  if (name === 'chat' && typeof args.message === 'string') args.message = `[${player.name}] ${args.message}`;
  return args;
}

const SECRET_ARGS = ['admin_password', 'token', 'relay_token'];

export function audit(entry) {
  try {
    if (entry.args && SECRET_ARGS.some((k) => k in entry.args)) {
      entry = { ...entry, args: Object.fromEntries(Object.entries(entry.args).map(([k, v]) => [k, SECRET_ARGS.includes(k) ? '***' : v])) };
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch (e) { log.warn('relay', 'audit write failed', { error: e.message }); }
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error('request body too large');
  }
  return body;
}

const bearer = (req) => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;

/** Start the relay. Resolves once listening: { server, port, close() }. */
export function startRelay({ port = loadConfig().relay_port, bind = '0.0.0.0' } = {}) {
  const ctx = makeContext();          // the host's own config: admin port on this machine + admin password
  const throttles = new Map();        // player name -> { times: [build timestamps] } (survives reconnects and re-binds)
  const stats = makeStatsRecorder();  // liveness per player for the host's relay-stats (never served here)

  /** Context for one request: the shared session seen as this player. */
  const playerContext = (player) => {
    const cfg = { ...ctx.cfg, relay: '', relay_token: '', company: player.company ?? null,
      max_builds_per_minute: player.max_builds_per_minute ?? ctx.cfg.max_builds_per_minute };
    if (!throttles.has(player.name)) throttles.set(player.name, { times: [] });
    return { cfg, session: async () => playerView(await ctx.session(), cfg, throttles.get(player.name)) };
  };

  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true, service: RELAY_SERVICE, version: VERSION });
    if (req.method !== 'POST' || req.url !== '/call') return reply(404, { ok: false, error: 'not found' });
    const remote = req.socket.remoteAddress;
    const started = Date.now();
    let player = null, name, args;
    try {
      player = playerForToken(bearer(req), loadPlayers()); // re-read each time: host changes apply at once
      if (!player) {
        audit({ outcome: 'auth_failed', remote });
        stats.record({ player: null, outcome: 'auth_failed' });
        return reply(401, { ok: false, error: 'relay: missing or unknown token. Ask the host for one (openttd-agent relay-add-player), then: openttd-agent configure --relay <url> --token <token>. run: openttd-agent guide' });
      }
      const parsed = JSON.parse((await readBody(req)) || '{}');
      name = parsed.name;
      args = parsed.args ?? {};
      args = authorize(player, name, args);
      ctx.refreshConfig();
      // Unshaped: the player's own runCommand applies --fields/--brief/--steps once.
      const result = await executeCommand(playerContext(player), name, args);
      const ms = Date.now() - started;
      log.info('relay', 'call', { player: player.name, name, ms });
      stats.record({ player: player.name, outcome: 'ok', name });
      if (!UNAUDITED_GROUPS.has(COMMANDS_BY_NAME.get(name).group)) audit({ outcome: 'ok', player: player.name, company: player.company, remote, name, args, ms });
      reply(200, { ok: true, result });
    } catch (e) {
      const refused = e instanceof Refused;
      log.warn('relay', refused ? 'refused' : 'call failed', { player: player?.name, name, error: e.message });
      stats.record({ player: player?.name ?? null, outcome: refused ? 'refused' : 'error', name });
      audit({ outcome: refused ? 'refused' : 'error', player: player?.name, company: player?.company, remote, name, args, error: e.message, ms: Date.now() - started });
      reply(refused ? 403 : 200, { ok: false, error: refused ? `relay refused: ${e.message}` : e.message });
    }
  });

  server.requestTimeout = 0; // long calls (turn-advance) must not be cut after node's default 5 minutes
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => {
      const actual = server.address().port;
      log.info('relay', 'listening', { bind, port: actual, pid: process.pid, players: loadPlayers().length, audit: AUDIT_FILE });
      resolve({ server, port: actual, close: () => { stats.flush(); ctx.close(); server.close(); server.closeAllConnections?.(); } });
    });
  });
}
