# ADR-0001：单数据库与兼容演进

**状态：** Accepted；当前兼容范围于 2026-11-11 更新，历次决策保留为历史记录
**原始日期：** 2026-10-24
**最近更新：** 2026-11-11
**决策者：** 用户
**当前目标：** package 0.6.0 / schema 2.3；发布状态见 release workflow

## 当前决策（2026-11-11）

作出本决策时的已安装版本为 package `0.5.0` / schema `2.2`。目标为 package
`0.6.0` / schema `2.3`。本节取代此前兼容范围，不保留通用 minor 兼容、旧二进制互操作或串接历史迁移的承诺。

- 新数据库直接使用 schema `2.3`。唯一支持的升级为精确 schema `2.2` 到 `2.3`；schema `2.1`、`2.0`、`1.0`、预版本、未来和不兼容结构均拒绝，不 reset、不重新播种数据、不串接旧迁移。
- `activity_events.phase` 的现有封闭 CHECK 不接受 `capture_review`。在 `BEGIN IMMEDIATE` 锁内复检版本与必需结构后，仅以新表、显式复制全部列、删除旧表、重命名新表和重建 `activity_retention` 的方式扩展该 CHECK，再更新 metadata、最终校验并原子提交。任何步骤失败都 rollback。迁移本身不 prune；重复或并发打开复检已提交版本，不重复迁移。
- 复制须原样保留所有 activity 的 sequence、operation/phase 唯一性、`event_json` 字节和 recorded/started 时间，不反序列化或改写旧事件。全部 memory 内容、ID、placement、kind、tags、topic、时间、organized 状态、domain/attachment、repository identity/location/metadata、provenance、ledger、FTS、扩展字段、扩展行与无关 schema 对象保持不变。
- 实际 `2.2` DDL 是显式校验与 fixture。若 activity 表有未知列、额外索引或 trigger，其他对象引用该表，存在迁移临时名称冲突，或 schema metadata 上有可能执行未知写入的 trigger，则在 DDL 前拒绝，不能通过丢弃未知结构来完成升级。不引入通用 migration framework 或未来兼容路径。
- 只读检查对精确 `2.2` 报告 `upgrade_needed`，对 `2.3` 报告 `ready`；不初始化、DDL、prune、补全语义或写 activity。organization 与 activity 的只读接口不代为升级。显式 activity preparation 完成 schema 事务后仍可按既有规则执行 retention。
- `capture_review` 是 `read` 类保留元数据，采用既有 30 天 / 10,000 条上限。typed metadata 仅含 `status`、有界 ASCII `reason`、正数且不重复的 `memory_ids`（最多 100）、`model_calls`（0..3）、`tool_calls`（非负 u64）和 `write_attempts`（0..1）。`saved` 必须一次 write attempt 且有 ID；`skipped` 必须无 ID；其余结果可携带已知已提交 ID。拒绝 body、secret、source 和其他未知字段。记录失败明确报告，不重放 memory 写入。
- 不承诺旧二进制打开 `2.3`；旧客户端 shim、capability negotiation 和旧请求 fallback 不在本次范围内。package、schema、setup manifest 和 receipt 格式仍是独立标识。安装 preflight 和最终版本就绪证据由安装契约定义，不能把旧 `0.5.0` 的 `ready`/`2.2` 当作新目标就绪。
- `0.5.0` 中已确立的 repository identity、location、scope、权限、organization 本地边界与独立确认的语义补全规则继续有效；本次不改变这些数据或语义。以下 2026-10-29 与原始 ADR 内容仅保留决策历史。

## 前次决策（2026-10-29，历史）

用户当前只需管理自己的单一 SQLite 数据库。此前关于通用同主版本 minor 兼容、schema `1.0` 桥接和旧 baseline 二进制互操作的承诺已被本节取代。

- 新数据库直接使用 schema `2.2`。唯一支持的升级是精确 schema `2.1` 到 `2.2`，在 `BEGIN IMMEDIATE` 中复检版本、新增 `repository_identities` 和 `repository_locations`、更新 metadata 并验证后原子提交；失败整体 rollback。现有记忆内容、ID、placement、type、tags、topic、时间、organized 状态、domain 与 attachment、provenance、extensions、FTS、activity、operation ledger 和原 repository metadata/hints 均须保留。
- schema `2.0`、`1.0`、预版本、损坏、不兼容和未来版本均明确拒绝，不串接旧迁移、不 reset 或自动重建。只读检查不升级、不 enrichment、不扫描文件系统；具体支持范围以 [当前 schema contract](../SCHEMA-VERSIONING.md) 为准。
- repository ID 的派生与 scope 语义保持不变。identity 是可选描述，location 是可选历史观察；没有描述或可访问路径的 ID 仍能访问其记忆。普通运行不读取旧 hint 作为 fallback，不从名称、remote 或路径推断、合并或扩大目标。已选 ID 贯穿权限、操作和 readback，显式选取逐项经过 host permission。
- known descriptor 与对应 memory 核心变更同事务写入；location 在核心提交后尽力记录，失败报告 warning，不重放 memory。描述不参与 operation fingerprint、replay 或 organization snapshot。
- 不作旧二进制打开 schema `2.2` 的互操作承诺。CLI、plugin、runtime skill 与 server 使用当前 `0.5.0` 契约，版本不匹配严格拒绝，无旧请求 fallback 或新增 capability negotiation。package `0.5.0`、schema `2.2`、setup manifest format `2` 和 receipt format `1` 是彼此独立的标识。
- 安装前允许实际已装 0.4.0 CLI 对 schema `2.1` 报告 `ready`；升级到 0.5.0 后只读检查报告 `upgrade_needed`/`2.1`，安装成功必须独立读回当前 CLI 的 `ready`/`2.2`。这只是立即前版安装过渡，不是通用旧版本兼容。
- 语义补全仅在发布并本机安装 0.5.0 后提出一次性计划。优先正常接口与明确确认的路径；接口不足时再提议有具体清单的一次性受控操作。不增加长期 backfill command/skill、自动文件系统扫描或迁移框架，不自动提升旧 hints。
- 记忆整理只支持本地数据库。配置了 remote target 时拒绝该功能，不回退到本地或新增网络协议；这不改变已有远程操作。
- 本次决策保留原 ADR 对原子迁移、保留 core 数据、拒绝不确定结构和不以 reset 修复的原则。下文原始决策中的其他兼容承诺是历史背景，不是当前支持合同。

## 原始背景（2026-10-24）

当前已发布 CLI 为 0.1.0，core schema 为 1.0；原始 0.0.10 使用相同的 core 形状。
package 版本、core schema 版本和 receipt 格式是彼此独立的标识。
0.0.10 与 0.1.0 都按完整 schema fingerprint 严格校验，并拒绝更高 minor。
因此，新版本若仅以新增表或列演进，同一数据库仍无法被这些旧二进制读取。

当前 activity 位于独立的 `<core filename>.activity.sqlite` 辅助库。
本决策需要说明未来 core schema 如何兼容演进，以及辅助库如何退出，
但本 ADR 不实施迁移、删除数据、撤回发布或改变任何已发布版本行为。

## 原始决策内容（历史）

### 数据库边界

目标架构使用一个 `memocap.db`，同时保存 memory、activity 和 repository metadata。
数据库文件是逻辑存储边界；SQLite WAL/SHM 文件仍由 SQLite 按需协调。
不再以独立 activity 数据库作为未来默认存储边界。

### 同一主版本内的 schema 演进

同一 schema major 的 minor 升级采用显式注册、可兼容的增量 SQL 演进。
新增表、非唯一索引，以及满足既有 SQL、trigger、约束和枚举语义的 nullable 或带默认值列，
可作为兼容演进；仅仅是 SQL 能执行，不足以证明兼容。
SQL 读取、插入和更新使用显式列清单，更新和移动不得以全行替换抹掉未知字段。
新增字段必须在旧 baseline 的省略写入、复制默认值及删除关联语义下仍然合法；
若旧 copy 或 delete 无法维护新功能要求的数据关系，该变化不能作为兼容 minor。
显式删除可以删除目标记忆，不代表可以清理不认识的 schema 对象或其他记忆的数据。
新程序校验自己依赖的必需结构，而不是要求整个数据库与单一完整 fingerprint 完全相同。
未知、损坏或无法确认安全的旧结构必须明确拒绝，不能通过 reset 清库来“修复”。

### 写入升级与只读检查

可写的新版本使用 `BEGIN IMMEDIATE`，并在锁内重新读取 schema 状态。
只有锁内状态仍需要升级时，才执行已注册且兼容的 DDL，并与 schema metadata 一起原子提交。
失败时整体 rollback；成功后的重复打开应保持幂等。
并发升级必须有明确结果：后取得锁的写者重新检查已提交状态，不重复应用迁移；
等待超时或 SQLite busy 错误按定义失败，不继续使用未确认升级的结构。

`status --read-only` 和 doctor 检查不执行初始化、DDL、prune 或 activity 写入。
只读检查可以报告 `upgrade_needed`，但不得代替可写升级。
SQLite WAL/SHM 协调不改变这里的逻辑只读承诺。

### 旧二进制与 breaking change

兼容性承诺从 package 0.2.0 的新 baseline 及之后经过测试的二进制开始，
不追溯承诺 0.0.10 或 0.1.0 能理解未来 schema。
新 baseline 二进制打开同一 major 的更高 minor 时，只依赖自己认识的结构，
保留未知结构和数据，不降级 schema，也不假装支持需新结构的功能。
实际 schema 版本号和升级映射须在实现时确定，不能仅凭 package 0.2.0 推算。

主版本升级用于明确 breaking change，例如重命名或删除结构、改变既有含义、
拒绝旧版本本可写入的有效数据，或引入旧消费者无法安全处理的新行枚举值。
这类升级必须显式迁移或拒绝，不能冒充同主版本内的兼容扩展。

### Activity 与数据保留

memory 写入成功后，即使 activity 记录失败，core 写入仍保持成功并报告 warning；
不得重放 core 写入，也不得声称两者总能原子成功。
既有 activity 历史的通用迁移策略尚待用户需求决定；
用户已明确允许丢弃其个人 activity 历史，但这不构成对其他用户的通用丢弃规则。

无论迁移方案如何，以下 core 内容与语义必须保留：memory 内容与 ID、placements、
tags、topics、时间、FTS、domains、attachments、provenance 和 operation ledger。
不为未证实需求设计通用导入器。0.2.0 的具体过渡步骤仍由优先级讨论决定。

个人旧辅助库的清理只能发生在确认没有旧 writer 或 plugin 后，且 0.2.0 不会再创建它之后。
清理范围必须是明确的辅助库路径及其 WAL/SHM sidecars，并确认由本次操作持有且已静止；
不得删除 core，也不得以旧快照回滚。用户可以另行选择更早暂停 activity，
那是独立的选择，不是本 ADR 授权的默认步骤。

### 发布边界

package 0.2.0 是未来目标，尚未发布。是否发布、是否撤回或弃用旧版，
都是独立的运营决策；本 ADR 不表示它们已经完成，也不要求现在删除任何用户数据。

## 考虑过的替代方案（原始决策）

1. **继续严格 fingerprint，并拒绝每个更高 minor。** 行为简单，但新增兼容结构仍会阻断旧 baseline，
   无法达成同一数据库跨 minor 演进的目标。
2. **要求用户手动导出、重建或 reset。** 可避开兼容性实现，但增加迁移负担和数据丢失风险，
   不符合保留 core memory 与身份、placement、provenance 的要求。
3. **保留双库作为长期架构。** 可隔离辅助历史，但维护两套生命周期与协调边界，
   也无法消除 core schema 对严格 fingerprint 的限制。选择单库并不等于承诺 activity 绝不丢失。

## 后果与风险（原始决策）

- 同主版本更高 minor 的旧 baseline 可继续执行已知功能，但不能获得新功能语义。
- 兼容性需要针对真实 SQL、trigger、约束、枚举和未知结构验证，不能只测试 DDL 成功。
- 单库扩大故障与锁竞争的共同边界；memory 与 activity 共享文件生命周期，需保持 activity 可选且不可重放 core 写入。
- 回滚到 0.0.10 或 0.1.0 不受本 ADR 保证；它们仍可能因更高 minor 拒绝打开数据库。
- 本决策先确立演进规则，不替代尚未确定的 0.2.0 迁移步骤或 activity 历史处置选择。

## 验收依据（原始决策）

实现同主版本兼容演进后，至少验证以下场景：

1. 以真实 0.0.10 schema fixture 升级，保留原有 memory；用 0.2.0 baseline 与后续 minor 二进制交替执行真实 CRUD。
2. 覆盖 copy、move、domain 操作、FTS、provenance、delete，验证复制默认值与删除关联语义；旧 baseline 写入后，未被明确删除的记忆保留未知字段，未知 schema 对象保持不变。
3. 注入 DDL 失败并确认完整 rollback；模拟竞争升级者，确认锁内复检且不重复升级。
4. 验证只读检查遇到未来兼容 minor 时不执行 DDL、初始化、prune 或 activity 写入，并能报告升级需要。
5. 验证未知、损坏以及更高 major 的数据明确拒绝且不 reset；验证新功能不会被旧 baseline 假称支持。

## 原始决策时的行为说明

原始决策时的目标是 package `0.2.0` 和 schema `2.0`；当前 contract 见
[schema versioning 文档](../SCHEMA-VERSIONING.md)。已发布 v0.1.0 的历史行为见
[v0.1.0 schema contract](https://github.com/LYY/memocap/blob/v0.1.0/docs/SCHEMA-VERSIONING.md)。
这些记录不表示 package 0.2.0 已发布，也不表示用户数据库已升级或个人辅助库已弃用或删除。
