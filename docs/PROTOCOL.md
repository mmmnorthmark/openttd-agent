# AgentBridge protocol

Transport: OpenTTD admin port (protocol v3). Client logs in with `ADMIN_JOIN` (password),
subscribes to `ADMIN_UPDATE_GAMESCRIPT` (automatic), then:

- **Request** `ADMIN_PACKET_ADMIN_GAMESCRIPT` JSON (< 9000 bytes):
  `{"id": <int>, "client": "<random hex>", "cmd": "<name>", "args": {...}}`
- **Reply** `ADMIN_PACKET_SERVER_GAMESCRIPT` JSON, possibly several parts:
  `{"id", "client", "ok": true, "part": <n>, "last": <bool>, "data": <any>}` or
  `{"id", "client", "ok": false, "error": "<text>"}`

Rules:
- Replies go to **every** admin connection; ignore any whose `client` isn't yours.
- If `data` is an array it may be split over parts 0..n; concatenate them in order.
- Each GS→admin message is kept under 1100 bytes (OpenTTD 15.x limit is ~1460).
- Build commands run under `GSCompanyMode(args.company)` and pass the rate gate
  (`command_delay_ticks`, `max_builds_per_day`).

GS commands: `ping`, `info`, `echo`, `companies`, `cargos`, `towns`, `industries`,
`industry_types`, `dump_tiles`, `get_rate`, `set_rate`, `airport_types`, `check_airport`,
`test_build_road`, `build_road`, `stations`, `vehicles`, `vehicle`, `engines`, `groups`, `depots`,
`autorenew`, `events`, `exec`. Row formats are documented in `gamescript/AgentBridge/main.nut`.

## exec

Every state change (vehicles, orders, groups and, from GS v4, construction) is one **step** in an
`exec` request, so dry runs, the rate gate and error reporting work the same for all of them:

`{"cmd": "exec", "args": {"company": 0, "dry_run": false, "keep_going": false, "steps": [["veh_buy", 13, 22, 27, 7, 11], ...]}}`

- Reply: `[summary, row, row, ...]`, one row `[ok, cost, error, value]` per attempted step;
  `summary = {dry_run, attempted, failed, cost, stopped, money}`.
- `dry_run` runs the steps under `GSTestMode` (cost and feasibility, nothing changes, no rate gate).
- Without `keep_going` the first failed step stops the request (`stopped` says why); a rate-limit
  refusal also sets `stopped`.
- Step formats are listed in `ExecStep` in main.nut. The client keeps a request under ~7 kB and 150 steps.

## events

The GS records game events in a ring buffer (last 300), each `{seq, date, type, ...}`;
`events {since}` returns those with `seq > since`. `info.event_seq` is the newest seq.
A GameScript receives: vehicle crashed, subsidy offer/awarded/expired, company new/in trouble/
bankrupt/merger, industry open/close, station first vehicle, town founded, exclusive transport
rights, road reconstruction. Vehicle lost/unprofitable, engine available and merger offers are
AI-only events in 15.x and never reach a GameScript.
