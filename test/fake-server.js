// Fake OpenTTD admin server + AgentBridge GS for tests. Speaks the real admin
// wire format and the GS reply protocol (including multi-part chunking).

import net from 'node:net';
import { PKT, PacketSplitter, Reader, encodePacket, cstr } from '../src/admin-client.js';

export const FAKE_MAP = 64;

// 64x64 world: flat clear land height 2, a water column at x=30 (y 0..63) except
// a land bridge at y=50..52, a "town" block of houses at 40..44,10..14.
export function fakeTileClass(x, y) {
  if (x === 30 && !(y >= 50 && y <= 52)) return 'w';
  if (x >= 40 && x <= 44 && y >= 10 && y <= 14) return 'o';
  return 'b';
}

function dumpRows({ y0, y1, x0 = 0, x1 = FAKE_MAP - 1 }) {
  const out = [];
  for (let y = y0; y <= y1; y++) {
    let s = `${y},${x0},`;
    for (let x = x0; x <= x1; x++) s += '02' + '0' + fakeTileClass(x, y);
    out.push(s);
  }
  return out;
}

const GS = {
  info: () => ({ tick: 1, date: 1, year: 1950, month: 1, day: 1, map_x: FAKE_MAP, map_y: FAKE_MAP, landscape: 0, paused: false, towns: 2, industries: 3, bridge_version: 2 }),
  cargos: () => [{ id: 0, label: 'PASS', name: 'Passengers', passengers: true }, { id: 7, label: 'WOOD', name: 'Wood', passengers: false }],
  industry_types: () => [{ id: 3, name: 'Forest', produces: [7], accepts: [] }, { id: 4, name: 'Sawmill', produces: [], accepts: [7] }],
  industries: () => [
    [1, 3, 10, 20, [[7, 120, 0]], 0],
    [2, 4, 50, 20, [], 0],
    [3, 3, 5, 60, [[7, 80, 75]], 1],
  ],
  towns: () => [[1, 'Bigton', 42, 12, 5000, false, 800, 10, 200, 0, 6], [2, 'Smallham', 10, 50, 300, false, 40, 0, 10, 0, 2]],
  companies: () => [{ id: 0, name: 'Matthew Transport', money: 100000, loan: 300000 }],
  get_rate: () => ({ command_delay_ticks: 0, max_builds_per_day: 0 }),
  dump_tiles: dumpRows,
  echo: (a) => a,
  build_road: (a) => ({ ok: true, cost: 1234, error: '', money: 98766, echoed_company: a.company }),
};

export function startFakeServer({ password = 'pw' } = {}) {
  const received = [];
  const server = net.createServer((sock) => {
    const splitter = new PacketSplitter();
    const send = (type, payload) => sock.write(encodePacket(type, payload));
    sock.on('data', (chunk) => {
      for (const [type, body] of splitter.push(chunk)) {
        const r = new Reader(body);
        if (type === PKT.ADMIN_JOIN) {
          if (r.str() !== password) { send(PKT.SERVER_ERROR, Buffer.from([9])); continue; }
          send(PKT.SERVER_PROTOCOL, Buffer.from([3, 0]));
          const tail = Buffer.alloc(4 + 1 + 4 + 2 + 2);
          tail.writeUInt32LE(42, 0); tail.writeUInt8(0, 4); tail.writeUInt32LE(0, 5); tail.writeUInt16LE(FAKE_MAP, 9); tail.writeUInt16LE(FAKE_MAP, 11);
          send(PKT.SERVER_WELCOME, Buffer.concat([cstr('fake'), cstr('15.3'), Buffer.from([1]), cstr(''), tail]));
        } else if (type === PKT.ADMIN_GAMESCRIPT) {
          const req = JSON.parse(r.str());
          received.push(req);
          const handler = GS[req.cmd];
          const base = { id: req.id, client: req.client };
          if (!handler) { send(PKT.SERVER_GAMESCRIPT, cstr(JSON.stringify({ ...base, ok: false, part: 0, last: true, error: `unknown cmd: ${req.cmd}` }))); continue; }
          const data = handler(req.args ?? {});
          // Also send a reply for some other client to prove filtering works.
          send(PKT.SERVER_GAMESCRIPT, cstr(JSON.stringify({ id: req.id, client: 'someone-else', ok: true, part: 0, last: true, data: 'not for you' })));
          if (Array.isArray(data) && data.length > 1) {
            const half = Math.ceil(data.length / 2);
            send(PKT.SERVER_GAMESCRIPT, cstr(JSON.stringify({ ...base, ok: true, part: 0, last: false, data: data.slice(0, half) })));
            send(PKT.SERVER_GAMESCRIPT, cstr(JSON.stringify({ ...base, ok: true, part: 1, last: true, data: data.slice(half) })));
          } else {
            send(PKT.SERVER_GAMESCRIPT, cstr(JSON.stringify({ ...base, ok: true, part: 0, last: true, data })));
          }
        } else if (type === PKT.ADMIN_RCON) {
          send(PKT.SERVER_RCON, Buffer.concat([Buffer.from([1, 0]), cstr(`ran: ${r.str()}`)]));
          send(PKT.SERVER_RCON_END, cstr('x'));
        }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received })));
}
