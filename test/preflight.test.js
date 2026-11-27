// src/preflight.js and the guide's first-run steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { nodeProblem, basesetsIn, diskWarning, keepAwakeHint, loadProblem, loadProblemText, portHolderText, unzipSingle, installOpenGfx } from '../src/preflight.js';
import { buildGuide, firstRunSteps } from '../src/guide.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('nodeProblem', () => {
  assert.equal(nodeProblem('22.1.0'), null);
  assert.equal(nodeProblem('20.0.0'), null);
  assert.match(nodeProblem('18.19.0'), /^node_too_old: .*Node 20 or newer; this is Node 18\.19\.0.*nodejs\.org/);
});

test('basesetsIn recognises OpenGFX, the original files and other sets', () => {
  assert.deepEqual(basesetsIn(['opengfx-8.0.tar']), ['OpenGFX']);
  assert.deepEqual(basesetsIn(['TRG1R.GRF', 'trgcr.grf', 'trghr.grf', 'trgir.grf', 'trgtr.grf', 'sample.cat']), ['original']);
  assert.deepEqual(basesetsIn(['abase.tar']), ['other']);
  assert.deepEqual(basesetsIn(['readme.txt']), []);
});

test('disk, keep-awake, port holder and load problems', () => {
  assert.equal(diskWarning(10 * 1024 ** 3, 'x'), null);
  assert.match(diskWarning(100 * 1024 ** 2, 'saves'), /^low_disk: only 100 MB free for saves/);
  assert.equal(diskWarning(null, 'x'), null);
  assert.match(keepAwakeHint(42, 'darwin'), /caffeinate -dims -w 42/);
  assert.match(keepAwakeHint(42, 'linux'), /systemd-inhibit/);
  assert.equal(portHolderText(3979, [{ command: 'openttd', pid: 7, address: '*' }]), 'port 3979 (held by openttd pid 7 on *)');
  assert.equal(portHolderText(3979, []), 'port 3979');
  assert.equal(loadProblem('[error] Savegame is made with newer version'), 'save_too_new');
  assert.equal(loadProblem('NewGRF file foo.grf not found'), 'newgrf_missing');
  assert.equal(loadProblem('Map generated'), null);
  assert.match(loadProblemText('save_too_new'), /^save_too_new: /);
});

/** A one-entry zip (deflated) built in memory. */
function zipOf(name, data) {
  const comp = zlib.deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, n, comp]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cen.length + n.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cen, n, end]);
}

test('unzipSingle and installOpenGfx (sha256 checked, nothing written on a mismatch)', async () => {
  const tar = Buffer.from('fake tar content '.repeat(100));
  const zip = zipOf('opengfx-8.0/opengfx-8.0.tar', tar);
  assert.deepEqual(unzipSingle(zip, /\.tar$/), { name: 'opengfx-8.0.tar', data: tar });
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(zip).digest('hex');
  const fake = (manifestSha) => async (url) => (url.endsWith('manifest.yaml')
    ? { ok: true, text: async () => `files:\n- id: opengfx-8.0-all.zip\n  size: ${zip.length}\n  sha256sum: ${manifestSha}\n` }
    : { ok: true, arrayBuffer: async () => zip });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ottd-gfx-'));
  await assert.rejects(installOpenGfx(dir, { fetchImpl: fake('0'.repeat(64)) }), /opengfx_checksum/);
  assert.ok(!fs.existsSync(path.join(dir, 'baseset', 'opengfx-8.0.tar')));
  assert.equal((await installOpenGfx(dir, { dryRun: true })).dry_run, true);
  const r = await installOpenGfx(dir, { fetchImpl: fake(sha) });
  assert.equal(fs.readFileSync(r.installed_to, 'utf8'), tar.toString());
  assert.equal((await installOpenGfx(dir, { fetchImpl: fake(sha) })).already_installed, true);
});

test('guide: first-run steps come right after doctor and stop on what is missing', () => {
  const doctor = { ok: true, openttd_found: true, openttd_version: '15.3', openttd_class: 'tested', node_ok: true, base_graphics: false, opened_once: true, disk_free_mb: 9000, gamescript_installed: 14, gamescript_bundled: 14 };
  const g = buildGuide('host', { config: { admin_password: true }, doctor });
  assert.deepEqual(g.steps.slice(0, 6).map((s) => s.id), ['doctor', 'node', 'openttd-version', 'opened-once', 'base-graphics', 'disk']);
  assert.equal(g.next.id, 'base-graphics');
  assert.equal(g.next.command, 'openttd-agent install-opengfx');
  const beta = buildGuide('player', { config: {}, doctor: { ...doctor, base_graphics: true, openttd_class: 'beta', openttd_message: 'OpenTTD 16.0-RC1 is a beta' } });
  assert.equal(beta.next.id, 'openttd-version');
  assert.match(beta.next.detail, /beta/);
  assert.ok(firstRunSteps({}).every((s) => s.done === null), 'no probe: nothing claimed');
  const unknown = buildGuide(undefined, { config: {}, doctor });
  assert.equal(unknown.steps.filter((s) => s.id === 'node').length, 1);
});
