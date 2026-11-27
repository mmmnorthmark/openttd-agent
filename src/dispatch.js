// One way to run a command from a surface (CLI, batch, MCP): pick where it runs, run it, shape the
// result once. Every surface calls dispatch(), so they behave the same (test/parity.test.js).
//
// Where a command runs:
//   - in this process: setup commands (session: false), --no-daemon / OPENTTD_AGENT_NO_DAEMON=1, a
//     relay player (the relay is the long-lived process), a profile (the daemon runs the base
//     config), or a daemon that runs with other settings (P11: config_hash differs);
//   - else in the local daemon, which keeps the admin connection, the map mirror and the
//     background jobs (pending sales and wagons, periodic saves) between calls.
// A one-shot process (the CLI) warns when a call there leaves a background job that dies with it.

import { COMMANDS_BY_NAME, executeCommand } from './commands.js';
import { loadConfig } from './config.js';
import { makeContext } from './context.js';
import { ensureDaemon, callDaemon, restartDaemon } from './daemon.js';
import { takeOutputArgs, shapeResult } from './output.js';
import { log } from './log.js';

const truthy = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());
export const noDaemonFromEnv = (env = process.env) => truthy(env.OPENTTD_AGENT_NO_DAEMON);

/** Command names from OPENTTD_AGENT_TOOLS (dashes or underscores), or null for all. */
export function toolsFromEnv(env = process.env) {
  const list = String(env.OPENTTD_AGENT_TOOLS ?? '').split(',').map((n) => n.trim().replaceAll('_', '-')).filter(Boolean);
  return list.length ? list : null;
}

/** Background jobs a session holds that end with its process. */
function backgroundJobs(s) {
  if (!s) return [];
  const jobs = [];
  if (s.pendingSales?.size) jobs.push(`${s.pendingSales.size} pending sale(s)`);
  if (s.pendingWagons?.size) jobs.push(`${s.pendingWagons.size} pending wagon attach(es)`);
  if (s._autoSave) jobs.push('a periodic save');
  return jobs;
}

async function runLocal(ctx, name, args, { readOnly, oneShot }) {
  const own = !ctx;
  const c = ctx ?? makeContext();
  try {
    if (!own) c.refreshConfig();
    const result = await executeCommand(c, name, args, { readOnly });
    const jobs = oneShot ? backgroundJobs(c.peekSession?.()) : [];
    const warnings = jobs.length
      ? [`background_job_not_kept: ${jobs.join(', ')} ran in this one-shot process and stop when it exits; they are saved in the jobs file and resume only when a daemon or MCP server connects to this game again. Run without --no-daemon (the background daemon keeps them running)`]
      : [];
    return { result, warnings };
  } finally { if (own) c.close(); }
}

/**
 * Run `name` with raw args (command args plus the reserved output args). opts:
 *   noDaemon  never use the daemon;  readOnly  L12 gate;  tools  allowed names (null = all);
 *   ctx       a long-lived context for in-process runs (MCP, batch --no-daemon), else a fresh one;
 *   oneShot   this process exits after the call (CLI), so warn about background jobs.
 * Returns { result, compact } (compact: the caller's per-call choice, or undefined). Throws on
 * bad arguments, unknown commands and daemon failures (the surface turns them into errorResult).
 */
export async function dispatch(name, rawArgs = {}, { noDaemon = false, readOnly = false, tools = null, ctx = null, oneShot = true } = {}) {
  const cmd = COMMANDS_BY_NAME.get(name);
  if (!cmd) throw new Error(`unknown_command: unknown command '${name}'. Run: openttd-agent help`);
  if (tools && !tools.includes(name)) throw new Error(`unknown_command: '${name}' is not enabled here (OPENTTD_AGENT_TOOLS / mcp --tools: ${tools.join(', ')})`);
  const { args, output } = takeOutputArgs(rawArgs, Object.keys(cmd.args.shape ?? {}));
  const cfg = ctx ? (ctx.refreshConfig(), ctx.cfg) : loadConfig();
  const warnings = [];
  let result;
  let local = !cmd.session || noDaemon || Boolean(cfg.relay) || Boolean(cfg.profile);
  if (!local) {
    const d = await ensureDaemon(cfg.daemon_port, cfg);
    if (!d.usable) {
      local = true;
      warnings.push(`daemon_config_mismatch: the background daemon on port ${cfg.daemon_port} runs with other settings (env such as OPENTTD_AGENT_COMPANY, HOST, ADMIN_PORT or the password differ), so this call ran in this process. Set OPENTTD_AGENT_DAEMON_PORT to give these settings their own daemon`);
    }
  }
  if (local) {
    const r = await runLocal(ctx, name, args, { readOnly, oneShot });
    result = r.result;
    warnings.push(...r.warnings);
  } else {
    try {
      result = await callDaemon(cfg.daemon_port, name, args, { readOnly });
    } catch (e) {
      // D1: a daemon that does not know a command we know runs older code; restart it once.
      if (!/^unknown_command:|unknown command '/.test(e.message)) throw e;
      log.info('dispatch', 'daemon does not know the command; restarting it', { name });
      await restartDaemon(cfg.daemon_port, cfg);
      result = await callDaemon(cfg.daemon_port, name, args, { readOnly });
    }
  }
  const shaped = shapeResult(result, output);
  if (warnings.length && shaped && typeof shaped === 'object' && !output.brief) shaped.warnings = [...(shaped.warnings ?? []), ...warnings];
  return { result: shaped, compact: output.compact };
}
