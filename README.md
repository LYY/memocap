[中文](README-CN.md)

# memocap

YiShi (忆时) memory — human-like retrieval, storage, forgetting, capsules, and visualization. Gives AI memory that forgets, associates, emerges, and can be sealed. Triggers: 忆时, 记忆, 记住, 回想, 回忆, recall, remember, 时间胶囊, 记忆检索, 可视化, 记忆脑图, 人物画像.

One SQLite. OpenCode is the only officially supported integration. Recall first every turn; store decisions / prefs / tasks / agreements after a similar-check.

## Install

Install the global CLI first, then register the OpenCode plugin:

```sh
pnpm add -g @lyy-gh/memocap@0.0.4
opencode plugin @lyy-gh/memocap
```

OpenCode is the only officially supported integration. The global CLI must be on PATH because the plugin invokes `memocap` as its sidecar.

The plugin command registers the scoped package after the global CLI is available.

## Commands

- `memocap remember [--type <TYPE>] [--tags <TAGS>] [--force] [--id <ID>] [--global] [--topic <TOPIC>] <CONTENT>`
- `memocap recall [--limit <LIMIT>] [--type <TYPE>] [--max-chars <MAX_CHARS>] [--global] <QUERY>`
- `memocap list [--global] [--limit <LIMIT>]`
- `memocap forget [--global] <ID>`
- `memocap scope show`
- `memocap scope migrate --from <FROM> (--id <ID> | --all) [--dry-run | --yes]`
- `memocap install [--global]` and `memocap uninstall [--global]` (unsupported legacy compatibility commands)
- `memocap status [--global]`
- `memocap serve [--bind <BIND>]`
- `memocap ui`

Run `memocap --help` or a subcommand with `--help` for the current full help text.

## Scopes

Local memory uses one SQLite database. Without `--global`, `remember`, `recall`,
`list`, and `forget` use the current repository scope. In a repository, recall includes the current repository scope and the global scope. List also shows both
scopes, while `--global` restricts the command to global memory.

```sh
memocap scope show
memocap remember --global --type preference "Use UTC timestamps"
memocap recall --global "timestamps"
memocap remember --topic "release-process" "Tag releases from the final commit"
```

`scope show` prints an opaque current scope ID such as
`scope:v1:<64 lowercase hex characters>`. A Git repository normally gets its
scope from its stable supported remote identity. If that identity is unavailable
or ambiguous, the Git common directory is used. Outside Git, the scope uses the
canonical non-Git directory path.

A repository memory with the same non-empty topic hides the global memory with
that topic during recall. `--topic` creates this explicit replacement
relationship. It does not filter ordinary topic searches, and it does not copy or
delete the global memory.

### Local migration

Migration changes the source scope to the current repository scope. It is
local-only, explicit, and never automatic. The source can be `global` or an old
opaque scope ID captured from `scope show`. Select exactly one of `--id` and
`--all`. For `--all`, select exactly one of `--dry-run` and `--yes`.

```sh
memocap scope migrate --from global --id 42 --dry-run
memocap scope migrate --from global --all --dry-run
memocap scope migrate --from global --all --yes
```

For a moved non-Git directory, run `scope show` before the move, run it again
after the move, then migrate from the old scope ID. A move can change the
canonical directory identity. The CLI does not automatically migrate or classify
those memories. Scope migration is unavailable when `MEMOCAP_ADDR` selects a
remote target.

## Usage

Local SQLite (default, no network):

    memocap remember "ship friday"
    memocap recall "friday"

Server (same store, token required):

    git clone https://github.com/LYY/memocap
    cd memocap
    export MEMOCAP_TOKEN=replace-me
    docker compose up -d

Port 8787. Data stays in the Compose volume. Without a token the stack will not start.

    export MEMOCAP_ADDR=http://127.0.0.1:8787
    export MEMOCAP_TOKEN=replace-me
    memocap remember "ship friday"

Other machines use the same token and set `MEMOCAP_ADDR` to `http://server:8787`.

If `MEMOCAP_ADDR` is unset, the CLI stays local and does not use the network. If
an address is set, both address and token are required, including
`MEMOCAP_TOKEN`. The CLI does not fall back to local when the token is missing.
Remote remember, recall, list, and forget
requests carry a valid remote scope ID. Use `--global` for the literal global scope;
otherwise the current repository scope is sent. Remote scope IDs are validated
strictly by the server.

## Compare

| Project | How it remembers | Hosts |
| --- | --- | --- |
| ClawHub memocap | value-store + recall-first | OpenClaw |
| claude-mem | auto-captures sessions | Claude |
| agentmemory | auto-captures via MCP | multi-host MCP |
| pi-memory | markdown files | Pi |
| this repo | value-store + recall-first | OpenCode, local SQLite or one-token server |
