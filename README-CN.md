[English](README.md)

# memocap

一份本机 SQLite。四个宿主，一条 `memocap`。每轮先 recall；决策、偏好、任务、约定查过同类再 store。

## 安装

```bash
pnpm add -g memocap
memocap
```

Pi：`pi install npm:memocap`

OpenCode：`opencode plugin memocap`

## 命令

`remember` / `recall` / `list` / `forget`

## 对照

| 项目 | 怎么记 | 哪一端 |
| --- | --- | --- |
| ClawHub memocap | 值必存 + 言必检 | 只 OpenClaw |
| claude-mem | 自动抓会话 | Claude |
| agentmemory | 自动抓，多端 MCP | 多端 MCP |
| pi-memory | markdown | 只 Pi |
| 本仓库 | 值必存 + 言必检 | 四端官方渠道，本机 SQLite |

Compose 远程库下一版才做。
