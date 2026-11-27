// MCP server (stdio). Registry commands become tools; names use underscores
// (find-cargo-pairs -> find_cargo_pairs). Calls go through dispatch() like the CLI, so game
// commands share the background daemon (its connection, map mirror and background jobs) unless
// noDaemon; results are the same objects the CLI prints (test/parity.test.js).
//
// The SDK validates tool arguments against inputSchema before our handler and strips keys it does
// not know (a stray `help` once advanced the game 41 days). Each tool therefore gets a
// pass-through Standard Schema: tools/list shows the command's JSON schema (io: 'input', the same
// as `commands`), and runCommand's validation (unknown keys refused, aliases, repairs) is the only one.
//
// Options (CLI: `mcp --tools a,b --compact false --read_only true --no-daemon`): `tools` limits
// the server to those commands (each tool schema costs prompt tokens on every request);
// `compact` (default true) returns one-line JSON; `readOnly` forces dry runs and refuses other
// actions. A relay player is not served the host-only tools.

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { COMMANDS, argsJsonSchema } from './commands.js';
import { makeContext } from './context.js';
import { dispatch } from './dispatch.js';
import { formatResult } from './output.js';
import { log } from './log.js';
import { VERSION } from './version.js';
import { errorResult } from './envelope.js';

const OUTPUT_NOTE = 'Every tool also takes fields ("a,b.c": keep only these; item fields apply to lists), brief (true: ok, cost, money, ids), compact (false: indented JSON) and steps ("all": every exec step, not only failed ones). Unknown arguments are refused and nothing runs. A result with ok:false is an error.';
const INSTRUCTIONS = `openttd-agent: read an OpenTTD world and build for your company.
Not connected yet, or no company? Run guide first and follow its next step (read-only, no secrets).
Start with doctor, then status. Analysis tools (towns, industries, find_cargo_pairs, town_gaps,
route_effort, airport_sites, companies) are read-only. Build tools act as your configured company
and are rate limited; dry_run=true checks the cost first. Coordinates are tile x,y.
${OUTPUT_NOTE}
The CLI exposes the same commands for scripting: \`openttd-agent <command> --arg value\` prints JSON.`;
const SHORT_INSTRUCTIONS = `openttd-agent: OpenTTD tools for your company. JSON results; coordinates are tile x,y. Builds take dry_run=true to check the cost first. Not connected or no company: run guide (if served) or \`openttd-agent guide\`. ${OUTPUT_NOTE}`;
const READ_ONLY_NOTE = '\nThis server is read-only: builds run as dry runs (forced_dry_run: true) and other actions are refused (first_error: read_only).';

const toolName = (command) => command.replaceAll('-', '_');

// Host-only for a relay player (P15): the relay refuses these, so do not spend prompt tokens on them.
const HOST_ONLY_GROUPS = new Set(['host', 'relay']);
const HOST_ONLY_SETUP = new Set(['launch', 'install-gamescript', 'scenario-prepare']);
export const playerTools = (commands) => commands.filter((c) => !HOST_ONLY_GROUPS.has(c.group) && !HOST_ONLY_SETUP.has(c.name));

// Commands to expose. names: undefined/empty = all; otherwise command names
// (dashes or underscores). Unknown names throw.
export function selectTools(names, commands = COMMANDS) {
  const wanted = (names ?? []).map((n) => n.trim().replaceAll('_', '-')).filter(Boolean);
  if (!wanted.length) return commands;
  const unknown = wanted.filter((n) => !commands.some((c) => c.name === n));
  if (unknown.length) throw new Error(`mcp --tools: unknown command(s) ${unknown.join(', ')}. Run: openttd-agent help`);
  return commands.filter((c) => wanted.includes(c.name));
}

/** Standard Schema that accepts anything (runCommand validates) and shows `cmd`'s JSON schema. */
export function passThroughSchema(cmd) {
  const json = () => argsJsonSchema(cmd);
  return { '~standard': { version: 1, vendor: 'openttd-agent', validate: (v) => ({ value: v ?? {} }), jsonSchema: { input: json, output: json } } };
}

export async function startMcp({ tools, compact = true, readOnly = false, noDaemon = false } = {}) {
  const ctx = makeContext();
  let selected = selectTools(tools);
  if (ctx.cfg.relay && !tools) selected = playerTools(selected);
  const base = selected.length === COMMANDS.length ? INSTRUCTIONS : SHORT_INSTRUCTIONS;
  const server = new McpServer({ name: 'openttd-agent', version: VERSION }, { instructions: base + (readOnly ? READ_ONLY_NOTE : '') });
  for (const cmd of selected) {
    server.registerTool(toolName(cmd.name), { description: `[${cmd.group}] ${cmd.description}`, inputSchema: passThroughSchema(cmd) },
      async (args) => {
        const started = Date.now();
        let result, perCall;
        try {
          ({ result, compact: perCall } = await dispatch(cmd.name, args ?? {}, { noDaemon, readOnly, ctx, oneShot: false }));
          log.info('mcp', 'tool', { name: cmd.name, ms: Date.now() - started, ok: result?.ok });
        } catch (e) {
          log.warn('mcp', 'tool failed', { name: cmd.name, error: e.message });
          result = errorResult(e.message);
        }
        return { content: [{ type: 'text', text: formatResult(result, perCall ?? compact) }], ...(result?.ok === true ? {} : { isError: true }) };
      });
  }
  await server.connect(new StdioServerTransport());
  log.info('mcp', 'ready', { tools: selected.length, compact, readOnly, noDaemon });
}
