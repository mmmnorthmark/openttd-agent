#!/usr/bin/env node
// openttd-agent CLI.
//   openttd-agent help [--full]              one line per command (--full: with every flag)
//   openttd-agent <command> --help           one command's flags
//   openttd-agent guide [--role host|player] setup checklist; follow "next"
//   openttd-agent <command> [--key value]   run a command, JSON result on stdout
//   openttd-agent <command> --args '{"k":1}'
//   openttd-agent --profile NAME <command> ...  use ~/.openttd-agent/players/NAME.json (or OPENTTD_AGENT_PROFILE)
//   openttd-agent batch [--no-daemon] < calls.jsonl  one {"name","args"} per line -> one {"name","result"} line each
//   openttd-agent mcp [--tools a,b] [--compact false] [--read_only true] [--no-daemon]  MCP server (stdio)
//   openttd-agent daemon | daemon-stop       local background connection (auto-started)
//   openttd-agent relay [--port N] [--bind A] host: serve registered players over the LAN (foreground)
// Every command also takes --fields a,b.c  --brief true  --compact true|false  --steps all (src/output.js).
// Global flags (before the command): --no-daemon, --compact[=false], --read_only, --profile NAME.
// Env: OPENTTD_AGENT_COMPACT, OPENTTD_AGENT_READ_ONLY, OPENTTD_AGENT_TOOLS, OPENTTD_AGENT_NO_DAEMON.
// Output: one-line JSON when stdout is not a terminal (or --compact true), else indented.
// Exit code 0 when the result has ok: true, else 1 (failures print {"ok": false, "error": ..., "first_error": ...}).

import readline from 'node:readline';
import { COMMANDS_BY_NAME, describeCommands } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { startDaemon, stopDaemon } from '../src/daemon.js';
import { makeContext } from '../src/context.js';
import { dispatch, noDaemonFromEnv, toolsFromEnv } from '../src/dispatch.js';
import { formatResult, compactDefault } from '../src/output.js';
import { readOnlyFromEnv } from '../src/readonly.js';
import { VERSION } from '../src/version.js';
import { errorResult } from '../src/envelope.js';

/**
 * --key value / --key=value / --flag (= 'true') / --args JSON. A bare word after a value joins it
 * with a space (L13: `--town New Bigton` is the town "New Bigton").
 */
function parseFlags(argv) {
  const args = {};
  let noDaemon = false;
  let last = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-daemon') { noDaemon = true; last = null; continue; }
    if (a === '--args') { Object.assign(args, JSON.parse(argv[++i])); last = null; continue; }
    if (!a.startsWith('--')) {
      if (last !== null && typeof args[last] === 'string') { args[last] += ` ${a}`; continue; }
      throw new Error(`bad_arguments: unexpected argument '${a}' (use --key value)`);
    }
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replaceAll('-', '_');
    const next = argv[i + 1];
    const bare = eq < 0 && (next === undefined || next.startsWith('--'));
    args[key] = eq > 0 ? a.slice(eq + 1) : bare ? 'true' : (i++, next);
    last = bare ? null : key; // a bare --flag takes no more words
  }
  return { args, noDaemon };
}

/** Commands this CLI serves: all, or OPENTTD_AGENT_TOOLS. */
function visibleCommands() {
  const tools = toolsFromEnv();
  return describeCommands().filter((c) => !tools || tools.includes(c.name));
}

const firstSentence = (text) => {
  const m = /^(.+?[.!?])(?=\s+[A-Z]|$)/.exec(text); // "e.g. the" is not a sentence end
  const s = m ? m[1] : text;
  return s.length > 110 ? `${s.slice(0, 107)}...` : s;
};

const BUILTINS_LINE = 'CLI only: help [--full], <command> --help, commands (JSON schemas), batch (JSONL on stdin), mcp, daemon, daemon-stop, relay [--port N --bind ADDR] (host), version. --no-daemon runs a call in this process.';
const OUTPUT_LINE = 'Every command: --fields a,b.c (keep only these; item fields apply to lists)  --brief true (ok, cost, money, ids)  --compact true|false  --steps all (exec: every step, not only failed ones).';

function printHelp(full) {
  const groups = {};
  for (const c of visibleCommands()) (groups[c.group] ??= []).push(c);
  const lines = [`openttd-agent ${VERSION}: openttd-agent <command> [--key value ...]  (JSON on stdout; <command> --help for its flags)`,
    'New here, not connected, or no company yet? Run: openttd-agent guide   and follow "next".'];
  for (const [g, cmds] of Object.entries(groups)) {
    if (!full) {
      lines.push(`${g}:`);
      for (const c of cmds) lines.push(`  ${c.name}: ${firstSentence(c.description)}`);
      continue;
    }
    lines.push('', `${g}:`);
    for (const c of cmds) {
      const props = Object.keys(c.args.properties ?? {});
      lines.push(`  ${c.name}${props.length ? ' [' + props.map((p) => '--' + p).join(' ') + ']' : ''}`);
      lines.push(`      ${c.description}`);
    }
  }
  lines.push(OUTPUT_LINE, BUILTINS_LINE);
  process.stdout.write(lines.join('\n') + '\n');
}

// Built-ins handled in main(), not in the command registry.
const BUILTIN_HELP = {
  help: 'help [--full]: one line per command; --full adds every flag and the whole description. <command> --help shows one command.',
  mcp: 'mcp [--tools a,b,c] [--compact false] [--read_only true] [--no-daemon]: MCP server on stdio. --tools (or OPENTTD_AGENT_TOOLS) serves only those commands; results are one-line JSON unless --compact false; --read_only forces dry runs and refuses other actions; game calls share the background daemon unless --no-daemon.',
  daemon: 'daemon: run the local background connection in the foreground (normally auto-started by the first command; restarted automatically when the code changes).',
  'daemon-stop': 'daemon-stop: stop the local background connection (its background jobs end). The next command starts a fresh one.',
  relay: 'relay [--port 47978] [--bind ADDR]: HOST ONLY. The only admin-port client; players connect with tokens (relay-add-player).',
  batch: 'batch [--no-daemon]: run JSON lines from stdin, one {"name": ..., "args": {...}} per line; prints one {"name", "result"} line each (result.ok false = failed), carries on after a failure and exits 1 if any failed.',
  commands: 'commands: every command with its JSON argument schema (the same schemas MCP tools/list shows).',
  version: 'version: print the package version.',
};

function printCommandHelp(name) {
  if (BUILTIN_HELP[name]) return void process.stdout.write(BUILTIN_HELP[name] + '\n');
  const c = visibleCommands().find((x) => x.name === name);
  if (!c) throw new Error(`unknown_command: unknown command '${name}'. Run: openttd-agent help`);
  const props = c.args.properties ?? {};
  const required = new Set(c.args.required ?? []);
  const lines = [`${c.name}: ${c.description}`, ''];
  for (const [k, v] of Object.entries(props)) lines.push(`  --${k}  ${v.type ?? ''}${required.has(k) ? ' required' : ''}${v.enum ? ' (' + v.enum.join('|') + ')' : ''}${v.default !== undefined ? ' default ' + JSON.stringify(v.default) : ''}${v.description ? '  ' + v.description : ''}`);
  lines.push('', OUTPUT_LINE);
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * Global flags: --profile NAME anywhere on the line (sets OPENTTD_AGENT_PROFILE); before the
 * command: --no-daemon, --compact[=true|false], --read_only. Returns { argv, noDaemon }.
 */
function takeGlobals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') { process.env.OPENTTD_AGENT_PROFILE = argv[++i] ?? ''; continue; }
    if (argv[i].startsWith('--profile=')) { process.env.OPENTTD_AGENT_PROFILE = argv[i].slice('--profile='.length); continue; }
    out.push(argv[i]);
  }
  let noDaemon = false;
  while (out.length && out[0].startsWith('--') && !['--help', '--version'].includes(out[0])) {
    const flag = out.shift();
    const [key, val] = flag.slice(2).replaceAll('-', '_').split('=');
    if (key === 'no_daemon') noDaemon = true;
    else if (key === 'compact') process.env.OPENTTD_AGENT_COMPACT = val ?? 'true';
    else if (key === 'read_only') process.env.OPENTTD_AGENT_READ_ONLY = val ?? 'true';
    else throw new Error(`bad_arguments: unknown global flag '${flag}' (global flags: --profile NAME, --no-daemon, --compact, --read_only; command flags go after the command)`);
  }
  return { argv: out, noDaemon };
}

/** Print one result and set the exit code from result.ok (P8). */
function emit(result, compact) {
  console.log(formatResult(result, compact ?? compactDefault()));
  if (!result || result.ok !== true) process.exitCode = 1;
}

async function runBatch(noDaemon) {
  const rl = readline.createInterface({ input: process.stdin });
  const ctx = noDaemon ? makeContext() : null; // one connection for the whole batch
  const opts = { noDaemon, readOnly: readOnlyFromEnv(), tools: toolsFromEnv(), ctx, oneShot: true };
  let failed = false;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let name = null, result;
      try {
        const call = JSON.parse(line);
        name = call.name ?? null;
        ({ result } = await dispatch(name, call.args ?? {}, opts));
      } catch (e) { result = errorResult(e.message); }
      if (!result || result.ok !== true) failed = true;
      console.log(JSON.stringify({ name, result }));
    }
  } finally { ctx?.close(); }
  process.exitCode = failed ? 1 : 0;
}

async function main() {
  const { argv, noDaemon: globalNoDaemon } = takeGlobals(process.argv.slice(2));
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    if (rest[0] && !rest[0].startsWith('--')) return printCommandHelp(rest[0]);
    return printHelp(rest.includes('--full'));
  }
  if (name === 'version' || name === '--version') return console.log(VERSION);
  if (rest.includes('--help') || rest.includes('-h')) return printCommandHelp(name);
  if (name === 'commands') return console.log(JSON.stringify(visibleCommands(), null, 2));
  if (name === 'mcp') {
    const { args, noDaemon } = parseFlags(rest);
    const { startMcp } = await import('../src/mcp.js');
    return startMcp({
      tools: args.tools ? String(args.tools).split(',') : toolsFromEnv() ?? undefined,
      compact: args.compact === undefined ? true : String(args.compact) === 'true',
      readOnly: args.read_only === undefined ? readOnlyFromEnv() : String(args.read_only) === 'true',
      noDaemon: noDaemon || globalNoDaemon || noDaemonFromEnv(),
    });
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
    const { noDaemon } = parseFlags(rest);
    return runBatch(noDaemon || globalNoDaemon || noDaemonFromEnv());
  }
  if (!COMMANDS_BY_NAME.has(name)) throw new Error(`unknown_command: unknown command '${name}'. Run: openttd-agent help`);
  const { args, noDaemon } = parseFlags(rest);
  const { result, compact } = await dispatch(name, args, {
    noDaemon: noDaemon || globalNoDaemon || noDaemonFromEnv(), readOnly: readOnlyFromEnv(), tools: toolsFromEnv(), oneShot: true,
  });
  emit(result, compact);
}

main().catch((e) => emit(errorResult(e.message)));
