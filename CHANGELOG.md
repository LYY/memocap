# Changelog

## 0.0.4 (2026-09-08)

Scope hotfix：强化 native-path scope isolation 与 transactional scope migration，同时保持已发布的 `v0.0.3` 不变。

- Unix scope identity 直接哈希原生路径字节；有效 UTF-8 路径保持既有 identity，非 UTF-8 路径不再因有损转换发生碰撞。
- 非 dry-run migration 在读取 source scope 前启动 immediate transaction，使选择、计数和更新共享同一事务边界；单条迁移返回实际更新数。
- 回归测试覆盖非 UTF-8 路径隔离、事务获取顺序、竞争写入以及失败时完整回滚。

## 0.0.3 (2026-09-07)

范围文档与当前 CLI 行为对齐，明确本机仓库 scope、global scope、topic shadow、迁移和严格远程 scope。

- 默认 `remember`、`recall`、`list`、`forget` 使用当前仓库 scope；仓库中的 `recall` 和 `list` 可见当前仓库与 global memory，`--global` 显式限制为 global scope。
- `--topic` 只建立显式替换关系：仓库中相同的非空 topic 会在 recall 时遮蔽 global memory，不会自动复制或删除。
- `scope show` 展示当前不透明 scope ID；`scope migrate` 仅限本地，必须显式选择一个 ID 或全部记录，并用 dry-run 或 yes 确认全部迁移。不会自动分类或迁移，非 Git 目录移动也遵循此规则。
- 设置 `MEMOCAP_ADDR` 后必须同时设置 `MEMOCAP_TOKEN`，不会回退到本地；远程请求携带并严格校验 scope ID。
- 验证证据：文档 contract tests 与临时 Git 仓库 CLI transcript 均通过。

## 0.0.2 (2026-09-04)

发布恢复候选：保留 `v0.0.1` 的既有 tag、Release 和 npm 包，不重发、不覆盖。

- release workflow 仅接受最终合入 `origin/main` 且携带当前 hardened workflow 的 tag commit，使用同一仓库和 tag 的非取消并发组串行 reconcile，确保 provenance 只来自 tag 触发的成功发布；恢复只能 rerun 同一 current-tag workflow，不能为历史 SHA 打 tag。
- launcher 为冷缓存下载使用每进程唯一临时文件和独占缓存锁，校验 SHA-256 后原子发布并保留可执行权限。

## 0.0.1 (2026-09-02)

独立发布 `@lyy-gh/memocap`，发布源为 [LYY/memocap](https://github.com/LYY/memocap)。OpenCode 是唯一官方支持的集成。

- 通过 Git tag 发布，并保留 tag、源码仓库和构建 artifact 的 release provenance。
- 发布包由 LYY/memocap GitHub Release 提供，OpenCode 插件通过全局 `memocap` CLI 工作。

## 0.1.3 — 2026-09-02

记住前先查重，召回默认少灌一点。

- `remember` 先用 FTS 查同类，撞到就不写；`--force` 才插入，`--id` 覆盖已有行。HTTP `POST /remember` 同样规则，冲突返回 409。
- `recall` 默认 3 条（原先 5），可 `--type` 按 kind 过滤、`--max-chars` 限制总字数；排序在 FTS 之后按新近。
- README 补了忆时记忆系统说明。

## 0.1.2 — 2026-08-25

Docker 镜像升到 rust 1.88；Compose 部署写进 README。Release Action 发三平台二进制和 npm。

## 0.1.1 — 2026-08-25

npm bin 改为 `bin/cli.cjs`，从 GitHub Release 拉二进制。Trusted Publisher 走 Action 发版。

## 0.1.0 — 2026-08-25

第一版。一份 SQLite，四端共用 `remember` / `recall` / `list` / `forget`。不设地址只走本机；设了 ADDR 和 token 走 HTTP / Compose 8787。
