# 三步核探针的校准 —— 期望值先于实现

**本文件在 `scripts/probe-ts-counterpart.mjs` 写完之前落盘。**
理由：探针的价值全在于它能不能推翻我的判断。如果先跑脚本再写期望，
我会不自觉地把期望写成「脚本恰好输出的那个」，校准就退化成同义反复。

## 为什么需要这个探针

第四轮把 `coding-agent/src/ui/web.rs::run_web` 判成了 `not-portable`，理由是
「`runWeb` 零命中，oracle 的 web UI 整体未移植」。**这是错的**：
`packages/coding-agent/src/ui/web.ts` 有 1714 行，入口是 `serveWeb`，
其文档注释直接标着 `pie: web.rs:218-236`。

错因很具体：**用「同名符号零命中」推断「整条路径未移植」**。
同一次核查里 `bedrock-provider.ts`（6 行占位）与 `ui/web.ts`（1714 行完整实现）
给出的信号**一模一样**——因为查的都是符号名。

所以探针必须查**文件与行数**，不查符号名。

## 三个探针（期望值）

| # | oracle 条目 | 期望 TS 文件 | 期望行数 | 期望导出面含 | 这个探针在测什么 |
|---|---|---|---|---|---|
| P1 | `coding-agent/src/ui/web.rs::run_web` | `packages/coding-agent/src/ui/web.ts` | **≥ 1700** | `serveWeb` | 完整实现不能被误判成缺口 |
| P2 | `ai/src/bedrock_provider.rs::invoke_stream` | `packages/ai/src/bedrock-provider.ts` | **≤ 10** | （占位，导出面极小） | 占位模块必须被识别为真缺口 |
| P3 | `ai/src/utils/oauth/pkce.rs::generate_pkce` | `packages/ai/src/utils/oauth/pkce.ts` | **> 10** | `generatePKCE` | **不靠 snake→camel 猜名字**——真实符号是 `generatePKCE` 不是 `generatePkce` |

P1 与 P2 是一对：它们的**符号名信号相同**（都零命中），但**文件信号截然相反**
（1714 行 vs 6 行）。探针必须把这一对分开，否则它没有解决 `run_web` 那个错误。

P3 是另一个方向：`check:surface-coverage` 把 `generate_pkce` 报成「未匹配」，
因为它的 `snake→camel/pascal` 三变体匹配不了 acronym 保持大写的 `generatePKCE`。
探针若也靠猜名字，就会重复这个漏配。

## 负控（期望）

给探针一个 oracle 里**不存在**的条目 `foo/bar.rs::nope`：

- 期望：明确报「oracle 中无此函数」并 **exit 非 0**
- 反面：静默返回「找不到 TS 对应物」——那会让一个拼错的名字被当成「真缺口」

## 路径映射规则（探针的核心）

不查符号名，查文件。oracle 的 `crates/<pkg>/src/<path>.rs` 映射到
`packages/<pkg>/src/<path>.ts`，其中：

- `<pkg>` 直接对应（`agent`→`agent` · `coding-agent`→`coding-agent` · `ai`→`ai` · `mcp`→`mcp`）
- 路径段的 `_` 转 `-`（Rust 用 snake_case 文件名，TS 用 kebab-case）
- `mod.rs` 映射到同名目录的 `index.ts`，也试目录本身
- 找不到时退到**同名 basename 全仓搜索**（覆盖目录结构不同的情况）

**探针只产出事实，判断仍是人的活。** 它不写证据表。
