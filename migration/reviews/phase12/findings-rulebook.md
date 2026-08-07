# Phase 12 · Reviewer C（对照 RULEBOOK）

总判定：**VIOLATION**（无 CRITICAL，无安全/打包面阻断项）

## 1. 依赖白名单 §1 — PASS
`package.json` 未被 phase-12 commit 触碰（`git show --stat 4b86b25` 28 文件无 manifest）。全部 import 落在 node builtin / workspace 包 / §1 白名单（smol-toml、typebox）/ 既有依赖（chalk、proper-lockfile）。
**`session-archive.ts` 手写 ustar 的主张核实为真**：import 列表无 `tar` 包也无动态 import；writer 在 :170-220，reader 在 :240-303，§1 理由在 :26-34。

## 2. 浏览器打包面 §2.3 — PASS
`git show 4b86b25 --name-only | grep -cE "packages/(ai|agent)/"` → **0**。依赖方向是向内消费（`lsp.ts:14` 从 `@pie/agent-core` 取 `AsyncQueue, detach`），未向 ai/agent 推入新符号。

**但 reviewer 揭示了一个我此前高估的事实（重要）**：`scripts/check-browser-smoke.mjs:11` 只打**单一入口** `scripts/browser-smoke-entry.ts`，不是整棵包树。因此 `ai/cli.ts:3`、`ai/utils/node-http-proxy.ts:1-2`、`ai/utils/oauth/anthropic.ts:8-9`、`agent/harness/env/nodejs.ts:1-18` 今天就带静态 `node:` import 而能通过门禁。**该门禁只保护入口可达图，弱于 §2.3 字面承诺的"整包打"。** 已记入 RULEBOOK §6 Deviation log，phase 19 决定是扩大入口集还是改写规则措辞。

## 3. 并发映射 §2.2 — VIOLATION（3 条）

正确映射（PASS）：`lsp.ts:196-201/206-211` 读泵与 stderr 排空用 `detach()`；`:154/243/294` 用 `AsyncQueue`；`:152/313-317` 临界区不跨 await 故用普通字段（判据正确）；子进程 spawn 走 `utils/child-process.ts` 与 `@pie/mcp` 的 `StdioTransport`；`mcp-loader.ts:250-268` 顺序 connect 与 oracle 一致；`lsp-supervisor.ts:172-186` 的 pending-Promise 缓存对应 `OnceCell::get_or_try_init`。`session-manager.ts:628-661` 是既有 base 代码，不在范围。

| # | 违规 | 处置 |
|---|---|---|
| 3A | **`tokio::time::timeout` 表外构造，同批次内三种映射**：`lsp.ts:294` 用 `AsyncQueue.next(AbortSignal.timeout)`、`lsp.ts:325-347` 与 `oauth.ts:204-250` 各自手搓 `new Promise`+`setTimeout`+`Promise.race` | **编排者已补 §2.2 行**（2026-08-05）；两处手搓交 fixer 收敛 |
| 3B | `oneshot` 未用表内 `Promise.withResolvers`（`lsp.ts:325-327` 手搓 `new Promise` 存 resolve） | LOW，交 fixer |
| 3C | **`FramedReader`（`lsp.ts:55-83`）重新实现了 `Signal`**（waiters 数组 + wake/waitForData），而 `Signal.notifyAll()/wait()` 已存在于 `async-queue.ts:114-160` 并由 `@pie/agent-core` 导出。§4「第二处实现 = 违规」，叶包例外不适用（coding-agent 在 agent-core 下游，可自由 import） | MED，交 fixer |
| 3D | **`spawn_blocking` 映射成全同步调用且无 `PERF(port):`**：oracle `session_archive.rs:214`/`:177` 是 `spawn_blocking`，TS `session-archive.ts:587`/`:461-470` 直接同步跑 50 MiB 上限的 readFileSync/Buffer.concat + sha256，阻塞事件循环 | MED，交 fixer 补标记（不改成异步） |
| 3E | `lsp.ts:366-373` 有意去掉 `AsyncMutex`（把 header+payload 合成一次 write，临界区不再跨 await）——**判 PASS**，但标记出来：规则是靠重构代码形状满足的，而非沿用 oracle 形状，值得第三方看见 | 记录，不改 |

## 4. 逃生舱标记 §3/§4 — VIOLATION（1 条格式错 + 3 条缺失）

标记齐备且带 oracle 行号的：`mcp-loader.ts:12/199/306/318`（B5，与 §5 表逐字一致）、`session-manager.ts:466`（B8）、`auth-storage.ts:545`（precedence TODO）。

| # | 问题 | 级别 |
|---|---|---|
| 4-1 | `session-archive.ts:32` 的 `(PERF(port) note: ...)` **格式不合规**（无冒号，`grep -n 'PERF(port):'` 命中不了）且**语义上根本不是性能说明**（是容器格式/健壮性说明）。divergence-ledger 自己写的是"a PERF(port)-**style** caveat"——实施者知道它不是 | LOW-MED |
| 4-2 | `session-archive.ts:29-31` 自陈「standard ustar，**not oracle's GNU-tar-header-shaped bytes**」——明确已知的持久化格式差异，**零标记** | MED |
| 4-3 | `lsp.ts:285-291` 把 oracle 的 `AsyncMutex<mpsc::Receiver>` 串行等待放宽成 `AsyncQueue` 的 FIFO 多等待者，只有散文说明无 `TODO(port):`。"当前只有一个调用方"是对**当前接线**的判断，后续 phase 改动不会触发任何 grep | MED |
| 4-4 | `session-archive.ts:461, 587` 的 spawn_blocking CPU 重活无 `PERF(port):`（同 3D） | MED |
| 4-5 | `lsp.ts:379` 硬编码 `PIE_LSP_CLIENT_VERSION = "0.75.0"`，oracle 用 `env!("CARGO_PKG_VERSION")`。它随 `initialize` 的 `clientInfo` 上线，会静默漂移。`VERSION` 已可从 `./config.ts` import（`session-archive.ts:43` 就是这么做的） | LOW |
| 4-6 | `auth-storage.ts` 的**落盘格式**分歧只存在于模块 doc 散文，无代码站点标记——同一文件里 precedence 分歧却有规范的 `TODO(port):`，不对称，导致 ED14 的 phase-19 义务不可 grep | LOW-MED |

判定为**无需标记**：`resource-loader.ts:58-70`（§4「不做的事」明文授权）；`oauth.ts` 的 randomToken 熵源提升（phase 7 先例，输出契约同形，judge 不可观测，§3 无对应标记类别）。

## 编排者裁决：B13 立项

reviewer 报告 `lsp-supervisor.ts:21-23` 以「不在 RULEBOOK §5 表里」为由拒绝为 project `.pie/lsp.toml` 的无信任门读取开台账条目，并指出**这是循环论证**——§5 由编排者维护，实施者应当提议而非自行否决。

编排者核实 oracle `lsp_supervisor.rs:76-103`：确实无条件读 `<cwd>/.pie/lsp.toml`、project 覆盖 user、无任何门；其中的 `command` 在首次匹配的 write/edit 命中扩展名时被 spawn。**与 B5 同类，仅 spawn 时机为懒触发。已补为 RULEBOOK §5 的 B13。**

reviewer 的这条方法论意见成立并已内化：实施者不得以"规则表里没有"为由否决一条应当上报的条目。
