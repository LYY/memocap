[English](README.md)

# memocap

忆时记忆系统 - 类人记忆检索/存储/遗忘/胶囊/可视化。让 AI 拥有会遗忘、会联想、会涌现、会封存的记忆。触发词：忆时、记忆、记住、回想、回忆、recall、remember、时间胶囊、记忆检索、可视化、记忆脑图、人物画像。

一份 SQLite。OpenCode 是唯一官方支持的集成。每轮先 recall；决策、偏好、任务、约定查过同类再 store。

## 安装

先安装全局 CLI，再注册 OpenCode 插件：

```sh
pnpm add -g @lyy-gh/memocap@0.0.4
opencode plugin @lyy-gh/memocap
```

OpenCode 是唯一官方支持的集成。全局 CLI 必须在 PATH 中，因为插件会把 `memocap` 作为 sidecar 调用。

插件命令会在全局 CLI 可用后注册 scoped package。

## 命令

- `memocap remember [--type <TYPE>] [--tags <TAGS>] [--force] [--id <ID>] [--global] [--topic <TOPIC>] <CONTENT>`
- `memocap recall [--limit <LIMIT>] [--type <TYPE>] [--max-chars <MAX_CHARS>] [--global] <QUERY>`
- `memocap list [--global] [--limit <LIMIT>]`
- `memocap forget [--global] <ID>`
- `memocap scope show`
- `memocap scope migrate --from <FROM> (--id <ID> | --all) [--dry-run | --yes]`
- `memocap install [--global]` 和 `memocap uninstall [--global]`（不支持的旧兼容命令）
- `memocap status [--global]`
- `memocap serve [--bind <BIND>]`
- `memocap ui`

运行 `memocap --help`，或给子命令加 `--help`，查看当前完整帮助。

## Scope

本机记忆共用一份 SQLite。未使用 `--global` 时，`remember`、`recall`、
`list`、`forget` 使用当前仓库 scope。在仓库中，recall 会同时检索当前仓库 scope 和 global scope。list 也会显示两个 scope；使用 `--global` 时只操作
global memory。

```sh
memocap scope show
memocap remember --global --type preference "Use UTC timestamps"
memocap recall --global "timestamps"
memocap remember --topic "release-process" "Tag releases from the final commit"
```

`scope show` 会打印不透明的当前 scope ID，例如
`scope:v1:<64 个小写十六进制字符>`。Git 仓库通常根据稳定且受支持的 remote
identity 获得 scope。remote 不可用或有歧义时，使用 Git common directory。
Git 之外使用规范化的非 Git 目录路径作为 scope identity。

仓库 memory 使用相同的非空 topic 时，会在 recall 时遮蔽 global memory 中相同的非空 topic。`--topic` 用来建立这个显式替换关系，不会过滤普通 topic
搜索，也不会复制或删除 global memory。

### 本地迁移

迁移会把 source scope 改为当前仓库 scope。迁移仅限本地，必须显式执行，
不会自动迁移或自动分类。source 可以是 `global`，也可以是从 `scope show`
记录的旧不透明 scope ID。`--id` 和 `--all` 只能选择一个。使用 `--all` 时，
`--dry-run` 和 `--yes` 只能选择一个。

```sh
memocap scope migrate --from global --id 42 --dry-run
memocap scope migrate --from global --all --dry-run
memocap scope migrate --from global --all --yes
```

非 Git 目录移动前运行 `scope show`，移动后再次运行，然后从旧 scope ID
迁移。移动可能改变规范化的非 Git 目录 identity。CLI 不会自动分类或迁移
这些 memory。设置 `MEMOCAP_ADDR` 使用远程 target 时，scope migrate 不可用。

## 用法

本机 SQLite（默认，不联网）：

    memocap remember "ship friday"
    memocap recall "friday"

服务器（同一份库，需要 token）：

    git clone https://github.com/LYY/memocap
    cd memocap
    export MEMOCAP_TOKEN=replace-me
    docker compose up -d

端口 8787。数据在 Compose volume 里。不设 token 起不来。

    export MEMOCAP_ADDR=http://127.0.0.1:8787
    export MEMOCAP_TOKEN=replace-me
    memocap remember "ship friday"

别的电脑用同一个 token，把 `MEMOCAP_ADDR` 设成 `http://服务器:8787`。

未设置 `MEMOCAP_ADDR` 时，CLI 只走本机，不使用网络。设置地址后，地址和 token
必须同时存在，包括 `MEMOCAP_TOKEN`，不会回退到本地。远程 remember、recall、list、forget
请求都会携带有效 scope ID。使用 `--global` 时发送字面量 global scope；
否则发送当前仓库 scope。服务器会严格校验远程 scope ID。

## 对照

| 项目 | 怎么记 | 哪一端 |
| --- | --- | --- |
| ClawHub memocap | 值必存 + 言必检 | 只 OpenClaw |
| claude-mem | 自动抓会话 | Claude |
| agentmemory | 自动抓，多端 MCP | 多端 MCP |
| pi-memory | markdown | 只 Pi |
| 本仓库 | 值必存 + 言必检 | 仅 OpenCode，本机 SQLite 或带 token 的服务器 |
