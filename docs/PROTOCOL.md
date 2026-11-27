# Protocols

Two hops: player -> **relay** (HTTP, per-player token), relay -> game (**AgentBridge** over the
admin port). A host playing alone can skip the relay and use the admin port directly.

# Relay protocol (player -> host)

`openttd-agent relay` on the host; default port 47978 (`relay_port`), all interfaces (`--bind` to narrow).

- `GET /health` -> `{"ok": true, "service": "openttd-agent-relay", "version": "<package version>"}`
- `POST /call` with header `Authorization: Bearer <token>` and body `{"name": "<command>", "args": {...}}`
  -> `200 {"ok": true, "result": ...}` or `200 {"ok": false, "error": "..."}` (the command failed),
  `401` (missing/unknown token), `403 {"ok": false, "error": "relay refused: ..."}` (policy).

`name` and `args` are exactly the CLI/MCP command and its arguments; the result is the same JSON.

Policy, applied before anything reaches the game (`authorize` in `src/relay.js`):

1. Token -> player. Tokens are 32 random bytes (base64url); the host stores only the SHA-256.
   The player file is re-read on every request, so add/remove/re-bind apply at once.
2. Only commands in groups `game`, `world`, `build`, `operate` are served. `setup`, `relay` and
   `host` commands (launch, install-gamescript, configure, scenario-prepare, player management,
   goal-set/goal-clear, pause/unpause/turn-advance) are host-only, and there is
   no raw rcon/console command. `rate` with arguments (a change) is host-only.
3. If the command has a `company` argument it is **set to the player's company**. A request that
   names another company is refused, as is any such command from a player still `pending`.
   Commands without one (world queries, `companies`, `events`) are read-only.
4. `chat` messages get a `[player]` prefix.
5. `max_builds_per_minute` is counted per player on the relay (dry runs are free). The GameScript
   rate gate still applies to everyone after that.

Audit: one JSON line per call in `~/.openttd-agent/relay-audit.jsonl` (`t, outcome` =
`ok|error|refused|auth_failed`, `player, company, remote, name, args, error, ms`). Read-only `world`
commands are not logged when they succeed.

Design choice: **commands run on the relay**, not on the player's machine. The alternative was to
expose read-only GS calls (`dump_tiles`, `towns`, ...) so each player keeps a map mirror and plans
locally. Running on the relay is simpler and safer: one mirror loaded once (2 s for 256x256, 8 s
for 512x512) and shared by all players, no raw GS surface to police, and planned builds are checked
against the freshest tiles. Cost: one LAN HTTP round trip per command (measured: a 55-tile planned
road dry run in 0.17 s end to end) and the relay and players must run the same package version.

Limits: plain HTTP, so the token is readable by anyone who can sniff the LAN. Home LAN only.
OpenTTD 15.3 binds the admin port with the same address list as the game port (`GetBindAddresses`
in `src/network/network.cpp`, used by both listeners), so the admin port cannot be loopback-only
while players join over the LAN; the admin password, which never leaves the host, protects it.

# AgentBridge protocol (relay -> game)

Transport: OpenTTD admin port (protocol v3). Client logs in with `ADMIN_JOIN` (password),
subscribes to `ADMIN_UPDATE_GAMESCRIPT` (automatic), then:

- **Request** `ADMIN_PACKET_ADMIN_GAMESCRIPT` JSON (< 9000 bytes):
  `{"id": <int>, "client": "<random hex>", "cmd": "<name>", "args": {...}}`
- **Reply** `ADMIN_PACKET_SERVER_GAMESCRIPT` JSON, possibly several parts:
  `{"id", "client", "ok": true, "part": <n>, "last": <bool>, "data": <any>}` or
  `{"id", "client", "ok": false, "error": "<text>"}`

Rules:
- Replies go to **every** admin connection; ignore any whose `client` isn't yours.
- The GS trusts `args.company`: it cannot tell admin connections apart. Per-player limits live in the relay.
- If `data` is an array it may be split over parts 0..n; concatenate them in order.
- Each GS→admin message is kept under 1100 bytes (OpenTTD 15.x limit is ~1460).
- Build commands run under `GSCompanyMode(args.company)` and pass the rate gate
  (`command_delay_ticks`, `max_builds_per_day`).

GS commands: `ping`, `info`, `echo`, `companies`, `cargos`, `towns`, `industries`,
`industry_types`, `dump_tiles`, `get_rate`, `set_rate`, `airport_types`, `check_airport`,
`test_build_road`, `build_road`, `stations`, `vehicles`, `vehicle`, `engines`, `groups`, `depots`,
`autorenew`, `events`, `exec`, `rail_types`, `bridge_types`, `goal_set`, `goal_status`, `goal_clear`, `acceptance` (v7),
`rail_tiles` (v9), `owned_land` (v10: `{company, points: [[x, y], ...]}` -> indices of the points
that are the company's owned land), `road_tiles` (v11: `{company, x0, y0, x1, y1}`, max 32x32 ->
rows `[x, y, kind, links, station, a, b, owner]`; `links` bit d = a road vehicle can drive into the
neighbour in direction d, from `GSRoad.AreRoadTilesConnected`, so one-way roads count).
v12 adds `company_history` (`{company, quarters}` -> `[quarter, value, income, expenses,
cargo_delivered, performance]`, quarter 0 = running), `rating_parts` (`{company}` -> the rating
inputs scripts can read), `station_vehicles` (`{company, station?}` -> `[station, [vehicle ids]]`,
a busy station spans several rows), `tile_owners` (`{x0, y0, x1, y1}`, max 40x40 -> `[x, y, owner]`
for company-owned tiles), `vehicle_wagons` (`{company, vehicle}` -> `[index, engine, cargo,
capacity]`), `signs` (`{company}` -> `[id, x, y, owner, text]`) and `road_types` (`{company}` ->
`[id, name, tram, max_speed, build_cost, available]`); `companies` rows gain `station_count` and
`vehicles_by_type` ([rail, road, water, air]); `depots` rows gain `front_x, front_y`.
v13 adds `town_rating` (`{company, towns?, points?}` -> `[town, rating, detailed, x, y]`: the
town window's word (`none`, `appalling` ... `outstanding`, from `GSTown.GetRating`) and the number
behind it (`GSTown.GetDetailedRating`, -1000..1000); with `points` (at most 60) one row per point
for the town whose local authority covers that tile (`GSTile.GetTownAuthority`, town -1 = none))
and `vehicle_loads` (`{company, vehicles?}` -> `[vehicle, cargo, capacity, load]` per cargo it can carry).
v14 declares script API 14 so OpenTTD 14.x loads it (15.x loads it through `compat_14.nut`); no
protocol change. The two 15.0+ calls it uses (`GSBaseStation.GetOwner`, `GSTile.IsHouseTile`) are
picked at run time (`StationOwner`, `IsHouse` in main.nut).
Row formats are documented in `gamescript/AgentBridge/main.nut`.

The `veh_depot` exec step (v11) never undoes an earlier send (a second "go to depot" cancels the
first in OpenTTD): value 1 = sent, 2 = already heading to a depot, 3 = already stopped in one;
failures say why (`not_found:`, `broken_down:`, `loading_full_load:`, `crashed:`, `no_depot:`).

## exec

Every state change (vehicles, orders, groups, construction) is one **step** in an
`exec` request, so dry runs, the rate gate and error reporting work the same for all of them:

`{"cmd": "exec", "args": {"company": 0, "dry_run": false, "keep_going": false, "steps": [["veh_buy", 13, 22, 27, 7, 11], ...]}}`

- Reply: `[summary, row, row, ...]`, one row `[ok, cost, error, value]` per attempted step;
  `summary = {dry_run, attempted, failed, cost, stopped, money}`.
- `dry_run` runs the steps under `GSTestMode` (cost and feasibility, nothing changes, no rate gate).
- Without `keep_going` the first failed step stops the request (`stopped` says why); a rate-limit
  refusal also sets `stopped`.
- Optional `rail_type` / `road_type` select the track type for the whole request.
- `rail` and `road` steps count "already built" as success, so a plan can be re-run.
- `demolish` checks every tile of its rectangle first and refuses all of it if one is protected.
- `loan` (v8): `["loan", "set", loan]`, `["loan", "add", delta]` (negative = repay) or
  `["loan", "max", 0]`. The target loan is rounded up to the loan interval; refused below 0, over
  `max_loan`, or when the bank balance would go below 0. Row value = the target loan.
- `buy_land` (v10): `["buy_land", x0, y0, x1, y1]` with x0 <= x1, y0 <= y1 buys every tile as
  owned land (`GSObjectType.BuildObject(3, 0, tile)`, one tile per call). It checks every tile
  first and refuses the whole rectangle (other company, industry, town building, infrastructure,
  water, objects, or already yours), then estimates in test mode and refuses if the game would
  refuse a tile or the bank balance is short; only then it buys row by row from x0,y0.
  Row value = tiles bought; a failure while buying says how many were bought before it.
- v12 steps: `["veh_reverse", vehicle]` (`GSVehicle.ReverseVehicle`), `["sign", x, y, text]`
  (value = sign id; the company owns it), `["sign_remove", sign_id]` (own signs only) and
  `["hq", x, y]` (`GSCompany.BuildCompanyHQ`; building again moves it).
- Step formats are listed in `ExecStep` in main.nut. The client keeps a request under ~7 kB and 150 steps.

## events

The GS records game events in a ring buffer (last 300), each `{seq, date, type, ...}`;
`events {since}` returns those with `seq > since`. `info.event_seq` is the newest seq.
A GameScript receives: vehicle crashed, subsidy offer/awarded/expired, company new/in trouble/
bankrupt/merger, industry open/close, station first vehicle, town founded, exclusive transport
rights, road reconstruction. Vehicle lost/unprofitable, engine available and merger offers are
AI-only events in 15.x and never reach a GameScript. AgentBridge adds its own `goal_done` and
`goal_failed` (`{company, deadline_year}`). The buffer is not saved: it restarts on load.

## goals

One goal per company, kept by AgentBridge (a game runs a single GameScript, so a goal script
cannot run next to it) and saved with the game (GS `Save`/`Load`).

- `goal_set {company, deadline_year, targets: [["COAL", 3000], ["VALUE", 500000]]}`: cargo labels
  as `cargos` reports them; `VALUE` = company value. Replaces the company's goal. Creates one
  `GSGoal` entry per target (company goal window). Reply: `[goal]`.
- `goal_status {company?}` -> `[goal, ...]`, progress read fresh:
  `{company, status: "active"|"done"|"failed", deadline_year, days_left, set_date, targets: [[label, amount, progress, done], ...]}`.
- `goal_clear {company}` -> `{removed}`.
- Cargo progress = deliveries by the company since `goal_set`, read from `GSCargoMonitor` town
  delivery monitors summed over all towns. In 15.3 every delivery, also one to an industry, is
  counted for the town the receiving station belongs to (`cargomonitor.cpp AddCargoDelivery`), so
  that sum counts each delivery once; industry monitors are not used (they would double count).
- Updated on the first tick of each game month and on every `goal_set`/`goal_status`. A target
  that was reached stays `done`. All done -> `done`; deadline year over first -> `failed`.

# Console (rcon) use by host commands

Host-only commands use the server console over the admin connection; nothing here is reachable
through the relay.

- `pause` / `unpause` / `turn-advance`: console `pause` / `unpause`, then poll GS `info`
  (`paused`, `date`). `setting command_pause_level` is read to report what is allowed while paused.
- `scenario-prepare` (own admin connection, `src/scenario.js`): `pwd` (save folder), `content update scenario`,
  `content state` (rows `id, type, state, name, unique id, md5`), `content select <id>`,
  `content download`, `list_scenarios`, `load_scenario <n>`, `save <name>`, `ls`, `load <name>`.
  A load is complete when the server sends a second `SERVER_WELCOME`. `save` returns before the
  file is complete (saving is threaded): the file is polled until it parses to its end marker.

# Savegame editing (scenario-prepare)

`src/savegame.js`, uncompressed saves only (`[misc] savegame_format = none`, tag `OTTN`):
4-byte tag, 4-byte version, chunks (`id` + mode byte; RIFF = 24/28-bit length + payload; array and
table types = gamma-length elements until a zero), 4 zero bytes.

- `GSDT` (GameScript name, settings, version, saved data) is copied from a save of a game running
  AgentBridge. 15.3 `saveload/game_sl.cpp` starts whatever `GSDT` names; nothing else decides it.
- `PATS` (game settings; a table whose header lists `type, name` per field) gets two integers set in
  place: `script.script_max_opcode_till_suspend` (new-game-only setting) and
  `construction.command_pause_level` (flagged not changeable in network games).
- AgentBridge drops saved goals that do not belong to the loaded map (other map stamp, or their
  `GSGoal` entries are missing), since the copied `GSDT` carries the donor game's script data.
