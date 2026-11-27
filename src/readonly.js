// Read-only mode (L12) and the read/write class of every command. Pure; test/readonly.test.js
// fails when a registry command is in no class, so a new command must be added here.
//
// OPENTTD_AGENT_READ_ONLY=1 (CLI, daemon calls, MCP) or `mcp --read_only true`:
//   - a command with a dry_run argument runs as a dry run (result: forced_dry_run: true);
//   - a READ command runs as usual;
//   - SHOW_OR_SET commands run when only the listed show arguments are given;
//   - everything else is refused (first_error: read_only); nothing is sent to the game.

/** Commands that change nothing (and take no dry_run). */
export const READ_COMMANDS = new Set([
  'doctor', 'guide', 'show-config', 'relay-list-players', 'relay-stats',
  'status', 'companies', 'rating', 'goal-status',
  'cargos', 'industry-types', 'towns', 'industries', 'find-cargo-pairs', 'acceptance', 'town-gaps', 'route-effort',
  'airport-types', 'airport-sites', 'tiles', 'rail-tiles', 'signs', 'owned-land',
  'saves', 'server-log',
  'test-build-road', 'rail-types', 'road-types', 'bridge-types', 'station-sites', 'loop-sites',
  'stations', 'vehicles', 'vehicle', 'summary', 'vehicle-problems', 'verify-route', 'engines', 'groups', 'depots', 'events', 'overview',
  'wait', 'road-stop-sites',
]);

/** Show-or-set commands: a read when only these arguments are given. */
export const SHOW_OR_SET = { rate: [], autorenew: ['company'] };

/** Commands that change something: refused in read-only mode (checked before dry_run). */
export const WRITE_COMMANDS = new Set([
  'install-gamescript', 'configure', 'scenario-prepare', 'relay-add-player', 'relay-set-company', 'relay-remove-player',
  'chat', 'goal-set', 'pause', 'unpause', 'turn-advance', 'goal-clear', 'save',
  'load', 'server-stop', 'console', 'company-new',
  'launch', // starts or restarts a server: refused even when asked as a dry run (host decision)
]);

/** Is read-only mode asked for by the environment? */
export const readOnlyFromEnv = (env = process.env) => ['1', 'true', 'yes'].includes(String(env.OPENTTD_AGENT_READ_ONLY ?? '').toLowerCase());

/** The class of a command: 'dry_run' | 'read' | 'show_or_set' | 'write' | null (unclassified). */
export function commandClass(name, known) {
  if (WRITE_COMMANDS.has(name)) return 'write';
  if (known.includes('dry_run')) return 'dry_run';
  if (READ_COMMANDS.has(name)) return 'read';
  if (name in SHOW_OR_SET) return 'show_or_set';
  return null;
}

/**
 * Read-only gate for one call. Returns { args, forced } (args possibly with dry_run=true) or
 * throws a read_only refusal. Unclassified commands are refused too.
 */
export function readOnlyGate(name, known, args) {
  const cls = commandClass(name, known);
  if (cls === 'read') return { args, forced: false };
  if (cls === 'dry_run') {
    const asked = args.dry_run;
    const already = asked === true || asked === 'true';
    return { args: { ...args, dry_run: true }, forced: !already };
  }
  if (cls === 'show_or_set' && Object.keys(args).every((k) => SHOW_OR_SET[name].includes(k))) return { args, forced: false };
  throw new Error(`read_only: '${name}' changes the game and this session is read-only (OPENTTD_AGENT_READ_ONLY / mcp --read_only); nothing was run`);
}
