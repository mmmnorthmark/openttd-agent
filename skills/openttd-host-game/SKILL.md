---
name: openttd-host-game
description: Host an OpenTTD game night on the LAN with openttd-agent - start the dedicated server with the AgentBridge GameScript, run the relay, register each player's agent with a token, bind tokens to companies, set goals, monitor and save. Use when the user says "host game night", "start the OpenTTD server", "set up OpenTTD for my friends and their agents", or asks how to add a player or give someone a token.
license: MIT
---

# Host an OpenTTD game night

You help the **host**: the machine that runs the OpenTTD server, the AgentBridge GameScript and the
openttd-agent **relay**. Players' agents reach the game only through the relay, each with its own
token bound to one company. Players who are not hosting use the `openttd-join-game` skill.

## Commands in this skill

Every example writes `openttd-agent ...`. Unless it is installed globally, run it as
`npx -y github:mmmnorthmark/openttd-agent#<tag> ...` with one release tag (for example `v0.8.0`) and
tell every player to use the **same tag**. All commands print JSON; `openttd-agent help` and
`openttd-agent <command> --help` show what exists. Unknown flags are refused.

**First step:** run `openttd-agent guide --role host` and follow its `next` step (v0.5.0 and later). It is
read-only, starts nothing and prints no secrets.

## 0. Is a game already running? Ask before replacing it

```sh
openttd-agent status
```

If `status` answers, a game is running on this machine. **Do not launch a new one, restart the
relay, or run `install-gamescript` + relaunch without the user's explicit OK**: it ends the game for
everyone. Ask whether to keep playing that game.

## 1. Check the machine

```sh
openttd-agent doctor
```

OpenTTD 15.x (players need the same version), Node 20+, graphics (OpenGFX, or the host's own original
TTD files in `Documents/OpenTTD/baseset`). Run OpenTTD once before the first launch.

## 2. Start the server

```sh
openttd-agent install-gamescript                      # again after every openttd-agent update
openttd-agent launch --mode dedicated --map_bits 9    # headless, binds 0.0.0.0: game 3979, admin 3977
```

- `launch` generates the admin password and keeps it in this machine's config. **It never leaves this
  machine.** Never paste it into chat, never send it to a player.
- Optional build limit for everyone: `--command_delay_ticks 2 --max_builds_per_day 50`.
- Resume a saved game: `launch --mode dedicated --load <name>`. Other flags: `launch --help`.

## 3. Start the relay

Run `openttd-agent relay` in its own terminal (or as a background process) and leave it running.
It listens on TCP 47978 and is the only client of the admin port.

## 4. Firewall and LAN IP

- Allow incoming **TCP 3979** (game) and **TCP 47978** (relay). macOS asks the first time; on
  Windows allow Node.js and OpenTTD on private networks; on Linux open them in ufw/firewalld.
- LAN IP: macOS `ipconfig getifaddr en0` (Wi-Fi; try `en1` if empty); Windows `ipconfig`
  (IPv4 Address); Linux `hostname -I`. `guide --role host` lists it too.

## 5. Players join and found companies

Every human, host included, opens OpenTTD → **Multiplayer** → **Add server** `<host-LAN-IP>:3979` →
join → **New company**.

## 6. Register each agent and bind it

```sh
openttd-agent relay-add-player --name <player> --company pending   # prints the token ONCE
openttd-agent companies                                            # company ids, once they founded one
openttd-agent relay-set-company --name <player> --company <id>
openttd-agent relay-list-players                                   # who is bound to what
```

Names: 1-32 of `A-Z a-z 0-9 _ . -`. Send each player **only**: the relay URL
`http://<host-LAN-IP>:47978`, their token (the printed `give_to_player` line), and the tag. Never the
admin password. Rebinding with `relay-set-company` applies at once; no relay restart.

## 7. Optional: a goal so there is a winner

Give **every** company the same targets:

```sh
openttd-agent cargos                                   # cargo labels in this game
openttd-agent goal-set --company <id> --deadline_year <year> --targets VALUE:500000
```

A game year is about 12 real minutes, so pick a deadline that fits the evening. Targets can mix
cargo and value, e.g. `COAL:3000,PASS:3000,VALUE:500000`. Players see it with `goal-status`.

## 8. During the game

- `openttd-agent companies`: money, value, deliveries for all companies.
- `openttd-agent relay-list-players`: bindings.
- `~/.openttd-agent/relay-audit.jsonl`: one JSON line per relay command or refusal (time, player,
  company, command, arguments, outcome).
- Host-only controls: `rate`, `pause` / `unpause`, `turn-advance --days N` (turn-based play),
  `goal-set` / `goal-clear`. Check `<command> --help` first.

## 9. End of the night

- `openttd-agent save --name <name>` (v0.5.0 and later), then next time
  `launch --mode dedicated --load <name>`. On older releases, save from the server console or a client.
- `openttd-agent relay-remove-player --name <player>` stops a token at once.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Players can't join | Same OpenTTD version? TCP 3979 open? They use the LAN IP, not 127.0.0.1? |
| Player: `cannot reach the relay` | Relay running? TCP 47978 open? Right IP in their URL? |
| Player: `missing or unknown token` | `relay-remove-player`, then `relay-add-player` and send the new line. |
| Player: `not bound to a company yet` | `companies`, then `relay-set-company`. |
| Player: `unknown command` | They run a different tag; everyone uses the host's tag. |
| AgentBridge did not answer / is older than vN | `install-gamescript`, then load the game again (ask first: it restarts the game). |

## Security

The relay speaks plain HTTP: tokens cross the LAN in clear text. Fine at home; not over the internet
or an untrusted network. The admin port shares the game port's bind addresses, so the generated
password is what protects it.
