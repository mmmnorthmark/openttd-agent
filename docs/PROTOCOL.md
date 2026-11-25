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
2. Only commands in groups `game`, `world`, `build`, `operate` are served. `setup` and `relay`
   commands (launch, install-gamescript, configure, player management) are host-only, and there is
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
`autorenew`, `events`, `exec`, `rail_types`, `bridge_types`. Row formats are documented in `gamescript/AgentBridge/main.nut`.

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
- Step formats are listed in `ExecStep` in main.nut. The client keeps a request under ~7 kB and 150 steps.

## events

The GS records game events in a ring buffer (last 300), each `{seq, date, type, ...}`;
`events {since}` returns those with `seq > since`. `info.event_seq` is the newest seq.
A GameScript receives: vehicle crashed, subsidy offer/awarded/expired, company new/in trouble/
bankrupt/merger, industry open/close, station first vehicle, town founded, exclusive transport
rights, road reconstruction. Vehicle lost/unprofitable, engine available and merger offers are
AI-only events in 15.x and never reach a GameScript.
