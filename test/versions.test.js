// src/versions.js: OpenTTD version parsing, classes, refusal and host/client comparison.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersionOutput, classifyVersion, versionRefusal, acceptUntested, compareHostClient, compareVersions, TESTED_VERSIONS, installHint, detectInstalledVersion } from '../src/versions.js';

test('parseVersionOutput reads the first line of openttd -h and bare versions', () => {
  assert.equal(parseVersionOutput('OpenTTD 15.3\n\nCommand line options:'), '15.3');
  assert.equal(parseVersionOutput('OpenTTD 16.0-beta1\n'), '16.0-beta1');
  assert.equal(parseVersionOutput('OpenTTD 20261101-master-g1234abcd'), '20261101-master-g1234abcd');
  assert.equal(parseVersionOutput('14.1'), '14.1');
  assert.equal(parseVersionOutput(''), null);
});

test('classifyVersion: tested, older, newer, beta, custom, unknown', () => {
  for (const v of TESTED_VERSIONS) assert.equal(classifyVersion(v).class, 'tested', v);
  assert.equal(classifyVersion('13.4').class, 'older_unsupported');
  assert.equal(classifyVersion('1.11.2').class, 'older_unsupported');
  assert.equal(classifyVersion('15.4').class, 'newer_untested');
  assert.equal(classifyVersion('16.0').class, 'newer_untested');
  assert.equal(classifyVersion('16.0-RC1').class, 'beta');
  assert.equal(classifyVersion('15.0-beta2').class, 'beta');
  assert.equal(classifyVersion('20261101-master-gabc').class, 'custom');
  assert.equal(classifyVersion(null).class, 'unknown');
  assert.match(classifyVersion('16.0').message, /--accept_untested true/);
});

test('versionRefusal: untested needs acceptance; older is always refused', () => {
  assert.equal(versionRefusal(classifyVersion('15.3'), false), null);
  assert.match(versionRefusal(classifyVersion('16.0-RC1'), false, 'the server'), /^untested_openttd_version: the server:/);
  assert.equal(versionRefusal(classifyVersion('16.0-RC1'), true), null);
  assert.match(versionRefusal(classifyVersion('13.4'), true), /^unsupported_openttd_version:/);
  assert.equal(versionRefusal(classifyVersion(undefined), false), null);
});

test('acceptUntested: argument, then config, then env', () => {
  assert.equal(acceptUntested({ arg: true, env: {} }), true);
  assert.equal(acceptUntested({ arg: 'false', cfg: true, env: { OPENTTD_AGENT_ACCEPT_UNTESTED: '1' } }), false);
  assert.equal(acceptUntested({ cfg: true, env: {} }), true);
  assert.equal(acceptUntested({ env: { OPENTTD_AGENT_ACCEPT_UNTESTED: 'yes' } }), true);
  assert.equal(acceptUntested({ env: {} }), false);
});

test('compareVersions and host/client mismatch', () => {
  assert.equal(compareVersions('14.1', '15.0'), -1);
  assert.equal(compareVersions('15.3', '15.3.0'), 0);
  assert.deepEqual(compareHostClient('15.3', '15.3'), { match: true, server: '15.3', client: '15.3' });
  const mm = compareHostClient('15.3', '15.2');
  assert.equal(mm.match, false);
  assert.match(mm.message, /server runs OpenTTD 15\.3, this machine has 15\.2.*cdn\.openttd\.org\/openttd-releases\/15\.3\//);
  assert.equal(compareHostClient(null, '15.3').match, null);
});

test('installHint links the official download page; detection of a missing exe does not throw', () => {
  assert.match(installHint('darwin'), /https:\/\/www\.openttd\.org\/downloads\/openttd-releases\/latest/);
  assert.match(installHint('linux'), /OPENTTD_EXE/);
  assert.equal(detectInstalledVersion(null).version, null);
  assert.equal(detectInstalledVersion('/nonexistent/openttd').version, null);
});

// ---- the server's version from the admin welcome ------------------------------------------------
import { startFakeServer } from './fake-server.js';
import { Session } from '../src/session.js';

async function connectTo(revision, cfgExtra = {}, env = {}) {
  const fake = await startFakeServer({ password: 'pw' });
  fake.state.revision = revision;
  const saved = process.env.OPENTTD_AGENT_ACCEPT_UNTESTED;
  if ('OPENTTD_AGENT_ACCEPT_UNTESTED' in env) process.env.OPENTTD_AGENT_ACCEPT_UNTESTED = env.OPENTTD_AGENT_ACCEPT_UNTESTED; else delete process.env.OPENTTD_AGENT_ACCEPT_UNTESTED;
  const s = new Session({ host: '127.0.0.1', admin_port: fake.port, admin_password: 'pw', company: 0, tile_refresh_rows_per_sec: 0, daemon_port: 1, ...cfgExtra });
  try { await s.connect(); return s.openttd; } finally {
    s.close(); fake.server.close();
    if (saved === undefined) delete process.env.OPENTTD_AGENT_ACCEPT_UNTESTED; else process.env.OPENTTD_AGENT_ACCEPT_UNTESTED = saved;
  }
}

test('session: a tested server version connects; an untested one is refused unless accepted', async () => {
  assert.equal((await connectTo('15.3')).class, 'tested');
  await assert.rejects(connectTo('16.0-RC1'), /^Error: untested_openttd_version: the server at 127\.0\.0\.1:\d+: OpenTTD 16\.0-RC1 is a beta/);
  assert.equal((await connectTo('16.0-RC1', { accept_untested: true })).class, 'beta');
  assert.equal((await connectTo('20261101-master-gabc', {}, { OPENTTD_AGENT_ACCEPT_UNTESTED: '1' })).class, 'custom');
  await assert.rejects(connectTo('13.4', { accept_untested: true }), /unsupported_openttd_version/);
});

// ---- launch refuses an untested installed OpenTTD -------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const BIN = path.resolve('bin/openttd-agent.js');
const cliRaw = (env, ...args) => new Promise((resolve) => execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } }, (_e, stdout) => resolve(JSON.parse(stdout))));

test('launch: an untested installed version is refused (first_error untested_openttd_version) unless --accept_untested', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-ver-'));
  const exe = path.join(dir, 'openttd');
  fs.writeFileSync(exe, '#!/bin/sh\necho "OpenTTD 16.0-beta1"\nexit 0\n', { mode: 0o755 });
  const env = { OPENTTD_AGENT_HOME: path.join(dir, 'home'), OPENTTD_AGENT_LOG: 'error', OPENTTD_EXE: exe, OPENTTD_PERSONAL_DIR: path.join(dir, 'personal'), OPENTTD_AGENT_ACCEPT_UNTESTED: '' };
  const refused = await cliRaw(env, 'launch', '--no-daemon', '--admin_password', 'pw', '--game_port', '45991', '--admin_port', '45992', '--wait', 'false');
  assert.equal(refused.ok, false);
  assert.equal(refused.first_error, 'untested_openttd_version');
  assert.ok(!fs.existsSync(path.join(dir, 'home', 'profiles', 'dedicated', 'openttd.cfg')), 'nothing written');
  const dry = await cliRaw(env, 'launch', '--no-daemon', '--admin_password', 'pw', '--dry_run', 'true');
  assert.equal(dry.openttd.class, 'beta');
  assert.match(dry.openttd.would_refuse, /^untested_openttd_version/);
  const accepted = await cliRaw(env, 'launch', '--no-daemon', '--admin_password', 'pw', '--dry_run', 'true', '--accept_untested', 'true');
  assert.equal(accepted.openttd.would_refuse, undefined);
  const doc = await cliRaw(env, 'doctor', '--no-daemon');
  assert.equal(doc.openttd.version, '16.0-beta1');
  assert.equal(doc.openttd.class, 'beta');
});

test('doctor and launch without OpenTTD: install guidance, no stack trace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-none-'));
  const env = { OPENTTD_AGENT_HOME: path.join(dir, 'home'), OPENTTD_AGENT_LOG: 'error', OPENTTD_EXE: path.join(dir, 'missing-openttd'), OPENTTD_PERSONAL_DIR: path.join(dir, 'personal') };
  const doc = await cliRaw(env, 'doctor', '--no-daemon');
  assert.equal(doc.openttd.class, 'not_installed');
  assert.match(doc.openttd.message, /openttd\.org\/downloads/);
  const launch = await cliRaw(env, 'launch', '--no-daemon', '--admin_password', 'pw', '--wait', 'false');
  assert.equal(launch.first_error, 'openttd_not_found');
  assert.doesNotMatch(launch.error, /at .*\.js:\d+/);
});
