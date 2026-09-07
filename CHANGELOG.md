# Changelog

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
