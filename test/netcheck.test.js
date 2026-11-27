// src/netcheck.js pure parts: address classes, local subnets, hints, firewall/lsof parsing, fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAddress, hostOf, localSubnets, onLocalSubnet, diagnoseAddress, connectionHint, parseSocketfilterfw, parseAppBlocked, parseLsofListen, hostFixes } from '../src/netcheck.js';

const IFACES = {
  lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
  en0: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false, cidr: '192.168.1.20/24' }, { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }],
};
const subnets = localSubnets(IFACES);

test('hostOf takes URLs, host:port and bare addresses', () => {
  assert.equal(hostOf('http://10.0.0.5:47978'), '10.0.0.5');
  assert.equal(hostOf('10.0.0.5:3979'), '10.0.0.5');
  assert.equal(hostOf('[fe80::1]:3979'), 'fe80::1');
  assert.equal(hostOf('gamehost'), 'gamehost');
});

test('classifyAddress', () => {
  const cases = { '127.0.0.1': 'loopback', localhost: 'loopback', '::1': 'loopback', '10.1.2.3': 'private', '172.16.0.1': 'private', '172.31.255.1': 'private', '172.32.0.1': 'public',
    '192.168.0.9': 'private', '100.64.0.1': 'cgnat', '100.127.1.1': 'cgnat', '100.128.0.1': 'public', '169.254.3.4': 'link_local', 'fe80::1': 'link_local', 'fd12::1': 'ipv6_private',
    '0.0.0.0': 'unspecified', '192.0.2.5': 'documentation', '198.51.100.7': 'documentation', '8.8.8.8': 'public', 'gamehost.example': 'hostname' };
  for (const [a, c] of Object.entries(cases)) assert.equal(classifyAddress(a), c, a);
});

test('local subnets and membership', () => {
  assert.deepEqual(subnets.map((s) => s.cidr), ['192.168.1.20/24']);
  assert.equal(onLocalSubnet('192.168.1.77', subnets), true);
  assert.equal(onLocalSubnet('192.168.2.77', subnets), false);
  assert.equal(onLocalSubnet('10.0.0.5', subnets), false);
  assert.equal(onLocalSubnet('gamehost', subnets), null);
});

test('diagnoseAddress: a private address off every local subnet gets the remote options', () => {
  const d = diagnoseAddress('http://10.0.0.5:47978', { subnets });
  assert.equal(d.class, 'private');
  assert.equal(d.on_local_subnet, false);
  assert.match(d.hint, /private address on another network: you're probably not on the same LAN/);
  assert.deepEqual(d.options.map((o) => o.option), ['invite code', 'private mesh VPN such as Tailscale', 'Cloudflare Tunnel']);
  assert.match(d.options[0].how, /server_game_type invite-only.*server_info/);
  assert.equal(diagnoseAddress('192.168.1.40', { subnets }).hint, undefined, 'same LAN: no hint');
  assert.match(diagnoseAddress('100.101.102.103', { subnets }).hint, /mesh/);
  assert.match(diagnoseAddress('0.0.0.0', { subnets }).hint, /bind address/);
});

test('connectionHint by error code', () => {
  assert.match(connectionHint('http://10.0.0.5:47978', 'ETIMEDOUT', { subnets }).hint, /another network/);
  assert.match(connectionHint('http://192.168.1.40:47978', 'ECONNREFUSED', { subnets }).hint, /nothing listens.*openttd-agent relay/);
  assert.match(connectionHint('192.168.1.40', 'timeout', { subnets, kind: 'game' }).hint, /firewall on the host.*net-check --role host/);
  assert.equal(connectionHint('192.168.1.40', 'EPIPE', { subnets }), null);
});

test('macOS socketfilterfw and lsof parsing', () => {
  assert.deepEqual(parseSocketfilterfw('Firewall is disabled. (State = 0)\nFirewall has block all state set to disabled.\nFirewall stealth mode is off\n'), { enabled: false, block_all: false, stealth: false });
  assert.deepEqual(parseSocketfilterfw('Firewall is enabled. (State = 1)\nFirewall has block all state set to enabled.\nFirewall stealth mode is on\n'), { enabled: true, block_all: true, stealth: true });
  assert.equal(parseAppBlocked('Incoming connection to /Applications/OpenTTD.app/Contents/MacOS/openttd is permitted.'), false);
  assert.equal(parseAppBlocked('Incoming connection to /usr/local/bin/node is blocked.'), true);
  assert.equal(parseAppBlocked('The application is not part of the firewall'), null);
  const lsof = 'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nopenttd 4242 u   12u  IPv4 0x1      0t0  TCP 127.0.0.1:3979 (LISTEN)\nnode    4243 u   20u  IPv6 0x2      0t0  TCP *:47978 (LISTEN)\n';
  assert.deepEqual(parseLsofListen(lsof), [{ command: 'openttd', pid: 4242, address: '127.0.0.1', port: 3979 }, { command: 'node', pid: 4243, address: '*', port: 47978 }]);
});

test('hostFixes: allow the app or port, never turn the firewall off', () => {
  const fixes = hostFixes({ platform: 'darwin', firewall: { enabled: true, block_all: true, apps: [{ app: '/Applications/OpenTTD.app/Contents/MacOS/openttd', blocked: true }] },
    ports: [{ port: 3979, role: 'game', listening: true, bind_scope: 'loopback', listen: [{ address: '127.0.0.1' }] }, { port: 47978, role: 'relay', listening: false }] });
  const text = fixes.join('\n');
  assert.match(text, /blocks ALL incoming.*keep the firewall on/);
  assert.match(text, /--unblockapp/);
  assert.match(text, /listens on 127\.0\.0\.1 only/);
  assert.match(text, /nothing listens on port 47978.*openttd-agent relay/);
  assert.doesNotMatch(text, /turn (the )?firewall off|disable the firewall|setglobalstate off/i);
  assert.match(hostFixes({ platform: 'win32', firewall: { enabled: true }, ports: [] }).join(' '), /Private networks only/);
});

import { playerCheck } from '../src/netcheck.js';
import net from 'node:net';

test('playerCheck: never sends to a private address on another network unless probe; probes loopback', async () => {
  const off = await playerCheck({ target: 'http://10.0.0.5:47978', ports: [{ port: 47978, role: 'relay' }], subnets });
  assert.equal(off.ports[0].reachable, null);
  assert.match(off.ports[0].skipped, /another network/);
  assert.ok(off.options.length >= 3);
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  const local = await playerCheck({ target: `http://127.0.0.1:${port}`, ports: [{ port, role: 'relay' }], subnets });
  assert.equal(local.ports[0].reachable, true);
  assert.equal(local.options, undefined);
  srv.close();
});
