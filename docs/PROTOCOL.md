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
`test_build_road`, `build_road`. Row formats are documented in `gamescript/AgentBridge/main.nut`.
