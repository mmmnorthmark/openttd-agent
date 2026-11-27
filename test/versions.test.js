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
