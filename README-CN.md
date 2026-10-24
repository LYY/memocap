[English](README.md)

# memocap

memocap 是 OpenCode 的 local-first SQLite 记忆 sidecar。它把显式记忆保存
到当前仓库、已挂载 domain 或 universal placement，再通过一条有序 visible
stack 进行 recall。

OpenCode 是唯一官方支持的集成。插件通过包内绝对路径的 CLI launcher 调用 sidecar，
并校验 native 版本，不从全局 PATH 选择其他 `memocap`。数据库生命周期以[Schema versioning contract](docs/SCHEMA-VERSIONING.md)
为准。部署和远程操作见[DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 安装

为当前用户安装 v0.2.1 CLI、OpenCode 插件和运行时 skill：

```sh
npx --yes --package @lyy-gh/memocap@0.2.1 memocap-setup install --global --yes --json
```

需要 Node.js 22.20 或更高版本、npm/npx、Git 和 OpenCode 1.19.3。安装器不会
安装或升级 OpenCode。项目安装、手动步骤、检查更新、恢复和数据处理见[安装指南](docs/INSTALL.md)。
Agent 进行已获授权的非交互安装或更新时，按[Agent 指南](docs/INSTALL-AGENT.md)操作。

## 命令矩阵

下面是当前 CLI surface。placement selector 互斥。`<PLACEMENT>` 是
`repository:<64 lowercase hex>`、`domain:<DOMAIN>` 或 `universal`。

全局 `--repo <PATH>` 显式选择真实仓库路径；只有 recall 可重复指定，最多八个目标。
写操作始终只有一个目标。全局 `--json` 返回 format-1 receipt，供自动化使用；
`serve` 和 `ui` 不支持它。package `0.2.1`、core schema `2.0`、receipt format
`1` 是独立版本。

```text
memocap remember [--type <TYPE>] [--tags <TAGS>] [--force] [--id <ID>] [--domain <DOMAIN> | --universal] [--topic <TOPIC>] <CONTENT>
memocap recall [--match all|any] [--limit <LIMIT>] [--type <TYPE>] [--max-chars <MAX_CHARS>] [--domain <DOMAIN> | --universal] <QUERY>
memocap list [--limit <LIMIT>] [--offset <OFFSET>] [--placement <PLACEMENT> | --domain <DOMAIN> | --universal]
memocap forget [--domain <DOMAIN> | --universal] <ID>
memocap scope show
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
`--universal` 选择 universal memory。不带 selector 的 `recall` 和 `list`
使用 visible stack；selector 则限制到一个精确 domain 或 universal placement。
`forget` 总是针对一个精确 placement，默认是当前仓库。

安装使用独立的 `memocap-setup`，其 `--global` 选择集成安装范围，不选择 universal
memory。旧 `memocap install/uninstall`、旧 scope 语法、其他 host adapter、TUI
写入和删除操作、无版本 HTTP route 仍已移除。

## Receipt、库存和 activity

Recall 默认 `--match all`；`any` 匹配至少一个规范化查询词。多仓库显式读取先按
各仓库处理 topic shadow，再对合并结果应用一份条数和字符预算。Receipt 展示
targets、searched placements、query terms、matched/returned IDs、截断、错误和
activity 状态。本次请求已有有效插件 receipt（包括空结果或有效缓存）时，不必
重复相同 recall。

只有明确要求完整库存时才用 `scope list --all`，再用
`list --placement <PLACEMENT> --limit 20 --offset 0` 分页查看精确 placement。
`status --read-only --json` 检查 core 和 activity 兼容性，不产生逻辑写入：不写入
数据或 schema、不初始化或迁移主数据库、不裁剪历史，也不记录 activity。普通记忆命令
（例如 `memocap list`）使用 read-write open，可能初始化缺失数据库，或将 schema `1.0`
桥接到 `2.0`。`activity list/show` 使用 read-only 访问，不会准备数据库。SQLite
`READ_ONLY` 连接仍可能协调 WAL/SHM sidecar；普通 WAL 检查不需要 owner snapshot。
`activity prepare` 显式准备本地主数据库，创建 schema `2.0` 或桥接精确注册的 `1.0`；
准备过程可能裁剪保留的 activity。远程准备由服务器管理员负责。完整边界见
[schema versioning contract](docs/SCHEMA-VERSIONING.md)。

Activity 和 repository hint 在主 SQLite 数据库中保存有限运维元数据，不是完整审计。
Recall/injection 最长保留 30 天、最多 10,000 条；write 元数据最多 1,000 条。
过期、裁剪或记录失败可能留下缺口。Core 写入成功后 activity 失败仍是写入成功，
应报告 warning，不能重放写入来修复历史。旧 `<core filename>.activity.sqlite` 文件不会被
自动打开、导入、改写或删除，其中的历史不会出现在新查询中。静止旧 writer 后的个人丢弃
必须是另行授权的选择。

插件提供 `memocap_recall`、`memocap_remember`、`memocap_scope` tools。
`/memory status`、`/memory recall`、`/memory scope <PATH...>`、`/memory scopes`、
`/memory list`、`/memory recent`、`/memory why` 可查看会话目标和 recall receipt。
准备进入模型输入不证明模型理解或采用。权限及显式切换目标规则见
[runtime skill](skills/memocap/SKILL.md)。

## Scope 和 visible stack

`scope show` 输出 active scope、repository ID、解析来源，以及按持久化顺序
排列的 attached domains：

```text
memocap scope show
```

存在受支持的 Git remote 时，repository identity 保持稳定。remote 不明确或
不支持时使用 Git common directory。Git 外使用规范化的非 Git 目录路径。输出
的 repository ID 是 opaque 标识，不是用户选择的 ACL 或 tenant 名称。

默认 visible stack 顺序是：

1. 当前 repository。
2. 按持久化 attachment 顺序排列的 attached domains。
3. universal memory。

Recall 会在 limit 和字符预算之前处理 topic shadow。repository 中相同的非空 normalized topic 会遮蔽所有更低层匹配记录。domain 会遮蔽 universal 的匹配
记录。domain 之间互不遮蔽。`list` 和 TUI List 保留可寻址的 shadowed record，
并标注 visibility。`status` 显示每个 source 以及总计的 addressable/effective
数量。删除遮蔽记录后，下层记录会重新出现。

`--topic` 只建立显式 replacement relationship，不会过滤普通 topic search，
不会复制记录，也不会删除下层记录。

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

JSON 操作先协商 `/v1/capabilities`，再调用 `/v1/receipt`；服务器不支持新语义时
在发送操作前失败。既有 `/v1/status` 继续供旧客户端使用。route、trust boundary、
Compose 和 recovery 流程见[DEPLOYMENT.md](docs/DEPLOYMENT.md)。服务器严格校验
remote repository ID。

远程 copy 或 move 丢失响应时，使用已发出的 recovery handle 运行
`memocap operation status --recovery <RECOVERY>`。`not_found alone` 不证明
手工 replay 安全，operation 仍可能是 unknown。不要只凭 bare `not_found`
结果手工重放请求。

## Policy boundaries

OpenCode skill 的 memory-admission 与 least-sharing policy 是 model guidance。它只接纳
稳定的 repository convention、持续的 preference，以及理由未被持久、权威且易查询来源
保留的 continuing decision，再选择 repository、attached-domain 或 universal placement。
临时状态保留在其 source system 中。它不会自动分类、扫描 secret、保证合规。这不是
compliance guarantee，也不会自动创建或挂载 domain。

Runtime validation 是另一层。CLI 和 server 会验证 repository ID、domain
registry、当前 repository attachment、精确 placement 和 operation fingerprint。
Namespace selection 还是另一层：`--domain`、`--universal` 和默认 visible stack
决定 memory 的读写位置。Authorization 只有上面所述的 remote bearer-token gate。

## Schema 和 data loss

打开旧版本数据库前先读[SCHEMA-VERSIONING.md](docs/SCHEMA-VERSIONING.md)。精确注册的
schema `1.0` 会桥接到 `2.0`，不重建 core 表，也不改变 memory ID 和 placement。
预版本、未知、畸形或不支持的 schema 会被拒绝，不会 reset。升级旧库前，使用 SQLite
backup API 或其他 WAL-aware 方法备份。v0.1.0 和 v0.0.10 binary 都无法打开 schema `2.0`；
切换软件版本不等于恢复数据。不要用旧备份覆盖更新的 schema `2.0` 数据。

## 对照

| 项目 | 怎么记 | 哪一端 |
| --- | --- | --- |
| ClawHub memocap | 值必存 + 言必检 | 只 OpenClaw |
| claude-mem | 自动抓会话 | Claude |
| agentmemory | 自动抓，多端 MCP | 多端 MCP |
| pi-memory | markdown | 只 Pi |
| 本仓库 | 值必存 + 言必检 | 仅 OpenCode，本机 SQLite 或带 token 的服务器 |

## 源码部署

用于 Compose 部署的源码 checkout：

```sh
git clone https://github.com/LYY/memocap
```
