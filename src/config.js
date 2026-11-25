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

export function loadConfig() {
  let file = {};
  if (fs.existsSync(CONFIG_FILE)) file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const cfg = { ...DEFAULTS, ...file };
  for (const [key, env] of Object.entries(ENV)) {
    if (process.env[env] !== undefined) cfg[key] = typeof DEFAULTS[key] === 'number' || key === 'company' ? Number(process.env[env]) : process.env[env];
  }
  return cfg;
}

/** Merge `updates` into the config file (only known keys) and return the new config. */
export function saveConfig(updates) {
  let file = {};
  if (fs.existsSync(CONFIG_FILE)) file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  for (const [k, v] of Object.entries(updates)) {
    if (!(k in DEFAULTS)) throw new Error(`unknown config key '${k}'. Known: ${Object.keys(DEFAULTS).join(', ')}`);
    if (v !== undefined) file[k] = v;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  return loadConfig();
}

export function redacted(cfg) {
  return { ...cfg, admin_password: cfg.admin_password ? '***' : '', relay_token: cfg.relay_token ? '***' : '' };
}
