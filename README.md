# openttd-agent

Let a coding agent (Claude Code, or anything that speaks MCP or runs shell commands) read an
OpenTTD world and build for **your** company while you play the same company by hand.

- **CLI first.** Every command prints JSON, so agents can chain and script calls ("code mode").
- **MCP too.** `openttd-agent mcp` exposes the same commands as MCP tools.
- **Bundled GameScript** (`AgentBridge`) does the in-game work; only the **host** installs it.
- **LAN games, per-player access.** The host runs a small **relay**; each player gets their own token, bound to
  one company. Nobody but the host's machine ever holds the admin password.

## Install / update

Needs Node 20+ and OpenTTD 15.x with the original TTD graphics or OpenGFX (run OpenTTD once first).
Nothing to clone: run it straight from GitHub with `npx`, pinned to a release tag.

```sh
npx -y github:mmmnorthmark/openttd-agent#v0.6.0 doctor      # checks OpenTTD, graphics, GameScript
```

Every example below writes `openttd-agent ...`. Either make that a short alias for the `npx` form:

```sh
alias openttd-agent='npx -y github:mmmnorthmark/openttd-agent#v0.6.0'   # add to ~/.zshrc or ~/.bashrc
```

or install it once: `npm i -g github:mmmnorthmark/openttd-agent#v0.6.0`.

**Versions.** Releases follow [semver](https://semver.org) and are git tags `vX.Y.Z`
([CHANGELOG.md](CHANGELOG.md)); `main` may be ahead of the latest release. To update, change the
tag wherever you use it (alias, MCP config), then the **host** re-runs `install-gamescript` and
loads the game again (a running game keeps the GameScript it started with).

### Use it from an agent

Claude Code, as MCP tools:

```sh
claude mcp add openttd -- npx -y github:mmmnorthmark/openttd-agent#v0.6.0 mcp
```

Any other MCP client: command `npx`, args `["-y", "github:mmmnorthmark/openttd-agent#v0.6.0", "mcp"]`.
For a small or fast model, expose only the tools it needs and get compact results (unreleased, on `main`):
`openttd-agent mcp --tools goal-status,stations,vehicles,find-cargo-pairs,build-cargo-route --compact true`.
Agents that run shell commands can use the CLI directly; it is often faster than MCP because they
can chain calls (`batch`) and filter JSON.

### Agent skills

Skills that teach any coding agent to host, join or play a game are in [`skills/`](skills/README.md):
`openttd-host-game`, `openttd-join-game`, `openttd-play`. In Claude Code:

```
/plugin marketplace add mmmnorthmark/openttd-agent
/plugin install openttd-agent@openttd-agent
```

Other agents: copy a skill folder into the agent's skills directory, or paste its `SKILL.md` as a
prompt. The skills don't include the MCP server; add it as above.

## Quick start: you, an agent and one company (about 10 minutes)

```sh
openttd-agent doctor                                        # all green?
openttd-agent install-gamescript                            # copies AgentBridge into OpenTTD
openttd-agent launch --mode dedicated --bind 127.0.0.1      # headless server on this machine, new 256x256 map
```

1. Open OpenTTD → Multiplayer → **Add server** `127.0.0.1:3979` → join → **New company**.
2. Point openttd-agent at that company and look around:

   ```sh
   openttd-agent companies                     # find your company id (usually 0)
   openttd-agent configure --company 0
   openttd-agent status
   openttd-agent find-cargo-pairs --cargo coal --limit 3
   ```

3. Build a whole route, price first:

   ```sh
   openttd-agent build-cargo-route --from_industry <source id> --to_industry <dest id> --cargo coal --dry_run true
   openttd-agent build-cargo-route --from_industry <source id> --to_industry <dest id> --cargo coal
   ```

   Watch the stations, track, depot and train appear in your OpenTTD window.
4. Hand it to your agent: "You run OpenTTD company 0 with the `openttd-agent` CLI (JSON output).
   Start with `openttd-agent help`; use `<command> --help` for arguments and `--dry_run true`
   before every build."

To play from another machine (a laptop on the same network or VPN), launch with `--bind 0.0.0.0`
and join `<this machine's IP>:3979`. Read the security notes under Game night first: the admin port
is then reachable too. With `--bind <one address>` the server listens only there, so `launch` saves
that address as `host` in the config (the CLI on this machine then reaches the admin port there).

`launch` writes its own launch profile: `[game_scripts]` lists AgentBridge only (an entry copied
from your own openttd.cfg, such as `none =`, used to win and the game ran without AgentBridge),
and `private.cfg` names the server (`server_name`) and the dedicated server's own client
(`client_name = openttd-agent server`, instead of "Unnamed Client").

## Game night

One **host** on the LAN runs a dedicated server. Every **player** joins it in the OpenTTD window
and founds a company; each player's coding agent then drives that company through the host's
**relay** (the agent may run on the host or on the player's own machine).

Lost? `openttd-agent guide` (or `guide --role host|player`) checks what is already done on this
machine and prints the steps as JSON, with `next` = the first one still to do. It is read-only,
starts nothing and prints no secrets; agents should run it first.

### Before you start (every machine)

1. **Same OpenTTD version everywhere** (15.x): `openttd-agent doctor` prints `openttd_version`.
2. **Node 20+**, and the same openttd-agent tag as the host (`guide` on a player compares them).
3. **Graphics:** OpenGFX is fine. To use the original TTD graphics, put your own original files in
   `Documents/OpenTTD/baseset`. Run OpenTTD once on each machine.

### Host

1. `openttd-agent install-gamescript` (again after every openttd-agent update).
2. `openttd-agent launch --mode dedicated --map_bits 9`: a headless server bound to `0.0.0.0`
   (game 3979, admin 3977). It generates the admin password and keeps it in your config.
   Optional rate limit for everyone: `--command_delay_ticks 2 --max_builds_per_day 50`.
3. `openttd-agent relay` in its own terminal; leave it running (port 47978).
4. Allow incoming **TCP 3979** (game) and **TCP 47978** (relay) in the firewall (macOS asks the
   first time; on Windows allow Node.js and OpenTTD on private networks).
5. Find your LAN IP to give the players: macOS `ipconfig getifaddr en0`; Windows `ipconfig`
   (IPv4 Address); Linux `hostname -I`. `guide --role host` lists it too.
6. Everyone, host included, opens OpenTTD → **Multiplayer** → **Add server** `<host-LAN-IP>:3979` →
   join → **New company**.
7. Register each agent that should play, and send the player the `configure` line it prints
   (the token is shown only once):

   ```sh
   openttd-agent relay-add-player --name joe --company pending
   ```

8. Once joe has founded his company, bind him to it:

   ```sh
   openttd-agent companies                           # find the company ids
   openttd-agent relay-set-company --name joe --company 1
   openttd-agent relay-list-players                  # who is bound to what
   ```

9. Optional, so there is a winner: the same goal for every company,
   `openttd-agent goal-set --company <id> --deadline_year 1960 --targets VALUE:500000` (see Goals).
10. End of the night: `openttd-agent save --name game-night-1` (writes `save/game-night-1.sav` in the
    launch profile); next time `openttd-agent launch --mode dedicated --load game-night-1`.
    `relay-remove-player --name joe` stops a token at once.

### Each player

1. Run the `configure` line the host sent:
   `openttd-agent configure --relay http://<host-LAN-IP>:47978 --token <token>`.
2. `openttd-agent status`: `my_company` is the company the host bound you to (`null` = not yet;
   ask the host to run step 8).
3. Connect your agent. Claude Code:

   ```sh
   claude mcp add openttd -- npx -y github:mmmnorthmark/openttd-agent#v0.6.0 mcp
   ```

   Any other MCP client: command `npx`, args `["-y", "github:mmmnorthmark/openttd-agent#v0.6.0", "mcp"]`.
   Or let the agent use the CLI directly (`openttd-agent help`; every command prints JSON).

### Several players or agents on one machine (profiles)

Each relay token can live in its own profile instead of the shared config, so agents never need
to export a token on every call:

```sh
openttd-agent --profile alice configure --relay http://192.168.1.20:47978 --token <alice's token>
openttd-agent --profile alice status                 # or: OPENTTD_AGENT_PROFILE=alice openttd-agent status
OPENTTD_AGENT_PLAYER_FILE=/path/to/alice.json openttd-agent status   # any JSON file with relay + relay_token (or token)
```

A profile is `~/.openttd-agent/players/<name>.json`; its keys override `config.json`, and env vars
override both. `configure` with a profile writes to the profile. MCP: `openttd-agent --profile alice mcp`.
A profile without a relay (direct admin-port mode) runs each call in its own process instead of the
shared daemon, so its `company` applies.

### A human and an agent in one company

Today the agent can act on anything the company owns: it can sell, reroute or demolish what you
built by hand, and you can do the same to its work. Agree up front who builds what (for example:
the agent runs rail, you run road vehicles), and have the agent check `vehicles` and `stations`
before changing them. A guard that keeps the agent off things it did not build is planned.

### What a player's token can do

- Read the world (towns, industries, map, all companies' figures) and run every analysis command.
- Build and operate **only as the company the host bound it to**. `--company <other>` is refused;
  leaving it out always means "my company". Two read-only exceptions show what the game window
  shows anyone: `stations --company X` (a rival's stations, waiting cargo and ratings, without
  vehicle counts) and `vehicles --company X` (counts per vehicle type only).
- Not: `rate` changes, `launch`, `install-gamescript`, `scenario-prepare`, `save`, setting goals,
  pausing or advancing turns, anything on the host's config, or raw console access.
- Chat sent through the relay is prefixed with the player's name.

The host sees who did what in `~/.openttd-agent/relay-audit.jsonl` (one JSON line per command or
refusal: time, player, company, command, arguments, outcome).

### Troubleshooting

- Start with `openttd-agent guide`: its `next` step usually names the problem, with the error in `detail`.
- **Can't join the game:** same OpenTTD version on both machines? Firewall open for TCP 3979? Right IP
  (the host's LAN address, not 127.0.0.1)?
- **`cannot reach the relay`:** is `openttd-agent relay` running on the host, TCP 47978 open, and the
  URL in `show-config` right?
- **`missing or unknown token`:** the host re-issues one (`relay-remove-player`, then `relay-add-player`).
- **`not bound to a company yet`:** the host runs `relay-set-company` (step 8).
- **`unknown command` through the relay:** player and host run different openttd-agent versions
  (`status` warns about it, and about a game running an older AgentBridge).
- **AgentBridge did not answer:** the host runs `install-gamescript` and launches the game again with
  `openttd-agent launch` (`doctor` lists launch profiles whose `[game_scripts]` is wrong). A loaded
  save runs the GameScript stored in it.

### Security notes

- **Never hand out the admin password.** Anyone holding it has the full server console and can act
  as any company; the GameScript cannot tell admin connections apart. That is why the relay exists.
- OpenTTD binds the admin port (3977) to the same addresses as the game port, so on a LAN game it
  is reachable from the LAN; the password is what protects it. `launch` generates a long random one.
- The relay speaks plain HTTP, so **tokens cross the LAN in clear text**. Fine for a home network;
  don't run it over the internet or on a network you don't trust.
- Tokens are stored on the host only as SHA-256 hashes (`~/.openttd-agent/relay-players.json`, mode 0600).

## Commands

`openttd-agent help` lists them all; `openttd-agent commands` prints JSON schemas.

| Group | Commands |
|---|---|
| setup | `guide` (what to do next, host or player), `doctor`, `install-gamescript`, `configure`, `show-config`, `launch`, `scenario-prepare` (host) |
| relay (host) | `relay` (the server), `relay-add-player`, `relay-list-players`, `relay-set-company`, `relay-remove-player` |
| game | `status`, `companies`, `chat`, `rate`, `goal-status` |
| host (refused through the relay) | `goal-set`, `goal-clear`, `pause`, `unpause`, `turn-advance`, `save` |
| world (read-only) | `towns`, `industries`, `industry-types`, `cargos`, `town-gaps`, `find-cargo-pairs` (industries and towns; town to town for passengers and mail), `acceptance`, `route-effort`, `airport-types`, `airport-sites` (with your company: `owned` per site), `tiles`, `owned-land` (your owned land as rectangles; GameScript v10) |
| operate: look | `stations`, `vehicles`, `vehicle`, `engines`, `groups`, `depots`, `events`, `autorenew` |
| operate: diagnose | `vehicle-problems` (one row per problem, including `stalled_on_line` and `deadlock`: `problem`, `severity` (`action` or `info`; `--severity action` for only what needs a command), `evidence`, `suggested_fix`, with the id and the unit number the game shows as "Train #4"), `verify-route` (`--vehicle ID`, or `--from_station A --to_station B`: is there a rail or road path (road: GameScript v11), and if not, the last reachable tile and the first gap) |
| operate: change | `vehicle-replace` (buy or clone on the route, start, sell the old one when it reaches the depot), `vehicle-reverse`, `vehicle-buy`, `vehicle-clone`, `vehicle-start`, `vehicle-stop`, `vehicle-depot` (safe to repeat: `already_heading`, `already_in_depot`), `vehicle-sell`, `vehicle-refit`, `vehicle-rename`, `order-add`, `order-remove`, `order-flags`, `order-skip`, `orders-copy`, `group-create`, `group-rename`, `group-delete`, `group-move`, `group-autoreplace`, `loan` (`--amount N`, `--borrow N`, `--repay N` or `--max true`; GameScript v8) |
| build: rail | `build-cargo-route` (stations, line, depot, train, orders in one call), `station-sites`, `build-line-depot`, `rail-types`, `build-rail` (planned path), `build-track` (one piece, for junctions and depot spurs), `build-rail-station`, `build-rail-depot`, `build-signal`, `build-terminus`, `build-passing-loop` (`--for_vehicle ID` sizes it for that line's longest train and traces the route after; `--remove true` undoes it), `loop-sites` (ranked, dry-run loop sites on a line) |
| build: road | `build-road-path` (planned path), `build-road-station` and `build-road-depot` (`connected`; `--connect auto` joins them to the nearest road; GameScript v11), `build-road` / `test-build-road` (straight) |
| build: other | `bridge-types`, `build-bridge`, `build-tunnel`, `terraform`, `demolish`, `purchase-land` (owned land, up to 400 tiles; GameScript v10), `build-dock`, `build-buoy`, `build-water-depot`, `build-airport` |

Every command that changes the game takes `--dry_run true` (cost and feasibility only). It acts as
your company: the one the host bound your token to (a different `--company` is refused).

**Results (0.7.0).** Every command prints one JSON object with `ok` (true/false) and `error`
(human text; `null` on success). A failure also has `first_error`, a short code: a game code such
as `ERR_AREA_NOT_CLEAR`, or one of ours such as `no_signal_here` or `refused`. List commands
(`stations`, `vehicles`, `towns`, `industries`, `engines`, `companies`, `depots`, ...) return
`{ok, error, total, matched, <items>, truncated}`, where `<items>` is named after the command
(`stations`, `towns`, ...): `total` before filters, `matched` after, `truncated` when `--limit`
cut the list. Build results keep their per-step `results[]`; in a dry run, a signal on track the
same command would lay is marked `skipped_in_dry_run` instead of failing, so a dry run's `ok` is
trustworthy. Cargo names are matched loosely: `iron_ore`, `Iron Ore` and `iron-ore` are the same.

Examples:

```sh
# Unexploited forests 100-200 tiles from a sawmill, easiest terrain first
openttd-agent find-cargo-pairs --cargo wood --source_type forest --dest_type sawmill \
  --min_distance 100 --max_distance 200 --max_transported_pct 20

# Goods from a factory to towns that accept them
openttd-agent find-cargo-pairs --cargo goods --dest_kind town

# Passengers between two towns, then feed the names to build-cargo-route
openttd-agent find-cargo-pairs --cargo passengers --min_distance 30
openttd-agent build-cargo-route --from_town Bigton --to_town Smallham --cargo passengers --dry_run true

# A whole rail route in one call: check and price it first, then build it
openttd-agent build-cargo-route --from_industry 6 --to_industry 9 --cargo "iron ore" --dry_run true
openttd-agent build-cargo-route --from_industry 6 --to_industry 9 --cargo "iron ore"

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
openttd-agent vehicle-clone --vehicle 11 --depot auto --count 2 --start true   # more trains, same orders

# Build a wood line: terminus at the forest, line to the sawmill, depot, then the train
openttd-agent build-terminus --x 12 --y 20 --platforms 2 --length 5 --dry_run true   # cost first
openttd-agent build-terminus --x 12 --y 20 --platforms 2 --length 5                  # -> connect_at {x,y,dir}
openttd-agent build-rail --x1 19 --y1 20 --start_dir sw --x2 140 --y2 61 --dry_run true
openttd-agent build-rail --x1 19 --y1 20 --start_dir sw --x2 140 --y2 61

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

## Playing a BaNaNaS scenario

BaNaNaS is OpenTTD's own content service (the in-game "Check Online Content"). A scenario loaded
as it comes would not start AgentBridge: a loaded game runs only the GameScript saved inside it.
`scenario-prepare` (host) downloads the scenario into the running server and writes a copy that does:

```sh
openttd-agent launch --mode dedicated                      # any game with AgentBridge running
openttd-agent scenario-prepare --search "empire builder"   # several matches: the error lists ids and names
openttd-agent scenario-prepare --content_id 15847807 --load true
```

- Result: `<save folder>/<name>_agent.sav`, plus how to load it. `--load true` leaves the server
  running it; without it, the game that was running is restored.
- Later: `openttd-agent launch --load <name>_agent` starts a server straight from that save.
- Do it before players join: the server loads the scenario for a moment, which drops clients.
- The copy differs from the scenario in three things only: the GameScript is AgentBridge (a goal
  script the scenario had will not run; set goals with `goal-set`), GameScript opcodes per tick
  are 100000, and everything may be done while paused (for turn-based play).
- Needs a server started by `launch` 0.2.0 or later (it writes uncompressed saves, which
  `scenario-prepare` reads and rewrites).

## Goals

A game runs one GameScript, so AgentBridge keeps the goals itself. The host sets one goal per company:

```sh
openttd-agent cargos                                        # the cargo labels of this game
openttd-agent goal-set --company 0 --deadline_year 1954 --targets COAL:3000,PASS:3000,GOOD:500
openttd-agent goal-status                                   # players: their own company's goal
openttd-agent goal-clear --company 0
```

- A cargo target counts what the company **delivers from now on**, anywhere on the map.
  `VALUE:500000` is a company value to reach instead.
- The goal shows in the game's goal window with progress, refreshed monthly and on every `goal-status`.
- `done` once every target was reached (a reached target stays reached); `failed` when the deadline
  year ends first. Both arrive as events (`goal_done`, `goal_failed`) in `events` and `turn-advance`.
- Goals are saved with the game. Setting a goal again replaces it and restarts the count.

## Real time or turns

**Real time is the normal game:** the clock runs while agents think, so a slow agent loses game
time. That is the default; nothing to set up. Multiplayer has no fast-forward: a game day takes
about 2 s, a year about 12 minutes, so give goals deadlines that fit the agent's speed.

**Turn-based (optional)**, for an agent that needs time to think: keep the game paused while it
plans and builds, then let time pass in chunks. Host commands:

```sh
openttd-agent pause                    # -> { paused, date, while_paused: "everything" }
openttd-agent turn-advance --days 30   # unpause, wait 30 game days (~60 s), pause; returns date + events
openttd-agent unpause
```

- A turn loop is: `goal-status`, look, build (the game is paused), `turn-advance`, repeat.
- Building while paused needs `construction.command_pause_level = 3`. `launch` sets it for new
  games and `scenario-prepare` for prepared scenarios; it cannot be changed in a running
  multiplayer game. `pause` reports what the running game allows.
- Multiplayer has no fast-forward: a game day takes about 2 s, a year about 12 minutes.
- Everyone in the game is paused. Human players can still look around, and build if the level allows.

## Building

- **Dry run first.** `--dry_run true` returns the cost and, per step, whether the game would
  accept it. Nothing is built and no rate limit is used. Signals on track the same command lays
  cannot be checked before the track exists: they show `skipped_in_dry_run`, and `ok` ignores them.
- **Paths are planned by openttd-agent** (on the host's relay) from the map mirror (flat and straight preferred; houses,
  industries and stations avoided; roads crossed on the level; water, rail and roads bridged), then
  built piece by piece. `build-rail` lays track strictly *between* its two anchor tiles (a station
  end, the tile in front of a depot, existing track); `build-road-path` includes both ends.
- **A failed step stops the build** and says why; what was built stays. Fix the spot (`terraform`,
  `demolish`, other anchors) and run the same command again: existing pieces are skipped.
- **`demolish` is guarded** in the GameScript: never another company's property, industries or town
  roads, and town buildings only with `--allow_houses true`.
- **`purchase-land` is all or nothing**: the GameScript checks every tile first (another
  company's property, industries, town buildings, roads, rail, stations, water, objects, land you
  already own) and the cost against your bank balance, and buys nothing if one fails. If the game
  still refuses a tile while buying, the reply lists the `bought` rectangles and the `failed_tile`.
- The planner's slope rules are simpler than the game's; on hilly ground expect to iterate.

## Tips for agents

- **Discover, don't guess:** `openttd-agent help` lists commands; `openttd-agent <command> --help`
  prints one command's arguments. Unknown flags are refused and nothing runs. `--id` is accepted
  for `--vehicle`, and `--vehicle`/`--vehicles` for each other.
- **Prefer the composite commands** (`build-cargo-route`, `station-sites`, `build-line-depot`,
  `find-cargo-pairs`): one call each instead of a dozen small ones, and they place things with the
  map mirror. Reading `tiles` to plan by hand is slow and error-prone; use it to look at a failure.
- **Dry run, check every step's `ok`, then build.** On failure, read the error, change one thing,
  and try once more; repeating the identical command will not help.
- **Check `vehicle-problems` every turn.** The game window shows "cannot reach" and loss-making
  trains to a player, but tells scripts nothing. `vehicle-problems` infers it: no rail path to the
  next order (`wrong_network`, `unreachable_destination`), no progress for 30 game days
  (`stuck_or_lost`; the daemon keeps the history, so it needs a second call that many days later),
  money lost last year, no orders, stopped, old or unreliable. Fix what it lists before building
  more; `verify-route --vehicle ID` shows where the track breaks.
- **Clone a train only at a depot of its own line.** A clone keeps its orders; in another line's
  depot it can never reach them (`vehicle-problems` reports `wrong_network`). `vehicle-clone
  --vehicle ID --depot auto` picks your depot nearest the train's first order station that is
  rail-connected to all its order stations; with `--depot_x/--depot_y` it refuses a depot that is
  not, and names one that is. `vehicle-buy --route_of ID` makes the same check before a buy.
- **Keep notes outside the game** (ids of what you built, the plan, what failed). Long games
  outlast any one context window.
- Slower or local models: keep each turn to a few composite calls; every call costs real time.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no welcome from 127.0.0.1:3977` | The server isn't running or the admin password differs: `show-config`, then `launch` again. |
| A command says AgentBridge is older than vN | The host runs `install-gamescript`, then loads the game again (`launch --load <save>`). |
| GS replies stop; log says "The script died unexpectedly" | Look in the launch profile's `openttd.log`; report it with the command you ran. |
| Can't join from another machine | Launch with `--bind 0.0.0.0` and allow OpenTTD through the firewall (TCP 3979). |
| Changed the code, behaviour didn't change | `openttd-agent daemon-stop`; the next call starts a fresh daemon. |
| The game shows "cannot reach" on trains | `vehicle-problems`, then `verify-route --vehicle <id>`: it names the gap, or says the train is on another line's track. |
| A route builds but earns nothing | `stations`: does the drop station show the cargo? `acceptance --x --y --cargo <c>` at it should be >= 8. |

## Rate limiting

Off by default (full speed). Two independent limits:

- **GameScript (host, applies to everyone):** `launch --command_delay_ticks N --max_builds_per_day N`,
  changeable live in OpenTTD's GameScript settings or with `openttd-agent rate`.
- **Relay (per player, set by the host):** `relay-add-player --max_builds_per_minute N` or
  `relay-set-company --name <n> --max_builds_per_minute N`; default is the host's own
  `configure --max_builds_per_minute N`.

## How it works

```
player's agent ──CLI/MCP──▶ openttd-agent ──HTTP + token (LAN, port 47978)──┐
                                                                            ▼
host's agent ──CLI/MCP──▶ openttd-agent ─────────────────────▶ openttd-agent relay (host)
                                                               │ checks token, forces company,
                                                               │ keeps the map mirror, audit log
                                                               │ admin port (TCP 3977, password stays here)
                                                               ▼
                                             OpenTTD ── AgentBridge GameScript (builds as that company)
```

- The relay copies the whole map into memory once (height, slope and tile type for every tile),
  then keeps refreshing it in the background. Analysis and path planning run there, so players
  need no map copy and questions don't slow the game.
- Playing alone, or as the host without the relay: leave `relay` unset and openttd-agent talks to
  the admin port itself through a local daemon (127.0.0.1 only, started automatically).
- Wire protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Development

```sh
npm install && npm test     # unit tests + a fake admin server end-to-end test
```

Releasing: bump `version` in package.json, date the CHANGELOG section, update the `#vX.Y.Z`
references in this README, commit, then `git tag -a vX.Y.Z -m vX.Y.Z` and push the branch with its tags.

Config lives in `~/.openttd-agent/` (`config.json`, launch `profiles/` with the server's saves and downloaded content, and on the host `relay-players.json`, `relay-audit.jsonl`). Your own `openttd.cfg` is never modified.
