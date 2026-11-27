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

test('launch (dry run) writes AgentBridge as the only game script and names the server client', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-agent-launch-'));
  const personal = path.join(home, 'personal');
  fs.mkdirSync(personal);
  fs.writeFileSync(path.join(personal, 'openttd.cfg'), '[game_scripts]\nnone = \n\n[network]\nserver_name = mine\n');
  const env = { OPENTTD_AGENT_HOME: home, OPENTTD_AGENT_LOG: 'error', OPENTTD_EXE: process.execPath, OPENTTD_PERSONAL_DIR: personal };
  const res = await cli(env, 'launch', '--mode', 'dedicated', '--admin_password', 'pw', '--bind', '198.51.100.7', '--dry_run', 'true');
  assert.equal(res.admin_host, 'would be saved as host: 198.51.100.7');
  assert.ok(res.would_write.some((f) => f.endsWith(path.join('dedicated', 'openttd.cfg'))));
  assert.equal(fs.existsSync(path.join(home, 'profiles')), false, 'a dry run writes nothing (S1)');
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false, 'a dry run saves no config');
  // A real launch (the "executable" is node, which exits at once): no wait, so nothing needs to answer.
  const real = await cli(env, 'launch', '--mode', 'dedicated', '--admin_password', 'pw', '--bind', '198.51.100.7', '--wait', 'false', '--game_port', '45679', '--admin_port', '45677');
  assert.equal(real.ok, true);
  assert.equal(real.server, 'dedicated');
  assert.match(real.side_server, /--server dedicated/, 'admin port 45677 is not the configured one');
  const cfg = fs.readFileSync(path.join(home, 'profiles', 'dedicated', 'openttd.cfg'), 'utf8');
  assert.match(cfg, /\[game_scripts\]\nAgentBridge = command_delay_ticks=0,max_builds_per_day=0\n/);
  assert.doesNotMatch(cfg, /^none =/m);
  assert.match(cfg, /server_admin_port = 45677/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'profiles', 'dedicated', 'server.json'), 'utf8')),
    { mode: 'dedicated', game_port: 45679, admin_port: 45677, bind: '198.51.100.7', host: '198.51.100.7' });
  const priv = fs.readFileSync(path.join(home, 'profiles', 'dedicated', 'private.cfg'), 'utf8');
  assert.match(priv, /client_name = openttd-agent server/);
  assert.match(priv, /server_name = openttd-agent game/);
  // A second launch rotates the log.
  fs.writeFileSync(path.join(home, 'profiles', 'dedicated', 'openttd.log'), 'old run\n');
  const again = await cli(env, 'launch', '--server', 'dedicated', '--admin_password', 'pw', '--bind', '198.51.100.7', '--wait', 'false');
  assert.equal(again.admin_port, 45677, '--server reuses the ports it used last time');
  assert.deepEqual(again.log_rotated, ['openttd.log -> openttd.log.1']);
  assert.match(fs.readFileSync(path.join(home, 'profiles', 'dedicated', 'openttd.log.1'), 'utf8'), /^old run\n/, 'the first child may still append to it');
  const doc = await cli(env, 'doctor');
  assert.equal(doc.launch_profile_game_scripts, undefined, 'the rewritten profile is fine');
  fs.mkdirSync(path.join(home, 'profiles', 'old'));
  fs.writeFileSync(path.join(home, 'profiles', 'old', 'openttd.cfg'), '[game_scripts]\nnone = \nAgentBridge = \n');
  const bad = await cli(env, 'doctor');
  assert.deepEqual(bad.launch_profile_game_scripts.map((p) => [p.profile, p.game_scripts]), [['old', ['none', 'AgentBridge']]]);
});
