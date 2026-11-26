// MCP server (stdio). Registry commands become tools; names use underscores
// (find-cargo-pairs -> find_cargo_pairs). Runs its own in-process session,
// independent of the CLI daemon.
//
// Options (CLI: `mcp --tools a,b --compact true`): `tools` limits the server to
// those commands (small models do better with a few tight tools, and every tool
// schema costs prompt tokens on each request); `compact` returns results as
// single-line JSON instead of indented JSON.

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { COMMANDS, runCommand } from './commands.js';
import { makeContext } from './context.js';
import { log } from './log.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = `openttd-agent: read an OpenTTD world and build for your company.
Not connected yet, or no company? Run guide first and follow its next step (read-only, no secrets).
Start with doctor, then status. Analysis tools (towns, industries, find_cargo_pairs, town_gaps,
route_effort, airport_sites, companies) are read-only. Build tools act as your configured company
and are rate limited. Coordinates are tile x,y. The CLI exposes the same commands for scripting:
\`openttd-agent <command> --arg value\` prints JSON.`;
const SHORT_INSTRUCTIONS = 'openttd-agent: OpenTTD tools for your company. JSON results; coordinates are tile x,y. Builds take dry_run=true to check the cost first. Not connected or no company: run guide (if served) or `openttd-agent guide`.';

const toolName = (command) => command.replaceAll('-', '_');

// Commands to expose. names: undefined/empty = all; otherwise command names
// (dashes or underscores). Unknown names throw.
export function selectTools(names, commands = COMMANDS) {
  const wanted = (names ?? []).map((n) => n.trim().replaceAll('_', '-')).filter(Boolean);
  if (!wanted.length) return commands;
  const unknown = wanted.filter((n) => !commands.some((c) => c.name === n));
  if (unknown.length) throw new Error(`mcp --tools: unknown command(s) ${unknown.join(', ')}. Run: openttd-agent help`);
  return commands.filter((c) => wanted.includes(c.name));
}

export async function startMcp({ tools, compact = false } = {}) {
  const selected = selectTools(tools);
  const ctx = makeContext();
  const instructions = selected.length === COMMANDS.length ? INSTRUCTIONS : SHORT_INSTRUCTIONS;
  const server = new McpServer({ name: 'openttd-agent', version: VERSION }, { instructions });
  for (const cmd of selected) {
    server.registerTool(toolName(cmd.name), { description: `[${cmd.group}] ${cmd.description}`, inputSchema: cmd.args },
      async (args) => {
        const started = Date.now();
        try {
          ctx.refreshConfig();
          const result = await runCommand(ctx, cmd.name, args);
          log.info('mcp', 'tool', { name: cmd.name, ms: Date.now() - started });
          return { content: [{ type: 'text', text: compact ? JSON.stringify(result) : JSON.stringify(result, null, 1) }] };
        } catch (e) {
          log.warn('mcp', 'tool failed', { name: cmd.name, error: e.message });
          return { content: [{ type: 'text', text: e.message }], isError: true };
        }
      });
  }
  await server.connect(new StdioServerTransport());
  log.info('mcp', 'ready', { tools: selected.length, compact });
}
