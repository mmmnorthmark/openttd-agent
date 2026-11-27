// Host tools (0.8.0): admin login failures, launch dry runs, server profiles, host commands
// against the fake admin server, GS timeout diagnosis, persisted background jobs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { AdminClient } from '../src/admin-client.js';
import { startFakeServer } from './fake-server.js';

test('admin login: a socket closed before welcome fails at once with admin_auth', async () => {
  const server = net.createServer((sock) => sock.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const started = Date.now();
  const admin = new AdminClient({ host: '127.0.0.1', port: server.address().port, password: 'x' });
  await assert.rejects(admin.connect(10000), /^Error: admin_auth: /);
  assert.ok(Date.now() - started < 2000, 'no wait for the 10 s timeout');
  server.close();
});

test('admin login: a wrong password is admin_auth too', async () => {
  const fake = await startFakeServer({ password: 'right' });
  const admin = new AdminClient({ host: '127.0.0.1', port: fake.port, password: 'wrong' });
  await assert.rejects(admin.connect(5000), /admin_auth: admin login refused: WRONG_PASSWORD/);
  fake.server.close();
});
