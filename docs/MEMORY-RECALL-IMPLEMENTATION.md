# v0.6.0 记忆捕获与召回实施记录

日期：2026-11-11。开发基线：`33e3f3f4c58d86a70a571e58eafaf3b763b942b9`。

状态：实现和本地隔离验收完成；最终审查、正式发布和本机托管升级另行记录。当前会话不能作为新版已加载的证据。本机安装后仍须由用户重启 OpenCode，再验证新会话的实际加载状态。

## 实现结果

- 默认发现当前宿主明确授权的整个人库，repository、domain 和 universal 保留来源与写入归属。当前仓库提供上下文，不再暗中限制默认召回；用户指定的精确来源过滤继续生效。
- 长查询保留后置锚点，中文及混合查询使用经过合成用例验证的词面候选。先在授权范围收集候选并按相关性排序，再应用条数和字符预算，不按来源顺序或相同 topic 提前隐藏记录。
- 引用明确标注 `full` 或 `partial`，携带稳定 ID、精确来源、正文 SHA-256 和原文读取参数。部分引用用于操作前，必须读到当前全文；来源路径不授予文件访问权限。
- 正常完成请求后执行有界审查。候选必须引用完整证据单元，保留前提和否定；可保存有导航价值的短文档入口，不复制完整 runbook。宿主冻结来源与正文、检查稳定指纹重复，经真实 native permission 写入后独立核对正文和标签。
- 每次审查最多两个独立子会话、三次模型生成和一次写入尝试。拒绝、取消、无候选、重复、超预算和未知写入结果分别可观察；未知结果不重放写操作。捕获 worker 不递归捕获自身。
- 数据库从当前已安装版本的 schema 2.2 窄升级到 2.3，仅为 activity phase 的 CHECK 增加 `capture_review`。事务内复检和失败回滚；保留所有记忆、来源、ID、扩展数据、历史事件和操作账本。只读检查不会升级数据库。

授权使用持久的精确 library grant，并同时遵守当前会话和 agent 的有效权限规则。空 targets、模型参数或文件路径均不能代替授权。捕获的真实写入仍经过工具宿主的 permission ask；不通过 shell 或备用入口绕过拒绝。

## 测量结果与采用决定

冻结用例、期望值和预算未因结果而改动。以下是 12 条独立 holdout 查询上的描述性结果，不代表真实任务总体准确率。

| 指标 | 原 v0.5.0 | 修正后词面检索 | 实验性语义融合 |
| --- | --- | --- | --- |
| 原严格评分成功 | 5/12 | 7/12 | 7/12 |
| 正例 hit@1、hit@3 | 7/11 | 9/11 | 9/11 |
| 正例候选覆盖 | 9/11 | 11/11 | 11/11 |
| 无答案查询出现噪声 | 1/1 | 1/1 | 1/1 |
| 不适用环境候选曝光 | 1/2 | 1/2 | 1/2 |

原评分的零环境曝光门槛仍未全部达到。它把不适用记录的出现视为失败；实际产品要求是广泛发现、保留来源和冲突，再核验适用性与操作权限。用户已明确接受跨区域候选，以降低漏召回风险。该取舍记录在[批准方案的实施决定](MEMORY-RECALL-IMPROVEMENT-PLAN.md)，没有修改[冻结评分合同](../tests/retrieval-evaluation/ACCEPTANCE.md)来制造通过。

同 topic 的独立或矛盾来源仍可并列。无答案相近词噪声尚未消除。CLI 显式使用全文字符预算时会省略放不下的完整记录；自动注入则可以明确标记 partial，再按 ID 读取全文。原评分只计算初始完整注入，后续 full-read 不改写其分数。

语义候选已完成预声明参数选择和一次 holdout 配对测量，但没有新增修复，且原型峰值 RSS 约 900 MB。因此本版没有加入生产模型、模型下载或语义运行依赖。详见[词面评测](LEXICAL-RECALL-EVALUATION.md)、[语义实验](SEMANTIC-EXPERIMENT.md)和[原基线](RETRIEVAL-BASELINE.md)。

## 独立实际操作验收

以下操作由主执行者运行，全部使用独立 HOME、配置、数据库和合成材料。模型端是 localhost 的确定性 SSE provider，外部业务目标为 mock；没有付费模型请求、生产查询、真实部署或向用户记忆库写入测试记录。宿主控制和工具调用链经过真实 OpenCode、打包插件及 native binary。

证据位于开发工作区的 `.omo/evidence/memory-recall/`，属于本机验收产物，不进入发布包。文件名和命令用于复现和审查，不要求公开本地临时路径。

| 场景 | 实际入口 | 结果 | 证据 |
| --- | --- | --- | --- |
| 原生完整测试 | `cargo test --locked` | 全部测试组与 doctest 通过 | `rust-final-v060.log` |
| Node 合同测试 | `node scripts/test-node-contracts.mjs` | 953 通过、22 按平台或显式开关跳过、0 失败 | `node-final-v060.log` |
| SDK 对应宿主中的捕获与跨仓链 | `MEMOCAP_CAPTURE_E2E=1 MEMOCAP_CAPTURE_PACKAGED_HOST=1 node --test tests/opencode-capture.integration.test.cjs` | OpenCode 1.19.3，24 场景通过 | `capture-chain-final-v060-host1193-r2.json`、同名 `.log` |
| 本机宿主版本中的相同链路 | `MEMOCAP_CAPTURE_E2E=1 node --test tests/opencode-capture.integration.test.cjs` | OpenCode 1.19.5，24 场景通过 | `capture-chain-final-v060-host1195-r2.json`、同名 `.log` |
| 环境、冲突与全文读取 | `MEMOCAP_APPLICABILITY_E2E=1 node --test tests/opencode-applicability.integration.test.cjs` | 8 场景通过，错误环境执行为零，partial 先读全文 | `applicability-final-v060.json`、同名 `.log` |
| 已发布旧版托管安装升级 | `MEMOCAP_V050_UPGRADE_E2E=1 node --test tests/setup-v050-upgrade.integration.test.cjs` | 官方 v0.5.0 npm 包及 native binary 升级到当前 v0.6.0 包；数据、历史、非托管配置保留，重复同版本更新幂等 | `managed-upgrade-final-v060-r4.json`、同名 `.log` |

跨仓连续案例并非预先通过 CLI 填入记忆：先在项目 A 完成真实文档读取，自动捕获并独立核对新 ID；再创建独立项目 B，用 `Where can I start an alpha release?` 自动召回该 ID，经真实 `memocap_read` 读到完整正文及 beta 禁令。A 的内容未变，B 没有新增测试记忆或额外写入。

捕获场景还覆盖真实 permission denial、写入前取消、重复 idle、写入已开始后的独立读回、未知结果不重试、正文或标签读回不符、秘密筛除、无可存内容和同一知识跨请求去重。适用性案例验证当前权威来源先于 mock 操作，且 alpha 的精确权限拒绝仍阻止执行。

这些确定性模型案例证明给定决策下的宿主机制和边界，不能证明真实模型会普遍选对候选、拒绝全部秘密或判断所有环境。缺少证据时仍按 unknown 处理。

升级验收独立核对 schema、所有业务表和 FTS 内容、旧事件 JSON、账本、实际安装文件摘要、policy digest、托管授权和非托管 JSONC 内容。npm 可以复用已校验内容缓存，因此测试验证 registry metadata 请求与实际安装文件逐项摘要，而不把必须重新下载 tarball 当作正确性条件。

## 发布与本机交付合同

最终审查须覆盖完整源码、以上证据、批准目标及已披露的评分限制。发布 tag 必须指向最终合入 main 且 main push CI 成功的精确 SHA；仅使用现有 release workflow 生成三个平台的 binary 与 checksum，并以 registry job 的 metadata、integrity 和 provenance 验证作为 npm 发布验收。

正式发布后，按该精确版本的安装指南升级本机现有托管范围，先只读检查和 dry-run，再备份实际数据库并正式更新，独立读回 CLI、plugin、policy、manifest 及 schema/activity readiness。安装静态检查通过后报告 `runtime.status: not_run`；用户自行重启并确认后，再在新会话核对实际加载与 recall receipt。
