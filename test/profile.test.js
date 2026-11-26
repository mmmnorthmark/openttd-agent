// Player profiles: --profile NAME / OPENTTD_AGENT_PROFILE / OPENTTD_AGENT_PLAYER_FILE (CLI, separate processes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BIN = path.resolve('bin/openttd-agent.js');
const cli = async (env, ...args) => JSON.parse((await run(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } })).stdout);

test('--profile keeps a relay token per player; the base config is untouched', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-agent-prof-'));
  const env = { OPENTTD_AGENT_HOME: home, OPENTTD_AGENT_LOG: 'error' };
  const saved = await cli(env, '--profile', 'alice', 'configure', '--relay', 'http://127.0.0.1:9/', '--token', 'tok-a');
  assert.equal(saved.relay, 'http://127.0.0.1:9');
  assert.equal(saved.relay_token, '***');
  assert.equal(saved.profile, 'alice');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'players', 'alice.json'), 'utf8')).relay_token, 'tok-a');
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false, 'base config not written');
  assert.equal((await cli({ ...env, OPENTTD_AGENT_PROFILE: 'alice' }, 'show-config')).relay, 'http://127.0.0.1:9');
  assert.equal((await cli(env, 'show-config')).relay, '');
  const file = path.join(home, 'bob.player.json');
  fs.writeFileSync(file, JSON.stringify({ relay: 'http://127.0.0.1:8', token: 'tok-b', note: 'ignored' }));
  const bob = await cli({ ...env, OPENTTD_AGENT_PLAYER_FILE: file }, 'show-config');
  assert.deepEqual([bob.relay, bob.relay_token, bob.profile], ['http://127.0.0.1:8', '***', 'bob.player']);
  await assert.rejects(cli(env, '--profile', '../x', 'show-config'), (e) => /profile name must be/.test(JSON.parse(e.stdout).error));
});
