// Minimal OpenTTD savegame chunk reader/splicer (format from 15.3 src/saveload/saveload.cpp).
// Only UNCOMPRESSED saves ('OTTN', written when openttd.cfg has [misc] savegame_format = none).
// Layout: 4-byte tag, 4-byte version, then chunks until a 4-byte zero id:
//   id (4 bytes) + mode byte m; type = m & 0x0F
//   RIFF (0): length = ((m >> 4) << 24) | byte << 16 | uint16 BE, then that many bytes
//   ARRAY/SPARSE_ARRAY/TABLE/SPARSE_TABLE (1,2,3,4): elements of [gamma len][len-1 bytes] until gamma 0
//   (table types' first element is the header; sparse elements include their index in len)
// Used to put the AgentBridge GameScript config (GSDT chunk) into a scenario, which otherwise
// runs only the GameScript saved inside it (15.3 saveload/game_sl.cpp).

const CH_RIFF = 0;
const CH_TYPE_MASK = 0x0f;

function readGamma(buf, pos) {
  let i = buf[pos++];
  if (i & 0x80) {
    i &= ~0x80;
    if (i & 0x40) {
      i &= ~0x40;
      if (i & 0x20) {
        i &= ~0x20;
        if (i & 0x10) {
          if (i & 0x08) throw new Error('savegame: unsupported gamma');
          i = buf[pos++];
        }
        i = (i << 8) | buf[pos++];
      }
      i = (i << 8) | buf[pos++];
    }
    i = (i << 8) | buf[pos++];
  }
  return [i >>> 0, pos];
}

/** Parse an uncompressed save into { header, chunks: [{id, start, end}] } (byte offsets into buf). */
export function parseSavegame(buf) {
  const tag = buf.toString('latin1', 0, 4);
  if (tag !== 'OTTN') throw new Error(`savegame: expected uncompressed 'OTTN' save, got '${tag}' (set [misc] savegame_format = none)`);
  const chunks = [];
  let pos = 8;
  for (;;) {
    if (pos + 4 > buf.length) throw new Error('savegame: truncated before end marker');
    const id = buf.toString('latin1', pos, pos + 4);
    if (buf.readUInt32BE(pos) === 0) {
      if (pos + 4 !== buf.length) throw new Error(`savegame: ${buf.length - pos - 4} bytes after end marker`);
      return { header: buf.subarray(0, 8), chunks, endMarker: pos };
    }
    const start = pos;
    const m = buf[pos + 4];
    pos += 5;
    const type = m & CH_TYPE_MASK;
    if (type === CH_RIFF) {
      const len = ((m >> 4) << 24) | (buf[pos] << 16) | buf.readUInt16BE(pos + 1);
      pos += 3 + len;
    } else if (type >= 1 && type <= 4) {
      for (;;) {
        let len;
        [len, pos] = readGamma(buf, pos);
        if (len === 0) break;
        pos += len - 1;
      }
    } else {
      throw new Error(`savegame: chunk ${id} has unknown type ${type} at offset ${start}`);
    }
    if (pos > buf.length) throw new Error(`savegame: chunk ${id} runs past end of file`);
    chunks.push({ id, start, end: pos });
  }
}

/** Return a copy of `target` with each chunk id in `ids` replaced by (or appended from) `donor`'s. */
export function spliceChunks(target, donor, ids) {
  const t = parseSavegame(target);
  const d = parseSavegame(donor);
  const parts = [t.header];
  const done = new Set();
  for (const c of t.chunks) {
    if (ids.includes(c.id)) {
      const dc = d.chunks.find((x) => x.id === c.id);
      if (!dc) throw new Error(`savegame: donor has no ${c.id} chunk`);
      parts.push(donor.subarray(dc.start, dc.end));
      done.add(c.id);
    } else {
      parts.push(target.subarray(c.start, c.end));
    }
  }
  for (const id of ids) {
    if (done.has(id)) continue;
    const dc = d.chunks.find((x) => x.id === id);
    if (!dc) throw new Error(`savegame: neither save has a ${id} chunk`);
    parts.push(donor.subarray(dc.start, dc.end));
  }
  parts.push(Buffer.alloc(4));
  const out = Buffer.concat(parts);
  parseSavegame(out); // self-check: the result must parse to the end marker
  return out;
}
