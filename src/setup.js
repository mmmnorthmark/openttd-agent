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
  if (report.gamescript_installed_version !== report.gamescript_bundled_version) report.next_steps.push('If you host: openttd-agent install-gamescript');
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
 * Write a launch profile and start OpenTTD.
 * mode: 'dedicated' (headless server, everyone joins as a client),
 *       'host' (GUI; you then start a LAN server from the Multiplayer menu),
 *       'join' (GUI client joining host:3979).
 */
export function launch({ mode = 'dedicated', profile = mode, adminPassword, adminPort = 3977, gamePort = 3979,
  bind = '0.0.0.0', joinHost, seed, mapBits = 8, load, commandDelayTicks = 0, maxBuildsPerDay = 0, scriptOpcodes = 100000, terrain, serverName = 'openttd-agent game',
  dryRun = false }) {
  const exe = findExecutable();
  if (!exe) throw new Error('OpenTTD executable not found; install it or set OPENTTD_EXE');
  const dir = path.join(CONFIG_DIR, 'profiles', profile);
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'openttd.cfg');
  if (!fs.existsSync(cfgPath)) {
    const userCfg = path.join(findPersonalDir(), 'openttd.cfg');
    fs.writeFileSync(cfgPath, fs.existsSync(userCfg) ? fs.readFileSync(userCfg, 'utf8') : '');
  }
  const patches = {};
  if (mode !== 'join') {
    if (!adminPassword) throw new Error('adminPassword is required to host (the launch command generates one when none is configured)');
    patches.network = {
      server_admin_port: adminPort, server_port: gamePort, allow_insecure_admin_login: 'true',
      server_game_type: 'local', server_name: serverName, pause_on_join: 'false',
    };
    // Opcodes a script may run per tick before OpenTTD suspends it (game default 10000, max 250000).
    // Higher = faster map dumps and replies, at some cost to tick time on the host.
    patches.script = { script_max_opcode_till_suspend: scriptOpcodes };
    patches.game_scripts = { [GS_NAME]: `command_delay_ticks=${commandDelayTicks},max_builds_per_day=${maxBuildsPerDay}` };
    patches.game_creation = { map_x: mapBits, map_y: mapBits };
    if (terrain !== undefined) patches.difficulty = { terrain_type: TERRAIN_TYPES.indexOf(terrain) }; // seed goes on the command line (-G); ini v7 dropped generation_seed
    fs.writeFileSync(path.join(dir, 'secrets.cfg'), `[network]\nadmin_password = ${adminPassword}\n`, { mode: 0o600 });
  }
  let cfgText = fs.readFileSync(cfgPath, 'utf8');
  if (!/^\s*\[version\]\s*$/m.test(cfgText)) cfgText = `[version]\nini_version = ${INI_VERSION}\n\n${cfgText}`;
  cfgText = cfgText.replace(/^\s*generation_seed\s*=.*\n?/m, '');
  fs.writeFileSync(cfgPath, patchIni(cfgText, patches));

  const args = ['-c', cfgPath];
  if (mode === 'dedicated') args.push('-D', `${bind}:${gamePort}`, '-d', 'script=4');
  if (mode === 'join') {
    if (!joinHost) throw new Error('joinHost is required for mode=join (the host machine LAN IP)');
    args.push('-n', `${joinHost}:${gamePort}`);
  }
  if (seed !== undefined && mode !== 'join') args.push('-G', String(seed));
  if (load) args.push('-g', load);
  const logFile = path.join(dir, 'openttd.log');
  const result = { mode, profile_dir: dir, executable: exe, args, log: logFile, admin_port: mode === 'join' ? null : adminPort, game_port: gamePort };
  // OpenTTD 15.3 binds the admin port to the same addresses as the game port
  // (network.cpp GetBindAddresses: one list for both), so it cannot be kept on loopback
  // while players join over the LAN. The password is what protects it.
  if (mode === 'dedicated') {
    result.admin_port_reachable_from = /^(127\.|localhost$|::1$)/.test(bind)
      ? 'this machine only'
      : 'the LAN (OpenTTD binds it like the game port). Keep the admin password on this machine; players use the relay.';
  }
  if (dryRun) return { ...result, dry_run: true };
  const out = fs.openSync(logFile, 'a');
  const child = spawn(exe, args, { cwd: dir, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  result.pid = child.pid;
  log.info('setup', 'launched OpenTTD', result);
  return result;
}
