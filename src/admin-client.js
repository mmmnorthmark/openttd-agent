// Minimal OpenTTD admin-port client (admin protocol v3, OpenTTD 15.x).
//
// Wire format: uint16 LE total length (incl. 3-byte header), uint8 packet type,
// payload. Strings are UTF-8, NUL-terminated.
// Login uses the password join (ADMIN_JOIN), so the server needs
// `network.allow_insecure_admin_login = true`. Intended for LAN games only.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { log } from './log.js';

export const PKT = {
  ADMIN_JOIN: 0, ADMIN_QUIT: 1, ADMIN_UPDATE_FREQUENCY: 2, ADMIN_POLL: 3,
  ADMIN_CHAT: 4, ADMIN_RCON: 5, ADMIN_GAMESCRIPT: 6, ADMIN_PING: 7,
  SERVER_FULL: 100, SERVER_BANNED: 101, SERVER_ERROR: 102, SERVER_PROTOCOL: 103,
  SERVER_WELCOME: 104, SERVER_NEWGAME: 105, SERVER_SHUTDOWN: 106, SERVER_DATE: 107,
  SERVER_CHAT: 119, SERVER_RCON: 120, SERVER_CONSOLE: 121, SERVER_GAMESCRIPT: 124,
  SERVER_RCON_END: 125, SERVER_PONG: 126,
};
export const UPDATE = { DATE: 0, CLIENT_INFO: 1, COMPANY_INFO: 2, COMPANY_ECONOMY: 3, COMPANY_STATS: 4, CHAT: 5, CONSOLE: 6, CMD_NAMES: 7, CMD_LOGGING: 8, GAMESCRIPT: 9 };
export const FREQ = { POLL: 1, DAILY: 2, WEEKLY: 4, MONTHLY: 8, QUARTERLY: 16, ANNUALLY: 32, AUTOMATIC: 64 };
export const ADMIN_TO_GS_JSON_LIMIT = 9000; // NETWORK_GAMESCRIPT_JSON_LENGTH
const SERVER_ERROR_NAMES = { 6: 'NOT_AUTHORIZED', 9: 'WRONG_PASSWORD', 10: 'NOT_EXPECTED', 13: 'ILLEGAL_PACKET' };

export function encodePacket(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(3);
  header.writeUInt16LE(payload.length + 3, 0);
  header.writeUInt8(type, 2);
  return Buffer.concat([header, payload]);
}

export function cstr(s) {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}

export class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u8() { return this.buf.readUInt8(this.pos++); }
  u16() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  str() {
    const end = this.buf.indexOf(0, this.pos);
    const s = this.buf.toString('utf8', this.pos, end < 0 ? this.buf.length : end);
    this.pos = end < 0 ? this.buf.length : end + 1;
    return s;
  }
}

/** Splits a TCP byte stream into [type, body] packets. */
export class PacketSplitter {
  constructor() { this.pending = Buffer.alloc(0); }
  push(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    const out = [];
    while (this.pending.length >= 3) {
      const size = this.pending.readUInt16LE(0);
      if (size < 3) throw new Error(`corrupt admin packet size ${size}`);
      if (this.pending.length < size) break;
      out.push([this.pending.readUInt8(2), this.pending.subarray(3, size)]);
      this.pending = this.pending.subarray(size);
    }
    return out;
  }
}

/**
 * Events: 'gamescript' (obj), 'chat' ({action, clientId, message}),
 * 'date' (int), 'close' (reason).
 */
export class AdminClient extends EventEmitter {
  constructor({ host, port, password, name = 'openttd-agent' }) {
    super();
    Object.assign(this, { host, port, password, name });
    this.sock = null;
    this.welcome = null;
    this.closed = false;
    this._rcon = null; // { lines, resolve, reject, timer }
    this._rconQueue = Promise.resolve();
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const splitter = new PacketSplitter();
      const timer = setTimeout(() => fail(new Error(`no welcome from ${this.host}:${this.port} within ${timeoutMs}ms`)), timeoutMs);
      const fail = (err) => { clearTimeout(timer); this.sock?.destroy(); reject(err); };
      this._onWelcome = (w) => { clearTimeout(timer); resolve(w); };
      this._onLoginError = fail;
      this.sock = net.createConnection({ host: this.host, port: this.port }, () => {
        this._send(PKT.ADMIN_JOIN, Buffer.concat([cstr(this.password), cstr(this.name), cstr('openttd-agent')]));
      });
      this.sock.on('data', (chunk) => {
        try {
          for (const [type, body] of splitter.push(chunk)) this._dispatch(type, new Reader(body));
        } catch (e) { log.error('admin', 'packet handling failed', { error: String(e) }); }
      });
      this.sock.on('error', (e) => { if (!this.welcome) fail(new Error(`admin connect to ${this.host}:${this.port} failed: ${e.message}`)); else log.error('admin', 'socket error', { error: e.message }); });
      this.sock.on('close', () => {
        if (this._rcon) this._rcon.reject(new Error('admin connection closed'));
        if (!this.closed) log.warn('admin', 'connection closed by server');
        this.emit('close', 'closed');
      });
    });
  }

  close() {
    this.closed = true;
    try { this._send(PKT.ADMIN_QUIT); } catch { /* already gone */ }
    this.sock?.end();
  }

  subscribe(updateType, freq = FREQ.AUTOMATIC) {
    const b = Buffer.alloc(4);
    b.writeUInt16LE(updateType, 0);
    b.writeUInt16LE(freq, 2);
    this._send(PKT.ADMIN_UPDATE_FREQUENCY, b);
  }

  /** Runs a console command on the server; resolves to its output lines. Serialized. */
  rcon(command, timeoutMs = 10000) {
    const run = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._rcon = null; reject(new Error(`rcon '${command}' timed out`)); }, timeoutMs);
      this._rcon = {
        lines: [],
        resolve: (lines) => { clearTimeout(timer); this._rcon = null; resolve(lines); },
        reject: (e) => { clearTimeout(timer); this._rcon = null; reject(e); },
      };
      this._send(PKT.ADMIN_RCON, cstr(command));
    });
    const p = this._rconQueue.then(run, run);
    this._rconQueue = p.catch(() => {});
    return p;
  }

  sendGamescript(obj) {
    const payload = JSON.stringify(obj);
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes >= ADMIN_TO_GS_JSON_LIMIT) throw new Error(`GS request too large: ${bytes} bytes (limit ${ADMIN_TO_GS_JSON_LIMIT})`);
    this._send(PKT.ADMIN_GAMESCRIPT, cstr(payload));
  }

  /** Broadcast a chat line to all players (shown as from the admin). */
  chat(message) {
    const b = Buffer.alloc(6);
    b.writeUInt8(3, 0); // NETWORK_ACTION_CHAT
    b.writeUInt8(0, 1); // DESTTYPE_BROADCAST
    b.writeUInt32LE(0, 2);
    this._send(PKT.ADMIN_CHAT, Buffer.concat([b, cstr(message)]));
  }

  _send(type, payload) {
    if (!this.sock || this.sock.destroyed) throw new Error('admin connection is not open');
    this.sock.write(encodePacket(type, payload));
  }

  _dispatch(type, r) {
    switch (type) {
      case PKT.SERVER_PROTOCOL: return;
      case PKT.SERVER_WELCOME: {
        const serverName = r.str(), revision = r.str(), dedicated = r.u8() === 1;
        r.str(); // formerly map name
        this.welcome = { serverName, revision, dedicated, seed: r.u32(), landscape: r.u8(), startDate: r.u32(), mapX: r.u16(), mapY: r.u16() };
        log.info('admin', 'connected', this.welcome);
        this._onWelcome?.(this.welcome);
        return;
      }
      case PKT.SERVER_ERROR: {
        const code = r.u8();
        const err = new Error(`admin login refused: ${SERVER_ERROR_NAMES[code] ?? code}. Check admin_password and that allow_insecure_admin_login = true on the host.`);
        if (!this.welcome) this._onLoginError?.(err); else log.error('admin', err.message);
        return;
      }
      case PKT.SERVER_FULL: case PKT.SERVER_BANNED: case PKT.SERVER_SHUTDOWN:
        log.warn('admin', 'server refused or shut down', { type });
        return;
      case PKT.SERVER_NEWGAME:
        this.emit('newgame');
        return;
      case PKT.SERVER_DATE:
        this.emit('date', r.u32());
        return;
      case PKT.SERVER_RCON:
        r.u16(); // colour
        this._rcon?.lines.push(r.str());
        return;
      case PKT.SERVER_RCON_END:
        this._rcon?.resolve(this._rcon.lines);
        return;
      case PKT.SERVER_GAMESCRIPT: {
        const raw = r.str();
        let obj;
        try { obj = JSON.parse(raw); } catch { log.error('admin', 'bad GS JSON', { raw: raw.slice(0, 200) }); return; }
        this.emit('gamescript', obj);
        return;
      }
      case PKT.SERVER_CHAT: {
        const action = r.u8(); r.u8();
        const clientId = r.u32();
        this.emit('chat', { action, clientId, message: r.str() });
        return;
      }
      default:
        return;
    }
  }
}
