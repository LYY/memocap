# Changelog

## 0.0.7 (2026-09-22)

This release establishes a race-safe release authority.

- A tag-only release accepts a tag commit in `origin/main` history only when a
  successful `CI` push run on `main` for the exact tag SHA exists.
- Workflow identity is bound to the workflow carried by the tag. Validation does
  not require the tag to equal the current `origin/main` tip, so later main
  commits cannot invalidate an already tested tag.
- Validation and binary-build jobs are read-only.
- The sole constrained `release` job holds `contents: write` and creates or uploads
  verified GitHub Release assets.
- The `registry` job uses npm trusted-publisher OIDC to publish the package and
  verify registry integrity and provenance.

## 0.0.6 (2026-09-22)

This release changes the memory contract to domain-aware placements and a
visible stack. It is a breaking release for scripts and operators.

- `--global`, `memocap install`, `memocap uninstall`, old scope syntax, legacy host adapters, legacy TUI actions, and unversioned HTTP routes are removed, not deprecated.
- The current repository, attached domains, and universal memory are distinct
  placements. Domain registration and repository attachment are separate
  lifecycle operations. Reads use repository, attached domains in persisted
  order, then universal memory.
- Topic shadowing is explicit and ordered. Repository records shadow lower
  tiers, domains shadow universal records, and domains do not shadow one
  another. List and TUI retain addressable shadowed records with provenance.
- `scope copy` and `scope move --yes` use exact placements, immutable first-transfer provenance, and an operation ledger. Reusing an operation ID with a
  changed request conflicts without mutation.
- Remote mode uses authenticated `/v1` routes only. One shared bearer token gates the server; it is not ACL, IAM, per-user authorization, or tenant isolation. A configured remote address never silently falls back to local.
- Response-loss recovery uses the issued strict handle with `operation status --recovery`. `not_found` alone does not prove manual replay is safe; an operation outcome may remain unknown.
- TUI now exposes only Status, List visible memories, and Exit.

The database schema remains `1.0`, independent of package release identity. An
exact recognized pre-versioned database may be reset transactionally without
confirmation. That reset deletes all old memory rows, creates schema `1.0`,
makes no backup, and prints the required notice. Unknown or incompatible
schemas refuse without mutation. See [SCHEMA-VERSIONING.md](docs/SCHEMA-VERSIONING.md).

## 0.0.5 (2026-09-20)

Memory scope guidance now requires a manual pre-store classification by usefulness rather than source.

Schema lifecycle now has an explicit data loss warning: only an exact
recognized pre-versioned database may be reset automatically, transactionally,
without confirmation and with no backup. Unknown, future, malformed, and different
major schemas refuse without mutation.

- Repository-specific decisions, working context, and consumer-specific dependency usage remain local; stored memory names the relevant dependency or path.
- `--global` is explicit and limited to stable, repository-agnostic knowledge useful across unrelated repositories, such as Go debugging methods; another repository is not sufficient by itself.

## 0.0.3 (2026-09-07)

范围文档与当前 CLI 行为对齐，明确本机仓库 scope、global scope、topic shadow 和严格远程 scope。

- 默认 `remember`、`recall`、`list`、`forget` 使用当前仓库 scope；仓库中的 `recall` 和 `list` 可见当前仓库与 global memory，`--global` 显式限制为 global scope。
- `--topic` 只建立显式替换关系：仓库中相同的非空 topic 会在 recall 时遮蔽 global memory，不会自动复制或删除。
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
