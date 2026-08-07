# phase 20-1 · 复核未验差异

四条结论此前来自子代理、未经主执行者复核。**先修可能修错东西**，所以先复核。
本文每条都给 oracle 源码引用（file:line）+ 实测输出，二者缺一不算复核。

结论：**4 条全部确认为真，0 条推翻，0 条无法判定。**

---

## 1. `NO_PROXY` —— 确认为真（oracle 的注释说了谎）

**oracle** `crates/ai/src/utils/node_http_proxy.rs`

- 第 4 行模块注释：`//! \`HTTPS_PROXY\`, and \`NO_PROXY\` env vars.`
- 但 `proxy_from_env()` 全文只读四个变量，**从不碰 `NO_PROXY`**，也没有 `.no_proxy()` 调用：

```rust
pub fn proxy_from_env() -> Option<reqwest::Proxy> {
    let url = env::var("HTTPS_PROXY").ok()
        .or_else(|| env::var("https_proxy").ok())
        .or_else(|| env::var("HTTP_PROXY").ok())
        .or_else(|| env::var("http_proxy").ok())?;
    reqwest::Proxy::all(&url).ok()
}
```

**本仓** `packages/ai/src/utils/node-http-proxy.ts:40-48` 实现了完整语义：读 `no_proxy`、
支持 `*` 通配、逗号/空白分隔逐项匹配，且有测试 `packages/ai/test/node-http-proxy.test.ts`。

**定性**：本仓**更正确**，oracle 是文档承诺与实现不符。这是一条真实的行为分叉，
方向是"我们做得对"。→ phase 2 处置为**声明偏离**，不应为对齐而删掉 NO_PROXY 支持。

---

## 2. Anthropic authorize URL —— 确认为真，且是**两处**差异

**oracle** `crates/ai/src/utils/oauth/anthropic.rs`（`build_authorize_url`）参数表**七项**：
`response_type · client_id · redirect_uri · scope · code_challenge · code_challenge_method · state`，
用 `percent_encoding::utf8_percent_encode(v, NON_ALPHANUMERIC)` 逐项编码。

**本仓** `packages/ai/src/utils/oauth/anthropic.ts:250-258` 参数表**八项**，多一个 `code: "true"`，
且用 `URLSearchParams`。

实测编码差异（同一 SCOPES 值）：

```
本仓 (URLSearchParams):     scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference
oracle (NON_ALPHANUMERIC):  scope=org%3Acreate%5Fapi%5Fkey%20user%3Aprofile%20user%3Ainference
```

**两处差异**：(a) 多带 `code=true`；(b) 空格 `+` vs `%20`、下划线不编码 vs `%5F`。
这是**浏览器可见的 URL**，用户会看到、会复制。→ phase 2 逐项处置。

---

## 3. summarization 丢失 `streamFn` 注入缝 —— 确认为真

**oracle** `crates/agent/src/harness/compaction/branch_summarization.rs`

- 第 13 行 `use crate::types::{AgentMessage, StreamFn};`
- 第 23-26 行 `pub async fn summarize_branch(... stream_fn: Option<StreamFn>, ...)`
- 第 49 行把它透传下去

**本仓** `packages/agent/src/harness/compaction/branch-summarization.ts:200-204`
`generateBranchSummary` 的 options 解构为
`{ model, apiKey, headers, signal, customInstructions, replaceInstructions, reserveTokens }`
——**没有 streamFn**。全文件 grep `streamFn|stream_fn|streamOverride` **零命中**。

**后果**：oracle 允许调用方注入流函数（测试可注入假流、上层可换实现）；本仓写死。
这是**可测试性缝隙的丢失**，不只是签名差异。→ phase 2 处置。

---

## 4. L-3（`push_aborted` 的"已验证"主张）—— 确认为真，证据比原报告更硬

**主张出处** `migration/reviews/ai/divergence-ledger.tsv:46` 称 push_aborted
"independently confirmed live and working via packages/ai/test/abort.test.ts"。

**复核**：

- `packages/ai/test/abort.test.ts` 的**全部 6 个 describe** 都受凭据门控
  （:102 GEMINI · :114/:131 OPENAI · :143 Azure · :157 ANTHROPIC_OAUTH · :169 MISTRAL）。
- 密闭 `npm test` 入口下实测：**`33 tests | 33 skipped`，Test Files 1 skipped** —— 零覆盖。
- 第 45 行唯一实质断言 `expect(msg.content.length).toBeGreaterThan(0)`，
  即断言中止后的消息**有内容**；而 oracle 的 `push_aborted` 推的是**全新空消息**。
  断言方向与 oracle **相反**。

**定性**：那条"已验证"是假的，两个层面都假——它在门禁里从不运行，且它断言的行为与 oracle 相反。
不存在任何密闭测试断言 provider 会以 oracle 的载荷发出中止事件。
→ divergence-ledger.tsv:46 的主张须更正；phase 2 建立真正的密闭断言。

---

## 对既有记录的更正（就地）

- `migration/reviews/phase19/surface-coverage-audit.md`：D-6 与 L-3 的"本人未复核"标注更新为
  **已由编排者复核确认**，并补上本文的证据指针。
- `migration/reviews/ai/divergence-ledger.tsv:46`：删除"independently confirmed live and working"
  的失实主张，改记为"该测试受凭据门控、密闭下零覆盖，且断言与 oracle 相反"。

## 方法论备注

四条**全部成立**这个结果本身值得警惕——它意味着子代理的发现质量高，但也意味着我此前
把它们标为"未复核"是对的：其中 L-3 的真实严重度比原报告更高（原报告只说"零覆盖"，
实测还发现断言方向相反）。**复核不是走过场，它改变了严重度定级。**
