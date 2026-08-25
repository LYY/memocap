[中文](README-CN.md)

# memocap

One SQLite. Four hosts, one `memocap`. Recall first every turn; store decisions / prefs / tasks / agreements after a similar-check.

## Install

pnpm add -g memocap

Codex: `memocap install` writes AGENTS.md.

Claude: `memocap install` writes CLAUDE.md and a skill.

Pi: `pi install npm:memocap`

OpenCode: `opencode plugin memocap`

## Commands

remember / recall / list / forget

## Usage

Local SQLite (default, no network):

    memocap remember "ship friday"
    memocap recall "friday"

Server (same store, token required):

    git clone https://github.com/luodaoyi/memocap
    cd memocap
    export MEMOCAP_TOKEN=replace-me
    docker compose up -d

Port 8787. Data stays in the Compose volume. Without a token the stack will not start.

    export MEMOCAP_ADDR=http://127.0.0.1:8787
    memocap remember "ship friday"

Other machines use the same token and set `MEMOCAP_ADDR` to `http://<server>:8787`.

If MEMOCAP_ADDR is unset, the CLI stays local and does not use the network.

## Compare

| Project | How it remembers | Hosts |
| --- | --- | --- |
| ClawHub memocap | value-store + recall-first | OpenClaw |
| claude-mem | auto-captures sessions | Claude |
| agentmemory | auto-captures via MCP | multi-host MCP |
| pi-memory | markdown files | Pi |
| this repo | value-store + recall-first | Codex / Claude / Pi / OpenCode, local SQLite or one-token server |
