# Repository Identity 实施提案

**状态：方案已收敛，尚未实施**

本文是针对当前 package `0.4.0`、schema `2.1` 的实现提案。实现目标为 package `0.5.0`、schema `2.2`，面向一个用户、一台机器、始终安装最新版本。本文收敛 repository 描述与已选目标的行为，不改变 repository ID 的推导、memory placement 或现有 scope 语义。

## 目标与不变量

- 保留现有 `repository_id`、SHA-256 派生规则、Git common directory 共享规则、placement 和 scope 算法。
- 同一主 worktree 与 linked worktree 继续使用同一 repository ID；不得因目录名、remote 描述或路径观察改写 ID。
- repository ID 是 memory 寻址依据。名称、normalized remote 和 location 都是描述信息，不是身份匹配键。
- 名称与 remote 可以重复。不同 repository ID 不因名称或 remote 相同而自动合并。
- 一个 repository 可以有零个或多个可选 location 观察。路径只表示曾经观察到，不承诺当前存在或可访问。
- repository memory 在没有身份描述、历史提示或可访问路径时仍可 recall、list、remember、readback 和组织。
- identity 确定性、descriptor 是否可用、文件系统当前是否可访问是三个独立状态，不互相推导。

## 数据模型

只在当前操作已知 repository descriptor 时创建 identity 行，不创建空注册行。`name_source` 为 `remote`、`git_common_directory` 或 `directory`；`origin` 为 `local` 或 `client_reported`，由执行端确定。normalized remote 可以未知。

```text
repository_identities
  repository_id     TEXT PRIMARY KEY
  display_name      TEXT NOT NULL
  name_source       TEXT NOT NULL
  origin            TEXT NOT NULL
  normalized_remote TEXT NULL
  recorded_at       TEXT NOT NULL

repository_locations
  repository_id     TEXT NOT NULL
  canonical_path    TEXT NOT NULL
  observed_at       TEXT NOT NULL
  source            TEXT NOT NULL
  PRIMARY KEY (repository_id, canonical_path)
```

- `repository_id` 存放完整且现有格式不变的 ID，例如 `repository:<64-hex>`。
- `display_name`、`name_source`、`origin`、`recorded_at` 在 identity 行中非空。`normalized_remote` 仅在当前 descriptor 明确提供时写入。
- 首次记录的非空名称及来源保留。后续普通写入只填补缺失的可选描述，不覆盖已有名称，不更新 `recorded_at` 来伪装重新注册。
- location 以 repository ID 与 canonical path 去重，重复观察只更新该路径的 `observed_at` 和 `source`。location 可以缺失，也可以没有对应 identity 行。
- memory 表不增加 repository identity 外键。identity 缺失不影响 memory 行有效性或可访问性。
- location 不依赖 memory 外键，也不参与 repository ID 推导、查询匹配、权限判断或操作 fingerprint。

不引入 identity 状态枚举、空 identity、`historical_hint_only`、独立的 unavailable 记录或自动注册协议。调用方可直接以 `identity: null` 表达 descriptor 尚未记录。

## 目标冻结与权限

路径解析一次生成不可变的内部 target，并在权限检查之前完成。该对象在本次调用中贯穿 permission、核心操作、结果与 readback：

```text
target = {
  repository_id,
  canonical_path?,
  identity_source,
  placements,
  descriptor?,
  observed_at?
}
```

- `repository_id` 在流程内始终稳定。`identity_source` 说明本次 ID 解析方式；descriptor 和观察时间可以不存在。
- `canonical_path` 只表示本次解析得到的可选路径。已有显式选定 ID 不需要附带路径。
- `placements` 是本次明确选择且授权的 placement，不由 identity、location 或返回上下文扩展。
- Plugin 使用不会随 worktree 清理消失的执行目录；相对 database path 在切换执行目录前按原配置目录固定为绝对路径，避免访问另一数据库。
- 新的显式路径选择必须在解析时存在且有效；失败就拒绝这次选择。会话此前明确选定的 repository ID 不因对应路径后来缺失而失效。
- recall、list、remember 及写入后的 readback 都使用同一冻结 target 中的 ID，不在各阶段重新解析 cwd 或重选 scope。
- 需要读取源码时仍需本次有效路径及相应权限；只访问 memory 时只需已选择的 repository ID。

## CLI、Plugin 与 Skill

- CLI 增加 `--repository-id <ID>`，用于直接执行已选 repository scope。它与 `--repo <PATH>` 互斥；ID-only 是当前功能，不是旧请求兼容路径。
- scope 工具使用 `repository_ids` 作为精确 ID 选择器，与 `paths` 互斥。读取最多八个目标，写入最多一个目标。
- 所有 target 都须显式选择并逐项经过 host permission。工具不得自动枚举 repository、扩大 target 集合或因描述缺失回退到其他 scope。
- Plugin 在路径解析后保存 target ID，并在后续 recall、list、remember 和 readback 复用。保存路径仅供明确需要文件系统的操作，不用于恢复或切换身份。
- Plugin、CLI 和随包 runtime skill 在同一 `0.5.0` 发布中锁步更新。版本不匹配时严格拒绝新契约操作，不协商能力、不回退到旧请求形状。
- `scope resolve --json` 仅解析明确给出的路径或 ID，不打开数据库、不读 memory、不写 Git。它为权限检查提供冻结 target。
- 内部 `--targets-json` 传递这些已解析 target，与 `--repo`、`--repository-id` 互斥；模型工具不接受任意 descriptor。这是当前数据流，不保留旧客户端兼容分支。

## Descriptor 与事务

known descriptor 的 identity 新增或补缺必须与对应 memory 核心变更处于同一个 SQLite transaction。identity 写失败时，memory 写和 identity 写一并 rollback。

- 普通 remember 和 overwrite：当前 frozen target 带 descriptor 时，原子写入 memory 与 identity；没有 descriptor 时只写 memory，不创建空 identity。
- repository copy/move destination：只有当前已知 destination descriptor 时才在 destination 核心事务中记录 identity。source 与 destination ID、placement 仍按原规则处理。
- delete-only：删除目标记录，不因删除动作新建 identity 或 location。
- location observation 仅由明确的当前 target 提供，在核心事务提交后尽力记录；失败报告 warning，不回滚或重放已提交的 memory，不改变 ID、placement 或操作等价性。
- activity 仍是 best-effort 操作元数据。identity 不再走 activity hint 的事务后写入路径；核心写成功后不得为补写描述而重放 memory 操作。
- organization 不要求 filesystem descriptor。保留记录的组织变更沿用既有事务并保留已有 identity；删除 survivor 时不创建 identity。

若只有已选 repository ID 而没有 descriptor，remember、readback 等 ID-only 流程照常运行。它不会插入空 identity 行，也不通过 basename、旧 hint 或 memory 内容造出描述。

## 读取上下文

需要提供 repository 上下文的既有响应，在外层按完整 repository ID 做键。上下文只描述本次操作涉及的 ID，不用于寻址或扩大操作范围。

```json
{
  "repository_context": {
    "repository:<64-hex-id>": {
      "identity": null,
      "locations": []
    }
  }
}
```

- `identity` 为 `null`，或包含已持久化的 `display_name`、`name_source`、`origin`、`normalized_remote` 与 `recorded_at`。
- `locations` 是零项或多项已记录观察，包含路径、观察时间和来源；不代表路径仍存在。
- 找不到 identity 时照样返回结果并保持 memory 可用，不返回旧 hint 专属状态或错误。
- 加载上下文只查询数据库，不解析、探测、扫描或打开 location 指向的路径。
- Organization 的严格 snapshot、键和比较字段保持原样。上下文不能加入 snapshot 或改变其拒绝未知字段的规则。

## 旧 Metadata 与一次性补全

- 现有 repository metadata/hints 行保留原样，迁移中不删除、不重写、不提升为 identity，也不作为普通响应的 fallback 分支。
- schema migration 只保留旧行，不读取或转换它们。安装 `0.5.0` 且迁移成功后，再提出一次性历史补全计划；路径解析所得 ID 必须与原 scope 一致，不从描述反推归属。
- 遵循当前 `AGENTS.md` 的单用户、单机器、latest-only 规则。补全优先使用正常接口和用户提供或明确确认的路径；若接口不足，再提议一次性受控操作，不为此增加长期功能。实际修改须经具体清单确认。
- 不从 memory content、名称相似度、basename、历史 remote hint 或未经确认的旧路径推断 identity。
- 不增加自动文件系统扫描、持久 backfill command、backfill skill、兼容 adapter 或常驻清理脚本。普通运行流程不回访旧 metadata。

## Schema 与升级

目标 package 为 `0.5.0`，目标 schema 为 `2.2`。实现前同步更新 ADR-0001 的当前决策和 schema contract；历史章节可保留为历史记录，但新实现只执行以下支持路径。

- 新 database 直接创建为 schema `2.2`。
- 只支持精确 `2.1 -> 2.2` 的单一显式迁移，新增 identity 与 location 存储结构并更新 schema metadata。
- schema `2.0`、`1.0`、预版本、未知、损坏及未来版本均按当前拒绝策略处理，不串接 `2.0 -> 2.1 -> 2.2`。
- 不建立通用 migration registry、自动 minor 链或 legacy schema adapter。迁移只实现当前明确的 `2.1 -> 2.2`。
- 迁移在 `BEGIN IMMEDIATE` 事务内复检版本、建表、更新 schema metadata 并验证目标结构。失败整体 rollback，不 reset、不重建数据库。
- 保留所有 memory 内容与 ID、placements、organized 状态、domain 与 attachment、provenance、FTS、activity、operation ledger、原 metadata/hints 和其他既有数据。
- 只读 status、只读查询与 organization page/read 不升级 schema、不 enrichment、不扫描文件系统。需要升级时报告或拒绝，不在只读流程写数据。
- 可写的当前版本按常规数据库 preparation 执行唯一迁移；不承诺旧 binary 读取新 schema。

## Remote 与操作账本

- 更新现有 remote function 使用本次 repository context 与当前 target contract，并执行严格版本检查。CLI 与 server 版本不一致时在 mutation 前失败。
- 不新增 capability negotiation，不接受旧请求 fallback，不为历史 client 保留双协议处理。
- Remote server 只处理 repository ID、placement 和 descriptor 数据；client path 只能作为 observation 保存，server 永不打开或解析 client path。
- Organization 继续 local-only，不新增 remote organization。
- 保持 operation ledger、request fingerprint、replay 和 recovery 原样。repository 描述与 location 不进入 fingerprint；同一已提交请求 replay 不得额外补写或改写 identity/location。
- 本次改动不能改变 copy/move 的 exact placement、memory ID、provenance 或未知结果处理。

## 实施与发布顺序

1. 更新 ADR-0001 当前决策和 schema contract，固定 schema `2.2`、精确 `2.1 -> 2.2` 与只支持当前版本的契约。
2. 实现数据模型、事务写入、读取上下文和目标冻结；完成 Rust core、CLI、plugin、skill 与现有 remote function 的版本锁步更新。
3. 在 feature branch 完成相关测试、格式检查、lint、typecheck、build 和完整 CI 必需检查。PR 中确认 schema upgrade 与数据保留验收全部通过。
4. 所有 PR checks 通过后 squash merge 到 `main`；确认 `main` CI 成功后再创建 `v0.5.0` release tag。
5. 验证 tag 对应的 registry 发布 job、registry metadata、integrity 与 provenance 均成功。Trusted Publisher 只以该 GitHub Actions job 为验收证据。
6. 发布成功后在本机按 `0.5.0` 安装流程更新 CLI、plugin 与 runtime skill，由安装流程执行正常可写 preparation，并独立验证版本、schema 与数据保留。
7. 迁移成功后，制定独立的 agent-assisted 历史补全实施方案，列出证据、原 scope、目标 descriptor 和待确认项。本次交付不自动执行语义补全。

## 验收案例

- 旧 repository ID、hash、scope fixture、placement 及主/linked worktree 共用 identity 均与变更前一致。
- 同一名称或 normalized remote 可关联不同 ID；不同历史 ID 不合并，名称不作为唯一键。
- known descriptor 写入后 identity 与 memory 同事务提交；注入 identity SQL 失败时二者都 rollback。
- descriptor 缺失时 memory 写入和读取成功，identity 行数不因 ID-only 请求增长。
- 已有 identity 的名称与来源不会被后续普通写覆盖；缺失的 nullable remote 可被后续已知 remote 补齐。
- 删除唯一或最后一条 repository memory 不会创建 identity；不再有 memory 引用的 identity 也不使其他记忆失效。
- exact `2.1` database 升级到 `2.2` 且全部既有核心数据及 metadata/hints 原样保留；迁移失败后 schema 与数据不变。
- 新 database 直接为 `2.2`；`2.0`、`1.0`、损坏、未知及未来 schema 不被迁移或 reset。
- Read-only status 与 organization page/read 不迁移、不 enrichment、不扫描；schema 不匹配时不发生写操作。
- 缺失或删除所有 checkout 后，已选 repository ID 仍可 recall/list/remember/readback；memory 不因无路径或无 identity 而失效。
- 路径在 permission 前只解析一次，permission、写入和 readback 均指向同一冻结 ID；显式选择缺失新路径会失败，既有 ID 选择不会被其旧路径失效。
- 进程 cwd 改变不改变本次 target 或 database path；路径后来被其他 repository 复用也不导致 scope 切换。
- `repository_ids` 与 `paths` 互斥，读取上限八个、写入上限一个；没有显式请求时不枚举或扩展目标。
- `repository_context` 使用完整 ID 键、`identity: null` 和空 `locations` 时仍返回正常 memory 结果；上下文不出现在或改变 organization snapshot。
- Remote server 不尝试访问客户端路径；严格版本不匹配在 mutation 前失败；不存在协商或旧请求 fallback。
- 同一 operation ID replay 返回既有结果且不改身份描述、location、fingerprint 或账本；copy/move recovery 不需要重放来补描述。
- 0.5.0 PR checks、squash merge 后 main CI、tag registry provenance 验证、本机 CLI/plugin/skill 锁步更新顺序均有可核对结果。

## 不在范围

不新增 repository 管理 UI、重命名、合并、后台清理、存活探测、remote organization、自动目录发现或多用户/多机器兼容。本文只定义本次实现，不修改生产代码、数据库或 release 状态。
