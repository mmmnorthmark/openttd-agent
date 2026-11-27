// Network diagnostics (0.8.0 batch 8). Pure part: classify an address, compare it with this
// machine's subnets, and turn a failed connection into a hint with the secure options. Impure
// part (probe*): read-only checks that need no admin rights (firewall state, listening sockets,
// a TCP self-connect). Nothing here changes a firewall or installs anything; other tools are
// only linked.
//
// Address classes: loopback, private (RFC 1918), cgnat (100.64.0.0/10, also used by mesh VPNs
// such as Tailscale), link_local (169.254/16, fe80::/10), unspecified (0.0.0.0, ::),
// documentation (RFC 5737), public, ipv6_private (fc00::/7), hostname (not an IP literal).

import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const LINKS = {
  invite_codes: 'https://wiki.openttd.org/en/Manual/Multiplayer',
  tailscale: 'https://tailscale.com/kb/1017/install',
  cloudflare_tunnel: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/',
  macos_firewall: 'https://support.apple.com/guide/mac-help/change-firewall-settings-on-mac-mh11783/mac',
  windows_firewall: 'https://support.microsoft.com/windows/risks-of-allowing-apps-through-windows-defender-firewall-654559af-3f54-3dcf-349f-71ccd90bcc5c',
};

const ip4 = (s) => (net.isIPv4(s) ? s.split('.').map(Number) : null);
const toInt = (p) => ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];

/** The host part of a URL, host:port or bare address ("http://192.0.2.1:47978" -> "192.0.2.1"). */
export function hostOf(target) {
  const s = String(target ?? '').trim();
  if (!s) return '';
  try { if (/^[a-z]+:\/\//i.test(s)) return new URL(s).hostname.replace(/^\[|\]$/g, ''); } catch { /* not a URL */ }
  if (/^\[.*\](:\d+)?$/.test(s)) return s.slice(1, s.indexOf(']'));
  if (net.isIPv6(s)) return s;
  return s.replace(/:\d+$/, '');
}

/** Class of one address (see header). */
export function classifyAddress(address) {
  const a = hostOf(address);
  if (a === 'localhost') return 'loopback';
  const p = ip4(a);
  if (p) {
    if (p.every((x) => x === 0)) return 'unspecified';
    if (p[0] === 127) return 'loopback';
    if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)) return 'private';
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return 'cgnat';
    if (p[0] === 169 && p[1] === 254) return 'link_local';
    if ((p[0] === 192 && p[1] === 0 && p[2] === 2) || (p[0] === 198 && p[1] === 51 && p[2] === 100) || (p[0] === 203 && p[1] === 0 && p[2] === 113)) return 'documentation';
    return 'public';
  }
  if (net.isIPv6(a)) {
    const l = a.toLowerCase();
    if (l === '::1') return 'loopback';
    if (l === '::') return 'unspecified';
    if (/^fe[89ab]/.test(l)) return 'link_local';
    if (/^f[cd]/.test(l)) return 'ipv6_private';
    return 'public';
  }
  return 'hostname';
}

/** IPv4 subnets of this machine from os.networkInterfaces() output: [{ iface, address, netmask, cidr }]. */
export function localSubnets(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [iface, list] of Object.entries(interfaces ?? {})) {
    for (const i of list ?? []) {
      if (!i || (i.family !== 'IPv4' && i.family !== 4) || i.internal) continue;
      out.push({ iface, address: i.address, netmask: i.netmask, cidr: i.cidr ?? `${i.address}/${maskBits(i.netmask)}` });
    }
  }
  return out;
}

const maskBits = (m) => (ip4(m) ?? [0, 0, 0, 0]).reduce((n, b) => n + b.toString(2).split('').filter((c) => c === '1').length, 0);

/** Is the IPv4 `address` inside one of `subnets`? null for non-IPv4 targets. */
export function onLocalSubnet(address, subnets) {
  const p = ip4(hostOf(address));
  if (!p) return null;
  const x = toInt(p);
  return subnets.some((s) => {
    const a = ip4(s.address), m = ip4(s.netmask);
    if (!a || !m) return false;
    const mask = toInt(m);
    return ((x & mask) >>> 0) === ((toInt(a) & mask) >>> 0);
  });
}

/** Options for a player who cannot reach the host directly (links only; nothing is bundled). */
export function remoteOptions() {
  return [
    { for: 'game (OpenTTD itself)', option: 'invite code', how: 'Host: openttd-agent console --command "setting server_game_type invite-only" (or public), then openttd-agent console --command server_info prints the invite code (+XXXXXX). Player: OpenTTD Multiplayer > Add Server > paste the code. The game coordinator connects you (direct or through its relay); no port forwarding.', link: LINKS.invite_codes },
    { for: 'relay (openttd-agent)', option: 'private mesh VPN such as Tailscale', how: 'Both machines install it and sign in to the same network; then use the host\'s mesh address (100.x.y.z) in configure --relay http://<mesh-address>:47978.', link: LINKS.tailscale },
    { for: 'relay (openttd-agent)', option: 'Cloudflare Tunnel', how: 'The host runs a tunnel to http://127.0.0.1:47978 and gives the player the tunnel URL; put an access policy in front of it (the relay token travels in that request).', link: LINKS.cloudflare_tunnel },
  ];
}

/**
 * Pure: what the target address means for this machine. -> { address, class, on_local_subnet,
 * local_subnets, hint?, options? }. `role`: 'player' (target = the host) or 'host'.
 */
export function diagnoseAddress(target, { subnets = localSubnets(), role = 'player' } = {}) {
  const address = hostOf(target);
  const cls = classifyAddress(address);
  const on = onLocalSubnet(address, subnets);
  const out = { address, class: cls, on_local_subnet: on, local_subnets: subnets.map((s) => s.cidr) };
  if (cls === 'private' && on === false) {
    out.hint = `${address} is a private address on another network: you're probably not on the same LAN as the host (this machine is on ${out.local_subnets.join(', ') || 'no LAN'}). Join the host's network, or use one of the options.`;
    out.options = remoteOptions();
  } else if (cls === 'cgnat' && on === false) {
    out.hint = `${address} is a CGNAT / mesh-VPN address (100.64.0.0/10). If it is the host's mesh VPN address, this machine must be signed in to the same mesh network.`;
    out.options = remoteOptions().filter((o) => /mesh/.test(o.option));
  } else if (cls === 'link_local') {
    out.hint = `${address} is a link-local address (no DHCP on that network); use the host's normal LAN address instead`;
  } else if (cls === 'loopback' && role === 'player') {
    out.hint = `${address} is this machine. Fine when the host runs here too; another player's machine needs the host's LAN address`;
  } else if (cls === 'unspecified') {
    out.hint = `${address} is "any address": a bind address, not one to connect to; use the host's LAN address`;
  } else if (cls === 'public') {
    out.hint = `${address} is a public internet address: the host must forward the port on its router (or use an invite code for the game and a tunnel or mesh VPN for the relay)`;
    out.options = remoteOptions();
  }
  return out;
}

/**
 * Pure: a hint for a failed connection (error code from a socket or fetch) to `target` of kind
 * 'relay' | 'game' | 'admin'. -> { hint, network } | null.
 */
export function connectionHint(target, errorCode, { kind = 'relay', subnets = localSubnets() } = {}) {
  const code = String(errorCode ?? '');
  const network = diagnoseAddress(target, { subnets });
  const offNet = (network.class === 'private' || network.class === 'cgnat') && network.on_local_subnet === false;
  let hint;
  if (offNet) hint = network.hint;
  else if (/ECONNREFUSED/.test(code)) hint = `the host machine answered but nothing listens there: is the ${kind === 'relay' ? "relay ('openttd-agent relay')" : 'server'} running, and is the port right?`;
  else if (/timeout|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/i.test(code)) hint = `no answer from ${network.address}: a firewall on the host drops the connection, the host is asleep or off, or it is on another network. Host: run openttd-agent net-check --role host`;
  else if (/ENOTFOUND|EAI_AGAIN/.test(code)) hint = `the name ${network.address} does not resolve; use the host's IP address`;
  else return null;
  return { hint, network };
}

// ---- host-side probes (impure, read-only, no admin rights) -------------------------------------

const run = (cmd, args, timeout = 3000) => {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, error: String(e.message).split('\n')[0] }; }
};

const SOCKETFILTERFW = '/usr/libexec/ApplicationFirewall/socketfilterfw';

/** Pure: socketfilterfw output -> { enabled, block_all, stealth }. */
export function parseSocketfilterfw(text) {
  const s = String(text);
  const flag = (re) => { const m = re.exec(s); return m ? !/disabled|off/i.test(m[1]) : null; };
  return {
    enabled: flag(/Firewall is (enabled|disabled)/i) ?? (/State = [12]/.test(s) ? true : /State = 0/.test(s) ? false : null),
    block_all: flag(/(?:Block all|blocks all)[^\n]*?(enabled|disabled|ON|OFF)/i) ?? (/Firewall is set to block all non-essential/i.test(s) ? true : null),
    stealth: flag(/Stealth mode (?:is )?(enabled|disabled|on|off)/i),
  };
}

/** Pure: `socketfilterfw --getappblocked <path>` output -> true (blocked) / false (allowed) / null (not listed). */
export function parseAppBlocked(text) {
  const s = String(text);
  if (/is blocked|block incoming connections/i.test(s)) return true;
  if (/is permitted|allow incoming connections/i.test(s)) return false;
  return null;
}

/** Pure: `lsof -nP -iTCP -sTCP:LISTEN` lines -> [{ command, pid, address, port }]. */
export function parseLsofListen(text) {
  const rows = [];
  for (const line of String(text).split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const name = cols.slice(8).join(' ').replace(/\s*\(LISTEN\)$/, '');
    const m = /^(.*):(\d+)$/.exec(name);
    if (!m) continue;
    rows.push({ command: cols[0], pid: Number(cols[1]), address: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) });
  }
  return rows;
}

/** Who listens on `port` (lsof on macOS/Linux; netstat on Windows; null when unknown). */
export function listeners(port) {
  if (process.platform === 'win32') {
    const r = run('netstat', ['-ano', '-p', 'TCP']);
    if (!r.ok) return null;
    return r.out.split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c[3] === 'LISTENING' && c[1]?.endsWith(`:${port}`))
      .map((c) => ({ command: null, pid: Number(c[4]), address: c[1].replace(/:\d+$/, ''), port }));
  }
  const r = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if (!r.ok && !r.out) return r.error && /ENOENT/.test(r.error) ? null : [];
  return parseLsofListen(r.out);
}

/** Process name for a pid (ps), or null. */
export function processName(pid) {
  if (!pid || process.platform === 'win32') return null;
  const r = run('ps', ['-o', 'comm=', '-p', String(pid)]);
  return r.ok ? r.out.trim().split('/').pop() || null : null;
}

/** TCP connect to host:port -> { ok, ms, error? } (never throws). */
export function tcpProbe(host, port, timeoutMs = 1500) {
  const t = Date.now();
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (r) => { sock.destroy(); resolve({ ...r, ms: Date.now() - t }); };
    sock.setTimeout(timeoutMs, () => done({ ok: false, error: 'timeout' }));
    sock.once('connect', () => done({ ok: true }));
    sock.once('error', (e) => done({ ok: false, error: e.code ?? e.message }));
  });
}

/** Firewall state without admin rights. -> { platform, tool, enabled, ..., apps?, note? } */
export function firewallState({ apps = [] } = {}) {
  if (process.platform === 'darwin') {
    if (!fs.existsSync(SOCKETFILTERFW)) return { platform: 'darwin', tool: null, enabled: null, note: 'socketfilterfw not found' };
    const g = run(SOCKETFILTERFW, ['--getglobalstate']);
    const b = run(SOCKETFILTERFW, ['--getblockall']);
    const st = run(SOCKETFILTERFW, ['--getstealthmode']);
    const parsed = parseSocketfilterfw(`${g.out}\n${b.out}\n${st.out}`);
    const appState = apps.filter(Boolean).map((p) => ({ app: p, blocked: parseAppBlocked(run(SOCKETFILTERFW, ['--getappblocked', p]).out) }));
    return { platform: 'darwin', tool: 'socketfilterfw', ...parsed, apps: appState };
  }
  if (process.platform === 'linux') {
    const ufw = run('ufw', ['status']);
    const fwd = run('firewall-cmd', ['--state']);
    const ufwPresent = ufw.ok || !/ENOENT/.test(ufw.error ?? '');
    const fwdPresent = fwd.ok || !/ENOENT/.test(fwd.error ?? '');
    return { platform: 'linux', tool: [ufwPresent && 'ufw', fwdPresent && 'firewalld'].filter(Boolean).join('+') || null,
      enabled: ufw.ok ? /Status: active/.test(ufw.out) : fwd.ok ? /running/.test(fwd.out) : null,
      ...(ufwPresent && !ufw.ok ? { note: 'ufw needs root to show its rules (sudo ufw status)' } : {}) };
  }
  if (process.platform === 'win32') {
    const r = run('netsh', ['advfirewall', 'show', 'currentprofile', 'state']);
    return { platform: 'win32', tool: 'netsh', enabled: r.ok ? /ON/.test(r.out) : null };
  }
  return { platform: process.platform, tool: null, enabled: null };
}

/** Pure: the secure fixes for a host's findings. Never "turn the firewall off". */
export function hostFixes({ firewall, ports, platform = process.platform, exe }) {
  const fixes = [];
  const list = ports.map((p) => p.port).join(', ');
  if (firewall?.block_all) fixes.push('macOS firewall blocks ALL incoming connections ("Block all incoming connections"). Untick only that option (System Settings > Network > Firewall > Options) and allow OpenTTD and node; keep the firewall on.');
  for (const a of firewall?.apps ?? []) {
    if (a.blocked === true) fixes.push(`macOS firewall blocks ${a.app}. Allow it: System Settings > Network > Firewall > Options > set it to "Allow incoming connections" (or: sudo ${SOCKETFILTERFW} --unblockapp "${a.app}"). ${LINKS.macos_firewall}`);
  }
  if (firewall?.enabled && platform === 'darwin' && !(firewall.apps ?? []).some((a) => a.blocked === true)) fixes.push('macOS firewall is on: when macOS asks "accept incoming network connections?" for OpenTTD or node, click Allow. If you clicked Deny before, set them to Allow in System Settings > Network > Firewall > Options.');
  if (platform === 'linux' && firewall?.tool?.includes('ufw')) fixes.push(`ufw: allow the ports from your LAN only, e.g. sudo ufw allow from 192.0.2.0/24 to any port ${ports[0]?.port ?? 3979} proto tcp (use your own LAN subnet; repeat for ${list})`);
  if (platform === 'linux' && firewall?.tool?.includes('firewalld')) fixes.push(`firewalld: sudo firewall-cmd --zone=home --add-port=<port>/tcp for ${list} (home/trusted zone for your LAN interface; add --permanent once it works)`);
  if (platform === 'win32') fixes.push(`Windows: when Windows asks, allow ${exe ? 'OpenTTD' : 'the app'} and Node.js on Private networks only (not Public). Change it later in "Allow an app through Windows Firewall". ${LINKS.windows_firewall}`);
  for (const p of ports) {
    if (p.listening === false) fixes.push(`nothing listens on port ${p.port} (${p.role}): start it (${p.role === 'relay' ? 'openttd-agent relay' : 'openttd-agent launch'})`);
    else if (p.role === 'admin') continue; // players never need the admin port; loopback is the safe state
    else if (p.bind_scope === 'loopback') fixes.push(`port ${p.port} (${p.role}) listens on ${p.listen.map((l) => l.address).join(', ')} only: other machines cannot reach it. ${p.role === 'relay' ? 'Start the relay with --bind 0.0.0.0 (or your LAN address)' : 'Launch with --bind 0.0.0.0 (or your LAN address)'}`);
    else if (p.self_connect && p.self_connect.ok === false) fixes.push(`port ${p.port} (${p.role}) does not answer on this machine's LAN address ${p.self_connect.address} (${p.self_connect.error})`);
  }
  return fixes;
}

const LOOPBACK = (a) => /^127\.|^::1$|^localhost$/.test(a);
const WILDCARD = (a) => a === '*' || a === '0.0.0.0' || a === '::';

/**
 * Host check: for each { port, role } who listens and where, a TCP self-connect on this machine's
 * first LAN address, the firewall state (apps: OpenTTD and node) and the secure fixes.
 */
export async function hostCheck({ ports, exe, subnets = localSubnets() }) {
  const lan = subnets[0]?.address ?? null;
  const out = [];
  for (const p of ports) {
    const ls = listeners(p.port);
    const listen = ls === null ? null : ls.map((l) => ({ ...l, command: l.command ?? processName(l.pid) }));
    const row = { ...p, listening: listen === null ? null : listen.length > 0, listen };
    if (listen?.length) {
      row.bind_scope = listen.every((l) => LOOPBACK(l.address)) ? 'loopback' : listen.some((l) => WILDCARD(l.address)) ? 'all' : 'specific';
      if (lan && row.bind_scope !== 'loopback') row.self_connect = { address: lan, ...(await tcpProbe(lan, p.port)) };
    }
    out.push(row);
  }
  const firewall = firewallState({ apps: [exe, process.execPath] });
  return { role: 'host', lan_addresses: subnets.map((s) => s.address), local_subnets: subnets.map((s) => s.cidr), ports: out, firewall,
    fixes: hostFixes({ firewall, ports: out, exe }),
    note: 'A self-connect on the LAN address does not pass through the firewall the way another machine does; the real test is a player running net-check against this address.' };
}

/** Player check: what the host address means here, and whether the relay and game ports answer. */
export async function playerCheck({ target, ports, subnets = localSubnets(), probe }) {
  const network = diagnoseAddress(target, { subnets });
  const out = [];
  // A private address on no local subnet is almost always another LAN: the hint is the answer, so
  // nothing is sent there unless asked (probe: true; routed site-to-site networks exist).
  const offNet = network.class === 'private' && network.on_local_subnet === false;
  for (const p of ports) {
    if (offNet && probe !== true) { out.push({ ...p, reachable: null, skipped: 'private address on another network (probe true tests it anyway)' }); continue; }
    const r = await tcpProbe(network.address, p.port, 2500);
    const h = r.ok ? null : connectionHint(network.address, r.error, { kind: p.role, subnets });
    out.push({ ...p, reachable: r.ok, ms: r.ms, ...(r.ok ? {} : { error: r.error, hint: h?.hint ?? null }) });
  }
  return { role: 'player', target: network.address, network, ports: out,
    ...(out.every((p) => p.reachable === true) ? {} : { options: network.options ?? remoteOptions() }) };
}
