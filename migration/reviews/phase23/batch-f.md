# 批 F —— agent 包 58 条

low 层里被第四轮判据 B∪C∪D（oracle 自测过 / 状态变更动词 / 返回 Result）漏掉的 agent 包部分。

## 裁定分布

| 裁定 | 条数 |
|---|---|
| `existing-test` | **30** |
| `new-test` | **3** |
| `not-portable` | **25** |
| 合计 | **58** |

`not-portable` 占比 **43.1%**，低于 60% 的闸门，无需成因分析。

## 新写的测试

`packages/agent/test/ported/batch-f.test.ts`，6 例，覆盖 3 个函数：

| 函数 | 测的是什么 |
|---|---|
| `estimateTextTokens` | **非 ASCII 的计费必须高于 ASCII**——算成一样的话，中文会话用量被系统性低估，压缩迟迟不触发，直到 provider 直接报超限 |
| `estimateTokens` | 结构化消息的多个 text 块必须**求和**——漏掉第二块会低估该轮，而低估在长会话里会累积 |
| `createCustomMessage` | `display=false` 与 `true` 必须可区分（它决定条目是否进 UI）；**参数收 ISO 串、字段存 epoch 毫秒** |

### 又一次被测试抓住的契约差异

我写的是 `expect(m.timestamp).toBe("2026-01-01T00:00:00Z")`。红了，实际返回 `1767225600000`。

读实现才发现：`createCustomMessage(…, timestamp: string)` 收 ISO 串，但字段里存的是
`new Date(timestamp).getTime()`。**这个转换值得钉死**——原样存字符串会让下游每一处
`timestamp` 比较失效，而且是**静默**失效：同格式字符串之间 `"2026-…" > "2025-…"` 恰好排序正确。

断言改成 `toBe(Date.parse(...))`，并把这个理由写进了测试注释。

## ⚠ 抽查抓出 2 条我刚写错的证据

**规则**（先于结果声明）：批 F 的 35 条非 not-portable 按出现顺序等距抽
`max(5, ⌈35/5⌉)` = **7** 条，步长 5，从 index 0 起。抽中 #0 · #5 · #10 · #15 · #20 · #25 · #30。

**7 条里 2 条不合格**：

| 抽中 | 我给的证据 | 问题 |
|---|---|---|
| #5 `agent_harness::session@1497` | `harness-e2e.test.ts:340`（rehydrateFromSession 的断言）| oracle 的 `session()` 是**公开取值器**；本仓 `agent-harness.ts:892` 是 `private session: Session`，**根本没有取值器**。我指的那条断言测的是另一个函数 |
| #30 `agent_harness::enqueue_follow_up@1584` | `agent.test.ts:301`（`agent.followUp` 的断言）| oracle 的 harness 方法转发给 Agent；本仓 harness **自己持有** `followUpQueue`（:907，私有），无公开入队方法。我指的是 **Agent 层**的同名函数——那是另一条名册条目（批 C 已裁定）|

两条都已改判 `not-portable` 并写清结构差异。

**这就是抽查的价值**：7 条抽中 2 条有问题（28.6%）。如果不抽，这两条会带着「有测试覆盖」的假象进入 513/513。

### 另一条在写入时被 `assert` 拦下

`agent_harness.rs::default_for@481` 我一度指向 `permission.test.ts:80`
（`PermissionPolicy.defaultForCodingAgent`）——**张冠李戴**。
oracle 的 `default_for(trigger)` 产的是 trigger action 的默认 prompt
（`"{source_label} fired: {event_label}"`），与权限策略毫无关系。

真证据是 `dynamic-tool.test.ts:410` 的 `expect(action.prompt).toBe("mcp:gh fired: pushed")` ——
那一行直接断言了那个格式串。

写入脚本的第一道 assert（「键必须在该批名册里」）先拦下了行号错误，
人工复核再拦下了语义错配。**两道关卡各挡住一类问题。**

## `not-portable` 25 条的形态

绝大多数是**取值器与构造器**：oracle 的 Rust 风格是给每个字段配 `fn field(&self)`，
给每种构造配一个 `new`/`with_*`；本仓要么把字段设为 private 不暴露、要么把多个构造变体
合并成单个 `constructor(options)`。

| 形态 | 例 |
|---|---|
| 私有字段无取值器 | `session()` · `storage()` · `root()` · `agent()` |
| 构造变体合并 | `agent_harness::new@873` 与 `@995` 合成一个 constructor |
| 枚举方法 → 字面量联合 | 三个 `as_audit_str`（分属不同 impl 块）|
| entry 取值 → 字段直读 | `session.rs::id@130` · `parent_id@145` |
| 批量版无独立后果 | `abort_all_triggers`（遍历调 `abortTrigger`，后者已有证据）|

判据 3 的机器验证：**25/25 条理由含 `packages/` 路径或 TS 标识符**（首次 24/25，一条补齐）。

## 命令与结果

```
node scripts/probe-ts-counterpart.mjs --batch F   58 条 → substantial+named 20 · substantial 38
node scripts/check-behavior-evidence.mjs          批 F 58/58；累计 425/513
npm run check                                     exit 0（11 门禁）
bash test.sh                                      exit 0 — 4410 passed / 0 failed（+6）
密闭性                                            ~/.pie/sessions 3316 → 3316，增量 0
```
