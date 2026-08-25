[中文](README-CN.md)

# memocap

One local SQLite. Four hosts, one `memocap`. Recall first every turn; store decisions / prefs / tasks / agreements after a similar-check.

## Install

```bash
pnpm add -g memocap
memocap
```

Pi: `pi install npm:memocap`

OpenCode: `opencode plugin memocap`

## Commands

`remember` / `recall` / `list` / `forget`

## Compare

| Project | How it remembers | Hosts |
| --- | --- | --- |
| ClawHub memocap | value-store + recall-first | OpenClaw |
| claude-mem | auto-captures sessions | Claude |
| agentmemory | auto-captures via MCP | multi-host MCP |
| pi-memory | markdown files | Pi |
| this repo | value-store + recall-first | Codex / Claude / Pi / OpenCode, local SQLite |

Compose remote store is next version.
