[English](README.md)

# memocap

memocap 是 OpenCode 的 local-first SQLite 记忆 sidecar。它把显式记忆保存
到当前仓库、已挂载 domain 或 universal placement，再通过一条有序 visible
stack 进行 recall。

OpenCode 是唯一官方支持的集成。插件通过全局 `memocap` CLI 调用 sidecar，
不会打开第二份存储。数据库生命周期以[Schema versioning contract](docs/SCHEMA-VERSIONING.md)
为准。部署和远程操作见[DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 安装

先安装全局 CLI，再注册 OpenCode 插件：

```sh
pnpm add -g @lyy-gh/memocap@0.0.8
opencode plugin @lyy-gh/memocap
```

全局 CLI 必须在 PATH 中（也就是 `PATH`）。插件会把 `memocap` 作为 sidecar 调用，不提供其他宿主集成，
也不会建立第二个记忆库。

## 命令矩阵

下面是当前 CLI surface。placement selector 互斥。`<PLACEMENT>` 是
`repository:<64 lowercase hex>`、`domain:<DOMAIN>` 或 `universal`。

```text
memocap remember [--type <TYPE>] [--tags <TAGS>] [--force] [--id <ID>] [--domain <DOMAIN> | --universal] [--topic <TOPIC>] <CONTENT>
memocap recall [--limit <LIMIT>] [--type <TYPE>] [--max-chars <MAX_CHARS>] [--domain <DOMAIN> | --universal] <QUERY>
memocap list [--limit <LIMIT>] [--domain <DOMAIN> | --universal]
memocap forget [--domain <DOMAIN> | --universal] <ID>
memocap scope show
memocap scope domain create <DOMAIN>
memocap scope domain attach <DOMAIN> [--before <DOMAIN>]
memocap scope domain detach <DOMAIN>
memocap scope domain list [--all]
memocap scope domain delete <DOMAIN>
memocap scope copy --id <ID> --from <PLACEMENT> --to <PLACEMENT> [--operation-id <OPERATION_ID>] [--note <NOTE>]
memocap scope move --id <ID> --from <PLACEMENT> --to <PLACEMENT> --yes [--operation-id <OPERATION_ID>] [--note <NOTE>]
memocap operation status --recovery <RECOVERY>
memocap status
memocap serve [--bind <BIND>]
memocap ui
```

`scope domain create` 注册可复用 domain ID。`attach` 把已注册 domain 挂载到
当前仓库，`--before` 调整它在 stack 中的位置。`detach` 只移除当前仓库的
绑定。`list` 显示当前仓库的 attachments，`list --all` 显示 registry，
`delete` 删除未使用的 registry entry。

不带 selector 时，`remember` 写入当前仓库 scope。`--domain` 要求 domain 已挂载，
`--universal` 选择 universal memory。不带 selector 的 `recall` 和 `list`
使用 visible stack；selector 则限制到一个精确 domain 或 universal placement。
`forget` 总是针对一个精确 placement，默认是当前仓库。

已移除的 surface 是 removed，不是 deprecated。已移除的 CLI 包括
`memocap install`、`memocap uninstall`、`--global` 以及旧 global 或 scope
语法。已移除的 TUI 包括写入、删除和旧菜单操作，现在只保留 `Status`、
`List visible memories`、`Exit`。Codex、Claude Code、Pi 的 host adapter 和
host path state 已移除。旧的无版本 HTTP route 已移除，不是兼容或 deprecated
路径。

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

Stack 顺序就是 repository、按持久化顺序排列的 attached domains、universal。

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
不会回退到本地。

服务器只接受 `/v1` 下经过认证的 `POST` 请求。`Authorization: Bearer <token>`
只负责 gate 整个 server。这是一个共享 bearer token。它不是 ACL、IAM、按用户授权或 tenant isolation。placement 选择和 domain attachment 决定 namespace selection，
不决定 authorization。
不是 ACL、IAM、按用户授权或 tenant isolation。

Bearer 鉴权不提供传输保密性或完整性。默认 Compose 部署只在宿主 loopback
接口暴露明文 HTTP。远程客户端必须经过运维人员控制的 TLS 终结反向代理，或等效的
可信加密网络边界；将 `MEMOCAP_ADDR` 设为其 `https://` endpoint。不要在所有宿主
接口发布原始 HTTP 端口。

远程 `scope show` 读取 `/v1/status`，显示远程 repository 的 attached domains
和 visible-stack counts。route 列表、trust boundary、Compose 和 recovery
流程见[DEPLOYMENT.md](docs/DEPLOYMENT.md)。远程请求携带有效 remote scope ID，且是有效 scope，
服务器会严格校验。远程 scope ID 必须有效。

远程 copy 或 move 丢失响应时，使用已发出的 recovery handle 运行
`memocap operation status --recovery <RECOVERY>`。`not_found alone` 不证明
手工 replay 安全，operation 仍可能是 unknown。不要只凭 bare `not_found`
结果手工重放请求。
not_found alone 不证明手工 replay 安全。

## Policy boundaries

OpenCode skill 的 least-sharing policy 是 model guidance。它要求模型拒绝不安全
候选、选择 repository 或 attached-domain placement、只在稳定跨 domain 时使用
universal、拆分 mixed candidate，并在不确定时使用 repository。它不会自动分类、
扫描 secret、保证合规。这不是 compliance guarantee，也不会自动创建或挂载 domain。

Runtime validation 是另一层。CLI 和 server 会验证 repository ID、domain
registry、当前 repository attachment、精确 placement 和 operation fingerprint。
Namespace selection 还是另一层：`--domain`、`--universal` 和默认 visible stack
决定 memory 的读写位置。Authorization 只有上面所述的 remote bearer-token gate。

## Schema 和 data loss

打开旧版本数据库前先读 `SCHEMA-VERSIONING.md`。唯一
无需确认的 bulk-delete 例外是 exact recognized pre-versioned schema。该事务会
删除所有旧 memory row，创建 schema `1.0`，不创建 backup，并输出指定 reset notice。
未知或不兼容 schema 会在不修改数据的情况下拒绝。没有面向用户的 reset command。

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
