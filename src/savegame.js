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

// ---- table fields ---------------------------------------------------------------------------
// A CH_TABLE chunk's first element is its header: (type byte, gamma-length name) pairs ended by
// a zero type byte; each later element is one record with the fields in header order.
// Type byte: low nibble = SLE_FILE_* (1/2 = 8 bit, 3/4 = 16, 5/6 = 32, 7/8 = 64, 9 = string id,
// 10 = string, 11 = struct), bit 4 = the field is a list with a gamma count first. Integers are big-endian.

const CH_TABLE = 3;
const FILE_TYPE_MASK = 0x0f;
const FILE_HAS_LENGTH = 0x10;
const FILE_STRUCT = 11;
const FILE_SIZES = [0, 1, 1, 2, 2, 4, 4, 8, 8, 2, 1];

/**
 * Return a copy of `buf` with integer fields of the first record of table chunk `chunkId` set:
 * `values` is { fieldName: integer }. Used for game settings (chunk PATS, names like
 * "construction.command_pause_level") that the console refuses to change in a network game.
 * Returns { buf, previous: { fieldName: old value } }. Throws if a field is missing or not a plain integer.
 */
export function patchTableFields(buf, chunkId, values) {
  const chunk = parseSavegame(buf).chunks.find((c) => c.id === chunkId);
  if (!chunk) throw new Error(`savegame: no ${chunkId} chunk`);
  if ((buf[chunk.start + 4] & CH_TYPE_MASK) !== CH_TABLE) throw new Error(`savegame: chunk ${chunkId} is not a table`);
  const out = Buffer.from(buf);
  let [len, pos] = readGamma(out, chunk.start + 5);
  const headerEnd = pos + len - 1;
  const fields = [];
  for (;;) {
    const type = out[pos++];
    if (type === 0) break;
    let n;
    [n, pos] = readGamma(out, pos);
    fields.push({ type, name: out.toString('utf8', pos, pos + n) });
    pos += n;
  }
  if (fields.some((f) => (f.type & FILE_TYPE_MASK) === FILE_STRUCT)) throw new Error(`savegame: chunk ${chunkId} has nested structs; not supported`);
  if (pos !== headerEnd) throw new Error(`savegame: chunk ${chunkId} header is ${headerEnd - pos} bytes longer than its field list`);
  [len, pos] = readGamma(out, pos);
  if (len === 0) throw new Error(`savegame: chunk ${chunkId} has no record`);
  const recordEnd = pos + len - 1;
  const wanted = new Map(Object.entries(values));
  const previous = {};
  for (const f of fields) {
    const size = FILE_SIZES[f.type & FILE_TYPE_MASK];
    if (size === undefined || size === 0) throw new Error(`savegame: field ${f.name} has unknown type 0x${f.type.toString(16)}`);
    let count = 1;
    if (f.type & FILE_HAS_LENGTH) [count, pos] = readGamma(out, pos);
    if (wanted.has(f.name)) {
      const v = wanted.get(f.name);
      if ((f.type & FILE_HAS_LENGTH) || size > 4) throw new Error(`savegame: field ${f.name} is not a plain 8/16/32-bit integer`);
      if (!Number.isInteger(v) || v < 0 || v >= 2 ** (8 * size)) throw new Error(`savegame: ${v} does not fit field ${f.name} (${size} bytes)`);
      previous[f.name] = out.readUIntBE(pos, size);
      out.writeUIntBE(v, pos, size);
      wanted.delete(f.name);
    }
    pos += count * size;
  }
  if (pos !== recordEnd) throw new Error(`savegame: chunk ${chunkId} record does not match its header (off by ${recordEnd - pos} bytes)`);
  if (wanted.size) throw new Error(`savegame: chunk ${chunkId} has no field ${[...wanted.keys()].join(', ')}`);
  return { buf: out, previous };
}
