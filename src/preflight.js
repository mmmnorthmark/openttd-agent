// First-run and "will this work here?" checks (0.8.0 batch 8): Node version, base graphics,
// OpenTTD opened once, free disk space, keeping the host awake, who holds a port, and the
// server's message for a save from a newer OpenTTD. Pure helpers are unit-tested
// (test/preflight.test.js); the probes are read-only.
// The CLI's Node check runs from src/node-check.js (imported first by bin/openttd-agent.js).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const MIN_NODE_MAJOR = 20;
export const LOW_DISK_BYTES = 500 * 1024 * 1024; // a 1024x1024 save is ~10-30 MB; leave room for autosaves
export const OPENGFX_VERSION = '8.0';
const CDN = 'https://cdn.openttd.org';

/** -> null when fine, else the message. */
export function nodeProblem(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  return major >= MIN_NODE_MAJOR ? null
    : `node_too_old: openttd-agent needs Node ${MIN_NODE_MAJOR} or newer; this is Node ${version}. Install the current LTS from https://nodejs.org/ (or with nvm: nvm install --lts), then run the command again`;
}

/** Base graphics sets present in a baseset folder listing (lower-case names). */
export function basesetsIn(files) {
  const f = files.map((x) => x.toLowerCase());
  const sets = [];
  if (f.some((x) => /^opengfx.*\.(tar|obg)$/.test(x) || x === 'opengfx')) sets.push('OpenGFX');
  if (['trg1r.grf', 'trgcr.grf', 'trghr.grf', 'trgir.grf', 'trgtr.grf'].every((x) => f.includes(x)) || ['trg1.grf', 'trgc.grf', 'trgh.grf', 'trgi.grf', 'trgt.grf'].every((x) => f.includes(x))) sets.push('original');
  if (f.some((x) => /\.(tar|obg)$/.test(x) && !/^opengfx/.test(x))) sets.push('other');
  return sets;
}

/** Folders OpenTTD searches for base sets under one personal dir (plus content_download). */
export function basesetDirs(personalDir) {
  return [path.join(personalDir, 'baseset'), path.join(personalDir, 'content_download', 'baseset')];
}

/** Sets found under the personal dir (and next to the executable, where official builds ship none). */
export function findBasesets(personalDir) {
  const files = [];
  for (const d of basesetDirs(personalDir)) {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        files.push(e.name);
        if (e.isDirectory()) { try { files.push(...fs.readdirSync(path.join(d, e.name))); } catch { /* unreadable */ } }
      }
    } catch { /* missing */ }
  }
  return basesetsIn(files);
}

/** Free bytes on the filesystem holding `dir` (its nearest existing parent), or null. */
export function freeBytes(dir) {
  let d = dir;
  while (d && !fs.existsSync(d)) { const up = path.dirname(d); if (up === d) break; d = up; }
  try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch { return null; }
}

/** -> null or a warning when `bytes` is below LOW_DISK_BYTES. */
export function diskWarning(bytes, where) {
  if (bytes === null || bytes === undefined || bytes >= LOW_DISK_BYTES) return null;
  return `low_disk: only ${Math.round(bytes / 1024 / 1024)} MB free for ${where}; saves and autosaves may fail. Free some space`;
}

/** How to keep the host awake while the server (pid) runs, per platform. */
export function keepAwakeHint(pid, platform = process.platform) {
  if (platform === 'darwin') return `a sleeping Mac drops every player: keep it awake while the server runs with: caffeinate -dims -w ${pid ?? '<server pid>'} &`;
  if (platform === 'linux') return `keep the host awake while the server runs, e.g.: systemd-inhibit --what=sleep:idle --why=openttd tail --pid=${pid ?? '<server pid>'} -f /dev/null &`;
  if (platform === 'win32') return 'keep the host awake while the server runs: Settings > System > Power > Sleep: Never (set it back after)';
  return null;
}

/** Pure: does a console/log text say the save is from a newer OpenTTD (or needs a missing NewGRF)? -> code or null. */
export function loadProblem(text) {
  const s = String(text ?? '');
  if (/newer version|savegame is made with a newer|version too new|too new/i.test(s)) return 'save_too_new';
  if (/NewGRF.*(not found|missing)|missing NewGRF|GRF.*not available/i.test(s)) return 'newgrf_missing';
  return null;
}

/** Pure: human text for loadProblem codes. */
export function loadProblemText(code) {
  return {
    save_too_new: 'save_too_new: this save was made by a newer OpenTTD than the server runs; load it with that version (every player then needs it too), or pick another save',
    newgrf_missing: 'newgrf_missing: the save uses NewGRFs the server does not have; get them through OpenTTD\'s online content (BaNaNaS) on the host, then load again',
  }[code] ?? null;
}

/** Pure: name the holder of a busy port from listener rows. */
export function portHolderText(port, rows) {
  if (!rows || !rows.length) return `port ${port}`;
  return `port ${port} (held by ${rows.map((r) => `${r.command ?? 'a process'}${r.pid ? ` pid ${r.pid}` : ''} on ${r.address}`).join(', ')})`;
}

// ---- OpenGFX (free base graphics) -------------------------------------------------------------

/**
 * Download OpenGFX from the official CDN into <personalDir>/baseset, checking the sha256 of the
 * release manifest. dryRun: only say what it would do. Returns { installed_to, version, sha256 }.
 */
export async function installOpenGfx(personalDir, { dryRun = false, fetchImpl = fetch } = {}) {
  const name = `opengfx-${OPENGFX_VERSION}-all.zip`;
  const url = `${CDN}/opengfx-releases/${OPENGFX_VERSION}/${name}`;
  const dest = path.join(personalDir, 'baseset');
  const have = findBasesets(personalDir);
  if (have.includes('OpenGFX')) return { already_installed: true, baseset_dir: dest, sets: have };
  if (dryRun) return { dry_run: true, would_download: url, would_install_to: dest, sets_now: have };
  const manifest = await (await fetchImpl(`${CDN}/opengfx-releases/${OPENGFX_VERSION}/manifest.yaml`)).text();
  const sha256 = new RegExp(`- id: ${name.replace(/\./g, '\\.')}[\\s\\S]*?sha256sum:\\s*([0-9a-f]{64})`).exec(manifest)?.[1];
  if (!sha256) throw new Error(`opengfx_manifest: no checksum for ${name} in the release manifest`);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`opengfx_download: GET ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== sha256) throw new Error(`opengfx_checksum: ${name} sha256 ${got} does not match the manifest (${sha256}); nothing installed`);
  const tar = unzipSingle(buf, /\.tar$/i);
  fs.mkdirSync(dest, { recursive: true });
  const file = path.join(dest, tar.name);
  fs.writeFileSync(file, tar.data);
  return { installed_to: file, version: OPENGFX_VERSION, sha256, bytes: tar.data.length };
}

/** Minimal ZIP reader: the first entry matching `re` (stored or deflated). */
export function unzipSingle(buf, re) {
  // End of central directory: last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('opengfx_zip: not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('opengfx_zip: bad central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!re.test(name)) continue;
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    const base = path.basename(name);
    if (!/^[A-Za-z0-9._-]+$/.test(base)) throw new Error(`opengfx_zip: unexpected entry name '${name}'`);
    if (method === 0) return { name: base, data: Buffer.from(raw) };
    if (method === 8) return { name: base, data: zlibInflate(raw) };
    throw new Error(`opengfx_zip: unsupported compression ${method}`);
  }
  throw new Error('opengfx_zip: no matching entry');
}

const zlibInflate = (raw) => inflateRawSync(raw);
