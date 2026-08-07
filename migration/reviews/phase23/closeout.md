# 第五轮收口（the fifth round，11 phases）

用户选定的判定标准：**证据无死角 = oracle 的 513 个公开函数每一个都有行为证据**。达成。

上一轮收口在 `migration/reviews/phase22/closeout.md`；本文件只写本轮。

---

## 1. 结果：513/513

| 裁定 | 条数 | 占比 |
|---|---|---|
| `existing-test` | **321** | 62.6% |
| `new-test` | **46** | 9.0% |
| `not-portable` | **144** | 28.1% |
| `dissolved-dependency` | 1 | 0.2% |
| `oracle-stub` | 1 | 0.2% |
| **合计** | **513** | 100% |

**`existing-test` 命中率 = 321 / 369 = 87.0%**（分母不含三类「无实现可测」的裁定）。

### 按批

| 批 | 来源 | 条数 | existing | new | not-portable |
|---|---|---|---|---|---|
| HIGH | 第三轮 | 45 | 42 | 1 | 0 |
| A–E2 | 第四轮 | 282 | 192 | 37 | 53 |
| **U** | **本轮**：surface-coverage 未匹配 | **40** | 8 | 4 | 28 |
| **F** | **本轮**：agent 包 low 未捞出 | **58** | 30 | 3 | 25 |
| **G** | **本轮**：coding-agent 包 | **52** | 27 | 0 | 25 |
| **H** | **本轮**：ai + mcp 包 | **36** | 22 | 1 | 13 |
| | **本轮新增** | **186** | **87** | **8** | **91** |

---

## 2. 五个计数门禁 —— 本轮前后对照

| 门禁 | 本轮开始 | 现在 | 说明 |
|---|---|---|---|
| `check:manifest` | 204/204 | **持平** | 本来就满 |
| `check:surface-coverage` | 未匹配 40 / 513 | **持平** | 本轮不移植新函数。**但已量化它的双向误差**（见 §4）——不修它，修了它仍然只比对名字 |
| `check:inline-test-ports` | 未匹配 190 / 541 | **持平** | 属行为层，不在本轮范围 |
| `check:triage-ledger` | 121 条无遗漏 | **持平** | 上一轮名册 |
| `check:behavior-evidence` | **282/282** | **513/513，`REQUIRE_COMPLETE = true`** | `ROSTER_SIZE` 282→513，收紧值只升不降 |

`npm run check` 仍是 **11 道门禁**。

---

## 3. 两个数字：误判率与漏配率

本轮最有价值的产出不是「513/513」这个数，是**推翻了两个此前被当作事实的数**。

### 3a. `not-portable` 的误判率 = 11.7%

第四轮的 60 条 `not-portable` 逐条复核后，**7 条是误判**（改判为 `existing-test`）。

七条里**五条是同一个错误**：原理由都断言「零命中」，而对应函数就在导出面上——
真实的 TS 名字是 oracle 名字的**扩展**：

| 原理由 grep 的名字 | 实际叫 |
|---|---|
| `receivedFrom` | `triggerRecordReceivedFrom` |
| `generateImages` | `generateImagesOpenRouter` |
| `isRetryableError` | `isRetryableErrorMessage` |
| （以为拆成两个）| `removeAndSaveSkillsState` |
| （以为是枚举方法）| `isTriggerStateTerminal` |

**精确 grep 一个猜出来的名字，没命中就下结论**——这是方法缺陷。

第六条 `run_web` 更重：理由写着「`runWeb` 零命中」，实测 **`runWeb` 就在
`packages/coding-agent/src/ui/web.ts:1497`，还被 `main.ts:1645` 调用**。
那次 grep 根本没做，理由是凭空写的。

### 3b. `check:surface-coverage` 的漏配率 = 30.0%

它报的 40 个「未匹配」里，**12 条（30.0%）TS 侧有实现**，只是名字对不上它的
`snake_case → camelCase / PascalCase` 三变体：

| oracle | 门禁猜的 | TS 实际叫 | 漏配原因 |
|---|---|---|---|
| `generate_pkce` | `generatePkce` | **`generatePKCE`** | acronym 保持大写 |
| `sanitize_surrogates_u16` | `sanitizeSurrogatesU16` | **`sanitizeSurrogates`** | 去掉了 Rust 类型后缀 |
| `list_api_ids` | `listApiIds` | **`getApiProviders`** | 换动词换名词 |
| `translate_base` | `translateBase` | **`buildBaseOptions`** | 完全重命名 |
| `parse_partial_json` | `parsePartialJson` | **`parseStreamingJson`** | partial→streaming |
| `proxy_from_env` | `proxyFromEnv` | **`resolveHttpProxyUrlForTarget`** | 语义展开 |

---

## 4. ⚠ `check:surface-coverage` 的双向误差

第四轮说它**低估**缺口。本轮补上另一半：**它同时也高估**。

| 方向 | 量 | 机制 |
|---|---|---|
| **高估**（报未匹配，其实有）| **12 / 40 = 30.0%** | 名字变体匹配不了 acronym 大写、动词替换、语义展开 |
| **低估**（报已匹配，其实没有）| **144 条** `not-portable` 它全算作「已匹配」 | 名字对上了不代表行为在——TS 侧有同名的**其他**符号 |

**两个方向同源：它只比对名字。**

`check:behavior-evidence` 的 513/513 才是能回答「行为在不在」的判据——它要求每条给出
**指向真断言行**的证据，或**逐条论证**的不可移植理由。

**本轮不修 surface-coverage 的匹配逻辑**：修了它仍然只比对名字。保留原样并在此标注
双向误差，比让它看起来更准确要诚实。

---

## 5. **513/513 不意味着什么**

这个数字很容易被读成「移植完成度 100%」。它不是。逐条说明它的边界：

### 它是**函数层**证据，不是行为层

oracle 有 **541 条内联测试**，其中 **190 条**在本仓找不到对应的移植测试
（`check:inline-test-ports` 的持平数字）。第三轮逐条裁定了其中 121 条，
**仍有 92 条未被本仓测试语料提及**。

一个函数有证据，不代表 oracle 那条具体断言被复现了。**这两层正交。**

### 144 条 `not-portable` 里，4 条是真能力缺口

| oracle | 状态 |
|---|---|
| `ai/src/event_stream.rs` 的 `event_type` / `content_type` / `crc32` / `message_type` / `parse_message` | AWS `vnd.amazon.eventstream` 二进制帧解析，**未移植** |
| `ai/src/utils/aws_eventstream.rs::new` | 探针报 `no-file` |
| `ai/src/bedrock_anthropic.rs::ingest` · `bedrock_provider.rs::{invoke_stream, register}` | `bedrock-provider.ts` **只有 6 行占位** |

**用户本轮明确不补功能**，只需论证清楚——上面就是那个论证。
但「513/513」**不代表 Bedrock 能用**。

### live provider 与性能仍无门禁

`npm run test:live` 需要真实凭据，不进 `npm run check`；性能无公平基准。
这两条边界第三轮已各自给出重估条件并当场答否，本轮维持现状。

### 有 1 条证据被诚实标注为偏弱

`models.rs::list_models` → `expect(models.length).toBeGreaterThan(0)`。
同测试块内没有更强的断言，且它返回全量目录（钉死条数会让每次加模型都红）。
「有模型」是它能给的最强不变量，但**证明的是「非空」不是「对」**。

---

## 6. 改动规模

| 类别 | 数量 |
|---|---|
| 新增测试文件 | **3**（`batch-u` 7 例 · `batch-f` 6 例 · `batch-h` 2 例）|
| 新增测试用例 | **15** |
| 套件总数 | 4397 → **4412**（+15，只增不减）|
| 新增脚本 | **2**（`build-roster-513.mjs` · `probe-ts-counterpart.mjs`）|
| 新增文档 | **7**（README · probe-calibration · reaudit-notportable · unmatched-40 · batch-f/g/h · 本文件）|
| 名册 / 证据表 | 各 **514 行** |
| **`src` 触碰** | **0** —— 本轮 4 个改动文件全在 `test/` 下 |
| 测试夹具改动 | 1（`skills-state-batch-c.test.ts` 的多行断言拆成单行，强度不变）|

**`src` 零改动**：本轮主线是补证据与纠错，不改行为。

---

## 7. 三次规则上移（同类失败第三次就改规则）

### 7a. 裁定键必须从名册生成

| phase | 错的条数 | 错在哪 |
|---|---|---|
| 4（批 U 40 条）| 7 | oracle **行号**凭印象写错 |
| 5（批 F 58 条）| 1 | 键的**文件名**写错 |
| 6（批 G 52 条）| **14** | **文件路径 + 行号都发明了** |

批 G 那次尤其说明问题：`hooks.rs::is_empty@106` 实为 `lsp_supervisor.rs::is_empty@106`、
`extensions/mod.rs::banner@47` 实为 `tui.rs::banner@47`、`ui/relay.rs::new@49`
**在批 G 里根本不存在**。成因是定位工具的输出为可读做了截断，我据此回填完整键时
把路径和行号一起猜了——**猜出来的键与真实键长得一样，肉眼分不出**。

「自动按名册校正」这个补救让事情更糟：它把 `error_line@93` 改成已存在的 `@288`，
Python dict 的重复键**静默覆盖**，错误从「报错」变成「悄悄少几条」。

**改规则**：键必须 `awk -F'\t' '$6=="<BATCH>"{printf "%s::%s@%s\n",$1,$2,$3}' roster.tsv` 生成。
批 H 用新规则**一次通过**。已存记忆 `adjudication-keys-must-be-generated-from-roster`。

### 7b. 三步核替代符号名推断

`run_web` 的误判催生了 `scripts/probe-ts-counterpart.mjs`：**查文件与行数，不查符号名**。

三个校准探针的期望值**在脚本写出来之前**就落盘了（否则校准会退化成同义反复）：

| 探针 | 期望 | 实际 |
|---|---|---|
| `run_web` | ≥1700 行，导出面含 `serveWeb` | 1715 行 ✓ |
| `bedrock_provider::invoke_stream` | ≤10 行（占位）| 7 行，`hint=stub` ✓ |
| `generate_pkce` | 导出面含 `generatePKCE` | ✓ **靠路径映射拿到，不靠猜名字** |

前两个是一对：**符号名信号相同（都零命中），文件信号截然相反（1715 行 vs 7 行）**。

### 7c. 探针自身的误配也记下来了

它的「同名 basename 全仓搜索」退路把 `ai/src/event_stream.rs`（AWS 二进制帧）
误配到了 `packages/ai/src/utils/event-stream.ts`（通用 EventStream，是 oracle
**另一个**同名文件的对应物）。

**三条正因为人工复核才没被误判成「已移植」。** 探针产出事实，判断仍是人的活。

---

## 8. 抽查抓出的问题

每批的抽样规则都**先于查看结果**声明并打进 transcript。

| 批 | 抽中 | 抓出 |
|---|---|---|
| 复核 60 条 | 7 改判全查 + 10 维持项 | 1 处**位置错误**（`defaultConvertToLlm` 在 `agent.ts:33` 而非 types.ts）|
| U | 12 漏配全查 + 6 | 0 |
| **F** | **7** | **2 条我刚写错的证据（28.6%）** |
| G | 7 | 0（2 条上调为更强断言）|
| H | 6 | 0（2 条上调，1 条标注偏弱）|

**批 F 那两条最值得记**：

- `agent_harness::session@1497` —— oracle 是公开取值器，本仓 `agent-harness.ts:892`
  是 `private session`，**根本没有取值器**；我指的断言测的是另一个函数
- `agent_harness::enqueue_follow_up@1584` —— 本仓 harness **自己持有** `followUpQueue`
  （私有，无公开入队方法）；我指向了 **Agent 层**的同名函数，那是另一条名册条目

**不抽的话，这两条会带着「有测试覆盖」的假象进入 513/513。**

---

## 9. 四次「猜 API 而没读」

全部被 tsgo 或运行时当场抓住，**没有一次进了证据表**：

| # | 我以为的 | 实际 |
|---|---|---|
| 1 | `unregisterApiProviders(["anthropic-messages"])` 按 api 名删 | 签名是 `(sourceId: string)`，按**注册源**删（一个扩展注册三个 api，卸载时整体移除）|
| 2 | `createCustomMessage(...).timestamp` 是 ISO 串 | 参数收 ISO 串，**字段存 epoch 毫秒** |
| 3 | `agent_harness.rs::default_for` 对应 `PermissionPolicy.defaultForCodingAgent` | 它产的是 trigger action 的默认 prompt（`"{source} fired: {event}"`）——**张冠李戴** |
| 4 | `session()` / `enqueue_follow_up()` 在 TS harness 上有公开入口 | 都是私有字段，无取值器/入队方法 |

第 2 条尤其值得记：原样存字符串会让下游每一处 `timestamp` 比较**静默**失效——
同格式字符串之间 `"2026-…" > "2025-…"` 恰好排序正确。

---

## 10. 三个负控（终态门禁）

| 负控 | 变异 | 门禁反应 |
|---|---|---|
| **A 缺行** | 删 evidence 末行（`assert` 514→513）| exit 1「已裁定 512 条，低于本轮下限 513 —— 进度倒退了」|
| **B 假证据** | 证据改指 `// This predicate gates...` 注释行 | exit 1「**那一行不是断言行**…必须指向 expect(...) 所在的行」|
| **C 越界裁定** | `evidence_kind = probably-fine` | exit 1「必须是 existing-test / new-test / not-portable / dissolved-dependency / oracle-stub 之一」|

三者都完整走了**红 → `assert` 变异落地 → 绿**三段。

负控 B 的输出还附带修复提示（「加第 4 列锚点，行号再漂时门禁会直接告诉你新行号」）——
那是第四轮 `anchor` 规则的产物，在这里自我说明了一次。

---

## 11. 全链验证

```
npm ci                                   exit 0
npm run build                            exit 0
npm run check                            exit 0（11 道门禁）
bash test.sh                             exit 0 — 4412 passed / 0 failed
密闭性                                   ~/.pie/sessions 3316 → 3316，增量 0
run-parity.sh                            差异集**恰等**声明基线 8 项（脚本 assert 逐项逐值）
run-parity.sh --self-check               3/3 DETECTED，SELF-CHECK PASSED
npm run test:live                        26 failed 全部 environment，**0 regression**
                                         （25× Anthropic OAuth 401 + 1× Google 配额；凭据只报变量名）
src/cli/**                               本轮未触碰（4 个改动文件全在 test/ 下），S1 DIFF 0
```

---

## 12. 一句话

**513 个公开函数，每一个都有一条能指到断言行、或经得起追问的裁定。**

而这个数字最有价值的部分，是它推翻的那两个此前被当作事实的数：
`not-portable` 的误判率 **11.7%**，`surface-coverage` 的漏配率 **30.0%**。

两者同源——**用记忆代替查证**。前者是猜名字去 grep，后者是让机器猜名字。
