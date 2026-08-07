# phase 19 — 表面覆盖审计（surface coverage audit）

**结论先行：43 个「无同名对应物」的 oracle public function 中，MISSING = 0。**
上界 43 全部消解为 RENAMED 11 / DISSOLVED 12 / TEST-ONLY·DEAD 20。

但**这个 0 的适用范围很窄**，窄到必须和数字一起读。见 §1「方法与其边界」与 §5「本测量证明了什么、没证明什么」。

---

## 1. 方法与其边界

### 1.1 做了什么

1. 取 oracle（Rust pie @0a120dfd，`$ORACLE_PIE_DIR`，只读）production 代码中的 public function（inline `#[cfg(test)] mod tests` 块排除）。
2. 按 camelCase / PascalCase / verbatim 三种形态在 TS 树 `packages/*/src` 中做**名字**匹配。
3. 无任何匹配者 = 43 个，构成本次审计的输入上界。
4. 对这 43 个逐个：**读 oracle 源码**确定它真正做什么 → 在 oracle 全树 grep 调用点判定死活 → 在 TS 树按**能力**（而非名字）搜索对应物 → 分类。

分类口径（四选一，优先级规则见下）：

| 分类 | 含义 |
|---|---|
| RENAMED | 能力在 TS 中以另一个名字（或内联进另一个函数）存在 |
| DISSOLVED | 能力被 TS 语言本身或被采纳的 npm 依赖吸收 |
| TEST-ONLY / DEAD | 该函数在 oracle **自身 production 代码中零调用点** |
| MISSING | oracle 有、本 port 没有的行为 |

**优先级规则（必须显式声明，否则计数不可复现）**：当多个分类同时成立时，**「oracle production 调用点为 0」优先**，判 TEST-ONLY/DEAD。理由：这是关于「缺失是否可能伤害任何人」的决定性事实——没有消费者，就没有可失去的东西。对这些行，表中另设一列记录 TS 侧是否仍有对应物，所以 RENAMED/DISSOLVED 的信息不会丢失。
本规则导致 20 行落入 TEST-ONLY/DEAD，其中 **17 行在 TS 侧同时存在对应能力**——即「oracle 里是死的，port 里反而是活的」。

「production 调用点」的判定：`#[cfg(test)] mod tests` 块内、`crates/*/tests/` 下、`examples/` 下的引用**均不计**；doc comment 中的名字提及不计；`lib.rs` 的 re-export 不计为调用。

### 1.2 这个方法会漏什么（false negative，方向明确）

名字匹配的漏检**全部指向同一个方向：高估覆盖率**。具体地：

- **改了名且改了行为的函数，会静默通过。** 本审计只检查了「名字对不上」的 43 个；另外约 470 个**名字对得上**的函数，其行为**一次都没有被本方法检查过**。名字相同不蕴含行为相同。
- **同名但语义漂移的类型/枚举值，完全不可见。** 本次审计在阅读 43 项的过程中**顺带**撞见了 6 处真实行为分歧（§4），其中 D-1、D-2 正是这一类：`FileErrorCode` 这个**类型名**两侧一致，但它的**取值**有 3 个拼写不同；`push_aborted` 的能力两侧都在，但**载荷 4 个字段不同**。名字匹配对这两者一律判「已覆盖」。
- 顺带撞见 6 处，只是因为我们为了给 43 项定性而读了大约 10% 的相邻代码。**按同样的密度外推，未被阅读的 90% 中很可能还有同量级的分歧**——这是外推，不是测量，不要当结论用。

### 1.3 这个方法会误报什么（false positive，已证实）

43 这个上界本身高度不可靠，它把大量非缺陷计入：

- **纯 Rust 惯用法**：builder（`with_path` / `with_metadata` / `with_base_dir`）、enum tag 读取器（`type_str`）、trait object 装箱（`default_stream_fn`）——TS 用可选参数、判别联合、一等函数直接消解。
- **oracle 自己的死代码**：20/43。其中 `ai/src/cli.rs::main_entry` 的函数体就是一句 `println!("pie-ai-rs CLI is a TODO.")`。
- **oracle 自己的 stub**：`truncate_text` / `truncate_shell_output` 的模块头自陈是 `TODO: full 1:1 port of ...truncate.ts (~344 lines)` 的临时替代品。
- **被指向了废弃分支**：见 §2.3 的 Bedrock 双栈。

### 1.4 计数口径的诚实说明

「513 个 public function」这个总体数字不可精确复现，取决于计数规则。用独立的、更粗的过滤器重数：**唯一函数名 440 个 / 定义处 574 个**。513 落在这个区间内，但三者都不是同一个东西。总体基数只用于给出量级感，**不承载结论**；承载结论的是被逐项审查的 43 个。

### 1.5 约束遵守

oracle 全程只读，未执行 `cargo`，未修复任何代码（修复会破坏本次计数），未 `git add` / `git commit`，未覆盖 `HOME`，未读取 `~/.pie/`。

---

## 2. 43 项分类全表

「oracle 调用点」= oracle production 代码中的调用点数（0 即 DEAD）。「TS 侧对应物」对 DEAD 行仍然填写，用于表明能力是否实际存在。

### 2.1 agent crate（13）

| # | oracle 位置 :: 函数 | 分类 | oracle 调用点 | 证据 / TS 侧对应物 |
|---|---|---|---|---|
| 1 | `agent/src/agent.rs :: active_token` | RENAMED | 1 (`harness/agent_harness.rs:2083`) | `Agent.signal` getter `packages/agent/src/agent.ts:316` + `Agent.abort()` `:321`。oracle 交出可 `.cancel()` 的 token，TS 交出只读 `AbortSignal` 并另设 `abort()`；两种能力都在，分工不同 |
| 2 | `agent/src/agent.rs :: enqueue_steering` | RENAMED | 1 (`agent_harness.rs:1581`) | `Agent.steer()` `packages/agent/src/agent.ts:285-287`，同为 `steeringQueue.enqueue(message)` |
| 3 | `agent/src/agent.rs :: prompt_many` | RENAMED | 1 (`agent.rs:172`，被 `prompt` 调用) | `Agent.prompt(message: AgentMessage[])` 重载 `packages/agent/src/agent.ts:346`，实现体 `:348-356` 经 `normalizePromptInput` 收敛为批量 `runPromptMessages` |
| 4 | `agent/src/harness/agent_harness.rs :: enqueue_steering` | TEST-ONLY/DEAD | **0**（全树仅定义处；`examples/` 亦无） | 能力仍在：`AgentHarness.steer()` `packages/agent/src/harness/agent-harness.ts:1923`，且 TS 侧**活跃** 5 处（`rpc-mode.ts:404`、`agent-session.ts:1398,1463`、`interactive-mode.ts:3878,3916`）。TS 多一条 `phase==="idle"` 守卫 |
| 5 | `agent/src/harness/agent_harness.rs :: format_skill` | TEST-ONLY/DEAD | **0** | 能力仍在：`formatSkillInvocation` `packages/agent/src/harness/skills.ts:42`。oracle 侧冗余——真正被用的是 `harness/skills.rs:23` 的模块级函数 |
| 6 | `agent/src/harness/agent_harness.rs :: replace_prompt_templates` | TEST-ONLY/DEAD | **0** | 能力仍在：`AgentHarness.setResources()` `agent-harness.ts:2320-2327`（整体替换，非仅 templates） |
| 7 | `agent/src/harness/agent_harness.rs :: replace_tools` | TEST-ONLY/DEAD | **0**（`agent_harness.rs:11` 仅 doc 提名） | 能力仍在且更强：`AgentHarness.setTools(tools, activeToolNames?)` `agent-harness.ts:2362-2372`，附带 Map 去重 + `validateToolNames` |
| 8 | `agent/src/harness/compaction/branch_summarization.rs :: summarize_branch` | TEST-ONLY/DEAD | **0**（仅 `lib.rs:38` re-export） | 能力仍在且**更完整**：`generateBranchSummary` `packages/agent/src/harness/compaction/branch-summarization.ts:200`，TS 侧**活跃**于 `agent-harness.ts:2127`，并额外产出 `readFiles`/`modifiedFiles`。oracle 文件头自陈是该 TS 文件的 "Partial 1:1 port"。**存在分歧 D-3** |
| 9 | `agent/src/harness/session/memory_storage.rs :: with_metadata` | TEST-ONLY/DEAD | **0** | `InMemorySessionStorage` 构造器可选参数 `packages/agent/src/harness/session/memory-storage.ts:43,52`：`options?.metadata ?? {id: uuidv7(), createdAt: ...}` 恰为 `with_metadata` vs `new` 的分叉 |
| 10 | `agent/src/harness/session/session.rs :: type_str` | DISSOLVED | 2 (`jsonl_storage.rs:243`, `memory_storage.rs:124`) | 被 TS 判别联合吸收。Rust 的 `#[serde(tag="type")]` 标签仅存在于序列化期，故需手写取值器；TS 中该 tag 就是运行时属性。10 个字面量在 `packages/agent/src/harness/types.ts:345-403` 一一对应，调用点变为 `entry.type === type`（`memory-storage.ts:98`、`jsonl-storage.ts:387`） |
| 11 | `agent/src/harness/types.rs :: with_path` | DISSOLVED | 1 (`harness/env/native.rs:56`) | 被 TS 可选构造参数吸收：`FileError` ctor `packages/agent/src/harness/types.ts:131`（`constructor(code, message, path?, cause?)`）。移植后的调用点 `harness/env/nodejs.ts:69-87` 构造时直接传 `path`。**相邻处存在分歧 D-1** |
| 12 | `agent/src/harness/utils/shell_output.rs :: truncate_shell_output` | TEST-ONLY/DEAD | **0** | oracle 自陈 stub（`// Stub passthrough — replace with the real ANSI-aware, head-and-tail truncator`）。TS 侧为真实实现：`executeShellWithCapture` + `sanitizeBinaryOutput` `packages/agent/src/harness/utils/shell-output.ts:43,30` |
| 13 | `agent/src/harness/utils/truncate.rs :: truncate_text` | TEST-ONLY/DEAD | **0**（唯一调用者是 #12，其本身已死） | oracle 自陈 stub。TS 侧为完整实现：`packages/agent/src/harness/utils/truncate.ts`（行数/字节双限、`truncateTail`、`TruncationResult`） |

### 2.2 agent types（3）

| # | oracle 位置 :: 函数 | 分类 | oracle 调用点 | 证据 / TS 侧对应物 |
|---|---|---|---|---|
| 14 | `agent/src/types.rs :: as_llm` | TEST-ONLY/DEAD | **0** | oracle 用 enum 包装 `Llm(Message)` 故需解包；TS `AgentMessage` 是裸判别联合（`packages/agent/src/types.ts:384`），LLM message **就是** AgentMessage，无物可解。判别在 `harness/messages.ts:120-123` 经 `switch (m.role)` 结构化完成 |
| 15 | `agent/src/types.rs :: default_stream_fn` | DISSOLVED | 2 (`agent_loop.rs:250`, `compaction/compaction.rs:535`) | 存在只为把 fn item 装箱进 `Arc<dyn Fn>`。TS 一等函数 + `??`：`agent-loop.ts:347`（`streamFn \|\| streamSimple`）、`agent.ts:225`（`options.streamFn ?? streamSimple`） |
| 16 | `agent/src/types.rs :: to_pie_ai` | DISSOLVED | 1 (`agent_loop.rs:257-263`) | 字面量联合子类型化。agent 侧 `"off"\|"minimal"\|...\|"xhigh"`（`agent/src/types.ts:359`）去掉 `"off"` 后即可赋给 ai 侧（`ai/src/types.ts:62`）。仅剩的 `Off => None` 过滤内联在 `agent.ts:447`、`agent-loop.ts:260-265`、`compaction.ts:604-605` |

### 2.3 ai crate — registry / bedrock / event stream（6）

**重要背景：oracle 有两套并行 Bedrock 栈，本清单指向的是被废弃的 v1。**
- 活栈：`providers/amazon_bedrock.rs`（`converse-stream`），注册于 `providers/register_builtins.rs:69`。
- 废栈 v1：`bedrock_provider.rs` / `bedrock_anthropic.rs` / `event_stream.rs`（`invoke-with-response-stream` + base64 `bytes`），零 production 调用点，其中两个文件带 `#![allow(dead_code)]`。

TS 侧 Bedrock **并未缺席**：`packages/ai/src/providers/amazon-bedrock.ts`（1019 行）为完整实况 provider，注册于 `register-builtins.ts:394-396`，依赖 `@aws-sdk/client-bedrock-runtime@3.1048.0`（已在 `packages/ai/package.json`，`amazon-bedrock.ts:244,253` 实际使用），并有 6 个测试文件覆盖。

| # | oracle 位置 :: 函数 | 分类 | oracle 调用点 | 证据 / TS 侧对应物 |
|---|---|---|---|---|
| 17 | `ai/src/api_registry.rs :: list_api_ids` | TEST-ONLY/DEAD | **0**（`lib.rs:28` 仅 re-export） | `getApiProviders()` `packages/ai/src/api-registry.ts:122-124`。oracle 自身 doc 即点名该 TS 函数。TS 返回 shim 对象（含 `.api`），是 oracle 返回 id 列表的超集。**两侧皆为无引用的公开表面** |
| 18 | `ai/src/bedrock_anthropic.rs :: ingest` | TEST-ONLY/DEAD | **0**（8 处调用全在 `#[cfg(test)]` 内，行 351-424） | 属废栈 v1。其解码的 base64 `bytes` 信封只存在于 `InvokeModelWithResponseStream`；活栈用 `converse-stream`，载荷是纯 JSON（`amazon_bedrock.rs:184`）。TS 活栈同构：`amazon-bedrock.ts:253` |
| 19 | `ai/src/bedrock_provider.rs :: invoke_stream` | TEST-ONLY/DEAD | **0**（另一处为 doc comment） | 属废栈 v1。同文件 `register()` 自陈是 no-op 占位符。注意假朋友：`packages/ai/src/bedrock-provider.ts` 只是 6 行懒加载 shim，非其对应物 |
| 20 | `ai/src/cli.rs :: main_entry` | TEST-ONLY/DEAD | **0** | 函数体是单句 `println!("pie-ai-rs CLI is a TODO...")`；`crates/ai/Cargo.toml` 无 `[[bin]]`。TS 侧**远超** oracle：`packages/ai/src/cli.ts` 为 172 行真实 CLI（`login`/`list`/`help`、OAuth、0700/0600 凭据落盘），并作为 `bin` 发布 |
| 21 | `ai/src/event_stream.rs :: message_type` | TEST-ONLY/DEAD | **0**（全树仅定义处，测试亦未用） | 活栈的 `utils/aws_eventstream.rs::EventStreamMessage` 根本不建模该概念。能力在采纳依赖内：`@smithy/core` event-streams 读 `:message-type` 并分支 error/exception/event |
| 22 | `ai/src/event_stream.rs :: parse_message` | DISSOLVED | 1（`bedrock_provider.rs:183`，但该调用者本身已死 → 传递性死代码） | 被 `@aws-sdk/client-bedrock-runtime` → `@smithy/core` 的 `splitMessage`/`EventStreamCodec`/`HeaderMarshaller` 吸收。逐项对应：BE u32 prelude 读取、prelude CRC32 校验、尾部 message CRC32 校验、header/payload 切分、header value type 0/1/4/5/6/7 解析（SDK 为超集） |

### 2.4 ai crate — providers / utils（15）

| # | oracle 位置 :: 函数 | 分类 | oracle 调用点 | 证据 / TS 侧对应物 |
|---|---|---|---|---|
| 23 | `ai/src/providers/faux.rs :: set_faux_responses` | TEST-ONLY/DEAD | **0**（`faux.rs:286` 在 `#[cfg(test)]` 内，块起于 `:250`） | `FauxProviderRegistration.setResponses` `packages/ai/src/providers/faux.ts:503-505`，同为整体替换 |
| 24 | `ai/src/providers/faux.rs :: append_faux_responses` | TEST-ONLY/DEAD | **0**（连 oracle 自己的测试都没用） | `appendResponses` `faux.ts:506-508`（`push(...responses)`），TS 测试 `faux-provider.test.ts:154` 实际使用 |
| 25 | `ai/src/providers/faux.rs :: clear_faux_responses` | TEST-ONLY/DEAD | **0**（`:283,:315` 均在 test 块内） | 无独立 `clearResponses`，清空表达为 `setResponses([])`（`agent-harness.test.ts:923,951,1045` 等），另有 `unregister()` `faux.ts:512`。TS faux provider 为闭包作用域队列（oracle 是进程全局 `OnceLock<Mutex<VecDeque>>`），并多出响应工厂、`getPendingResponseCount`、`tokensPerSecond` 节流等控制 |
| 26 | `ai/src/providers/simple_options.rs :: translate_base` | TEST-ONLY/DEAD | **0**（模块被编译但无 provider 走它） | 能力仍在且**活跃 9 处**：`buildBaseOptions` `packages/ai/src/providers/simple-options.ts:3-20`，被 anthropic/openai-responses/openai-completions/google/google-vertex/mistral/amazon-bedrock/azure/codex 全线调用 |
| 27 | `ai/src/utils/json_parse.rs :: parse_partial_json` | RENAMED | 5 (`openai_completions.rs:388`, `openai_responses.rs:509`, `mistral.rs:306`, `amazon_bedrock.rs:294`, `anthropic.rs:506`) | `parseStreamingJson<T>` `packages/ai/src/utils/json-parse.ts:104`。链路：`JSON.parse` → `repairJson` → `partialParse`（`partial-json@0.1.7`，已在 `package.json:79`）。oracle 手写的 `close_partial` 括号/引号闭合逻辑即溶解于此依赖；oracle 自身 doc 亦称 "Same idea as the TS `partial-json` package"。两侧测试矩阵同输入同断言（完整对象/未闭合对象/未闭合字符串/尾逗号/空）。已知刻意差异：空输入 Rust 返回 `Value::Null`、TS 返回 `{}`；不可恢复输入 Rust 返回 `Err`、TS 返回 `{}`——两侧调用点均已守卫 |
| 28 | `ai/src/utils/node_http_proxy.rs :: proxy_from_env` | DISSOLVED | 9（`build_client` 经全部 9 个 provider） | 双路覆盖：① 全局 `undici.setGlobalDispatcher(new EnvHttpProxyAgent(...))` `packages/coding-agent/src/core/http-dispatcher.ts:39-55`，`undici@8.9.0` 已在依赖并于 `cli.ts:21` 进程入口接线；② AWS SDK 旁路仍保留显式解析 `packages/ai/src/utils/node-http-proxy.ts`（`getProxyEnv:23`、`shouldProxyHostname:39`、`resolveHttpProxyUrlForTarget:91`）。**相关 oracle 缺陷 D-6** |
| 29 | `ai/src/utils/oauth/anthropic.rs :: build_authorize_url` | RENAMED | 1 (`anthropic.rs:149`，在 `pub async fn login` 内) | 内联进 `loginAnthropic`：`packages/ai/src/utils/oauth/anthropic.ts:250-262`。常量逐字节一致（`AUTHORIZE_URL`、base64 混淆 `CLIENT_ID`、`CALLBACK_PORT` 53692、`REDIRECT_URI`、`SCOPES`、`S256`）。**存在分歧 D-4** |
| 30 | `ai/src/utils/oauth/pkce.rs :: generate_pkce` | RENAMED | 1 (`anthropic.rs:147`) | `generatePKCE()` `packages/ai/src/utils/oauth/pkce.ts:21-34`。算法同构：32 随机字节 → base64url-no-pad verifier → SHA-256 → base64url-no-pad challenge。原语（RNG/SHA-256/base64url）溶进 Web Crypto，但具名封装保留，故判 RENAMED。TS 复用于两个 OAuth provider（`anthropic.ts:237`、`openai-codex.ts:190`） |
| 31 | `ai/src/utils/retry.rs :: is_aborted` | DISSOLVED | 9（全部 9 个 provider） | 被原生 `AbortSignal` 约定吸收。9 个分支逐一对应 TS 的 `signal?.aborted ? "aborted" : "error"`（anthropic:703、openai-responses:158、openai-completions:421、codex:251、azure:181、google:284、google-vertex:315、mistral:134、bedrock:298）。错误对象侧由 `isAbortError` `packages/ai/src/utils/retry.ts:74-79` 承担，用于把 abort 排除出重试预算 |
| 32 | `ai/src/utils/sanitize_unicode.rs :: sanitize_surrogates_u16` | TEST-ONLY/DEAD | **0**（同模块的 `sanitize_surrogates` 亦为 0，且其实现是恒等函数——**oracle 实际上没有任何在线的代理项清洗**） | JS 字符串本身即 UTF-16 码元序列，「先解码成 u16 缓冲」一步无对应物。`sanitizeSurrogates` `packages/ai/src/utils/sanitize-unicode.ts:21-25` 直接以正则处理孤立代理项，算法对 `H H L` 等情形与 Rust 循环输出一致，且 TS 侧**活跃约 40 处** |
| 33 | `ai/src/utils/abort.rs :: send_or_abort` | DISSOLVED | 2 (`retry.rs:53`, `:75`) | 原生 `fetch(url, {signal})`。`sendWithRetry` `packages/ai/src/utils/retry.ts:129-174` 每次尝试前查 `signal?.aborted`（`:138-140`）并对 abort 直接重抛不重试（`:146-148`）；传输层取消由各 provider 透传 signal 完成 |
| 34 | `ai/src/utils/abort.rs :: next_or_abort` | DISSOLVED | 6 (`anthropic.rs:275`, `google.rs:194`, `mistral.rs:192`, `openai_completions.rs:200`, `openai_responses.rs:242`, `amazon_bedrock.rs:159`) | 两层覆盖：循环内显式 `signal.aborted` 检查（`anthropic.ts:340-342` 等 9 处）+ 原生 race——body 流来自 signal 绑定的 fetch，故挂起中的 `reader.read()` 在 abort 时 reject 而非悬挂，正是 `tokio::select!` 手工构造的性质 |
| 35 | `ai/src/utils/abort.rs :: drain_bytes_or_abort` | DISSOLVED | 1 (`retry.rs:98`) | `await response.body?.cancel().catch(() => {})` `packages/ai/src/utils/retry.ts:169-170`（注释含 oracle 出处）。TS 是**取消**而非**排空**，因而无需 abort race；紧随其后的 `sleepOrAbort(delay, signal)` 承担取消。净效果相同（连接释放 + 及时响应 abort） |
| 36 | `ai/src/utils/abort.rs :: response_text_or_abort` | DISSOLVED | 8-9（全部 provider 的 `!status.is_success()` 分支） | 原生。唯一显式错误体读取 `openai-codex-responses.ts:1198-1199` 作用于 signal 绑定的 `Response`；其余由各 vendor SDK 在自己的 signal 绑定 fetch 上读取并抛出，落入 provider `catch`。未发现 abort 悬挂路径 |
| 37 | `ai/src/utils/abort.rs :: push_aborted` | RENAMED（内联重实现） | **22**（9 个 provider 文件） | **manifest.tsv:58 的 `dissolved:native-AbortSignal` 对本项不成立**——合成终止事件是应用行为，`AbortSignal` 不免费提供。TS 在 9 个 provider 的 `catch` 块中逐个手写等价物（`anthropic.ts:703-706` 等），形如 `output.stopReason = signal?.aborted ? "aborted" : "error"; stream.push({type:"error", reason:output.stopReason, error:output})`。能力在，但**载荷有 4 字段分歧，见 D-2** |

### 2.5 coding-agent crate（6）

| # | oracle 位置 :: 函数 | 分类 | oracle 调用点 | 证据 / TS 侧对应物 |
|---|---|---|---|---|
| 38 | `coding-agent/src/agent_session.rs :: forward_to_listener` | TEST-ONLY/DEAD | **0**（全仓库仅定义处） | 函数体为空 `{}`，参数丢弃（`_:`），带 `#[allow(dead_code)]`。**不是**事件扇出。同文件 `AgentSessionEvent` 同样状态，oracle 自注 "declared for future embedder use; the binary doesn't emit these yet" |
| 39 | `coding-agent/src/session/mod.rs :: open_repo` | RENAMED | 3 (`commands.rs:1893`, `:2070`, `:2486`) | **不是 git**，是 cwd 域 JSONL 会话记录库。TS 弃用句柄对象、改传目录字符串：`getDefaultSessionDir` `packages/coding-agent/src/core/session-manager.ts:484` / `sessionDirForCwd` `:501`。路径算法一致（`sha256(cwd)[:6]` hex，`PIE_DIR` 覆盖保留）。下游表面齐备（`findSessionPathById`、`resolveResumeSessionPath`、`newestSessionPath`、`deleteSessionById` 等）。**存在分歧 D-5** |
| 40 | `coding-agent/src/tools/remove_skill.rs :: with_base_dir` | RENAMED | 1（`new()` at `:48`，走默认目录；覆盖用法 `:460+` 全在 test 块内，块起于 `:338`） | `RemoveSkillToolOptions.{agentDir, baseDir, skillsRoot}` `packages/coding-agent/src/tools/remove-skill.ts:127-134`，解析于 `:150-152`。TS 把 oracle 单一 `base_dir` 拆成三个更细的覆盖点（超集）。production 接线 `tools/index.ts:237` |
| 41 | `coding-agent/src/tools/set_skill_state.rs :: with_base_dir` | RENAMED | 1（`new()` at `:57`；覆盖用法 `:418+` 全在 test 块内，块起于 `:334`） | `SetSkillStateToolOptions.{agentDir, baseDir}` `packages/coding-agent/src/tools/set-skill-state.ts:102-107`，解析于 `:130-131`。`PIE_DIR` 默认经 `config.ts:482` 保留 |
| 42 | `coding-agent/src/skills.rs :: skills_dirs` | DISSOLVED | 1 (`skills.rs:34`，被 `load_all` 调用) | 内联进 `loadSkills` `packages/coding-agent/src/core/skills.ts`：project = `resolve(cwd, CONFIG_DIR_NAME, "skills")`（`:451,:456`）、user = `join(resolvedAgentDir, "skills")`（`:452,:455`）。`CONFIG_DIR_NAME` 默认 `.pie`（`config.ts:451`），`getAgentDir()` 即 oracle `base_dir()`（`config.ts:485`，带 `pie:` 出处注释）。`skills.ts:444-450` 显式记录了 project-wins 优先级的等价论证 |
| 43 | `coding-agent/src/triggers/cron.rs :: next_run_after` | RENAMED | 3 (`cron.rs:1152`, `:1204`, `:1248`) | `cronJobNextRunAfter` `packages/coding-agent/src/triggers/cron.ts:103` → `cronExpressionNextAfter:332` / `parseCronExpression:306`。逐维度核对一致：起始边界（`after+1min` 后清零秒）、逐分钟绝对步进、5×366 天视界（毫秒数完全相同）、本地时区匹配、DST 行为、**DOM∧DOW 用 `&&`（与 Vixie cron 的 OR 不同，但两侧同样 bug-for-bug）**、DOW `7→0` 归一、各字段取值域、`*`/范围/`/step`/逗号列表、`start>end` 与 `step==0` 报错。仅两处纯装饰性差异（超 u32 数值的**错误文案**不同；空白切分对 U+FEFF 的处理不同），**均不改变任何一次触发时刻** |

---

## 3. 计数

| 分类 | 数量 |
|---|---|
| RENAMED | **11** |
| DISSOLVED | **12** |
| TEST-ONLY / DEAD | **20** |
| **MISSING** | **0** |
| 合计 | 43 |

补充口径（同一批 43 项的另一个切面）：

- 43 项中 **20 项在 oracle 自身 production 代码中零调用点**——即上界的 47% 是 oracle 的死代码、stub 或废弃分支。
- 这 20 项 DEAD 中，**17 项在 TS 侧仍有对应能力，且多数在 TS 侧是活跃的**（`buildBaseOptions` 9 处、`sanitizeSurrogates` ~40 处、`generateBranchSummary`/`AgentHarness.steer` 均已接线、`cli.ts` 是真实 CLI 而 oracle 是一句 println）。**在这 43 项的范围内，port 比 oracle 接线得更完整，而不是更少。**
- 无 UNCERTAIN 项。43 项全部给出了可复核的文件+行号证据。

---

## 4. 顺带发现的真实分歧（不属于 43 项分类，但属于本次审计的产出）

这些是为给 43 项定性而阅读相邻代码时**撞见**的，不是系统搜索的结果。**它们比 MISSING=0 更值得注意**，因为它们全部属于「名字对得上、行为对不上」这一类——即 §1.2 所述本方法结构性看不见的那一类。

| ID | 分歧 | 复核状态 | 影响 |
|---|---|---|---|
| **D-1** | `FileErrorCode` 取值拼写分歧：oracle `not_a_directory` / `is_a_directory` / `invalid_path`（`agent/src/harness/types.rs:31-41`，`rename_all="snake_case"`）vs TS `not_directory` / `is_directory` / `invalid`（`packages/agent/src/harness/types.ts:114-122`），且 TS 多一个 `not_supported` | **本人已复核两侧源码** | 目前 TS 侧未见跨序列化边界使用（仅 `types.ts` 内部 + 一处注释），故当前无实害；一旦该枚举进入持久化或 RPC 载荷即成为 parity break |
| **D-2** | `push_aborted` 载荷分歧：oracle 推送**全新空消息**（`content: []`、`usage` 全零、`response_id: None`、`error_message` 恒为 `"aborted"`）；TS 推送**累积的 `output`**（保留部分内容、累计 token **与 cost**、真实错误文本、可能已有 responseId） | oracle `abort.rs:116-135` 与 TS `anthropic.ts:697-706` **由本人独立复核**；其余 8 provider 与下游影响链路来自子代理 | **本表最高**。交互式 ESC 路径两侧都在更上游被 `agent_loop` 抢先拦截，故不受影响；受影响的是直接使用 `@pie/ai` 的 `complete()`/`stream()` 消费者：TS 中被中止的一轮会带回**非零 `usage.cost`**，oracle 带回零。任何未按 `stopReason` 过滤就累加 cost 的代码，在 TS 上会为中止轮次计费。另：`agent-loop.ts:413-425` 会把该部分消息写入 `context.messages`，而 `agent_loop.rs:315-319` 丢弃——非 ESC 中止会在 TS 会话历史留下可见的半截 assistant 轮次 |
| **D-3** | 摘要注入缝丢失：oracle `summarize_branch` 接受 `stream_fn: Option<StreamFn>`，`GenerateSummaryRequest` 亦带该字段；TS `GenerateBranchSummaryOptions`（`branch-summarization.ts:51-66`）**无 streamFn**，`compaction.ts:608,889` 直接硬调 `completeSimple` | **本人已复核两侧** | 低。SDK 嵌入方无法把摘要走自定义/代理 LLM 传输。TS 改以显式 `apiKey`/`headers`/`signal` 覆盖大部分定制需求 |
| **D-4** | Anthropic authorize URL：TS 多发 `code: "true"` 参数（`oauth/anthropic.ts:251`），oracle 无（`oauth/anthropic.rs:36-43`）；且 TS 用 `URLSearchParams`（空格→`+`）而 oracle 用 `NON_ALPHANUMERIC` 百分号编码（空格→`%20`），`SCOPES` 是空格分隔故实际受影响 | **本人已复核两侧** | 低。两者均为合法 wire 格式；`code=true` 是上游 pi 的行为（支持手工粘贴 code）。但若要求对 oracle 的 bug-for-bug 一致，这是一处未登记的偏离 |
| **D-5** | `open_repo` 副作用分歧：oracle `JsonlSessionRepo::new` 是纯构造（只有 `create()` 才 `create_dir_all`）；TS `getDefaultSessionDir`（`session-manager.ts:484-490`）会 `mkdirSync`。三条**只读**路径用了会建目录的变体：`/sessions`（`slash-dispatch-session.ts:579`）、`/find`（`:619`）、automation hint（`session-manager.ts:2207`） | **本人已复核全部三处 + 两个变体定义** | 低。但这是**违反 port 自己写在 `session-manager.ts:492-500` 的不变量**（"Read-only surfaces ... must not leave an empty `~/.pie/sessions/<hash>/` behind"）。cwd 与会话原始 cwd 不同时，TS 会留下空目录而 oracle 不会。纯变体 `sessionDirForCwd` 就在旁边且 `main.ts` 已正确使用 |
| **D-6** | oracle 自身缺陷：`node_http_proxy.rs:3-4` doc 声称 "Honors HTTP_PROXY, HTTPS_PROXY, and NO_PROXY"，但函数体（`:10-15`）从不读 `NO_PROXY`、不调 `.no_proxy(...)`，也忽略 `ALL_PROXY` | 子代理发现，本人未复核 | 无损失——**TS 反而正确实现了 NO_PROXY**。记录于此是为提醒：oracle 的 doc comment 不可作为行为合同（与本仓 CLAUDE.md 第 7 条「老代码是 spec」的操作方式一致：以源码为准） |

### 4.1 账本缺陷（migration 记录本身的问题，非代码问题）

| ID | 问题 | 复核状态 |
|---|---|---|
| **L-1** | `migration/manifest.tsv:21`（`ai/event_stream` ← `crates/ai/src/event_stream.rs`，AWS 二进制分帧解析器）的 out_path 指向 `packages/ai/src/utils/event-stream.ts`，状态 `done`。但该 TS 文件是 `EventStream<T,R>` 异步迭代器类，**无分帧、无 CRC、无 prelude**，且它**已经是** `manifest.tsv:61`（`ai/utils/event_stream`）的 out_path——正确的 1:1 配对。一个 out_path 被两行重复记账，第 21 行断言了它并不具备的覆盖 | **本人已复核**：`grep -c "crc\|Crc\|prelude" packages/ai/src/utils/event-stream.ts` = **0**；文件首行即 `export class EventStream<T, R = T>`。第 21 行的诚实值应与第 59 行一致，即 `dissolved:adopted-@aws-sdk/client-bedrock-runtime`。底层能力确实被覆盖（见 #22），故这是**账本错误而非覆盖缺口** |
| **L-1a** | 为什么 L-1 一直没被发现：`migration/scripts/check-manifest-coverage.sh` 只校验 **column 2（oracle src path）** 对 oracle `.rs` 文件全覆盖且无重复，**从不校验 column 4（out_path）的唯一性**。out_path 重复记账在现有工具下不可见 | **本人已复核该脚本**（`cut -f2` + `uniq -d`，无 column 4 检查） |
| **L-2** | `migration/manifest.tsv:58` 的 `dissolved:native-AbortSignal` 理由对 5 个 helper 中的 4 个成立，对 `push_aborted` 不成立（见 #37 / D-2）。注释中的「18 处使用」对应的是 `AbortSignal` **类型引用**数，而非 `signal.aborted` 检查点数 | 子代理发现；`push_aborted` 确为合成事件发射器、TS 确为逐 provider 手写重实现，**本人已独立确认** |
| **L-3** | `migration/reviews/ai/divergence-ledger.tsv:46` 称 `push_aborted` "independently confirmed live and working via packages/ai/test/abort.test.ts"，但该文件整体受凭据门控（`describe.skipIf(!process.env.GEMINI_API_KEY)` 等），在 hermetic `npm test` 入口下贡献**零覆盖**；且其唯一实质内容断言（`:45` `expect(msg.content.length).toBeGreaterThan(0)`）与 oracle 行为**相反**。目前**不存在**任何 hermetic 测试断言 provider 会以 oracle 的载荷发出中止终止事件 | **2026-08-05 编排者已复核确认**：6 个 describe 全部凭据门控，密闭下实测 `33 tests / 33 skipped`（零覆盖）；且 `:45` 的断言 `content.length > 0` 与 oracle 的空消息**方向相反**。严重度高于原报告。见 phase20/reverify.md §4 |

---

## 5. 本测量证明了什么、没证明什么

### 证明了

- 在「oracle public function 名字在 TS 树中无任何匹配」这一**特定**筛子下，**没有一项对应真实的能力缺失**。43 个候选全部有据可查地消解掉了。
- 这个筛子本身噪声极大：47%（20/43）是 oracle 自己的死代码、自陈 stub 或废弃分支；其余多为 Rust 惯用法在 TS 中的自然消解。**「43 个未移植函数」这一说法是错误的**，正确说法是「43 个名字对不上的位置，逐一查证后缺失为 0」。
- 在这 43 项覆盖到的范围内，TS port 的接线程度**普遍高于** oracle，而非低于。

### 没有证明

- **没有证明 port 整体完整。** 本次只审查了 43 个，即 oracle public function 总体（量级 440–574，取决于计数口径）的约 8–10%，且是按「名字对不上」这一与正确性无关的标准挑出来的 8–10%。
- **没有对任何名字匹配上的函数做过行为核对。** 剩余约 90% 的表面，本方法给出的「已覆盖」判定其强度仅等于「存在一个同名符号」。§4 的 D-1 与 D-2 是这一盲区内实际存在缺陷的直接证据——两者都发生在名字匹配得上的位置，都不会被本方法看见，而 D-2 有真实的计费与会话历史后果。
- **没有覆盖非函数表面。** 类型取值（D-1 即是）、常量、默认值、错误文案、序列化标签、CLI flag、配置键，均不在本方法射程内。
- **没有覆盖 oracle 里同样不存在的东西。** 本方法方向单一（oracle → TS）；TS 独有而 oracle 无的行为（例如 `FileErrorCode` 的 `not_supported`）不会被标记。

### 与既有三类证据的关系

本仓此前的三类证据——manifest done 数、4186 个测试、12 个 parity 场景——**各自假定**移植完整而非度量它。本次审计是第四类，同样**不度量完整性**：它度量的是「名字对不上的位置里有没有缺失」，答案是没有。

真正能度量完整性的下一步，是对**名字匹配上的**函数做行为级差分（而非存在性检查）。D-1/D-2 表明该处的产出率不会是零。L-1/L-1a 则表明：manifest 的 `done` 标记至少有一处由不相干的文件满足，且现有校验脚本在设计上看不见这类错误，因此 done 数在 out_path 唯一性被补校验之前不能当作覆盖证据使用。

---

## 附：不可复核项与不确定性声明

- 全部 43 项分类均给出文件+行号，无 UNCERTAIN。
- §4 中 **D-1、D-3、D-4、D-5 与 L-1、L-1a 由本人直接复核两侧源码**；**D-2 的 oracle 侧与 anthropic provider 侧由本人复核**，其余 8 个 provider 的对应行与下游影响链路（transform_messages / compaction / agent-loop 持久化）来自子代理报告，未逐条复验。
- ~~D-6、L-3 完全来自子代理，本人未复核~~ → **2026-08-05 已由编排者逐条复核，4 条（含 D-6 NO_PROXY、L-3）全部确认为真**；
  L-3 的实际严重度高于原记录。证据见 `migration/reviews/phase20/reverify.md`。
- oracle 全程只读；未修复任何代码（§1.5）。本文件是测量记录，任何修复都应在本记录定稿之后另起工作项。
