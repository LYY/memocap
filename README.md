# memocap

给 OpenAI Codex 用的**本地优先记忆工具**。单个 Rust 二进制，数据保存在本机 SQLite；不需要 Python、ChromaDB、模型下载或云端 API。

它借鉴了 `go-codex-notify` 的使用方式：运行后进入 TUI，选择项目级或全局安装，自动将一段受控指令写入 `AGENTS.md`，让 Codex 在你**明确说“记住、回忆、查找本地记忆”**时调用本地 CLI。

## 安全边界

- 不自动保存聊天内容。
- 不自动检索或主动提起旧记忆。
- 不联网；记忆只存在本机 SQLite 文件。
- `AGENTS.md` 只写入 `<!-- memocap:begin -->` 到 `<!-- memocap:end -->` 之间的区块。
- 重复安装不会重复注入；卸载只移除 memocap 自己的区块，不碰原有项目规则。
- 删除记忆、导出或其它破坏性操作应只在用户明确要求时执行。

## 安装与配置

从 [Releases](https://github.com/luodaoyi/memocap/releases) 下载与你系统一致的 `memocap` 二进制后运行：

```powershell
# Windows PowerShell
.\memocap.exe
```

```bash
# macOS / Linux
chmod +x ./memocap
./memocap
```

TUI 中可选：

- **为当前项目配置 AGENTS.md**：把规则加到当前目录的 `AGENTS.md`。推荐。
- **为全部 Codex 项目配置 ~/.codex/AGENTS.md**：全局启用。
- **移除当前项目的 memocap 配置**：只删除本工具的受控区块。
- **查看本地状态**：查看数据库路径和记忆数量。

也可以不用 TUI：

```bash
# 当前项目
memocap install

# 全局 Codex 配置
memocap install --global

# 查看状态
memocap status
memocap status --global

# 删除本工具写入的规则
memocap uninstall
memocap uninstall --global
```

安装后重开 Codex 会话，`AGENTS.md` 即会生效。

## Codex 如何调用

写入的规则只允许 Codex 在你明确要求时调用 `memocap`。例如：

```text
记住：这个项目使用 pnpm；不要在本机跑完整构建，验证交给 GitHub Actions。
```

```text
查一下本地记忆中这个项目关于 CI 和构建的约定。
```

Codex 会执行类似命令：

```bash
memocap remember \
  --type preference \
  --tags "pnpm,ci" \
  "这个项目使用 pnpm；不要在本机跑完整构建，验证交给 GitHub Actions。"

memocap recall "CI 构建" --limit 5
```

## CLI

```bash
# 保存显式记忆
memocap remember --type preference --tags "codex,ci" "内容"

# SQLite FTS5 全文检索
memocap recall "关键词" --limit 5

# 查看最新记忆
memocap list --limit 20

# 删除一条记忆（先确认 ID）
memocap forget 12
```

默认数据路径：

- Windows：`%USERPROFILE%\.memocap\memocap.db`
- macOS / Linux：`~/.memocap/memocap.db`

可通过环境变量覆盖：

```bash
MEMOCAP_HOME=/custom/home
MEMOCAP_DATA_DIR=/custom/data
CODEX_HOME=/custom/codex-home
```

## 开发

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

CI 会在 Linux、macOS 和 Windows 上运行格式检查、Clippy 与测试。

## 与原版 memocap 的区别

原版 ClawHub `memocap` 使用 Python、ChromaDB、中文 embedding 模型，且包含自动检索、自动存储、归档、导入导出和可视化等行为。

这个项目只保留 Codex 本地使用最需要的部分：**显式存储、显式检索、可撤销的 `AGENTS.md` 集成**。

## License

MIT
