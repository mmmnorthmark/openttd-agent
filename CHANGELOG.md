# Changelog

Semver. The GameScript has its own integer version (`GetVersion()` in info.nut); the host must
re-run `install-gamescript` when it changes.

## 0.1.0 (2026-11-24)
Verified end to end against a real OpenTTD 15.3 dedicated server (flat 256x256 and mountainous
512x512 maps): map mirror, opportunity queries, airport sites, rail termini, planned rail lines up
a 4-level climb, depots, trains, buses, orders, demolish guards, events.

- CLI (JSON output, batch mode, auto-started local daemon) and MCP server over one command registry.
- AgentBridge GameScript v5: world queries, airport checks, road build, rate limits, operate reads,
  events ring buffer, and `exec` (one step list for every state change, with dry run).
- Operate: stations, vehicles, vehicle (orders), engines, groups, depots, events, autorenew;
  vehicle buy/clone/start/stop/depot/sell/refit/rename; order add/remove/flags/skip/copy-share;
  group create/rename/delete/move/autoreplace.
- Construct: planned rail and road paths (bridges, level crossings, slopes), rail stations, depots,
  signals, terminus and passing-loop templates, road stations/depots, bridges, tunnels, terraform,
  guarded demolish, docks, buoys, ship depots, airports. All with dry run.
- World mirror with analysis: find-cargo-pairs, town-gaps, route-effort, airport-sites.
- Setup: doctor, install-gamescript, configure, launch (dedicated / host / join, `--terrain`,
  `--script_opcodes`).
- `build-track`: one rail piece, for junctions and depot spurs.

Fixed in the first real-game run:
- Launch profile now writes `[version] ini_version`, without which OpenTTD ignores secrets.cfg
  and the admin port never opens.
- GameScript died on any build or dry run (handlers were dispatched through native `.call()`).
- Company loan lookups, road depot / bay stop entrances, events never recorded.
- GS opcode budget 100000 per tick: full 256x256 map mirror 19 s -> 2.2 s (512x512: 8.4 s),
  no tick slowdown measured.
