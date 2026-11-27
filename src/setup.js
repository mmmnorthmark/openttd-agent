// Host/player setup: locate OpenTTD, install the GameScript, write a launch
// profile, start the game. Never edits the user's own openttd.cfg: launch
// profiles live in ~/.openttd-agent/profiles/<name>/ and OpenTTD is started with
// `-c <profile>/openttd.cfg`. With -c, OpenTTD uses the cfg's folder as its
// config and personal dir (secrets.cfg, saves, log), and still scans the normal
// personal dir (~/Documents/OpenTTD etc.) for baseset, game scripts and AIs.
// secrets.cfg is only read when openttd.cfg has [version] ini_version >= 1;
// without it OpenTTD reads secrets from openttd.cfg itself (15.3 settings.cpp).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from './config.js';
import { log } from './log.js';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GS_NAME = 'AgentBridge';
// OpenTTD 15.x INIFILE_VERSION (IFV_REMOVE_GENERATION_SEED). Needed so secrets.cfg is honoured.
export const INI_VERSION = 7;
export const TERRAIN_TYPES = ['very_flat', 'flat', 'hilly', 'mountainous', 'alpinist']; // difficulty.terrain_type 0..4

export function personalDirCandidates() {
  const home = os.homedir();
  if (process.env.OPENTTD_PERSONAL_DIR) return [process.env.OPENTTD_PERSONAL_DIR];
  switch (process.platform) {
    case 'darwin': return [path.join(home, 'Documents', 'OpenTTD')];
    case 'win32': return [path.join(home, 'Documents', 'OpenTTD'), path.join(home, 'OneDrive', 'Documents', 'OpenTTD')];
    default: return [path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'openttd'), path.join(home, '.openttd')];
  }
}

export function findPersonalDir() {
  const c = personalDirCandidates();
  return c.find((d) => fs.existsSync(d)) ?? c[0];
}

export function findExecutable() {
  if (process.env.OPENTTD_EXE) return process.env.OPENTTD_EXE;
  const candidates = {
    darwin: ['/Applications/OpenTTD.app/Contents/MacOS/openttd', path.join(os.homedir(), 'Applications/OpenTTD.app/Contents/MacOS/openttd')],
    win32: ['C:\\Program Files\\OpenTTD\\openttd.exe', 'C:\\Program Files (x86)\\OpenTTD\\openttd.exe',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\OpenTTD\\openttd.exe'],
    linux: ['/usr/games/openttd', '/usr/bin/openttd', '/usr/local/bin/openttd'],
  }[process.platform] ?? [];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['openttd'], { encoding: 'utf8' }).split(/\r?\n/)[0] || null; } catch { return null; }
}

function readGsVersion(dir) {
  try {
    const m = fs.readFileSync(path.join(dir, 'info.nut'), 'utf8').match(/GetVersion\(\)\s*\{\s*return\s+(\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/** AgentBridge version shipped in this package (gamescript/AgentBridge/info.nut). */
export function bundledGsVersion() { return readGsVersion(path.join(PACKAGE_ROOT, 'gamescript', GS_NAME)); }

const ORIGINAL_BASESET = ['trg1r.grf', 'trgcr.grf', 'trghr.grf', 'trgir.grf', 'trgtr.grf', 'sample.cat'];

export function doctor() {
  const personal = findPersonalDir();
  const exe = findExecutable();
  const basesetDir = path.join(personal, 'baseset');
  const baseFiles = fs.existsSync(basesetDir) ? fs.readdirSync(basesetDir).map((f) => f.toLowerCase()) : [];
  const installedGs = path.join(personal, 'game', GS_NAME);
  const bundledGs = path.join(PACKAGE_ROOT, 'gamescript', GS_NAME);
  const report = {
    platform: process.platform,
    node: process.version,
    openttd_executable: exe ?? 'NOT FOUND (install from https://www.openttd.org or set OPENTTD_EXE)',
    personal_dir: personal,
    personal_dir_exists: fs.existsSync(personal),
    original_graphics: ORIGINAL_BASESET.every((f) => baseFiles.includes(f)) ? 'found' : `missing (${ORIGINAL_BASESET.filter((f) => !baseFiles.includes(f)).join(', ')}); OpenGFX will be used instead`,
    original_music_tracks: baseFiles.filter((f) => /^gm_tt\d+\.gm$/.test(f)).length,
    gamescript_bundled_version: readGsVersion(bundledGs),
    gamescript_installed_version: readGsVersion(installedGs),
    gamescript_needed: 'host only',
  };
  if (exe && process.platform === 'darwin') {
    // Read the bundle version; never run the binary here (it would open the game window).
    const plist = path.resolve(path.dirname(exe), '..', 'Info.plist');
    const m = fs.existsSync(plist) && fs.readFileSync(plist, 'utf8').match(/CFBundleShortVersionString<\/key>\s*<string>([^<]+)/);
    if (m) report.openttd_version = m[1];
  }
  report.next_steps = [];
  if (!exe) report.next_steps.push('Install OpenTTD 15.x');
  if (report.gamescript_installed_version !== report.gamescript_bundled_version) {
    report.gamescript_warning = report.gamescript_installed_version === null ? 'AgentBridge is not installed'
      : `installed AgentBridge v${report.gamescript_installed_version} differs from the v${report.gamescript_bundled_version} this openttd-agent ships`;
    report.next_steps.push('If you host: openttd-agent install-gamescript, then launch the game again (a running game keeps the GameScript it started with)');
  }
  const gsProblems = gameScriptProblems();
  if (gsProblems.length) {
    report.launch_profile_game_scripts = gsProblems;
    report.next_steps.push(`Launch profile ${gsProblems.map((p) => p.profile).join(', ')}: [game_scripts] lists ${gsProblems.map((p) => p.game_scripts.join(', ') || 'nothing').join('; ')}; AgentBridge must be the only entry: run openttd-agent launch again (it rewrites the section)`);
  }
  return report;
}

function removeIfSymlink(p) {
  try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* does not exist */ }
}

/** Copy the bundled GameScript into <personal>/game/AgentBridge (host only). */
export function installGamescript({ personalDir = findPersonalDir() } = {}) {
  const src = path.join(PACKAGE_ROOT, 'gamescript', GS_NAME);
  const dst = path.join(personalDir, 'game', GS_NAME);
  const before = readGsVersion(dst);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  removeIfSymlink(dst); // dev symlink (possibly dangling): replace the link only
  fs.cpSync(src, dst, { recursive: true, force: true });
  const ai = path.join(personalDir, 'ai', 'IdleAI');
  fs.mkdirSync(path.dirname(ai), { recursive: true });
  removeIfSymlink(ai);
  fs.cpSync(path.join(PACKAGE_ROOT, 'ai', 'IdleAI'), ai, { recursive: true, force: true });
  const result = { installed_to: dst, version_before: before, version_now: readGsVersion(dst), also_installed: ai };
  log.info('setup', 'gamescript installed', result);
  return result;
}

// ---- INI patching (keeps everything else in the file untouched) ------------

export function patchIni(text, patches) {
  const lines = text.split(/\r?\n/);
  for (const [section, kv] of Object.entries(patches)) {
    let start = lines.findIndex((l) => l.trim().toLowerCase() === `[${section}]`);
    if (start === -1) { lines.push('', `[${section}]`); start = lines.length - 1; }
    let end = lines.findIndex((l, i) => i > start && /^\s*\[.*\]\s*$/.test(l));
    if (end === -1) end = lines.length;
    for (const [key, value] of Object.entries(kv)) {
      const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
      const at = lines.findIndex((l, i) => i > start && i < end && re.test(l));
      const line = `${key} = ${value}`;
      if (at !== -1) lines[at] = line; else { lines.splice(end, 0, line); end++; }
    }
  }
  return lines.join('\n');
}

/**
 * Replace a whole INI section's body with `lines` (adds the section if missing). Used for
 * [game_scripts]: OpenTTD starts the first entry listed there, so a `none =` or another script
 * copied from the user's openttd.cfg would win over AgentBridge.
 */
export function replaceIniSection(text, section, bodyLines) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `[${section}]`);
  if (start === -1) return [...lines, '', `[${section}]`, ...bodyLines].join('\n');
  let end = lines.findIndex((l, i) => i > start && /^\s*\[.*\]\s*$/.test(l));
  if (end === -1) end = lines.length;
  // Keep blank lines and comments that separate this section from the next one.
  lines.splice(start + 1, end - start - 1, ...bodyLines, '');
  return lines.join('\n');
}

/** Entries of an INI section (key names, comments and blanks skipped). */
export function iniSectionKeys(text, section) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `[${section}]`);
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && !/^\s*\[.*\]\s*$/.test(lines[i]); i++) {
    const m = /^\s*([^;#=\s][^=]*?)\s*=/.exec(lines[i]);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Launch profiles whose openttd.cfg [game_scripts] lists anything but AgentBridge alone (doctor). */
export function gameScriptProblems(profilesDir = path.join(CONFIG_DIR, 'profiles')) {
  const out = [];
  if (!fs.existsSync(profilesDir)) return out;
  for (const name of fs.readdirSync(profilesDir)) {
    const cfg = path.join(profilesDir, name, 'openttd.cfg');
    if (name === 'join' || !fs.existsSync(cfg)) continue;
    const keys = iniSectionKeys(fs.readFileSync(cfg, 'utf8'), 'game_scripts');
    if (keys.length !== 1 || keys[0] !== GS_NAME) out.push({ profile: name, game_scripts: keys, fix: `openttd-agent launch --mode ${name === 'host' ? 'host' : 'dedicated'} rewrites it` });
  }
  return out;
}

/** A console save name: 1-64 of A-Z a-z 0-9 _ . -, not starting with '.', no path separators. Returns it or throws. */
export function checkSaveName(name) {
  const n = String(name ?? '').trim().replace(/\.sav$/i, '');
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/.test(n) || n.includes('..')) {
    throw new Error(`save name must be 1-64 characters from A-Z a-z 0-9 _ . - (no '/', '\\', '..' or leading '.'), got '${name}'`);
  }
  return n;
}

/**
 * `launch --load` value -> path for OpenTTD's -g (used as given: absolute, or relative to the
 * profile dir, and it needs its extension). A bare save name, as printed by scenario-prepare or
 * used with the console's `save`, is looked up in the profile's save/ folder.
 */
export function resolveSavePath(load, profileDir) {
  const candidates = [path.resolve(profileDir, load), path.join(profileDir, 'save', load), path.join(profileDir, 'save', `${load}.sav`)];
  const found = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!found) throw new Error(`savegame '${load}' not found. Tried: ${candidates.join(', ')}`);
  return found;
}

/** OpenTTD's launch profile folder for a server name (`launch --server NAME`; default: the mode). */
export function profileDir(name) {
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(String(name)) || String(name).startsWith('.')) throw new Error(`server name must be 1-32 of A-Z a-z 0-9 _ . - (not starting with '.'), got '${name}'`);
  return path.join(CONFIG_DIR, 'profiles', name);
}

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

/** One value of an INI file (`section`, `key`), or undefined. */
export function iniValue(text, section, key) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `[${section}]`);
  if (start === -1) return undefined;
  for (let i = start + 1; i < lines.length && !/^\s*\[.*\]\s*$/.test(lines[i]); i++) {
    const m = /^\s*([^=;#]+?)\s*=\s*(.*?)\s*$/.exec(lines[i]);
    if (m && m[1] === key) return m[2];
  }
  return undefined;
}

/**
 * Plan a launch: the files to write and the command line, reading but never writing anything
 * (so --dry_run changes nothing on disk). Returns { dir, cfgPath, files: [{ path, text, mode? }], args, logFile }.
 */
export function planLaunch({ mode = 'dedicated', server = mode, adminPassword, adminPort = 3977, gamePort = 3979,
  bind = '0.0.0.0', joinHost, seed, mapBits = 8, load, commandDelayTicks = 0, maxBuildsPerDay = 0, scriptOpcodes = 100000, terrain, serverName = 'openttd-agent game' }) {
  const dir = profileDir(server);
  const cfgPath = path.join(dir, 'openttd.cfg');
  const files = [];
  let cfgText;
  if (fs.existsSync(cfgPath)) cfgText = fs.readFileSync(cfgPath, 'utf8');
  else {
    const userCfg = path.join(findPersonalDir(), 'openttd.cfg');
    cfgText = fs.existsSync(userCfg) ? fs.readFileSync(userCfg, 'utf8') : '';
  }
  const patches = {};
  if (mode !== 'join') {
    if (!adminPassword) throw new Error('adminPassword is required to host (the launch command generates one when none is configured)');
    patches.network = {
      server_admin_port: adminPort, server_port: gamePort, allow_insecure_admin_login: 'true',
      server_game_type: 'local', pause_on_join: 'false',
    };
    // Opcodes a script may run per tick before OpenTTD suspends it (game default 10000, max 250000).
    // Higher = faster map dumps and replies, at some cost to tick time on the host.
    patches.script = { script_max_opcode_till_suspend: scriptOpcodes };
    patches.game_creation = { map_x: mapBits, map_y: mapBits };
    // Uncompressed saves: scenario-prepare reads and rewrites them (src/savegame.js). Read at startup only.
    patches.misc = { savegame_format: 'none' };
    // 3 = all actions allowed while paused, so agents can build during a paused turn (new games; a
    // loaded save keeps its own value, which `pause` sets over the console).
    patches.construction = { command_pause_level: 3 };
    if (terrain !== undefined) patches.difficulty = { terrain_type: TERRAIN_TYPES.indexOf(terrain) }; // seed goes on the command line (-G); ini v7 dropped generation_seed
    files.push({ path: path.join(dir, 'secrets.cfg'), text: `[network]\nadmin_password = ${adminPassword}\n`, mode: 0o600 });
    // client_name and server_name are private settings (private.cfg since ini_version 1; openttd.cfg
    // entries are ignored). A dedicated server joins its own game as a client: name it, or the
    // client list shows "Unnamed Client".
    const privatePath = path.join(dir, 'private.cfg');
    const privateText = fs.existsSync(privatePath) ? fs.readFileSync(privatePath, 'utf8') : '';
    files.push({ path: privatePath, text: patchIni(privateText, { network: { server_name: serverName, ...(mode === 'dedicated' ? { client_name: 'openttd-agent server' } : {}) } }) });
  }
  if (!/^\s*\[version\]\s*$/m.test(cfgText)) cfgText = `[version]\nini_version = ${INI_VERSION}\n\n${cfgText}`;
  cfgText = cfgText.replace(/^\s*generation_seed\s*=.*\n?/m, '');
  cfgText = patchIni(cfgText, patches);
  if (mode !== 'join') cfgText = replaceIniSection(cfgText, 'game_scripts', [`${GS_NAME} = command_delay_ticks=${commandDelayTicks},max_builds_per_day=${maxBuildsPerDay}`]);
  files.unshift({ path: cfgPath, text: cfgText });
  if (mode !== 'join') {
    files.push({ path: path.join(dir, SERVER_STATE_FILE), text: JSON.stringify({ mode, game_port: gamePort, admin_port: adminPort, bind, host: adminHostForBind(bind) }, null, 2) + '\n' });
  }

  const args = ['-c', cfgPath];
  if (mode === 'dedicated') args.push('-D', `${bind}:${gamePort}`, '-d', 'script=4');
  if (mode === 'join') {
    if (!joinHost) throw new Error('joinHost is required for mode=join (the host machine LAN IP)');
    args.push('-n', `${joinHost}:${gamePort}`);
  }
  if (seed !== undefined && mode !== 'join') args.push('-G', String(seed));
  if (load) args.push('-g', resolveSavePath(load, dir));
  return { dir, cfgPath, files, args, logFile: path.join(dir, 'openttd.log') };
}

/** server.json in a launch profile: { mode, game_port, admin_port, bind, host } written by launch. */
export const SERVER_STATE_FILE = 'server.json';

/** Keep the last LOG_KEEP logs: openttd.log -> openttd.log.1 -> ... Returns the moved names. */
export const LOG_KEEP = 3;
export function rotateLogs(logFile, keep = LOG_KEEP) {
  if (!fs.existsSync(logFile) || fs.statSync(logFile).size === 0) return [];
  for (let i = keep - 1; i >= 1; i--) {
    if (fs.existsSync(`${logFile}.${i}`)) fs.renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`);
  }
  fs.renameSync(logFile, `${logFile}.1`);
  return [`${path.basename(logFile)} -> ${path.basename(logFile)}.1`];
}

/**
 * Write a launch profile and start OpenTTD (or, with dryRun, only say what it would do).
 * mode: 'dedicated' (headless server, everyone joins as a client),
 *       'host' (GUI; you then start a LAN server from the Multiplayer menu),
 *       'join' (GUI client joining host:3979).
 * Returns { result, child }; child is null on a dry run.
 */
export function launch(opts) {
  const { mode = 'dedicated', dryRun = false, adminPort = 3977, gamePort = 3979, bind = '0.0.0.0' } = opts;
  const exe = findExecutable();
  if (!exe) throw new Error('OpenTTD executable not found; install it or set OPENTTD_EXE');
  const plan = planLaunch(opts);
  const result = { mode, server: opts.server ?? mode, profile_dir: plan.dir, executable: exe, args: plan.args, log: plan.logFile,
    admin_port: mode === 'join' ? null : adminPort, game_port: gamePort };
  // OpenTTD 15.3 binds the admin port to the same addresses as the game port
  // (network.cpp GetBindAddresses: one list for both), so it cannot be kept on loopback
  // while players join over the LAN. The password is what protects it.
  if (mode === 'dedicated') {
    result.admin_port_reachable_from = /^(127\.|localhost$|::1$)/.test(bind)
      ? 'this machine only'
      : 'the LAN (OpenTTD binds it like the game port). Keep the admin password on this machine; players use the relay.';
  }
  if (dryRun) return { result: { ...result, dry_run: true, would_write: plan.files.map((f) => f.path) }, child: null };
  fs.mkdirSync(plan.dir, { recursive: true });
  for (const f of plan.files) fs.writeFileSync(f.path, f.text, f.mode ? { mode: f.mode } : undefined);
  const rotated = rotateLogs(plan.logFile);
  if (rotated.length) result.log_rotated = rotated;
  const out = fs.openSync(plan.logFile, 'a');
  const child = spawn(exe, plan.args, { cwd: plan.dir, detached: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  child.unref();
  result.pid = child.pid;
  log.info('setup', 'launched OpenTTD', result);
  return { result, child };
}
