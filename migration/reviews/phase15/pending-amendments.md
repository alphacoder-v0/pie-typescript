# Phase 15 · 待在 phase 边界应用的修订

> RULEBOOK standing rule 1：法典在 loop 内只读，修订排队、在 phase 边界应用并记入 §6 Deviation log。

## A1 — §2.1 补一行：非 serde 判别式的大小写约定（**真实法典缺口**）

**来源**：feed/kernel 单元上报。`QueuedTurn.kind` 没有 serde derive，因此 camelCase 与 snake_case **同样忠实**——法典对此无规定。
后果：该 agent 与 web 单元的 agent 在本轮中**来回改了三次**（camelCase ↔ snake_case）才各自收敛到 snake_case。

这正是法典存在的理由：**两个 agent 对同一个未言明的问题可能给出不同答案时，答案就该写进法典。**

**拟补规则（§2.1）**：
> serde 派生的 tag → 用 wire 名。**非 serde 的判别式（如内部 tagged union 的 `kind`）→ 也用 snake_case**，以保持 switch 站点的对称性。

当前落地状态已一致且通过类型检查，故本条是**追认+固化**，不需要改代码。

## A2 — `src/debug.ts:46-65` 的占位类型可以删除了

该处有 standing `TODO(port)`：「等 `ui/feed.ts` 行落地后，把这两个类型换成真实导出」。
现在 `ui/feed.ts` 已落地，其 `FeedLevel`/`FeedUpdate` 与占位版**结构相同**。
属 feed 单元边界之外，未处理。**待编排者或后续 fixer 收口**（改 `debug.ts` 的 import 即可）。

## A3 — `ui/index.ts` 集成者必须闭合的行为缺口（**最重要**）

`kernel.ts:206` 的 `TODO(port)`：
- oracle 的**无图片** `user_prompt_turn` 把 prompt 包在 `AgentSession` 的重试循环里（`agent_session.rs:87-149`：可重试分类、退避、`rewind_failed_assistant`、一次 fallback-model 切换）。
- TS 侧把重试放在了 `core/agent-session.ts`，而它由 `AgentSessionConfig` 构造、**从 kernel 够不到**。
- 当前交付的是**一次不重试的** `harness.prompt()`；`retry()` 已暴露，集成者可在不改构造函数的前提下恢复该包装。

**这条必须写进 `ui/mod` 单元的 brief**，否则 REPL 接线完成后重试语义会静默缺失——与 phase 13 的 B8「复刻在 CLI 不用的文件上」同类风险。

## 其余 TODO(port)（记录，不阻塞）

| 站点 | 内容 | 可达性 |
|---|---|---|
| `kernel.ts:133` | `is_streaming()` 无对应物（`AgentHarness.phase` 私有），改为 kernel 内在途计数器；失败时**保守抛 `busy`** 而非静默跳过 | 复刻 `ui/mod.rs:1009-1018` 意图 |
| `feed.ts:88` | `FeedUpdate` 的 `TextDelta(String)` 在 serde 内部 tagging 下会运行时报错；oracle 无任何站点序列化 `FeedUpdate`，故 `delta` 命名是本移植的自由选择 | 不可观测 |
| `feed.ts:194` | 谚文字母 U+1160–U+11FF 宽度：`unicode-width` 为 0，本移植为 1 | feed 内容不可达 |
| `feed.ts:228` | `rustLines` 与 `src/tui.ts:145-151` 的模块私有版重复；去重需改 `tui.ts`，**本 phase 冻结**（parity S1 已逐字节全绿） | phase 19 去重 |
| `feed.ts:272` | chrono 对 0..=9999 之外的年份加符号，`padStart` 不加 | 不可达 |

**无 `BUG(port)` 候选**（两个文件都没发现 oracle 缺陷）。
