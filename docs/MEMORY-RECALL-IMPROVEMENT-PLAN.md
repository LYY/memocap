# 记忆自动捕获与跨项目召回改进方案

**状态：** 已批准，正在独立 worktree 实施；发布及本机升级尚未完成

**适用范围：** 单人、单机、单一 SQLite 数据库；当前正式宿主为 OpenCode。

## 目标与产品方向

本方案有两个同等重要的目标：

1. 在正常任务完成后自动捕获有证据、可复用的经验，不要求用户每次显式说“记住”。
2. 在不同项目和不同措辞下，从已有记忆中找回对当前任务有用的内容。

价值判断以是否减少重复提示、反复定位工具或仓库、以及重新调查同一流程为准。记忆应让用户能从任务直接到达已验证的入口，同时保留对当前资料的核验，不以记忆数量或自动捕获率作为价值替代指标。

交付包含独立 worktree 开发、新版本发布，以及发布成功后的本机升级和运行时验证。仅发布可下载的软件包不算本次工作全部完成。

repository、domain、universal 是现有记录的来源位置和管理来源，不是必须先迁移才能使用的分类。保留所有原有 placement、ID 和来源；不要求旧记录迁入 universal，不要求用户手动管理 domain，也不要求重标旧记录。

用户需要同时在多个相关项目中工作。项目上下文应帮助判断记忆是否适用、作为默认写入来源，但不再把当前 repository 设为默认召回的硬边界。

## 行为合同

### 搜索范围与授权

- 默认召回范围改为所选数据库中、当前宿主明确授权可读的整个人库，包含 repository、domain 与 universal 来源。
- 这取代旧评审中“默认硬过滤 repository 且保留 placement 顺序 shadowing”的建议。placement 仍记录来源和写入归属，但不再决定默认搜索能否看见候选。
- 整库读取权限必须在 host、API 与 receipt 合同中显式表达。不得通过忽略现有 target permission 或把空 targets 默认为全库来扩大访问。
- 为整个人库授权应是明确的授权能力，不是每次查询都弹确认。未取得新授权时不得假装已授权，也不得默默退回另一种范围；具体授权载体在接口设计阶段确定。
- 用户明确要求按 origin、placement 或目标过滤时，过滤条件继续生效，且 receipt 显示实际过滤范围。仅选择当前上下文仓库不等于要求收窄搜索；它是默认写入 origin，不等同于召回 ACL。
- 候选发现、对当前任务的适用性判断、执行某条记忆所述操作的权限是三个独立判断。召回不授予执行权。
- 记忆里的路径只作引用。路径本身不授权读取文件；任何文件访问仍须由当前 host permission 单独允许。

### 候选排序与适用性

- 先在授权人库内广泛收集词面与语义候选，再按当前任务、项目和环境的相关性排序，随后处理重复与冲突，最后应用条数和字符预算。
- 不按 repository/source 顺序先取前三条，也不因同 topic 就无条件排除其他 placement。来源、topic、明确的适用条件均是排序与解释依据，不是暗中丢弃候选的捷径。
- 保留已经明确建立的替代关系，并按其适用条件判断当前有效内容。仅有相同 topic 或不同 placement 不构成新的覆盖依据；结果应说明冲突、替代关系及其适用条件。
- 项目、环境或版本不匹配时不得把操作步骤当成适用指令。例如 alpha 发布流程不能自动用于 beta 或 production。
- 旧记录不因缺少结构化 metadata 而被排除；正文明确记载的项目或环境条件可以用于适用性判断，无须先补写字段。缺少明确依据时标为未知，不根据来源路径或含糊措辞猜测有效范围。
- 重复候选可以折叠展示并保留所有来源 ID。矛盾事实并列呈现并指向证据核验，不做静默覆盖、合并或删除。

### 查询与检索质量

- 修正长查询只保留前 12 个词的问题，保留尾部的精确路径、错误、版本、服务名等锚点。不能让常见前缀词挤掉后置实体。
- 修正中文及英中混合查询的词面发现。先建立经固定用例验证的 CJK lexical baseline，再评估本地语义候选与融合。
- 搜索目标是“本地语义候选 + lexical exact anchor”的混合发现。模型、索引、融合方法和运行预算均须由本机测量与 holdout 结果选择。
- BGE-M3 可作为实验候选，不代表本身就保证召回质量。Respire Core 内部实现不可见，不作为可移植算法合同或质量证据。
- 不预设未经验证的 rank 权重、候选倍数、延迟门槛、模型体积或资源上限。先测 corrected lexical baseline，再冻结验收门槛并做配对比较。

### 注入完整性

- 每条注入引用都必须声明 `full` 或 `partial`。禁止静默截断可能含约束、否定或环境边界的正文。
- 若预算只能放入 partial 内容，receipt 和注入内容都保留完整性状态、记忆 ID 及取得原文的路径。协议、缓存和 receipt 不得丢失这个状态。
- 对 partial 引用，在将其作为操作依据前，必须按稳定 ID 读取并核对完整原文；未获得原文时不得假定被省略的尾部没有限制。
- 不强迫所有历史记录补写手工 title。先用现有正文、tags 和可重建索引服务召回，再用实测判断新增派生字段的价值。

### 自动捕获

- 对一个正常完成的用户请求至多启动一次有界的完成后审查，不在每个工具调用或模型步骤后重复运行。用户不必显式发出“记住”指令。
- 审查只提取已完成任务中有来源证据且未来可复用的内容：操作流程、入口、前置条件、成功检查、已知陷阱、约定、长期偏好和已作出的决定。工具成功退出不等于业务目标已完成；未验证的业务结果不得写成已证实经验。
- 当记忆能减少重复提示、定位或调查时，即使详细文档或代码已存在，也允许捕获已核实的“任务到工具”或“服务与环境到仓库及入口”路由，包括前置条件、验证方式和来源指针。检索命中路由后仍应直接查看当前文档或脚本，不凭旧记忆代替核验。
- 这取代“权威文档已写明就不应记住”的过严规则。即使路由已写入文档，只要能减少未来提示或定位成本，仍可保存精简路由、适用条件与权威来源指针；不复制完整 runbook，也不保存临时结果或没有导航价值的重复摘要。
- 拒绝秘密、凭据、临时状态、一次性结果、无来源支撑的 assistant 推断，以及已有等价记录。结论必须保持在证据实际支持的范围。
- worker 的自身调用不得再次触发捕获。新输入、会话中断或取消应使过期 worker 停止并丢弃未提交候选；permission denial 是终态，不可改走 shell 或 CLI 绕过。
- 写入开始前核对请求是否仍有效；写入已经开始时，不得假定取消已阻止提交，必须独立读回确认实际结果，不回放写操作。
- 写入结果只有在独立 readback 确认 ID、placement 与正文后才能报告为 saved。写入结果不确定时先读回确认，未确认前不得重试。
- 不要求每轮必须写入一条记忆；模型调用、工具调用及写入次数仍设有界上限。不自动进行破坏性 merge 或删除。记录 duplicate、no durable value、insufficient evidence、denied、budget、failed、unknown 等明确结果，并沿用 receipt/activity 的可观测方式表达。

### 面向任务的路由记忆

- 路由记忆回答“这类任务从哪里开始、需要什么条件、怎样确认结果”，不声称已替用户执行当前任务，也不取代在线事实与实时状态检查。
- 合成案例包括：调查线上 issue 时路由到 Datadog logs 与 Metabase production DB；用户要求将某服务发布到 alpha 环境时，若有已核实映射则路由至对应仓库和入口，不要求用户提供路径；跨仓库改写查询应能在不含工具名或仓库路径时找到同一类有效路由。
- 仓库名称或当前工作上下文不证明服务归属。只有来源证据明确绑定服务、环境和仓库时才保存映射；证据不足时将路由标为 unknown，不自行猜测。
- 路由找到后应直接阅读当前仓库的权威 docs、脚本或配置，核对入口、前置条件和验证命令。记忆提供导航，不复制完整 runbook，也不重复保存临时调查结果。
- 已证实入口失效或适用条件变化的路由应标明失效依据并重新核验；未知服务与不适用环境应明确呈现。不能仅因记录较旧就判断路由过期，也不能把未知或不适用的内容当作可执行指令。

## OpenCode 集成门槛

官方 [Plugins 文档](https://opencode.ai/docs/plugins) 描述 `session.idle` 事件及 SDK client。当前 [plugin/recall.js](../plugin/recall.js#L211) 处理的是 `session.deleted` 与 `session.error`，尚无已核实的请求完成后捕获 worker。

尚未验证的事项包括：完成事件能否稳定区分正常完成与中断、worker 如何避免递归、取消与新输入竞争如何处理、权限 denial 是否按预期传播，以及当前 `@opencode-ai/plugin` 1.19.3 的精确模型调用 API。不得把 `client.session.chat` 写成该版本已确认的接口。

实现前先做集成 spike，并在真实 OpenCode 宿主进行手工 QA。确认生命周期、递归隔离、取消和权限行为后，才进入捕获实现；worker 预算必须实测，不照搬 Respire 的轮数、调用数或 30 秒限制。

## 分阶段实施

### 开发准备：隔离目标版本

在阶段 0 前准备 v0.6.0，目标依据是当前 package 与最新发布版本 v0.5.0，而不是假设已有后续版本。本次方案整理时观察到当前 `main` 为 `33e3f3f4c58d86a70a571e58eafaf3b763b942b9` 且是唯一 worktree，GitHub v0.6.0 tag 前缀查询为空，npm 已发布版本也不含 0.6.0。实际开发前与创建 tag 前均须重新核对分支、工作区、package/Cargo 版本及 GitHub/npm 版本冲突。

开发前逐项确认：

- `main` 与远端状态已刷新，记录当前 HEAD 和 tracked/untracked 状态。
- `feat/memory-recall-v0.6.0` 分支及目标 worktree 路径不存在冲突；发现已存在时先检查其内容，不覆盖。
- package 与 Cargo 版本、GitHub v0.6.0 tag、npm 已发布版本分别核验；任一冲突未解决前不进入阶段 0，也不覆盖既有发布。

必须从刚刚核实的 `main` 建立新 worktree `../memocap-memory-recall-v0.6.0`，分支名为 `feat/memory-recall-v0.6.0`。现有未跟踪的 `docs/MEMORY-RECALL-IMPROVEMENT-PLAN.md` 与 `docs/RESPIRE-DESIGN-REVIEW.md` 不会随 Git worktree 自动带入，须明确复制并检查内容；不得覆盖或丢弃它们。后续产品代码、测试和版本变更只在新 worktree 内完成。

进入 worktree 后遵循全局 local-dev 同步要求，并从新 root 执行所有命令。刷新该 worktree 的本地代码图和工具状态，核实 `.code-review-graph/` 与 `.codegraph/` 内部 ignore 规则及 Git 状态；这些本地工具产物不得进入提交。不得在当前 root worktree 直接开发或发布。

### 阶段 0：冻结验收集与公共合同

**产出：** 去敏合成 fixtures、当前 lexical baseline、明确的库读取授权合同，以及完整性字段和按 ID 读全文的协议草案。

覆盖中文改写、长 query 后置锚点、跨项目通用知识、项目/环境不匹配、显式 origin filter、无答案、重复与冲突，以及完整和 partial 正文。捕获样本另行标注应保存、应跳过及其证据；缺失的发布和 DB 流程使用合成任务验证捕获，不算作已有记忆的检索失败。

合成测试还必须覆盖证据 grounding、查询中不含工具名或仓库路径的召回、跨仓库改写、过期或未知路由、环境不匹配，以及应拒绝的冗余完整 runbook。Datadog、Metabase、线上数据库和真实部署均不得由测试连接或操作；使用隔离的合成 fixture 与 mock destination。

**开发前置：** 按“开发准备”核验 v0.6.0 版本与冲突，建立指定 worktree，并将两份未跟踪方案文档显式带入后再开始阶段 0。

**完成条件：** 核心查询 family、目标 ID、negative cases、3 条与 6000 字符的对照预算均冻结；查看 holdout 结果前先声明各门槛的计算规则。所有涉及整库搜索的测试均明确授权状态。

### 阶段 1：OpenCode 宿主集成 spike

验证完成生命周期、SDK 可用面、一次触发、取消、权限拒绝及 readback 行为；用实际安装的宿主和插件版本走通，不由文档事件名推断完整 worker 合同。

**产出：** 可复现的 spike 结果、手工 QA 记录、已验证的宿主边界与失败路径。

**完成条件：** 正常完成只触发一次，worker 不递归；写入开始前收到新输入或取消时不再提交旧候选，已开始的写入能确认实际结果；denial 被报告且无旁路。若宿主不满足条件，先解决集成方式，不以未验证 API 继续写生产逻辑。

### 阶段 2：并行实现捕获与宽范围发现

公共授权、receipt、完整性与 ID readback 合同冻结后，捕获和召回可以并行推进，因为二者分别验证“经验是否值得保存”与“已有经验能否找到”。模块边界先按职责落位，不预定最终函数签名。

捕获工作流覆盖候选证据、准入与去重、默认 repository 写入 origin、permission-aware 写入、独立 readback 和明确结果分类。对已完成任务只审查一次，不导入完整 session，不重写旧记忆。

召回工作流覆盖选定数据库的已授权人库、显式 origin filter、来源与 applicability 分离、冲突呈现和末端统一预算。source order 不再先于相关性决定默认前三名。

**预期改动面：** runtime skill 与 policy、OpenCode plugin、core/CLI、remote server/client 和 receipt，以及针对准入、授权、召回、readback 的测试。精确模块接口以阶段 0 的公共合同为准。

**完成条件：** 合成端到端场景能展示 capture outcome 和跨 placement 候选；未经授权的人库读取、写入或文件访问均为零。

### 阶段 3：串行改进共享检索与注入路径

按顺序执行以下子阶段，每次只推进一项共享接口变更，避免 lexical、正文完整性和语义融合同时改变而无法归因。

1. **词面修正：** 处理 query 前缀截断和 CJK overlap，保留尾部精确锚点；对冻结 query set 与 lexical baseline 配对测量。
2. **完整性及 full-read：** 为每条引用增加 full/partial 语义，确保 ID、readback route、缓存与 receipt 全程一致；测试尾部否定、Unicode 和 JSON 转义。
3. **本地语义候选：** 必须针对已识别的自然语言改写缺口，开展修正后 lexical 与 hybrid 的配对评估。用调参集选择模型、索引、融合及资源预算，再以独立 holdout 决定是否采用；不更改产品授权与 applicability 合同。

每个子阶段先通过 targeted tests，再进行下一项。语义阶段若没有 holdout 收益或造成不可接受的噪声、环境误用或本机资源负担，应停止该实验，不回退已经验证的词面与完整性修复。

### 阶段 4：真实宿主端到端验收

以真实 OpenCode 宿主验证“完成一项任务、自动审查并保存、独立读回、切换到不同项目及不同措辞召回、读取完整原文再使用”。同时验证新输入取消、denial、无可存内容、重复记录和不适用环境。

**完成条件：** 关键场景通过冻结的 gate；权限扩张、秘密保存、无证据写入、部分正文被当作全文使用均为零；保存结果均能独立读回；receipt 可以说明搜了什么、返回什么及完整性状态。

### 阶段 5：版本发布与隔离安装验收

仅在阶段 4 的真实宿主 E2E 通过后进入发布阶段。同步更新 `package.json`、`package-lock.json`、`Cargo.toml`、`Cargo.lock`、CI 中的 `RELEASE_TAG` 及当前 docs、runtime skill 和 policies 的版本标识为 v0.6.0；不预设 schema 版本变化。核对版本断言和实际 v0.5.0 到新版的安装升级合同，不机械替换历史 fixtures 或沿用过期的升级特例。运行 `RELEASE_TAG=v0.6.0 node scripts/check-release.mjs`，并完成相关测试、构建、真实宿主 QA、变更 review 与合入。

发布 tag 只能指向最终合入 `main` 的精确 SHA，且该 SHA 的 main push CI 已成功后才能创建。使用仓库现有 `.github/workflows/release.yml` 的 `v*` tag 触发发布，不在本地 npm publish，也不手工创建 GitHub Release。工作流先验证 tag/CI/main 关系，再生成 Linux x64、macOS arm64、Windows x64 三个平台二进制及其校验文件，GitHub Release 应包含六个资产。

registry job 使用 `npm-release` Environment、`id-token: write`，并按 `npm publish --access public --provenance --ignore-scripts` 发布。只有该 GitHub Actions registry job 成功，并完成 registry metadata、integrity 与 provenance 验证，才是 npm trusted publisher 的验收证据。绑定已由仓库 `AGENTS.md` 确认为 active；不得运行 `npm whoami`、`npm trust list`、npm token/login 命令，不得创建、修改或删除 trust，也不得执行旧版 RELEASE-TRUST migration 步骤。

对 tag、GitHub Release 资产和 npm registry 结果分别读回核实。写操作结果不确定时先执行对应读取确认，禁止靠重试发布或 tag 操作来验证成功与否。

使用隔离的全新安装和从 v0.5.0 升级路径，以合成代表性数据检查；禁止复制或连接用户 live DB。验证 CLI binary、plugin 与已安装 policy/skill 版本一致，数据保留正确，并在真实宿主中走通“捕获后 readback，再以无工具名、无仓库路径的输入跨仓库召回路由”；外部 Datadog、Metabase、DB 与部署目标使用 mock，不执行真实操作。

**完成条件：** v0.6.0 已发布且可供用户安装，隔离安装与升级验收通过；记录版本号和最终 SHA、CI/Release/registry 链接，以及安装升级和真实宿主 QA 证据。发布成功后继续执行阶段 6，不以 registry 成功代替本机升级完成。

### 阶段 6：发布后升级本机，待用户重启后验证生效

本机安装新版是用户明确要求的交付步骤，在阶段 5 确认发布成功后执行。沿用本机现有托管安装的范围与数据库，按新发布 tag 对应的 `docs/INSTALL-AGENT.md` 升级；不得直接套用旧版指南中的升级版本或 schema 假设。

1. 读取现有 CLI、plugin、policy/skill、托管 manifest 与配置来源，确认实际安装范围；冻结本次已验证发布的精确版本，不再次跟随浮动 latest，也不额外创建项目级安装。
2. 先执行该版本支持的只读检查与 dry-run，处理真实冲突。按版本指南备份既有数据库并执行正式更新，保留记忆、ID、来源及配置中的非托管内容。实际本机升级与前述隔离测试分开，不拿用户数据库做测试 fixture。
3. 用独立读操作确认安装结果：实际 CLI 路径与版本、plugin entry、policy/skill 版本和 digest、托管 manifest，以及 schema/activity readiness。结果不确定时先查实际状态，不重复安装来验证成功。
4. 静态检查通过后报告“已安装，待用户重启 OpenCode 后验证”，记录目标版本、安装结果和后续验证项，此时 `runtime.status: not_run`。由用户自行重启；agent 等待用户确认已重启，不主动重启用户宿主，也不以另启宿主代替这一确认。
5. 用户确认重启后，在重启后的新会话中验证新版加载，核对 `/memory status` 的 managed policy 路径、版本与 digest，并观察真实 recall receipt。自动捕获与跨仓操作路由的写入测试在隔离环境完成，不向真实记忆库插入测试记录，也不执行生产查询或部署。

**完成条件：** 新版本已安装到本机原有集成中，CLI/plugin/policy 一致，已有数据保留；用户重启后，新会话的运行时验证通过。安装和静态检查完成即可交付这一阶段的安装结果，并将运行时验收明确留为“待用户重启后验证”，无需保持当前任务阻塞等待。用户确认重启后再继续验收，报告安装范围、版本和路径、数据保留与运行时证据；在此之前不能声称新版已在当前会话生效或运行时验收完成。

## 评测与验收

捕获和召回分别评估，不能用检索分数代替写入质量。捕获报告 admission precision、admissible knowledge coverage、readback success 与 duplicate rate；召回报告 candidate coverage、hit@1、hit@3、MRR、negative noise、wrong-environment rate、p50/p95 latency 与索引 footprint。

冻结的合成路由评测须覆盖：有证据的线上 issue 到 Datadog logs 与 Metabase production DB；要求将某服务发布到 alpha 环境时召回已知仓库和入口且不依赖用户提供路径；不带工具名或仓库路径的跨仓库改写；已证实失效及 unknown 路由应要求核验；环境不匹配不得执行；已有权威资料时捕获精简路由而非复制完整 runbook。全部使用合成数据与 mock destination，不访问真实 Datadog、Metabase、production DB 或部署环境。

冻结的 query family 必须含中文自然问法、英中混合、改写、长问句精确锚点、项目专属事实、环境/版本冲突、显式 origin filter、no-answer 与近似负例。按 family 和目标 placement 分开报告，不只报平均值。

核心对比保持当前 top 3 条与 6000 字符注入预算。改变条数或字符预算是独立实验，不与排序或模型改动混在一轮。先测正确 lexical baseline，再测 hybrid；调参集与 holdout 分离。

在查看 holdout 前预先写定接受门槛。数值目标从实测 baseline、查询成本和风险约束中制定，不猜测、不沿用 Respire 的默认值。报告跨项目噪声相对有用召回的真实取舍。

必须通过的关键例包括：中文 `数据库变更必须保留用户数据` 能被“数据库迁移有什么要求”找到；查询前 12 个常见词后的 `Deployment` 仍被发现；精确路径、错误和版本不被语义融合压过；alpha 内容不被当作 beta/prod 指令；尾部否定只能以 partial 展示时，使用前先读到全文。

安全 gate 固定为零：不得保存秘密、无证据事实或越权候选；不得把来源路径解释为文件权限；不得丢掉显式 origin filter；不得将 partial 正文无标记地作为完整依据。测量失败或未达门槛时如实报告，不宣称普遍提升。

## 数据、安全与非目标

继续使用单一 SQLite。所有权威 memory 行、ID、placement、type、tags、topic、时间、organization 状态、domains/attachments、provenance、extensions、activity 和 operation ledger 均须保留。语义 embedding、FTS 派生内容等索引可重建并与原文保持一致；语义索引 pending 时 lexical recall 必须可用。

索引结果不能返回已删除记录，也不能用过期正文覆盖当前记录。索引重建、并发更新和删除必须验证稳定 ID 与当前正文版本。

如确实需要 schema 变化，只能提出从当前安装版本出发的窄升级，按 [ADR-0001](adr/0001-single-database-compatible-evolution.md) 与 [SCHEMA-VERSIONING.md](SCHEMA-VERSIONING.md) 增加保留数据、失败回滚及独立读回测试。不得预写未来 schema 号、扩展旧客户端兼容或重置数据库。

本优化不重写历史记录、不批量导入旧 session、不做自动文件系统扫描、不增加通用迁移框架或 ontology，不做情绪/热度加权，不自动 merge/delete。按 query 的显式反馈可作为后续可选演进，不阻塞本方案。

需要用实测决定的是宿主集成可行性、worker 与检索预算、CJK tokenizer、模型和索引方案、信号融合及 holdout tradeoff。这些是实现参数，不是要求用户重新决定是否自动捕获或是否跨项目发现。

## 证据与限制

当前审计是有界扫描，不是原子数据库快照，也不能解释历史记录为何缺失。扫描时发现 12 条 live records，分布在 6 个 repository placements，domain 与 universal 均为 0。其中既有操作排障路由，也有保存在单个仓库来源中却涉及其他项目的知识。这些观察用于解释跨项目发现的需求；公开方案不包含具体记录 ID 或业务内容。

没有找到完整的多环境发布流程或通用生产数据库查询流程；现有排障记录包含部分数据库导航线索。没有证据可归因这些未找到项的来源。上述观察不能用来推断历史捕获失败率；实现测试须创建去敏合成等价物，不得访问用户 live database 或使用真实记忆作为 fixture。

既有合成探针复现了局部失效：保存的中文原句“数据库变更必须保留用户数据”能原文召回，却无法通过“数据库”或“数据库迁移有什么要求”召回；英文 `Deployment` 精确查询命中，但 `release validation` 未命中；长问句前 12 个 token 会丢弃末尾 `Deployment`；7026 字符原文只注入 5999 字符，尾部 prohibition 消失且没有 partial 标记。

这些数据只证明对应 failure mode 存在，不是总体 benchmark，不支持提升百分比或广泛质量结论。旧审计中构建成功及 48 项测试通过是此前实现验证，不是本提案新跑的检查，也不是自然语言召回质量证据。

Respire 比较依赖公开文档与 CLI/plugin 可见源码；Core 排序内部不可检查，也没有真实 held-out 对比结果。参考 [Respire 设计评审](RESPIRE-DESIGN-REVIEW.md) 中的证据分级与限制。本方案预计通过移除已复现的查询词丢失、CJK 词面盲区、范围过滤和静默截断等失败路径，改善记忆捕获与召回能力；改善幅度尚未测得，不作比例承诺。

## 实施决定与测量边界

实现继续遵循已批准的产品取舍：用户明确提出“不能召回比召回跨区域更致命”，由 agent 根据完整来源判断内容是否适用于当前任务。默认在明确授权的库内发现跨来源候选，保留冲突与原文条件；不因相同 topic 恢复来源遮蔽，也不把候选、来源位置或记忆路径当成执行授权。没有可靠条件的历史记录仍标为 unknown。

冻结的 v1 合成 holdout 共 12 例。旧版严格成功 5/12，修正词面与发现范围后为 7/12；正例 hit@3 从 7/11 到 9/11，可见候选覆盖从 9/11 到 11/11。无答案样本仍有噪声，错误环境候选的曝光率仍为 1/2。v1 对 forbidden ID 的曝光要求没有全部达到，长正文在显式 CLI 整条预算下被省略也仍计失败。这些原始结果保留，不通过改标注、隐藏冲突或把 full-read 计入初始完整注入来提高分数。

候选曝光与执行必须分开验证：原文明确只适用于 alpha 的候选可被发现，但不得作为 beta 或 production 的操作依据；partial 内容必须按提供的 ID 与 hash 读取当前全文。真实隔离宿主的操作验收另外检查跨环境拒绝、未知和失效入口先核验、冲突并列、显式过滤、尾部否定与原生权限。这类使用脚本 provider 的验收证明宿主工作流和权限边界，不是模型判断准确率或普遍执行安全的证明，也不把 v1 未通过项改称通过。

本地语义候选已按预先冻结的配置完成配对实验，holdout 没有额外修复样本，且引入约 900 MB 的实验进程峰值 RSS。因此 v0.6.0 不集成该模型、其运行库或模型下载；采用已验证的长查询、CJK、宽范围发现和完整性修复。实验及资源测量见 [语义实验记录](SEMANTIC-EXPERIMENT.md)，其结论仅针对本次模型、配置和小型合成集。

实际 schema 变化仅用于让现有 activity phase CHECK 接受 `capture_review`。当前实现从真实 v0.5.0 的 schema 2.2 窄升级至 2.3，事务保留原有活动与其余数据；不重建 memory 表、不重写历史记忆、不增加旧客户端兼容链。升级的只读检查、失败回滚及真实旧版托管安装验收分别留存证据。

## 参考

- [Respire 对照、合成探针与历史建议](RESPIRE-DESIGN-REVIEW.md)
- [单数据库与演进决策](adr/0001-single-database-compatible-evolution.md)
- [当前 schema 生命周期合同](SCHEMA-VERSIONING.md)
- [查询词提取、引用预算与 partial 现状](../plugin/protocol.js#L56)
- [OpenCode 自动召回与默认 top 3/6000 字符预算](../plugin/recall.js#L107)
- [OpenCode 当前事件处理](../plugin/recall.js#L211)
- [当前 placement 召回、排序与 topic shadowing](../src/store/visible/recall.rs#L63)
- [当前 FTS 查询](../src/store/visible/recall.rs#L158) 与 [索引列](../src/store/schema/baseline.rs#L62)
- [当前 admission、证据与 placement policy](../skills/memocap/references/memory-policy.md#L5)
- [OpenCode 官方 Plugins 文档](https://opencode.ai/docs/plugins)
- [现有发布工作流的验证与 registry jobs](../.github/workflows/release.yml#L15) 与 [registry trusted publishing job](../.github/workflows/release.yml#L225)
- [发布版本合同检查器](../scripts/check-release.mjs#L65)
- [npm trusted publisher 与产品演进约束](../AGENTS.md)
- [当前安装升级合同与运行时验证；发布时须同步到新版本](INSTALL-AGENT.md)
