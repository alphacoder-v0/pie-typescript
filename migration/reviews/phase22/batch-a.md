# 批 A —— 会话与历史（52/52）

`roster.tsv` 中 `batch=A` 的 52 个函数，全部有裁定。

## 裁定分布

| 裁定 | 条数 |
|---|---|
| `existing-test` | **41** |
| `new-test` | **6** |
| `not-portable` | **5** |
| 合计 | **52** |

（其中 5 条在 phase 3 的校准探针里已裁定，本 phase 补齐余下 47 条。）

## 效率：定位器让这批比校准快一个数量级

phase 3 手工裁定 30 条用了约 **45 轮**工具调用。本批 47 条用了约 **12 轮**——
差别全在 `scripts/find-behavior-evidence.mjs`：它把 phase 3 六次筛选试错的经验固化下来，
一条命令跑出全批候选，人只需要**核实**而不是**搜索**。

定位器做对的四件事（每一件都对应 phase 3 的一个教训）：

1. 从**实现文件里读**真实符号名，而不是自动 snake_case→camelCase 推导
2. 找**调用点 + 其后最近的断言**，而不是只找同一行（真实测试多是两行分开）
3. 同时认 `expect(` 与 `assert`（tui 用 node:test）
4. 为每条候选算好锚点并标注唯一性

## 但候选仍需逐条人工核 —— 假阳性率约 40%

定位器给出 35 条候选，核实后**有 14 条是假的**。典型：

| 函数 | 定位器给的 | 为什么是假的 |
|---|---|---|
| `memory_repo::create` | `expect(await repo.open(metadata)).toBe(session)` | 那是 `open` 不是 `create`；正确的在下一行 `repo.list()` |
| `session::append_model_change` | `expect(context.thinkingLevel).toBe("high")` | 那是 thinking level；`model` 的断言在下一行 |
| `session::append_session_name` | `entry.type === "label"` | label 是 `appendLabel` 的产物；`session_info` 才是 |
| `session/mod::is_empty` | `expect(h.isEmpty()).toBe(true)` | 那是 `HistoryStore.isEmpty`，不是会话侧的 |
| `history::len` | agent-harness.test.ts 的 `resultEntry` | 完全无关 |
| `session/mod::cron_sidecar_path` | session-archive 的「前置条件」断言 | 间接，没有直接验证路径派生 |

**14 条里有 9 条只需在同一测试块内下移一到两行**（`:17→:18`、`:31→:32`、`:95→:96`），
另 5 条需要另找或新写。这个模式值得记：定位器取的是「调用后第一条断言」，
而一个测试往往先断言 setup 的中间结果、再断言真正要测的东西。

## `not-portable` 5 条 —— TS 侧确实没有

| 函数 | 情况 |
|---|---|
| `agent_harness.rs::prompt_with_images` | phase 3 已判；`packages` 下零命中 |
| `ai/event_stream.rs::event_type` | phase 3 已判；AWS Bedrock 二进制帧解析器未移植 |
| `agent_session.rs::is_retryable_error` | `isRetryableError` 零命中；重试判定在 `ai/retry.ts` 里内联 |
| `session/mod.rs::cron_sidecar_path_for_session` | 零命中；本仓只有 `cronSidecarPath(sessionPath)`，by-session-id 那层未移植 |
| `session/mod.rs::trigger_sidecar_path_for_session` | 同上 |

**累计 5 / 77 已裁定 ≈ 6.5%。** phase 3 时是 2/30 ≈ 6.7%，比例稳定。
外推到 282 条约 **18 个**——这是 `check:surface-coverage` 报「已匹配」而实际不存在的量，
它的「未匹配 40/513」确实低估了缺口。

## 抽查（规则先于结果声明）

**规则**：批 A 的 `existing-test` 共 41 条，抽 `max(5, ⌈41/3⌉)` = **14** 条，
按 `evidence.tsv` 中本批行的出现顺序等距取（步长 `⌊41/14⌋` = 2，从 index 0 起）。
规则与 14 个抽中项在核实**之前**已打进 transcript。

每条问三件事：①指向的是这个函数的行为吗 ②这条断言失败时，被测函数是否一定出错
③是不是 tautology。

**结果：14 条全部通过。** 其中 5 条做了完整的上下文核实：

| 抽中项 | 三问结论 | 备注 |
|---|---|---|
| `jsonl_repo::list` → `session-storage.test.ts:60` | 是 / 是 / 否 | `const files = await repo.list()` 紧接 `expect(files).toHaveLength(1)` |
| `session::get_entry` → `session.test.ts:76` | 是 / 是 / 否 | `toMatchObject({type, parentId, fromId})`，强断言 |
| `uuid::uuidv7` → `session-uuid.test.ts:34` | 是 / 是 / 否 | 断言精确 uuid 值（测试注入了固定时钟） |
| `history::load` → `history.test.ts:133` | 是 / 是 / 否 | **偏弱**：`not.toThrow()` 只验证不抛，不验证读到什么。测试自己的注释写了「Smoke-test」 |
| `automation_elsewhere_hint` → `session-dir-purity.test.ts:74` | 是 / 是 / 否 | **偏弱**：只断言 `undefined`；同块下一行 `expect(createdEntries()).toEqual([])` 更强 |

两条「偏弱」都通过了判据（断言失败时函数确实一定出错），但值得记：
**`not.toThrow()` 这类断言证明的是「没崩」，不是「对」。** 后续批次遇到同形的应优先找更强的。

## 新写的测试

`packages/coding-agent/test/ported/batch-a.test.ts`，12 例，覆盖 6 个函数：

| 函数 | 测的是什么 |
|---|---|
| `repo_utils::create_session_id` | uuidv7 形状 + **64 次不重复**（重复意味着第二个会话覆盖第一个的 JSONL） |
| `repo_utils::create_timestamp` | ISO-8601 带 `Z` + 经 `Date` 往返不丢瞬间 |
| `history::len` | TS 侧是 **getter `length`** 不是方法 `len()`；计数 / 空表 / 追加后跟随 |
| `session/mod::trigger_sidecar_path` | `.triggers.json` 扩展名——**扩展名是合同的一部分** |
| `session/mod::cron_sidecar_path` | `.cron.toml`（注意是 toml 不是 json），且与 triggers 的路径不同 |
| `session/mod::resume` | 两条失败路径各有明确错误：空目录 / id 不存在。静默返回别的会话是最坏结果 |

写这批时被运行时抓出一处**我的测试错误**：`resolveResumeSessionPath(dir, "zzz")` 在空目录下
抛的是「no sessions to resume」而不是「no session matches id zzz」——
因为「无会话可续」的检查排在 id 匹配之前。不先放一个会话文件就测不到 id-not-found 那条路径。
已修（注释记在测试里）。

## 命令与结果

```
node scripts/find-behavior-evidence.mjs A     47 条待裁定 → 35 有候选 / 12 无候选
node scripts/check-behavior-evidence.mjs      批 A 52/52；累计 77/282
                                              existing-test 57 · new-test 15 · not-portable 5
npm run check                                 exit 0（11 道门禁）
bash test.sh                                  exit 0 — 4355 passed / 0 failed
                                              （agent 455 · ai 488 · coding-agent 2737 · mcp 46 · tui 612 · workers 17）
                                              基线 4319 → +36，只增不减
密闭性                                        ~/.pie/sessions 3297 → 3297，增量 0
```
