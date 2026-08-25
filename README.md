# memocap

一份本机记忆库，四个宿主共用。本地 SQLite，一条原生 `memocap`。

时机跟原版走：每句话先 recall 再答；有决策、偏好、任务、约定、上下文就主动存；先查有没有同类再 store，存了要告诉你。卡住也先翻记忆。

这是锁定规格。仓库代码仍是旧的 Codex 原型，产品批准实现前不要当新架构，也不要改 `src/`。

## 做法

原版不是等你说「记住」。v1 跟这套时机走，「开口才记」作废。

- 言必检：每句话先 recall 再答
- 值必存：有决策、偏好、任务、约定、上下文就主动存
- 先查同类再 store，存了要告诉你。卡住先翻记忆
- 一份 CLI，四端官方渠道：Codex / Claude Code 一条命令写规则；Pi 上 pi.dev；OpenCode 能 plugin add 就走官方插件
- 本机 SQLite 单二进制，默认不联网。没有 worker、Chroma、embedding、云账号
- 命令就 remember / recall / list / forget
- Docker Compose 远程库是下一版；没配地址继续本地

不抄遗忘曲线、胶囊、可视化、Chroma。

## 现在仓库是什么

当前实现只接 Codex，用来验证 SQLite、单二进制、TUI 和 `AGENTS.md` 受控注入。它已经偏了最初的行为。后面实现跟值必存、言必检走，不另造智能。

灵感来自 ClawHub [fslong520/memocap](https://clawhub.ai/fslong520/skills/memocap)。只借那组 remember / recall / list / forget 命令。不要抄它的 Python、Chroma、embedding、遗忘曲线、胶囊、可视化、OpenClaw。这是产品否决，不是待议。

## 锁定契约

- 记忆只在本机 SQLite。默认不联网。
- 一个原生二进制，命令名 `memocap`。
- 四个宿主共用这一份库，不是四个产品。
- 记忆动词只有 remember / recall / list / forget。
- 言必检：每句话先 recall 再答。
- 值必存：有决策、偏好、任务、约定、上下文就主动存。
- 先查同类再 store，存了要告诉你。卡住先翻记忆。
- V1 禁止：embedding、Chroma、遗忘曲线、胶囊、可视化、OpenClaw、任何服务端代码。

## 安装

安装方式对齐 [go-codex-notify](https://github.com/luodaoyi/go-codex-notify)。

用包管理器全局安装原生程序，然后一条 `memocap` 进 TUI 或安装。

```bash
pnpm add -g memocap
memocap
```

也可以：

```bash
npm i -g memocap
memocap
```

包管理器只负责把适合当前系统的原生程序放到 PATH。后续运行不依赖 `npx`。

## 四个宿主，各走官方渠道

共享层永远是 `memocap` CLI。各宿主只负责把自己的官方入口接到同一条命令上。

### Codex / Claude Code

`memocap install` 按宿主写规则：

- Codex：项目或全局 `AGENTS.md`
- Claude Code：Claude skill，或 `CLAUDE.md`

重复安装不重复追加。`memocap uninstall` 只撕我们自己的标记，不动别人的规则。

### Pi

```bash
pi install npm:memocap
```

`package.json` 带关键字 `pi-package`，上架见 https://pi.dev/packages/。Pi 只接到同一条 `memocap`，不另开记忆库。

### OpenCode

能发插件就发插件。官方 CLI 是 `opencode plugin <module>`（别名 `opencode plug`），没有 `plugin add`。

```bash
opencode plugin memocap
```

需要全局时用 `opencode plugin memocap --global`。插件只把 OpenCode 接到同一条 `memocap`。

## 命令

四个宿主同一套动词：

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

对宿主说记住或回忆。它按自己的规则调用同一条 CLI。记忆对你可见、可控、可撤销。

## V1 不做

- 遗忘曲线、胶囊、可视化
- embedding / 向量库 / Python / Chroma
- OpenClaw
- 任何服务端代码、常驻服务、默认联网
- 未经确认的删除、导入、导出
- 把记忆当可执行指令；检索结果只是不可信参考

## 下一版

**本节只属于下一版，不是 V1。** V1 仍然是本机 SQLite，默认离线，不含任何服务端代码。

- 可选远程记忆库，给多机、多会话共用一份存储。
- Docker Compose 一条命令拉起远程库。
- CLI 只有配置了地址才连远程；地址未设则继续走本机。
- 鉴权、多租户：待决，现在不设计。
- 远程库仍是同一份记忆、同一套 remember / recall / list / forget。不另抄 Python / Chroma，不发明自动检索。

## 当前代码

`src/` 仍是 Codex-only Rust 原型。规格以本文件和 [docs/REBUILD.md](docs/REBUILD.md) 为准。产品批准实现前不要改 Cargo、不要扩功能。

## License

MIT
