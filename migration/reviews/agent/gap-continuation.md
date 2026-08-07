# Phase 8 实质缺口：turn-continuation 族未移植

`agent_harness.rs` 单元的 implementer 报告了 4 个 pub API 未移植，编排者核实确认它们在 oracle 中真实存在且是公开 API：

| oracle 函数 | 行 | 作用 | 下游依赖 |
|---|---|---|---|
| `continue_()` | 1732 | 继续上一轮（无新用户输入的续跑） | `--continue` CLI 标志（phase 13）；`/goal` 自动续跑（phase 11） |
| `run_turn_with_continuation()` | 1750 | 带续跑判定的单轮执行 | 同上 |
| `force_compact()` | 1946 | 强制压缩（不等阈值） | `/compact` 命令（phase 13） |
| `run_evaluator()` | 1974 | 无工具的评估调用（判定目标是否达成） | **`/goal` 的核心机制**（phase 11，RULEBOOK §5 相关：40k 字 transcript 上限、8 次续跑上限） |

## 未移植的原因（implementer 的论证，编排者接受）

base 的架构是"每轮从 `session.buildContext()` 重建不可变 `AgentHarnessTurnState`"，oracle 是"持久 `Agent` wrapper"。base 侧**没有 `continue_()` 概念可供叠加**——不是漏做，是没有可叠加的底座。强行移植等于在 diff-port 单元里重构 base 架构，超出该单元职责。

## 已就位的接口保证

`checkBudgetCap()` 已实现（B4 复刻：轮次间软门）。implementer 在其注释中标注：未来的 continuation 单元**必须在自己的轮次边界调用它**，否则 B4 的行为会失真（变成完全不检查，而非 oracle 的"轮次间检查"）。

## 交接决议（编排者）

1. **不在 phase 8 补**：这四个 API 的正确落点需要先确定 base 的 continuation 架构，而其唯一消费者在 phase 11（`/goal`）与 phase 13（CLI `--continue`/`/compact`）。
2. **phase 11 必须处理 `run_evaluator` + `continue_` + `run_turn_with_continuation`**：`/goal` 的 evaluator 与自动续跑就是这三个的组合。phase 11 的 brief 要显式包含"在 agent-harness.ts 补齐 continuation 族"这一前置任务。
3. ~~**phase 13 必须处理 `force_compact`**~~ —— **2026-08-04 更正**：phase 11 核实 `force_compact` 在 phase 8 就已移植，即现有的公开 `compact()` 方法（其文档注释本就引用 `agent_harness.rs:1946-1950`）。编排者当初把它列为待办是误判——它不在那 4 个未移植 API 之列。phase 13 只需接线 `/compact` 命令到既有方法。
4. **两者都必须在轮次边界调用 `checkBudgetCap()`**，并写测试断言 B4 语义（同一 prompt 内不复查、跨轮次复查）。
5. phase 17 的 parity burndown 要验证 `/goal` 的 8 次续跑上限与 40,000 字 transcript 截断（RULEBOOK §5 与 ROADMAP phase 11 验收标准）。

## 标记状态

`agent-harness.ts` 当前只有 1 处 `TODO(port)`（在一个已弃用 API 处），未覆盖本文档所列 4 项。**编排者已派 fixer 补齐标记**——每个未移植 API 的最近落点需有 `TODO(port): <api> not ported — see migration/reviews/agent/gap-continuation.md (phase 11/13)`，否则 phase 19 的标记对账会漏掉它们。

---

# 更新（2026-08-04，phase 10）：deprecated PromoteAction variant 已补齐

phase 8 的 agent_harness implementer 把 `PromoteSummaryWhenSummaryContains` 标为"oracle 已 deprecated、无调用方 → 不移植"，留 `TODO(port): add if a caller needs it`。

**phase 10 证实它有调用方**：oracle `crates/coding-agent/src/triggers/dynamic.rs:584` 正是使用者（`promote_to_chat` 规则路径）。oracle 自己的注释也写明该 variant "still present for transition… downstream PRs remove it once all callers have migrated"——即在冻结的 `0a120dfd` 上它仍是活代码。

dynamic 单元的 implementer 因此跨包给 `packages/agent/src/harness/agent-harness.ts` 补了该 variant 与 `applyPromotion` 分支，并加 2 个测试（agent-harness.test.ts 20→22 全绿）。**编排者核实后确认此举正确**：不补的话 `promote_to_chat` 会是永久死代码（sub-agent 路径不产生结构化 `details`，非 deprecated 的那个 variant 会永远 fail-closed）。

教训：phase 8 判定"无调用方"时，调用方所在的 phase 10 还没移植。**跨 phase 的"死代码"判定必须等下游 phase 完成后复核**，不能在上游 phase 就定论。
