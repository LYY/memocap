# memocap 当前重开发基线

这是当前实现规格，不是历史原型说明。OpenCode 是唯一官方支持的集成。先读
[README](../README.md)、[DEPLOYMENT](DEPLOYMENT.md) 和
[Schema Versioning Contract](SCHEMA-VERSIONING.md)。本文只描述当前
v0.1.0 的 domain-aware、可观测 memory 行为。Package `0.1.0`、tag `v0.1.0`、
core schema `1.0` 和 receipt format `1` 分别管理，不同步递增。

## 当前安装和边界

按[安装指南](INSTALL.md)使用固定版本 setup runner，或按
[Agent 指南](INSTALL-AGENT.md)执行已获授权的安装/更新：

```bash
npx --yes --package @lyy-gh/memocap@0.1.0 memocap-setup install --global --yes --json
```

OpenCode 受支持版本是 `1.19.3`，setup 不安装或升级宿主。插件通过包内绝对路径
launcher 调用同版本 native CLI，不依赖全局 PATH 解析。Skill 使用固定
`skills@1.7.4` 从 matching release tree `v0.1.0` 安装；copy-only skill 的安装
指导链接指向该 tag 下的官方文档。
Codex、Claude Code、Pi 的 host adapter、规则注入和 host path state 已移除，不是 deprecated，也不提供行为保证。

默认 target 是本机 SQLite。设置 `MEMOCAP_ADDR` 后选择 remote target，并且必须
同时设置 `MEMOCAP_TOKEN`。缺少 token 会失败，不会回退到本地。Compose 只提供
一个服务、一个端口和一个持久卷，不提供 ACL、IAM、多租户或按用户授权。

## 当前命令矩阵

完整选项以 `memocap --help`、各 subcommand help 和双语 README 为准。
全局 `--repo <PATH>` 显式选择真实仓库；只有 recall 可重复指定，最多八个。
写操作只有一个目标。`--json` 适用于可观测操作，不支持 `serve` 和 `ui`。
常用运维入口：

```text
memocap recall <QUERY> --repo <PATH> --match all|any --limit 3 --max-chars 6000 --json
memocap remember <CONTENT> --repo <PATH> --json
memocap scope show --repo <PATH> --json
memocap scope list --all --json
memocap list --placement <PLACEMENT> --limit 20 --offset 0 --json
memocap status --read-only --repo <PATH> --json
memocap activity list --writes --limit 20 --offset 0 --json
memocap activity show <OPERATION_ID> --json
memocap activity prepare --json
memocap-setup check --global --json
memocap-setup update --to 0.1.0 --global --dry-run --json
memocap-setup update --to 0.1.0 --global --yes --json
memocap-setup doctor --global --json
```

`memocap-setup --global` 选择安装范围，不是 universal memory selector。
已移除 `memocap install`、`memocap uninstall`、旧 memory `--global`、旧 scope syntax、
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
Domain 相同的 topic 会遮蔽 universal，domain 之间互不遮蔽。Recall 默认 AND
匹配（`--match all`），`any` 显式启用 OR；多目标先按仓库 shadow，再合并并应用
一份 limit/字符预算。完整库存必须显式请求，counts 来源是 core，不是 activity。

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

JSON 操作先协商 `/v1/capabilities`，再调用 `/v1/receipt`，涵盖 memory、domain、
transfer、inventory、activity 和 read-only status。不支持新能力的服务器在操作
发送前失败。既有 versioned routes 继续服务旧客户端；无版本 HTTP route 已移除。
客户端不打开服务器 core/activity 文件，也不回退本地。

远程 copy 或 move 遇到响应丢失时，CLI 会基于 repository、operation ID 和 request fingerprint 形成严格 recovery handle，并通过 `operation status --recovery`
查询。状态可能是已提交、`not_found` 或 unknown。`not_found` alone 不证明手工 replay 安全，operation status 请求自身也可能处于 unknown。只能使用已发出的
严格 handle/status 流程；不能把一次丢响应当作可以随意重发的许可。

## TUI 和 skill policy

TUI 只提供 Status、List visible memories、Exit。Status 和 List 使用共享的
visible-stack service，显示 schema、placement、provenance/visibility 注释和
addressable/effective counts。翻页和退出不改变 SQLite。

本次请求的有效 recall receipt（含空结果或有效缓存）满足 recall-first；不因
每次工具迭代重复相同查询。目标切换需用户明确要求并提供真实路径。插件通过
`memocap_scope`、`memocap_recall`、`memocap_remember` tools 和 `/memory` commands
暴露会话目标、recall、库存、recent、why。Permission denial 必须报告，不能用
shell 绕过。Prepared input 不等于模型理解或采用。

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

普通 v0.1.0 升级不改变完整 core-1.0 fingerprint，保留既有数据，v0.0.10 binary
仍可使用兼容 core。退回旧 binary 不是恢复备份。`status --read-only --json`
只检查，不初始化、迁移或 reset；filesystem/WAL 临时文件边界应独立考虑。

Activity 独立存于 `<core filename>.activity.sqlite`，不增加 core 表。Recall/
injection 保留最多 30 天、10,000 条；write 元数据最多 1,000 条。过期、裁剪、
记录失败或提交后崩溃可留下缺口，不是完整 audit。Core 写入成功后附属记录失败
仍报告成功加 warning，不能重复写入修复历史。`activity prepare` 只显式准备本地
附属库，远程由服务器管理员处理；未知或损坏附属库不自动重置。

## 安装与运行就绪

`check` 解析一次候选版本；更新按 `resolved_version` 固定 `--to`，先 dry-run
再按授权执行。Same-version 一致时 no-op，不完整 owned step 可修复。Npx 可以
在 core 启动前下载 runner 并写 npm cache；core dry-run 不下载 payload 或改配置、
skill、manifest、数据库。失败/partial 后先读取实际状态再重试，不重复不确定写入。

Doctor 区分 `installation_ready`（core 未初始化）、`static_ready`（core 兼容且
activity 可用）、`incomplete`、`activity_not_initialized`、`activity_degraded`。
前两者 exit 0，但 `runtime.status` 仍是 `not_run`。用户重启 OpenCode 后在新会话
实际检查 `/memory status` 和 recall receipt 才能报告 runtime verified。卸载保留
core、activity、备份及其他 agent 的共享 skill，软件回滚不恢复数据库。
