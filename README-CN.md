[English](README.md)

# memocap

memocap 是 OpenCode 的 local-first SQLite 记忆 sidecar。它把显式记忆保存
到 repository、已挂载 domain 或 universal placement，再从获授权的个人记忆库中
进行 recall。选定的 repository 提供任务上下文和默认写入来源，不限制人库读取范围。

OpenCode 是唯一官方支持的集成。插件通过包内绝对路径的 CLI launcher 调用 sidecar，
并校验 native 版本，不从全局 PATH 选择其他 `memocap`。数据库生命周期以[Schema versioning contract](docs/SCHEMA-VERSIONING.md)
为准。部署和远程操作见[DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 安装

为当前用户安装 v0.6.0 CLI、OpenCode 插件和运行时 skill：

```sh
npx --yes --package @lyy-gh/memocap@0.6.0 memocap-setup install --global --yes --json
```

需要 Node.js 22.20 或更高版本、npm/npx，以及 OpenCode 1.19.3 或 1.19.5。
插件 SDK 固定为 1.19.3。npm 包包含完整 skill 和 references。安装器将它复制到所选 OpenCode 配置根下，并让插件与
`skills.paths` 指向同一个受管理目录。默认流程不使用 Git 或 `skills` CLI；npm
registry 或 npx 下载 runner 时仍可能需要网络。安装器不会安装或升级 OpenCode。
项目安装、可选的独立 skill、检查更新、恢复和数据处理见[安装指南](docs/INSTALL.md)。
Agent 进行已获授权的非交互安装或更新时，按[Agent 指南](docs/INSTALL-AGENT.md)操作。

## 命令矩阵

下面是当前 CLI surface。placement selector 互斥。`<PLACEMENT>` 是
`repository:<64 lowercase hex>`、`domain:<DOMAIN>` 或 `universal`。

全局 `--repo <PATH>` 显式选择真实仓库路径；recall 和 `scope resolve` 可重复指定，最多八个目标。
也可使用与 `--repo` 互斥的 `--repository-id <ID>` 直接选择明确的 repository ID。
写操作始终只有一个目标。全局 `--json` 返回 format-1 receipt，供自动化使用；
`serve` 和 `ui` 不支持它。package `0.6.0`、core schema `2.3`、receipt format
`1` 是彼此独立的标识。

```text
memocap remember [--type <TYPE>] [--tags <TAGS>] [--force] [--id <ID>] [--domain <DOMAIN> | --universal] [--topic <TOPIC>] <CONTENT>
memocap recall [--match all|any] [--limit <LIMIT>] [--type <TYPE>] [--max-chars <MAX_CHARS>] [--library | --placement <PLACEMENT>...] [--domain <DOMAIN> | --universal] <QUERY>
memocap read <ID> --placement <PLACEMENT>
memocap list [--limit <LIMIT>] [--offset <OFFSET>] [--placement <PLACEMENT> | --domain <DOMAIN> | --universal]
memocap forget [--domain <DOMAIN> | --universal] <ID>
memocap scope show
memocap scope resolve --json
memocap scope list --all
memocap scope domain create <DOMAIN>
memocap scope domain attach <DOMAIN> [--before <DOMAIN>]
memocap scope domain detach <DOMAIN>
memocap scope domain list [--all]
memocap scope domain delete <DOMAIN>
memocap scope copy --id <ID> --from <PLACEMENT> --to <PLACEMENT> [--operation-id <OPERATION_ID>] [--note <NOTE>]
memocap scope move --id <ID> --from <PLACEMENT> --to <PLACEMENT> --yes [--operation-id <OPERATION_ID>] [--note <NOTE>]
memocap operation status --recovery <RECOVERY>
memocap status [--read-only]
memocap activity list [--writes] [--limit <LIMIT>] [--offset <OFFSET>] [--repository <ID>] [--session <ID>] [--operation <ID>]
memocap activity show <OPERATION_ID>
memocap activity prepare
memocap serve [--bind <BIND>]
memocap ui
memocap-setup <install|check|update|doctor|uninstall> [--global | --project <PATH>] [--to <VERSION>] [--dry-run] [--yes] [--json]
```

`scope domain create` 注册可复用 domain ID。`attach` 把已注册 domain 挂载到
当前仓库，`--before` 调整它在 stack 中的位置。`detach` 只移除当前仓库的
绑定。`list` 显示当前仓库的 attachments，`list --all` 显示 registry，
`delete` 删除未使用的 registry entry。

不带 selector 时，`remember` 写入当前仓库 scope。`--domain` 要求 domain 已挂载，
`--universal` 选择 universal memory。`recall` 默认搜索整个个人记忆库；`--library`
显式写出这一范围。重复使用 `--placement` 时只搜索列出的精确来源，`--domain` 或
`--universal` 则选择一个精确来源。这些 filter 互斥，绝不会被静默扩大。repository
目标提供上下文和默认写入来源，不构成人库读取边界。不同的是，不带 selector 的
`list` 使用当前 visible stack。`forget` 总是针对一个精确 placement，默认是当前仓库。

安装使用独立的 `memocap-setup`，其 `--global` 选择集成安装范围，不选择 universal
memory。旧 `memocap install/uninstall`、旧 scope 语法、其他 host adapter、TUI
写入和删除操作、无版本 HTTP route 仍已移除。

## 召回、全文读取和权限

原生 `memocap recall` 默认搜索整个个人记忆库，包括 repository、domain 和
universal placement。本地模式搜索本机数据库，remote mode 搜索所配置服务器上的记忆库。
`--repo` 和 `--repository-id` 选择 repository 上下文和默认写入来源，不会缩小默认读取范围。
可以用 `--library` 明确写出全库范围，也可重复
使用 `--placement` 限定到精确来源。`--domain` 和 `--universal` 是精确的单来源
filter，不能互相组合，也不能与其他 recall filter 组合。显式 filter 不会被静默
替换成更宽的搜索。

OpenCode 插件同样默认搜索整个已授权记忆库。安装器为 library 读取添加以下精确的
持久授权：

```json
{
  "permission": {
    "memocap_recall": { "library": "allow" },
    "memocap_read": { "library": "allow" }
  }
}
```

每次插件操作仍会检查当前 agent 和 parent session 的有效宿主权限。有效 deny
会阻止访问；ask 使用 OpenCode 原生权限提示，拒绝 ask 也会阻止访问。持久授权不会
覆盖冲突的有效权限。直接运行本地 CLI 时，文件访问遵循当前操作系统账户的权限；
远程 CLI 另受共享 bearer token gate 控制。Placement 和 repository ID 用于选择上下文
或数据来源，不是授权规则。获准读取记忆不代表获准打开它引用的源码文件。

使用 `memocap read <ID> --placement <PLACEMENT>` 或插件的 `memocap_read` tool，
按精确 ID 和来源读取完整的当前正文。插件 recall 最多注入 3 条 reference，总预算为
6,000 个字符。每条都会标记为 `full` 或 `partial`，并保留完整来源的 hash 和精确的
`memocap_read` 读取路线。把 `partial` 当作操作依据前，先读取全文；如果 hash 已变化，
应以当前正文为准并说明变化。原生 CLI 的 `--max-chars` 只保留按相关性排序的完整记录前缀；
下一条正文（包括第一条）超出预算时，该条及后续正文都会省略。

较长的插件查询会为精确路径、版本和名称保留位置，不会只保留前面的常见词。CJK recall
使用当前记忆正文中的有界重叠词面片段。这是词面检索，不是语义排序；本构建不包含语义排序。

## Receipt、库存和 activity

原生 recall 默认 `--match all`；`any` 匹配至少一个规范化查询词。插件 recall 使用
`any`。系统先在获准的搜索范围内统一排序，再应用结果条数和正文大小预算，不按 placement
顺序优先返回。不同来源的相同 topic 不会自动替换或隐藏另一条记录。来源本身不能证明
记忆适用于当前环境；适用性未知时应保留这种不确定性，并在行动前核对当前权威信息。
执行前还应检查引用的当前源码或文档；来源指针不授予文件访问权限。
Receipt 展示 targets、discovery、searched placements、query terms、matched/returned
IDs、完整性、截断、错误和 activity 状态。本次请求已有有效插件 receipt（包括空结果或
有效缓存）时，不必重复相同 recall。

库存与默认 recall 是不同功能。`memocap list`、TUI List 和 `status` 中的 visible-source
计数仍保留当前 visible stack 的标签及 topic 可见性。需要完整 placement
库存时使用 `scope list --all`，再用
`list --placement <PLACEMENT> --limit 20 --offset 0` 分页查看精确 placement。
`status --read-only --json` 检查 core 和 activity 兼容性，不产生逻辑写入：不写入
数据或 schema、不初始化或迁移主数据库、不裁剪历史，也不记录 activity。普通记忆命令
（例如 `memocap list`）使用 read-write open，可能初始化缺失数据库，或将精确支持的
schema `2.2` 升级到 `2.3`。`activity list/show` 使用 read-only 访问，不会准备数据库。SQLite
`READ_ONLY` 连接仍可能协调 WAL/SHM sidecar；普通 WAL 检查不需要 owner snapshot。
`activity prepare` 显式准备本地主数据库，创建 schema `2.3` 或升级精确支持的 `2.2`；
准备过程可能裁剪保留的 activity。远程准备由服务器管理员负责。完整边界见
[schema versioning contract](docs/SCHEMA-VERSIONING.md)。

Activity 和 repository hint 在主 SQLite 数据库中保存有限运维元数据，不是完整审计。
Recall/injection 最长保留 30 天、最多 10,000 条；write 元数据最多 1,000 条。
过期、裁剪或记录失败可能留下缺口。Core 写入成功后 activity 失败仍是写入成功，
应报告 warning，不能重放写入来修复历史。旧 `<core filename>.activity.sqlite` 文件不会被
自动打开、导入、改写或删除，其中的历史不会出现在新查询中。静止旧 writer 后的个人丢弃
必须是另行授权的选择。

插件提供 `memocap_recall`、`memocap_read`、`memocap_remember`、`memocap_scope` 和
`memocap_organize` tools。
`/memory status`、`/memory recall`、`/memory scope <PATH...>`、`/memory scopes`、
`/memory list`、`/memory recent`、`/memory why` 可查看会话目标和 recall receipt。
准备进入模型输入不证明模型理解或采用。权限及显式切换目标规则见
[runtime skill](skills/memocap/SKILL.md)。

## 自动捕获

一次正常完成的用户请求后，插件最多执行一次有界 review，并可保存一条简洁、有证据的
记忆。不必每轮都说“记住”，也不要求每轮都写入。候选可包括长期偏好、决策，以及从任务到
所用 tool 或 service/environment，再到 repository 入口的简洁路线。即使详细文档已经存在，这类路线仍可能有用；
应保存适用条件和来源指针，而不是复制 runbook。秘密、临时状态、没有依据的 assistant
结论和未经验证的结果不适合作为候选。

Review 最多使用两个隔离 child session、三次 generation dispatch 和一次原生写入尝试。
这个流程有意保持有界和保守，因此可能跳过有用信息；它不会验证所有自然语言事实，也不
承诺捕获所有内容或提供质量分数。重复或含糊的 idle 事件可能触发 fail-closed，跳过本来
有效的捕获。写入前若观察到新的真实输入、busy/retry 或 error、会话删除、worker error/abort
或超时，旧 review 会失效。写入开始后，必须等待真实工具 callback 和独立读回完成；单有取消
信号不能证明写入已停止。宿主权限拒绝是终态，不会通过 CLI 或 shell 绕过。写入结果未知时先读，不重放。
`/memory status` 和 `/memory why` 展示捕获状态、原因、调用与尝试次数及相关 ID，不展示
候选正文。自动捕获不会设置 topic、强制写入、覆盖现有 ID 或合并记录。当前准入规则和精确
限制见[捕获实现说明](docs/OPENCODE-CAPTURE-IMPLEMENTATION.md)。

## 记忆整理

运行 `/memory organize` 可检查已保存的记忆。默认扫描所有 placement 中尚未整理的
记录，包括被 shadow 的记录。`/memory organize --all` 或 `/memory organize -a` 还会检查
此前整理过的记录。`/memory help` 展示命令形式，不会打开数据库。
使用 `/memory organize --help` 或 `/memory organize -h` 查看完整说明。待整理扫描为空时，
提示“没有未整理记忆”，并建议使用 `-a`；不会自动启动第二次扫描。

记忆整理只支持本地数据库。配置了 remote mode 时，该请求会被拒绝，不会回退到本地，
也不会新增远程整理能力；现有远程操作不变。完整候选集会先分页扫描完，再报告扫描完成。
预览会列出精确 ID、placement、原文、建议动作、新内容、理由、证据和适用范围。用户确认
具体变更组并通过权限感知整理工具授权后，才会写入。每组单独提交，并在提交后读回验证。
发现冲突时必须重新评估；结果不确定时先读取，不会为验证而重放写入。

确认的 keep、refine 和同 placement merge 只会在事务成功后标记幸存记录已整理；delete
会删除记录。被拒绝、失败、有冲突或等待证据的记录保持不变。新记忆和 copy 创建的记录
均为未整理状态；move 和普通编辑保留原整理状态。`--all` 只扩大检查范围，不触发自动分类。
完整流程和判断规则见按需加载的[记忆整理指南](skills/memocap/references/memory-organization.md)。

## Scope 和 visible stack

`scope show` 输出 active scope、repository ID、解析来源，以及按持久化顺序
排列的 attached domains：

```text
memocap scope show
```

存在受支持的 Git remote 时，repository identity 保持稳定。remote 不明确或
不支持时使用 Git common directory。Git 外使用规范化的非 Git 目录路径。输出
的 repository ID 是 opaque 标识，不是用户选择的 ACL 或 tenant 名称。

Schema `2.3` 保留独立保存的可选 identity 描述与 location 观察。响应中的
`repository_context` 按完整 repository ID 做键；未知描述为 `identity: null`，
没有观察为 `locations: []`。名称和 remote 可以重复，不会合并 ID；location 只表示
曾观察到的路径，不承诺路径仍存在，读取上下文也不会扫描这些路径。
描述或 checkout 缺失不影响 repository memory：

```sh
memocap --repository-id 'repository:<64 lowercase hex>' recall 'project convention' --json
```

`memocap_scope` 接受互斥的 `paths` 或 `repository_ids`，每个明确目标逐项经过
host permission。`scope resolve --json` 只解析显式路径或 ID，不打开数据库、不写 Git。
选定 ID 在 recall、list、remember 和 readback 中保持不变，不因可选历史路径消失而
失效；该冻结上下文不限制默认全库 recall。访问源码仍需有效路径与权限。描述、location
和返回上下文都不授权扩大目标。
历史语义补全仅在发布并本机安装后提出一次性确认计划，优先正常接口。

库存和可见性报告使用的 visible stack 顺序是：

1. 当前 repository。
2. 按持久化 attachment 顺序排列的 attached domains。
3. universal memory。

这个顺序不限制默认 recall；默认 recall 搜索整个已授权记忆库，并在预算前统一排序。
`list` 和 TUI List 保留可寻址记录，并标注当前 topic/replacement 可见性。`status`
显示每个 source 以及总计的 addressable/effective 数量。Topic 标签可以影响这些库存标注；
recall 不根据这些标注隐藏候选。

`--topic` 为 placement 中的记录设置标签。更新已有记录需要显式指定它的 `--id`；
仅有 topic 不会替换正文。不同 placement 共享 topic 不会复制或删除记录，也不会在 recall 中隐藏记录。

## Copy、move 和 provenance

Copy 和 move 都要求精确 placement。Copy 保留 source record，并在目标创建
新 record。Move 保留 memory ID，只改变 placement。`scope move` 因为会从 source
placement 删除记录，所以必须使用 `--yes`：

```sh
memocap scope copy --id 7 --from repository:<REPOSITORY_HASH> --to domain:rust/cli --note "shared crate guidance"
memocap scope move --id 8 --from domain:rust/cli --to universal --yes
```

第一次 transfer 写入 immutable first-transfer provenance。后续 copy 或 move
事件单独写入 operation ledger。相同 operation ID 的精确已提交请求在新进程或
attachment 改变后仍可幂等 replay。相同 operation ID 配不同请求会 conflict，
且不产生 mutation。

## TUI

运行 `memocap ui`，或不带 subcommand 运行 `memocap`。菜单只有 `Status`、
`List visible memories`、`Exit`。Status 显示 schema version、按顺序的
placement、addressable/effective 数量、总计，以及 local 或 remote target。
List 使用与 CLI 相同的 visible inventory，包含 placement 和 shadow annotation。
翻页回到菜单，不写入 memory。

## Local 和 remote target

没有设置 remote address 时，CLI 打开本机 SQLite，不使用网络。设置
`MEMOCAP_ADDR` 后进入 remote mode，并且必须设置 `MEMOCAP_TOKEN`。缺少 token
会报错，remote mode 不会静默回退到本地。地址和 token 必须同时存在。

服务器只接受 `/v1` 下经过认证的 `POST` 请求。`Authorization: Bearer <token>`
只负责 gate 整个 server。这是一个共享 bearer token。它不是 ACL、IAM、按用户授权或 tenant isolation。placement 选择和 domain attachment 决定 namespace selection，
不决定 authorization。

Bearer 鉴权不提供传输保密性或完整性。默认 Compose 部署只在宿主 loopback
接口暴露明文 HTTP。远程客户端必须经过运维人员控制的 TLS 终结反向代理，或等效的
可信加密网络边界；将 `MEMOCAP_ADDR` 设为其 `https://` endpoint。不要在所有宿主
接口发布原始 HTTP 端口。

当前 JSON 操作通过 `/v1/capabilities` 检查 server 版本，再调用 `/v1/receipt`；
CLI 与 server 必须匹配 0.6.0，版本不符在 mutation 前拒绝，无旧请求 fallback 或新增能力协商。route、trust boundary、
Compose 和 recovery 流程见[DEPLOYMENT.md](docs/DEPLOYMENT.md)。服务器严格校验
remote repository ID。

远程 copy 或 move 丢失响应时，使用已发出的 recovery handle 运行
`memocap operation status --recovery <RECOVERY>`。`not_found alone` 不证明
手工 replay 安全，operation 仍可能是 unknown。不要只凭 bare `not_found`
结果手工重放请求。

## Policy boundaries

OpenCode skill 的 memory-admission 与 least-sharing policy 是 model guidance。它倾向于保存
可复用的 convention、长期 preference、持续有效的 decision，以及能减少未来查找工作的简洁
证据路线，即使详细文档已经存在。保留适用条件和来源指针，不复制 runbook。临时状态保留在
source system 中；placement 选择满足目标复用所需的最窄范围。准入和重复检查保持保守，可能
漏掉有用或等价的知识；它们不能证明自然语言事实真实，也不保证完整捕获。此 policy 不承诺
完整分类、不扫描所有 secret、不保证合规，也不会自动创建或挂载 domain。

Runtime validation 是另一层。CLI 和 server 会验证 repository ID、domain
registry、当前 repository attachment、精确 placement 和 operation fingerprint。本地 CLI
遵循调用它的操作系统账户权限。OpenCode 插件读取还要求上文的持久 library grant 和当前
宿主权限。远程请求使用独立的共享 bearer-token gate。Placement 和 domain 选择的是数据来源，
不是 authorization。

## Schema 和 data loss

打开旧版本数据库前先读[SCHEMA-VERSIONING.md](docs/SCHEMA-VERSIONING.md)。新数据库使用
schema `2.3`；只有精确且受支持的 schema `2.2` 可以升级到 `2.3`，仅重建 activity 表及其
必需索引，不改变 memory ID 或 placement。schema `2.1`、`2.0`、`1.0`、预版本、未知、未来版本和畸形数据库会被拒绝，
不会 reset。升级 `2.2` 前，使用 SQLite backup API 或其他 WAL-aware 方法备份。切换
package 版本不会更改或恢复数据库数据。不要用旧备份覆盖更新的数据。package `0.6.0`、
schema `2.3` 和 receipt format `1` 是彼此独立的标识。

## 对照

| 项目 | 怎么记 | 哪一端 |
| --- | --- | --- |
| ClawHub memocap | 值必存 + 言必检 | 只 OpenClaw |
| claude-mem | 自动抓会话 | Claude |
| agentmemory | 自动抓，多端 MCP | 多端 MCP |
| pi-memory | markdown | 只 Pi |
| 本仓库 | 有界证据捕获 + 全库 recall | 仅 OpenCode，本机 SQLite 或带 token 的服务器 |

## 源码部署

用于 Compose 部署的源码 checkout：

```sh
git clone https://github.com/LYY/memocap
```
