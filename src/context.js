// Execution context shared by daemon and MCP: lazily connected Session that
// reconnects when the connection drops or the connection settings change.

import { loadConfig } from './config.js';
import { Session } from './session.js';
import { log } from './log.js';

const connKey = (c) => `${c.host}:${c.admin_port}:${c.admin_password}`;

export function makeContext() {
  let session = null;
  let connecting = null;
  let key = null;
  const ctx = {
    cfg: loadConfig(),
    refreshConfig() {
      ctx.cfg = loadConfig();
      if (session) session.cfg = ctx.cfg; // company / throttle changes apply live
      if (session && key !== connKey(ctx.cfg)) {
        log.info('context', 'connection settings changed; reconnecting');
        session.close();
        session = null;
      }
    },
    async session() {
      if (session) return session;
      if (!connecting) {
        const s = new Session(ctx.cfg);
        connecting = s.connect().then(() => {
          session = s;
          key = connKey(ctx.cfg);
          s.admin.on('close', () => { if (session === s) session = null; });
          // New game or load on the host: map, cargo ids and the GS all changed. Drop the session;
          // the next call connects again and mirrors the new map.
          s.admin.on('newgame', () => { if (session === s) session = null; s.close(); });
          return s;
        }).finally(() => { connecting = null; });
      }
      return connecting;
    },
    close() { session?.close(); },
  };
  return ctx;
}
