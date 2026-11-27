// tools/version-matrix.mjs pure parts: CDN index and manifest parsing, the results table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseIndex, parseManifest, markdownTable } from '../tools/version-matrix.mjs';

test('parseReleaseIndex keeps stable 14.x and 15.x releases, sorted', () => {
  const html = '<a href="16.0-RC1/">x</a><a href="15.3/">x</a><a href="15.0-RC4/">x</a><a href="14.1/">x</a><a href="14.0/">x</a><a href="15.10/">x</a><a href="13.4/">x</a><a href="15.2/">x</a>';
  assert.deepEqual(parseReleaseIndex(html), ['14.0', '14.1', '15.2', '15.3', '15.10']);
});

test('parseManifest reads id, size and sha256 per file', () => {
  const text = 'name: stable\nfiles:\n- id: openttd-15.3-macos-universal.zip\n  size: 15540074\n  md5sum: ea2d\n  sha256sum: ' + 'c'.repeat(64) + '\n- id: other.tar.xz\n  size: 1\n';
  assert.deepEqual(parseManifest(text), [{ id: 'openttd-15.3-macos-universal.zip', size: 15540074, sha256: 'c'.repeat(64) }, { id: 'other.tar.xz', size: 1 }]);
});

test('markdownTable: one row per version, failures carry their error', () => {
  const t = markdownTable([{ version: '15.3', verified: true, detected: '15.3', server_version: '15.3', bridge_version: 14, steps: [{ step: 'launch', ok: true }, { step: 'save', ok: false, error: 'save_timeout' }] }]);
  assert.match(t, /\| 15\.3 \| verified \| 15\.3 \| 15\.3 \| v14 \| - \| ok \|/);
  assert.match(t, /FAIL save_timeout/);
});
