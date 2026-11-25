# openttd-agent

Shared package (public): CLI + MCP + AgentBridge GameScript for agent-driven OpenTTD companies on a LAN.
Research and design history: ~/code-local/openttd-agent-research/FINDINGS.md.

- Access model (0.2.0): players never get the admin password. Host runs `openttd-agent relay` (`src/relay.js`, port 47978): the only admin-port client; per-player tokens (`src/relay-players.js`, SHA-256 only, `~/.openttd-agent/relay-players.json`), company forced per request, audit in `relay-audit.jsonl`. Commands run on the relay (shared map mirror); a player's `runCommand` forwards any `session: true` command when `cfg.relay` is set (`src/relay-client.js`).
- Relay policy is `authorize()` in `src/relay.js`: groups game/world/build/operate only; a new group is host-only until added there. Every command that changes the game or reads company data must take `company` (use `who`/`act`) or the relay cannot force it; `test/relay.test.js` fails otherwise.
- OpenTTD 15.3 cannot bind the admin port separately from the game port (one bind list, `GetBindAddresses` in network.cpp).
- One command registry: `src/commands.js`. CLI (`bin/`), daemon (`src/daemon.js`) and MCP (`src/mcp.js`) are thin wrappers. Add commands only there.
- GS ↔ admin protocol: `docs/PROTOCOL.md`. Keep GS replies < 1100 B; return arrays for big data.
- Bump `GetVersion()` in `gamescript/AgentBridge/info.nut` whenever main.nut changes; bump package semver + CHANGELOG per release; tag `vX.Y.Z`.
- Tests: `npm test` (fake admin server in test/fake-server.js mirrors GS commands; extend it with every new GS command).
- Verified GS API names against OpenTTD 15.3 headers (src/script/api). Check new ones the same way before use.
- Personal skills live in the private repo `openttd-agent-skills`, not here.
- State changes are **exec steps**: add an op to `ExecStep` in main.nut, mirror it in the fake server's `exec`, and build the step list in the command (`run(ctx, a, steps)`). Never add a one-off GS build handler.
- Row decoders for operate data live in `src/operate.js` (pure, unit-tested).
- Not exposed to GameScripts in 15.3 (don't promise them): vehicle breakdown count, service interval, vehicle-lost/unprofitable/engine-available events, production-change events.
- No Squirrel compiler on this machine: errors show only in the launch profile's `openttd.log` (`-d script=4`). Before a real run, check API calls with `python3 -I tools/check_gs_api.py <headers dir> gamescript/AgentBridge/main.nut`.
- GS rules learned in the first real run (0.1.0): never dispatch through `.call()`/`acall()` or sort/valuator callbacks around DoCommands (a native call on the stack makes any DoCommand fatal and the script dies silently); company-scoped getters without a company arg (`GetLoanAmount`) need `GSCompanyMode`; a script death logs only "The script died unexpectedly".
- OpenTTD with `-c`: the cfg's folder becomes config + personal dir (secrets.cfg, saves, log); `~/Documents/OpenTTD` is still scanned for baseset/game/ai. secrets.cfg is ignored unless openttd.cfg has `[version] ini_version` >= 1 (launch writes 7).
- Real-game test loop: `launch --mode dedicated --admin_password <pw> --bind 127.0.0.1 [--terrain mountainous --map_bits 9]`, then rcon `start_ai IdleAI` for a company (id 0). Relay check: `relay-add-player --name t --company 0`, `relay`, then a second `OPENTTD_AGENT_HOME` with `configure --relay http://127.0.0.1:47978 --token <t>`; `relay-remove-player` after. Tested 0.1.0: map mirror 2.2 s (256²) / 8.4 s (512²); ~35 dry-run builds/s via `batch`.
- Path planning and build templates are pure functions in `src/planner.js` (`planPath`, `railSteps`, `roadSteps`, `terminusSteps`, `passingLoopSteps`); test them on synthetic maps in `test/planner.test.js`.
- Rail `build-rail` anchors get no track (verified in play). Joining onto existing track (depots, branches) needs `build-track`. Signal facing (`front`) is still unverified in play.
