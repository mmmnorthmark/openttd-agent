// tools/check_public.mjs patterns (public-repo hygiene, batch 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkText } from '../tools/check_public.mjs';

const rules = (file, text) => checkText(file, text).map((h) => h.rule);

test('personal names only in LICENSE/NOTICE', () => {
  assert.deepEqual(rules('README.md', 'Ask Zach to host'), ['personal_name']);
  assert.deepEqual(rules('CLAUDE.md', 'Releases (Matthew, 2026)'), ['personal_name']);
  assert.deepEqual(rules('LICENSE', 'Copyright (c) 2026 Matthew Miller'), []);
  assert.deepEqual(rules('src/x.js', 'const format = matter;'), []);
});

test('task tracker, private repo, backup host', () => {
  assert.deepEqual(rules('src/a.js', '// see Todoist task'), ['task_tracker']);
  assert.deepEqual(rules('CLAUDE.md', 'recipes live in openttd-agent-skills'), ['private_repo']);
  assert.deepEqual(rules('CLAUDE.md', 'backed up to the NAS'), ['backup_host']);
  assert.deepEqual(rules('docs/x.md', 'BaNaNaS content'), []);
});

test('mesh VPN names only in the networking docs and netcheck', () => {
  assert.deepEqual(rules('src/commands.js', 'use Tailscale'), ['mesh_vpn']);
  assert.deepEqual(rules('README.md', 'a private mesh VPN such as Tailscale'), []);
  assert.deepEqual(rules('src/netcheck.js', 'tailscale.com'), []);
});

test('private IPs: RFC 1918, CGNAT, link-local refused; documentation ranges and loopback fine', () => {
  for (const ip of ['10.0.0.5', '172.16.3.4', '172.31.0.1', '192.168.1.20', '100.64.0.1', '100.127.9.9', '169.254.1.1']) {
    assert.deepEqual(rules('docs/PROTOCOL.md', `relay at ${ip}:47978`), ['private_ip'], ip);
  }
  for (const ip of ['192.0.2.20', '198.51.100.7', '203.0.113.9', '127.0.0.1', '0.0.0.0', '172.32.0.1', '100.128.0.1', '8.8.8.8', '1.10.0.0.5']) {
    assert.deepEqual(rules('docs/PROTOCOL.md', `relay at ${ip}:47978`), [], ip);
  }
  assert.deepEqual(rules('test/netcheck.test.js', "classify('10.0.0.5')"), []);
});

test('home paths and hostnames', () => {
  assert.deepEqual(rules('CLAUDE.md', 'history: /Users/someone/code'), ['home_path']);
  assert.deepEqual(rules('CLAUDE.md', 'see ~/code-local/x'), ['home_path']);
  assert.deepEqual(rules('README.md', 'C:\\Users\\bob\\Documents'), ['home_path']);
  assert.deepEqual(rules('README.md', '~/.openttd-agent/config.json and ~/Documents/OpenTTD'), []);
  assert.deepEqual(rules('README.md', 'ssh me@studio.local'), ['hostname']);
  assert.deepEqual(rules('README.md', 'http://gamebox.local:47978'), ['hostname']);
  assert.deepEqual(rules('src/host.js', "if (target.local) x(); path.join(home, '.local', 'share')"), []);
});

test('the checker itself is exempt', () => {
  assert.deepEqual(rules('tools/check_public.mjs', 'todoist tailscale /Users/x'), []);
});
