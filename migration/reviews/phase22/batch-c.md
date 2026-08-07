# 批 C —— agent 主循环（49/49）

`roster.tsv` 中 `batch=C` 的 49 个函数，全部有裁定。

## 裁定分布

| 裁定 | 条数 |
|---|---|
| `existing-test` | **30** |
| `new-test` | **8** |
| `not-portable` | **11** |
| 合计 | **49** |

## 压缩三件套 —— 本批最有价值的部分

`estimate_context_tokens` / `should_compact` / `compact` 各自拿到了**精确数值断言**：

| 函数 | 证据 | 为什么这条强 |
|---|---|---|
| `should_compact` | `compaction.test.ts:170` | `shouldCompact(80001, 100000, settings)` → `true`，下一行 `80000` → `false`。**阈值边界两侧都断言了**——差一个 `>` 和 `>=` 就会红 |
| `estimate_context_tokens` | `compaction.test.ts:358` | `estimateContextTokens([...]).lastUsageIndex` 的精确值，不是「大于 0」这种 |
| `compact` | `compaction.test.ts:285` | `result.summary` 的精确内容 + `faux.state.callCount === 0`（验证短路时没调模型） |

这三个错了的后果是**静默丢上下文**：模型突然「忘了」前面说过的话，没有任何错误信息。
它们此前在名册里，说明 `check:surface-coverage` 只验证了名字对得上。

## `not-portable` 11 条 —— 出现一个新形态

除了已知的两类（TS 侧零命中、刻意合并），本批出现第三类：

### 可测，但只能 tautology

`agent_harness.rs::set_compaction_settings` 在 TS 侧**存在**（`agent-harness.ts:1954`），
但它只是把 settings 存进 harness。它的效果全部经 `shouldCompact` / `compact` 观察，
而那两条已各有强证据。为它单写一条只能断言「存进去又读出来」——那是 tautology，
不是行为证据。

记 `not-portable` 并写清理由，比硬凑一条假证据诚实。这类在批 D 又出现一次
（`mcp/http.rs::set_auth`）。

### 其余 10 条

| 类型 | 函数 |
|---|---|
| TS 侧零命中 | `types.rs::as_str` · `as_audit_str` · `default_stream_fn` · `agent_harness::force_compact` |
| 命名差异 | `agent.rs::enqueue_follow_up`（TS 是 `Agent.followUp`）· `convert_to_llm`（TS 是 `AgentOptions.convertToLlm` 钩子）· `env/native::current`（TS 是 `NodeExecutionEnv.cwd` 字段） |
| 缺省实现内联 | `types.rs::default_convert_to_llm` |

## 新写的测试

`packages/agent/test/ported/batch-c.test.ts`，15 例，覆盖 8 个函数：

| 函数 | 测的是什么 |
|---|---|
| `agent.rs::new` | 干净初始状态；**两个实例不共享队列**（守「不是模块级单例」） |
| `agent.rs::state` | 同时暴露 `messages` 与 `isStreaming` |
| `agent.rs::enqueue` / `has_items` / `drain` | steering 与 follow-up 是**两个独立队列**——清错一个会丢掉用户排好的后续消息 |
| `types.rs::new@52` / `new@83` | `FileError` 与 `ExecutionError` 各自的构造器。**名册的键带 oracle 行号正是为了区分这两个同名函数**（见 README） |
| `notification_hook.rs::pending` | 四个可选字段必须是 **`null` 不是 `undefined`**——`JSON.stringify` 会丢掉 `undefined` 的键，静默改变线格式。实现注释专门写了这一点 |

### 这批 15 例一次通过

前四批各被抓出一次「猜 API 而没读」。本批写之前先 `grep` 了 `Agent` 的方法列表，
发现公开面是 `steer` / `followUp` / `hasQueuedMessages` / `clearAllQueues`，
而不是我原本假设的 `enqueueSteering`。**先读再写，省掉了一轮返工。**

## 抽查（规则先于结果声明）

**规则**：批 C 的 `existing-test` 共 30 条，抽 `max(5, ⌈30/3⌉)` = **10** 条，
按 `evidence.tsv` 中本批行的出现顺序等距取（步长 3，从 index 0 起）。
规则与 10 个抽中项在核实**之前**已打进 transcript。

**10 条全部通过三问，且全部是强断言**——`toMatchObject` / `toEqual` / 精确数值，
本批**没有出现** `toBeDefined()` / `not.toThrow()` 这类弱断言（批 A 有 2 条、批 B 有 2 条）。

抽中项：`agent::abort` · `agent::subscribe` · `agent_harness::prompt` ·
`reload_skills_from_disk` · `set_thinking_level` · `compaction::generate_summary` ·
`cost::reset` · `permission::default_for_coding_agent` · `types::label` · `cost::new`。

## `anchor` 规则的收益在本批兑现

行号漂移在本批发生 **7 次**：

- 5 次是我往测试文件里追加内容（后面所有行下移）
- 2 次是 `npm run check` 里的 `biome check --write` 重排版（把断言拆成多行）

门禁每次都**直接给出正确行号**（「锚点现在在第 N 行。改成它即可」），零手工查找。
这条规则是 phase 3「同类失败第三次 → 停修实例、改规则」的产物。

## 命令与结果

```
node scripts/find-behavior-evidence.mjs C     44 条待裁定 → 34 有候选 / 10 无候选
node scripts/check-behavior-evidence.mjs      批 C 49/49；累计 161/282（57.1%）
npm run check                                 exit 0（11 道门禁）
bash test.sh                                  exit 0 — 4384 passed / 0 failed
                                              基线 4319 → +65，只增不减
密闭性                                        ~/.pie/sessions 3297 → 3297，增量 0
```
