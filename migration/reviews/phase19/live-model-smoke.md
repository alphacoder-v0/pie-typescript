# phase 19 · 真实模型端到端冒烟

2026-08-04。**动机**：用户指出"测试不完整，不能保证移植之后真的可用、能完成任务"。核实后属实——
`sse-fixture-server.mjs` 发出的工具调用数是 **0**，parity 的 8 个场景与 smoke 的 14 项检查
**从未执行过一次工具调用**，也没有任何测试让真实二进制改过一个文件。

也就是说，一个 coding agent 的核心闭环——模型要求调工具 → agent 执行 → 结果回灌 → 模型继续 →
文件真的被改——此前只在**进程内 + faux 假 provider** 下验证过，从未走过真实二进制与真实 HTTP 栈。

这个缺口要命，是因为本次迁移反复证明**缺陷住在接线处**：pie 的全部增量零 importer、DS4 provider
从未注册、系统提示是 pi 的、`--version` 走错流、`autoDetectModel` 返回值被丢弃——**这五条没有
一条能被"进程内 + 假 provider"抓到**。

---

## 任务

临时目录、临时 HOME，播种一个真有 bug 的文件与一个会失败的测试：

```js
// math.js —— add() 本该相加
function add(a, b) { return a - b; }

// test.js
assert.strictEqual(add(2, 3), 5);
assert.strictEqual(add(10, 4), 14);
console.log("ALL TESTS PASS");
```

跑之前 `node test.js` 必须 **exit 1**（每次运行前实测确认）。

提示词要求：用 read 读文件 → 用 edit 修复 → 用 bash 跑 `node test.js` 确认 → 停止。

**验收不看模型说了什么，只看两件事**：磁盘上的文件内容是否真的变了，以及测试是否真的通过。

---

## 运行 1 — Google / Gemini 2.5 Flash

`google/gemini-2.5-flash`，API 家族 `google-generative-ai`，凭据取自 `GEMINI_API_KEY`。

```
⚙ read(path="math.js")
    function add(a, b) { return a - b; }
⚙ edit(old_string="return a - b;", path="math.js", new_string="return a + b;")
    Edited math.js (1 replacement).
    --- before
    - return a - b;
    +++ after
    + return a + b;
⚙ bash(command="node test.js")
    $ node test.js
    ALL TESTS PASS
    [exit 0]
I've fixed the bug in `math.js` ... confirmed that all tests pass by running `node test.js`.
```

运行后实测：`math.js` 为 `return a + b;`，`node test.js` → `ALL TESTS PASS`，exit 0。进程 exit 0。

## 运行 2 — SiliconFlow / DeepSeek V4 Flash

`openai/deepseek-ai/DeepSeek-V4-Flash`，API 家族 **`openai-completions`**，
baseUrl **`https://api.siliconflow.cn/v1`**，经 `~/.pie/models.json` 自定义模型登记：

```json
{ "models": [{ "id": "deepseek-ai/DeepSeek-V4-Flash", "api": "openai-completions",
  "provider": "openai", "baseUrl": "https://api.siliconflow.cn/v1", … }] }
```

（provider 记为 `openai` 是必要的：`env-api-keys.ts` 的 provider→环境变量映射是**固定表**，
未知 provider 名拿不到 key。模型 id 会原样作为请求体里的 model 发出。）

```
⚙ read(path="math.js")
⚙ edit(path="math.js", old_string="return a - b;", new_string="return a + b;")
    Edited math.js (1 replacement).
⚙ bash(command="node test.js")
    ALL TESTS PASS
    [exit 0]
Done. The bug was `a - b` in the add function. Changed it to `a + b` …
```

运行后实测：同上，文件已改、测试通过、exit 0。

---

## 运行 3 — 复杂任务（SiliconFlow / DeepSeek V4 Flash）

用户指出前两次任务过于简单，不足以支撑"能干活"。第三次改用一个需要真实排障的多文件仓库。

**播种**：一个算术表达式解释器，`src/tokenize.js` → `src/parse.js` → `src/eval.js`，测试
`test/run.js` 导入的是 `eval.js`。7 个用例中 2 个失败：

```
FAIL  10 - 2 - 3    want=5   got=11
FAIL  100 / 5 / 2   want=10  got=40
```

难点是刻意设计的：
- 失败信息**不指名任何文件**；bug 在 `parse.js`，而测试导入的是 `eval.js`。
- 只有 2/7 失败，另外 5 个必须保持通过——粗暴改动会打破它们。
- 根因是 precedence-climbing 解析器对左结合运算符递归时传了 `parseExpr(prec)` 而非
  `prec + 1`，使 `-` 和 `/` 变成右结合。需要理解算法而非模式匹配。

**提示词**只描述症状，并明确禁止改测试或弱化断言。

**结果**：
```
工具序列: bash bash ls ls read read read read bash edit bash    （11 次调用，多轮）
改动:     src/parse.js:34  parseExpr(prec) → parseExpr(prec + 1)   （恰好一处）
测试文件: 未被修改，7 个用例完整
最终:     node test/run.js → ALL TESTS PASS, exit 0
```

它自述的根因，逐字：

> In the precedence-climbing parser, the right-recursive call used `parseExpr(prec)` instead of
> `parseExpr(prec + 1)`, making `-` and `/` right-associative instead of left-associative, so
> `10 - 2 - 3` was parsed as `10 - (2 - 3) = 11` and `100 / 5 / 2` as `100 / (5 / 2) = 40`.

根因、机制、两个失败用例的具体算式全部正确。行为序列也是真正的排障：先复现、再探目录、读四个文件
建立跨文件模型、再复现、**只改一处**、最后验证。

## 全量 live 测试套件（`npm run test:live`）

用户要求 `npm test` 跑真实 provider。落地为**独立入口** `test-live.sh` / `npm run test:live`，
保留环境中已有的凭据；`npm test` 保持密闭不变。理由写在脚本头部：密闭那套是**门禁**
（CI 与干净环境回归必须能在无凭据机器上跑通），这套是**证据**。

实测（仅 `GEMINI_API_KEY` 可用）：

| | 密闭 `npm test` | live `npm run test:live` |
|---|---|---|
| passed | 4127 | **4157** |
| skipped | 776 | 746 |
| failed | 0 | 1 |

解冻的 30 个用例里，**当场抓出两个只有真实 provider 才能暴露的问题**：

1. **`cross-provider-handoff.test.ts` 的 skip 守卫写错了**——它断言"至少 2 个 fixture"，
   却用 `hasAnyApiKey()`（≥1）作守卫。恰好只有一个凭据时它会运行并必然失败
   （`expected 1 to be greater than or equal to 2`）。已修为 `hasAtLeastTwoApiKeys()`。
   密闭模式下整个 describe 被跳过，所以这个错误守卫**永远不会暴露**。
2. **两个测试硬编码了已被 Google 退役的 `gemini-2.0-flash`**（API 返回 404
   "no longer available"）。已切到 `gemini-2.5-flash`——该包另外 12 个 live google 测试本就在用它。

仍失败的 1 个是 `context-overflow`，**环境类且在本账号上不可能通过**：它必须发送超过模型
1M 上下文的输入才能触发溢出，而账号配额恰是 1,000,000 tokens/分钟——**配额 429 必然先于
上下文错误到达**。该用例要求"账号配额 > 模型上下文窗口"。

**顺带发现的产品问题（未修，见 backlog）**：`pie --list-models google` 仍然把已退役的
`gemini-2.0-flash` 列给用户，选它即 404。目录是 oracle 的冻结快照且被 parity S1 逐字节钉住，
**改它会打破 S1**——这是"忠实复刻"与"当下正确"的真实冲突，属产品决策，不由本次擅自处置。

## 三次运行一共证明了什么

| 被证明可用的路径 | 证据 |
|---|---|
| 工具调用闭环（模型→执行→回灌→继续） | 运行 1/2 各 3 轮；运行 3 共 **11 次调用、多轮迭代**，最终正常终止 |
| `read` / `edit` / `bash` / `ls` 四条工具路径 | 转录里逐条可见，edit 带真实 diff，bash 带真实 `[exit 0]` |
| 真实文件变更 | 磁盘内容实测改变，非模型自述 |
| 25 个工具全部注册 | 启动横幅列出完整工具表 |
| 多轮 agent loop 与终止条件 | 运行 3 是真正的排障序列：复现 → 探目录 → 读 4 个文件 → 复现 → **只改一处** → 验证 → 停止 |
| 审批旁路（`--yes --always-allow`） | 非交互下写文件未被卡住 |
| **两个 API 家族** | `google-generative-ai` 与 `openai-completions` 各一次 |
| **自定义模型加载**（`~/.pie/models.json`） | 运行 2 依赖它才能解析出模型 |
| **第三方 OpenAI 兼容 baseUrl 路由** | 运行 2 打到 SiliconFlow 而非 api.openai.com——**若路由错了，SF 的 key 打到 OpenAI 会直接 401**。phase 16 恰好在这条路上出过真 bug（`--base-url` 曾把请求发往真实 OpenAI 端点），这次是对该修复的独立确认 |

## 仍然**没有**证明什么

诚实边界，不要过度解读：

- **三次运行、最难的一次也只是中等规模。** 运行 3 确实需要跨文件推理与算法理解（7 个用例、
  4 个源文件、只改一处且不许动测试），但仓库仍是几百行量级。**不能**推断大仓库检索、
  长上下文、压缩（compaction）触发后、或需要几十轮迭代的任务。
- **无 oracle 并排。** 没有让 Rust pie 跑同一个任务对比。真实模型输出天然不确定，逐字节比对
  不可行；只能比"是否都完成"，本次未做。
- **不可重复、不进 CI。** 依赖真实凭据与外部服务，结果非确定性。这是**一次性证据**，
  不是回归门禁。回归门禁由密闭 E2E（S9–S12，工具调用 fixture）承担。
- **失败面覆盖仍然很薄。** live 套件里撞到过真实的 429（配额）与 404（模型退役），但那是
  测试撞上的，不是**任务执行中**的限流/超时恢复。google 的 `sendWithRetry` 已知未接线
  （`TODO(port)`）。
- **费用与凭据**：两次各消耗少量 token。SiliconFlow 的 key 由用户放在 `~/.sf-key`（0600），
  全程未打印、未写入本仓任何文件；如不再需要请自行删除。

---

## 结论

在此之前，"移植是否真的可用"这个问题**没有任何证据**——4125 个测试与 8 个 parity 场景
都绕开了工具执行。现在有了三层：

1. **可重复的门禁**：密闭 E2E S9–S12，工具执行逐字节对齐 oracle，8 个负控证明它们能失败。
2. **最小闭环证据**：两个 provider、两条 API 家族，真实模型改动真实文件。
3. **中等复杂度证据**：跨文件排障，11 次工具调用，诊断与修复都正确，且未动测试。

外加 `npm run test:live` 让 credential-gated 用例真正执行——**它第一次运行就抓出两个
只有真实 provider 才能暴露的问题**（错误的 skip 守卫、硬编码的退役模型）。

结论从"不知道"变成了"中等规模任务已确认可用"。仍未验证的是大仓库、长上下文与失败恢复。
