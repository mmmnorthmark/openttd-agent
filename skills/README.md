# Agent skills for openttd-agent

Instructions any coding agent can follow for OpenTTD game night. Each skill is a folder with a
`SKILL.md` in the open [Agent Skills](https://agentskills.io) format (YAML frontmatter `name` and
`description`, then Markdown).

| Skill | Use it when |
|---|---|
| [`openttd-join-game`](openttd-join-game/SKILL.md) | You are a **player**: someone else hosts, you have (or need) a relay URL and token. |
| [`openttd-host-game`](openttd-host-game/SKILL.md) | You are the **host**: start the server and relay, hand out tokens, bind companies, set goals, save. |
| [`openttd-play`](openttd-play/SKILL.md) | You are connected and want a neutral turn loop: read state, dry-run, build, fix problems, loan, clone. |

The skills tell the agent to run `openttd-agent guide --role player|host` first when the release has
it, and to follow its `next` step.

## Which tag

Commands in the skills run `npx -y github:mmmnorthmark/openttd-agent#<tag>`. Use the **latest
release tag** (see [CHANGELOG.md](../CHANGELOG.md) and the repo's tags), and the **same tag on every
machine** in one game: the host picks it, players copy it.

## Install

**Claude Code, as a plugin** (this repo is also a plugin marketplace):

```text
/plugin marketplace add mmmnorthmark/openttd-agent
/plugin install openttd-agent@openttd-agent
```

Pin the skills to a release with `/plugin marketplace add mmmnorthmark/openttd-agent#<tag>`. The
skills then show as `/openttd-agent:openttd-join-game` and so on, and load on their own when you say
"join the OpenTTD game" or "host game night". The plugin holds only the skills; add the MCP server
yourself (`claude mcp add openttd -- npx -y github:mmmnorthmark/openttd-agent#<tag> mcp`) or let the
agent use the CLI.

**Claude Code, without the plugin:** copy a skill folder into `~/.claude/skills/` (all projects) or
`.claude/skills/` (one project), e.g. `skills/openttd-join-game` → `~/.claude/skills/openttd-join-game`.

**Other agents** (Codex, Cursor, Gemini CLI and others): if the agent supports Agent Skills, copy the
folder into its skills directory (see its docs). Otherwise paste the body of the `SKILL.md` into the
chat or the agent's rules file as a plain prompt. The bodies assume only a shell, Node 20+ and `npx`;
the Claude Code MCP line is labelled, and every MCP client gets the generic stdio command too.
