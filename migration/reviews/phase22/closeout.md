# 第四轮收口（supergoal `pie-medium-149-low-td9AgT`，10 phases）

用户选定的两件事，都做完了。

上一轮收口在 `migration/reviews/phase21/closeout.md`；本文件只写本轮。

---

## 1. 主线：282 个函数全部有行为裁定

`roster.tsv` 的 282 条 —— medium 层 149 全量 + 从 low 279 里按判据捞出的 133 —— **282/282 裁定完毕**。

| 裁定 | 条数 | 占比 |
|---|---|---|
| `existing-test` | **185** | 65.6% |
| `new-test` | **37** | 13.1% |
| `not-portable` | **60** | 21.3% |

**`existing-test` 命中率 = 185 / 222 = 83.3%**（分母不含 `not-portable`）。

### 按批

| 批 | 主题 | existing | new | not-portable | 小计 |
|---|---|---|---|---|---|
| A | 会话与历史 | 41 | 8 | 3 | 52 |
| B | 触发器与目标 | 32 | 9 | 4 | 45 |
| C | agent 主循环 | 30 | 9 | 10 | 49 |
| D | ai + mcp | 22 | 8 | **23** | 53 |
| E1 | coding-agent 上半 | 32 | 1 | 9 | 42 |
| E2 | coding-agent 下半 | 28 | 2 | 11 | 41 |
| | **合计** | **185** | **37** | **60** | **282** |

### 按来源

| 来源 | existing | new | not-portable |
|---|---|---|---|
| medium（扇入 ≥2） | 86 | 30 | 33 |
| low（本轮判据捞出） | 98 | 7 | 28 |

一个反直觉的结果：**low 层的 `existing-test` 命中率反而更高**（98/105 = 93% vs medium 的 86/116 = 74%）。
原因是本轮的捞取判据 B（oracle 自己在 `cfg(test)` 块里调用过它）天然偏向「已被重视的函数」，
而它们在 TS 侧往往也被移植测试覆盖了。

---

## 2. 附带：测试密闭性 —— 第四条边界关闭

`bash test.sh` 现在真正密闭。详见 `hermeticity.md`。

| | 真实 `~/.pie/sessions` |
|---|---|
| 跑 `test.sh` 前 | 3316 |
| 跑 `test.sh` 后 | 3316 |
| **增量** | **0** |

同一次运行里 **21 个会话目录 / 35 个文件**落在临时 `PIE_DIR` 内——那就是此前每跑一次测试
就泄漏进用户目录的量。

**根因与上一轮记录的不同**：不是「12 条测试缺夹具」，是它们设了优先级较低的
`PI_CODING_AGENT_DIR`，被 `PIE_DIR` 盖掉（`getAgentDir()` 的优先级是
`PIE_DIR` > `PI_CODING_AGENT_DIR` > `~/.pie`）。改用 oracle 自己的变量后，**断言一字未改**。

顺带发现并解决了上一轮没记录的一面：16 条 grep/find 测试需要 `$PIE_DIR/bin/{fd,rg}`。
区分「隔离状态」与「隔离工具依赖」后软链解决——测试需要 `rg` 就像需要 `node` 一样。

---

## 3. 计数前后对照

| 门禁 | 本轮开始 | 现在 | 说明 |
|---|---|---|---|
| `check:manifest` | 204/204，missing 0 | 持平 | 本来就满 |
| `check:surface-coverage` | 未匹配 40 / 513 | **持平** | 本轮不移植新函数，持平是正确结果 |
| `check:inline-test-ports` | 未匹配 190 / 541 | **持平** | 本轮新增测试不提及 oracle 内联测试名，不影响这个按名字匹配的计数 |
| `check:triage-ledger` | 121 条，TODO 0 | 持平 | 上一轮的名册，本轮不动 |
| `check:behavior-evidence` | **不存在** | **282/282，已收紧为「未满即失败」** | 本轮新增，第五道计数门禁 |

`npm run check` 现在是 **11 道门禁**。

---

## 4. `not-portable` 60 条 —— 这个数字本身是结论

60 / 282 = **21.3%**。它们不是「漏做」，分五类：

（原为 61 条。`ui/web.rs::run_web` 已改判——见文末「一条被我判错的裁定」。）

| 类型 | 条数（约） | 代表 |
|---|---|---|
| **整条路径未移植** | 5 | AWS Bedrock 二进制帧（`event_stream.rs` 全家 + `bedrock_anthropic`）—— `bedrock-provider.ts` 只有 6 行的占位模块 |
| **Rust 惯用法在 TS 不需要** | 12 | `as_str` / `known` / `is_terminal`（枚举方法 vs 字面量联合）· 各种 `text()` 构造器 vs 对象字面量 |
| **命名或结构差异** | 20 | `enqueue_follow_up`→`Agent.followUp` · `leaf_id`→`getLeafId` · `with_skills_root`→options 参数 · builder 链 vs 单构造器 |
| **可测但只能 tautology** | 8 | `set_compaction_settings` / `set_auth` / `cwd_hash` / `hooks::len` —— 效果已被别的函数的证据覆盖 |
| **需真实 I/O 或终端** | 8 | `mcp/http::connect` · `stdio::spawn` · `ui/mod::new` / `run`（由 parity S2 守） |

### ⚠ 这直接说明 `check:surface-coverage` 低估了缺口

它报「未匹配 40 / 513」，但本轮 282 条里有 **60 条**它算作「已匹配」而 TS 侧实际不存在同物。
按比例外推到全部 513 个公开函数，真实缺口远大于 40。

**这不是本轮引入的问题，是本轮发现的问题。** 它推翻了那个门禁给人的印象——
「513 个函数只剩 40 个没对上」听起来像 92% 完成度，实际那个数字只统计了名字。

---

## 5. 改动规模

| 类别 | 数量 |
|---|---|
| 新增测试文件 | 8 |
| 新增测试用例 | **84** |
| 套件总数 | 4319 → **4397**（+78，只增不减） |
| 新增脚本 | 3（`classify-behavior-impact` · `check-behavior-evidence` · `find-behavior-evidence`） |
| 新增文档 | 8（README · calibration · hermeticity · batch-a…e2 · 本文件） |
| 名册 / 证据表 | 各 283 行 |
| `src` 触碰 | 0 —— **本轮未改任何产品代码** |
| 测试夹具改动 | 4 个文件（密闭性）+ `test.sh` |

**`src` 零改动**是本轮的一个特征：主线是补证据而非改行为。唯一的行为面改动在 `test.sh`
（`PIE_DIR` 隔离 + 工具软链）。

---

## 6. 方法论：定位器把成本降了一个数量级

phase 3 的校准探针手工裁定 30 条用了约 **45 轮**工具调用，据此外推剩余 252 条要 **380 轮**。

实际用了约 **90 轮**。差别全在 `scripts/find-behavior-evidence.mjs` —— 它把 phase 3
六次筛选试错的经验固化下来：

1. 从**实现文件里读**真实符号名（自动 snake_case→camelCase 在 30 个样本里失败 5 次以上）
2. 找**调用点 + 其后最近的断言**（真实测试多是两行分开，只找同一行会漏掉大半）
3. 同时认 `expect(` 与 `assert`（tui 用 node:test）
4. 把**导入了实现模块**的候选排前面（★ 标记）—— 这一条把假阳性率从批 A 的 40% 压到批 B 的 5%
5. 为每条候选算好锚点并标注唯一性

**但它不自动写证据表。** 判断哪条候选是真的，始终是人的活——本轮六批累计抓出约 30 处假阳性，
包括「匹配到注释里的 `Arc::new`」「匹配到 goal 的 `set` 而非 skills_state 的」
「指向 cron registry 而非 dynamic registry 的同名方法」「指向的是注释行」。

---

## 7. 一条规则改动的复利：`anchor` 列

phase 3 里「行号漂移」连续失败三次（手填错 / 追加测试下移 / biome 重排版）。
按 RULEBOOK「复发失败上移」——**停修实例，改规则**：

`evidence.tsv` 加可选的第 4 列 `anchor`（断言行特征文本）。门禁行为：

- 行号指向的行含锚点 → 通过
- 行号不是断言行，但锚点在文件里唯一命中 → **报错并直接给出正确行号**
- 锚点 0 次命中 → 证据失效，需重新裁定
- 锚点多次命中 → 锚点不够独特

**这条规则在后续六批里省了约 20 次手工查找**，最后还做成了自动闭环
（解析门禁输出里的「锚点现在在第 N 行」并批量应用）。

### 修锚点时我差点毁掉一条证据

`clear_api_providers` 的锚点在文件里命中两次，我为了让它唯一，把证据改指了另一条断言——
那条与 `clearApiProviders()` **毫无关系**。已回退。教训记在 `calibration.md`：
**锚点冲突要么改写测试、要么在同一测试块内换断言，绝不能换到另一个测试块——那等于换了一件被验证的事。**

---

## 7b. 第二次规则上移：断言行判据收紧（phase 10）

批 E2 的抽查抓出一条假证据：`skills_state::apply` 指向 `skills-state-batch-c.test.ts:49`，
那是一行**注释**——移植测试里抄录的 oracle 断言原文：

```
//   assert!(skills[0].disable_model_invocation, "overlay disable applies");
```

门禁原来的判据 `/\bexpect\(|\bassert\b/` 对它无效：`\bassert\b` 匹配上了 Rust 的 `assert!` 宏。

这是同类问题第三次出现（前两次是指到 `it(...)` 行、指到 setup 行，都在上一轮）。
按 RULEBOOK「复发失败上移」，phase 10 **当场改规则**：

```js
const isAssertion = (text) => {
    const t = (text ?? "").trim();
    if (t.startsWith("//") || t.startsWith("*")) return false;   // 排除注释行
    return /\bexpect\(|\bassert\s*[.(]/.test(t);                  // assert 必须带 . 或 (
};
```

**收紧后的规则立刻抓出 2 条此前漏网的假证据**：

| 条目 | 原证据 | 问题 |
|---|---|---|
| `lsp::spawn` | 锚点 `* test can assert on the exact bytes the` | 指向 JSDoc 注释块 |
| `skills_state::load` | 锚点 `//   assert!(loaded.overrides.is_empty()` | 同样是抄录的 oracle 断言注释 |

两条已重新裁定到真断言（`lsp.test.ts:324` 的 `expect(initResult).toEqual({capabilities:{}})` 与
`skills-state-batch-c.test.ts:140` 的 `expect((await loadSkillsState(dir)).overrides).toEqual([])`）。

**一条规则改动，回溯抓出了两条已经通过审查的假证据。** 这是「改规则而非修实例」最直接的回报。

---

## 8. 五次「猜 API 而没读」

每次都被 tsgo 或运行时当场抓住，没有一次进了证据表：

| # | 我以为的 | 实际 |
|---|---|---|
| 1 | `CronRegistry.markRunning(id, trace)` | 不存在；job 经 `dueJobs()` 进入 running |
| 2 | `GoalState.text` | 真实字段是 `condition / status / iterations / last_reason? / updated_at` |
| 3 | `appendMessage()` 返回带 `.id` 的对象 | 返回 **id 字符串** |
| 4 | `defaultInboxPath()` → `inbox.json` | 是 `inbox.jsonl`（逐行追加） |
| 5 | `getImagesApiProvider()` 返回注册时那个对象 | 注册时**重建**并包装 `generateImages`，不是同一引用 |

第 3 条尤其值得记：我写的是 `expect(await session.getLeafId()).toBe(first.id)`，
而 `first.id` 是 `undefined`——**如果当时写的是 `toBeDefined()` 之类的弱断言，这个错误会静默通过。**

批 C 起我改成「写之前先 grep 公开面」，那 15 例一次通过。

---

## 9. 弱证据的坦白

抽查通过 ≠ 证据同样强。本轮有 4 条抽中项被标注「偏弱」：

| 抽中项 | 断言 | 弱在哪 |
|---|---|---|
| `history::load` | `expect(() => HistoryStore.load()).not.toThrow()` | 只证明「没崩」，不证明读到了什么。测试自己的注释写了「Smoke-test」 |
| `automation_elsewhere_hint` | `expect(hint).toBeUndefined()` | 同块下一行 `expect(createdEntries()).toEqual([])` 更强 |
| `cron::add_job` | `expect(traceId).toBeDefined()` | 断言的是 `dueJobs` 的产物，不验证 job 内容 |
| `cron::storage_path` | `expect(sidecar).toBeDefined()` | 不验证路径本身对不对 |

它们都通过了判据（断言失败时函数确实一定出错），但**`toBeDefined()` / `not.toThrow()`
证明的是「有东西」「没崩」，不是「对」**。批 C 之后优先找更强的断言，批 C/D/E 的抽查里
没有再出现这类。

---

## 10. 全链验证

```
npm ci                                   exit 0
npm run build                            exit 0
npm run check                            exit 0（11 道门禁）
bash test.sh                             exit 0 — 4397 passed / 0 failed
                                         agent 470 · ai 497 · coding-agent 2751
                                         · mcp 50 · tui 612 · workers 17
密闭性复验                                ~/.pie/sessions 3316 → 3316，增量 0
bash migration/parity/run-parity.sh      exit 1（预期）— 差异集恰等于声明基线 8 项
                                         S3/requests 2 · S3/run 8 · S3/session 12
                                         · S5/req2body 2 · S6/session 24
                                         · S8/list 2 · S8/resumeerr 2 · S8/resumeexit 2
                                         S1/S2/S4/S7 与 S9–S12 全 DIFF 0
bash migration/parity/run-parity.sh --self-check
                                         exit 0 — MUTATIONS DETECTED: 3/3
npm run test:live                        exit 1 — 26 failed / 526 passed
                                         **全部 environment，0 regression**（见下）
```

### `test:live` 的 26 条失败逐条归类

| 归类 | 条数 | 依据 |
|---|---|---|
| **environment** | 25 | 全部是 `401 {"type":"authentication_error","message":"invalid x-api-key"}` —— 本机**没有 Anthropic OAuth 凭据**。在场的只有 `GEMINI_API_KEY`（另有 `~/.sf-key`，0600） |
| **environment** | 1 | Gemini `context-overflow`：账号配额 1,000,000 tokens/分钟，**429 必然先于上下文溢出错误到达**。该用例要求「账号配额 > 模型上下文窗口」，上一轮已记录 |
| **regression** | **0** | 本轮 `src` 零改动，且 25 条的错因是 HTTP 401 而非断言不符 |

**凭据只报变量名，值从未打印。**

### 清洁度

本轮新增行中 `console.log` / `FIXME` / `XXX` / `HACK` / `@ts-ignore` / `eslint-disable`
计数**全部为 0**。

扫描报出的 5 处均为误报，已逐条核实：
- `console.log` × 4 —— 在 `package-command-paths.test.ts` 里是**测试构造的假 npm 可执行脚本的内容**
  （`if(args.includes("root")) console.log(...)`），是被测夹具的一部分；且全部是既有代码
- `XXX` × 1 —— 是 `mktemp -d "…/pie-test-home.XXXXXX"` 的模板占位符，不是 TODO 标记

---

## 11. 本轮新增的声明偏离

**无。** D1–D13 不变，`BUG(port)` 台账 B1–B18 不变。

`check-behavior-evidence.mjs` 加了第三类 `not-portable`（原规格写「无第三类」）——
这是**规格偏离**，理由已在 phase 3 论证并记入 `calibration.md`：
规格的前提「每个名册函数在 TS 侧都有对应物」被 30 个抽样里的 2 个反例推翻，
硬塞假证据是最坏的选择。有 phase 21 裁定台账的先例（同样有 `not-portable` 类）。

---

## 12. 留给下一轮的

| 项 | 规模 | 说明 |
|---|---|---|
| **low 层未捞出的 146 个** | 146 | 三条判据（B/C/D）都没捞到。判据的已知盲区：纯函数 + 不可失败 + oracle 没测的。硬补就退回主观挑选 |
| `check:surface-coverage` 的 40 个未匹配 | 40 | 用户在范围问答中明确留到下一轮 |
| `packages/tui/test` 未进门禁语料 | 6 条虚高 | `check-inline-test-ports` 与 `check-triage-ledger` 的语料目录漏了它，导致未匹配数虚高 6 条（190 报成，实际 184）。**方向保守**，不影响结论 |
| `test:live` 的 Anthropic OAuth 凭据 | — | 本机无，25 条 live 用例跑不了。不是代码问题 |

**最重要的一条**：本轮证明了 `check:surface-coverage` 的「未匹配 40/513」**显著低估真实缺口**
（282 条里 61 条是 not-portable）。下一轮如果要给出「移植完成度」的数字，
不能再引用那个 92%。

---

## 13. 一条被我判错的裁定（收口后复核发现）

本轮结束后复核 `not-portable` 时发现：**`coding-agent/src/ui/web.rs::run_web` 被我误判了。**

我的理由写的是「`runWeb` 零命中，oracle 的 web UI 整体未移植」。实际上：

- `packages/coding-agent/src/ui/web.ts` **有 1714 行**（oracle 那个文件是 1200 行）
- 入口是 `serveWeb(options, state)`，其文档注释直接标着 **`pie: web.rs:218-236`** —— 正是 `run_web`
- `packages/coding-agent/test/ui/web.test.ts` **存在**，`:506` 用 `serveWeb` 起服务器驱动整套测试

已改判为 `existing-test` → `ui/web.test.ts:525`。计数从 184/37/61 变为 **185/37/60**。

**错在哪**：我用「同名符号 `runWeb` 零命中」推断「整条路径未移植」，而正确做法是
**看实现文件是否存在、有多少行**。同一次核查里 `bedrock-provider.ts` 只有 6 行（确是占位模块），
`ui/web.ts` 有 1714 行——两者天差地别，但「同名符号零命中」对它们给出的信号一模一样。

**这条判错说明 `not-portable` 这一类需要二次裁定**：60 条里可能还有同型误判。
下一轮应当逐条核实「TS 侧实现文件是否存在且有实质内容」，而不是只查符号名。
