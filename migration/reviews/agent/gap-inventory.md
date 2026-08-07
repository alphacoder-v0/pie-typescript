# Phase 8 实现缺口清单（由 char-tests 移植量化）

批次 H 把 oracle `crates/agent/tests/` 的 113 个集成测试 1:1 移植为 vitest，结果 **75 通过 / 38 跳过 / 0 失败**。38 个跳过全部是实现缺口（`it.skip` + 内联理由，或 `it.fails` + 保持 oracle 强度的断言），不是弱化断言。

## 编排者分类与处置

| # | 缺口 | 阻塞测试数 | 判定 | 处置 |
|---|---|---|---|---|
| 1 | **Issue #110 ControlPlaneWrite 用户 Prompt 门**：`PermissionClassification`/`OnControlPlanePromptHook`/`ControlPlanePromptDecision`/`ControlPlanePromptRequest`/`AgentEvent.ControlPlanePromptResolved` 的**实现**（类型已由批次 G 补进 types.ts） | 12 | **phase 8 内补** | agent-loop.ts 接线（pie 权限门核心；cron-deps.ts:66-71 等它） |
| 2 | `AgentHarness.systemPrompt()` getter + base/skills 自动组装 | 2 | **phase 8 内补** | resume 后系统提示需字节一致，是 parity 关键 |
| 3 | `promptFromTemplate` 用 bash 位置参数而非 `{{var}}` 插值 | 1 | **phase 8 内补** | 批次 E 已建 `PromptTemplateRegistry`，只需接线 |
| 4 | 无 `rehydrateFromSession`；`navigateTree` 不重建 thinkingLevel/model | 2 | **phase 8 内补** | resume 语义 |
| 5 | `subscribeHarness` 只携带 trigger 生命周期事件（base 设计） | 1 | **待判定** | 需确认 oracle 的 HarnessEvent 面是否 judge 可观测 |
| 6 | `compact()` 无 per-harness `CompactionSettings` 覆盖、无优雅失败返回、无自动压缩接线 | 3 | **phase 8 内补** | 自动压缩是核心行为（B1 的下游效应正是它更早触发） |
| 7 | `abort()` 不取消 in-flight `onTriggerPrompt` hook（实测 30s 挂起） | 1 | **phase 8 内补** | 真实缺陷，会挂住进程 |
| 8 | `evaluatePromotionCondition` 私有且 `details` 恒 `undefined` | 3 | **phase 8 内补** | trigger promotion 的核心判定 |
| 9 | 无 `reloadSkillsFromDisk` 方法/事件 | 5 | **phase 8 内补** | skills 热重载 |
| 10 | 无 `OnTurnEndHook`/continuation 循环、无 `run_evaluator` | 7 | **交 phase 11/13** | 已决策，见 `gap-continuation.md` |
| 11a | `it.fails`：abort 时 TS 以 `stopReason:"aborted"` 消息 resolve `prompt()`，oracle 是 reject 且零持久化条目 | 2 | **待判定** | 需判哪边对：oracle 是 spec，但 base 行为可能是 pi 的有意设计 |
| 11b | `it.fails`：`cost_tracker_accumulates_across_turns` 的 `turnCount` 因 B3/B3a 的 cost 种子注入而双计 | 1 | **测试工件** | 非实现缺口，调整测试注入方式 |

## 已裁决无需处理

- `cut_point_anchors_on_user_message_even_around_trigger_custom`：批次 H 查证这是**已裁决**决定（ledger 的 `agent/harness/compaction/compaction` 行有记录），正确地跳过并引用，未重新翻案。

## 后续

编排者在批次 F（agent_loop.ts 等）完成后统一派 fixer 处理 #1–#9；#5、#11a 需先做 judge 可观测性判定（BUG-scope 规则）。
