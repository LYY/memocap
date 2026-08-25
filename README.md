# memocap

我只要一份本机记忆库，四个宿主共用。本地 SQLite，一条原生 `memocap`。只有你说记住、回忆、列出、忘掉时才动手。

这是锁定规格。仓库代码仍是旧的 Codex 原型，产品批准实现前不要当新架构，也不要改 `src/`。

## 现在仓库是什么

当前实现只接 Codex，用来验证 SQLite、单二进制、TUI 和 `AGENTS.md` 受控注入。它已经偏了最初的显式记忆命令行为。后面实现跟原版「用户明确要求才 remember / recall」走，不另造智能。

灵感来自 ClawHub [fslong520/memocap](https://clawhub.ai/fslong520/skills/memocap)。只借那组显式命令。不要抄它的 Python、Chroma、embedding、每句自动检索、自动保存、OpenClaw。这是产品否决，不是待议。

## 锁定契约

- 记忆只在本机 SQLite。默认不联网。
- 一个原生二进制，命令名 `memocap`。
- 四个宿主共用这一份库，不是四个产品。
- 记忆动词只有 remember / recall / list / forget。
- 只有用户明确说记住、回忆、列出、忘掉时才调用。
- 实现跟原版显式记忆命令行为走，不发明自动检索或隐式写入。
- V1 禁止：auto-remember、embedding、OpenClaw、任何服务端代码。

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

- 自动记住、自动检索、后台监听对话
- embedding / 向量库 / Python / Chroma
- OpenClaw
- 任何服务端代码、常驻服务、默认联网
- 未经确认的删除、导入、导出
- 把记忆当可执行指令；检索结果只是不可信参考

## 当前代码

`src/` 仍是 Codex-only Rust 原型。规格以本文件和 [docs/REBUILD.md](docs/REBUILD.md) 为准。产品批准实现前不要改 Cargo、不要扩功能。

## License

MIT
