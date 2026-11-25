// MCP server (stdio). Every registry command becomes a tool; names use
// underscores (find-cargo-pairs -> find_cargo_pairs). Runs its own in-process
// session, independent of the CLI daemon.

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { COMMANDS, runCommand } from './commands.js';
import { makeContext } from './context.js';
import { log } from './log.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = `openttd-agent: read an OpenTTD world and build for your company.
Start with doctor, then status. Analysis tools (towns, industries, find_cargo_pairs, town_gaps,
route_effort, airport_sites, companies) are read-only. Build tools act as your configured company
and are rate limited. Coordinates are tile x,y. The CLI exposes the same commands for scripting:
\`openttd-agent <command> --arg value\` prints JSON.`;

export async function startMcp() {
  const ctx = makeContext();
  const server = new McpServer({ name: 'openttd-agent', version: VERSION }, { instructions: INSTRUCTIONS });
  for (const cmd of COMMANDS) {
    server.registerTool(cmd.name.replaceAll('-', '_'), { description: `[${cmd.group}] ${cmd.description}`, inputSchema: cmd.args },
      async (args) => {
        const started = Date.now();
        try {
          ctx.refreshConfig();
          const result = await runCommand(ctx, cmd.name, args);
          log.info('mcp', 'tool', { name: cmd.name, ms: Date.now() - started });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
        } catch (e) {
          log.warn('mcp', 'tool failed', { name: cmd.name, error: e.message });
          return { content: [{ type: 'text', text: e.message }], isError: true };
        }
      });
  }
  await server.connect(new StdioServerTransport());
  log.info('mcp', 'ready', { tools: COMMANDS.length });
}
