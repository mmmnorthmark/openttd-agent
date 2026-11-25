// Host only: get a scenario from BaNaNaS (OpenTTD's content service) and make a copy of it
// that runs the AgentBridge GameScript.
//
// Why a copy: a loaded scenario or save runs only the GameScript stored in its own GSDT
// chunk (15.3 saveload/game_sl.cpp), so AgentBridge would not start. We save the running
// game (which has AgentBridge) as a donor, load the scenario, save it, and copy the donor's
// GSDT chunk into that save (src/savegame.js). Everything goes over the server console
// (rcon on the admin port); the saves are read from the server's save folder on this machine.
//
// Needs the server started with `[misc] savegame_format = none` (openttd-agent launch does that).

import fs from 'node:fs';
import path from 'node:path';
import { AdminClient } from './admin-client.js';
import { GSRpc } from './gs-rpc.js';
import { parseSavegame, patchTableFields, spliceChunks } from './savegame.js';
import { log } from './log.js';

const POLL_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Console line of `content state`: "id, type, state, name, unique id, md5" (the name may contain ", "). */
export function parseContentLine(line) {
  const parts = String(line).split(', ');
  if (parts.length < 6 || !/^\d+$/.test(parts[0])) return null;
  return { id: Number(parts[0]), type: parts[1], state: parts[2], name: parts.slice(3, -2).join(', '), unique_id: parts.at(-2) };
}

/** Pick one scenario from parsed content rows by numeric id or by name text. Throws with the candidates when unclear. */
export function pickContent(rows, { search, contentId }) {
  const scenarios = rows.filter((r) => r.type === 'Scenario');
  if (contentId !== undefined) {
    const hit = scenarios.find((r) => r.id === contentId);
    if (!hit) throw new Error(`no scenario with content id ${contentId} on BaNaNaS (${scenarios.length} scenarios listed). Find the id with --search <text>`);
    return hit;
  }
  const needle = String(search).toLowerCase();
  const hits = scenarios.filter((r) => r.name.toLowerCase().includes(needle));
  if (hits.length === 1) return hits[0];
  const exact = hits.filter((r) => r.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  if (hits.length === 0) throw new Error(`no scenario on BaNaNaS matches '${search}' (${scenarios.length} scenarios listed)`);
  const shown = hits.slice(0, 20).map((r) => `${r.id} ${r.name}`).join('; ');
  throw new Error(`${hits.length} scenarios match '${search}'; pass --content_id <id>. ${shown}${hits.length > 20 ? '; ...' : ''}`);
}

/** Console lines of `list_scenarios` ("3) Title (1.0)") -> [{ index, title }]. */
export function parseScenarioList(lines) {
  return lines.map((l) => /^(\d+)\) (.*)$/.exec(l)).filter(Boolean).map((m) => ({ index: Number(m[1]), title: m[2] }));
}

/**
 * Which entry of the server's scenario list is the downloaded content? Scenario titles are
 * "<content name> (<version>)". Prefer the entry that appeared with the download.
 */
export function pickScenarioEntry(list, contentName, titlesBefore = []) {
  const mine = list.filter((e) => e.title === contentName || e.title.startsWith(`${contentName} (`));
  const fresh = mine.filter((e) => !titlesBefore.includes(e.title));
  const pool = fresh.length ? fresh : mine;
  if (pool.length === 1) return pool[0];
  const added = list.filter((e) => !titlesBefore.includes(e.title));
  if (pool.length === 0 && added.length === 1) return added[0];
  throw new Error(`cannot tell which scenario on the server is '${contentName}' (${pool.length} candidates). Server list: ${list.map((e) => `${e.index}) ${e.title}`).join('; ') || 'empty'}`);
}

/** "Mini Empire Builder on 64x64" -> "mini_empire_builder_on_64x64" (safe as a console argument and file name). */
export const saveSlug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'scenario';

/** Poll `probe` until it returns something truthy; throws a readable timeout otherwise. */
async function until(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

/** Resolves when the server reports a running game again (after a load). Arm it BEFORE sending the load. */
function nextWelcome(admin, what, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { admin.off('welcome', done); reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}; see the server's openttd.log`)); }, timeoutMs);
    const done = (w) => { clearTimeout(timer); resolve(w); };
    admin.once('welcome', done);
  });
}

/**
 * Console `save <name>` and wait for the file. Saving runs in a server thread, so "saved" on the
 * console comes before the file is complete: wait until a file written after `since` parses to its end marker.
 */
async function saveAndRead(admin, saveDir, name, timeoutMs) {
  const file = path.join(saveDir, `${name}.sav`);
  const since = Date.now() - 2000; // file system timestamps can lag the clock a little
  const out = await admin.rcon(`save ${name}`, 30000);
  if (out.some((l) => /failed/i.test(l))) throw new Error(`server could not save '${name}': ${out.join(' ')}`);
  let lastError = 'file not written yet';
  try {
    return await until(`${file} to be written`, timeoutMs, () => {
      try {
        if (fs.statSync(file).mtimeMs < since) return null;
        const buf = fs.readFileSync(file);
        parseSavegame(buf);
        return buf;
      } catch (e) {
        lastError = e.message;
        if (/expected uncompressed/.test(e.message)) throw new Error(`${e.message}. The server writes compressed saves; restart it with: openttd-agent launch`);
        return null;
      }
    });
  } catch (e) { throw new Error(e.message.startsWith('timed out') ? `${e.message} (${lastError})` : e.message); }
}

async function loadAndWait(admin, consoleCommand, what, timeoutMs) {
  const loaded = nextWelcome(admin, what, timeoutMs);
  loaded.catch(() => {}); // a console error below wins over the timeout
  const out = await admin.rcon(consoleCommand, 30000);
  if (out.some((l) => /cannot be found|is not a/i.test(l))) throw new Error(`server refused '${consoleCommand}': ${out.join(' ')}`);
  return loaded;
}

/** The scenario's entry in the server's list; a fresh download can take a moment to be listed. */
async function findScenarioEntry(admin, contentName, titlesBefore) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const list = parseScenarioList(await admin.rcon('list_scenarios', 30000));
    try { return pickScenarioEntry(list, contentName, titlesBefore); } catch (e) { if (Date.now() > deadline) throw e; }
    await sleep(POLL_MS);
  }
}

/** Content rows once the list from BaNaNaS has arrived and stopped growing. */
async function contentRows(admin, timeoutMs) {
  let last = -1;
  return until('the content list from BaNaNaS (is this machine online?)', timeoutMs, async () => {
    const rows = (await admin.rcon('content state', 30000)).map(parseContentLine).filter(Boolean);
    const stable = rows.length > 0 && rows.length === last;
    last = rows.length;
    return stable ? rows : null;
  });
}

/**
 * cfg: { host, admin_port, admin_password }. One of search / contentId.
 * Returns { scenario, save_path, load_with, ... }. With load=false the game that was running is restored.
 */
export async function prepareScenario(cfg, { search, contentId, name, load = false, scriptOpcodes = 100000, timeoutMs = 180000 }) {
  if ((search === undefined) === (contentId === undefined)) throw new Error('give exactly one of --search <text> or --content_id <numeric id>');
  if (!cfg.admin_password) throw new Error('scenario-prepare runs on the host (it needs the admin password in the config; openttd-agent launch saves it)');
  if (name !== undefined && !/^[A-Za-z0-9_-]{1,48}$/.test(name)) throw new Error('name must be 1-48 of A-Z a-z 0-9 _ -');
  const admin = new AdminClient({ host: cfg.host, port: cfg.admin_port, password: cfg.admin_password, name: `openttd-agent-scenario-${process.pid}` });
  await admin.connect();
  const steps = [];
  const step = (msg, data = {}) => { steps.push(msg); log.info('scenario', msg, data); };
  try {
    const gs = new GSRpc(admin);
    const before = await gs.call('info', {}, 10000).catch((e) => {
      throw new Error(`the running game has no AgentBridge to copy (${e.message}). Start one first: openttd-agent launch`);
    });
    const saveDir = (await admin.rcon('pwd'))[0];
    if (!saveDir || !fs.existsSync(saveDir)) throw new Error(`cannot see the server's save folder '${saveDir}' from this machine; scenario-prepare must run on the host`);

    // 1. Find the scenario (before touching the game, so a bad search changes nothing).
    await admin.rcon('content update scenario');
    const content = pickContent(await contentRows(admin, timeoutMs), { search, contentId });
    // 2. Donor: the running game, with AgentBridge and its settings in the GSDT chunk.
    const donorName = 'agentbridge_donor';
    const donor = await saveAndRead(admin, saveDir, donorName, timeoutMs);
    if (!parseSavegame(donor).chunks.some((c) => c.id === 'GSDT')) throw new Error('the donor save has no GSDT chunk');
    step(`saved the running game as ${donorName}.sav`);

    // Download it unless the server already has it.
    const titlesBefore = parseScenarioList(await admin.rcon('list_scenarios', 30000)).map((e) => e.title);
    if (content.state !== 'Installed') {
      await admin.rcon('content unselect all');
      await admin.rcon(`content select ${content.id}`);
      const started = await admin.rcon('content download');
      step(`downloading '${content.name}' (${content.id}): ${started.join(' ')}`);
      await until(`'${content.name}' to download`, timeoutMs, async () => {
        const rows = (await admin.rcon('content state', 30000)).map(parseContentLine).filter(Boolean);
        const mine = rows.find((r) => r.id === content.id);
        if (mine?.state === 'Unknown') throw new Error(`BaNaNaS no longer has content ${content.id}`);
        return mine?.state === 'Installed' && !rows.some((r) => r.state === 'Selected' || r.state === 'Dep Selected');
      });
    } else {
      step(`'${content.name}' (${content.id}) is already downloaded`);
    }

    // 3. Load it and save it as a normal game.
    const entry = await findScenarioEntry(admin, content.name, titlesBefore);
    const welcome = await loadAndWait(admin, `load_scenario ${entry.index}`, `scenario '${entry.title}' to load`, timeoutMs);
    step(`loaded scenario '${entry.title}' (${welcome.mapX}x${welcome.mapY})`);
    const base = saveSlug(name ?? content.name);
    const baseBuf = await saveAndRead(admin, saveDir, `${base}_base`, timeoutMs);

    // 4. Write the playable copy: AgentBridge's GSDT chunk, plus two game settings a scenario brings
    // with it and the console refuses to change in a network game: the GameScript opcode budget
    // (usually 10000: slow map mirror) and command_pause_level 3 (agents may build while paused).
    const savePath = path.join(saveDir, `${base}_agent.sav`);
    const patched = patchTableFields(baseBuf, 'PATS', { 'script.script_max_opcode_till_suspend': scriptOpcodes, 'construction.command_pause_level': 3 });
    fs.writeFileSync(savePath, spliceChunks(patched.buf, donor, ['GSDT']));
    step(`wrote ${savePath}`);

    const result = {
      scenario: { content_id: content.id, unique_id: content.unique_id, name: content.name, title: entry.title, map_x: welcome.mapX, map_y: welcome.mapY },
      save_path: savePath,
      load_with: { running_server: `openttd-agent scenario-prepare --content_id ${content.id} --load true`, console: `load ${base}_agent`, new_server: `openttd-agent launch --load ${base}_agent` },
      settings_changed: { 'script.script_max_opcode_till_suspend': [patched.previous['script.script_max_opcode_till_suspend'], scriptOpcodes],
        'construction.command_pause_level': [patched.previous['construction.command_pause_level'], 3] },
    };

    // 5. Leave the server with AgentBridge running: the new copy, or the game we started from.
    await admin.rcon('ls'); // refresh the console's save list so `load` sees the new file
    const target = load ? `${base}_agent` : donorName;
    await loadAndWait(admin, `load ${target}`, `${target}.sav to load`, timeoutMs);
    const after = await until('AgentBridge to answer in the loaded game', 30000, () => gs.call('info', {}, 3000).catch(() => null));
    step(load ? `loaded ${target}; AgentBridge v${after.bridge_version} is running` : `restored the game that was running (${donorName}.sav)`);
    if (load && (after.map_x !== welcome.mapX || after.map_y !== welcome.mapY)) throw new Error(`loaded ${target} but the map is ${after.map_x}x${after.map_y}, expected ${welcome.mapX}x${welcome.mapY}`);
    return { ...result, loaded: load, server_now: load
      ? { game: `${base}_agent`, bridge_version: after.bridge_version, year: after.year, map_x: after.map_x, map_y: after.map_y, companies: 'none yet: join the game, or console `start_ai IdleAI` for a test company' }
      : { game: `${donorName} (the game that was running, year ${before.year})`, bridge_version: after.bridge_version },
      steps };
  } finally {
    admin.close();
  }
}
