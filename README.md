# openttd-agent

Let a coding agent (Claude Code, or anything that speaks MCP or runs shell commands) read an
OpenTTD world and build for **your** company while you play the same company by hand.

- **CLI first.** Every command prints JSON, so agents can chain and script calls ("code mode").
- **MCP too.** `openttd-agent mcp` exposes the same commands as MCP tools.
- **Bundled GameScript** (`AgentBridge`) does the in-game work; only the **host** installs it.
- **LAN games.** Talks to the host's admin port with the admin password. Don't expose that port to the internet.

## Install / update

Needs Node 20+ and OpenTTD 15.x.

```sh
npx -y github:mmmnorthmark/openttd-agent#v0.1.0 doctor
```

To update, change the tag (`#v0.2.0`) wherever you reference it, and the **host** re-runs
`install-gamescript`. See [CHANGELOG.md](CHANGELOG.md).

Optional: `npm i -g github:mmmnorthmark/openttd-agent#v0.1.0` gives you a plain `openttd-agent` command.

### Claude Code MCP config

```sh
claude mcp add openttd -- npx -y github:mmmnorthmark/openttd-agent#v0.1.0 mcp
```

## Game night

**Host** (the machine running the game):

```sh
openttd-agent install-gamescript
openttd-agent launch --mode dedicated --admin_password <shared-secret> --map_bits 9
# optional rate limit for everyone: --command_delay_ticks 2 --max_builds_per_day 50
```

Then everyone, the host included, joins the game from OpenTTD's Multiplayer menu (or
`openttd-agent launch --mode join --join_host <host-LAN-IP>`) and starts or joins their company.

**Each player** (once):

```sh
openttd-agent configure --host <host-LAN-IP> --admin_password <shared-secret>
openttd-agent companies                 # find your company id
openttd-agent configure --company <id>
openttd-agent status
```

## Commands

`openttd-agent help` lists them all; `openttd-agent commands` prints JSON schemas.

| Group | Commands |
|---|---|
| setup | `doctor`, `install-gamescript`, `configure`, `show-config`, `launch` |
| game | `status`, `companies`, `chat`, `rate` |
| world (read-only) | `towns`, `industries`, `industry-types`, `cargos`, `town-gaps`, `find-cargo-pairs`, `route-effort`, `airport-types`, `airport-sites`, `tiles` |
| operate: look | `stations`, `vehicles`, `vehicle`, `engines`, `groups`, `depots`, `events`, `autorenew` |
| operate: change | `vehicle-buy`, `vehicle-clone`, `vehicle-start`, `vehicle-stop`, `vehicle-depot`, `vehicle-sell`, `vehicle-refit`, `vehicle-rename`, `order-add`, `order-remove`, `order-flags`, `order-skip`, `orders-copy`, `group-create`, `group-rename`, `group-delete`, `group-move`, `group-autoreplace` |
| build (your company) | `test-build-road`, `build-road` |

Every command that changes the game takes `--dry_run true` (cost and feasibility only) and
`--company <id>` (default: your configured company).

Examples:

```sh
# Unexploited forests 100-200 tiles from a sawmill, easiest terrain first
openttd-agent find-cargo-pairs --cargo wood --source_type forest --dest_type sawmill \
  --min_distance 100 --max_distance 200 --max_transported_pct 20

# Towns with the most untransported passengers
openttd-agent town-gaps --min_population 1000

# Where could I put a small airport near Bigton?
openttd-agent airport-sites --town Bigton --airport small

# Run a strategy as a group: loss-making trains, stations with poor ratings, what's new
openttd-agent vehicles --type rail --max_profit_last_year 0
openttd-agent stations --max_rating_pct 40 --min_waiting 100
openttd-agent engines --type rail --cargo wood
openttd-agent events --since 0

# Buy a train at a depot, give it orders, start it
openttd-agent vehicle-buy --depot_x 13 --depot_y 22 --engine 5            # -> vehicles: [11]
openttd-agent vehicle-buy --depot_x 13 --depot_y 22 --engine 27 --cargo wood --attach_to 11 --count 5
openttd-agent order-add --vehicle 11 --station 3 --flags full_load_any,non_stop
openttd-agent order-add --vehicle 11 --station 4 --flags unload,non_stop
openttd-agent vehicle-start --vehicles 11

# Chain many calls in one process
printf '%s\n' '{"name":"status"}' '{"name":"town-gaps"}' | openttd-agent batch
```

Library use from a script:

```js
import { connect } from 'openttd-agent';
const game = await connect();
console.log(await game.run('companies'));
game.close();
```

## Rate limiting

Off by default (full speed). Two independent limits:

- **GameScript (host, applies to everyone):** `launch --command_delay_ticks N --max_builds_per_day N`,
  changeable live in OpenTTD's GameScript settings or with `openttd-agent rate`.
- **Client (each player, self-imposed):** `configure --max_builds_per_minute N`.

## How it works

```
your agent ──CLI/MCP──▶ openttd-agent (daemon keeps the connection + map mirror)
                              │ admin port (TCP 3977, LAN)
                              ▼
                        OpenTTD host ── AgentBridge GameScript (GSCompanyMode builds as your company)
```

- The daemon starts automatically on the first game command and listens on 127.0.0.1 only.
- It copies the whole map into memory once (height, slope and tile type for every tile), then
  keeps refreshing it in the background, so analysis questions don't slow the game.
- Wire protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Development

```sh
npm install && npm test     # unit tests + a fake admin server end-to-end test
```

Config lives in `~/.openttd-agent/` (`config.json`, launch `profiles/`). Your own `openttd.cfg` is never modified.
