# OpenTTD compatibility

openttd-agent checks which OpenTTD it runs with (`src/versions.js`):

| Class | Example | What happens |
|---|---|---|
| `tested` | 14.0, 14.1, 15.0, 15.1, 15.2, 15.3 | runs |
| `newer_untested` | 15.4, 16.0 | `launch` and game connections refuse (`first_error: untested_openttd_version`) unless accepted |
| `beta` | 16.0-beta1, 16.0-RC1 | refused unless accepted |
| `custom` | nightlies, own builds | refused unless accepted |
| `older_unsupported` | 13.4 and older | always refused (`unsupported_openttd_version`): the GameScript does not load |

Accept an untested version with `launch --accept_untested true`, `configure --accept_untested true`
or `OPENTTD_AGENT_ACCEPT_UNTESTED=1`. `doctor` shows the installed version and its class; `status`
shows the server's version (from the admin welcome), the local one, and whether they match.
OpenTTD only lets a client join a server of exactly the same version, so every player installs
the host's version (official builds of every release: `https://cdn.openttd.org/openttd-releases/<version>/`).
Host commands (`server-stop`, `load`, `server-log` ...) are never version-gated, so any server
started by `launch` can still be stopped.

## GameScript and the OpenTTD API

AgentBridge (v14) declares script API 14: OpenTTD 14.x loads it as it is, 15.x and newer load it
through their `compat_14.nut` (string wrappers only). Two calls it uses are newer than 14.x and
are picked at run time:

| Call | 15.0+ | 14.x |
|---|---|---|
| owner of a station (`station_first_vehicle` events) | `GSBaseStation.GetOwner` | `GSStation.GetOwner` |
| "is a town building" (`demolish`, `purchase-land` checks) | `GSTile.IsHouseTile` | approximation: an unowned town-authority tile that is not transport, water, station, industry or clear land (an unowned object such as a transmitter also counts) |

AgentBridge v12 and older declared API 15 and do not load on 14.x at all ("GetAPIVersion returned
invalid version" in the server log).

## Version matrix

`tools/version-matrix.mjs` downloads each official release from cdn.openttd.org, checks its
sha256 against the release's `manifest.yaml`, unpacks it into `~/.cache/openttd-agent/versions/<v>/`
and runs a smoke suite in a sandbox: its own `HOME` (so `~/Documents/OpenTTD` and
`~/.local/share/openttd` are inside the sandbox), its own `OPENTTD_AGENT_HOME`, OpenGFX 8.0
(sha256-checked) as the base set, its own ports (4100 + 10 per version) and `--no-daemon`.
Every server it starts is stopped with `server-stop` and, failing that, by its own profile's
cfg path only.

Smoke suite: `doctor` (detected version), `install-gamescript` (into the sandbox),
`launch --mode dedicated --bind 127.0.0.1` (128x128, very flat, seed 12345) waiting until
AgentBridge answers, `status` (server version from the admin welcome), `company-new --ai IdleAI`,
`build-road-path` as a dry run and for real, `vehicles`, a dry-run `demolish` per tile around the
biggest town until one answers "town building" (the house check), `save`, `load`, `status`,
`server-log --errors true` (AgentBridge still `started`, not died), `server-stop`.

```sh
node tools/version-matrix.mjs                         # every 14.x and 15.x release
node tools/version-matrix.mjs --versions 15.3,16.0-RC1 # chosen ones (betas too)
node tools/version-matrix.mjs --download_only true    # fetch and verify only
```

Linux: `.github/workflows/version-matrix.yml` runs the same suite on the generic amd64 builds
(`--platform linux`), one job per release, weekly and on pull requests that touch the GameScript
or the version code. It has not been run from this repo yet; the first run will show whether the
runtime library list in it is complete (a failing job prints the missing ones with `ldd`).

### Results: macOS (universal builds, arm64 Mac, Node v22.23.4), 2026-11-27, openttd-agent 0.8.0 (unreleased)

| OpenTTD | sha256 | detected | server | AgentBridge | doctor | launch | status | company-new | build dry run | build real | vehicles | house check | save | load | status after load | gs alive | server-stop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 14.0 | verified | 14.0 | 14.0 | v14 | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 14.1 | verified | 14.1 | 14.1 | v14 | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 15.0 | verified | 15.0 | 15.0 | v14 | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 15.1 | verified | 15.1 | 15.1 | v14 | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 15.2 | verified | 15.2 | 15.2 | v14 | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |
| 15.3 | verified | 15.3 | 15.3 | v14 | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok | ok |

Re-run on the final 0.8.0 hardening tree (after merging the rail, fleet and observation batches): same result.

Saves do not travel to older versions: 14.1 loading a 15.3 save fails ("Savegame is made with
newer version"); `load` answers `save_too_new` (the server has started a new random game instead) and
`launch --load` reports why the server exited.

Not in `TESTED_VERSIONS`, run for information with the acceptance set:

| OpenTTD | result |
|---|---|
| 16.0-RC1 | every smoke step ok (AgentBridge v14 through compat_14 + compat_15); still refused without `--accept_untested` until a 16.0 release passes |
