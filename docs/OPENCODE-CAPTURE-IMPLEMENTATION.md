# OpenCode Automatic Capture

生产插件现在在当前真实用户回合正常完成后启动一次有界 review。实现位于
`plugin/capture/`；现有 `operations.freezeCapture`、bridge 版本握手和独立精确
readback 保持原有行为。本文描述 v0.6.0 实现；发布、本机安装和重启后的生效状态分别由交付记录确认。

## 生命周期与写入边界

- 只认 `chat.message` 本次观察到的真实用户输入，不扫描历史回合补写。
- 只由 `session.status` 的 idle 启动。同步认领回合后才执行异步 SDK 请求；
  deprecated `session.idle` 不启动或取消任何工作。
- 检查最新 user ID、最后 assistant 的 `parentID`、`time.completed`、`finish:stop`，
  拒绝 assistant error、失败工具和未完成工具。
- 写前任意后续同 parent 的 status idle 都产生 `ambiguous_idle`，包括无害重复。
  这是有意的保守取舍，不是对 abort 身份的推断，也不会重试该回合。
- 新真实输入、busy/retry、error、deleted、worker error/abort、超时使旧 review 失效，
  并请求真实 SDK abort 子会话。已开始实际写入后保留独立 readback，等待真实工具
  callback 完成，不能把 prompt 查询返回当作写入或取消已经原子完成的证明。
- 在所有异步准备和 CLI version handshake 后，现有 bridge 的同步 `beforeSpawn`
  再检查 parent generation，并一次性转入 writing。失效时没有 remember 命令 spawn。
- parent 状态和结果各保留最多 128 项，worker 注册表最多 256 项。完成的 worker
  保留有界 tombstone，阻止迟到 generation/tool 重新进入普通工具路径；会话删除和
  dispose 会清理状态，所有启动的 review/abort Promise 均被追踪。

提取与提交使用两个新 child。两者使用同一 parent agent/model，创建时显式复制
parent permission。提取通过实际 `client.tool.ids()` 发现工具，用实际
`client.session.prompt` 把每个 ID 设置为 false。提交创建另一个 child，保留 parent
规则，仅追加其他实际工具 ID 的 deny，不添加 remember allow，也不传 `prompt.tools`。

提交 child 的模型只能请求一个候选。真实 `memocap_remember.execute` callback 内
绑定 child ID、当前 running tool part 的 message/call ID、完整候选及单一 parent
选择的 repository。内部显式复制 parent targets，不能从模型、cwd 或路径推断来源。
没有 parent 已选择的单一来源时跳过。模型选择其他正文、topic、目标或非空 tags
都会消耗唯一尝试并被拒绝；后续请求得到 blocked receipt。

只有这个真实 callback 才构造 `operations.freezeCapture(actualToolContext, ...)`。
native `context.ask` 前后均重新读取当前 agent permission 与 parent permission，
避免宿主历史批准缓存覆盖新 deny。每次写入仍经过真正的 native ask 和工具 dispatcher。
一个 review 最多有三次实际 `chat.params` dispatch，包括工具后的正常总结；第四次在
hook 内生成前拒绝。非绑定工具在 `tool.execute.before` 拒绝。最多一次原生命令写入。

saved 必须来自独立 readback 的 status ok，且 ID、placement、完整正文及 host fingerprint tag
都与冻结请求相同。tag 不符的 capture readback 明确失败，结果为 unknown。
写入开始后失败、receipt 丢失或无 ID 是 unknown，不重放。

## 证据准入与限制

模型只返回 `admitCandidate` 接受的严格 JSON 提案，不能生成正文或 placement。
正文由完整 host unit 和 host source pointer 构造。quote 必须逐字等于完整 unit，
不会截断或拆掉条件、否定或适用环境。预算为最多 2 个引用 unit、合计 800 Unicode
code points，最终正文最多 1200；提取最多提供 12 个完整 unit，超大 unit 跳过。
输出 JSON 最多 16000 UTF-16 code units，单次生成最多 1024 tokens。

`eligibility` 是有限的 host policy assessment，不是模型给出的真值：

- 真实用户的完整小消息可供已有提取模型判断价值，无需以 For future 或偏好词开头。
  host 不把词语匹配当作长期价值的证明；临时任务、引述 assistant 和不确定结论由提取
  policy 选择空候选。单条超预算消息跳过，不从中截取一句话冒充完整来源。
- 工具证据只接受成功完成的真实 `read` 对 docs Markdown 或 README 的简短路由读取。
  长文档按完整 Markdown 小节划分，保留祖先标题及其全部直属上下文，保留同节后面的
  条件、禁止项及环境限定。完整 unit 至多 800 code points；超大、未闭合或无法完整
  保留上下文的小节跳过。编号步骤或 fenced code 在候选 unit 内判为 runbook；另一个
  小节中的代码不会否决完整短 route。不解析任意语义依赖，跨节条件不确定时模型应跳过。
- 实际 OpenCode read 的包装只在 EOF 总行数及从 1 开始的连续行号完整匹配时解包。
  offset/截断读取不会被当作完整文档；用户正文中的 Source 行不会被剥离。
- assistant-only、普通 shell exit status、未验证业务成功、其他工具来源均不准入。
  provider、环境和 repository 的名字不形成默认映射。
- admission 的 secret screen 在发送提取请求前逐 unit 检查并移除含凭据形状的 unit，
  最终准入再次检查。独立干净小节仍可供判断，secret 不送进提取请求；状态只含静态 reason。

这些结构规则验证来源、完整引用和预算，不能证明自然语言事实真实、理解意图或衡量
AI 质量。提取模型可能误判价值或意图；测试中的 no-durable/quoted-assistant 空候选仅
验证给定 policy 决策的宿主行为，不是自然语言精度结果。成功读取只证明来源可用，
不证明任意业务结论。文档已有入口不自动拒绝短 route；没有新增 SDK durable 字段。

host knowledge key 将完整 substantive units 仅规范 CRLF 和外侧空白，去重排序后连同
精确 placement 计算 SHA256。正文保留原文及 host 生成的长度/来源 footer，另存固定
前缀 `memocap-capture-<sha256>` tag。只有 host footer 的 per-turn 来源不参与 key；
用户自己写的 Source 行及条件仍参与比较。没有旧格式兼容解析或用户文本清洗。

重复预检重新检查已有显式 library read grant，用稳定 fingerprint 查询授权 library
（现有 recall 上限 3）。每个命中，包括 partial hit，都经过授权的精确 ID 完整读取，
比较实际 placement、tag 和 canonical 原始知识。查询或完整读取失败则不写入。
同一 runtime 最多保留 128 个 in-flight key，同 key 并发 review 跳过，完成即释放。
不同 turn/source call ID 的同 placement 精确知识只保存一次；不同条件或 placement
不合并。不承诺任意语义等价、跨来源去重或多进程锁；没有 topic、force、overwrite、merge。

## 可观察结果与 Rust 集成边界

`/memory status` 和 `/memory why` 的 `capture` 字段提供 status、静态 reason、
实际模型/工具调用数、write attempts、user/child/memory/operation IDs，不含候选正文。
并发旧 review 不会覆盖较新 generation 的结果。

生产端发送单个 UUID activity operation，关联已知 native write operation，使用现有
event context 和 receipt wrapper。wire detail 为：

```json
{"phase":"capture_review","metadata":{"status":"saved","reason":"saved_verified","memory_ids":[1],"model_calls":3,"tool_calls":1,"write_attempts":1}}
```

同工作区的 native build 已支持该 payload。当前实际宿主证据包含独立 `activity show`
比对的 `persisted:true`。若 native 记录失败，插件仍明确返回
`capture.activity_warning:activity_failed`，不会隐藏失败、改写 phase 或重试写入。

## 运行证据

`tests/opencode-capture.integration.test.cjs` 在实际 OpenCode **1.19.5**，SDK/plugin
**1.19.3** 上运行生产插件；provider 为既有 localhost SSE wire fixture。
早期开发构建的原始运行证据：`tests/opencode-capture/evidence-1.19.5.json`。该记录中的
native 仍使用开发期间的 0.5.0 包标识，不代表已发布 v0.5.0 支持捕获。最终 v0.6.0
构建的独立验收与发布状态由交付记录确认。

场景包含正常 stop 与 deprecated duplicate、不改变 parent deny 的双 child、status/why、
版本握手挂起期间真实 parent abort（等待插件观察到第二次 status idle 才释放）、受控
同型 idle replay、新真实输入、native ask reject、no durable、secret、unsupported source、
空候选、两个真实 turn 的稳定精确重复、长文档实际 read 的短完整 route、重复命中完整
读取失败零写入、fingerprint tag 读回不符、候选篡改、第二工具/三调用预算、写后 parent/child abort
仍完成 readback、实际写入但无 receipt ID 的 unknown 不重放，以及真实 parent model error。
其中同型 idle replay、完整读取失败、tag 不符和丢失 receipt 是明确标注的受控注入；abort、permission dispatcher、
工具、CLI spawn 和数据库读写均经过真实宿主边界。

probe 执行工作区当前 native，并记录或延迟隔离 sandbox 的 native launcher；上述 read
和 receipt 故障由 probe 在真实 native 执行后受控注入。
没有使用不带 Read 的旧 0.5.0 不可变副本。重复场景由真实两次用户输入及原生 capture
保存驱动，没有 CLI 写入旁路。HOME/XDG、OpenCode 和 memory DB、项目、端口及 package
均隔离，结束验证 host/provider 端口关闭、sandbox 删除、active children 为零。付费
provider 请求为零，没有读取用户 auth 或 live data，也不声称 AI 质量或系统级网络隔离。

```sh
node --test tests/plugin-*.test.cjs tests/capture-*.test.cjs
MEMOCAP_CAPTURE_E2E=1 \
MEMOCAP_CAPTURE_EVIDENCE=tests/opencode-capture/evidence-1.19.5.json \
node --test tests/opencode-capture.integration.test.cjs
```

native 必须已经从同一工作区当前源码构建，保持 package 的当前 0.6.0 handshake。
默认测试集跳过耗时真实宿主测试；没有新增依赖、setup、schema、release 或冻结 fixture 变更。
