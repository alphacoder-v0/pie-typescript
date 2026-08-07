# 批 B —— 触发器与目标（45/45）

`roster.tsv` 中 `batch=B` 的 45 个函数，全部有裁定。

## 裁定分布

| 裁定 | 条数 |
|---|---|
| `existing-test` | **32** |
| `new-test` | **9** |
| `not-portable` | **4** |
| 合计 | **45** |

（其中 5 条在 phase 3 校准探针里已裁定。）

## 「★导入了实现」这个信号显著降噪

定位器给候选排序时，把**导入了实现模块的测试文件**排在前面。这一批里它几乎完全消除了
批 A 那种「匹配到别处同名符号」的假阳性：带 ★ 的 19 条候选，核实后 **18 条为真**（假阳性率 5%，
批 A 是 40%）。

唯一那条假阳性也很说明问题：`dynamic.rs::storage_path` 的候选指向
`cron-tool-bugs.test.ts:152` 的 `globalCronRegistry().storagePath()`——
**同名方法，但属于另一个 registry**。★ 标记不区分「导入了 dynamic.ts」和「导入了 cron.ts」，
因为那个测试文件两个都导入了。

## `not-portable` 4 条

| 函数 | 情况 |
|---|---|
| `trigger.rs::is_terminal` | `isTerminal` 零命中；终态判定在本仓由调用方直接比较字面量，没抽成谓词 |
| `trigger.rs::received_from` | `receivedFrom` 零命中；本仓的 trigger 事件直接带 source 字段 |
| `trigger_runtime.rs::with_config` | `withConfig` 零命中。**这条有源码级说明**：`trigger-runtime.ts:92-96` 的注释写明「Replaces the oracle's separate `TriggerRuntime::new()` and `TriggerRuntime::with_config(config)` — a single constructor covers both」 |
| `dynamic.rs::storage_path` | TS 侧的 `storagePath` 是 `DynamicTriggerRegistryState` 的**私有字段**（dynamic.ts:336/340），不是公开方法 |

`with_config` 那条值得单独说：它不是「漏了」，是**移植时刻意合并**的，而且合并理由写在了实现的注释里。
这类「oracle 两个函数 → TS 一个」的合并，用「TS 侧有没有同名符号」去判会误判成缺失；
是读到实现注释才确认的。**后续批次遇到 `new` / `with_*` 这类构造器族要特别留意。**

累计 `not-portable` **9 / 117 ≈ 7.7%**（phase 3 是 6.7%，批 A 后是 6.5%）。

## 抽查（规则先于结果声明）

**规则**：批 B 的 `existing-test` 共 32 条，抽 `max(5, ⌈32/3⌉)` = **11** 条，
按 `evidence.tsv` 中本批行的出现顺序等距取（步长 2，从 index 0 起）。
规则与 11 个抽中项在核实**之前**已打进 transcript。

**结果：11 条全部通过三问。** 两条偏弱：

| 抽中项 | 断言 | 为什么偏弱 |
|---|---|---|
| `cron::add_job` → `calibration-batch.test.ts:82` | `expect(traceId).toBeDefined()` | 断言的是 `dueJobs` 返回的 traceId。addJob 没加成功则 dueJobs 无 job、traceId 为 undefined，所以「断言失败⇒函数出错」成立；但它不验证 job 的**内容** |
| `cron::storage_path` → `cron-tool-bugs.test.ts:152` | `expect(sidecar).toBeDefined()` | 只验证非 undefined，不验证路径本身对不对 |

与批 A 记的是同一类：**`toBeDefined()` / `not.toThrow()` 证明的是「有东西」「没崩」，不是「对」。**
这两条留在证据表里（判据成立），但在 closeout 里会汇总为「弱证据」计数。

## 新写的测试

`packages/coding-agent/test/ported/batch-b.test.ts`，14 例，覆盖 6 个函数：

| 函数 | 测的是什么 |
|---|---|
| `cron::new` / `dynamic::new` | 构造出来是空的，且**两个实例不共享状态**（守「不是模块级单例」——串了两个会话的 cron 就会互相看到） |
| `cron::remove_job` | 返回被删的 job · 未知 id 返回 undefined 且不动别的 · **id 会 trim**（oracle 是 `id.trim()`） |
| `cron::job_for_trace` | 按 running trace 反查；查错了会把 A 的完成状态写到 B 头上 |
| `dynamic::add_rule_with_flags` | `fireOnce` 与 `promoteToChat` 两个标志**独立**落到规则上——上层 add 都转调它 |
| `inbox::default_inbox_path` | 文件名是 `inbox.jsonl`（**不是 `.json`**——inbox 逐行追加） |

写这批时被运行时抓出一处**我的猜测错误**：我按惯例写了 `inbox.json`，实际是 `inbox.jsonl`
（`inbox.ts:59`）。这是本轮第 4 次「猜 API 而没读」被测试抓住（前三次：`markRunning` 不存在、
`GoalState` 无 `text` 字段、`appendMessage` 返回 id 字符串）。

## 命令与结果

```
node scripts/find-behavior-evidence.mjs B     40 条待裁定 → 32 有候选 / 8 无候选
node scripts/check-behavior-evidence.mjs      批 B 45/45；累计 117/282（41.5%）
                                              existing-test 87 · new-test 21 · not-portable 9
npm run check                                 exit 0（11 道门禁）
bash test.sh                                  exit 0 — 4369 passed / 0 failed
                                              （agent 455 · ai 488 · coding-agent 2751 · mcp 46 · tui 612 · workers 17）
                                              基线 4319 → +50，只增不减
密闭性                                        ~/.pie/sessions 3297 → 3297，增量 0
```

### 一次 environment 失败（已复跑确认）

首次跑 `test.sh` 时 `anthropic-oauth.test.ts` 红 5 条，全部是
`Error: listen EADDRINUSE: address already in use 127.0.0.1:53692`——该测试绑**固定端口**，
撞上了机器上的其他进程。归类 **environment**：本轮未触碰 `packages/ai`，
且复跑（端口释放后）5 条全绿。记录在此而不是悄悄重跑，因为「重跑就好了」正是掩盖真回归的说法。
