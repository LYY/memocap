# 自动捕获与使用后维护

> 本指南描述 memocap v0.7.1 的自动捕获与使用后维护行为。实际运行行为以相互匹配的 v0.7.1 CLI、OpenCode 插件和配套 `policy` 为前提；本文不表示这些组件已经发布或安装，也不保证模型的自然语言判断普遍正确。

本指南补充 [README 的自动捕获说明](../README.md#L198)。现有 [OpenCode 捕获实现说明](./OPENCODE-CAPTURE-IMPLEMENTATION.md#L1)记录 v0.6.0 的历史行为；本指南描述 v0.7.1。

## 自动捕获

正常完成的真实用户回合后，插件可能进行一次有界审查，最多保存一条简短记忆；无需每回合说“记住”，也不保证每回合都写入。插件只处理运行时实际观察到的回合，不在启动时导入旧历史，也不后台扫描文件或网络来源。[README](../README.md#L200) [观察缓冲](../plugin/capture/observed.js#L67)

证据来自当前真实用户文字，以及该回合实际观察到的 `read`、`bash` 工具结果，包括明确失败的结果。失败证据只能支持该失败；后续独立观察可以支持修复后的结果。`read` 必须是完整文件输出，行号从 1 连续到 EOF，显示的正文与工具输出相符；偏移读取、截断或包装不匹配会被拒绝。Markdown 可按完整小节和上下文打包，代码、配置、脚本等非 Markdown 文件不会按语义切段，过长时可能整包省略。[来源适配](../plugin/capture/sources.js#L9) [完整 read 检查](../plugin/capture/sources/read.js#L3) [小节打包](../plugin/capture/sources/sections.js#L42) [选择排序与预算](../plugin/capture/sources/selection.js#L5)

命令证据保存实际命令、完整输出、工具状态和退出码；API 响应只有在本回合受支持的真实工具观察中出现时才可能成为证据，插件不会另行发起通用 API 或网络读取。退出码 0 只说明进程以 0 退出，HTTP 200 只说明观察到该响应，assistant 的完成陈述也不是独立验证。若业务结果重要，应在正常任务中取得相称的独立结果观察。成功读取只说明当时读到了内容，不证明业务成功或来源现在仍然有效。[命令结果字段](../plugin/capture/sources.js#L41) [提取与支持规则](../plugin/capture/extraction.js#L5)

模型不能挑写入位置或直接提供最终正文。宿主只接受可逐字回溯到来源的引用，最多四条原子陈述、两个引用单元、合计 800 个 Unicode code points，正文最多 1200 个 code points。宿主会按引用 provenance 开销提供可用正文容量提示，并检查含 provenance 的最终序列化正文是否超限；超限就拒绝整条候选，不截短已通过引用核验的陈述。提示要求必要条件放不下时不提案，不得静默省略；这是模型要求，不是程序对语义完整性的证明。支持审查必须逐条通过。对 runbook，记忆应总结入口、前提、验证方式和限制，指向来源，不复制整份步骤或文件。使用前仍需按当前任务权限核对现行权威资料。[准入](../plugin/capture/admission.js#L25) [提取策略与容量规则](../plugin/capture/extraction.js#L5) [最终正文上限](../plugin/capture/contract.js#L14) [provenance 序列化](../plugin/capture/identity.js#L17)

来源指针记录观察时的 locator、时间及所观察文本的 hash。它是“上次看到这里”，不是来源新鲜度证明，也不授予读取文件、访问网络或绕过权限的能力；路径可能消失，内容也可能改变。缺失、404、超时、离线、拒绝访问、时间久远或整份来源 hash 改变，单独看都不构成自动删除依据。保留仍有用的历史事实和独特条件；依赖当前环境操作前，由 agent 在正常任务中按当前权限重新验证权威来源。维护 worker 不补充文件或网络读取，也不后台扫描；读回只证明记忆存储状态，不证明来源新鲜度。[指针构造](../plugin/capture/sources.js#L59) [维护证据判定](../plugin/maintenance/assessment.js#L4) [维护判断规则](../plugin/maintenance/reviewer.js#L9)

秘密筛查识别若干常见凭据格式和模式，不是通用秘密检测器。未被模式命中的敏感信息仍可能存在；不要把捕获视为脱敏边界，也不要主动把凭据写入对话、文件或命令输出。[筛查模式](../plugin/capture/screen.js#L1)

OpenCode 插件入口省略相应选项时，捕获和维护的执行窗口默认分别为 60 秒和 60 秒。维护先运行，捕获窗口在维护协调结束后启动；两个阶段各自只启动一次窗口，阶段内 generation 共用窗口且不续期。每阶段最多三次 generation、两个 child；捕获最多一次原生写入尝试，维护最多一个 atomic group。两阶段串行执行窗口合计 120 秒，不含终态收集、读回和清理。每次 provider 请求最长 30 秒，默认观察证据 TTL 为 120 秒。入口支持分别设置 30、45 或 60 秒的捕获与维护窗口，覆盖一项不会改变另一项默认值。直接省略低层 `captureExecutionProfile` helper 的参数仍使用历史 30/30 秒基线，不是插件入口默认值。来源选择 profile 的数值是实现上限。正文和引用另受上述 code point 上限约束。[插件入口](../plugin/cli.js#L11) [执行 profile 与低层默认值](../plugin/capture/execution-profile.js#L1) [捕获计时](../plugin/capture/execution.js#L5) [调用与写入限制](../plugin/capture/binding.js#L6) [观察证据 TTL](../plugin/capture/observed.js#L6) [维护窗口与阶段预算](../plugin/maintenance/scheduler.js#L12) [来源预算](../plugin/capture/sources/profile.js#L3)

自动捕获的重复预检只按精确 placement 和规范化后的实质陈述识别相同知识，不是语义等价判断；来源相同不代表内容相同。它不完成独立跟踪的 #24 语义去重，也不做跨 placement 合并。[精确身份](../plugin/capture/identity.js#L3) [完整读取后的预检](../plugin/capture/duplicates.js#L5)

## 使用后维护

这是针对本任务已声明采用记录的自动复核，不是全库整理；全库组织只在用户明确请求时走独立流程，详见 [memory organization guide](../skills/memocap/references/memory-organization.md)。

维护只复核本任务中 agent 明确声明采用的记忆，不把“出现在 recall 结果里”当作已使用。先用真实 `memocap_read` 按精确 `id` 和 `placement` 读取全文；仅当读取成功、记录未改变、backend 为 local 且正文完整时，工具结果才会附上 `maintenance_read`，其中包含 `receipt_id`、`id`、`placement` 和完整正文的 `content_hash`。[工具参数](../plugin/tools.js#L63) [完整读取凭据](../plugin/maintenance/runtime.js#L36) [凭据构造](../plugin/maintenance/usage.js#L19)

随后 `memocap_maintain` 的 `operation: "use"` 必须提供这次读取的 `receipt_id`、相同 `id`、精确 `placement`、相同 `content_hash`，以及 `statements`。每项必须是正文中恰好出现一次的原文引用；最多 8 项，合计最多 800 个 code points。凭据绑定同一任务，只能使用一次，最多声明三条记录。这个声明绑定到实际完整读取，但不证明 agent 心理上依赖了该内容；单纯 recall 可见性也不是采用声明。[use 参数](../plugin/maintenance/tool.js#L5) [精确引用校验](../plugin/maintenance/usage.js#L7) [单任务使用限制](../plugin/maintenance/runtime.js#L51)

审查只看上述采用记录和当前任务实际观察到的用户文字、完整 `read` 或 `bash` 结果；不会为补证启动外部读取。模型审查 child 的工具关闭。复核可判断 `keep`、`unknown`、`update`、`merge` 或 `delete`；观察到的失败只支持该失败，不能据此声称业务成功；后续独立验证可支持修复结果。缺失、404、超时、离线、拒绝访问、时间久远或来源 hash 改变，单独看都不能支持删除。删除要求直接退役证据，且不得遗留独特事实。更新与合并必须保留仍成立的条件、环境和独特信息；这是带引用的模型判断，不是程序能够证明的自然语言真实性。[当前任务证据](../plugin/maintenance/tasks.js#L27) [审查工具边界与规则](../plugin/maintenance/reviewer.js#L9) [结构及证据约束](../plugin/maintenance/assessment.js#L14)

维护决策和跨轮延续中的模型引用只提供 `source_id` 和原文 `quote`。插件核对完整观察的 SHA-256，在原文中唯一定位引文，并生成绑定哈希和 Unicode code point 位置的规范引用。这个规则不改变 `memocap_maintain` 的 `use` 参数或写入授权。[模型引用解析](../plugin/maintenance/quote.js#L10)

同一 parent 的维护证据 frame 只在内存中有界保留：最多 5 分钟、每 frame 不超过 12 条 evidence、64 个 parent、总量最多 1 MiB；累计到第四个 review turn 后不再保存下一 frame。延续还必须匹配同一 goal、object、environment 和冻结 origin，并同时引用当前与先前的完整观察。新真实用户输入会取消旧的 pre-write review 和 worker；只有已完成、仍在界内的证据可能由下一轮重新审查，旧候选或旧 writer 不会复活。[frame 边界](../plugin/maintenance/continuity.js#L15) [连续性要求](../plugin/maintenance/continuity.js#L4) [新输入失效](../plugin/maintenance/tasks.js#L11) [捕获 generation 失效](../plugin/capture/lifecycle.js#L7)

## 持续授权与提交

`memocap_maintain` 只有 `use` 和 `apply` 两种 operation，没有 `propose`。`use` 的完整字段为 `operation`、`receipt_id`、`id`、`placement`、`content_hash`、`statements`。`apply` 只接受 `operation` 与 `proposal_id`。宿主审查可显示短时提案及所需权限 pattern；普通 parent agent/session 不能自行提交提案。`apply` 只接受宿主为当前任务绑定、尚未消费的 commit child 中那一次精确工具调用和提案 ID。没有公共 CLI grant setter，也不会自动安装维护 grant。[工具 schema](../plugin/maintenance/tool.js#L3) [提案生成与过期时间](../plugin/maintenance/reviewer.js#L131) [apply 绑定校验](../plugin/maintenance/executor.js#L21)

持续授权必须是 host 配置中 `permission.memocap_maintain` 对象里的精确 pattern-to-action 映射，值为 `allow`：

```json
{
  "permission": {
    "memocap_maintain": {
      "v1/db:<数据库路径 UTF-8 的 base64url>/placement:<placement UTF-8 的 base64url>/op:update/id:7": "allow",
      "v1/db:<数据库路径 UTF-8 的 base64url>/placement:<placement UTF-8 的 base64url>/op:merge/id:*": "allow"
    }
  }
}
```

Base64url 只是编码，不是加密。pattern 必须以 `/id:N` 或 `/id:*` 结尾，每个 pattern 只有一段 `id:`；实现只把精确 ID 或同一数据库、placement、operation 前缀下的 `id:*` 视为持续 grant，merge 的每个参与记录都必须有匹配 grant。裸 `memocap_maintain: allow`、读取权限或组织工具权限都不代替此 grant。组织工具的 `confirmed: true` 仅用于用户明确请求的组织操作，也不能模拟维护授权。config、parent、agent、session 任一层的有效 deny 都是终态；具备持续 grant 后，提交仍要经过 native `context.ask`，并在 ask 前后重新读取权限和核对 fingerprint。拒绝或权限变化时不换工具、不换目标、不扩大范围。[pattern 生成](../plugin/maintenance/permission-target.js#L22) [持续 grant 与 deny 判定](../plugin/maintenance/permission.js#L11) [原生 ask 与二次检查](../plugin/maintenance/executor.js#L38)

通过支持审查后，宿主最多提交一个原子组。update 保留原记录 ID；merge 只能在同一 placement 内进行，且参与记录和依赖的 snapshot 必须在即时事务中仍完全匹配。冲突会拒绝旧提案；事务提交后会读回结果。实现保证同 placement、snapshot CAS 和单事务合并，不保证模型一定保留了每项独特语义信息。[同 placement 校验](../src/organization/request.rs#L97) [即时事务、snapshot 与合并](../src/organization/apply.rs#L5) [维护组限制](../src/organization/maintenance.rs#L12)

若写入已 dispatch 而 receipt 或读回不确定，状态是 `unknown`，先以安全读操作查明当前记录，绝不重放写入。原生写入成功但 activity 记录失败时，读回仍可得到 `committed` 并附 `maintenance_activity_failed` warning，这也不能重放。`/memory status` 与 `/memory why` 可查看 capture、maintenance 状态、原因、调用/尝试计数和相关 ID；maintenance 的 proposal 状态可能带有待审内容，capture 状态不暴露候选正文。[读回与不重放](../plugin/maintenance/backend.js#L23) [状态查询](../plugin/operations.js#L175) [capture 状态字段](../plugin/capture/review.js#L4)

## 验证边界

当宿主校验通过时，它能证明的范围仅包括来源绑定、引用 hash/span、权限、snapshot CAS 和事务读回等机械边界符合实现约束。这些校验不证明模型的自然语言判断普遍正确、记忆没有遗漏必要语义或适用于所有任务，也不表示发布、安装或模型质量验收已经完成。
