# Phase 8 的 forward flags（编排者受理台账）

## FF1 — serializeConversation 的 oracle 格式分歧（**本 phase 内处理**）

`packages/agent/src/harness/compaction/utils.ts` 的 `serializeConversation` 与 oracle `serialize_conversation` 真实分歧：

- oracle：`USER:` / `ASSISTANT:` / `TOOL_RESULT[name]:` 的原始转储，无截断，内联块顺序
- base：括号化 / 分组 / 截断格式

**judge 可观测**：经 `compaction.ts` 的 `compact()` 进入摘要文本 → 写入 session JSONL → parity S6 逐行差分。按 BUG-scope 规则（RULEBOOK §2 开头）判定为"必须对齐 oracle"。

C2 当时未改的原因正当：修它需连同 `compaction.ts` 的 token-budget 机制一起调和，而该文件正被 C1 编辑。C1 已于 2026-08-03 完成，冲突解除。

**状态**：已派 fixer 处理。

## FF2 — phase 8 的 shell_output/truncate 是死代码替身（**phase 9 交接**）

manifest 里 phase-8 的 `agent/harness/utils/{shell_output,truncate}` 两个 oracle 文件都是自称 TODO 的 stub 且零调用点（连 oracle 自己 `lib.rs` 的导出面都到不了），因此 phase 8 判 `none` 是正确的。

但**真正 parity 相关的截断算法在 phase 9 的 `coding-agent/tools/truncate`（+ `bash.rs`）**：bash 输出的截断算法、stdout/stderr 组织、退出码呈现都在那里，且全部用户可见。

**phase 9 接手者注意**：不要因为 phase 8 把这两个单元判了 `none`，就以为"截断行为已对齐"。真实 parity 面在 phase 9 自己手里。

## FF3 — cron-deps.ts 的 stub 切换（**phase 10 交接**）

`packages/coding-agent/src/triggers/cron-deps.ts` 是 phase 5 pilot 建的跨 phase stub 集合（当时 agent-core 侧尚不存在这些类型）。现在 phase 8 已落地真身：`trigger.ts`、`trigger-runtime.ts`、`notification-hook.ts`、`permission.ts`、四个并发 util。

**phase 10 移植 triggers/loops/inbox 时必须**：

1. 把 `cron.ts` 及其它 cron-deps 消费者切到 `@pie/agent-core` 的真实导出；
2. 删除 cron-deps.ts 中已被真身取代的 stub（其余仍缺的保留 `TODO(port)`）；
3. **注意大小写不同**：stub 是 camelCase（`lastEventAt`），真身是 snake_case wire 形状（`last_event_at`）。切换时必须同时改调用点——只改 import 会静默产出错误的 wire 输出。

涉及的 stub：`NotificationHookStatus`/`notificationHookStatusPending`、`TriggerSource`、`Trigger`、`TriggerRecord`、`HookState`、`AgentTool` 等。

## FF4 — AGENTS.md/CLAUDE.md 加载的真实位置（**phase 12 交接**）

批次 E 核实：`packages/agent/src` 全域零引用 AGENTS.md/CLAUDE.md，phase 8 无需处理。
真实分歧点在 **`packages/coding-agent/src/core/resource-loader.ts` 的 `loadContextFileFromDir`**（检查 `AGENTS.md`/`AGENTS.MD`/`CLAUDE.md`/`CLAUDE.MD`）。

审计确认的 oracle 行为：**pie 当前产品路径不加载这些文件**（与 pi 的明确差异，ROADMAP phase 13 验收标准列为"系统提示不含 AGENTS.md/CLAUDE.md 加载路径，grep 对账"）。
→ phase 12（resource loader / config 单元）或 phase 13（CLI 组装）必须复刻这一"不加载"行为，并写 grep 对账测试。

## FF5 — SessionErrorCode 的 message 文本（**phase 12/17 验证**）

`SessionErrorCode` 枚举值分歧已判为 judge 不可观测（ED12），但 **message 文本是可观测的**：parity S8 断言 oracle 的 `Error: invalid entry: EOF while parsing a string at line 1 column 528`。
→ phase 12 完成 session 层后，S8 双侧跑通时必须确认 TS 侧产生同样措辞的 message（"invalid entry: ..."），而不是自造的（如 "corrupted entry"）。
