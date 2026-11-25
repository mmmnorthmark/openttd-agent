# Changelog

Semver. The GameScript has its own integer version (`GetVersion()` in info.nut); the host must
re-run `install-gamescript` when it changes.

## (unreleased)

- `mcp --tools a,b,c` serves only those commands as MCP tools (every tool schema is sent with
  each model request; a few tight tools suit small models), with shorter server instructions.
  `mcp --compact true` returns tool results as single-line JSON.
- GameScript v8 (the host re-runs `install-gamescript`; a running game picks it up when it is
  loaded again): `loan` exec step.
- `loan` (player, own company): show the loan, or change it with one of `--amount N` (set),
  `--borrow N`, `--repay N` or `--max true`; `--dry_run true` predicts. The new loan is rounded up
  to the loan interval; refused below 0, over `max_loan`, or when repaying needs more cash than
  the company has. Returns loan, max_loan and money before and after. With an older running
  GameScript it says to re-run `install-gamescript` and load the game again.

## 0.2.0 (2026-11-25)
Per-player access replaces the shared admin password. BaNaNaS scenarios, goals and turn-based
play. GameScript v7: the host re-runs `install-gamescript` (a running game picks it up when it is
loaded again).

- `openttd-agent relay` (host): the only admin-port client. Players send commands to it over HTTP
  with their own token; it forces every command to the company the host bound that player to,
  refuses host-only commands (launch, install-gamescript, configure, rate changes; there is no raw
  rcon), applies a per-player `max_builds_per_minute`, prefixes chat with the player's name and
  writes `~/.openttd-agent/relay-audit.jsonl`.
- Host commands: `relay-add-player` (prints the token once; only its SHA-256 is stored),
  `relay-list-players`, `relay-set-company` (bind a `pending` player later), `relay-remove-player`.
- Players: `configure --relay http://<host-LAN-IP>:47978 --token <token>`. CLI, MCP and the library
  then run game commands through the relay; no admin password and no local daemon. Analysis and
  path planning run on the relay's shared map mirror.
- `launch` generates and saves a random admin password when none is configured, and reports
  whether the admin port is reachable from the LAN (OpenTTD binds it like the game port).
- New config keys: `relay`, `relay_token`, `relay_port` (default 47978).
- `scenario-prepare` (host): downloads a scenario from BaNaNaS into the running server and writes
  `<name>_agent.sav`, a copy that runs AgentBridge (a scenario loaded as-is runs only the
  GameScript saved in it). `--load true` switches the server to it.
- `launch --load <save name>` finds saves in the profile's save folder. Launch profiles now write
  uncompressed saves (`savegame_format = none`; larger files and map downloads) and allow all
  actions while paused (`command_pause_level = 3`) for new games.
- Goals (AgentBridge v6): `goal-set` / `goal-clear` (host) and `goal-status` (players, own company).
  Per company: cargo delivery targets and/or a company value by the end of a year; shown in the
  goal window, saved with the game, `goal_done` / `goal_failed` events.
- Turn-based play (host): `pause`, `unpause`, `turn-advance --days N` (run N game days, pause
  again, return the date and events).
- A daemon or relay now reconnects by itself after the host loads another game.
- `station-sites`: dry-run-checked rail terminus spots next to an industry, town or tile, facing
  the other end of the planned line, each with a ready `build-terminus` line and `connect_at`.
- `build-line-depot --station <id>`: finds a straight piece of your line near a station, builds a
  rail depot beside it and joins it both ways in one call.
- Unknown flags are refused (nothing runs) instead of ignored; `<command> --help` prints one
  command's arguments.
- `build-cargo-route`: a whole rail route in one call: a terminus at each end facing the other,
  the line between them, a depot beside it, one train (cheapest-to-run locomotive that can pull
  the cargo, wagons that carry it, filling the platform), orders (full load at the source, unload
  and leave empty at the destination; plain both ways for passengers/mail between towns) and
  start. `--dry_run true` checks every placement and the line and returns `estimated_cost`. A
  failure stops at that step and lists what was built (station ids, tiles, vehicle); nothing is
  demolished. Default rail type: the one with the cheapest track.
- `find-cargo-pairs` also pairs sources with towns: goods, passengers, mail, food... go to towns
  whose centre accepts them (acceptance >= 8, reported per pair). `--dest_kind any|industry|town`.
  Secondary (processing) industries are marked `secondary: true` in `industries` and
  `find-cargo-pairs` and are kept by `--min_production` (they show last_month 0 until supplied).
- `acceptance --x --y [--radius 4] [--width --height] [--cargo]`: per-cargo acceptance of a
  station spot (AgentBridge v7, `GSTile.GetCargoAcceptance`). With an older AgentBridge,
  `find-cargo-pairs` lists towns unchecked (acceptance null) with a note.

Migrating from 0.1.0: the host stops sharing the admin password (change it), runs `relay`, and
registers players; players replace `configure --host/--admin_password/--company` with
`configure --relay/--token` (and may clear the old password with `configure --admin_password ""`).

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
