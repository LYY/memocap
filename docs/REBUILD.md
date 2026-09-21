# memocap 当前重开发基线

这是当前实现规格，不是历史原型说明。OpenCode 是唯一官方支持的集成。先读
[README](../README.md)、[DEPLOYMENT](DEPLOYMENT.md) 和
[Schema Versioning Contract](SCHEMA-VERSIONING.md)。本文只描述当前
domain-aware memory 行为。

## 当前安装和边界

安装顺序固定为先全局 CLI，再注册 OpenCode 插件：

```bash
pnpm add -g @lyy-gh/memocap@0.0.6
opencode plugin @lyy-gh/memocap
```

全局 CLI 必须在 `PATH` 中，插件把 `memocap` 作为 sidecar 调用。
Codex、Claude Code、Pi 的 host adapter、规则注入和 host path state 已移除，不是 deprecated，也不提供行为保证。

默认 target 是本机 SQLite。设置 `MEMOCAP_ADDR` 后选择 remote target，并且必须
同时设置 `MEMOCAP_TOKEN`。缺少 token 会失败，不会回退到本地。Compose 只提供
一个服务、一个端口和一个持久卷，不提供 ACL、IAM、多租户或按用户授权。

## 当前命令矩阵

README 和 README-CN 中的命令矩阵必须保持完全一致。它是 CLI 帮助的文档化摘要：

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

已移除 `memocap install`、`memocap uninstall`、`--global`、旧 scope syntax、
旧 TUI 写入或删除菜单。旧的无版本 HTTP route 已移除。这些 surface 是 removed，
不是 deprecated compatibility surface。

## Domain lifecycle

Domain registry 和 repository attachment 是两件事：

1. `memocap scope domain create <DOMAIN>` 注册可复用 domain ID。
2. `memocap scope domain attach <DOMAIN> [--before <DOMAIN>]` 将已注册 domain
   挂载到当前 repository，并可插入到已有 attachment 之前。
3. `memocap scope domain list` 显示当前 repository 的 attachment，`--all` 显示
   registry 中的所有 domain。
4. `memocap scope domain detach <DOMAIN>` 只解除当前 repository 的绑定。
5. `memocap scope domain delete <DOMAIN>` 删除未使用的 registry entry。

Domain 必须先注册，且用于当前读写时必须已挂载。系统不会自动创建或挂载 domain。
`scope show` 显示当前 repository ID、解析来源和 attachment 顺序：

```text
memocap scope show
```

## Placement 和 visible stack

当前 repository placement 是默认写入位置。`--domain <DOMAIN>` 选择已挂载 domain，
`--universal` 选择 universal。两者互斥。Recall 和 list 不带 selector 时使用
visible stack，带 selector 时只读取一个精确 placement。Forget 默认删除当前
repository 中的 ID，使用 selector 才能删除 domain 或 universal 中的 ID。

默认 stack 顺序是 repository、按持久化顺序排列的 attached domains、universal。
Repository 相同的非空 normalized topic 会遮蔽所有更低层匹配项。Domain 相同的
topic 会遮蔽 universal。Domain 之间互不遮蔽。Recall 先过滤 shadowed rows，再
应用 limit 和字符预算。List 和 TUI List 保留所有 addressable rows，并展示
shadow 原因。Status 显示每个 source 的 addressable/effective count 和总计。

Repository 相同的非空 normalized topic 会遮蔽所有更低层匹配项；这不是复制或删除。
Domain 相同的 topic 会遮蔽 universal，domain 之间互不遮蔽。

## Copy、move 和 provenance

`scope copy` 和 `scope move` 都必须给出 `--id`、`--from`、`--to`，并使用精确
placement：`repository:<hash>`、`domain:<DOMAIN>` 或 `universal`。Source 和
destination 必须不同。Move 还必须给 `--yes`。

Copy 保留 source memory，并在 destination 创建新 memory。Move 保留 memory ID，
只改变 placement。第一次 transfer 的 provenance 不可变，后续 transfer 作为
独立 operation ledger event 保存。精确 operation ID 和 request fingerprint 让
已提交请求可以在新进程中 replay；改动同一 operation ID 的请求会 conflict，且
不会写入部分状态。

## Remote `/v1` 和 recovery

Remote 只使用 `/v1`。服务器先校验 `Authorization: Bearer <token>`，再解析
请求。Bearer token 是整个 server 的共享 gate，不是 ACL、IAM、用户授权或 tenant
隔离。Remote scope ID、domain attachment、placement 和 operation fingerprint
仍由运行时单独校验。

当前 `/v1` operation 包括 memory remember、recall、list、forget，domain create、
list、attach、detach、delete，memory copy、move，operation status 和 status。旧的无版本 HTTP route 已移除，不保留 fallback。

远程 copy 或 move 遇到响应丢失时，CLI 会基于 repository、operation ID 和 request fingerprint 形成严格 recovery handle，并通过 `operation status --recovery`
查询。状态可能是已提交、`not_found` 或 unknown。`not_found` alone 不证明手工 replay 安全，operation status 请求自身也可能处于 unknown。只能使用已发出的
严格 handle/status 流程；不能把一次丢响应当作可以随意重发的许可。
not_found alone 不证明手工 replay 安全。

## TUI 和 skill policy

TUI 只提供 Status、List visible memories、Exit。Status 和 List 使用共享的
visible-stack service，显示 schema、placement、provenance/visibility 注释和
addressable/effective counts。翻页和退出不改变 SQLite。

Skill policy、runtime validation、namespace selection、authorization 是四个不同
边界。Skill policy 只指导模型，不扫描 secret、不会自动分类、不保证合规。Runtime
validation 检查 ID、registry、attachment、placement 和 fingerprint。Namespace
selection 由默认 stack、`--domain`、`--universal` 决定。Authorization 只指 remote
bearer-token gate。

## Schema 生命周期

数据库生命周期以 schema versioning contract 为唯一权威，不在此
重复其 machine-readable policy。准确的 recognized old schema 是唯一无需确认的
bulk-delete 例外，事务会删除旧 memory rows、创建 schema `1.0`、不创建 backup，
并输出 reset notice。未知、未来、畸形和不同 major schema 都在不修改数据的情况下
拒绝。没有 standalone reset command。
