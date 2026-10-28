# Changelog

## @lyy-gh/memocap 0.3.0 (2026-10-26)

Implemented outcomes for package target `0.3.0` and Git tag target `v0.3.0`.
Publication and registry provenance verification are separate release gates;
this entry does not claim either has completed.

- OpenCode setup now uses the exact npm package worker to copy its complete
  bundled skill and references into one versioned, full-digest managed directory.
  The plugin and `skills.paths` select the same absolute path; the default setup
  no longer requires a separate Skills CLI or GitHub skill fetch.
- Installation guidance documents config-root resolution, inherited owner reuse,
  fail-closed handling for ambiguous or shared legacy skills, format-1 manifest
  migration, static versus runtime verification, and conservative uninstall.
- Standalone `npx skills` remains an optional, separately sourced and updated path
  for other agents, not a second step in the OpenCode installation.

## @lyy-gh/memocap 0.2.1 (2026-10-24)

- Fix setup uninstall removing owned OpenCode plugin entries from JSONC,
  including string and tuple entries with optional trailing commas. Preserve
  comments, whitespace, unrelated plugin entries and options, and memory databases.
- Parse configuration strictly before edits and validate edited JSONC before
  writing, so malformed input is rejected without changing the file.

## @lyy-gh/memocap 0.2.0 (2026-10-24)

Implemented outcomes for package target `0.2.0` and Git tag target `v0.2.0`.
Publication and registry provenance verification are separate release gates;
this entry does not claim either has completed.

- Core memories, activity events, and repository hints now share one main
  SQLite database at schema `2.0`. The exact registered `1.0` schema bridges
  atomically without rebuilding core tables or changing memory IDs and
  placements. Pre-versioned, malformed, unknown, or unsupported schemas refuse
  without reset.
- Compatible higher `2.n` schemas preserve supported unknown tables, columns,
  indexes, and triggers within the documented bounded compatibility rules.
- `status --read-only` reports a missing database as `not_initialized`, schema
  `1.0` as `upgrade_needed`, and compatible `2.n` with its actual version.
  Ordinary memory `list` uses a read-write open and can initialize or bridge;
  `activity list/show` remain read-only and do not prepare the main database.
- Local `activity prepare` creates the main schema or bridges exact `1.0`, then
  prepares retained activity and may prune it. Authorized setup install/update
  prepares a missing or legacy local database and verifies it by readback;
  check, doctor, and dry-run do not prepare. Doctor is ready only at
  `static_ready`, while runtime remains `not_run` until verified in a new
  OpenCode session.
- Existing `.activity.sqlite` files are left untouched and their history is
  not imported. Any personal discard is a separate authorized choice after old
  writers are quiescent. Activity failures remain warnings after a successful
  core write; never replay that write to fill history.
- The v0.1.0 and v0.0.10 binaries cannot open schema `2.0`. Back up with
  SQLite's backup API or another WAL-aware method before bridging; a software
  downgrade is not data restoration, and an older backup must not overwrite
  newer data. During higher-target preflight, v0.1.0 reports `upgrade_needed`
  for schema `1.0`; local v0.0.10 inspection is `inspection_deferred`, not a
  success or readiness result.

## @lyy-gh/memocap 0.1.0 (2026-10-23)

Implemented outcomes for package target `0.1.0` and Git tag target `v0.1.0`.
Publication and registry provenance verification are separate release gates;
this entry does not claim either has completed.

- Explicit `--repo` targets, up to eight repositories for recall, and
  `--match all|any` make selection and query matching visible. Recall preserves
  per-repository topic shadowing and applies one shared result/character budget.
- `--json` receipts report operation identity, targets, query terms, matched and
  returned IDs, limits, errors, and activity outcome. Full inventory is explicit
  through `scope list --all` and paged `list --placement`.
- Retained operation metadata lives in a separate `.activity.sqlite` store.
  Activity is bounded operational history with possible gaps, not a full audit
  log. Auxiliary failure never changes a successful core write into a failure
  or authorizes replaying it.
- OpenCode uses its package's absolute bundled launcher and checks the native
  version. Current-request recall receipts, explicit scope switching, memory
  tools, and `/memory` commands expose what ran and what was prepared for model
  input; they do not prove model understanding or adoption.
- `memocap-setup install/check/update/doctor/uninstall` manages explicitly
  selected integrations, preserves unrelated configuration and memory data,
  freezes the resolved update target, and uses a version-checked exact-target
  worker when needed. It distinguishes static readiness from runtime
  verification. Skills use the matching release tree and pinned Skills 1.7.4.
- Core schema remains `1.0`, including its existing complete fingerprint.
  Existing compatible core data is retained and remains usable by v0.0.10;
  auxiliary activity is independent. A software downgrade is not a database
  restore. See [installation](docs/INSTALL.md) and
  [schema lifecycle](docs/SCHEMA-VERSIONING.md) before operating older stores.

## 0.0.10 (2026-09-27)

Patch release making memory guidance language-aware while admitting only durable memory before least-sharing placement.

- Memory guidance now uses the user's known working language for primary memory
  content, adds concise cross-language aliases only for core concepts likely to
  be recalled across languages, and does not mechanically translate every term.
- Long-term memory now stores stable repository conventions, enduring preferences,
  or continuing decisions only when their rationale is not already available from
  a durable, authoritative, cheaply queryable source.
- Temporary state belongs to the relevant source system, including Git history,
  PRs, issues, CI, deployments, calendars, tickets, documents, dashboards, and
  generated artifacts.

## 0.0.9 (2026-09-23)

Patch release aligning the packaged OpenCode plugin and skill, plus the Rust-embedded guidance, with retrieval-oriented memory write rules.

## 0.0.8 (2026-09-23)

Patch release for the release-boundary documentation correction.

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

## Pre-independent project history

The entries below predate the independent `@lyy-gh/memocap` release line that
began at `0.0.1`. Their historical version numbers and host claims describe
that earlier project context. In particular, the 2026-08-25 `0.1.0` entry is
not the current `@lyy-gh/memocap` `0.1.0` release target above.

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
