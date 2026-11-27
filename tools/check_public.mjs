// Public-repo hygiene check (0.8.0 batch 8). Fails (exit 1) when a tracked or new file holds a
// personal reference: names other than the copyright holder in LICENSE/NOTICE, task-tracker or
// private-network names, private IPs that are not RFC 5737 documentation examples, absolute home
// directory paths, private hostnames, or the private skills repo.
//
// Run: node tools/check_public.mjs (or tools/check_public.sh; part of `npm run check`).
// Pure part: checkText(file, text) -> [{ file, line, rule, text }], unit-tested in test/public.test.js.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Files where the copyright holder's name is the credit (allowed only there). */
const CREDIT_FILES = new Set(['LICENSE', 'NOTICE']);
/** Generic networking docs and the address classifier may name mesh VPNs and private ranges. */
const NETWORK_FILES = new Set(['README.md', 'src/netcheck.js', 'test/netcheck.test.js', 'docs/NETWORK.md']);
/** This checker and its test describe the patterns themselves. */
const SELF_FILES = new Set(['tools/check_public.mjs', 'tools/check_public.sh', 'test/public.test.js']);

// RFC 1918 + CGNAT (100.64.0.0/10) + link-local. Documentation ranges (192.0.2/24, 198.51.100/24,
// 203.0.113/24) and loopback are fine everywhere.
const PRIVATE_IP = /(?<![\d.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})(?![\d.]*\d)/;

/** [rule, regex, allowedIn(file) -> bool]. Regexes are case-insensitive unless noted. */
export const RULES = [
  ['personal_name', /\b(matthew|matt|zach|becky|katherine|joshua|estel|providence|iunia|joanna|ricki)\b/i, (f) => CREDIT_FILES.has(f)],
  ['task_tracker', /todoist/i, () => false],
  ['mesh_vpn', /tailscale|tailnet|\.ts\.net\b/i, (f) => NETWORK_FILES.has(f)],
  ['private_ip', PRIVATE_IP, (f) => NETWORK_FILES.has(f)],
  ['home_path', /(\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+|~\/code-local|~\/Dropbox)/, () => false],
  // An mDNS hostname in a URL, login or host:port ("//name.local", "@name.local", "name.local:3979");
  // a bare ".local" (XDG ~/.local/share) or a property (target.local) is not one.
  ['hostname', /\b(mmmstudio|mmmnas\d*|macbook)\b|(\/\/|@)[a-z0-9-]+\.local\b|\b[a-z0-9-]+\.local:\d+/i, () => false],
  ['backup_host', /\bNAS\b/, () => false],
  ['private_repo', /openttd-agent-(skills|research)|private skills repo|skills repo/i, () => false],
];

/** Hits of every rule in one file's text. `file` is the repo-relative path. */
export function checkText(file, text) {
  if (SELF_FILES.has(file)) return [];
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [rule, re, allowed] of RULES) {
      if (allowed(file)) continue;
      if (re.test(line)) hits.push({ file, line: i + 1, rule, text: line.trim().slice(0, 160) });
    }
  });
  return hits;
}

/** Tracked and new (not ignored) files of the repo at root, binary-looking ones skipped. */
function repoFiles(root) {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).filter((f) => !/\.(png|jpe?g|gif|sav|tar|zip|xz|gz|grf|ico)$/i.test(f) && f !== 'package-lock.json');
}

function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const hits = [];
  for (const f of repoFiles(root)) {
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; } // deleted in the worktree
    hits.push(...checkText(f, text));
  }
  if (hits.length) {
    for (const h of hits) console.error(`${h.file}:${h.line}: ${h.rule}: ${h.text}`);
    console.error(`check_public: ${hits.length} personal reference(s). Use generic wording and RFC 5737 example addresses (192.0.2.x, 198.51.100.x, 203.0.113.x).`);
    process.exit(1);
  }
  console.log('check_public: ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
