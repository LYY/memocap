# Respire 本地记忆设计与 memocap 对照

日期：2026-11-11
范围：对照当前本地 checkout 中的 memocap 与 Respire CLI、Pi 适配、通用技能。本文只做设计调查，不实施产品改动。

## 结论

Respire 文档描述了更丰富的本地语义与词面候选、校准和诊断机制；但排序及候选选择属于本次 checkout 未包含实现源码的 Core，文档也明确没有外部语料复现。因此，不能据此断言 Respire 的自然语言召回优于 memocap。

memocap 已有自动 recall、FTS5/BM25、可核验 receipts、基于相似性的重复候选准入策略与受确认的整理流程。当前证据支持先修复查询词提取和 CJK 词面查找，再用真实 paraphrase 与 negative 数据集决定是否增加语义候选、重排或反馈。

最具体的已知问题是：自动 recall 只保留前 12 个查询词；默认 FTS 索引没有中文分词策略；6000 字符注入预算可能裁掉记忆尾部，且结果不标明内容不完整。下文的两条合成探针仅能定位这些问题，不能代表总体召回质量。

## 范围与证据等级

检查日期为 2026-11-11。以下版本和检查时 clean 状态由本次调查中的只读 Git 查询记录；调查结束时 memocap 仅新增本文档。

| Checkout | 检查时 HEAD |
| --- | --- |
| memocap | `33e3f3f4c58d86a70a571e58eafaf3b763b942b9` |
| respire-cli | `c7a1bdc5ddd89dc8aa71aa4ea6c9f6a6851003e8` |
| respire-pi | `a516332512a31cbf0db7a1913ea8a0dbac6128a6` |
| respire-general | `8c99e78bb9184410cf519212c6c0225cdf01cfc6` |
| skills | `0e376a311f74b31ca9ac68cd953542db8ed55f23` |

本文区分三类证据：

1. **源码已核验**：本地可读的 CLI、插件和 SQLite 实现所能直接证明的行为。
2. **文档合同或 opaque Core 行为**：Respire 文档声称的行为，或 CLI 将请求交给 Core SDK、但当前检查无法独立核实的实现。
3. **合成诊断**：本次调查在独立临时数据库中验证的两条合成记忆，以及直接调用插件函数的查询和预算探针，不构成自然语言质量基准。

本次运行了 memocap 构建和相关测试。这些测试验证实现合同，不验证自然语言召回质量。没有运行 memocap 与 Respire 的对照质量 benchmark。

## 设计对照

| 维度 | memocap | Respire 可核验边界 |
| --- | --- | --- |
| 记忆准入 | 选择性保存持久约定、偏好与决定，按最窄范围放置。技能要求检查相似记忆，不能静默覆盖或合并。[准入与相似性策略](../skills/memocap/references/memory-policy.md#L7) | 通用技能要求答前翻忆、答后整理新事实；Pi 在正常请求结束后另启一个有界提取 worker。两者不是同一准入模型。[Respire skill](</Users/liuyuyu/program/github/risense-ai/respire-general/skills/respire/SKILL.md:11>) [Pi lifecycle](</Users/liuyuyu/program/github/risense-ai/respire-pi/lib/index.js:134>) |
| 自动召回 | OpenCode 插件提取词项，调用 CLI `recall --match any --limit 3`。[调用参数](../plugin/recall.js#L107) | Pi 把完整用户输入传给 `rsrs recall`，请求最多 5 个标题，正文按需另读。[Pi recall](</Users/liuyuyu/program/github/risense-ai/respire-pi/lib/index.js:157>) |
| 候选与排序 | SQLite FTS5 仅索引 `content` 与 `tags`，每个 placement 内按 BM25 排序，没有此路径上的语义向量通道。[FTS schema](../src/store/schema/baseline.rs#L62) [placement query](../src/store/visible/query.rs#L15) | 文档称本地语义、词面与其他信号参与 Core 排序；CLI 将候选、查询设置交给 `query_business`。最终候选打分属于 opaque Core，不能仅凭 CLI 源码复核。[Core ownership](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/retrieval.md:3>) [SDK call](</Users/liuyuyu/program/github/risense-ai/respire-cli/crates/commands/src/recall_select.rs:198>) |
| 范围与顺序 | repository、按序 attached domain、universal；先做 topic shadowing，再限条数和预算。多目标合并沿 target/source 顺序，不是全局相关度排序。[visible stack](../src/store/visible/shadow.rs#L15) [merge](../src/store/visible/recall.rs#L95) | CLI 提供已授权 catalog 给 Core；本次没有核验 Respire 的完整 scope 优先级合同。不可从召回分数推断授权或放宽目标。[authorized titles](</Users/liuyuyu/program/github/risense-ai/respire-cli/crates/commands/src/recall_select.rs:157>) |
| 上下文完整性 | 注入最多 3 条、最多 6000 JSON 字符；长正文可按字符预算截断，载荷没有 partial 标记。[reference block](../plugin/protocol.js#L70) | 可选 dynamic budget 合同报告选中表示与字符数；文档称 Core 选择完整 representation，标题/摘要默认不证明语义完整。该合同依赖匹配 Core。[budget contract](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/retrieval.md:30>) |
| 质量证据 | 本任务提供的测试结果覆盖实现合同；无对照 NL benchmark。 | 校准默认值被明确描述为初始值、不是质量保证；文档未声称复现外部语料。[calibration limits](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/recall-calibration.md:50>) |

## memocap 已核实机制与缺口

### 已有能力，不应重复造轮子

- 插件在用户消息上自动执行 recall，复用同一消息、targets 与 query 的短时缓存；成功的空结果也是可检查 receipt，不必无条件重复查询。[capture 与缓存](../plugin/recall.js#L115) [recall-first 策略](../skills/memocap/SKILL.md#L11)
- FTS5/BM25 已覆盖正文和 tags；支持 all/any 词项匹配。[索引](../src/store/schema/baseline.rs#L62) [FTS query](../src/store/visible/recall.rs#L158)
- receipts 会保留实际 target、searched placements、matched/returned IDs 和截断信息。记忆准入要求判断相似概念；显式 organization 支持经确认的 keep、refine、merge、delete，并对快照冲突回滚。[recall receipt](../src/operation/reads.rs#L60) [organization apply](../src/organization/apply.rs#L5)
- 这不是自动语义去重。记忆策略把跨允许范围的概念比较交给 agent，要求重复候选跳过或提出补充修订，禁止因相似度静默覆盖、合并。[相似性策略](../skills/memocap/references/memory-policy.md#L45)

### 已观察的召回与注入短板

`queryTerms` 只处理用户输入前 16000 个字符，以 Unicode 字母、数字和下划线的连续片段为词项；每项最多 64 code point，只保留前 12 个唯一词。[实现](../plugin/protocol.js#L56)

FTS5 表只声明 `content,tags`，没有显式 tokenizer、title 或向量列。默认 SQL 将查询按空白拆分后逐项加引号；连续 CJK 字符没有在插件层切词。[索引定义](../src/store/schema/baseline.rs#L62) [查询编译](../src/store/visible/recall.rs#L158)

返回结果先做可见性筛选，再 `truncate(limit)`，然后应用字符预算。多目标先按 target/source 顺序合并，保留同一记录的适用 targets，最后限条数和字符数。[单目标路径](../src/store/visible/recall.rs#L63) [多目标路径](../src/store/visible/recall.rs#L95)

注入只带前三条；大正文会缩短到 JSON 字符预算内，且输出仅有 `id`、placement、适用 repository 和 `content`，没有 `complete` 或 `truncated` 字段。[预算实现](../plugin/protocol.js#L81)

### 已验证的合成探针

检索探针只含两条合成记忆，未加 tags，不读取或修改真实用户数据库。它能复现代码路径上的局部现象，不支持总体质量或模型优劣结论。

复现环境记录：在 `/var/folders/x_/n5qr2_211jg2j9_7q_gdxw940000gn/T/opencode/memocap-retrieval-probe-6uDzGn` 隔离设置 `MEMOCAP_DB`、`MEMOCAP_HOME`、`MEMOCAP_DATA_DIR`，不设置 remote addr/url/token；用 `target/debug/memocap` 和 repository ID `repository:` 加 64 个小写 `a`。写入并读回 ID 1 `数据库变更必须保留用户数据`、ID 2 `Deployment requires a Windows smoke test`。CLI 查询形式为 `memocap --repository-id "$repo" recall '<查询>' --match any --limit 3 --max-chars 6000`，自动查询词来自 `queryTerms`。

以下是重建同类探针的命令骨架。每次使用新建的临时目录，避免重复写入上次的探针数据库：

```sh
probe="$(mktemp -d /var/folders/x_/n5qr2_211jg2j9_7q_gdxw940000gn/T/opencode/memocap-retrieval.XXXXXX)"
export MEMOCAP_DB="$probe/memocap.db" MEMOCAP_HOME="$probe/home" MEMOCAP_DATA_DIR="$probe/data"
unset MEMOCAP_ADDR MEMOCAP_URL MEMOCAP_ADDRESS MEMOCAP_TOKEN
repo="repository:$(printf '%064d' 0 | tr '0' 'a')"
target/debug/memocap --repository-id "$repo" remember -- '数据库变更必须保留用户数据'
target/debug/memocap --repository-id "$repo" remember -- 'Deployment requires a Windows smoke test'
target/debug/memocap --repository-id "$repo" list --placement "$repo" --limit 20 --offset 0
target/debug/memocap --repository-id "$repo" recall '数据库迁移有什么要求' --match any --limit 3 --max-chars 6000
```

表中其余查询复用最后一条命令替换 query；长 prompt 的词项输出按 [queryTerms 实现](../plugin/protocol.js#L56)复核。另一个预算探针直接调用 `referenceBlock`，不经 CLI。

| 查询 | 返回 ID | 观察 |
| --- | --- | --- |
| 原始中文正文 `数据库变更必须保留用户数据` | `[1]` | 原文命中 |
| `数据库` | `[]` | 短 CJK 子串未命中 |
| `数据库迁移有什么要求` | `[]` | 自然中文问法未命中 |
| `Deployment` | `[2]` | 英文锚点命中 |
| `release validation` | `[]` | 释义性英文词未命中 |
| `What validation is required before deployment?` | `[2]` | 此问法能命中正文锚点 |

查询 `please help me understand what we previously agreed about the process for Deployment` 被转成 `[please, help, me, understand, what, we, previously, agreed, about, the, process, for]`，`Deployment` 被第 12 词上限排除。这与 `queryTerms` 的源码规则一致。

另以 `referenceBlock` 直接输入一条正文：`A`.repeat(7000) + ` NEVER reset the database.`。记录正文共 7026 chars，最终 block 5999 chars，注入正文 5669 chars，`injected_ids` 为 `[1]`，结尾的限制句不在输出中，且无 partial 标记。它证明截断路径存在，不代表真实记忆正文的截断频率。

本次验证结果：`cargo build --locked` 通过；`cargo test --locked --test explicit_targets --test visible_stack_store --test store` 为 36 passed；`node --test tests/plugin-recall.test.cjs tests/plugin-reference-budget.test.cjs` 为 12 passed。测试验证实现，不验证 CJK、改写查询或误召回的用户体验。

## Respire 设计证据边界

### 源码可证与文档所述

CLI 明确声明检索、排序、特征准备与上下文选择由 Core 负责，CLI 负责用户设置、加密数据和本地索引 locator。[retrieval.md](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/retrieval.md:3>) CLI 构造查询、可选 provider 与设置后调用 opaque `query_business`，因此其代码不能证明 Core 内部实现细节。[recall_select.rs](</Users/liuyuyu/program/github/risense-ai/respire-cli/crates/commands/src/recall_select.rs:187>)

校准文档列出 M3 cosine floor 0.42、词面权重 0.30 等配置，同时明确称部分数值是初始值，不是验证过的质量保证。正文 embedding 文档描述为 title 加正文前 400 个 Unicode scalar；tags 仍作词面字段，full-body chunking 未变。[recall-calibration.md](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/recall-calibration.md:23>) [embedding input](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/recall-calibration.md:59>)

文档描述 fast 为本地路径，quality 才会把 query 和有限候选 titles 送往配置的 endpoint；selector 失败有 local fallback。不能把可选远端选择器误写成默认路径。[retrieval.md](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/retrieval.md:164>)

文档还称 pending index 保留 full-body lexical recall，后台会准备索引。这里的 Core 搜索与索引行为是文档合同，本次没有拿 Core 源码或真实库独立核实。[pending index](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/retrieval.md:194>)

CLI 的 how-to 路由会在普通结果外补充程序性记忆候选，合并去重后，必要时把最佳程序放入第三位；运行成功/失败仅提供有界的排序调整。这是可以源码核实的机制，固定提升位置是否适合 memocap 仍需评测。[how-to merge](</Users/liuyuyu/program/github/risense-ai/respire-cli/crates/commands/src/skill.rs:208>)

评测模块支持逐 query 的预期 ID、无答案负例、hit@1/3/k 和 MRR；负例仍返回结果会单独计为 noise。值得借鉴的是这套可回放测量方式，本次没有运行它或取得可对照的真实数据集。[benchmark](</Users/liuyuyu/program/github/risense-ai/respire-cli/crates/commands/src/bench.rs:21>)

Pi 适配器在正常输入时传入完整 prompt，最多请求 5 个标题，并将 recall 文本作为与用户消息分开的 request context。主回答结束后可启动 detached wrap-up。该 worker 有 4 轮、8 次 memory tool call、最多一次写入和 30 秒总预算；提取要求引用用户陈述或成功 tool result 的完整原句，并在写后读回。[input/recall](</Users/liuyuyu/program/github/risense-ai/respire-pi/lib/index.js:134>) [wrap-up bounds](</Users/liuyuyu/program/github/risense-ai/respire-pi/lib/wrap-up.js:3>) [evidence/write](</Users/liuyuyu/program/github/risense-ai/respire-pi/lib/wrap-up.js:57>)

通用 Respire skill/MCP 不提供逐轮 hooks；自动 recall/落库依赖各 host 的 extension namespace。Pi hook 不能当作所有客户端的通用行为。[respire-general README](</Users/liuyuyu/program/github/risense-ai/respire-general/README.md:14>)

Respire 的 `extract` 是独立、显式的多平台 session importer，不是 Pi wrap-up 的同一功能，也不等于当前默认自动导入。本文不建议批量导入会话或自动写入 transcript。[session import](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/session-import.md:28>)

### 尚未证明的部分

- `query_business` 的具体特征组合、排序权重、候选 overfetch 数量与跨信号融合依赖 Core SDK；CLI 类型和合同名不证明算法实现或质量。
- 文档称默认 M3，但没有证据证明它对 memocap 的用户数据、硬件或中文查询最优。安装、建索引、重建、运行延迟和资源开销都应在目标机器实测，不在本文虚构体积或延迟。
- 校准文档明确说没有复现外部 corpus。反馈实验默认关闭，原始 200-case/250-entry/40-mark 数据集未提供；文档要求 holdout、配对 hit@20/MRR、误惩罚、延迟与覆盖评估。[calibration](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/recall-calibration.md:79>) [feedback](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/explicit-feedback.md:3>) [missing dataset](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/explicit-feedback.md:56>)
- `HashingEmbedder` 明确是现有测试 provider，不能作为实际语义质量证据。[business.rs](</Users/liuyuyu/program/github/risense-ai/respire-cli/crates/core-sdk/src/business.rs:582>)

## 优先建议

以下均为建议，未在代码中实施。成本是相对 memocap 当前单机方案的粗略工程估计，不是 Respire 性能测量。

| 顺序 | 建议与成本 | 验收指标 |
| --- | --- | --- |
| P0 | **先建真实 query evaluation set。成本：中。** 从可复查且获准的既有任务中抽取去敏 query 与目标记忆 ID，纳入同义改写、中文口语问题、英中混问、路径/错误/版本精确锚点，以及无答案和近似负例。按 query family、目标 placement 和是否有 topic shadow 分层；固定训练/调参与 holdout。 | 每个版本保存 query、正确 IDs、实际 candidates/排名、空结果和配置快照。报告 hit@1/3、MRR@3、正例 miss、negative noise、分 query family 结果及本机 p50/p95 latency。阈值在看 holdout 结果前约定；不以合成两行或单一 aggregate 作为上线依据。 |
| P1 | **修正 query-term 编译与自然 CJK 词面查找。成本：中。** 先消除通用停用词占满前 12 位导致尾部实体丢失的问题；保留整句中稀有实体、路径、版本和错误锚点。另单独评估 CJK 词边界处理，避免只靠空格拆词或对任意文本做盲目字符切片。 | 复用 P0 的 CJK/混合语种/长问句/精确锚点和无答案分层。验收 `Deployment` 等后置锚点不再被常见前缀挤掉；有正确词面交集的中文自然问句能召回目标记忆；精确 ID、路径、版本不退化；无答案 noise 与 scope/shadow 结果无回归。 |
| P1 | **显式表示正文完整性，并保留按 ID 取得完整内容的能力。成本：低中。** 超预算时明确 partial 状态；长记忆可采用简短导航或摘要，再授权读取完整正文。短记忆继续提供完整内容，避免每轮增加无必要的读取。 | 用长内容、JSON 转义、Unicode 边界和尾部否定句测试。receipt 继续说明已注入 ID；超长内容必须明确 partial，并能取得完整原文。不得超 budget，不得把 partial 状态丢失在缓存或呈现中。 |
| P2 | **评估本地 semantic candidate channel，同时保留 lexical exact-anchor。成本：中高。** 仅在 P0/P1 显示 paraphrase 缺口后做小型隔离试验。把语义结果视为额外候选，而非替代精确词项；先测所选模型的下载、索引构建/重建、磁盘与内存占用、查询延迟和离线可用性，再选型。BGE-M3 可以作为待测选项，不是结论。 | 对同一冻结数据做词面 baseline 与语义+词面配对报告：分 family 的 hit@3/MRR、negative noise、exact-anchor recall、p95 latency、实际安装和 rebuild 操作成本。只有 holdout 有收益且精确锚点、负例及本地运行预算满足事先设定的门槛才继续。 |
| P3 | **再评估授权范围内的候选 overfetch 与最终 top 3 排序。成本：中高，行为变更。** 在已授权 target 内对各 retrieval channel 取候选，先按每个 repository 执行 topic shadow，再融合与裁剪。保留 repository/domain/universal 可见性、domain 间不互相 shadow、同 topic 的高层 authority，以及跨 target applicability。当前 source/target 次序是有意行为，不应静默改成全局分数排序。 | 用成对 cases 对比旧顺序与新排序的 hit@3、MRR、noise、各 placement 命中率。增加 repository 覆盖 domain/universal、domain 覆盖 universal、多 target 同一记忆及 domain 互不 shadow 的固定回归用例。任何未授权 target 的 candidate 必须为零。 |
| P4 | **标题/程序路由按需试验。成本：低中。** 可先对新记忆推导或试验检索用 title，不要求给旧记忆批量手工改名或重写正文。若 P0 表明 how-to 类问题仍有明显缺口，再单独测试程序候选通道，限制其排序影响并保留事实结果。 | 新增 title 后比较原 query 集的召回与正文保持率；程序通道需报告 how-to family MRR/top 3 变化及事实问题误提升数。没有 holdout 收益就不增加长期路由复杂度。 |
| P5 | **反馈晚于基础检索，且只做 query-specific。成本：中高。** memocap 已有 query-specific recall receipt 和活动记录；这不等于存在用户质量标注或可用于排序的反馈。先确认用户愿意提供可归因的候选评价，再决定是否引入。不要加情绪权重、全局正负计数或固定 boost。 | 每条标注绑定本次 query、target、candidate ID 和来源；相近但语义相反的 query 必须检验错误传播。使用时间或 query-family holdout，报告 paired MRR/hit@3、false penalty、negative noise 与延迟。默认关闭，未达到预设门槛不影响排序。 |

## 明确不建议

- 不要把 `limit 3` 改成更大的常数当作召回修复；先找出候选为何未命中，以及增加结果是否会扩大误召回。
- 不要以 Respire 的 M3 默认或 Core 合同名作为 memocap 选型依据，也不要假设 BGE-M3 自动等于 dense、sparse 和 ColBERT 三种已验证通道。
- 不要把所有对话或历史 session 批量写成长期记忆。Respire 的 session import 本身也要求后续整理；memocap 的既定边界是选择性保存持久且可复用的知识。[memocap admission](../skills/memocap/references/memory-policy.md#L7) [Respire import](</Users/liuyuyu/program/github/risense-ai/respire-cli/docs/session-import.md:49>)
- 不要要求用户为所有旧记忆手工补 title；先做可撤销的派生/索引原型并用 benchmark 证明收益。
- 不要把 Respire CLI/Core 当作可移植实现代码。CLI license 限非商业用途，且明确不授权 Core 实现；本报告仅比较可见机制和文档合同。[license](</Users/liuyuyu/program/github/risense-ai/respire-cli/LICENSE:5>)

## 最终判断

memocap 目前的优势是简单、显式、范围可检查，且已有 receipt、scope/topic shadow 与组织流程；短板是词面路径对用户自然改写不够宽容，并且输入和输出两端都可能静默丢掉有用信息。Respire 展示了值得测试的本地语义与候选选择方向，但公开证据不足以证明其排序质量优于 memocap。

建议先以真实 query/negative 数据建立基线，第一批修词项与 CJK 召回、正文完整性；随后验证本地语义候选、评估受控 overfetch，最后考虑程序路由和可选反馈。每一步都保留精确 scope、显式授权、topic shadow 与否定语义；超过当前行为的重排须作为单独产品决策评估。
