# Changelog

Semver. The GameScript has its own integer version (`GetVersion()` in info.nut); the host must
re-run `install-gamescript` when it changes.

## 0.6.0 (2026-11-25)

- `purchase-land --x0 --y0 --x1 --y1 [--dry_run true]` (build, your company): buys a rectangle as
  owned land ("Purchase land for future use"), any two opposite corners, at most 400 tiles per
  call. All or nothing: refused, buying nothing, if any tile belongs to another company, is an
  industry, a town building, road, rail, a station, water or an object, is already yours, or the
  bank balance is short; the error lists up to 6 tiles and why. A dry run returns `tiles`,
  `estimated_cost` and `affordable`. A failure while buying returns `tiles_bought`, `bought`
  (rectangles), `failed_tile` and `not_bought`.
- `owned-land [--x0 --y0 --x1 --y1] [--limit 50]` (your company): owned land as `tiles` and merged
  `rects` [x0, y0, x1, y1]; the whole map comes from the map mirror, a given rectangle is read fresh.
- `airport-sites`: with a company, your owned land counts as buildable, each site has `owned`
  (whole footprint is your owned land) and owned sites come first.
- GameScript v10 (the host re-runs `install-gamescript`; a running game picks it up when it is
  loaded again): `buy_land` exec step and `owned_land` query. With an older GameScript,
  `purchase-land` and `owned-land` say so and `airport-sites` leaves out `owned`.

## 0.5.0 (2026-11-25)

- Agent skills in `skills/` (`openttd-host-game`, `openttd-join-game`, `openttd-play`), installable as a
  Claude Code plugin (`.claude-plugin/`) or pasted into any agent as a prompt.
- `guide [--role host|player]`: read-only setup checklist as JSON: `role`, ordered `steps`
  (`done` true, false, or null when it cannot tell; `command`; `why`) and `next`, the first step
  still to do. The role defaults to player when a relay is configured, host when an admin password
  or launch profile exists, else both. It checks the config, `doctor`, whether the server answers
  (`companies`, through the running daemon if there is one), the local relay, registered players
  and their bindings, goals, and for a player the relay, its version and `status`. Every probe has
  a short timeout; it starts and stops nothing and prints no tokens or passwords. Also an MCP tool.
- `save --name <name>` (host only, refused through the relay): saves the running server game over
  the console into the launch profile's `save/<name>.sav`; load it with `launch --load <name>`.
  Names with path separators, `..` or a leading `.` are refused.
- MCP instructions and the `help` header tell agents to run `guide` first when not connected or
  without a company; errors for no server, no admin password, no company, an unreachable relay,
  a bad token and an unbound player now end with "run: openttd-agent guide".
- README: Game night rewritten as numbered Host and Each player checklists, with prerequisites,
  firewall ports, finding the LAN IP, a note on sharing a company with an agent, and troubleshooting.

## 0.4.0 (2026-11-25)

Minor, not patch: `build-cargo-route` now refuses a route you already run unless `--allow_existing true`.

- `vehicle-problems` rows carry `severity`: `action` (it cannot earn until fixed) or `info`
  (`broken_down`, `low_reliability`, `old`, `crashed`: leave a running train alone).
  `--severity action|info` filters; the reply adds `vehicles_needing_action`. The fixes for
  breakdowns and low reliability no longer suggest a plain `vehicle-depot`, which stopped working
  trains in the depot (an agent then restarted them, over and over, in a live game).
- `build-cargo-route` refuses (`failed_step: existing_route`) when your rail stations already
  serve both ends: near the source and handling the cargo, near the destination; passengers and
  mail in either direction. Clone a train instead, or pass `--allow_existing true`. (A live agent
  built the same town pair twice, once each way.)
- Fix: `--help` on the built-ins (`daemon-stop`, `daemon`, `mcp`, `relay`, `batch`, `commands`,
  `version`) said "unknown command".

## 0.3.0 (2026-11-25)

- `vehicle-problems [--vehicle ID] [--stuck_days 30]` (player, own company): one row per problem
  with `problem`, `evidence`, `suggested_fix`, the vehicle id and its `unit_number` (the "Train #4"
  in the game window). Problems: `wrong_network` (no rail path to the current order's station while
  the order stations are joined to each other: the train runs on another line's track),
  `unreachable_destination`, `stuck_or_lost` (same order for `stuck_days` game days without getting
  closer; the game's vehicle-lost event is AI-only, so this is inferred, and the daemon or relay
  keeps the history between calls), `no_income` (lost money last year at age over a year),
  `no_orders`, `stopped_in_depot`, `stopped`, `old`, `broken_down`, `low_reliability`, `crashed`.
- `verify-route --vehicle ID` or `--from_station A --to_station B` (id or name): is there a rail
  path; if not, the last reachable tile and the first gap with a reason (`no_track`,
  `track_not_joined`, `station_platform_side`, `depot_entrance_faces_away`,
  `one_way_signal_against`, `other_company_track`, `bridge_side`, `tunnel_side`). Exact on
  GameScript v9; with an older GameScript a coarse trace over the map mirror, marked as such.
- GameScript v9 (the host re-runs `install-gamescript`; a running game picks it up when it is
  loaded again): `rail_tiles` (track bits, depot fronts, bridge and tunnel ends, signals);
  `vehicles` rows add `current_order`, `dest`, `dest_station` and `speed`; `vehicle` adds
  `unit_number` and `rail_type`. (`info` reported `bridge_version` 8 at first, so clients used
  the coarse trace; fixed before release, with a test that it matches `GetVersion()`.)
- `vehicle-clone` checks the depot (rail): `--depot auto` (or no depot) picks your depot nearest
  the vehicle's first order station that is rail-connected to all its order stations;
  `--depot_x/--depot_y` is refused when that depot is not (the clone would get lost), with the gap
  and a depot that would work. Exact on GameScript v9; with an older one the coarse trace refuses
  only what it cannot join. `--check_route false` skips the check; road, ship and air vehicles are
  not traced. `depot_x/depot_y` are now optional.
- `vehicle-buy --route_of ID`: the same check against that vehicle's order stations before buying.
- Fix: `build-cargo-route` could put the route's depot, and so its first train, beside another
  line's track when that ran closer to the source than the new line. The train then never reached
  the route's stations ("cannot reach" in the game). The depot now goes only beside the route's
  own line.
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
- `find-cargo-pairs` pairs town with town for passengers and mail (cargos marked passenger or
  mail in `cargos`): `--cargo passengers` returned no candidates because towns were never sources.
  The source is a town with its last-month production from `towns`; the destination another town
  whose centre accepts the cargo. Both ends have `kind: "town"` and a `name` that
  `build-cargo-route --from_town <name> --to_town <name>` takes. Industry sources are unchanged.

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
