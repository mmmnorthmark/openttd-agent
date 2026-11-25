# Changelog

Semver. The GameScript has its own integer version (`GetVersion()` in info.nut); the host must
re-run `install-gamescript` when it changes.

## 0.1.0 (unreleased)
- CLI (JSON output, batch mode, auto-started local daemon) and MCP server over one command registry.
- AgentBridge GameScript v2: world queries, airport checks, road build, rate limits.
- World mirror with analysis: find-cargo-pairs, town-gaps, route-effort, airport-sites.
- Setup: doctor, install-gamescript, configure, launch (dedicated / host / join).
