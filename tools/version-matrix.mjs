#!/usr/bin/env node
// Version matrix: download official OpenTTD releases, verify their sha256 from the release
// manifest, and run a smoke suite of openttd-agent commands against each one in a sandbox.
//
//   node tools/version-matrix.mjs [--versions 14.0,15.3] [--platform macos|linux] [--base_port 4100]
//                                 [--download_only true] [--out docs/version-matrix.json]
//
// Default versions: every 14.x and 15.x release (no betas/RCs) listed on cdn.openttd.org.
// Cache: ~/.cache/openttd-agent/versions/<v>/ (archives + unpacked build), OpenGFX in
//        ~/.cache/openttd-agent/opengfx/. Sandboxes: ~/.cache/openttd-agent/sandboxes/<v>-<time>/.
//
// Sandbox per version (nothing outside it is read or written by OpenTTD or openttd-agent):
//   HOME=<sandbox>/home (so ~/Documents/OpenTTD and ~/.local/share/openttd resolve inside it),
//   XDG_DATA_HOME / XDG_CONFIG_HOME inside it, OPENTTD_AGENT_HOME=<sandbox>/agent,
//   OPENTTD_EXE=<the downloaded build>, its own game/admin ports (base_port + 10*i),
//   OpenGFX copied into the sandbox baseset folder, --no-daemon for every call.
// Every server started here is stopped with server-stop (by its own profile cfg path only) and,
// if still running, SIGTERM to the pids of exactly that cfg path. No other OpenTTD is touched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'openttd-agent.js');
const CDN = 'https://cdn.openttd.org';
const CACHE = process.env.OPENTTD_AGENT_MATRIX_CACHE ?? path.join(os.homedir(), '.cache', 'openttd-agent');
const OPENGFX_VERSION = '8.0';

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

const log = (...a) => console.error(`[matrix ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
  return r.text();
}

/** Release folders on the CDN index -> ['14.0', '14.1', '15.0', ...] (stable 14.x/15.x only). */
export function parseReleaseIndex(html, majors = [14, 15]) {
  const names = [...String(html).matchAll(/href="(\d+\.\d+(?:\.\d+)?)\/"/g)].map((m) => m[1]);
  return [...new Set(names)].filter((v) => majors.includes(Number(v.split('.')[0])))
    .sort((a, b) => a.split('.').map(Number).reduce((d, x, i) => d || x - (b.split('.').map(Number)[i] ?? 0), 0));
}

/** manifest.yaml -> [{ id, size, sha256 }] (just the fields we use; the format is a flat list). */
export function parseManifest(text) {
  const files = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    let m;
    if ((m = /^- id:\s*(\S+)/.exec(line))) { cur = { id: m[1] }; files.push(cur); continue; }
    if (cur && (m = /^\s+size:\s*(\d+)/.exec(line))) cur.size = Number(m[1]);
    if (cur && (m = /^\s+sha256sum:\s*([0-9a-f]{64})/.exec(line))) cur.sha256 = m[1];
  }
  return files;
}

const archiveName = (v, platform) => (platform === 'macos' ? `openttd-${v}-macos-universal.zip` : `openttd-${v}-linux-generic-amd64.tar.xz`);

async function download(url, file, sha256) {
  if (fs.existsSync(file) && sha256 && sha(file) === sha256) return { cached: true };
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  const got = sha(tmp);
  if (sha256 && got !== sha256) throw new Error(`checksum mismatch for ${url}: manifest ${sha256}, got ${got}`);
  fs.renameSync(tmp, file);
  return { cached: false, sha256: got };
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Download, verify and unpack one release. Returns { exe, archive, sha256, verified }. */
async function prepareVersion(v, platform) {
  const dir = path.join(CACHE, 'versions', v);
  fs.mkdirSync(dir, { recursive: true });
  const name = archiveName(v, platform);
  const manifest = parseManifest(await fetchText(`${CDN}/openttd-releases/${v}/manifest.yaml`));
  const entry = manifest.find((f) => f.id === name);
  if (!entry) throw new Error(`no ${name} in the ${v} manifest`);
  const archive = path.join(dir, name);
  const dl = await download(`${CDN}/openttd-releases/${v}/${name}`, archive, entry.sha256);
  const unpacked = path.join(dir, 'build');
  if (!fs.existsSync(unpacked)) {
    fs.mkdirSync(`${unpacked}.part`, { recursive: true });
    if (platform === 'macos') execFileSync('ditto', ['-x', '-k', archive, `${unpacked}.part`]);
    else execFileSync('tar', ['-xJf', archive, '-C', `${unpacked}.part`]);
    fs.renameSync(`${unpacked}.part`, unpacked);
  }
  const exe = findExe(unpacked, platform);
  if (!exe) throw new Error(`no openttd executable inside ${unpacked}`);
  return { exe, archive, sha256: entry.sha256, verified: true, cached: dl.cached };
}

function findExe(dir, platform) {
  const walk = (d, depth) => {
    if (depth > 4) return null;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (platform === 'macos' && e.isDirectory() && e.name === 'OpenTTD.app') return path.join(p, 'Contents', 'MacOS', 'openttd');
      if (platform === 'linux' && e.isFile() && e.name === 'openttd') return p;
      if (e.isDirectory()) { const f = walk(p, depth + 1); if (f) return f; }
    }
    return null;
  };
  return walk(dir, 0);
}

/** OpenGFX (free base graphics) -> path of its .tar, downloaded once and verified. */
async function prepareOpenGfx() {
  const dir = path.join(CACHE, 'opengfx', OPENGFX_VERSION);
  fs.mkdirSync(dir, { recursive: true });
  const name = `opengfx-${OPENGFX_VERSION}-all.zip`;
  const manifest = parseManifest(await fetchText(`${CDN}/opengfx-releases/${OPENGFX_VERSION}/manifest.yaml`));
  const entry = manifest.find((f) => f.id === name);
  if (!entry) throw new Error(`no ${name} in the OpenGFX manifest`);
  const zip = path.join(dir, name);
  await download(`${CDN}/opengfx-releases/${OPENGFX_VERSION}/${name}`, zip, entry.sha256);
  const tar = path.join(dir, `opengfx-${OPENGFX_VERSION}.tar`);
  if (!fs.existsSync(tar)) execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  if (!fs.existsSync(tar)) throw new Error(`OpenGFX zip did not contain ${path.basename(tar)}`);
  return tar;
}

/** Sandbox env for one version: nothing points at the real home. */
function sandboxEnv(box, exe, ports) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(OPENTTD|XDG_)/.test(k)) env[k] = v;
  return { ...env, HOME: path.join(box, 'home'), XDG_DATA_HOME: path.join(box, 'home', '.local', 'share'), XDG_CONFIG_HOME: path.join(box, 'home', '.config'),
    OPENTTD_AGENT_HOME: path.join(box, 'agent'), OPENTTD_EXE: exe, OPENTTD_AGENT_DAEMON_PORT: String(ports.daemon), OPENTTD_AGENT_ACCEPT_UNTESTED: '1',
    OPENTTD_AGENT_NO_DAEMON: '1' };
}

function personalDir(box, platform) {
  return platform === 'macos' ? path.join(box, 'home', 'Documents', 'OpenTTD') : path.join(box, 'home', '.local', 'share', 'openttd');
}

/** One CLI call in the sandbox -> { ok, ms, result }. */
function cli(env, name, args, timeoutMs = 180000) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [BIN, name, '--no-daemon', '--args', JSON.stringify(args)], { env, encoding: 'utf8', timeout: timeoutMs });
  let result;
  try { result = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { result = { ok: false, error: `no JSON (exit ${r.status}): ${(r.stderr || r.stdout).slice(-400)}` }; }
  return { ok: result.ok !== false, ms: Date.now() - t, result };
}

/** Smoke suite against one version. Returns { version, steps: [{ step, ok, ms, error? }], ... }. */
async function smoke(v, exe, gfxTar, platform, ports) {
  const box = path.join(CACHE, 'sandboxes', `${v}-${Date.now()}`);
  const env = sandboxEnv(box, exe, ports);
  fs.mkdirSync(path.join(personalDir(box, platform), 'baseset'), { recursive: true });
  fs.copyFileSync(gfxTar, path.join(personalDir(box, platform), 'baseset', path.basename(gfxTar)));
  const steps = [];
  const out = { version: v, sandbox: box, ports, steps };
  const record = (step, r, extra = {}) => { steps.push({ step, ok: r.ok, ms: r.ms, ...(r.ok ? {} : { error: String(r.result.first_error ?? r.result.error ?? 'failed').slice(0, 200) }), ...extra }); return r; };
  const pw = crypto.randomBytes(12).toString('hex');
  try {
    const doc = record('doctor', cli(env, 'doctor', {}));
    out.detected = doc.result.openttd?.version ?? null;
    out.detected_class = doc.result.openttd?.class ?? null;
    record('install-gamescript', cli(env, 'install-gamescript', {}));
    record('configure', cli(env, 'configure', { admin_port: ports.admin, admin_password: pw }));
    const launch = record('launch', cli(env, 'launch', { mode: 'dedicated', bind: '127.0.0.1', game_port: ports.game, admin_port: ports.admin,
      map_bits: 7, terrain: 'very_flat', seed: 12345, wait_s: 150 }, 200000));
    out.bridge_version = launch.result.bridge_version ?? null;
    if (!launch.ok) { out.log_tail = launch.result.log_tail?.slice(-8); return out; }
    const st = record('status', cli(env, 'status', {}));
    out.server_version = st.result.openttd?.server ?? null;
    const co = record('company-new', cli(env, 'company-new', { ai: 'IdleAI' }));
    if (co.ok) cli(env, 'configure', { company: co.result.company });
    // A short straight road on flat land; try a few rows in case a town or tree is in the way.
    let built = null;
    for (const y of [20, 40, 60, 80, 100]) {
      const dry = cli(env, 'build-road-path', { x1: 20, y1: y, x2: 30, y2: y, dry_run: true });
      if (!dry.ok) continue;
      record('build dry run', dry);
      built = record('build real', cli(env, 'build-road-path', { x1: 20, y1: y, x2: 30, y2: y }));
      break;
    }
    if (!built) record('build dry run', { ok: false, ms: 0, result: { error: 'no row with a buildable road' } });
    record('vehicles', cli(env, 'vehicles', {}));
    // A dry-run demolish around the biggest town reaches the GS house check (GSTile.IsHouseTile is 15.0+;
    // 14.x uses the fallback in main.nut): a refusal naming a town building is the expected answer.
    const towns = cli(env, 'towns', { limit: 1 });
    const town = towns.result.towns?.[0];
    if (town) {
      // One tile at a time (a rectangle stops at its first refusal, usually the town's road).
      let hit = null, last = null, ms = 0;
      for (let r = 1; r <= 3 && !hit; r++) {
        for (let dx = -r; dx <= r && !hit; dx++) for (const dy of [-r, r]) {
          last = cli(env, 'demolish', { x0: town.x + dx, y0: town.y + dy, dry_run: true });
          ms += last.ms;
          if (/town building/.test(JSON.stringify(last.result))) { hit = last; break; }
        }
      }
      record('house check', { ok: Boolean(hit), ms, result: { error: `no tile near ${town.name} answered "town building": ${JSON.stringify(last?.result).slice(0, 120)}` } });
    } else record('house check', { ok: false, ms: towns.ms, result: { error: 'no town' } });
    record('save', cli(env, 'save', { name: 'smoke' }));
    record('load', cli(env, 'load', { name: 'smoke' }, 120000));
    record('status after load', cli(env, 'status', {}));
    const sl = cli(env, 'server-log', { errors: true, lines: 5 });
    record('gs alive', { ok: sl.ok && sl.result.gs?.state === 'started', ms: sl.ms, result: { error: `gs ${sl.result.gs?.state}: ${(sl.result.lines ?? []).join(' | ').slice(0, 160)}` } });
  } finally {
    record('server-stop', cli(env, 'server-stop', {}, 60000));
    const cfg = path.join(box, 'agent', 'profiles', 'dedicated', 'openttd.cfg');
    const left = pidsOf(cfg);
    for (const pid of left) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    if (left.length) out.killed_after_stop = left;
  }
  return out;
}

/** OpenTTD pids started with exactly this cfg path (never any other OpenTTD). */
function pidsOf(cfgPath) {
  try {
    return execFileSync('pgrep', ['-f', `openttd.* -c ${cfgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`], { encoding: 'utf8' })
      .split('\n').map(Number).filter((n) => n > 0 && n !== process.pid);
  } catch { return []; }
}

export function markdownTable(results) {
  const cols = ['doctor', 'launch', 'status', 'company-new', 'build dry run', 'build real', 'vehicles', 'house check', 'save', 'load', 'status after load', 'gs alive', 'server-stop'];
  const head = `| OpenTTD | sha256 | detected | server | AgentBridge | ${cols.join(' | ')} |`;
  const sep = `|${'---|'.repeat(cols.length + 5)}`;
  const rows = results.map((r) => {
    const cell = (c) => { const s = r.steps?.find((x) => x.step === c); return s ? (s.ok ? 'ok' : `FAIL ${s.error ?? ''}`.trim()) : '-'; };
    return `| ${r.version} | ${r.verified ? 'verified' : 'no'} | ${r.detected ?? '-'} | ${r.server_version ?? '-'} | ${r.bridge_version ? `v${r.bridge_version}` : '-'} | ${cols.map(cell).join(' | ')} |`;
  });
  return [head, sep, ...rows].join('\n');
}

async function main() {
  const f = flags(process.argv.slice(2));
  const platform = f.platform ?? (process.platform === 'darwin' ? 'macos' : 'linux');
  const versions = f.versions ? f.versions.split(',') : parseReleaseIndex(await fetchText(`${CDN}/openttd-releases/`));
  const base = Number(f.base_port ?? 4100);
  log('versions', versions.join(', '), 'platform', platform);
  const gfx = await prepareOpenGfx();
  const results = [];
  for (const [i, v] of versions.entries()) {
    const ports = { game: base + i * 10, admin: base + i * 10 + 1, daemon: base + i * 10 + 2 };
    let prep;
    try { prep = await prepareVersion(v, platform); } catch (e) { results.push({ version: v, verified: false, error: e.message, steps: [] }); log(v, 'download failed', e.message); continue; }
    log(v, 'ready', prep.exe, prep.cached ? '(cached)' : '(downloaded)');
    if (f.download_only === 'true') { results.push({ version: v, verified: prep.verified, steps: [] }); continue; }
    const r = await smoke(v, prep.exe, gfx, platform, ports);
    results.push({ ...r, verified: prep.verified, sha256: prep.sha256, platform });
    log(v, r.steps.map((s) => `${s.step}:${s.ok ? 'ok' : 'FAIL'}`).join(' '));
  }
  const outFile = f.out ?? path.join(CACHE, `version-matrix-${platform}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ platform, node: process.version, date: new Date().toISOString(), results }, null, 2) + '\n');
  console.log(markdownTable(results));
  log('results in', outFile);
  if (results.some((r) => r.error || r.steps.some((s) => !s.ok))) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(2); });
