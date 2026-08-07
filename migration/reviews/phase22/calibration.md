# 校准探针（phase 3）—— 30 个抽样量出的真实成本

phase 3 只有一个任务：**在投入六个批次之前，先量出这活到底多贵、方法到底成不成立。**

结论：命中率踩线通过，但**五个规格没预见的成本因素**比命中率本身更重要。

---

## 取样（规则先于结果声明）

**规则**：六批（A/B/C/D/E1/E2）各取 5 个 = 30。每批内按 `roster.tsv` 中该批行的出现顺序，
以步长 `⌊本批规模 / 5⌋` 从 index 0 起等距取。

等距取样不是图省事——它保证样本跨越每批内的不同文件，不会全落在同一个模块上。
抽中的 30 个 `oracle_file::fn_name@line` 在开始裁定**之前**已打进 transcript。

---

## 裁定结果

| 裁定 | 条数 | 说明 |
|---|---|---|
| `existing-test` | **19** | 指向已有断言行 |
| `new-test` | **9** | 本轮新写，配负控 |
| `not-portable` | **2** | TS 侧根本不存在（详见「发现三」） |

**`existing-test` 命中率 = 19 / 28 = 67.9%**（分母不含 `not-portable`——那些函数在 TS 侧不存在，
既不该算命中也不该算未命中，放进分母会让「已有测试覆盖了多少」这个读数失真）。

若按 30 为分母则是 **63.3%**；按 phase-3 规格的阈值判定（<60% 触发 `SCOPE_REASSESS`），
**两种算法都不触发**。规格判据 6 的结论：**不触发，可进入批 A**。

上一轮 high 层 45 个里 42 个是 `existing-test`（93%）。本轮 67.9% 显著更低，
原因如规划时所料：high 层是**风险规则命中**的函数，天然集中在已被重点测试的路径上。

---

## 判据 3：「这条断言失败时，被测函数是否一定出错？」

19 条 `existing-test` **全部回答「是」**。逐条核实过，不是过一遍 grep 就算数。
最有代表性的一条：

- `coding-agent/src/readline.rs::from_registry_and_skills` → `readline.test.ts:66`
  `const c = SlashCompleter.fromRegistryAndSkills(...)` 之后 `expect(c.matches("/d")).toContain("/db9")`。
  合并逻辑错了，`c.matches` 就不会包含 `/db9`。**是。**

---

## 五个成本发现（比命中率更重要）

### 发现一：自动定位不可靠，必须人工核

我先后试了**六种**筛选策略，每一种都在假阳性和假阴性之间摇摆：

| 策略 | 结果 |
|---|---|
| 全语料 grep 函数名 | `list` 匹配 124 条、`new` 匹配 49 条，几乎全是无关标识符 |
| 要求同一行既有调用又有 `expect(` | 降到 11/30，但仍有假阳性（`inbox::list` 匹配到别的 `.list()`） |
| 限定「import 了实现模块的测试」 | 降到 7/30，**大量假阴性**——`bug-report.test.ts:104` 明明有 `expect(defaultDest(NOW))` 却被漏掉 |
| 调用行 + 其后 12 行内最近断言 | 18/30，接近真实值 |
| 逐个人工核实候选 | 抓出 2 个假阳性（`env/native::new` 匹配到注释里的 `Arc::new`；`skills_state::set` 匹配到 goal 的 `set`） |
| 定向深挖 | 又找到 1 条自动搜索漏掉的（`agent.test.ts:239` 的 `agent.abort()`，因该文件从 `../src/index.ts` 而非 `../src/agent.ts` 导入） |

**没有一种自动策略能替代人工核。** 这是本轮最贵的一条结论。

### 发现二：Rust→TS 的名字映射需要人工

自动 `snake_case → camelCase` 在 30 个样本里失败 5 次以上：

| oracle | 自动推导 | TS 侧真名 |
|---|---|---|
| `skills_state.rs::set` | `set` | `setSkillState`（模块级函数，不是方法） |
| `session/mod.rs::badge` | `badge` | `automationCountsBadge` |
| `session.rs::leaf_id` | `leafId` | `getLeafId` |
| `tools/mod.rs::set_skill_state_tool` | `setSkillStateTool` | `createSetSkillStateToolDefinition` |
| `config.rs::base_dir` | `baseDir` | `getAgentDir` |

### 发现三：名册里有 TS 侧**根本不存在**的函数 ⚠

30 个里 2 个：

- `agent/src/harness/agent_harness.rs::prompt_with_images` —— 全仓 `packages` 下零命中
- `ai/src/event_stream.rs::event_type` —— `packages/ai/src` 零命中；oracle 那个文件是
  AWS `application/vnd.amazon.eventstream` 二进制帧解析器（Bedrock `:invoke-with-response-stream` 专用）

**这是关于 `check:surface-coverage` 的坏消息**：它把这两个算作「已匹配」。
按 2/30 的比例外推，282 条名册里可能有 **~19 个**同类；而名册只是 513 个公开函数的一部分。
**「未匹配 40 / 513」这个数字低估了真实缺口。**

规格原本规定「无第三类」，前提正是「每个函数在 TS 侧都有对应物」。前提被推翻，
所以加了 `not-portable` 类（要求 ≥20 字理由，与 phase 21 的裁定台账同构，有先例）。
硬塞一个假证据是最坏的选择——那正是这套门禁存在的理由所要防的事。

### 发现四：筛选器漏了断言风格差异

`packages/tui` 用 `node:test` 的 `assert`，其余包用 vitest 的 `expect(`。
我的筛选器只找 `expect(`，于是把 `markdown.test.ts:60` 已有的 `assert.ok(...)` 整个漏掉，
差点为它白写一条 new-test。门禁本身早就同时认这两种（`/\bexpect\(|\bassert\b/`），
是我的**搜索脚本**比门禁还窄。

### 发现五：行号会漂，而且是必然 ⚠

同一类失败在本 phase 里发生了**三次**：

1. 手填的行号本来就错（指到 `it(...)` 行）
2. 往测试文件里加内容 → 后面所有行下移
3. `npm run check` 里的 `biome check --write` 重排版 → 又漂一次（把 `expect(...)` 拆成多行）

按 RULEBOOK「复发失败上移」——**停修实例，改规则**：

`evidence.tsv` 增加**可选的**第 4 列 `anchor`（断言行的特征文本）。门禁行为：

- 行号指向的行含锚点 → 通过
- 行号不是断言行，但锚点在文件里**唯一**命中一条断言 → 报错并**直接给出正确行号**
- 锚点 0 次命中 → 那条断言已被改写或删除，证据失效，需重新裁定
- 锚点多次命中 → 锚点不够独特，需换更有区分度的断言

第 4 列是可选的（容忍 3 或 4 列），让「加锚点」可以逐批推进而不是一次性重写全表。

补锚点时发现 4 条锚点不唯一，其中 `goal.rs::as_str` 的锚点退化成了 `expect(`
（biome 把断言拆行后，那一行只剩这几个字符），在文件里命中 24 次。处置：

- `goal.rs::as_str` —— **改写测试**，把断言收成单行（`expect(activeOnes, "…").toEqual([true, true, true])`），锚点随之唯一
- `markdown.rs::new` —— 改指同一个测试块里的相邻断言（`Nested 1.1`），仍验证同一件事
- 另 2 条（`clear_api_providers` / `transform_messages`）—— **保持原样**。门禁是「行号 + 锚点」双重定位，
  锚点重复不影响当前校验；只有在行号漂移后需要重定位时才会要求换锚点，而那时门禁会明确报出来

### 修锚点时我差点毁掉一条证据 ⚠

`clear_api_providers` 的锚点在文件里命中两次，我为了让它唯一，把证据改指了
`oracle-inline-core.test.ts:135` 的 `expect(doneModel).toBe("simple")`——那条断言与
`clearApiProviders()` **毫无关系**，它验证的是流式响应的模型名。

原证据 `:129` 是 `clearApiProviders();` 紧接着的
`expect(getApiProvider(RACE_API as never)).toBeUndefined();`，才是真正验证它的那一条。

**为了让机器可校验的形式指标（锚点唯一）而牺牲实质（证据真的验证了那个函数），
是这套门禁存在所要防的头号失效模式，而我在建成它一小时后就犯了一次。**
已回退。教训写在这里：**锚点冲突要么改写测试、要么在同一测试块内换断言，
绝不能换到另一个测试块——那等于换了一件被验证的事。**

---

## 成本外推

30 条裁定消耗约 **45 轮**工具调用（含 9 条 new-test 的编写与两次负控）。

按同样密度外推到剩余 252 条：**约 380 轮**。这是规划时未预估的量级——
规划时按 high 层 45 个的经验估的是「每批一个 phase」，实际每批（约 40 条）就需要 60+ 轮。

**这个数字应该让编排者和用户都看到**，因为它直接决定后六个批次是否按原计划走。

---

## 本 phase 的产出物

| 项 | 值 |
|---|---|
| `evidence.tsv` | 31 行（1 表头 + 30 条），已补 `anchor` 列 |
| 新增测试文件 | `packages/coding-agent/test/ported/calibration-batch.test.ts`（19 例）· `packages/agent/test/ported/calibration-batch.test.ts`（5 例） |
| 套件 | 4319 → **4343 passed / 0 failed**（+24） |
| 密闭性 | `~/.pie/sessions` 3297 → 3297，**增量 0**（phase 2 的成果保持） |
| 门禁 | `npm run check` exit 0（11 道） |

### 负控

| 变异 | 内容 | 结果 |
|---|---|---|
| M1 | `dynamic.ts` 的 `clearRules` 返回 0 而非清除数 | coding-agent 批 exit 1 ✓ |
| M2 | `session.ts` 的 `getLeafId` 恒返回首条（叶子不跟随） | agent 批 exit 1 ✓ |

两个变异脚本都先 `assert` 锚点唯一命中、变异标记确实写进文件，还原后再 `assert` 无残留。

### 顺带修正的三处实现认知错误

写测试时被 tsgo 与运行时抓出，都是**我猜了 API 而没读**：

- `CronRegistry` 没有 `markRunning`——job 通过 `dueJobs(since, now)` 进入 running 并生成 trace_id
- `GoalState` 没有 `text` 字段——真实结构是 `condition / status / iterations / last_reason? / updated_at`
- `Session.appendMessage` 返回的是 **id 字符串**，不是带 `.id` 的对象

第三条尤其值得记：我写的 `expect(await session.getLeafId()).toBe(first.id)` 里 `first.id` 是
`undefined`，而 `getLeafId()` 返回了真实 id——断言「真实值 === undefined」失败才暴露出来。
**如果我当时写的是 `toBeDefined()` 之类的弱断言，这个错误会静默通过。**
