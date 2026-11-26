// Config: ~/.openttd-agent/config.json, overridable by env vars.
// Host: admin_password (never leaves this machine) + relay_port.
// Player: relay (the host's relay URL) + relay_token. No admin password.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = process.env.OPENTTD_AGENT_HOME ?? path.join(os.homedir(), '.openttd-agent');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const DEFAULTS = {
  host: '127.0.0.1',          // where the admin port is (the relay host talks to its own machine)
  admin_port: 3977,
  admin_password: '',         // host only; players never get it
  company: null,              // direct mode: company id to act as. Relay mode: the host decides
  relay: '',                  // player: http://<host-LAN-IP>:<relay_port>; when set, game commands go there
  relay_token: '',            // player: token printed once by the host's relay-add-player
  relay_port: 47978,          // host: port `openttd-agent relay` listens on
  daemon_port: 47977,         // local daemon (127.0.0.1 only)
  max_builds_per_minute: 0,   // client-side throttle, 0 = unlimited (full speed)
  tile_refresh_rows_per_sec: 4, // background map refresh speed after the first full load
};

const ENV = {
  host: 'OPENTTD_AGENT_HOST', admin_port: 'OPENTTD_AGENT_ADMIN_PORT', admin_password: 'OPENTTD_AGENT_ADMIN_PASSWORD',
  company: 'OPENTTD_AGENT_COMPANY', relay: 'OPENTTD_AGENT_RELAY', relay_token: 'OPENTTD_AGENT_RELAY_TOKEN', relay_port: 'OPENTTD_AGENT_RELAY_PORT', daemon_port: 'OPENTTD_AGENT_DAEMON_PORT', max_builds_per_minute: 'OPENTTD_AGENT_MAX_BUILDS_PER_MINUTE',
};

export const PLAYERS_DIR = path.join(CONFIG_DIR, 'players');

/**
 * Active player profile: OPENTTD_AGENT_PLAYER_FILE (a JSON file path) or OPENTTD_AGENT_PROFILE
 * (a name: ~/.openttd-agent/players/<name>.json; the CLI's global --profile sets it). A profile
 * holds config keys (typically relay, relay_token; `token` is accepted for relay_token) and sits
 * between config.json and env vars. Returns { name, file } or null.
 */
export function activeProfile() {
  const file = process.env.OPENTTD_AGENT_PLAYER_FILE;
  if (file) return { name: path.basename(file).replace(/\.json$/i, ''), file: path.resolve(file) };
  const name = process.env.OPENTTD_AGENT_PROFILE;
  if (!name) return null;
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name) || name.startsWith('.')) throw new Error(`profile name must be 1-32 of A-Z a-z 0-9 _ . - (not starting with '.'), got '${name}'`);
  return { name, file: path.join(PLAYERS_DIR, `${name}.json`) };
}

function readProfile(p) {
  if (!fs.existsSync(p.file)) {
    if (process.env.OPENTTD_AGENT_PLAYER_FILE) throw new Error(`player file ${p.file} (OPENTTD_AGENT_PLAYER_FILE) does not exist`);
    return {};
  }
  let data;
  try { data = JSON.parse(fs.readFileSync(p.file, 'utf8')); } catch (e) { throw new Error(`player profile ${p.file} is not valid JSON: ${e.message}`); }
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    const key = k === 'token' ? 'relay_token' : k;
    if (key in DEFAULTS) out[key] = v; // other keys (notes, names) are ignored
  }
  return out;
}

export function loadConfig() {
  let file = {};
  if (fs.existsSync(CONFIG_FILE)) file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const profile = activeProfile();
  const cfg = { ...DEFAULTS, ...file, ...(profile ? readProfile(profile) : {}) };
  for (const [key, env] of Object.entries(ENV)) {
    if (process.env[env] !== undefined) cfg[key] = typeof DEFAULTS[key] === 'number' || key === 'company' ? Number(process.env[env]) : process.env[env];
  }
  if (profile) Object.defineProperty(cfg, 'profile', { value: profile.name, enumerable: true });
  return cfg;
}

/**
 * Merge `updates` into the config file (only known keys) and return the new config. With a
 * profile active the updates go to the profile file instead (configure --profile NAME ...).
 */
export function saveConfig(updates) {
  const profile = activeProfile();
  const target = profile ? profile.file : CONFIG_FILE;
  let file = {};
  if (fs.existsSync(target)) file = JSON.parse(fs.readFileSync(target, 'utf8'));
  for (const [k, v] of Object.entries(updates)) {
    if (!(k in DEFAULTS)) throw new Error(`unknown config key '${k}'. Known: ${Object.keys(DEFAULTS).join(', ')}`);
    if (v !== undefined) file[k] = v;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  return loadConfig();
}

export function redacted(cfg) {
  return { ...cfg, admin_password: cfg.admin_password ? '***' : '', relay_token: cfg.relay_token ? '***' : '' };
}
