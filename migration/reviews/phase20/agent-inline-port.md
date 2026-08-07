# phase 20-4 · 移植 oracle `crates/agent` 内联单测

## 1. 去重：52 这个数

```
 60  oracle crates/agent 内联测试总数
 -8  名字已被 packages/agent/test 或 packages/coding-agent/test 直接引用
────
 52  ← ROADMAP 的「上界 52」
```

数字与 ROADMAP 完全吻合。与 phase 3 同样，52 是**上界不是缺口数**——按名字去重的假阴性率在这个
包里尤其高：本仓的 trigger / trigger-runtime / permission 测试是照着 oracle 规格写的，
但用的是英文散文式命名，一个 oracle 函数名都没提。

## 2. 52 条的逐条裁定

### 2.1 行为已被覆盖 —— 45 条

| oracle 文件 | 条数 | TS 对应 | 说明 |
|---|---|---|---|
| `harness/trigger.rs` | 9 | `trigger.test.ts` | 9 条逐条对得上：round-trip(:38)、snake_case(:45)、PascalCase(:51)、internally-tagged kind(:64)、replacement_policy snake_case(:72) 与必填(:83)、terminal set(:109)、custom_type(:160)、policy round-trip(:164) |
| `harness/trigger_runtime.rs` | 8 | `trigger-runtime.test.ts` | 8 条逐条对得上：:40 / :48 / :65 / :77 / :87 / :96 / :128 / :136 |
| `harness/permission.rs` | 3 | `permission.test.ts` | :9 / :86 / :105 |
| `harness/notification_hook.rs` | 4 | `notification-hook.test.ts` | :14 / :44 / :52 / :63 |
| `harness/system_prompt.rs` | 2 | `system-prompt.test.ts` | :29 / :33（另有 :51 逐字节布局，比 oracle 更严） |
| `harness/prompt_templates.rs` | 2 | `prompt-templates.test.ts` | :152 插值；:40 frontmatter 名 |
| `harness/utils/truncate.rs` | 2 | `truncate.test.ts` | TS 做的是逐字节边界穷举比对，覆盖面**超过** oracle 那两条 |
| `harness/skills.rs` | 5/6 | `skills.test.ts` :97/:119、`resource-formatting.test.ts` :14 | description 必填、kebab 校验、frontmatter 解析、无 frontmatter 透传、调用块格式 |
| `harness/env/native.rs` | 4/6 | `nodejs-env.test.ts` :236/:267、:247、:274、:332 | 正常完成、流式回调、超时、中止 |
| `compaction/compaction.rs` | 6/10 | `compaction.test.ts` :161、:862、:798、:161(enabled:false)、:365+:156、:177/:195/:248 | 阈值、maxTokens 上限、溢出重试、禁用、last-usage、切点 |

### 2.2 真缺口，本次移植 —— 7 条

| # | oracle `#[test]` | 落点 |
|---|---|---|
| 1 | `summary_budget_leaves_room_for_output_and_estimate_error` | `ported/compaction-prompt-budget.test.ts` |
| 2 | `summary_budget_caps_single_oversized_message` | 同上 |
| 3 | `cjk_truncation_respects_token_budget` | 同上 |
| 4 | `compact_trims_summarizer_prompt_before_provider_call` | 同上 |
| 5 | `exec_preserves_stdout_stderr_without_inventing_trailing_newlines` | `ported/exec-stdio-and-env-paths.test.ts` |
| 6 | `exec_high_stderr_volume_does_not_deadlock_stdout_drain` | 同上 |
| 7 | `env_path_helpers` | 同上 |

合计 45 + 7 = 52。

## 3. 这一批里唯一的实现缺口：摘要提示预算

前四条**此前在本仓无处安放，因为本仓没有这一层**。`compaction.ts` 的注释里半声明过：

> an exact byte-budget port isn't available at this layer — this keeps the same observable
> behavior (never fail compaction outright on overflow; retry with less, disclosed, content)

实际差异不是「形式上的」：

| | oracle | 本仓（改前） |
|---|---|---|
| 何时裁剪 | **发送前**算预算、裁到预算内 | 发出去，等 provider 以 context-overflow 拒绝，再折半重试 |
| 余量 | `(window - output) × 4/5`，刻意留 20% | 无——把余量交给 provider 判断 |
| 单条超大消息 | 序列化后做尾部截断，按**字符类别**估 token | 只能丢消息，丢光了还剩那一条 |

后果两条：每次超限白烧一个来回连同那次的输入 token；更要紧的是，有的 provider 遇到超限是
**静默截断**而不是报错——那种情况下本仓会拿到一份被悄悄削过的摘要，且没有任何信号。

**处置：实现并接入**（`summarizationPromptBudget` / `serializeConversationForSummaryBudget`
及其内部的 `trimMessagesForSummaryBudget` / `suffixStartForTokenBudget`，均逐行对齐
`compaction.rs:345-484`）。溢出重试保留为兜底——预算是估算，估错了还有第二道。

`estimateTextTokens`（ascii/4 + nonAscii）此前**已经**忠实移植，缺的只是拿它做发送前裁剪。

## 4. 「一上来就红」

**归类为实现缺陷的：0 条。** 7 条移植测试在实现补齐后一次通过；改前那 4 条无法运行
（被测函数不存在），不属于「初红」而属于「无处安放」，已在 §3 单列。

env 路径助手为可测性从模块私有改为 `export`（四个纯函数，无行为改动）——oracle 也是直接测它们。

## 5. 负控（三条，全部实测，变异均带 assert 确认落地）

| # | 变异 | 结果 |
|---|---|---|
| 1 | 预算公式去掉 20% 余量（`×4/5` → 原值） | `expected 183616 to be less than or equal to 146892` **红** |
| 2 | 尾部截断的 token 估算退化成「一律按 1/4 计」（即 bytes/4 那种） | `expected 5532 to be less than or equal to 2000` **红** |
| 3 | `dirnameEnvPath("/c")` 返回空串而非 `"/"` | `expected '' to be '/'` **红** |

第 2 条的数字值得记下来：CJK 按字节估算时实测 5532 token 撑爆 2000 的预算，**2.8 倍**，
与 oracle 注释里「低估约三倍」的说法吻合。这条是整组最有判别力的一条。

## 6. 工程检查

```
npm run build   成功
npm run check   7 道门禁全绿
bash test.sh    exit 0；合计 4235 passed / 0 failed
                （agent 450 + ai 484 + coding-agent 2634 + mcp 38 + tui 612 + workers 17）
```

agent 包 443 → **450**，正好是本 phase 新增的 7 条。
