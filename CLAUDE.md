# openttd-agent

Shared package (public): CLI + MCP + AgentBridge GameScript for agent-driven OpenTTD companies on a LAN.
Research and design history: ~/code-local/openttd-agent-research/FINDINGS.md.

- One command registry: `src/commands.js`. CLI (`bin/`), daemon (`src/daemon.js`) and MCP (`src/mcp.js`) are thin wrappers. Add commands only there.
- GS ↔ admin protocol: `docs/PROTOCOL.md`. Keep GS replies < 1100 B; return arrays for big data.
- Bump `GetVersion()` in `gamescript/AgentBridge/info.nut` whenever main.nut changes; bump package semver + CHANGELOG per release; tag `vX.Y.Z`.
- Tests: `npm test` (fake admin server in test/fake-server.js mirrors GS commands; extend it with every new GS command).
- Verified GS API names against OpenTTD 15.3 headers (src/script/api). Check new ones the same way before use.
- Personal skills live in the private repo `openttd-agent-skills`, not here.
