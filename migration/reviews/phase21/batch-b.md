# 批次 B — 凭据与安全面（19 条）

`auth.rs` 6 · `mcp_loader.rs` 5 · `debug.rs` 3 · `bug_report.rs` 2 ·
`ai/src/utils/oauth/anthropic.rs` 2 · `hooks.rs` 1。

**分布：covered 16 · not-portable 1 · gap 2。**

与批次 A（gap 48%）形成鲜明对照。原因不难理解：这批里的东西**上一轮就被当成安全面重点做过**
——`bug-report.test.ts`、`debug.test.ts`、`mcp-loader.test.ts` 的脱敏断言几乎是 oracle 的逐字复刻，
连否定断言的字符串都一样。缺口只剩 `auth.rs` 的两条。

## 八条凭据泄漏直接相关项 —— 逐条结论

phase spec 规定这八条**只能是 `covered`（带行号）或 `gap`（已移植）**，不接受 `not-portable`。
实测**八条全部 `covered`**：

| # | oracle 测试 | verdict | evidence | 那一行断言了什么 |
|---|---|---|---|---|
| 1 | `save_sets_mode_0600` | covered | `auth-storage.test.ts:487` | `expect(statSync(authJsonPath).mode & 0o777).toBe(0o600)`，且**先 `umask(0o000)`** 再断言——比 oracle 更强 |
| 2 | `streamable_http_auth_resolves_from_auth_store_without_debug_leak` | covered | `mcp-loader.test.ts:559` | `expect(debug).not.toContain(token)`（:560 再断言 `<redacted>` 在场） |
| 3 | `streamable_http_missing_auth_diagnostic_does_not_echo_token_ref` | covered | `mcp-loader.test.ts:571` | `expect(message).not.toContain(secretLikeRef)`（:572 断言 `<configured-token-ref>`） |
| 4 | `debug_context_redacts_user_and_tool_result_secrets` | covered | `debug.test.ts:92` | `[REDACTED:openai_anthropic_key]` 正断言 + :93 原值否定断言；tool-result 的 bearer 在 :110-111 |
| 5 | `debug_tool_call_and_assistant_text_are_redacted` | covered | `debug.test.ts:124` | 工具参数里的 github token；assistant 文本与 thinking 在 :132-135 |
| 6 | `debug_error_message_is_redacted` | covered | `debug.test.ts:146` | provider 错误正文里的 bearer 被脱敏 |
| 7 | `redacts_known_patterns` | covered | `bug-report.test.ts:60` | 十条否定断言 :60-69 + 五条 `[REDACTED:*]` 正断言 :71-76，与 oracle 逐条同形 |
| 8 | `redact_leaves_normal_text_alone` | covered | `bug-report.test.ts:82` | 反例：无密钥文本 `toBe(s)` 原样返回 |

第 7、8 条是**一对**（正例 + 反例），evidence 指向两个不同的断言行，符合判据 4。

## 其余 11 条

| oracle 测试 | verdict | evidence / 理由 |
|---|---|---|
| `round_trip_api_key` | covered | `auth-storage.test.ts:843`（读侧）；写侧落盘字节由 :371 断言 |
| `round_trip_oauth` | covered | `auth-storage.test.ts:861` —— access / refresh / expires / scopes 四字段逐一断言，含秒→毫秒换算 |
| `empty_configs_reports_zero` | covered | `mcp-loader.test.ts:145`（serverNames / tools / hooks / diagnostics 四空断言，clientCount 0 在 :144） |
| `streamable_http_rejects_command_args` | covered | `mcp-loader.test.ts:411` |
| `streamable_http_config_deserializes_with_bearer_ref` | covered | `mcp-loader.test.ts:434` |
| `authorize_url_contains_pkce_and_state` | covered | `anthropic-oauth.test.ts:153`；:157 断言七个参数的**完整顺序**，:169-175 断言各自逐字节编码值——比 oracle 的 5 条 `contains` 强 |
| `client_id_decodes` | covered | `anthropic-oauth.test.ts:171` —— 断言 URL 里的 `9d1c250a%2De61b%2D44d9%2D88ed%2D5944d1962f5e`，其解码即 oracle 断言的 UUID；`decode()` 一旦坏掉该断言必红 |
| `compaction_command_hook_receives_env_and_payload` | covered | `hooks.test.ts:295` —— 钩子命令行逐字复刻 oracle（:277），断言输出 `"compaction manual 42 "` |
| `needs_refresh_evaluates_expiry_slack` | **not-portable** | 见下 |
| `missing_file_loads_empty_store` | **gap** | → `ported/auth-batch-b.test.ts` |
| `resolve_for_provider_uses_shared_provider_env_map` | **gap** | → 同上 |

## 唯一的 not-portable：`needs_refresh_evaluates_expiry_slack`

oracle 的 `ProviderCredential::needs_refresh(slack_seconds)` **有零个生产调用点**——
`auth.rs:240` / `:241` / `:243` 三处引用**全在它自己的测试里**。

它参数化的那个 slack，实际烘焙在 **mint 时刻**：

```rust
// oracle crates/ai/src/utils/oauth/anthropic.rs:69
expires_at: Some(now + t.expires_in * 1000 - 5 * 60 * 1000),
```

刷新判定于是就是裸 `now >= expires_at`，不需要运行时 slack。TS 逐字复刻了这个减法
（`packages/ai/src/utils/oauth/anthropic.ts:242` 与 `:439`），刷新判定同为
`Date.now() >= cred.expires`（`auth-storage.ts:844`）。

**移植这个函数只会在 TS 侧新增一段同样没人调用的死代码。** 它守的行为在本仓的落点是那两处
减法，而那两处是 oauth 流程的一部分，由 `anthropic-oauth.test.ts` 覆盖。

这条不属于 phase spec 圈定的八条凭据泄漏项，所以 `not-portable` 不违反「八条不接受
not-portable」的规定。

## 两条 gap 与它们的移植

### `missing_file_loads_empty_store`

`auth-storage.test.ts:537` 覆盖的是**空白内容**的 auth.json（`""` / `"\n"` / 空格 / CRLF），
那是「文件在、内容空」的解析分支。**「文件根本不存在」走 ENOENT，是另一条路径**，此前无断言。

移植后断言三件事：`list()` 为空 · `get()` 为 undefined · **读取不得创建文件**
（oracle `load_from` 的 `if !path.exists() { return Ok(Self::default()) }`；给从未登录过的用户
凭空造一个空 auth.json，会让「有没有登录过」从文件系统上看不出来——parity S7 抓到过同类问题）。

### `resolve_for_provider_uses_shared_provider_env_map`

`auth-storage.test.ts:743/764/775` 覆盖了「env 胜过存储」「无 env 回落存储」「空白 env 跳过」，
但**全程只用 `ANTHROPIC_API_KEY` 一个变量**。

oracle 这条的重点是放一个**诱饵**：另一个 provider 的 env var 也在场时，它绝不能满足本 provider
的查询；撤掉本 provider 的变量后结果必须变空，而不是退而求其次拿诱饵。

这是安全语义——env 映射一旦退化成「随便找一个已设置的 API key」，用户的 openai 密钥
就会被发往 deepseek 的 endpoint。与 `main-batch-a.test.ts` 里 store 侧的 fails-closed
是同一个风险的两半。

## 抽查（判据 5）

**抽样规则先于结果确定**：batch=B 且 verdict=covered 的行按台账行号升序编号 1..16，
取编号 ≡ 0 (mod 3) → 3、6、9、12、15；不足 6 条补末条 16。
抽查数 = `max(5, ⌈16/3⌉)` = 6。

抽中 **#3 #6 #9 #12 #15 #16**（台账第 15 / 18 / 42 / 79 / 82 / 83 行）。

| # | oracle 断言 | TS 断言 |
|---|---|---|
| 3 | `match reloaded.get("anthropic").unwrap() { ApiKey { value } => assert_eq!(value, "sk-test") }` | `expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "sk-oracle-stored" })` |
| 6 | `assert_eq!(redact(s), s);`（s = `"hello world, no secrets here"`） | `expect(redact(s)).toBe(s)` |
| 9 | `assert!(line.contains("[REDACTED:bearer_token]"));`（error message 分支） | `expect(rendered).toContain("[REDACTED:bearer_token]")` |
| 12 | `assert!(tools.is_empty()); assert!(hooks.is_empty()); assert!(diagnostics.is_empty()); assert_eq!(client_count, 0); assert!(server_names.is_empty());` | `expect(loaded.serverNames).toEqual([])` + :144 clientCount 0 + :146 tools + :147 hooks + :149 diagnostics |
| 15 | `assert!(!err.contains(secret_like_ref), "{err}");` | `expect(message).not.toContain(secretLikeRef)` |
| 16 | `assert!(err.to_string().contains("must set endpoint, not command/args"), "{err}");` | `expect(result.diagnostics[0]).toContain("must set endpoint, not command/args")` |

**抽查又抓到一处我自己的错**：#9 原本填 `debug.test.ts:110`，但那一行属于
`debug_context_redacts_user_and_tool_result_secrets` 的 tool-result 分支——同一行被两条不同的
oracle 测试引用了。改为 `:146`（error-message 分支的真实断言行）。

修正后做了一次**全局去重检查**：30 条 covered 指向 30 个各异的 evidence 行，无重复引用。
这个检查已成为后续批次的例行动作。

## 负控（两条 gap 各一，变异脚本带 assert）

| 变异目标 | 变异内容 | 结果 |
|---|---|---|
| `auth-storage.ts` `getApiKey` | env 查找退化为「本 provider 没有就扫所有 `*_API_KEY` 取第一个」 | 诱饵那条当场红，缺失文件那条正确保持绿 |
| `auth-storage.ts` `create()` | 对缺失路径抢先建文件 | 缺失文件那条红（`读取不得创建文件: expected true to be false`），诱饵那条保持绿 |

两个变异各自只打红对应的一条，交叉不影响——说明两条断言各守各的面，不是同一条的重复。

## 凭据纪律自查（判据 7）

```
新增文件中真实凭据形态（sk- / ghp_ / xoxb- 且非 -synthetic）：无命中
新增测试是否提及 ~/.sf-key 或真实 ~/.pie/auth.json：均未提及
测试内实际赋值的凭据：sk-deepseek-env-synthetic / sk-openai-should-not-count-synthetic
（注释中出现的无后缀版本是 oracle 测试源码原文的引用，不是本仓代码使用的值）
PIE_DIR 全程指向 mkdtemp 目录，afterEach 还原并删除；真实 ~/.pie/ 不被读也不被写
```

## 命令与结果

```
node scripts/check-triage-ledger.mjs   OK — 批次 B 剩余 TODO 0（covered 16 · not-portable 1 · gap 2）
npm run check                          exit 0（9 道门禁）
bash test.sh                           exit 0 — 4292 passed / 0 failed
                                       （agent 450 · ai 484 · coding-agent 2683 · mcp 46 · tui 612 · workers 17）
                                       批次 A 后 4290 → +2
```
