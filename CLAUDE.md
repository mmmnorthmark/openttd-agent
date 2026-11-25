# openttd-agent

Shared package (public): CLI + MCP + AgentBridge GameScript for agent-driven OpenTTD companies on a LAN.
Research and design history: ~/code-local/openttd-agent-research/FINDINGS.md.

- One command registry: `src/commands.js`. CLI (`bin/`), daemon (`src/daemon.js`) and MCP (`src/mcp.js`) are thin wrappers. Add commands only there.
- GS ↔ admin protocol: `docs/PROTOCOL.md`. Keep GS replies < 1100 B; return arrays for big data.
- Bump `GetVersion()` in `gamescript/AgentBridge/info.nut` whenever main.nut changes; bump package semver + CHANGELOG per release; tag `vX.Y.Z`.
- Tests: `npm test` (fake admin server in test/fake-server.js mirrors GS commands; extend it with every new GS command).
- Verified GS API names against OpenTTD 15.3 headers (src/script/api). Check new ones the same way before use.
- Personal skills live in the private repo `openttd-agent-skills`, not here.
- State changes are **exec steps**: add an op to `ExecStep` in main.nut, mirror it in the fake server's `exec`, and build the step list in the command (`run(ctx, a, steps)`). Never add a one-off GS build handler.
- Row decoders for operate data live in `src/operate.js` (pure, unit-tested).
- Not exposed to GameScripts in 15.3 (don't promise them): vehicle breakdown count, service interval, vehicle-lost/unprofitable/engine-available events, production-change events.
- The GS has not been compiled by OpenTTD yet if `status` has never run against a real game: there is no Squirrel compiler on this machine, so a syntax slip in main.nut only shows in `openttd.log` (`-d script=3`).
- Path planning and build templates are pure functions in `src/planner.js` (`planPath`, `railSteps`, `roadSteps`, `terminusSteps`, `passingLoopSteps`); test them on synthetic maps in `test/planner.test.js`.
- Rail `build-rail` anchors get no track; signals face trains coming from `front`. Both conventions are from the 15.3 API source and still need a real-game check.
