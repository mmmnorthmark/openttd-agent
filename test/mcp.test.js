// MCP server: tool selection (--tools) and compact results (--compact), over real stdio JSON-RPC
// against the fake admin server.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startFakeServer } from './fake-server.js';
import { selectTools } from '../src/mcp.js';
import { COMMANDS } from '../src/commands.js';

const BIN = path.resolve('bin/openttd-agent.js');
let fake, env;

before(async () => {
  fake = await startFakeServer({ password: 'pw' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-mcp-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'pw', company: 0, tile_refresh_rows_per_sec: 0 }));
  env = { ...process.env, OPENTTD_AGENT_HOME: home, OPENTTD_AGENT_LOG: 'error' };
});
after(() => fake.server.close());

// Start `mcp <flags>`, send JSON-RPC requests in order, return their responses by id.
async function mcpSession(flags, requests) {
  // --no-daemon: never reach a background daemon on the default port from a test.
  const child = spawn(process.execPath, [BIN, 'mcp', '--no-daemon', ...flags], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) { const m = JSON.parse(line); if (m.id !== undefined) replies.set(m.id, m); }
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const wait = async (id) => { for (let t = 0; t < 200 && !replies.has(id); t++) await new Promise((r) => setTimeout(r, 25)); return replies.get(id); };
  send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await wait(0);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (const r of requests) { send({ jsonrpc: '2.0', ...r }); await wait(r.id); }
  child.kill();
  return replies;
}

test('selectTools: all by default, a subset by name (dashes or underscores), unknown names refused', () => {
  assert.equal(selectTools(undefined).length, COMMANDS.length);
  assert.equal(selectTools(['']).length, COMMANDS.length);
  assert.deepEqual(selectTools(['goal-status', 'find_cargo_pairs']).map((c) => c.name).sort(), ['find-cargo-pairs', 'goal-status']);
  assert.throws(() => selectTools(['status', 'nope']), /unknown command\(s\) nope/);
});

test('mcp --tools lists only those tools; --compact returns single-line JSON', async () => {
  const r = await mcpSession(['--tools', 'goal-status,companies', '--compact', 'true'], [
    { id: 1, method: 'tools/list' },
    { id: 2, method: 'tools/call', params: { name: 'companies', arguments: {} } },
  ]);
  assert.deepEqual(r.get(1).result.tools.map((t) => t.name).sort(), ['companies', 'goal_status']);
  const text = r.get(2).result.content[0].text;
  assert.ok(!text.includes('\n'), text);
  assert.equal(JSON.parse(text).companies[0].name, 'Test Transport');
});

test('mcp without --tools lists every command', async () => {
  const r = await mcpSession([], [{ id: 1, method: 'tools/list' }]);
  assert.equal(r.get(1).result.tools.length, COMMANDS.length);
});
