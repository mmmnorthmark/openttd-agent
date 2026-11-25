// Host-side player registry for the relay: <config dir>/relay-players.json (mode 0600).
// Only a SHA-256 hash of each token is stored; the token itself is shown once
// by addPlayer. Tokens are 32 random bytes, so a plain hash is enough (nothing
// to brute-force). Shape: { players: [{ name, company, token_sha256, created, max_builds_per_minute? }] }
// company is an integer or null (= pending: the host binds it later).

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONFIG_DIR } from './config.js';

export const PLAYERS_FILE = path.join(CONFIG_DIR, 'relay-players.json');
const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;

const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

export function loadPlayers() {
  if (!fs.existsSync(PLAYERS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8')).players ?? [];
}

function savePlayers(players) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PLAYERS_FILE, JSON.stringify({ players }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(PLAYERS_FILE, 0o600); // writeFileSync's mode only applies when the file is created
}

/** 'pending' | '' | null | undefined -> null; otherwise a company id >= 0. */
export function parseCompany(value) {
  if (value === undefined || value === null || value === '' || value === 'pending') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 14) throw new Error(`company must be 'pending' or a company id 0..14 (see: openttd-agent companies), got '${value}'`);
  return n;
}

const publicView = (p) => ({ name: p.name, company: p.company ?? 'pending', created: p.created,
  max_builds_per_minute: p.max_builds_per_minute ?? 'relay default' });

function findOrThrow(players, name) {
  const p = players.find((x) => x.name === name);
  if (!p) throw new Error(`no player named '${name}'. Registered: ${players.map((x) => x.name).join(', ') || '(none)'}`);
  return p;
}

/** Register a player and return the token (the only time it is available). */
export function addPlayer({ name, company, maxBuildsPerMinute }) {
  if (!NAME_RE.test(String(name ?? ''))) throw new Error('name must be 1-32 characters from A-Z a-z 0-9 _ . -');
  const players = loadPlayers();
  if (players.some((p) => p.name === name)) throw new Error(`player '${name}' already exists; relay-remove-player it first to issue a new token`);
  const token = randomBytes(32).toString('base64url');
  const player = { name, company: parseCompany(company), token_sha256: hashToken(token), created: new Date().toISOString(),
    ...(maxBuildsPerMinute !== undefined ? { max_builds_per_minute: maxBuildsPerMinute } : {}) };
  savePlayers([...players, player]);
  return { ...publicView(player), token };
}

export function listPlayers() {
  return loadPlayers().map(publicView);
}

export function removePlayer(name) {
  const players = loadPlayers();
  findOrThrow(players, name);
  savePlayers(players.filter((p) => p.name !== name));
  return { removed: name };
}

/** Bind (or re-bind, or un-bind with 'pending') a player to a company; optionally change their rate limit. */
export function updatePlayer(name, { company, maxBuildsPerMinute } = {}) {
  const players = loadPlayers();
  const p = findOrThrow(players, name);
  if (company !== undefined) p.company = parseCompany(company);
  if (maxBuildsPerMinute !== undefined) p.max_builds_per_minute = maxBuildsPerMinute;
  savePlayers(players);
  return publicView(p);
}

/** The player whose token this is, or null. */
export function playerForToken(token, players = loadPlayers()) {
  if (!token) return null;
  const given = Buffer.from(hashToken(token), 'hex');
  return players.find((p) => {
    const stored = Buffer.from(String(p.token_sha256 ?? ''), 'hex');
    return stored.length === given.length && timingSafeEqual(stored, given);
  }) ?? null;
}
