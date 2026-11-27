// Request/response over the AgentBridge GameScript.
// GS replies are broadcast to every admin, so each client tags requests with a
// random `client` id and only accepts replies carrying it.

import { randomBytes } from 'node:crypto';
import { UPDATE, FREQ } from './admin-client.js';
import { log } from './log.js';

export class GSError extends Error {}

export class GSRpc {
  constructor(admin) {
    this.admin = admin;
    this.client = randomBytes(4).toString('hex');
    this.nextId = 1;
    this.pending = new Map(); // id -> { parts: Map, lastPart, resolve, reject, timer, cmd, started }
    // Optional () -> { code, detail } | null, called on a timeout: the host's server log says whether the GS died (host.js diagnoseGs).
    this.diagnose = null;
    admin.on('gamescript', (msg) => this._onMessage(msg));
    admin.subscribe(UPDATE.GAMESCRIPT, FREQ.AUTOMATIC);
  }

  call(cmd, args = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const what = `GS cmd '${cmd}' timed out after ${timeoutMs}ms`;
        let d = null;
        try { d = this.diagnose?.() ?? null; } catch { /* no diagnosis: plain timeout */ }
        reject(new GSError(d ? `${d.code}: ${what}; ${d.detail}` : `gs_timeout: ${what}. Is the AgentBridge GameScript running on the host? (openttd-agent doctor, server-log --errors true)`));
      }, timeoutMs);
      this.pending.set(id, { parts: new Map(), lastPart: null, resolve, reject, timer, cmd, started: Date.now() });
      try {
        this.admin.sendGamescript({ id, client: this.client, cmd, args });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _onMessage(msg) {
    if (msg.client !== this.client) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (!msg.ok) {
      this._finish(msg.id, p);
      p.reject(new GSError(`GS cmd '${p.cmd}' failed: ${msg.error}`));
      return;
    }
    p.parts.set(msg.part ?? 0, msg.data);
    if (msg.last) p.lastPart = msg.part ?? 0;
    if (p.lastPart !== null && p.parts.size === p.lastPart + 1) {
      this._finish(msg.id, p);
      p.resolve(assembleParts(p.parts));
    }
  }

  _finish(id, p) {
    clearTimeout(p.timer);
    this.pending.delete(id);
    log.debug('gs', 'reply', { cmd: p.cmd, id, parts: p.parts.size, ms: Date.now() - p.started });
  }
}

/** Single non-array part -> that value; otherwise arrays concatenated in part order. */
export function assembleParts(parts) {
  const ordered = [...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k));
  if (ordered.length === 1 && !Array.isArray(ordered[0])) return ordered[0];
  return ordered.flatMap((chunk) => chunk ?? []);
}
