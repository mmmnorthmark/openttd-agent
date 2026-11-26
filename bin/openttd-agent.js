#!/usr/bin/env node
// openttd-agent CLI.
//   openttd-agent help                      list commands
//   openttd-agent guide [--role host|player] setup checklist; follow "next"
//   openttd-agent <command> [--key value]   run a command, JSON result on stdout
//   openttd-agent <command> --args '{"k":1}'
//   openttd-agent --profile NAME <command> ...  use ~/.openttd-agent/players/NAME.json (or OPENTTD_AGENT_PROFILE)
//   openttd-agent batch < calls.jsonl        one {"name","args"} per line -> one JSON result per line
//   openttd-agent mcp [--tools a,b] [--compact true]  run as an MCP server (stdio), optionally only some tools
//   openttd-agent daemon | daemon-stop       local background connection (auto-started)
//   openttd-agent relay [--port N] [--bind A] host: serve registered players over the LAN (foreground)
// Exit code 0 on success, 1 on error (error JSON on stdout: {"ok": false, "error": "...", "first_error": "<code>"}).

import readline from 'node:readline';
import { COMMANDS_BY_NAME, describeCommands, runCommand } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { ensureDaemon, callDaemon, startDaemon, stopDaemon } from '../src/daemon.js';
import { makeContext } from '../src/context.js';
import { VERSION } from '../src/version.js';
import { errorResult } from '../src/envelope.js';

function parseFlags(argv) {
  const args = {};
  let noDaemon = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-daemon') { noDaemon = true; continue; }
    if (a === '--args') { Object.assign(args, JSON.parse(argv[++i])); continue; }
    if (!a.startsWith('--')) throw new Error(`unexpected argument '${a}' (use --key value)`);
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replaceAll('-', '_');
    const next = argv[i + 1];
    const value = eq > 0 ? a.slice(eq + 1) : (next === undefined || next.startsWith('--') ? 'true' : (i++, next));
    args[key] = value;
  }
  return { args, noDaemon };
}

async function execute(name, args, noDaemon) {
  const cmd = COMMANDS_BY_NAME.get(name);
  if (!cmd) throw new Error(`unknown command '${name}'. Run: openttd-agent help`);
  // With a relay configured the host's relay is the long-lived process; no local daemon needed.
  // A profile in direct (admin-port) mode may name its own company: run in this process, because the
  // shared daemon runs with the base config.
  const cfg = loadConfig();
  if (!cmd.session || noDaemon || cfg.relay || cfg.profile) {
    const ctx = makeContext();
    try { return await runCommand(ctx, name, args); } finally { ctx.close(); }
  }
  const port = cfg.daemon_port;
  await ensureDaemon(port);
  return callDaemon(port, name, args);
}

function printHelp() {
  const groups = {};
  for (const c of describeCommands()) (groups[c.group] ??= []).push(c);
  const lines = [`openttd-agent ${VERSION}`, '', 'Usage: openttd-agent <command> [--key value ...]   (JSON on stdout)',
    'New here, not connected, or no company yet? Run: openttd-agent guide   and follow "next".', ''];
  for (const [g, cmds] of Object.entries(groups)) {
    lines.push(`${g}:`);
    for (const c of cmds) {
      const props = Object.keys(c.args.properties ?? {});
      lines.push(`  ${c.name}${props.length ? ' [' + props.map((p) => '--' + p).join(' ') + ']' : ''}`);
      lines.push(`      ${c.description}`);
    }
    lines.push('');
  }
  lines.push('Other: commands (JSON schemas), batch (JSONL on stdin), mcp, daemon, daemon-stop, relay [--port N --bind ADDR] (host), version');
  process.stdout.write(lines.join('\n') + '\n');
}

// Built-ins handled in main(), not in the command registry.
const BUILTIN_HELP = {
  mcp: 'mcp [--tools a,b,c] [--compact true]: MCP server on stdio. --tools serves only those commands; --compact returns single-line JSON.',
  daemon: 'daemon: run the local background connection in the foreground (normally auto-started by the first command).',
  'daemon-stop': 'daemon-stop: stop the local background connection. Run it after updating openttd-agent; the next command starts a fresh one.',
  relay: 'relay [--port 47978] [--bind ADDR]: HOST ONLY. The only admin-port client; players connect with tokens (relay-add-player).',
  batch: 'batch: run JSON lines from stdin, one {"name": ..., "args": {...}} per line; one JSON result per line, carries on after a failure and exits 1 if any failed.',
  commands: 'commands: every command with its JSON argument schema.',
  version: 'version: print the package version.',
};

function printCommandHelp(name) {
  if (BUILTIN_HELP[name]) return void process.stdout.write(BUILTIN_HELP[name] + '\n');
  const c = describeCommands().find((x) => x.name === name);
  if (!c) throw new Error(`unknown command '${name}'. Run: openttd-agent help`);
  const props = c.args.properties ?? {};
  const lines = [`${c.name}: ${c.description}`, ''];
  for (const [k, v] of Object.entries(props)) lines.push(`  --${k}  ${v.type ?? ''}${v.enum ? ' (' + v.enum.join('|') + ')' : ''}${v.default !== undefined ? ' default ' + JSON.stringify(v.default) : ''}${v.description ? '  ' + v.description : ''}`);
  process.stdout.write(lines.join('\n') + '\n');
}

/** Remove the global --profile NAME (anywhere on the line) and set OPENTTD_AGENT_PROFILE from it. */
function takeProfile(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') { process.env.OPENTTD_AGENT_PROFILE = argv[++i] ?? ''; continue; }
    if (argv[i].startsWith('--profile=')) { process.env.OPENTTD_AGENT_PROFILE = argv[i].slice('--profile='.length); continue; }
    out.push(argv[i]);
  }
  return out;
}

async function main() {
  const [name, ...rest] = takeProfile(process.argv.slice(2));
  if (!name || name === 'help' || name === '--help' || name === '-h') return printHelp();
  if (name === 'version' || name === '--version') return console.log(VERSION);
  if (rest.includes('--help') || rest.includes('-h')) return printCommandHelp(name);
  if (name === 'commands') return console.log(JSON.stringify(describeCommands(), null, 2));
  if (name === 'mcp') {
    const { args } = parseFlags(rest);
    const { startMcp } = await import('../src/mcp.js');
    return startMcp({ tools: args.tools ? String(args.tools).split(',') : undefined, compact: String(args.compact) === 'true' });
  }
  if (name === 'daemon') return void startDaemon();
  if (name === 'relay') {
    const { args } = parseFlags(rest);
    const { startRelay } = await import('../src/relay.js');
    await startRelay({ ...(args.port ? { port: Number(args.port) } : {}), ...(args.bind ? { bind: args.bind } : {}) });
    return;
  }
  if (name === 'daemon-stop') return console.log(JSON.stringify(await stopDaemon(loadConfig().daemon_port)));
  if (name === 'batch') {
    const rl = readline.createInterface({ input: process.stdin });
    let failed = false;
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const { name: n, args = {} } = JSON.parse(line);
        console.log(JSON.stringify({ name: n, result: await execute(n, args, false) }));
      } catch (e) { failed = true; console.log(JSON.stringify(errorResult(e.message))); }
    }
    process.exitCode = failed ? 1 : 0;
    return;
  }
  const { args, noDaemon } = parseFlags(rest);
  const result = await execute(name, args, noDaemon);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify(errorResult(e.message)));
  process.exitCode = 1;
});
