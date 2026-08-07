# 60 条 `not-portable` 二次裁定

第四轮收口后复核发现 `coding-agent/src/ui/web.rs::run_web` 被判错了。本 phase 把那 60 条**逐条**重新核了一遍。

## 结果

| | 条数 |
|---|---|
| 复核前 `not-portable` | **60** |
| **改判为 `existing-test`** | **7** |
| 维持 `not-portable` | **53** |

**误判率 7/60 = 11.7%。**

## 改判的 7 条 —— 每条的原理由错在哪

| oracle 条目 | 原理由说 | 事实 | 新证据 |
|---|---|---|---|
| `agent/src/harness/trigger.rs::is_terminal@210` | 「Rust 枚举方法，TS 用字面量联合替代」 | `isTriggerStateTerminal` 是真函数，trigger.ts:115，5 个状态逐一断言 | `packages/agent/test/harness/trigger.test.ts:110` |
| `agent/src/harness/trigger.rs::received_from@269` | 「`receivedFrom` 在 packages/*/src 零命中」 | `triggerRecordReceivedFrom` 就在 trigger.ts:158 | `packages/agent/test/harness/trigger.test.ts:132` |
| `ai/src/providers/images/openrouter.rs::generate@9` | 「非同名，在本仓是 ImagesApiProvider.generateImages」 | `generateImagesOpenRouter` 就在 openrouter.ts:39，有专属测试 openrouter-images.test.ts | `packages/ai/test/openrouter-images.test.ts:87` |
| `ai/src/vertex_adc.rs::build_jwt@96` | （第四轮未逐条核） | `buildVertexJwt` 在 vertex-adc.ts:124，vertex-adc.test.ts 有专属 describe 块 | `packages/ai/test/vertex-adc.test.ts:145` |
| `coding-agent/src/agent_session.rs::is_retryable_error@57` | 「零命中，重试判定在 ai 层 retry.ts 内联」 | `isRetryableErrorMessage` 就在 agent-session.ts:139 | `packages/coding-agent/test/ported/session-archive-batch-d.test.ts:185` |
| `coding-agent/src/config.rs::memory_dir@27` | 「只是路径拼接，单独断言属 tautology」 | config-paths.test.ts:21 钉死了字面子目录名 memory——改成 memories 会红，不是 tautology | `packages/coding-agent/test/config-paths.test.ts:21` |
| `coding-agent/src/skills_state.rs::remove_and_save@151` | 「拆成 removeSkillState + saveSkillsState 两步」 | `removeAndSaveSkillsState` 是**一个**函数，skills-state.ts:238 | `packages/coding-agent/test/ported/skills-state-batch-c.test.ts:183` |

### 七条里有五条是同一个错误

`received_from` · `generate` · `is_retryable_error` · `remove_and_save` · `is_terminal` ——
这五条的原理由都断言「零命中」或「本仓拆成了别的形态」，而**对应函数就在导出面上**：

| 原理由查的名字 | 实际叫 |
|---|---|
| `receivedFrom` | `triggerRecordReceivedFrom` |
| `generateImages` | `generateImagesOpenRouter` |
| `isRetryableError` | `isRetryableErrorMessage` |
| （以为拆成两个） | `removeAndSaveSkillsState` |
| （以为是枚举方法） | `isTriggerStateTerminal` |

**前四个都是「精确 grep 一个猜出来的名字，没命中就下结论」。**
真实的 TS 名字是 oracle 名字的**扩展**（加前缀 `triggerRecord`、加后缀 `OpenRouter` / `Message`），
精确匹配必然落空。

### 一条更严重的：`run_web` 的「零命中」是假的

第四轮的理由写着「`runWeb` 零命中」。实测 **`runWeb` 就在
`packages/coding-agent/src/ui/web.ts:1497`，还被 `main.ts:1645` 调用**。

这不是「推断方法错」（用符号名推断路径），而是**那次 grep 根本没做，理由是凭空写的**。
误判的性质因此不同：前五条是方法有缺陷，这条是事实核查缺失。

## 维持 `not-portable` 的 53 条 —— 三类细分

| 类型 | 条数 | 说明 |
|---|---|---|
| **结构差异** | 41 | oracle 有具名函数，本仓用别的语言机制表达同一件事（字面量联合 / 对象字面量 / options 参数 / `??` 内联默认值） |
| **只能tautology** | 4 | TS 侧存在，但可观测后果已被别的函数的证据覆盖，单写只能断言「存进去又读出来」 |
| **能力缺口** | 4 | **oracle 有而本仓确实没有**——全部是 AWS eventstream 二进制帧路径 |
| **需真实IO/终端** | 4 | TUI 主循环 / 真实 HTTP 握手 / 真实子进程，密闭单测覆盖不到 |
| | **53** | = 维持数 53 ✓ |

### 四条真能力缺口，逐条

| oracle | 实证 |
|---|---|
| `ai/src/event_stream.rs::event_type` | `packages/ai/src/event-stream.ts` **不存在** |
| `ai/src/event_stream.rs::content_type` | 同上 |
| `ai/src/event_stream.rs::crc32` | 全仓 grep `crc32` 零命中 |
| `ai/src/utils/aws_eventstream.rs::new` | 探针报 `no-file` |

共同实证：`packages/ai/src/bedrock-provider.ts` **只有 6 行**，导出一个 `bedrockProviderModule` 占位。

**用户已明确本轮不补这个能力**，只需论证清楚——这一节就是那个论证。

### ⚠ 探针的一个已知误配（记下来而不是绕过）

探针的「同名 basename 全仓搜索」退路把 `ai/src/event_stream.rs` 映射到了
`packages/ai/src/utils/event-stream.ts`（89 行）。**那是错的**：oracle 有**两个**同名文件
（`ai/src/event_stream.rs` 是 AWS 二进制帧、`ai/src/utils/event_stream.rs` 是通用 EventStream 抽象），
`utils/event-stream.ts` 是**后者**的对应物。

所以探针的 `substantial` 不等于「有对应实现」——当 oracle 存在同名不同路径的文件时，
basename 退路会误配。**这三条正因为人工复核才没被误判成「已移植」。**

## 抽查（规则先于结果声明）

**规则**（在查看任何结果之前打进 transcript）：
- 改判的 7 条 **全查**（100%）
- 维持的条目按 `evidence.tsv` 出现顺序等距抽 `max(5, ⌈n/5⌉)` = **10** 条，步长 4，从 index 0 起
- 抽中编号：#0 · #4 · #8 · #12 · #16 · #20 · #24 · #28 · #32 · #36

**结果：10/10 通过三问**（① TS 真无此物？② 理由与事实符？③ 若有对应物为何不能作证据？）：

| 抽中 | 核实 |
|---|---|
| `agent::convert_to_llm` | `defaultConvertToLlm` 在 agent.ts:33 且**模块私有**（非 export）—— ✓ 但原理由写的是「types.ts」，**位置错了，已修正** |
| `agent_harness::set_compaction_settings` | `agent-harness.ts:1954` 存在，只存 settings ✓ |
| `agent/types::as_str` · `ai/types::as_str` | 全仓 `asStr` **0 命中** ✓ |
| `event_stream::content_type` | `packages/ai/src/event-stream.ts` 不存在 ✓ |
| `ai/types::text@288` | `TextContent` 是 interface 非构造函数 ✓ |
| `headers::merge_headers` | `mergeHeaders` 在 anthropic.ts:227，**无 export 关键字** ✓ |
| `commands::set_sink` | 全仓 `setSink` **0 命中** ✓ |
| `hooks::len` | `isEmpty` 的证据确在表中（hooks.test.ts:194）✓ |
| `resume_picker::pick_blocking` | 全仓 `pickBlocking` **0 命中** ✓ |

抽查抓出 1 处**位置错误**（不是裁定错误）：`defaultConvertToLlm` 在 `agent.ts:33` 而非 types.ts。已修正。

## 判据 3 的机器验证

53 条理由**逐条** grep「含 `packages/` 路径 或 `<name>.ts` 文件名 或 camelCase 标识符」：

```
判据 3：53/53 —— 命中数 = 条数 ✓
```

首次运行是 **40/53**，13 条不合格。逐条具体化后达标——其中 6 条原本只写了「同因」而没说 TS 侧到底在哪，
现在都点到了文件与行号（例如 `triggers/tool-definitions.ts` 承担了 oracle `tools/mod.rs` 的工厂层）。

