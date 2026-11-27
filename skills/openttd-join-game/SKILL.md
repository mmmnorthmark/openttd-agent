---
name: openttd-join-game
description: Join someone else's OpenTTD game night as a player and let this agent run your company through the host's openttd-agent relay. Use when the user says "join the OpenTTD game", "connect to game night", "I'm playing OpenTTD with friends", has a relay URL and token from a host, or asks how to set up openttd-agent as a player (not the host).
license: MIT
---

# Join an OpenTTD game night (player)

You help a player whose friend is **hosting** an OpenTTD LAN game. The host runs the server and an
openttd-agent **relay**; you act for the player's company through that relay with a personal token.
If the user is the one hosting, use the `openttd-host-game` skill instead.

## Commands in this skill

Every example writes `openttd-agent ...`. Unless the user installed it globally, run it as
`npx -y github:mmmnorthmark/openttd-agent#<tag> ...`, where `<tag>` is **the release tag the host
uses** (for example `v0.8.0`; ask the host). Every command prints JSON. `openttd-agent help` lists
commands; `openttd-agent <command> --help` shows one command's flags. Unknown flags are refused.

**First step:** run `openttd-agent guide --role player` and follow its `next` step (v0.5.0 and later).
It is read-only and prints no secrets. On older releases, follow the steps below.

## 1. Ask the host for exactly two things

- The **relay URL**: `http://<host-LAN-IP>:47978`
- Your **token** (the host gets it from `relay-add-player`; it is shown once)

Also ask which openttd-agent tag they use. **Never ask for, accept or store the admin password.**
A player does not need it, and anyone holding it can act as every company.

## 2. Check this machine

```sh
openttd-agent doctor
```

- `openttd_version` must equal the host's OpenTTD version (15.x), or the game will not let you join.
- Node 20 or newer (`node --version`).
- Graphics: OpenGFX works. For the original TTD look, the player puts their **own** original TTD
  files in `Documents/OpenTTD/baseset`. Run OpenTTD once before game night.
- A player does **not** run `install-gamescript`, `launch` or `relay`; those are host jobs.

## 3. Point openttd-agent at the host

```sh
openttd-agent configure --relay http://<host-LAN-IP>:47978 --token <token>
openttd-agent status
```

`status` answers through the relay. `my_company` is the company the host bound your token to;
`null` means not yet (step 4).

## 4. The human joins and founds the company

The **person** (not the agent) does this in the OpenTTD window: **Multiplayer** → **Add server**
`<host-LAN-IP>:3979` → join → **New company**. Then they tell the host, who runs
`relay-set-company` to bind the token to that company. Run `status` again until `my_company` is a number.

## 5. Connect the agent

- **Claude Code** (MCP tools; tool names use underscores, e.g. `goal_status`):
  `claude mcp add openttd -- npx -y github:mmmnorthmark/openttd-agent#<tag> mcp`
- **Any other MCP client** (stdio): command `npx`, args `["-y", "github:mmmnorthmark/openttd-agent#<tag>", "mcp"]`.
- **No MCP:** use the CLI directly. Often faster: chain calls and filter the JSON.

## 6. Rules of the road (tell the user, then follow them)

- **Real time.** The game does not pause for you; a game day is about 2 s, a year about 12 minutes.
  Keep each turn to a few calls and prefer composite commands.
- **Your company only.** The token builds and operates only as the bound company. `--company <other>`
  is refused; leave `--company` out.
- **Agree what you may touch.** You can act on anything the company owns, including what the human
  built by hand. Before the first build, agree a split (for example: agent runs rail, human runs
  road vehicles). Never sell, reroute or demolish something you did not build without asking.
- Host-only things are refused for you: rate limits, goals, pause, saving, launching.
- Chat you send (`chat --message`) is shown with your player name. Be a good sport.

## 7. Start playing

```sh
openttd-agent goal-status                                # what wins, and the deadline
openttd-agent find-cargo-pairs --cargo coal --limit 5    # opportunities; try other cargos too
openttd-agent build-cargo-route --from_industry <id> --to_industry <id> --cargo coal --dry_run true
openttd-agent build-cargo-route --from_industry <id> --to_industry <id> --cargo coal
openttd-agent vehicle-problems                           # every turn; fix "action" rows first
```

Always dry-run first and check each step's `ok`. For the full loop, use the `openttd-play` skill.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `cannot reach the relay` | Is `openttd-agent relay` running on the host, TCP 47978 open in its firewall, and the URL in `show-config` right? |
| `missing or unknown token` | Ask the host for a new token (`relay-remove-player`, then `relay-add-player`). |
| `not bound to a company yet` / `my_company: null` | The human founds a company first; then the host runs `relay-set-company`. |
| `unknown command` through the relay | You and the host run different tags. Use the host's tag. |
| Can't join in the OpenTTD window | Same OpenTTD version? Host's LAN IP, not 127.0.0.1? Host firewall open for TCP 3979? |
| AgentBridge did not answer | Host job: `install-gamescript`, then load the game again. |
