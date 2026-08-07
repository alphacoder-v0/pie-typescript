# 批 U —— `check:surface-coverage` 的 40 个「未匹配」

这 40 条从未进过任何名册（`risk-tiers.tsv` 只覆盖 473 条），也从未被任何一轮逐条看过。
门禁自己说它们「对不上名字」。

## 裁定分布

| 裁定 | 条数 |
|---|---|
| `existing-test` | **8** |
| `new-test` | **4** |
| `not-portable` | **28** |
| 合计 | **40** |

## 三类分流（判据 2）

| 类型 | 条数 | 含义 |
|---|---|---|
| **结构差异** | **24** | oracle 有具名函数，本仓用别的语言机制表达同一件事 |
| **启发式漏配** | **12** | **TS 侧有实现，门禁只是没匹配上名字** |
| **真能力缺口** | **4** | oracle 有而本仓确实没有（AWS eventstream / Bedrock） |
| 合计 | **40** | ✓ |

「启发式漏配」= 那 12 条 `existing-test` + `new-test`：TS 侧的实现一直都在，
只是名字对不上门禁的三变体转换。

## ⚠ 双向误差：`check:surface-coverage` 既低估也高估

第四轮的结论是「它低估缺口」。本 phase 补上另一半——**它同时也高估**。

### 高估（报了「未匹配」，其实有）

**40 条里有 12 条（30.0%）是启发式漏配。**

门禁的匹配是 `snake_case` → `camelCase` / `PascalCase` / 原样，三个变体做正则查找。
它匹配不了：

| oracle | 门禁猜的 | TS 实际叫 | 漏配原因 |
|---|---|---|---|
| `generate_pkce` | `generatePkce` | **`generatePKCE`** | acronym 保持大写 |
| `sanitize_surrogates_u16` | `sanitizeSurrogatesU16` | **`sanitizeSurrogates`** | 移植时去掉了 Rust 的类型后缀 |
| `list_api_ids` | `listApiIds` | **`getApiProviders`** | 换了动词（list→get）与名词（ids→providers）|
| `translate_base` | `translateBase` | **`buildBaseOptions`** | 完全重命名 |
| `parse_partial_json` | `parsePartialJson` | **`parseStreamingJson`** | partial→streaming |
| `proxy_from_env` | `proxyFromEnv` | **`resolveHttpProxyUrlForTarget`** | 语义展开 |

### 低估（报了「已匹配」，其实没有）

第四轮已量化：282 条名册里 53 条是 `not-portable`，门禁把它们算作「已匹配」。
本 phase 又添 4 条真能力缺口（AWS eventstream 一族）——它们**也在**门禁的「已匹配」里，
因为 `packages/ai/src` 下有同名的其他符号。

### 两个方向同源

**它只比对名字。** 名字对上了不代表行为在，名字对不上也不代表行为不在。

`check:behavior-evidence` 的 513/513 才是那个能回答「行为在不在」的判据——
它要求每条给出**指向真断言行**的证据，或**逐条论证**的不可移植理由。

**本轮不修 surface-coverage 的 acronym 匹配**：修了它仍然只比对名字。
保留原样并在此标注它的双向误差，比让它看起来更准确要诚实。

## 新写的测试

`packages/ai/test/ported/batch-u.test.ts`，7 例，覆盖 4 个函数：

| 函数 | 测的是什么 |
|---|---|
| `generatePKCE` | challenge 是 BASE64URL(SHA256(verifier))：43 字符无 padding；**两次调用 verifier 不重复**（重复等于 PKCE 失效，拦截者可重放 code 交换）|
| `sanitizeSurrogates` | 合法代理对（U+1F600）必须存活；孤立 `\uD800` 必须被替换——否则 provider 的 JSON 解析器拒收，表现为一个看不出原因的 400 |
| `getApiProviders` | 列出恰好注册过的 api；**`unregisterApiProviders` 按注册源删而非按 api 名删** |
| `buildBaseOptions` | apiKey 必须透传——丢了会表现为「凭据错」而不是「我们根本没发」|

### 又一次「猜 API 而没读」被当场抓住

我写的是 `unregisterApiProviders(["anthropic-messages"])`。红了。
读实现才发现签名是 `unregisterApiProviders(sourceId: string)` ——
它按**注册源**删（一个扩展注册了三个 api，卸载时整体移除），不是按 api 名删。

断言改成注册时带 `sourceId`、卸载时传 `"ext-a"`，顺带把这个语义写进了测试注释。

## 抽查（规则先于结果声明）

**规则**（查看结果之前打进 transcript）：
- **12 条启发式漏配全查**（100%）——它们是改判方向，最该被质疑
- 28 条 `not-portable` 等距抽 `max(5, ⌈28/5⌉)` = **6** 条，步长 4，从 index 0 起
- 抽中编号：#0 · #4 · #8 · #12 · #16 · #20 · #24

**结果：12 + 6 全部通过。**

| 抽中 | 核实 |
|---|---|
| #0 `event_stream::message_type` | `packages/ai/src/event-stream.ts` 不存在 ✓ |
| #4 `types::with_path` | `FileError` 构造器第三参确是 `path?: string`（types.ts:140）✓ |
| #8 `agent::active_token` | `agent.ts` 里 `activeToken`/`getToken` 导出 **0 处**（signal 仅内部用）✓ |
| #12 `session::type_str` | `typeStr` 全文件 **0 命中** ✓ |
| #16 `branch_summarization::summarize_branch` | 该文件确是 **3 个**导出函数，无合一入口 ✓ |
| #20 `abort::send_or_abort` | `sendOrAbort` **0 命中** ✓ |
| #24 `retry::is_aborted` | `isAborted` **0 命中** ✓ |

12 条漏配的证据行全部经门禁断言行判据（非注释、含 `expect(`）。

## 两次被 `assert` 拦下的错误

写入脚本时 `assert` 挡住了两类错误，**都没有静默进证据表**：

1. **7 条 oracle 行号我凭印象写错了**（如 `enqueue_steering@158` 实为 `@1580`）。
   名册是唯一事实源，按它批量校正。
2. **3 条证据行号指到了 `it(` 行或被 biome 拆行的 `expect(`**。
   改成从文件里**实读**断言行，不再手填。

第 2 类正是上一轮「evidence 必须指向断言行」那条规则要防的事——规则在这里又兑现了一次。
