# phase 20-2 · 已确认行为差异的逐条处置

七条。每条的结局只有两种：与 oracle 一致，或写进 `intentional-divergences.md` 并说明为何不跟随。
每条都配一个"没修就会红"的测试，且**每个负控都实测跑过**。

---

## 1. 只读会话路径调用 `mkdirSync`（D-5）

**先复核，结果与原描述不符。** 原 claim 说的是 `--list-sessions` / `--delete-session`。实测：

```
命令                                   oracle 新增条目   本仓新增条目
--list-all-sessions                          0               0
--delete-session <不存在的 id>               0               0
--resume-id <不存在的 id>                    0               3
```

违反发生在 `--resume-id`，不在 claim 点名的两个命令上。三个条目是
`~/.pie`、`~/.pie/sessions`、`~/.pie/sessions/<hash>`。

**违反的是本仓自己声明的不变量**（`session-manager.ts:492-500`，`sessionDirForCwd` 的文档）：

> Read-only surfaces ... must not leave an empty `~/.pie/sessions/<hash>/` behind for a cwd
> that has never held a session.

**链路**：`main.ts:421 resolveSessionPath` → `SessionManager.list(cwd)` →
`getDefaultSessionDir`（内含 mkdirSync）。`--list-sessions` 之所以干净，只是因为
`main.ts:329` 恰好已经改用纯函数——修法一直在仓里，没覆盖到 `SessionManager` 的读接口。

**处置**：`SessionManager.list`（:1751）与 `automationElsewhereHint`（:2207）改用
`sessionDirForCwd`。写入面（`create` / `createBranchedSession` / 构造函数的 persist 分支）不动——
oracle 的 `JsonlSessionRepo::create` 同样 `create_dir_all`。

**测试**：`packages/coding-agent/test/session-dir-purity.test.ts`（模块级，含负控：`create` 必须建目录）
+ `cli-state-surfaces.test.ts` F11 新增一条（进程级，断言 `readdirSync(PIE_DIR)` 为空）。

**修后实测**：`--resume-id <不存在的 id>` 两侧同为 0。

---

## 2. Anthropic authorize URL（原记为两处，实为三处）

oracle `crates/ai/src/utils/oauth/anthropic.rs:34-54`。差异：

1. 本仓多带 `code=true`；
2. 参数**顺序**不同（本仓 `code, client_id, response_type, …`；oracle `response_type, client_id, …`）；
3. 编码不同——`URLSearchParams` 是 form 编码（空格 `+`、`_` 不编码），oracle 用
   `NON_ALPHANUMERIC`（空格 `%20`、`_` → `%5F`）。

三处全在**用户浏览器地址栏里看得见的 URL** 上。

**处置**：全部对齐。新增 `encodeNonAlphanumeric`，按 oracle 的顺序拼七个参数、只编码值不编码键。

`code=true` 是 pi 骨架的东西；oracle 的模块注释自称 "Partial 1:1 port" 却主动没有它。去掉它只影响
本仓独有的手动粘贴路径：授权页不再直接显示 `<code>#<state>`，改为照常重定向到本地回调；
远程浏览器场景仍可用——从地址栏复制那条重定向 URL 即可，`parseAuthorizationInput` 的 URL 分支
本就处理这种形式。**诚实边界**：Anthropic 授权页无法密闭驱动，这一条没有端到端实证，
依据是 oracle 作为在跑的产品不带该参数也能完成登录。

**测试**：`anthropic-oauth.test.ts` 新增一条，断言取**原始 query 字符串**而非
`URL.searchParams`——后者会先解码，`+` 与 `%20`、`_` 与 `%5F` 在它眼里完全一样，这条差异就永远看不见。

**负控实测**：还原旧实现 → `expected [ 'code', 'client_id', …(6) ] to deeply equal [ 'response_type', … ]`，红。

**顺带修掉一个会间歇变绿的断言**：第一版写 `code_challenge` 匹配 `/^[A-Za-z0-9\-_]+$/`，
但 base64url 里的 `-`/`_` 会被编码成 `%2D`/`%5F`，只有 43 个字符恰好全是字母数字时才通过（约 25%）。
已改为 `/^[A-Za-z0-9%]+$/` + 解码后校验形状。**20 次连跑 20/20 通过。**

---

## 3. `NO_PROXY` —— 声明偏离 D11

oracle 的模块注释第 4 行写着它处理 `NO_PROXY`，但 `proxy_from_env()` 全文只读四个变量、
从不碰它；`Proxy::all(&url).ok()` 还会把打错字的代理 URL 静默丢弃。

本仓实现完整语义且有测试。**这是方向为"我们做得对"的分叉，且对面是一个安全相关的静默失败**：
在企业内网里 `NO_PROXY` 决定内部主机名不被发到外部代理。跟随 oracle 等于主动删掉正确实现，
去复刻一个**其自身文档承诺存在**的功能缺失。

**处置**：升格为 D11。此前记为 `explained-divergences.tsv` 的 ED6，理由写作"judge 不可观测"——
那个定性是躲避：不可观测说的是判定器看不见，不是"没有立场"。ED6 已标 closed 并指向 D11。

---

## 4. summarization 丢失 `streamFn` 注入缝

oracle `branch_summarization.rs:26` 的 `stream_fn: Option<StreamFn>` 透传给 `generate_summary`，
后者 `compaction.rs:535` 做 `unwrap_or_else(default_stream_fn)`。**oracle 自己的三个测试
（`compaction.rs:819/908/987`）正是靠注入假流函数才能在无网络下跑**——这条缝的意义就是可测试性。

本仓写死 `completeSimple`，同一目的只能靠 `registerFauxProvider` 这种**全局**注册来达成
（`compaction.test.ts` 其余用例全是这么写的），调用方无法按次覆盖。

**缝其实丢在三处**，不止原报告说的一处：`branch-summarization.ts:232`、`compaction.ts:608`、
`compaction.ts:889`。全部补齐，并透传进 `compact()`。

`generateTurnPrefixSummary` 在 oracle 没有对应物，但它在 `compact()` 的 split-turn 分支里被调用——
注入的 streamFn 若绕不过它，测试注入了假流仍会发出真网络请求，那样的缝比没有更糟。所以一起接。

实现是**单路径**：`completeSimple(m,c,o)` 本身就是 `streamSimple(m,c,o).result()`
（`ai/src/stream.ts:59-66`），改成 `(streamFn ?? streamSimple)(…)` 没有产生第二套代码。

**测试**：`compaction.test.ts` 新增两条。关键断言不是"注入的函数被调用了"，而是**"全局 provider
一次都没被碰"**——只断言前者的话，两个都跑一遍也会绿，而那正是缝没接上的样子。

**负控实测**：让 `generateSummary` 忽略注入参数 → `expected +0 to be 1`，红。

---

## 5. `FileErrorCode` 取值不一致（连带查出 `ExecutionErrorCode`）

oracle 的枚举带 `#[serde(rename_all = "snake_case")]`，**取值会上线**。逐项对照：

| oracle 序列化值 | 本仓原值 | 处置 |
|---|---|---|
| `not_a_directory` | `not_directory` | 改名 |
| `is_a_directory` | `is_directory` | 改名 |
| `invalid_path` | `invalid` | 改名 |
| （无） | `not_supported` | 删除（从未被构造过） |
| `spawn_failed` | `spawn_error` | 改名 |
| （无） | `shell_unavailable` / `callback_error` | 保留，声明 D12 |

`ExecutionErrorCode` 是核对时顺带查出的，phase 清单里没点名，但属同一缺陷。

生产代码里按 code 分支的只有 `not_found` 与 `aborted`，两者本就正确；要改名的四个只被构造、
从不被判断。两个测试断言了旧取值，已改为 oracle 的取值——那两条断言相对 oracle 本就是错的。

保留的两个见 D12：它们标记的情形 oracle 根本没有对应站点（oracle 无 shell 发现逻辑；Rust 回调不会抛），
折叠成 `spawn_failed`/`unknown` 会丢诊断信息，换来的对齐是纯形式上的——这些 code 在本仓
**从不进入会话记录，也从不发给模型**。

---

## 6. `push_aborted` 的载荷与费用记账（D-2，本批危害最大的一条）

oracle `abort.rs:116-135` 推的是**全新空消息**：`content: []`、`usage` 全零（含 cost）、
`response_model`/`response_id`/`diagnostics` 均空、`error_message` 恒为 `"aborted"`。

本仓九个 provider 各自在 catch 块里推**累积的 `output`**——部分内容、累计 token 与 **cost**、
底层错误文本一并带出。后果：被中止的一轮带回非零 `usage.cost`，而 harness 在 `message_end` 上
`costTracker.record(event.message.usage)`（`agent-harness.ts:1274-1282`）——**中止轮次被计费**。

**处置**：新建 `packages/ai/src/utils/abort.ts`（`abortedMessage` / `zeroUsage`），九个 provider
的 catch 块统一在 `signal.aborted` 时推 oracle 的空消息。

manifest 把 `ai/utils/abort` 记为 `dissolved:native-AbortSignal`。该判断对五个 `*_or_abort` 辅助函数
成立，对 `push_aborted` **不成立**——合成一条终止消息是应用行为，`AbortSignal` 不提供它。
phase 19 的 surface-coverage 审计第 37 项已指出，本次落实并更正了 manifest 行的 out_path。

**测试**（两个文件，分工明确）：

- `abort-payload.test.ts`：九个 provider + `abortedMessage` 逐字段 + 负控（未中止的失败仍是 error）。
  **判别力边界要说清楚**：该文件用连接拒绝路径，`output` 本来就是空的，所以真正区分新旧实现的是
  `errorMessage`；cost 与 content 两条在这里是回归护栏，不是判别式。
- `abort-payload-midstream.test.ts`：先让内容与 usage 累积（`input_tokens:500` + 一段文本 delta）
  **再**中止。这才是对 cost 有判别力的那个。

**负控实测**（两次，第二次才有效）：

第一次把 `if (options?.signal?.aborted)` 改成 `if (false)` —— 测试**照样全绿**。原因是同一段文本
在文件里出现两次，`replace(..., 1)` 改中的是第 687 行的预检查而不是 catch 块里的分支，
而我的脚本没有断言变异是否落地。**一个没生效的负控等于没有负控。** 加上
`assert s.count(target) == 1` 与 `assert "abortedMessage(model)" not in s` 后重做：

```
abort-payload.test.ts        → expected 'Request was aborted.' to be 'aborted'          红
abort-payload-midstream      → expected [ { type: 'text', text: '部分内容' } ] to be []  红
```

**连带处理的冲突**：`tokens.test.ts` 有 18 个用例叫 "should include token stats when aborted
mid-stream"，断言的正好相反（`usage.input > 0`、`cost.total > 0`）。它们全部凭据门控，密闭下 skip，
但 `npm run test:live` 会跑并**必然失败**。那张按 provider 分叉的矩阵编码的是上游 SSE 什么时候发
usage，也就是 pi 的行为，与 oracle 契约直接冲突。已改为断言 oracle 口径，并连用例名一起改
（留着相反的名字会误导下一个读它的人）。**这是加强不是弱化**：八个 provider 的豁免分支全部取消，
改为一条无例外的判定。

**取舍要说明**：被中止的一轮**确实**消耗了上游 token，归零意味着这部分不进账。这是 oracle 的记账
口径，本仓按行为合同跟随。若日后决定改口径，改的是 `abort.ts` 而不是测试断言。

---

## 7. 中止消息仍进会话转录 —— 声明偏离 D13

同一条发现的第二半。oracle 在 Error 事件上 `return Err` 且不写历史；本仓推进 `context.messages`
并发 `message_end`，harness 据此 `appendMessage`。

修好载荷后，留下的是一条**空** assistant 条目。抹掉它要同时改 `context.messages` 写入、
`message_end` 发射时机，以及依赖该事件的 harness / session / UI kernel / RPC 四条链路；
实测有 20+ 个测试文件、30 处断言建立在"中止会产生一条 message_end"之上。

**这不是"判定不出来所以不管"**：差异明确、可观察，只是被判断为不值得现在动。D13 写明了
对齐入口（`agent-loop.ts:414-424` 的 done/error 分支）与验收标准。

---

## 工程检查（本 phase 结束时实测）

```
npm run build                     成功
bash test.sh                      4206 passed / 0 failed
                                  （agent 443 + ai 462 + coding-agent 2634 + mcp 38
                                    + tui 612 + workers 17；后两个走 node --test，
                                    不发 vitest 的 "Tests" 汇总行）
npm run check                     7 道门禁全绿
bash migration/parity/run-parity.sh   exit=1（预期），差异集逐行等于声明基线：
    S3/requests.norm 2 · S3/run.norm 8 · S3/session.norm 12 · S5/req2body.norm 2
    S6/session.norm 24 · S8/list.norm 2 · S8/resumeerr.norm 2 · S8/resumeexit.norm 2
    其余全部 0，S9–S12 全 0
```

`check:surface-coverage` 未匹配数 43 → **40**，基线已同步收紧（只降不升）。
