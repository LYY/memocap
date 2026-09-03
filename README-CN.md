[English](README.md)

# memocap

忆时记忆系统 - 类人记忆检索/存储/遗忘/胶囊/可视化。让 AI 拥有会遗忘、会联想、会涌现、会封存的记忆。触发词：忆时、记忆、记住、回想、回忆、recall、remember、时间胶囊、记忆检索、可视化、记忆脑图、人物画像。

一份 SQLite。OpenCode 是唯一官方支持的集成。每轮先 recall；决策、偏好、任务、约定查过同类再 store。

## 安装

先安装全局 CLI，再注册 OpenCode 插件：

```sh
pnpm add -g @lyy-gh/memocap@0.0.1
opencode plugin @lyy-gh/memocap
```

OpenCode 是唯一官方支持的集成。全局 CLI 必须在 PATH 中，因为插件会把 `memocap` 作为 sidecar 调用。

插件命令会在全局 CLI 可用后注册 scoped package。

## 命令

remember [--force] / recall [--type] [--limit 3] / list / forget

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
    memocap remember "ship friday"

别的电脑用同一个 token，把 `MEMOCAP_ADDR` 设成 `http://服务器:8787`。

未设置 MEMOCAP_ADDR 时，CLI 只走本机，不使用网络。

## 对照

| 项目 | 怎么记 | 哪一端 |
| --- | --- | --- |
| ClawHub memocap | 值必存 + 言必检 | 只 OpenClaw |
| claude-mem | 自动抓会话 | Claude |
| agentmemory | 自动抓，多端 MCP | 多端 MCP |
| pi-memory | markdown | 只 Pi |
| 本仓库 | 值必存 + 言必检 | 仅 OpenCode，本机 SQLite 或带 token 的服务器 |
