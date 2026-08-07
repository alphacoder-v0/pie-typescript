# 批 D —— ai + mcp（53/53）

`roster.tsv` 中 `batch=D` 的 53 个函数，全部有裁定。

## 裁定分布

| 裁定 | 条数 |
|---|---|
| `existing-test` | **18** |
| `new-test` | **8** |
| `not-portable` | **27** |
| 合计 | **53** |

**`not-portable` 占比 51%** —— 是本轮迄今最高的一批，且这个数字本身就是结论。

## 为什么这一批 not-portable 这么多

三个成因，都不是「漏移植」：

### ① 整条路径未移植：AWS Bedrock 二进制帧（5 条）

`ai/src/event_stream.rs` 是 `application/vnd.amazon.eventstream` 的解析器
（Bedrock 的 `:invoke-with-response-stream` 专用）。整个文件在 TS 侧没有对应物：

| 函数 | |
|---|---|
| `event_stream.rs::event_type` | phase 3 已判 |
| `event_stream.rs::content_type` | 同文件，同因 |
| `event_stream.rs::crc32` | 帧校验 |
| `aws_eventstream.rs::new` | 解析器构造 |
| `bedrock_anthropic.rs::new` | Bedrock 的 Anthropic 适配（本仓由 anthropic.ts 的 baseUrl 路由承担） |

这是**能力缺口**，不是命名差异。`check:surface-coverage` 把它们算作「已匹配」
（因为 TS 侧有同名的其他符号），这正是它低估缺口的机制。

### ② Rust 惯用法在 TS 里不需要（5 条）

`types.rs` 的 `as_str` / `known` / `is_terminal` / 两个 `text` 构造器：
oracle 用枚举 + `impl` 方法，本仓用**字面量联合类型 + 对象字面量**。
「把枚举转成线格式字符串」这件事在 TS 里不存在——字符串就是值本身。

### ③ 需要真实 I/O 或只能 tautology（5 条）

| 函数 | 情况 |
|---|---|
| `mcp/http.rs::connect` | 会发起真实 HTTP 握手，密闭测试覆盖不到 |
| `mcp/stdio.rs::spawn` | 启动真实子进程；`client-fixture.test.ts` 用的是内存 transport |
| `mcp/http.rs::new` | TS 侧构造器是 **private**（`http.ts:333`），只能经 `connect()` 建实例 |
| `mcp/http.rs::set_auth` | 只把凭据存进 transport，效果全在后续请求头上——单测只能断言「存进去又读出来」 |
| `ai/utils/abort.rs::sleep_or_abort` | 有实现但未导出；退避中止由 `sendWithRetry` 的整体行为覆盖 |

`set_auth` 这条与批 C 的 `set_compaction_settings` 同型：**可测，但只能 tautology**。
硬写一条只会给证据表灌水。

## 新写的测试

两个文件，13 例：

| 文件 | 覆盖 | 要点 |
|---|---|---|
| `packages/ai/test/ported/batch-d.test.ts` | images 注册表 · `validateToolCall` · `EventStream` 生命周期 | 见下 |
| `packages/mcp/test/ported/batch-d.test.ts` | `makeRequest` / `makeNotification` | request 与 notification 的区别**只在有没有 `id`**——弄反了对端会一直等一个永不到来的响应 |

`EventStream` 那组值得单说：`end()` settles `result()` 这条守的正是
「UI 卡在思考中」那个故障——流没被关闭，`result()` 永不 resolve。

`validateToolCall` 的错误信息断言也不是形式主义：错误里必须带工具名
（`Tool "nope" not found`），模型看到才知道自己调错了；一个泛化的 "invalid call"
只会让它重试同样的错误。

### 一次被运行时抓住的契约误解

我写 `expect(getImagesApiProvider(api)).toBe(provider)`，红了。
读实现才发现注册时会**重建**内部 provider 并把 `generateImages` 包一层
（`images-api-registry.ts:42-48`），取回的不是同一引用。
断言改为按 `api` 断言身份 + 用「第二次注册后引用变了」验证覆盖语义。

这是本轮第 5 次「猜 API 而没读」被测试抓住（前四次：`markRunning` 不存在、
`GoalState` 无 `text`、`appendMessage` 返回 id 字符串、`inbox.json` 实为 `.jsonl`）。

## 抽查（规则先于结果声明）

**规则**：批 D 的 `existing-test` 共 18 条，抽 `max(5, ⌈18/3⌉)` = **6** 条，
按 `evidence.tsv` 中本批行的出现顺序等距取（步长 3，从 index 0 起）。

抽中并核实：`api_registry::get_api_provider` · `env_api_keys::env_var_names` ·
`cloudflare::resolve_cloudflare_base_url` · `hash::short_hash` ·
`mcp/client::tools_list` · `event_stream::push`。

**6 条全部通过三问。** 其中两条特别强：

- `env_var_names("ds4")` → `toEqual(["DS4_API_KEY"])`，测试标题直接写着「matching oracle's env_var_names("ds4")」
- `shortHash("hello") === shortHash("hello")`——`hash.test.ts` 是它的专属测试文件

### 反向移植的标注

`ai/src/utils/hash.rs::short_hash` 是 **pi → oracle 的反向移植**：
实现文件头写明「1:1 port of `packages/ai/src/utils/hash.ts`」。
它的证据指向 `hash.test.ts`，那是 **TS 侧原版**的测试——不是「移植后补的」，
而是 oracle 当初照着抄的那一份。批 D 只此一例，已在证据表的裁定里体现（`existing-test`，非 new）。

## 命令与结果

```
node scripts/find-behavior-evidence.mjs D     48 条待裁定 → 28 有候选 / 20 无候选
node scripts/check-behavior-evidence.mjs      批 D 53/53；累计 209/282（74.1%）
                                              existing-test 132 · new-test 37 · not-portable 40
npm run check                                 exit 0（11 道门禁）
bash test.sh                                  exit 0 — 4397 passed / 0 failed
                                              （agent 470 · ai 497 · coding-agent 2751 · mcp 50 · tui 612 · workers 17）
                                              基线 4319 → +78，只增不减
密闭性                                        ~/.pie/sessions 3297 → 3297，增量 0
```

### `anchor` 规则本批省了 7 次手工查找

行号漂移在本批发生 7 次（追加测试 3 次 + biome 重排版 4 次）。门禁每次都直接给出正确行号，
最后一次我把它做成了**自动闭环**：解析门禁输出里的「锚点现在在第 N 行」，批量应用。
这条规则是 phase 3「复发失败上移」的产物，到本批已经完全兑现。
