# high 层 45 个函数的行为证据

phase 7 把 473 个「只验证了名字」的函数分成 high 45 / medium 149 / low 279。
本 phase 让 **high 层 45 个 100% 有行为证据**。

```
existing-test         42
new-test               1
dissolved-dependency   1
oracle-stub            1
                    ────
                      45
```

## 证据种类比 ROADMAP 多两种 —— 这是一处需要说明的偏离

ROADMAP 的 Phase 8 规定 `evidence_kind ∈ {existing-test, new-test, parity-scenario}`。
实际用到了**四种**，多出的两种不是为了凑数，而是因为有两个函数**没有 oracle 行为可以对照**：

| kind | 用在哪 | 为什么另立一类 |
|---|---|---|
| `dissolved-dependency` | `ai/src/sigv4.rs :: sign` | manifest 已判 `dissolved:adopted-@aws-sdk/signature-v4`，rationale 写明「SigV4 签名由 @aws-sdk 提供（RULEBOOK §1 的 adopt 判据），**无对应 TS 文件**」。给一个 vendored 依赖写测试，测的是 AWS SDK，不是移植保真度 |
| `oracle-stub` | `ai/src/utils/oauth/openai_codex.rs :: login` | oracle 那一侧是 `Err("openai-codex OAuth not yet implemented")`（`openai_codex.rs:6-8`）。要求 TS 与之「行为一致」等于要求 TS 也报错——那会**破坏** TS 侧能用的实现 |

把这两个硬塞成 `existing-test` 才是不诚实的：那需要拿一条断言别的东西的测试来充数，
正是本轮反复在抓的橡皮图章。

同类但已有证据的一例：`openai_codex.rs :: refresh` 的 oracle 侧同为 stub（`:10-12`），
但 TS 侧有 `openai-codex-oauth.test.ts:27`（断言无效 refresh token 会 reject 且不写 stderr）。
那条记为 `existing-test`，并在表里注明**它是 TS 自身合同，不是 oracle 对照**。

## 唯一的 new-test：`cleanupSessionResources`

45 个里唯一真正**零行为覆盖**的。它落在 high 层是因为 `credential` 规则命中。

oracle 侧同样是空 stub，而且注释自陈是「`packages/ai/src/session-resources.ts` 的 1:1 stub」
——**方向是 oracle 抄的 TS**。所以立的合同是 TS 自己那份实现承诺的语义，三条：
回调都被调用并拿到 sessionId · 返回值能注销 · **某个回调抛错不阻断其余回调，最后汇总成
`AggregateError`**。

第三条是唯一有分量的：会话切换时若一个 provider 的清理抛错就中断整条链，后面的 HTTP 连接池
与 OAuth 定时器全部泄漏，而用户只看到一条报错——泄漏是静默的。

**负控**：把 `cleanupSessionResources` 改成遇错即中断（去掉 try/catch 与 errors 汇总），
变异脚本 assert 标记落地 1 处 → 那条当场红：

```
× one throwing cleanup does not stop the rest; failures aggregate
  → 抛错之后的回调仍然要跑: expected [ 'first' ] to deeply equal [ 'first', 'second', 'third' ]
```

其余 3 条正确保持绿，说明它们各守各的面。还原后 4 条全绿。

## 抽查（判据 2）

**抽样规则先于结果确定**：`existing-test` 的行按表内顺序编号，取编号 ≡ 0 (mod 3)，
需要 `max(5, ⌈44/3⌉)` = 15 个（该规则在 44 条内产出 14 个，即全部符合者）。

抽查**当场抓出三处误配**，全部改正：

| # | 原 evidence | 问题 | 改为 |
|---|---|---|---|
| 3 | `jsonl_storage::create` → `pie-session-helpers.test.ts:202` | 那一行是 `expect(deleted).toBe(path)`，断言的是 **delete** | `session-dir-purity.test.ts:89`（`created.length > 0`） |
| 9 | `sigv4::sign` → `bedrock-endpoint-resolution.test.ts:88` | 那一行断言 SDK 客户端**被构造**，不是请求被签名 | 改判 `dissolved-dependency` |
| 15 | `openai_codex::login` → `openai-codex-oauth.test.ts:27` | 那一行调的是 `refreshOpenAICodexToken`，是 **refresh** | 改判 `oracle-stub` |

同时把 `github_copilot::login` 的 evidence 从 `:48`（`init?.method === "POST"`，任何 POST 都满足）
上移到 `:53`（`expect(String(init?.body)).toContain("client_id=")`）——device-flow 的请求体才是
`login` 的特征。

抽查后的样本（改正后）：

| # | 函数 | evidence | 断言原文 |
|---|---|---|---|
| 6 | `bedrock_provider::from_env` | `bedrock-endpoint-resolution.test.ts:105` | `expect(config.region).toBe("us-east-2")` |
| 12 | `oauth/anthropic::refresh` | `anthropic-oauth.test.ts:259` | `expect(body.refresh_token).toBe("refresh-token")` |
| 18 | `vertex_adc::load_service_account` | `vertex-adc.test.ts:82` | `await expect(loadVertexServiceAccount()).rejects.toThrow(VertexAdcError)` |
| 21 | `bug_report::build` | `bug-report.test.ts:60` | `expect(r).not.toContain("sk-abcdefghij")` |
| 24 | `export::save` | `ported/export-e2e.test.ts:94` | `expect(written).toBe(dest)` |
| 30 | `model_picker::view` | `model-picker.test.ts:315` | `expect(p.view(5)).toEqual({ title: "Select provider", rows: [] })` |
| 33 | `oauth::await_callback` | `oauth.test.ts:199` | `await expect(flow.awaitCallback(100)).rejects.toThrow(/timed out/)` |
| 36 | `session_archive::activate_imported` | `session-archive.test.ts:247` | `expect(imported.originallyEnabledTriggers).toEqual(["was-enabled"])` |
| 39 | `session/mod::delete_by_id` | `pie-session-helpers.test.ts:202` | `expect(deleted).toBe(path)` |
| 42 | `tui::render_harness_event` | `ported/tui-render-e2e.test.ts:249` | `expect(plain.includes("pi>"), …).toBe(false)` |

## 机器校验：每条 evidence 必须是断言行

生成证据表的脚本内置了与 `check-triage-ledger.mjs` **同一条**规则——`<path>:<line>` 指向的那一行
必须含 `expect(` 或 `assert`。它在本 phase 挡下了 **7 次**手滑：4 次行号占位 `:0`、2 次指到空行、
1 次指到 `caught = error;`。

phase 4 把这条规则写进门禁时说「同类失败第三次就该改规则」；这里它是第四、五、六……次生效。

## 这份证据表守不住什么

- `existing-test` 证明的是「有一条断言碰过这个函数的输出」，**不是**「这个函数的所有分支都被覆盖」。
  45 个里没有一个做过分支覆盖统计。
- `dissolved-dependency` 与 `oracle-stub` 两类**本质上是「无需证据」的记录**，不是证据本身。
  它们的正确性取决于那两条理由是否成立——理由写在上面，可以被反驳。
- 分层本身的盲区见 `risk-tiering.md` 的「守不住什么」一节：medium 149 与 low 279 完全没查。

## 判据对照

| 判据 | 结果 |
|---|---|
| 1. high 层 100% 有证据，行数 = high 层规模 | 45 行 = 45 ✓ |
| 2. `existing-test` 的行真的断言了该函数的输出；抽查 1/3 | 抓出 3 处误配并改正 ✓ |
| 3. `new-test` 先贴 oracle 依据再贴 TS 断言 | `session-resources-batch-h.test.ts` 文件头贴了 oracle 的 stub 原文并说明方向 ✓ |
| 4. `new-test` 配负控，变异带 assert | 遇错即中断 → 目标条红，其余 3 条绿 ✓ |
| 5. 新增 parity 场景（若有）差异集不变、self-check 3/3 | **未新增场景**；差分仍为 8 项声明基线，self-check 3/3 ✓ |
| 6. `bash test.sh` 只增不减；`npm run check` exit 0 | 4313 passed（+4）· exit 0 ✓ |

## 命令与结果

```
npm run check                                        exit 0
bash test.sh                                         exit 0 — 4313 passed / 0 failed
                                                     （agent 450 · ai 488 · coding-agent 2700 · mcp 46 · tui 612 · workers 17）
bash migration/parity/run-parity.sh                  exit 1（预期）— 差异集恰为 8 项声明基线
bash migration/parity/run-parity.sh --self-check     exit 0 — MUTATIONS DETECTED: 3/3
```
