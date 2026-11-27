---
name: openttd-play
description: Run an OpenTTD company turn by turn with the openttd-agent CLI or MCP tools - read the state, find routes, dry-run, build, fix vehicle problems, manage the loan and add trains to busy routes. Use when the agent is already connected to a game (status shows a company) and the user says "play OpenTTD", "run my company", "take a turn" or "build something profitable".
license: MIT
---

# Play an OpenTTD company with openttd-agent

A neutral play loop for a company you are already connected to. Not connected yet? Use
`openttd-join-game` (player) or `openttd-host-game` (host) first.

Commands are written as CLI calls (`openttd-agent <command> --flag value`); MCP clients call the same
tool with underscores (`goal_status`, `build_cargo_route`) and the flags as arguments. Check flags with
`openttd-agent <command> --help`. Leave `--company` out: it defaults to your company.

## Each turn

1. **Read the state** (cheap, read-only):
   - `goal-status`: targets, progress, `days_left`.
   - `status` and `companies`: date, your money and loan, how the others are doing
     (`companies --history 4` for trends; `rating` shows which rating components are low).
   - `summary`: one line per vehicle and station (worst first).
   - `events --since <latest_seq from last turn>`: what happened.
2. **Fix before you build:** `vehicle-problems`. Handle every `severity: action` row first using its
   `suggested_fix`; `verify-route --vehicle <id>` names where the track breaks. Leave `info` rows on
   a running train alone. `deadlock` / `stalled_on_line`: `vehicle-reverse --vehicles <one id>`.
3. **Find one opportunity:** `find-cargo-pairs --cargo <name> --limit 5` (see `cargos` for names;
   passengers and mail pair towns, feed both names to `--from_town` / `--to_town`). `industries` and
   `town-gaps` give more options.
4. **Dry-run, then build:**
   `build-cargo-route --from_industry <id> --to_industry <id> --cargo <name> --dry_run true`.
   Check `estimated_cost` against your money and every step's `ok`. Then run it without `--dry_run`.
   On failure read `failed_step` and the error, change one thing, try once more; the identical
   command will fail the same way.
5. **Money:** `loan` shows loan and `max_loan`; `loan --borrow <amount>` (or `--max true`) funds a
   good route, `loan --repay <amount>` when cash piles up. Interest costs money: borrow for a plan.
6. **Grow busy routes:** `stations --min_waiting 100` shows cargo piling up. Add a train with
   `vehicle-clone --vehicle <id> --depot auto --start true` (it picks a depot on that train's own
   line). A clone in another line's depot gets lost. A single-track line needs a passing loop before a
   second train: `loop-sites --vehicle <id>` ranks dry-run sites and prints the `build-passing-loop`
   command. Old or weak vehicles: `vehicle-replace --vehicles <ids>` (the old one is sold when it
   reaches the depot).
7. **Write notes** outside the game: ids you built, the plan, what failed. Long games outlast context.
   On the map itself, `sign --x --y --text` marks a planned plot for free.

## Rules

- Real time unless the host runs turns: a game day is about 2 s. Prefer composite commands
  (`build-cargo-route`, `find-cargo-pairs`, `station-sites`, `build-line-depot`) over many small calls.
- Always `--dry_run true` before a build that costs money.
- Never touch what the human partner built unless they agreed. Check `vehicles` and `stations`
  before changing anything.
- `demolish` and `vehicle-sell` are permanent: ask first.
