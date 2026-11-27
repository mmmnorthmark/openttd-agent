// Relay liveness statistics (host only): per player last call, calls per minute, refusals.
// The relay records every call in memory and writes a small snapshot file (at most every 2 s);
// `relay-stats` reads it in another process. Never served through the relay itself.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { log } from './log.js';

export const RELAY_STATS_FILE = path.join(CONFIG_DIR, 'relay-stats.json');
const WINDOW_MS = 10 * 60_000; // keep call times for 10 minutes

/** Record one call. stats: { players: { name: entry } }; outcome 'ok' | 'refused' | 'error' | 'auth_failed'. Pure. */
export function recordCall(stats, { player, outcome, name, now = Date.now() }) {
  const key = player ?? '(unknown token)';
  const e = stats.players[key] ?? { calls: 0, refused: 0, errors: 0, last_call: null, last_command: null, last_refusal: null, recent: [] };
  e.calls++;
  if (outcome === 'refused' || outcome === 'auth_failed') { e.refused++; e.last_refusal = { t: new Date(now).toISOString(), name: name ?? null }; }
  if (outcome === 'error') e.errors++;
  e.last_call = new Date(now).toISOString();
  e.last_command = name ?? null;
  e.recent = [...e.recent.filter((t) => now - t < WINDOW_MS), now];
  stats.players[key] = e;
  stats.updated = new Date(now).toISOString();
  return e;
}

/** Readable view of a stats snapshot at `now`. Pure. */
export function statsView(stats, now = Date.now()) {
  const players = Object.entries(stats?.players ?? {}).map(([name, e]) => {
    const recent = (e.recent ?? []).filter((t) => now - t < WINDOW_MS);
    const lastMs = e.last_call ? now - Date.parse(e.last_call) : null;
    return { player: name, last_call: e.last_call, seconds_since_last_call: lastMs === null ? null : Math.round(lastMs / 1000), last_command: e.last_command,
      calls_last_minute: recent.filter((t) => now - t < 60_000).length, calls_per_min_10min: Math.round((recent.length / 10) * 10) / 10,
      calls_total: e.calls, refused_total: e.refused, errors_total: e.errors, last_refusal: e.last_refusal };
  }).sort((p, q) => (p.seconds_since_last_call ?? 1e12) - (q.seconds_since_last_call ?? 1e12));
  return { updated: stats?.updated ?? null, players };
}

/** In-memory recorder for the relay process, flushing to RELAY_STATS_FILE at most every 2 s. */
export function makeStatsRecorder(file = RELAY_STATS_FILE) {
  const stats = { started: new Date().toISOString(), players: {} };
  let timer = null;
  const flush = () => {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(stats), { mode: 0o600 });
    } catch (e) { log.warn('relay', 'stats write failed', { error: e.message }); }
  };
  return {
    stats,
    record(entry) {
      recordCall(stats, entry);
      if (!timer) { timer = setTimeout(flush, 2000); timer.unref?.(); }
    },
    flush,
  };
}

/** Read the snapshot the relay wrote, or null. */
export function readStats(file = RELAY_STATS_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
