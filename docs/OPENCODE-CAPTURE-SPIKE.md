# OpenCode Capture Spike

2026-11-11：已跑通真实宿主的最小 adapter 边界：正常完成事件 -> 当前用户 message ID -> 独立 child session 的无工具提取；另外通过 child session 的真实 `memocap_remember` 工具验证权限和独立读回。后续实验已确认 idle parent abort 的信号歧义，以及新输入可观察的 user ID/epoch 变化。**这不是完整自动捕获验收；取消与提交竞争仍是生产实现的前置 gate。**

## 实测证据

| 宿主 | SDK / plugin | 结果 | 模型请求 | 运行时间 |
| --- | --- | --- | --- | --- |
| npm 官方 OpenCode 1.19.3 | 1.19.3 / 1.19.3 | PASS | 6 | 30.20 s |
| 本机 `/opt/homebrew/bin/opencode` 1.19.5 | 1.19.3 / 1.19.3 | PASS | 6 | 27.85 s |

每次运行：主请求 1 次、child 提取 1 次、allow 写入与工具后续回复 2 次、deny 与工具后续回复 2 次。每个写入场景只发出一个 `memocap_remember` tool call。付费 provider 请求均为 0。宿主配置只启用 localhost `wire/wire-model`；模型输出来自确定性 HTTP SSE fixture。npm 下载是依赖引导，不是模型调用。本次没有声称 macOS 网络命名空间阻断了所有外连。

保留的原始证据：[1.19.3](../tests/opencode-capture-spike/evidence-1.19.3.json)、[1.19.5](../tests/opencode-capture-spike/evidence-1.19.5.json)。`actual_version` 是被测宿主版本；复用 fixture 的 `host.version` 记录的是引导安装的固定版本 1.19.3，不能用它判断第二次运行的版本。

两次均确认 host/provider 监听端口关闭，隔离 package sandbox 删除，active children 为 0。HOME、XDG config/cache/data/state、OpenCode 数据库、memocap 数据库和项目均由 fixture 单独创建；未读取用户 auth、数据库或会话，未重启用户宿主。测试使用指定的不可变 v0.5.0 native，与当前仍为 0.5.0 的 package 配合，不依赖正在并行修改的 `target/debug/memocap`。

## 已验证的合同

1. 宿主会发出 `session.status` idle 与 deprecated `session.idle` 两个通知。它们不携带 user turn ID。observer 用宿主提供的 root `client.session.messages({path:{id}})` 取得最新 user 和最后 assistant，确认 `assistant.parentID === user.id`、`time.completed`、`finish === 'stop'` 且无 `error`。实际主回复 ID 与这次提取绑定的 assistant/user ID 一致。
2. 两种 idle 通知实际只创建一个 worker。observer 在第一个异步创建前认领 user ID，并在 prompt 前把 child ID 加入排除集合。日志包含 `duplicate.excluded` 和两个 `worker.excluded`；总请求数为 2 时，child 已返回候选且没有递归 worker。所有 child session 都排除捕获，是本 spike 的保守边界。
3. `client.session.create({body:{parentID,title,permission}})` 在 root v1 SDK 1.19.3 上确实转发 `permission` 并由宿主保存，即使该 SDK 的 v1 类型声明不含此字段。worker 显式复制从 parent 读取的 permission；GET child 确认规则一致。不能把 parentID 当作权限继承合同。本轮没有另做省略 permission 的对照测试。
4. 从真实宿主 `/experimental/tool/ids` 发现所有工具，提取请求逐项设置 `tools[id] = false`。实际 provider 请求 `tools` 为空，单次返回 JSON 文本。没有使用未验证的 structured-output schema、`session.chat` 或 `wait` API。候选 JSON 的正文是合成 fixture 数据；断言验证结构和结果，不锁定提示语。
5. **`prompt.tools` 会改写 session permission。** 初次真实实验使用 `memocap_remember:true` 时，预先创建的 deny 被覆盖，工具实际写入了隔离库。因此写入阶段绝不能用 `tools:true` 当作只控制工具可见性的选项。最终通过的写入测试不传 `tools`，用 session permission 保留权限规则。提取 child 与写入 child 必须分开，或在明确重建并核对 permission 后再使用；不能直接在无工具提取 child 上开启工具写入。
6. 写入走真实模型 tool call -> 宿主 plugin tool dispatcher -> 现有 `plugin/tools.js` 的 `memocap_remember.execute(args, context)` -> 原生 `context.ask`。未构造 ToolContext，未替换 `ask`，未通过 CLI 写入。allow 返回 `inserted`，现有工具的 readback 为 `ok`，测试再通过独立 CLI `list` 比对 ID、placement 和完整正文。
7. denial 用 `memocap_remember/*:allow` 加目标 repository ID 的更具体 `deny` 规则。这样工具仍可进入真实 dispatcher，而内部 `context.ask` 必须按实际 target 规则拒绝。返回 `status:denied`，独立 CLI `list` 找不到该合成正文；没有重试、切 shell 或其他写入旁路。模型后续回复仍正常完成。拒绝是工具 receipt 的终态，不等于整个 assistant 请求报错。
8. hook 的异步任务由 observer 自行追踪并处理失败，不能依赖宿主等待 `Hooks.event`。本测试通过 localhost telemetry 等待明确的 worker completion，不以固定 sleep 代替完成信号。此控制服务只用于测试，不是生产接口。

## 可交给生产实现的边界

提取 adapter 可以接收 `(parentSessionID, currentUserMessageID)`，读取并冻结该 turn 的证据与模型/agent，创建显式复制权限的 child，注册排除后用逐项 false 的工具清单发起一次 prompt，解析有界 JSON 文本。idle 只是检查信号，user message ID 才是去重键。

宿主权限可用于提交，但需要真正经过宿主注册工具的调用路径。已证明原生 `memocap_remember` 的 allow/deny/readback 可用；本 spike 没有证明存在公共的“直接执行工具” SDK API。若生产采用独立提交 child，需要保持原权限，不能通过 `tools:true` 覆盖 deny。模型的 tool call 参数仍属不可信输入：生产还需要一个绑定已准入候选、目标和当前 generation 的 host-owned commit 工具或等价受控路径，不能仅凭模型复述正文决定写入。本 spike 没有实现或验收这个提交工具。

## 尚未通过的 gate

- active parent abort、tool continuation、提取请求已经发出后的取消。下文的无效模型负向测试仅覆盖一个真实 error 场景。
- 新输入的 ID/epoch 变化已观察到，但生产提交前的过期候选拒绝尚未实现或验收。idle parent abort 只能观察到普通 idle 通知，缺少可唯一识别的取消信号；不能把该合同标为通过。
- 写入已开始后发生取消的 readback、未知结果不重放、生产总请求/工具预算，以及候选 grounding/admission。

因此，本轮完成“先取得一个小而真实的宿主实验”的交付，不把整个改进计划阶段 1 标为通过。无需改共享 fixture 或生产文件就能复现实验；生产 capture 仍须补齐上列 gate。

## Idle Abort 与新输入观察补充

[独立 observation test](../tests/opencode-capture-spike/observation.test.cjs) 在实际安装的 **1.19.5** 上通过，18.51 s、3 次 localhost 模型请求、0 次付费调用、0 次 memory 写入。只加载测试 observer，不加载正在并行修改的 memocap plugin；复用隔离 fixture 与指定的不可变 v0.5.0 native。原始证据为 [observation-1.19.5.json](../tests/opencode-capture-spike/observation-1.19.5.json)。本次不重复先前的工具权限实验。

测试 gate 位于 child 创建并加入 worker 排除集合之后、发出 child prompt 之前。observer 的真实 HTTP GET 在 gate 上等待，测试收到 `gate.waiting` 后才调用宿主 API。释放 gate 后只读取 parent messages 并报告 epoch，直接结束 worker，不发模型请求或工具调用；这是一项信号观察，不是生产取消逻辑。

| 操作与观察范围 | 实际 trace / 状态 | 含义 |
| --- | --- | --- |
| parent 正常 stop 且 worker 已在 gate 等待，再调用真实 `client.session.abort` | API 返回 `true`；`session.status {type:idle}` -> `session.idle`；没有新增 parent message/error；前后 `session.messages` 完全相等；释放时 epoch `1 -> 1`、user ID 不变 | 在 abort 响应、独立 messages 读取、worker 释放这个有界区间内，没有独有的 abort 标志。事件 ID 是新的，但事件类型和 properties 与重复 idle 相同，不能据此识别用户取消。 |
| 另一 parent 的旧 worker 已等待，提交第二条真实用户输入，再释放旧 worker | `chat.message` 观察到新 user ID，epoch `1 -> 2`；旧 worker 的 `latestUserID` 等于第二轮 assistant 的 `parentID`，与旧 user ID 不同 | 新输入在旧 worker 继续前可观察。生产可同步更新 generation，并在提交前复核最新 user ID；本测试未执行提交。第二轮 worker 也明确释放，无残留 gate。 |
| 新 parent 请求不存在的 `wire/missing-model` | SDK `UnknownError` 与真实 `session.error`；没有正常完成的 stop assistant；通过 error 响应及后续 messages GET 时创建 worker 数为 0；provider 请求数保持 3 | 证明这条错误路径不会启动 review；没有声称覆盖所有 error、active abort 或任意延迟之后的全局事件缺失。 |

observer 收集所有 `session.status`、`session.idle`、`session.error` 与 `message.*` 通知，未用固定 sleep 推断静默。trace 的边界是上述 API/HTTP gate 完成点；不能从有限观察声称宿主永远不会再发事件。

**实现影响：** 新输入能够驱动过期判定；idle 后用户取消不能仅靠现有 idle/error/message hooks 区分。生产若要求该取消也可靠停止 capture，需要额外的明确取消入口或宿主提供可识别的取消信号；把所有重复 idle 当成取消会同时破坏正常完成后的捕获。当前没有修改生产行为，也没有把这个信号缺口伪装成取消 gate 通过。两个监听端口关闭、sandbox 删除、active children 为 0；三个变更 JS 文件均无 LSP diagnostics，均少于 200 行。

复现该观察实验：

```sh
MEMOCAP_CAPTURE_OBSERVATION=1 \
MEMOCAP_TEST_NATIVE=/var/folders/x_/n5qr2_211jg2j9_7q_gdxw940000gn/T/opencode/memocap-v0.5.0-baseline.VBcIVe/memocap-native \
MEMOCAP_CAPTURE_EVIDENCE="$PWD/tests/opencode-capture-spike/observation-1.19.5.json" \
node --test tests/opencode-capture-spike/observation.test.cjs
```

## 复现

在 worktree 根目录运行；`MEMOCAP_TEST_NATIVE` 必须指向与当前 package 版本一致的独立 native。证据路径的父目录已存在。

```sh
MEMOCAP_CAPTURE_SPIKE=1 \
MEMOCAP_TEST_NATIVE=/var/folders/x_/n5qr2_211jg2j9_7q_gdxw940000gn/T/opencode/memocap-v0.5.0-baseline.VBcIVe/memocap-native \
MEMOCAP_CAPTURE_EVIDENCE="$PWD/tests/opencode-capture-spike/evidence-1.19.3.json" \
node --test tests/opencode-capture-spike.integration.test.cjs
```

增加 `MEMOCAP_CAPTURE_HOST=/opt/homebrew/bin/opencode` 并更换 evidence 文件名，即运行已安装的宿主；该 binary 仍使用 fixture 的隔离环境。未设 `MEMOCAP_CAPTURE_SPIKE=1` 时测试默认 skip。三个新 JS 文件的 `lsp_diagnostics` 均无诊断。本次只新增测试和证据文档，无生产代码编译变更。
