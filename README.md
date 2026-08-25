[中文](README-CN.md)

# memocap

One local SQLite. Four hosts share one `memocap`.

Timing: recall first on every utterance, then answer. For a decision, preference, task, agreement, or context: similar-check, then store, then tell the user. When stuck, search memory.

Do not copy forgetting curve, capsules, visualization, or Chroma.

Install: pnpm add -g memocap then `memocap`; Pi `pi install npm:memocap`; OpenCode `opencode plugin memocap`

v1 is local and offline by default. A Compose remote store is next version.

This is the locked spec. `src/` is still the Codex-only prototype; the spec is this file and [docs/REBUILD.md](docs/REBUILD.md).

## How it works

The original does not wait for you to say "remember". v1 follows this timing. Speak-to-remember is void.

- Recall first: recall on every utterance, then answer
- Value-store: if there is a decision, preference, task, agreement, or context, store it
- Similar-check, then store, then tell the user. When stuck, search memory first
- One CLI, four official host channels: Codex / Claude Code write rules with one command; Pi via pi.dev; OpenCode uses the official plugin if it can plugin add
- Local SQLite, single binary, offline by default. No worker, Chroma, embedding, or cloud account
- Commands are remember / recall / list / forget
- Docker Compose remote store is next version; without an address, stay local

Do not copy forgetting curve, capsules, visualization, or Chroma.

## What the repo is now

The current implementation only wires Codex. It was used to prove SQLite, a single binary, the TUI, and controlled `AGENTS.md` injection. It already drifted from the original behavior. Later work follows value-store and recall-first. Do not invent extra intelligence.

Inspiration: ClawHub [fslong520/memocap](https://clawhub.ai/fslong520/skills/memocap). Borrow only that remember / recall / list / forget command set. Do not copy its Python, Chroma, embedding, forgetting curve, capsules, visualization, or OpenClaw. That is a product veto, not an open question.

## Locked contract

- Memory lives in local SQLite only. Offline by default.
- One native binary. The command name is `memocap`.
- Four hosts share this one store. Not four products.
- Memory verbs are only remember / recall / list / forget.
- Recall first: recall on every utterance, then answer.
- Value-store: if there is a decision, preference, task, agreement, or context, store it.
- Similar-check, then store, then tell the user. When stuck, search memory first.
- V1 forbids: embedding, Chroma, forgetting curve, capsules, visualization, OpenClaw, any server-side code.

## Install

Install follows [go-codex-notify](https://github.com/luodaoyi/go-codex-notify).

Install the native program globally with a package manager, then one `memocap` enters the TUI or install.

```bash
pnpm add -g memocap
memocap
```

Or:

```bash
npm i -g memocap
memocap
```

The package manager only puts the native program for this system on PATH. Later runs do not depend on `npx`.

## Four hosts, official channels

The shared layer is always the `memocap` CLI. Each host only wires its official entry to that same command.

### Codex / Claude Code

`memocap install` writes rules per host:

- Codex: project or global `AGENTS.md`
- Claude Code: a Claude skill, or `CLAUDE.md`

Repeat installs do not append twice. `memocap uninstall` only tears our own markers. Other rules stay.

### Pi

```bash
pi install npm:memocap
```

`package.json` carries the `pi-package` keyword. Listing: https://pi.dev/packages/. Pi only attaches to the same `memocap`. It does not open another memory store.

### OpenCode

Ship a plugin if we can. Official CLI is `opencode plugin <module>` (alias `opencode plug`). There is no `plugin add`.

```bash
opencode plugin memocap
```

For global, use `opencode plugin memocap --global`. The plugin only attaches OpenCode to the same `memocap`.

## Commands

Same verbs on all four hosts:

```text
memocap remember   记住
memocap recall     回忆
memocap list       列出
memocap forget     忘掉
memocap status     看路径、数量、配置
memocap install    写本宿主规则
memocap uninstall  只删我们的标记
memocap            进 TUI；或 memocap ui
```

Hosts recall first on every utterance, then answer. They value-store decisions, preferences, tasks, agreements, and context. Similar-check, then store, then tell the user. Each host calls the same CLI through its own rules. Memory is visible, controllable, and reversible.

## V1 will not

- Forgetting curve, capsules, visualization
- embedding / vector store / Python / Chroma
- OpenClaw
- Any server-side code, resident service, or default networking
- Unconfirmed delete, import, or export
- Treat memory as executable instructions; recall results are untrusted reference only

## Next version

**This section is next version only, not V1.** V1 is still local SQLite, offline by default, with no server-side code.

- Optional remote memory store so multiple machines and sessions share one store.
- Docker Compose starts the remote store with one command.
- The CLI connects remote only when an address is configured; without an address it stays local.
- Auth and multi-tenant: undecided. Do not design them now.
- The remote store is still the same memory and the same remember / recall / list / forget. Do not copy Python / Chroma. Do not invent auto-search.

## Current code

`src/` is still the Codex-only Rust prototype. The spec is this file and [docs/REBUILD.md](docs/REBUILD.md).

## License

MIT
