// OpenTTD version awareness (0.8.0 batch 8): which OpenTTD is installed, which version a server
// runs (admin welcome `revision`), and whether openttd-agent was tested with it.
//
// Pure: parseVersionOutput, classifyVersion, compareHostClient, acceptUntested, versionRefusal.
// Impure (read-only): detectInstalledVersion (macOS Info.plist, else `openttd -h` with a
// throw-away HOME so it never creates a personal dir in the real one).
//
// TESTED_VERSIONS is what tools/version-matrix.mjs ran green (docs/COMPATIBILITY.md). Add a
// version only after the matrix passes on it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TESTED_VERSIONS = ['14.0', '14.1', '15.0', '15.1', '15.2', '15.3'];
/** Oldest release the GameScript loads on (info.nut GetAPIVersion "14"). */
export const MIN_SUPPORTED = '14.0';
export const DOWNLOAD_URL = 'https://www.openttd.org/downloads/openttd-releases/latest';
/** Official files of one release (all platforms, with checksums in manifest.yaml). */
export const versionDownloadUrl = (v) => `https://cdn.openttd.org/openttd-releases/${v}/`;
export const ACCEPT_ENV = 'OPENTTD_AGENT_ACCEPT_UNTESTED';

const RELEASE = /^(\d+)\.(\d+)(?:\.(\d+))?$/;
const PRERELEASE = /^(\d+)\.(\d+)(?:\.(\d+))?-(beta|rc)\d+$/i;

/** First "OpenTTD <version>" in `openttd -h` output (or a bare version string) -> version or null. */
export function parseVersionOutput(text) {
  const s = String(text ?? '').trim();
  const m = /OpenTTD\s+(\S+)/.exec(s) ?? /^(\S+)$/.exec(s.split(/\r?\n/)[0] ?? '');
  return m ? m[1] : null;
}

const parts = (v) => RELEASE.exec(v)?.slice(1, 4).map((x) => Number(x ?? 0)) ?? null;
/** -1 / 0 / 1 for two release versions "a.b[.c]". */
export function compareVersions(a, b) {
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * Class of an OpenTTD version string:
 *   tested            in TESTED_VERSIONS
 *   older_unsupported a release older than MIN_SUPPORTED (the GameScript does not load)
 *   newer_untested    a release not in the list (newer, or a patch release we have not run)
 *   beta              a beta or release candidate (x.y-betaN / x.y-RCN)
 *   custom            a nightly, a git build or anything else
 *   unknown           no version (not detected)
 */
export function classifyVersion(version, tested = TESTED_VERSIONS) {
  const v = version === undefined || version === null ? '' : String(version).trim();
  if (!v) return { version: null, class: 'unknown', tested: false, message: 'OpenTTD version unknown' };
  const range = `${tested[0]}-${tested[tested.length - 1]}`;
  if (RELEASE.test(v)) {
    if (tested.includes(v)) return { version: v, class: 'tested', tested: true, message: `OpenTTD ${v} is tested with this openttd-agent` };
    if (compareVersions(v, MIN_SUPPORTED) < 0) return { version: v, class: 'older_unsupported', tested: false, message: `OpenTTD ${v} is older than ${MIN_SUPPORTED}: the AgentBridge GameScript does not load on it. Install a tested release (${range}): ${DOWNLOAD_URL}` };
    return { version: v, class: 'newer_untested', tested: false, message: `OpenTTD ${v} has not been tested with this openttd-agent (tested: ${tested.join(', ')}). It may work; update openttd-agent, or accept the risk with --accept_untested true (or ${ACCEPT_ENV}=1)` };
  }
  if (PRERELEASE.test(v)) return { version: v, class: 'beta', tested: false, message: `OpenTTD ${v} is a beta or release candidate, not tested (tested: ${range}). Accept the risk with --accept_untested true (or ${ACCEPT_ENV}=1)` };
  return { version: v, class: 'custom', tested: false, message: `OpenTTD '${v}' looks like a nightly or custom build, not tested (tested: ${range}). Accept the risk with --accept_untested true (or ${ACCEPT_ENV}=1)` };
}

/** Is running an untested version allowed? An explicit argument wins, then config, then env. */
export function acceptUntested({ arg, cfg, env = process.env } = {}) {
  if (arg === true || arg === 'true') return true;
  if (arg === false || arg === 'false') return false;
  if (cfg === true) return true;
  return ['1', 'true', 'yes'].includes(String(env[ACCEPT_ENV] ?? '').toLowerCase());
}

/**
 * The refusal text for a version class, or null when it may run. `where` names the side
 * ('installed OpenTTD' / 'the server'). Older-than-supported is refused even when accepted.
 */
export function versionRefusal(cls, accepted, where = 'OpenTTD') {
  if (cls.class === 'tested' || cls.class === 'unknown') return null;
  if (cls.class === 'older_unsupported') return `unsupported_openttd_version: ${where}: ${cls.message}`;
  if (accepted) return null;
  return `untested_openttd_version: ${where}: ${cls.message}`;
}

/** Host (server) and client versions must be identical for OpenTTD to let a client join. */
export function compareHostClient(server, client) {
  if (!server || !client) return { match: null, server: server ?? null, client: client ?? null };
  if (server === client) return { match: true, server, client };
  return { match: false, server, client,
    message: `version mismatch: the server runs OpenTTD ${server}, this machine has ${client}. OpenTTD refuses to join a server of another version; install ${server} (${versionDownloadUrl(server)})` };
}

const cache = new Map();

/**
 * Version of the OpenTTD at `exe`: { version, source } or { version: null, source, error }.
 * macOS: the app's Info.plist (never starts the game). Others: `<exe> -h` with HOME/XDG in a
 * temp folder (OpenTTD creates its personal dir on start), 5 s timeout.
 */
export function detectInstalledVersion(exe) {
  if (!exe) return { version: null, source: null, error: 'not installed' };
  let key = exe;
  try { key = `${exe}:${fs.statSync(exe).mtimeMs}`; } catch { return { version: null, source: null, error: `${exe} does not exist` }; }
  if (cache.has(key)) return cache.get(key);
  let out;
  const plist = exe.includes('.app/') ? path.join(exe.slice(0, exe.indexOf('.app/') + 4), 'Contents', 'Info.plist') : null;
  if (plist && fs.existsSync(plist)) {
    const m = fs.readFileSync(plist, 'utf8').match(/CFBundleShortVersionString<\/key>\s*<string>([^<]+)/);
    out = m ? { version: m[1].trim(), source: 'Info.plist' } : { version: null, source: 'Info.plist', error: 'no CFBundleShortVersionString' };
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openttd-agent-ver-'));
    try {
      const text = execFileSync(exe, ['-h'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: tmp, XDG_DATA_HOME: tmp, XDG_CONFIG_HOME: tmp, USERPROFILE: tmp } });
      const v = parseVersionOutput(text);
      out = v ? { version: v, source: `${path.basename(exe)} -h` } : { version: null, source: `${path.basename(exe)} -h`, error: 'no version in the output' };
    } catch (e) {
      const v = parseVersionOutput(`${e.stdout ?? ''}`); // some builds exit non-zero after -h
      out = v ? { version: v, source: `${path.basename(exe)} -h` } : { version: null, source: `${path.basename(exe)} -h`, error: String(e.message).split('\n')[0].slice(0, 200) };
    }
  }
  cache.set(key, out);
  return out;
}

/** Install guidance when OpenTTD is not found (no stack trace). */
export function installHint(platform = process.platform) {
  const how = { darwin: 'download the macOS build, open the .dmg and drag OpenTTD to Applications, then open it once from Finder',
    win32: 'download the Windows installer (or install it from Steam)', linux: 'download the Linux build (or use your package manager, Flatpak or Steam)' }[platform]
    ?? 'download the build for your system';
  return `OpenTTD is not installed (or not where openttd-agent looks). Install a tested release (${TESTED_VERSIONS.join(', ')}): ${how}: ${DOWNLOAD_URL}. Installed elsewhere? Set OPENTTD_EXE to the openttd executable.`;
}
