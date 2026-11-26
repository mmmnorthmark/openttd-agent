// `guide`: what to do next to get a game night running, as host or player.
// Two halves:
//   probeSetup(ctx)            impure, read-only, cheap probes (each try/catch + short timeout).
//                              Never starts or stops anything; never returns secrets.
//   buildGuide(role, probes)   pure: probe results -> { role, steps, next }.
// Probe shape (every field optional; missing = not probed):
//   config: { relay, token, admin_password: booleans, launch_profile: boolean, relay_port }
//   doctor: { ok, openttd_found, openttd_version, gamescript_installed, gamescript_bundled } | { ok: false, error }
//   lan_ips: [string]
//   game:   { ok, companies: [ids], goals: { [id]: status } | null } | { ok: false, error }    (host)
//   relay_local: { ok, version } | { ok: false, error }                                     (host)
//   players: [{ name, company }]                                                            (host)
//   relay:  { ok, version } | { ok: false, error }                                          (player)
//   status: { ok, my_company } | { ok: false, error }                                       (player)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { doctor } from './setup.js';
import { relayHealth, callRelay } from './relay-client.js';
import { listPlayers } from './relay-players.js';
import { daemonHealthy, callDaemon } from './daemon.js';
import { VERSION } from './version.js';

const GAME_TIMEOUT_MS = 8000;
const PACKAGE_REF = (version) => `github:mmmnorthmark/openttd-agent#v${version}`;

// First line, without the "run: openttd-agent guide" hint that error messages end with (this is guide).
const short = (msg) => String(msg ?? '').split('\n')[0].replace(/[.,]?\s*(Then |Not sure which\? |or )?run: openttd-agent guide\)?$/i, '').slice(0, 240);

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms); timer.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Run fn with a timeout; never throws. -> { ok: true, value } | { ok: false, error } */
async function attempt(fn, ms, what) {
  try { return { ok: true, value: await withTimeout(Promise.resolve().then(fn), ms, what) }; } catch (e) { return { ok: false, error: short(e.message) }; }
}

/** 'host' | 'player' | 'unknown' from the config alone. */
export function inferRole(config) {
  if (config.relay) return 'player';
  if (config.admin_password || config.launch_profile) return 'host';
  return 'unknown';
}

const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

/** Host game probe: through the running daemon if there is one, else one in-process admin connection. Read-only commands only. */
async function probeGame(ctx) {
  const { runCommand } = await import('./commands.js'); // late import: commands.js imports this module
  const port = ctx.cfg.daemon_port;
  const viaDaemon = await daemonHealthy(port).catch(() => false);
  const call = (name, args = {}) => withTimeout(viaDaemon ? callDaemon(port, name, args) : runCommand(ctx, name, args), GAME_TIMEOUT_MS, name);
  try {
    const reply = await call('companies');
    const companies = (Array.isArray(reply) ? reply : reply.companies).map((c) => c.id); // a daemon older than 0.7.0 returns a bare list
    let goals = {};
    for (const id of companies) {
      const g = await call('goal-status', { company: id }).catch(() => null);
      if (!g) { goals = null; break; }
      goals[id] = g.status;
    }
    const st = await call('status').catch(() => null);
    return { ok: true, companies, goals, gamescript_running: st?.info?.bridge_version ?? null };
  } catch (e) { return { ok: false, error: short(e.message) }; }
}

/** Gather probe results for `role` ('host' | 'player' | 'unknown'). */
export async function probeSetup(ctx, role) {
  const cfg = ctx.cfg;
  const profiles = path.join(CONFIG_DIR, 'profiles');
  const config = {
    relay: Boolean(cfg.relay), token: Boolean(cfg.relay_token), admin_password: Boolean(cfg.admin_password),
    launch_profile: ['dedicated', 'host'].some((p) => fs.existsSync(path.join(profiles, p, 'openttd.cfg'))),
    relay_port: cfg.relay_port,
  };
  const probes = { config, lan_ips: lanAddresses() };
  const d = await attempt(() => doctor(), 3000, 'doctor');
  probes.doctor = d.ok
    ? { ok: true, openttd_found: !String(d.value.openttd_executable).startsWith('NOT FOUND'), openttd_version: d.value.openttd_version ?? null,
      gamescript_installed: d.value.gamescript_installed_version, gamescript_bundled: d.value.gamescript_bundled_version }
    : d;
  const wanted = role === 'unknown' ? inferRole(config) : role;
  if (wanted === 'host') {
    probes.players = (await attempt(() => listPlayers(), 1000, 'players')).value ?? [];
    const local = await attempt(() => relayHealth({ relay: `http://127.0.0.1:${cfg.relay_port}` }), 4000, 'relay');
    probes.relay_local = local.ok ? { ok: Boolean(local.value.ok), version: local.value.version ?? null, ...(local.value.ok ? {} : { error: short(local.value.error) }) } : local;
    probes.game = config.admin_password ? await probeGame(ctx) : { ok: false, error: 'no admin_password in the config (launch generates one)' };
  }
  if (wanted === 'player' && config.relay) {
    const h = await attempt(() => relayHealth(cfg), 4000, 'relay');
    probes.relay = h.ok ? { ok: Boolean(h.value.ok), version: h.value.version ?? null, ...(h.value.ok ? {} : { error: short(h.value.error) }) } : h;
    if (probes.relay.ok && config.token) {
      const s = await attempt(() => callRelay(cfg, 'status', {}, { timeoutMs: GAME_TIMEOUT_MS }), GAME_TIMEOUT_MS + 500, 'status');
      probes.status = s.ok ? { ok: true, my_company: s.value.my_company ?? null } : s;
    }
  }
  return probes;
}

// ---- pure step logic ----------------------------------------------------------

const known = (probe) => probe !== undefined && probe !== null;

function doctorStep(p) {
  const d = p.doctor;
  return {
    id: 'doctor', step: 'Check this machine: OpenTTD installed, same OpenTTD version on every machine',
    done: known(d) && d.ok ? d.openttd_found : null,
    command: 'openttd-agent doctor',
    why: `Every machine needs the same OpenTTD version (doctor prints openttd_version${d?.openttd_version ? `; here ${d.openttd_version}` : ''}) and Node 20+. Graphics: OpenGFX is fine, or your own original TTD files in Documents/OpenTTD/baseset.`,
  };
}

export function hostSteps(p, version = VERSION) {
  const d = p.doctor, game = p.game, players = p.players ?? [];
  const ip = p.lan_ips?.[0] ?? '<host-LAN-IP>';
  const relayPort = p.config?.relay_port ?? 47978;
  const pending = players.filter((x) => x.company === null || x.company === undefined || x.company === 'pending');
  const companies = game?.ok ? game.companies : null;
  const unknownBinding = companies ? players.filter((x) => typeof x.company === 'number' && !companies.includes(x.company)) : [];
  const goals = game?.ok ? game.goals : null;
  return [
    doctorStep(p),
    {
      id: 'install-gamescript', step: 'Install the AgentBridge GameScript (host only)',
      done: known(d) && d.ok ? (d.gamescript_installed !== null && d.gamescript_installed === d.gamescript_bundled) : null,
      command: 'openttd-agent install-gamescript',
      why: 'The server runs AgentBridge; re-run after updating openttd-agent, then load the game again.',
    },
    {
      id: 'launch', step: 'Start the dedicated server',
      done: known(game) ? game.ok : null,
      command: 'openttd-agent launch --mode dedicated --map_bits 9',
      why: 'Headless server on 0.0.0.0:3979 with AgentBridge; generates the admin password and keeps it in your config.',
      ...(game && !game.ok ? { detail: game.error } : {}),
    },
    {
      id: 'gamescript-running', step: 'The game runs the AgentBridge version this openttd-agent ships',
      done: game?.ok && game.gamescript_running && d?.ok && d.gamescript_bundled ? game.gamescript_running >= d.gamescript_bundled : null,
      command: 'openttd-agent install-gamescript, then openttd-agent launch (or load the save again)',
      why: 'A running game keeps the GameScript it started with; newer commands fall back or say so until it is reloaded.',
      ...(game?.ok && game.gamescript_running ? { detail: `running v${game.gamescript_running}, bundled v${d?.gamescript_bundled ?? '?'}` } : {}),
    },
    {
      id: 'relay', step: 'Run the relay and leave it running',
      done: known(p.relay_local) ? p.relay_local.ok : null,
      command: 'openttd-agent relay',
      why: `Players' agents connect to it on port ${relayPort} with their own token; nobody else needs the admin password.`,
      ...(p.relay_local?.ok && p.relay_local.version && p.relay_local.version !== version ? { detail: `relay runs ${p.relay_local.version}, this is ${version}` } : {}),
    },
    {
      id: 'network', step: 'Open the firewall and tell players the address',
      done: null,
      command: `allow incoming TCP 3979 (game) and ${relayPort} (relay); players join ${ip}:3979`,
      why: 'You can only check this from another machine.',
      lan_ips: p.lan_ips ?? [],
    },
    {
      id: 'join', step: 'Everyone joins in the OpenTTD window and clicks New company',
      done: companies ? companies.length >= Math.max(1, players.length) : null,
      command: `OpenTTD: Multiplayer > Add server ${ip}:3979 > Join game > New company`,
      why: 'A company exists only once a player founds it.',
      ...(companies ? { detail: `${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}: ${companies.join(', ') || '(none)'}` } : {}),
    },
    {
      id: 'relay-add-player', step: 'Register each player whose agent should play',
      done: players.length > 0,
      command: 'openttd-agent relay-add-player --name <player> --company pending',
      why: 'Prints a token once and the configure line to send that player.',
      ...(players.length ? { detail: `registered: ${players.map((x) => x.name).join(', ')}` } : {}),
    },
    {
      id: 'relay-set-company', step: 'Bind each player to their company',
      done: players.length > 0 ? pending.length === 0 && unknownBinding.length === 0 : false,
      command: `openttd-agent companies, then openttd-agent relay-set-company --name ${pending[0]?.name ?? unknownBinding[0]?.name ?? '<player>'} --company <id>`,
      why: "A player's agent can build only as the company it is bound to.",
      ...(pending.length ? { detail: `pending: ${pending.map((x) => x.name).join(', ')}` } : {}),
      ...(unknownBinding.length ? { detail: `bound to a company that does not exist: ${unknownBinding.map((x) => `${x.name}->${x.company}`).join(', ')}` } : {}),
    },
    {
      id: 'goal-set', step: 'Optional: set the same goal for every company so there is a winner',
      optional: true,
      done: goals && companies.length ? companies.every((id) => goals[id] && goals[id] !== 'none') : null,
      command: 'openttd-agent goal-set --company <id> --deadline_year <year> --targets VALUE:500000',
      why: 'AgentBridge tracks and settles it; it shows in the game\'s goal window.',
    },
    {
      id: 'save', step: 'End of the night: save the game',
      optional: true, done: null,
      command: 'openttd-agent save --name <name>',
      why: 'Saved in the launch profile\'s save folder; next time: openttd-agent launch --mode dedicated --load <name>.',
    },
  ];
}

export function playerSteps(p, version = VERSION) {
  const c = p.config ?? {}, relay = p.relay, status = p.status;
  const configured = Boolean(c.relay && c.token);
  return [
    doctorStep(p),
    {
      id: 'configure', step: 'Point openttd-agent at the host\'s relay with your token',
      done: configured,
      command: 'openttd-agent configure --relay http://<host-LAN-IP>:47978 --token <token from the host>',
      why: 'The host sends you this line after relay-add-player.',
    },
    {
      id: 'relay', step: 'Reach the host\'s relay',
      done: configured && known(relay) ? relay.ok : null,
      command: "ask the host to run: openttd-agent relay; check the address and that TCP 47978 is open",
      why: 'Every game command goes through it.',
      ...(relay && !relay.ok ? { detail: relay.error } : {}),
    },
    {
      id: 'version', step: 'Use the same openttd-agent version as the host',
      done: relay?.ok && relay.version ? relay.version === version : null,
      command: relay?.ok && relay.version && relay.version !== version ? `npx -y ${PACKAGE_REF(relay.version)} guide` : `openttd-agent version`,
      why: 'Commands must match on both sides.',
      ...(relay?.ok && relay.version ? { detail: `host ${relay.version}, you ${version}` } : {}),
    },
    {
      id: 'status', step: 'Check your token works',
      done: known(status) ? status.ok : null,
      command: 'openttd-agent status',
      why: 'status shows my_company, the company the host bound you to.',
      ...(status && !status.ok ? { detail: status.error } : {}),
    },
    {
      id: 'company', step: 'Join the game, click New company, and ask the host to bind it to you',
      done: status?.ok ? status.my_company !== null && status.my_company !== undefined : null,
      command: 'OpenTTD: Multiplayer > Add server <host-LAN-IP>:3979 > Join game > New company; host: openttd-agent relay-set-company --name <you> --company <id>',
      why: 'Your agent can build only for the company you are bound to.',
      ...(status?.ok && status.my_company !== null && status.my_company !== undefined ? { detail: `my_company ${status.my_company}` } : {}),
    },
    {
      id: 'agent', step: 'Connect your coding agent',
      done: null,
      command: `claude mcp add openttd -- npx -y ${PACKAGE_REF(version)} mcp`,
      why: 'Or any MCP client (command npx, args -y <package> mcp), or let the agent run the CLI directly.',
    },
  ];
}

/** First step still to do: a required one with done === false, else an optional one. */
export function nextStep(steps) {
  return steps.find((s) => s.done === false && !s.optional) ?? steps.find((s) => s.done === false) ?? null;
}

/** Pure: role ('host' | 'player' | undefined = infer) + probe results -> { role, steps, next }. */
export function buildGuide(role, probes, version = VERSION) {
  const r = role ?? inferRole(probes.config ?? {});
  let steps;
  if (r === 'host') steps = hostSteps(probes, version);
  else if (r === 'player') steps = playerSteps(probes, version);
  else {
    const host = hostSteps(probes, version).slice(1).map((s) => ({ ...s, part: 'host' }));
    const player = playerSteps(probes, version).slice(1).map((s) => ({ ...s, part: 'player' }));
    steps = [doctorStep(probes),
      { id: 'role', step: 'Decide: are you hosting the game or joining it?', done: false,
        command: 'openttd-agent guide --role host   or   openttd-agent guide --role player', why: 'Nothing in the config says yet.' },
      ...host, ...player];
  }
  const next = nextStep(steps);
  return { role: r, steps, next, ...(next ? {} : { note: 'every step that can be checked is done; steps with done null are for you to check' }) };
}

export async function guide(ctx, role) {
  const probes = await probeSetup(ctx, role ?? 'unknown');
  return buildGuide(role, probes);
}
