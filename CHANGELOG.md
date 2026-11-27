# Changelog

Semver. The GameScript has its own integer version (`GetVersion()` in info.nut); the host must
re-run `install-gamescript` when it changes.

## 0.8.0 (unreleased)

Host tools (batch 3):

- **Breaking:** `launch --mode dedicated` now waits until the admin port and AgentBridge answer
  (default 60 s, `--wait_s`; `--wait false` returns at once) and returns `ready`, `bridge_version`,
  `seconds`. Not ready: `ok: false`, `first_error: not_ready`, with `process` (pid, running,
  exit_code) and `log_tail`.
- **Breaking:** `launch` on a profile whose server already runs returns `already_running: true`
  and starts nothing; `--restart true` stops it (console quit, then SIGTERM to the processes
  started with that profile's cfg only) and starts again.
- **Breaking:** `launch --dry_run true` writes nothing (it used to write the profile files); it
  lists them in `would_write`.
- `launch` rotates the profile's `openttd.log` (keeps `.1`-`.3`).
- `launch --server NAME --game_port N --admin_port M`: a second server on its own launch profile
  (`profiles/NAME/server.json` keeps its ports). A server on another admin port than the
  configured one leaves the config alone (`side_server` says how to reach it). `--server` is not
  `--profile`: the global `--profile` picks a player profile.
- New host commands (group `host`, refused by the relay), each with `--server NAME`: `load --name N
  [--pause true|false]`, `saves [--match --limit]`, `company-new [--ai IdleAI]`, `server-stop [--save N]`,
  `console --command "<console line>"`, `server-log [--lines --errors true --grep]`.
- `install-gamescript --reload true [--server --save_name]`: install, rescan, save, load that save,
  wait for the bundled bridge version, restore the pause state.
- `doctor` reports a macOS quarantine flag on OpenTTD.app (with the `xattr` fix) and `servers`:
  every launch profile with running, ports and whether its log shows the GameScript died.
- GS timeouts carry a code: `gs_died` (the server log shows the script died after its last start;
  the lines are in the error) or `gs_timeout` (with the last error lines). Connecting to a game
  whose GameScript does not answer gives `no_gamescript` / `gs_died`.
- Admin logins the server drops before welcome fail at once with `first_error: admin_auth`
  (they used to wait for the 10 s timeout).
- Background jobs (queued vehicle sales, train-add-wagons jobs, the periodic save) are kept in
  `~/.openttd-agent/jobs-<host>-<port>.json` per game (seed and start date) and resume when the
  daemon or relay reconnects to that game. `status` gains `background_jobs`.

CLI/MCP parity and the output contract (batches 1 and 2):

- **Breaking:** MCP refuses unknown arguments like the CLI (`first_error: unknown_argument`,
  nothing runs). The SDK used to strip them and run the command with defaults (a stray `help`
  advanced the game 41 days). Tools get a pass-through schema; aliases (`--id`) and the error
  JSON now work over MCP too.
- **Breaking:** build/exec results list only failed steps: `results_failed` plus
  `steps_done`/`steps_total`. `--steps all` gives the full `results`. A failed step has no `value`
  (it could show 1048575 as an id).
- **Breaking:** the CLI prints one-line JSON when stdout is not a terminal (`--compact false` or
  `OPENTTD_AGENT_COMPACT=0` indents), and the MCP server is compact by default (`mcp --compact false`).
- **Breaking:** a result with `ok: false` makes the CLI exit 1 and sets MCP `isError` (it used to
  exit 0 / not set it unless the command threw). `batch` prints `{"name", "result"}` for every
  line, failures too (they used to be a bare error object without the name).
- **Breaking:** `null`, `""`, `false` and `[]` no longer coerce to 0 for numbers (company 0 is a
  real company). `null` (and `""` for a number) means "not given"; `false`/`[]` are refused.
- **Breaking:** `help` prints one line per command (`help --full` for the old listing, about 4x
  longer); `commands` schemas use `io: 'input'`, the same as MCP `tools/list`.
- Every command takes `--fields a,b.c` (projection; item fields apply to lists), `--brief true`
  (ok, cost, money, ids) and `--compact`, on the CLI, in `batch` and over MCP.
- Error codes: `unknown_command`, `unknown_argument`, `bad_arguments` (a missing argument says
  `required`), `read_only`, `daemon_timeout`, `daemon_failed`, `relay_timeout`.
- A JSON number works for a text argument (`join: 12`). Read commands and dry runs clamp an
  out-of-range number (`clamped`); read commands ignore `--dry_run`/`--list`, `vehicle-depot`
  ignores `--depot auto` (`ignored_args`). CLI: a bare word after a value joins it with a space.
  Town arguments of line ends (`build-cargo-route`, `build-truck-route`, `station-sites`) accept a
  station-style name ("Bigton Woods" -> Bigton) or a unique prefix; the target says `matched_town`.
- Read-only mode: `OPENTTD_AGENT_READ_ONLY=1` or `mcp --read_only true` forces dry runs
  (`forced_dry_run: true`) and refuses other actions. `OPENTTD_AGENT_TOOLS=a,b` limits the CLI and
  `help` like `mcp --tools`. A relay player's MCP server lists only the tools the relay serves.
- One dispatch for CLI, batch and MCP (`src/dispatch.js`): MCP game calls now share the background
  daemon (its map mirror and background jobs) unless `--no-daemon`; `batch --no-daemon` works and
  keeps one connection. A one-shot call that starts a background job warns `background_job_not_kept`.
- The daemon reports `code_id` (files of src/bin/gamescript) and `config_hash` on `/health`. The
  CLI restarts a daemon running other code (no more `daemon-stop` after an update or an edit), and
  once more when a daemon answers "unknown command" for a known one. A daemon running with other
  settings (another caller's env, e.g. `OPENTTD_AGENT_COMPANY`) is left alone; the call runs in the
  caller's process with `warnings: daemon_config_mismatch`.
- Calls longer than 5 minutes work through the daemon and the relay (node:http, server request
  timeouts off); one overall timeout `OPENTTD_AGENT_CALL_TIMEOUT_S` (default 3600 s).
- `test/parity.test.js`: every command through the CLI and MCP against identical fake servers.

Observation and output (batch 6):

- `status` gains `date` ("YYYY-MM-DD") and `me` (your company's row: money, loan, max_loan, value,
  cargo_delivered, performance, profit of the last full quarter). Read `me`, never `companies[0]`:
  the list holds every company and ids need not start at your company. `summary` gets the same
  `date` and `me` header.
- `companies` gains `date`; every row and `history` row gains `profit` (income + expenses).
- `tiles --format text` (up to 80x80): one character per tile (class letter, upper case = owned by
  your company), an x ruler and rows `"y|chars"`. `tiles --x --y --radius R` instead of the corners
  (both formats). The box is clipped to the map.
- `stations --ids A,B`, `--near_x X --near_y Y [--radius R]` (nearest first, each with `distance`),
  `--unserved true` and `--max_vehicles N`. **Breaking:** the default `--limit` for your own
  company rises from 100 to 1000 (another company's stay at 100).
- `events --type a,b` takes a list (any matches), `--exclude a,b` leaves types out, and
  `--companies A,B` (alias `--company N`) keeps events about those companies. The argument is
  not `company` on purpose: the relay forces `company` to the player's own, and news is public.
- `airport-sites --towns A,B`: several towns in one call (`towns[{town, sites}]`; a town that is
  not found gets `error`). `--town` alone keeps the old result.

## 0.7.0 (2026-11-26)

AgentBridge GameScript v12: hosts must run `install-gamescript` and reload the game. Older GameScripts get clear refusals or fallbacks. List outputs and `first_error` changed shape (below), so scripts that parse them need updating.

Behaviour changes agents must know:

- **One result envelope.** Every command returns an object with `ok` (bool) and `error` (human
  text, `null` on success, never `""`). Failures also carry `first_error`, now a short code
  (`ERR_AREA_NOT_CLEAR`, `refused`, `no_signal_here`, ...; it used to be the error text, which is
  now in `error` as `step N (op): <text>`). CLI, daemon, batch and MCP errors print
  `{"ok": false, "error": ..., "first_error": ...}`.
- **List commands return `{ok, error, total, matched, <items>, truncated}`** instead of a bare
  array: `stations` (`stations`; was a bare list cut at 100), `companies`, `cargos`,
  `industry-types`, `towns`, `industries`, `town-gaps` (`towns`), `airport-types`, `engines`,
  `groups`, `depots`, `rail-types`, `bridge-types`, `relay-list-players` (`players`). `vehicles`
  keeps its keys, adds `truncated`, and its default `--limit` is now 1000 (was 200, which cut a
  215-vehicle fleet silently).
- **Dry runs no longer report false failures**: a signal step on track that an earlier step of
  the same command lays (build-terminus, build-passing-loop) is marked `skipped_in_dry_run` with
  its `dry_run_error`, and the top-level `ok` counts only real problems.
- `build-cargo-route` results carry `cost`, `vehicles[]`, and `complete` on every `built[]` entry.
- `build-road` takes `--dry_run true` like every other build (it was refused as an unknown argument).
- `build-signal --remove` on a tile without that signal returns `first_error: no_signal_here`
  (and names the signal the tile does have, if any) instead of a bare ERR_PRECONDITION_FAILED;
  nothing is sent to the game. Needs GameScript v9 to check; older ones run the step as before.
- `vehicle-buy --attach_to TRAIN` first checks (also in a dry run) that the train is stopped in
  that depot and refuses with `first_error: train_not_in_depot` and the fix; nothing is bought. If
  the game still refuses to couple a wagon, the wagon is sold back at once (`sold_back`).
- `build-cargo-route` refuses `existing_route` only when one of your vehicles has orders at both
  of your stations there (`existing.served_by`); stations nobody serves any more (a sold fleet)
  no longer block a rebuild (`existing_unserved` notes them). The refusal hints `--allow_existing true`.
- Player profiles: global `--profile NAME` (or `OPENTTD_AGENT_PROFILE=NAME`) reads and, with
  `configure`, writes `~/.openttd-agent/players/NAME.json`; `OPENTTD_AGENT_PLAYER_FILE=<path>` uses
  any JSON file (`token` accepted for `relay_token`). Keys override config.json; env vars override
  both. `relay-add-player` also prints the profile form (`or_as_profile`).
- Relay: `stations --company X` and `vehicles --company X` work for another company, read-only and
  trimmed to what the game window shows anyone (stations without vehicle counts; vehicles as
  `total` and `by_type` only). Every other command stays bound to the player's company.
  `vehicles --summary true` gives the counts for your own company (plus `by_state`).
- A game without AgentBridge no longer piles up admin connections: a session whose GameScript
  does not answer closes its admin connection at once (a daemon retrying every call filled the
  server's admin slots: `read ECONNRESET`). The error names the likely cause and the fix.
- `launch`: `[game_scripts]` in the launch profile is rewritten to hold only AgentBridge (a
  `none =` copied from the user's openttd.cfg silently won, and the GS never answered). `doctor`
  lists launch profiles where it is wrong (`launch_profile_game_scripts`).
- `launch --bind <address>` (not 0.0.0.0 or loopback) saves that address as `host`, so the CLI on
  the host reaches the admin port there instead of 127.0.0.1 (ECONNREFUSED).
- `launch` writes `server_name` (and, for a dedicated server, `client_name = openttd-agent
  server`) to the profile's private.cfg; OpenTTD 15 ignores them in openttd.cfg, so the server's
  own client showed as "Unnamed Client".
- Version drift is visible: `status` returns `versions` (openttd-agent, running and bundled
  AgentBridge) and `warnings` when the running GameScript is older than the bundled one or, for a
  player, when the host's relay runs another openttd-agent version. `doctor` adds
  `gamescript_warning`; `guide` (host) has a `gamescript-running` step. The CLI restarts a
  background daemon that runs another version (it kept serving old code after an update).
- **GameScript v11** (the host re-runs `install-gamescript`; a running game picks it up when it is
  loaded again): `road_tiles` query and a decoding `veh_depot` step.
- `verify-route` traces road vehicles and road stops (GS v11): `--vehicle` picks rail or road by
  vehicle type, a station pair picks by facilities (`--mode auto|rail|road`). Road gap reasons:
  `no_road`, `road_not_joined`, `one_way_road`, `depot_not_joined`, `depot_entrance_faces_away`,
  `stop_not_joined`, `stop_entrance_faces_away`, `other_owner_road`. With an older GameScript it is
  refused with that reason (it used to give a wrong rail answer: `method: rail_tracks, connected:
  false, first_gap: null`); ships and aircraft are refused too. `vehicle-problems` checks road
  vehicles the same way (`road_trace` says whether it could).
- `vehicle-depot` is safe to repeat (GS v11): vehicles already heading to a depot are left alone
  (`already_heading`; a second send cancelled the depot order), ones already in a depot are
  `already_in_depot`; failures are decoded in `failed[]` (`not_found`, `broken_down`,
  `loading_full_load`, `crashed`, `no_depot`). Older GameScripts only skip vehicles in a depot.
- `build-road-depot` and `build-road-station` return `connected` (GS v11): true when the entrance
  (or one end of a drive-through stop) joins a road beyond it, with `ends[]`. `--connect auto`
  builds a road path from the entrance to the nearest road (`connect`). A refused drive-through
  stop says why where it can tell: `first_error: drive_through_refused` with `junction`,
  `one_way_road`, `other_owner_road`, `not_plain_road` or `slope` (the game only said ERR_UNKNOWN).
- Fix: the rail trace read one-way path signals backwards (`rail_tiles` bit d is a signal facing
  trains that come from neighbour d, per OpenTTD's GetSignalType/HasSignalOnTrackdir), so
  `verify-route` could call a working one-way stretch blocked and a blocked one open.
- **`build-passing-loop` geometry and safety.** Both sides now have the same `length - 1` clear
  tiles between the points and the exit signal (the main side had one fewer: the loop's one-way
  signal moved one tile in); results say `clear_tiles` and `fits_trains_up_to_tiles`.
  `--train_tiles N` or `--for_vehicle ID` (longest train on that line) sets the default length
  (train + 2) and refuses a loop that is too short (`loop_too_short`). Before building (GS v9)
  every main-line tile under the footprint must be straight track along `dir` or free land
  (`not_straight_at`, `blocked_at`, `signal_at` with `at {x,y}`) and the loop side free
  (`loop_side_occupied_at`): loops at bends broke lines silently. After a real build:
  `loop_check` (both directions through the loop) and, with `--for_vehicle`, `route_after`
  (`connected` | `broken` with `first_gap`; broken sets ok false). `--remove true` with the same
  arguments takes out the loop track and both signals, including the one on the main track.
- Forgiving arguments: `--id` works for `--vehicle`; `--vehicle` and `--vehicles` stand in for
  each other (one id for `--vehicle`); `depots` and `engines` default to `--type rail`; a bad
  number says what it got (`--vehicle: expected number, received NaN (got "abc")`).
- Cargo names match loosely everywhere (`iron_ore`, `Iron Ore`, `iron-ore`); an unknown cargo
  error lists the known names.

- **GameScript v12** (host: `install-gamescript`, then load the game again): `veh_reverse`, `sign`,
  `sign_remove` and `hq` steps; `company_history`, `rating_parts`, `station_vehicles`,
  `tile_owners`, `vehicle_wagons`, `signs`, `road_types` queries; `companies` rows gain
  `station_count` and `vehicles_by_type`, `depots` rows the front tile. Commands that need them
  say so on an older GameScript.
- New `loop-sites --vehicle ID` (or `--from_station A --to_station B`): walks your own track
  between the stations, finds straight plain stretches long enough for `build-passing-loop`
  (length + 4 tiles), centres the loop in each, checks the lane beside it and dry-runs the best;
  each site has `gap` (straight tiles to the nearest bend, points, signal or station; ranked by
  `--min_gap_from_bend`, default 8), `distance_from_station`, `position_pct`, `cost` and `build`.
- `build-passing-loop` also refuses a loop lane on houses, water or other non-free land
  (`loop_side_occupied_at` with the map class) before building.
- New `vehicle-replace --vehicles A,B [--engine N --wagon W --wagons K]`: buys the replacement at
  a depot on the vehicle's own route, shares the old vehicle's orders and starts it; the old one
  gets its own copy of the orders, loads nothing at its next unloading stop and stops in the depot
  after it, and the daemon (or relay) sells it there (checked every 20 s; `--finish true` sells
  arrivals now and lists `pending_sales`). `--when now` sends the old one to a depot at once.
  Without `--engine` the replacement is a clone. Live-tested: two replacements, old trains sold
  on arrival.
- New `vehicle-reverse --vehicles A,B` (GS v12, `GSVehicle.ReverseVehicle`): turn a train or road
  vehicle round, e.g. to free a deadlock.
- `vehicle-problems` finds trains that stand still: `stalled_on_line` (speed 0 on the same tile for
  `--stall_days`, default 10, not at a station or broken down) and `deadlock` (two such trains
  within 16 tiles; fix: reverse one). Once vehicle-problems has run, the daemon samples the
  company's vehicles every 15 s, so one later call sees a stall. `stuck_or_lost` is not reported
  on top of a stall. Live-tested: a too-short loop jammed two trains, both were reported as
  `deadlock`, and reversing one freed them.
- New `rail-tiles --x0 --y0 --x1 --y1` (max 32x32): per rail tile the kind, track pieces
  (`x`, `y`, `n`, `s`, `e`, `w`), signals (`facing: from_sw|from_se|from_ne|from_nw`, `one_way`),
  depot front, bridge/tunnel other end, station, rail type, owner and `mine`; `--mine true|false`
  filters. `tiles` marks owned tiles (GS v12): `*` = your company, `#` = another company (agents
  took other companies' rail for their own and dry runs failed with ERR_OWNED_BY_ANOTHER_COMPANY).
- `vehicle-buy` builds a whole working train in one call: `--wagon W --wagons N` attaches N
  wagons to each new locomotive, `--orders A,B` (station ids or names) with `--order_flags
  "full_load_any;unload,no_load"` (one set per order, or one for all) gives the orders (more
  vehicles share them), `--start true` starts them. Flags and stations are checked before buying.
- `stations` rows carry `vehicle_ids` (GS v12: your vehicles with an order for that station), and
  `vehicles --station ID|name` lists only those.
- New `summary [--group G | --vehicles A,B | --stations A,B | --what vehicles|stations]`: one
  compact text line per vehicle (profit this/last year, age, reliability, state, position,
  destination; worst profit first) and per station (vehicles, cargo waiting and rating; worst
  rating first), plus the profit totals. Agents hand-rolled this from `vehicles` and `stations`.
- New `rating` (GS v12): your performance rating split into the game's nine components (value,
  needed for full points, points, max, `missing`, what counts), sorted by missing points, with
  `estimate_now` and `game_rating_last_quarter`. `cargo_types` is not readable by scripts (null);
  `stations` counts station parts with a vehicle order (the game: served in the last 20 days).
  Live check: estimate 32 of 950 known points against the game's 37 (one cargo type is ~6 points).
- `companies`: each row says which quarter its figures are (`period`, e.g. "1951 Q2": the last full
  quarter) and has `station_count` and `vehicles_by_type` {rail, road, water, air} (GS v12).
  `--history N` adds the last N quarters per company (`history[]`: period, value, income,
  expenses, delivered, performance; newest first).
- Periodic saves (host): `save --every_months N --prefix P` saves now and then `P-YYYY-MM` every N
  game months (the daemon checks every 20 s; `--every_months 0` stops; `save` alone shows the
  schedule). `pause --save NAME` pauses and saves. Live-tested.
- New `sign --x --y --text`, `signs`, `sign-remove --ids|--x --y|--text` (GS v12): free company
  signs to mark plots, instead of placing track as a marker (which cost money and could not be
  told apart from real track). Live-tested.
- `vehicle-problems` rows carry `as_of` (game date of the sample) and `days_watched` (age of the
  history behind the row); `--fresh true` forgets the history for your vehicles first (after a
  fix, old samples no longer report it). `stopped_in_depot` says how long the vehicle has been
  parked; wagons without a locomotive in a depot are `loose_wagons` (they were reported as a
  parked train with unit number -1).
- `find-cargo-pairs` defaults to 20..200 tiles when `--min_distance`/`--max_distance` are not
  given (it was 0..1000 and offered 900-tile pairs); `distance_bounds` says which bounds applied.
  `--near_x --near_y [--radius 60]` keeps sources near a tile.
- `towns --near_x --near_y [--radius 50]` (rows gain `distance`, nearest first) and `--id`;
  `industries --id`.
- `build-cargo-route`: a town end with no room for the terminus is retried with a wider search,
  a shorter platform and one platform; `source_fallback` / `dest_fallback` say what was asked and
  what worked (it failed with `no terminus site passed`). `warnings[]` lists your stations within
  8 tiles of a new terminus (`near_own_station`, `end`, `tiles`). Live-tested (dry runs).
- `depots` rows have `front` and `exit_dir` (GS v12). `build-rail-depot` returns `exit_dir`,
  `front_joined` and `front_leads` (where a train leaving it can go) with a warning when nothing
  joins the entrance or trains can leave one way only (a new train then ran to the far end of the
  line to turn round, which looked lost).
- New host-only `relay-stats`: per relay player `last_call`, `seconds_since_last_call`,
  `last_command`, `calls_last_minute`, `calls_per_min_10min`, totals of calls, refusals and errors,
  `last_refusal` (since the relay started; the relay writes `~/.openttd-agent/relay-stats.json`
  every few seconds). Never served through the relay.
- New `build-hq --x --y [--dry_run true]` (GS v12): build or move the company headquarters;
  returns its location (`hq`). Live-tested.
- New `road-types` (GS v12): road and tram types with id, tram, max speed, cost, available.
  `--road_type ID` on `build-road`, `build-road-path`, `build-road-station`, `build-road-depot`
  builds that type (trams: a tram type, usually from a NewGRF; a plain game has road only);
  `engines --type road --road_type ID` finds the vehicles for it. Road tracing (`connected`,
  `verify-route`) follows plain road only and says so for other types.
- `build-cargo-route --passing_loops N`: lays N passing loops on straight stretches spread along
  the new line (loop-sites logic on the planned line for the dry run and on the traced line when
  built), each sized for the train (train tiles + 2); `passing_loops[]` in the dry run,
  `passing_loop` entries in `built[]`; a loop that does not fit is a warning. `loop-sites` also
  offers several positions on one long straight stretch. Live-tested: a 58-tile line with 2 loops,
  traced connected.
- Fix: a new vehicle (or sign or group) with id 0 lost its id in exec results, so commands that
  continue with the new vehicle (orders, start, wagons) could not.
- New `train-add-wagons --vehicle T --wagons N [--wagon W]`: attaches the wagons at once when
  the train is stopped in a depot; otherwise sends it to a depot (retrying while no depot is ahead
  of it) and the daemon attaches the wagons on arrival and restarts it (`--finish true` does it now
  and lists `pending` and `recent`). Live-tested: 4 -> 5 wagons, restarted.
- New `add-train --vehicle T [--count N] [--force true]`: counts the trains on T's line and the
  passing loops on its track, refuses with `needs_loop` when the trains would outnumber loops + 1,
  else clones T on its own route, starts it and traces the new train's route (`verify`).
  Live-tested: refused on a 3-train/1-loop line, added on a 2-train/2-loop line (connected).
- New `build-truck-route` (the road twin of build-cargo-route): truck (or bus) stop at each end
  (bay stop by an industry; drive-through on a straight town road near the centre, else a bay
  stop; the destination must accept the cargo), a road between them reusing existing roads, a
  depot beside it, `--vehicles N` road vehicles with shared orders, started, then a road trace both
  ways (`verify`). Every placement is dry-run first; `--dry_run true` returns `estimated_cost`.
  Live-tested: coal mine to power station, 25 road tiles, 2 trucks, verify connected both ways,
  the first truck loaded coal and left.
- Review fixes in this batch: build-cargo-route sizes the default train for the shorter platform
  (a fallback can shorten one end); vehicle-replace points the old vehicle back at the order it was
  heading for after its orders are copied; parked days and `--finish` results work per company
  through the relay; `deadlock` ignores trains queued within 4 tiles of their destination;
  `signs` / `sign-remove` list only your own signs; a wagon job survives a timed-out request;
  `--passing_loops` can use neighbouring sites on one long straight.

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
