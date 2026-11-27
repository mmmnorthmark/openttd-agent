// Host-only server control (0.8.0): which server a host command talks to, its process and
// log, readiness, and the console commands behind load / saves / server-stop / console /
// company-new / install-gamescript --reload. Every function here talks to a server on THIS
// machine: it reads the launch profile (~/.openttd-agent/profiles/<server>/) and opens its own
// short-lived AdminClient (a load makes every session stale, so these never use the daemon's).
//
// Process lookup and kill go only by the profile's exact openttd.cfg path on the command line
// (`-c <profile>/openttd.cfg`), so no other OpenTTD on the machine is ever touched.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { AdminClient } from './admin-client.js';
import { GSRpc } from './gs-rpc.js';
import { CONFIG_DIR } from './config.js';
import { profileDir, adminHostForBind, iniValue, SERVER_STATE_FILE, bundledGsVersion, installGamescript, checkSaveName } from './setup.js';
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG_TAIL_LINES = 20;

// ---- which server -------------------------------------------------------------------

/** server.json of a launch profile, or null. */
export function readServerState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, SERVER_STATE_FILE), 'utf8')); } catch { return null; }
}

/** Ports of a launch profile: server.json, else its openttd.cfg [network] (profiles from before 0.8.0). */
export function profilePorts(dir) {
  const st = readServerState(dir);
  if (st) return { game_port: st.game_port, admin_port: st.admin_port, bind: st.bind ?? null, host: st.host ?? null };
  try {
    const text = fs.readFileSync(path.join(dir, 'openttd.cfg'), 'utf8');
    const num = (k) => { const v = Number(iniValue(text, 'network', k)); return Number.isFinite(v) && v > 0 ? v : null; };
    return { game_port: num('server_port'), admin_port: num('server_admin_port'), bind: null, host: null };
  } catch { return { game_port: null, admin_port: null, bind: null, host: null }; }
}

/** Launch profiles on this machine (folders with an openttd.cfg), 'join' excluded. */
export function listServerProfiles() {
  const root = path.join(CONFIG_DIR, 'profiles');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => n !== 'join' && fs.existsSync(path.join(root, n, 'openttd.cfg')));
}

function secretsPassword(dir) {
  try { return iniValue(fs.readFileSync(path.join(dir, 'secrets.cfg'), 'utf8'), 'network', 'admin_password') || null; } catch { return null; }
}

/**
 * The server a host command acts on. `server` names a launch profile (launch --server); without
 * it, the configured admin port (config host/admin_port), matched to the profile that uses that
 * port (default 'dedicated'). Returns { server, dir, cfgPath, host, admin_port, game_port, password, local }.
 */
export function serverTarget(cfg, server) {
  if (server !== undefined && server !== null && server !== '') {
    const dir = profileDir(server);
    if (!fs.existsSync(path.join(dir, 'openttd.cfg'))) {
      throw new Error(`unknown_server: no launch profile '${server}' (${dir}). Known: ${listServerProfiles().join(', ') || 'none'}. Start one with: openttd-agent launch --server ${server}`);
    }
    const p = profilePorts(dir);
    return { server, dir, cfgPath: path.join(dir, 'openttd.cfg'), host: p.host ?? adminHostForBind(p.bind), admin_port: p.admin_port ?? 3977,
      game_port: p.game_port, password: secretsPassword(dir) ?? cfg.admin_password, local: true };
  }
  const names = listServerProfiles();
  const byPort = names.filter((n) => profilePorts(profileDir(n)).admin_port === cfg.admin_port);
  const name = byPort.includes('dedicated') ? 'dedicated' : byPort[0] ?? (names.includes('dedicated') ? 'dedicated' : names[0] ?? 'dedicated');
  const dir = profileDir(name);
  const p = profilePorts(dir);
  return { server: name, dir, cfgPath: path.join(dir, 'openttd.cfg'), host: cfg.host, admin_port: cfg.admin_port, game_port: p.game_port,
    password: cfg.admin_password || secretsPassword(dir), local: byPort.includes(name) };
}

// ---- process --------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** PIDs of OpenTTD processes started with exactly this cfg path (`-c <cfgPath>`). [] if none; null if unknown (no pgrep). */
export function serverPids(cfgPath) {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('pgrep', ['-f', `openttd.* -c ${escapeRe(cfgPath)}( |$)`], { encoding: 'utf8' });
    return out.split('\n').map((l) => Number(l.trim())).filter((n) => n > 0 && n !== process.pid);
  } catch (e) {
    if (e.status === 1) return []; // pgrep: nothing matched
    return null;
  }
}

/** Send SIGTERM (then SIGKILL) to the processes of this cfg path only. Returns the pids signalled. */
export async function killServer(cfgPath, { graceMs = 8000 } = {}) {
  const pids = serverPids(cfgPath) ?? [];
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  const deadline = Date.now() + graceMs;
  while ((serverPids(cfgPath) ?? []).length && Date.now() < deadline) await sleep(200);
  const left = serverPids(cfgPath) ?? [];
  for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  return { signalled: pids, killed_hard: left };
}

/** Does anything accept TCP on host:port? Never right before an admin login (see waitReady). */
export function portOpen(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// ---- log --------------------------------------------------------------------------------

const ERROR_LINE = /\[E\]|\[S\]|died unexpectedly|made an error|error|Error|ERROR|fatal|Fatal|\[squirrel\]/;
const GS_STARTED = /AgentBridge v\d+ started/;
const GS_DIED = /The script died unexpectedly|Your script made an error|script died/i;

/** Last lines of a profile's openttd.log. errors: only error-looking lines. grep: only lines containing it. */
export function logTail(dir, { lines = LOG_TAIL_LINES, errors = false, grep } = {}) {
  const file = path.join(dir, 'openttd.log');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { file, exists: false, lines: [] }; }
  let all = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const total = all.length;
  if (errors) all = all.filter((l) => ERROR_LINE.test(l) && !/\[admin\]/.test(l));
  if (grep) all = all.filter((l) => l.includes(grep));
  return { file, exists: true, total_lines: total, lines: lines ? all.slice(-lines) : [], gs: gsLogState(text) };
}

/** From the log text: did AgentBridge start, and did a script die after its last start? */
export function gsLogState(text) {
  const lines = String(text).split(/\r?\n/);
  let started = -1, died = -1;
  lines.forEach((l, i) => { if (GS_STARTED.test(l)) started = i; if (GS_DIED.test(l)) died = i; });
  const version = started >= 0 ? Number(/AgentBridge v(\d+)/.exec(lines[started])[1]) : null;
  if (died > started) return { state: 'died', started_version: version, line: lines[died].trim(), context: lines.slice(Math.max(0, died - 4), died + 1).map((l) => l.trim()).filter(Boolean) };
  return { state: started >= 0 ? 'started' : 'not_started', started_version: version };
}

/**
 * Why did the GS not answer? Reads the local launch profile of the server at cfg host/admin_port.
 * Returns { code: 'gs_died' | 'gs_timeout', detail } or null when there is no local log.
 */
export function diagnoseGs(cfg) {
  if (!/^(127\.|localhost$|::1$)/.test(String(cfg.host ?? '127.0.0.1'))) {
    const names = listServerProfiles().filter((n) => profilePorts(profileDir(n)).host === cfg.host);
    if (!names.length) return null;
  }
  const t = serverTarget(cfg);
  return t.local ? diagnoseTarget(t) : null;
}

/** diagnoseGs for a known server target (its profile's log). */
export function diagnoseTarget(t) {
  const tail = logTail(t.dir, { lines: 4, errors: true });
  if (!tail.exists) return null;
  if (tail.gs.state === 'died') return { code: 'gs_died', detail: `the GameScript died (server log ${tail.file}: ${tail.gs.context.join(' | ').slice(-600)}). Load the game again (openttd-agent load --name <save>) or launch again; server-log --errors true shows more` };
  return { code: 'gs_timeout', detail: `server log ${tail.file}, last error lines: ${tail.lines.join(' | ').slice(-500) || 'none'}; AgentBridge ${tail.gs.state}` };
}

// ---- admin helpers ---------------------------------------------------------------------

/** Run fn(admin, gs) with a fresh admin connection to the target server; always closes it. */
export async function withAdmin(target, fn, { name = 'openttd-agent-host' } = {}) {
  if (!target.password) throw new Error('admin_auth: no admin password for this server (launch saves one in the config and in the profile secrets.cfg)');
  const admin = new AdminClient({ host: target.host, port: target.admin_port, password: target.password, name: `${name}-${process.pid}` });
  try {
    await admin.connect(10000);
  } catch (e) {
    if (/^admin_auth:/.test(e.message)) throw e;
    throw new Error(`server_not_running: no admin port at ${target.host}:${target.admin_port} (server '${target.server}': ${e.message}). Start it with: openttd-agent launch${target.server !== 'dedicated' ? ` --server ${target.server}` : ''}`);
  }
  const gs = new GSRpc(admin);
  if (target.local) gs.diagnose = () => diagnoseTarget(target);
  try { return await fn(admin, gs); } finally { admin.close(); }
}

/** Poll GS info until it answers (and, when given, reports minVersion). Returns info or null. */
async function waitGs(gs, timeoutMs, minVersion) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await gs.call('info', {}, 3000).catch(() => null);
    if (info && (minVersion === undefined || (info.bridge_version ?? 0) >= minVersion)) return info;
    if (Date.now() > deadline) return info ?? null;
    await sleep(300);
  }
}

/**
 * Wait until a launched server is ready: admin port answers and AgentBridge replies to `info`.
 * `exited()` -> exit code or undefined. Returns { ready, seconds, bridge_version?, stage, ... }.
 */
export async function waitReady(target, { timeoutMs = 60000, exited = () => undefined } = {}) {
  const started = Date.now();
  let stage = 'process', lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (exited() !== undefined) { stage = 'process_exited'; break; }
    // No bare TCP probe first: OpenTTD 15.3 drops an admin login that follows a connection closed without
    // logging in (seen live), so every try is a real login.
    try {
      const info = await withAdmin(target, async (_admin, gs) => waitGs(gs, Math.max(1000, timeoutMs - (Date.now() - started))));
      if (info) return { ready: true, seconds: Math.round((Date.now() - started) / 100) / 10, bridge_version: info.bridge_version ?? null, paused: info.paused, map: [info.map_x, info.map_y], year: info.year };
      stage = 'gamescript';
    } catch (e) {
      // A fresh server also drops admin logins for its first frames, so a bare close is retried;
      // a real refusal (wrong password) is final.
      lastError = e.message;
      stage = /^admin_auth:/.test(e.message) ? 'admin_auth' : /^server_not_running:/.test(e.message) ? 'admin_port' : stage;
      if (/login refused/.test(e.message)) break;
    }
    await sleep(500);
  }
  return { ready: false, seconds: Math.round((Date.now() - started) / 100) / 10, stage, ...(lastError ? { last_error: lastError } : {}) };
}

/** Process state + log tail for a server that is not ready (H3). */
export function notReadyDetail(target, { pid, exitCode } = {}) {
  const pids = serverPids(target.cfgPath);
  return {
    process: { pid: pid ?? pids?.[0] ?? null, running: pids === null ? null : pids.length > 0, pids, exit_code: exitCode ?? null },
    log_tail: logTail(target.dir, { lines: LOG_TAIL_LINES }).lines,
  };
}

/** Wait until a save file written after `since` exists and its size stops changing (saving runs in a server thread). */
async function waitSaveFile(file, since, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  for (;;) {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs >= since && st.size > 0 && st.size === last) return st.size;
      last = st.size;
    } catch { /* not there yet */ }
    if (Date.now() > deadline) throw new Error(`save_timeout: ${file} was not complete within ${Math.round(timeoutMs / 1000)}s`);
    await sleep(400);
  }
}

/** Console save and wait for the file (when the save folder is on this machine). */
export async function saveAndWait(admin, target, name) {
  const n = checkSaveName(name);
  const since = Date.now() - 2000;
  const out = await admin.rcon(`save ${n}`, 30000);
  if (out.some((l) => /failed|error/i.test(l))) throw new Error(`save_failed: server could not save '${n}': ${out.join(' ')}`);
  const file = path.join(target.dir, 'save', `${n}.sav`);
  const bytes = target.local ? await waitSaveFile(file, since) : null;
  return { saved: `${n}.sav`, ...(target.local ? { path: file, bytes } : {}), console: out };
}

/** Console `ls` ("0) .. (Parent directory)", "1) autosave/ (Directory)", "2) game.sav") -> [{ index, name }], savegames only. */
export function parseLs(lines) {
  return lines.map((l) => /^\s*(\d+)\)\s+(.*?)\s*$/.exec(l)).filter(Boolean)
    .filter((m) => !/\((Parent directory|Directory)\)$/.test(m[2]))
    .map((m) => ({ index: Number(m[1]), name: m[2].replace(/\.sav$/i, '') }));
}

/** Resolves on the next welcome (a load finished). Arm before sending the load. */
function nextWelcome(admin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { admin.off('welcome', done); reject(new Error(`load_timeout: no new game within ${Math.round(timeoutMs / 1000)}s; see server-log`)); }, timeoutMs);
    const done = (w) => { clearTimeout(timer); resolve(w); };
    admin.once('welcome', done);
  });
}

async function setPausedConsole(admin, gs, want) {
  let info = await gs.call('info', {}, 5000);
  if (info.paused === want) return info;
  await admin.rcon(want ? 'pause' : 'unpause');
  const deadline = Date.now() + 10000;
  while (info.paused !== want && Date.now() < deadline) { await sleep(150); info = await gs.call('info', {}, 5000); }
  return info;
}

/**
 * Load a save by name on the running server (H1): `ls` to refresh the list, load by index,
 * wait for the new game and for AgentBridge. pause: true/false sets the pause state after; undefined keeps the save's.
 */
export async function loadSave(admin, gs, name, { pause, timeoutMs = 60000, minVersion } = {}) {
  const started = Date.now();
  const want = String(name).replace(/\.sav$/i, '');
  const list = parseLs(await admin.rcon('ls', 15000));
  const entry = list.find((e) => e.name === want) ?? list.find((e) => e.name.toLowerCase() === want.toLowerCase());
  if (!entry) {
    const near = list.filter((e) => e.name.toLowerCase().includes(want.toLowerCase().slice(0, 4))).slice(0, 10).map((e) => e.name);
    throw new Error(`save_not_found: no save '${want}' in the server's save folder (${list.length} saves${near.length ? `; similar: ${near.join(', ')}` : ''}). List them with: openttd-agent saves`);
  }
  const loaded = nextWelcome(admin, timeoutMs);
  loaded.catch(() => {});
  const out = await admin.rcon(`load ${entry.index}`, 30000);
  if (out.some((l) => /cannot be found|is not a|failed/i.test(l))) throw new Error(`load_failed: server refused 'load ${entry.index}' (${entry.name}): ${out.join(' ')}`);
  const welcome = await loaded;
  const info = await waitGs(gs, 30000, minVersion);
  if (!info) throw new Error(`gs_timeout: loaded ${entry.name} but AgentBridge did not answer within 30 s (the save may run another GameScript or none; see server-log --errors true)`);
  const now = pause === undefined ? info : await setPausedConsole(admin, gs, pause);
  const bundled = bundledGsVersion();
  return { loaded: entry.name, map: [welcome.mapX, welcome.mapY], date: `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`,
    paused: now.paused, bridge_version: now.bridge_version ?? null, seconds: Math.round((Date.now() - started) / 100) / 10,
    ...(bundled !== null && (now.bridge_version ?? 0) < bundled ? { warning: `this save runs AgentBridge v${now.bridge_version}; v${bundled} is bundled: openttd-agent install-gamescript --reload true` } : {}) };
}

/** Saves in a profile's save folder, newest first. */
export function listSaves(dir) {
  const folder = path.join(dir, 'save');
  if (!fs.existsSync(folder)) return { folder, saves: [] };
  const saves = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.sav')).map((f) => {
    const st = fs.statSync(path.join(folder, f));
    return { name: f.replace(/\.sav$/i, ''), bytes: st.size, modified: st.mtime.toISOString() };
  }).sort((a, b) => b.modified.localeCompare(a.modified));
  return { folder, saves };
}

/**
 * Stop a server (H1): optional save first, then console `quit`; SIGTERM by the profile's cfg
 * path if it does not exit (or the admin port does not answer).
 */
export async function stopServer(target, { save, timeoutMs = 20000 } = {}) {
  const before = serverPids(target.cfgPath);
  const out = { server: target.server, was_running: before === null ? null : before.length > 0, pids: before };
  let saved = null, method = null, adminError = null;
  try {
    await withAdmin(target, async (admin) => {
      if (save) saved = await saveAndWait(admin, target, save);
      admin.closed = true; // expected: the server drops the connection on quit
      await admin.rcon('quit', 5000).catch(() => null); // the server goes away before it answers
      method = 'console_quit';
    });
  } catch (e) {
    if (save && !saved) throw e; // never quit without the save that was asked for
    adminError = e.message;
  }
  const deadline = Date.now() + timeoutMs;
  while ((serverPids(target.cfgPath) ?? []).length && Date.now() < deadline) await sleep(250);
  if ((serverPids(target.cfgPath) ?? []).length) { out.kill = await killServer(target.cfgPath); method = method ? `${method}+sigterm` : 'sigterm'; }
  const after = serverPids(target.cfgPath);
  return { ...out, stopped: after === null ? null : after.length === 0, method: method ?? (out.was_running ? null : 'not_running'),
    ...(saved ? { save: saved } : {}), ...(adminError && out.was_running ? { admin_error: adminError } : {}) };
}

/** Start an AI company on the server (`start_ai <ai>`) and wait for its company id (H1). */
export async function companyNew(admin, gs, ai = 'IdleAI', { timeoutMs = 20000 } = {}) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(ai)) throw new Error(`bad_arguments: ai must be an AI name like IdleAI, got '${ai}'`);
  const before = new Set((await gs.call('companies')).map((c) => c.id));
  const out = await admin.rcon(`start_ai ${ai}`, 15000);
  if (out.some((l) => /failed|not found|unknown|can't|cannot|too many/i.test(l))) throw new Error(`company_new_failed: start_ai ${ai}: ${out.join(' ')}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await gs.call('companies');
    const fresh = rows.filter((c) => !before.has(c.id));
    if (fresh.length) return { company: fresh[0].id, name: fresh[0].name ?? null, ai, console: out };
    if (Date.now() > deadline) throw new Error(`company_new_timeout: no new company within ${Math.round(timeoutMs / 1000)}s after start_ai ${ai} (console: ${out.join(' ') || 'nothing'}). A paused game may hold it: unpause briefly`);
    await sleep(300);
  }
}

/**
 * install-gamescript --reload true (H4): install, rescan, save, load that save again (the
 * loaded game starts the newest compatible AgentBridge) and restore the pause state.
 */
export async function reloadGamescript(target, { saveName } = {}) {
  const install = installGamescript();
  const want = bundledGsVersion();
  return withAdmin(target, async (admin, gs) => {
    const before = await gs.call('info', {}, 10000).catch(() => null);
    const rescan = await admin.rcon('rescan_game', 30000);
    const name = saveName ?? `gs-reload-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}`;
    const saved = await saveAndWait(admin, target, name);
    const loaded = await loadSave(admin, gs, name, { pause: before ? before.paused : undefined, minVersion: want ?? undefined });
    const ok = want === null || (loaded.bridge_version ?? 0) >= want;
    log.info('host', 'gamescript reloaded', { server: target.server, before: before?.bridge_version, now: loaded.bridge_version });
    return { ok, ...(ok ? {} : { error: `gs_version: the game still runs AgentBridge v${loaded.bridge_version} after the reload (v${want} installed); check server-log --errors true` }),
      installed: install, reloaded: true, bridge_version_before: before?.bridge_version ?? null, bridge_version_now: loaded.bridge_version,
      paused: loaded.paused, save: saved.saved, rescan, load: loaded };
  });
}

/** Every launch profile on this machine with its ports and whether its OpenTTD runs (doctor). Cheap: no admin login. */
export function serverStates() {
  return listServerProfiles().map((name) => {
    const dir = profileDir(name);
    const pids = serverPids(path.join(dir, 'openttd.cfg'));
    const p = profilePorts(dir);
    const gs = logTail(dir, { lines: 0 }).gs ?? null;
    return { server: name, running: pids === null ? null : pids.length > 0, pids, game_port: p.game_port, admin_port: p.admin_port,
      ...(gs ? { gamescript_in_log: gs.state } : {}) };
  });
}
