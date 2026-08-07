# Phase 13 · 可达性审计（编排者已逐条复核）

**触发**：批次 A 报告 `packages/agent/src/harness/agent-harness.ts` 在产品里无调用方。
**前例**：phase 12 的 B8——复刻在 CLI 不用的 `jsonl-storage.ts` 上，真实路径是 `core/session-manager.ts`。
**方法**：从 `cli.ts → main.ts` 沿 import 图判定可达性；以**实际 import 的符号**为准（`index.ts` 的 `export *` 面不算数）。

## 1. harness 模块可达性：28 个中 5 个按值可达、2 个仅类型、**21 个死**

按值可达（真正在跑）：`session/uuid.ts`、`detach.ts`、`async-queue.ts`、`select.ts`、`notification-hook.ts`
仅类型可达：`trigger.ts`、`types.ts`
**死**：`agent-harness.ts`、`trigger-runtime.ts`、`compaction/*`、`session/*`（除 uuid）、`cost.ts`、`messages.ts`、`permission.ts`、`prompt-templates.ts`、`skills.ts`、`system-prompt.ts`、`utils/*`、`async-mutex.ts`、`env/nodejs.ts`

**死的绝大多数是"重复"而非"缺失"**：compaction、session、skills、prompt-templates、system-prompt、messages、truncate 都存在两份，CLI 恒选 `coding-agent/src/core/` 那份。

一个不构成豁免的细节：`core/extensions/loader.ts:10,52` 以 namespace 方式把整个 `@pie/agent-core` 注册为第三方扩展的虚拟模块——所以死文件会被**加载**且**可被扩展调用**，但没有任何 CLI 控制流进入它们。

## 2. §5 BUG 台账 → 复刻站点 → 可达性（**最重要的一张表**）

| id | 复刻站点 | 可达 | 产品路径上的等价物 |
|---|---|---|---|
| B1 | ai/providers/openai-responses-shared.ts:537 | **活** | 同文件即产品路径 |
| B2 | ai/providers/openai-completions.ts:1061 | **活** | 同上 |
| B3 | agent/harness/cost.ts:9 | 死 | **效果经另一站点存活**：provider 从不算 `usage.cost`（B3a），`core/agent-session.ts:3002` 求和得 0 |
| B3a | ai/providers/*.ts（8 个文件） | **活** | 产品路径 |
| B4 | agent/harness/agent-harness.ts:1676 | 死 | **该缺陷在产品路径上不存在**——`budgetCap` 在 coding-agent/src 零命中，CLI 连有缺陷的预算门都没有 |
| B5 | coding-agent/mcp-loader.ts:12,212,331 | **活** | 批次 A 已接线 |
| B6 | coding-agent/triggers/cron.ts:545,1340,1517 | 死 | **产品路径上不存在**——CLI 无 cron 子系统 |
| B7 | coding-agent/triggers/cron.ts:578,1457 | 死 | 同 B6 |
| B8 | (a) harness/session/jsonl-storage.ts:146 **死** / (b) core/session-manager.ts:466 **活** | **活（经 b）** | 修正 phase 12 的认知：B8 被复刻了**两次**，一死一活 |
| B9 | agent/harness/trigger-runtime.ts:134 | 死 | **产品路径上不存在**——CLI 无 dedup 窗口实现 |
| B10 | coding-agent/tools/task.ts:183 | 死 | **产品路径上不存在**——无 task/subagent 工具 |
| B11 | coding-agent/tools/memory.ts:283 | 死 | 同 B10——无 memory 工具 |
| B12 | ai/providers/openai-responses-shared.ts:606 | **活** | 产品路径 |
| B13 | coding-agent/lsp-supervisor.ts:23,143 | **活** | 批次 A 已接线 |

**14 条里 6 条只复刻在不可达代码上**（B4/B6/B7/B9/B10/B11），另有 B3 的 harness 层复刻已死但效果经 B3a 存活。
这 6 条的测试全部通过**直接驱动死模块**而绿，因此既不可能与 oracle 分歧、也不可能察觉产品做了别的事——**这就是 parity 假绿的确切形态**。

## 3. agent-harness 六项行为在产品路径上的存在性

| 行为 | harness 有 | coding-agent 有 | 结论 |
|---|---|---|---|
| B4 budget cap | 是 | **否**（零命中） | 仅库内死代码，产品无此功能 |
| 自动压缩 / compact() | 是 | 是（`core/agent-session.ts:1665/1896/1906-2079`，用 `core/compaction/`） | **双份实现**，CLI 用自己那份；harness 那份无 parity 价值 |
| trigger promotion | 是 | 仅在死文件里（`triggers/cron.ts:826-880`） | 两边都无（产品路径）——两个死实现，零个活的 |
| 权限门 | `PermissionClassification` 在 types.ts | 仅在死文件里（`src/tools/*`、`triggers/*-deps.ts`） | **两边都无**；`core/agent-session.ts` 与 `core/tools/index.ts` 无任何权限/审批逻辑 |
| runEvaluator / continuation（/goal） | 是 | `goal.ts` 有实现但**零导入者** | 库内死 + CLI 死 |
| skills 热重载 | 是 | **否** | 仅库内死代码 |

**根因（结构性）**：`core/agent-session.ts:89` 的 `import ... from "./tools/index.ts"` 从 `core/` 解析到 **`core/tools/index.ts`**（pi 的 read/bash/edit/write/grep/find/ls），而非同级的 `src/tools/index.ts`。因此**整个 pie 工具移植（task、memory、skill 家族、git、web-fetch、web-search）都是孤儿**，只有 `tools/mcp-adapter.ts` 经 `mcp-loader.ts:43` 存活。

## 编排者复核（已独立验证，非转述）

- `src/tools/index.ts` 零导入者 ✓（所有 `tools/index.ts` 命中都解析到 `core/tools/index.ts`；`tools/index.ts:58` 自己反而 import `../core/tools/index.ts`，是个没人用的包装层）
- `triggers/index.ts` 零导入者 ✓
- `goal.ts` 零导入者 ✓
- `budgetCap|budget_cap` 在 coding-agent/src 命中数 = **0** ✓

## 方法论修正（重要，改变后续核查方式）

phase 12 从 B8 得出的教训是"复刻可能落在死路上"。**这个总结不准确**：B8 实际是**复刻了两次，一死一活**。
因此后续核查每条 BUG 时，`grep "BUG(port): B<n>"` **命中一处不足以定性**——必须枚举全部命中并逐个判可达性。同一个结论适用于所有"已移植"的判定：**存在 ≠ 可达**。

## 与 phase 13 使命的关系

ROADMAP 对 phase 13 的定义是「把 10–12 的器官接成活体」。本审计恰好量化了"哪些器官还没接上"，因此**不是对既往 phase 的否定，而是 phase 13 的工作清单**。但它也说明：manifest 的 156/205 是**移植进度**，不等于**产品可用进度**——两者的差额正是本审计列出的孤儿子系统。

## 由本审计产生的 phase 13 接线清单（编排者）

| # | 接线 | 影响的台账/行为 |
|---|---|---|
| T1 | `src/tools/index.ts` 的 pie 工具注册表接进 CLI 的工具注册 | B10、B11 复活；task/memory/skill 家族/git/web-fetch/web-search 上线 |
| T2 | `triggers/index.ts`（cron/dynamic/inbox）接进 main | B6、B7 复活；pie 相对 pi 的核心增量上线 |
| T3 | `goal.ts` 接进命令面 | `/goal` 上线；runEvaluator/continuation 复活 |
| T4 | 权限分类接进工具执行路径 | 目前产品**完全没有权限门**——同时是假绿与安全风险 |
| T5 | `logging.ts` / `debug.ts` 接进 main（批次 D 交付，见 pending-amendments W1/W2） | 日志 sink 上线 |

**B4（budget cap）与 skills 热重载**：产品路径上根本不存在该功能，不是接线问题而是**移植落位问题**——需决定落到 `core/agent-session.ts` 还是随 harness 一起接入。留待接线清单执行时逐项裁决。
