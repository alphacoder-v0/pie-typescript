# phase 20-3 · 移植 oracle `crates/ai` 内联单测

## 1. 去重：46 这个数从哪来

ROADMAP 写的是「上界 46」。实测 oracle `crates/ai` 的内联测试（`#[cfg(test)]` 块内的
`#[test]` / `#[tokio::test]`）总数是 **82**。差额的来源是可复现的：

```
 82  oracle crates/ai 内联测试总数
-36  名字已被 packages/ai/test/ 直接引用（刻意移植过，注释里写了 oracle 测试名）
────
 46  ← ROADMAP 的「上界 46」
```

**这 46 是上界不是缺口数**，因为按名字去重会有假阴性：行为被覆盖但没在注释里署名的，
也会落进这 46。所以对每一条都读了 oracle 的测试体，再去 TS 侧找**具体的断言**，
找不到才算缺口。

## 2. 46 条的逐条裁定

### 2.1 不可移植 —— 14 条

这些 oracle 单元在 TS 侧由第三方库承担，oracle 的测试测的是**它自己那份实现**，
移植过来等于测 AWS SDK，不是测本次移植。

| oracle 文件 | 条数 | manifest 归宿 | 说明 |
|---|---|---|---|
| `sigv4.rs` | 4 | `dissolved:adopted-@aws-sdk/signature-v4` | 签名算法整体采纳 SDK |
| `utils/aws_eventstream.rs` | 2 | `dissolved:adopted-@aws-sdk/client-bedrock-runtime` | AWS 二进制帧解码 |
| `event_stream.rs` | 4 | `consolidated:` 到 `utils/event-stream.ts` | crc32 / prelude CRC / 短缓冲——TS 全仓无此代码，`grep crc32` 零命中 |
| `bedrock_anthropic.rs` | 3 | `consolidated:` 到 `amazon-bedrock.ts` | Anthropic-over-Bedrock 的 SSE Converter；TS 用 SDK 的 ConverseStream，无自建解析 |
| `utils/abort.rs` | 1 | `dissolved:native-AbortSignal` | `next_or_abort` 是 Rust 特有的 token-vs-future 竞速；TS 用原生 AbortSignal。（同文件的 `push_aborted` **不属此列**，已在 phase 20-2 落地为 `utils/abort.ts`） |

### 2.2 行为已被覆盖、只是没署名 —— 10 条

| oracle `#[test]` | TS 侧的具体断言 |
|---|---|
| `stop_reason_mapping`（bedrock） | `bedrock-usage-and-stop-reason.test.ts:165` |
| `long_retention_adds_ttl` | `cache-retention.test.ts:208` |
| `replays_queued_text_and_tool_call` | `faux-provider.test.ts:117` + `:392` |
| `falls_back_to_canned_message` | `faux-provider.test.ts:117`（oracle 只断言 `is_some()`，TS 返回 error 消息同样满足） |
| `excludes_rate_limit` | `overflow.test.ts:57` + `:69` |
| `length_stop_zero_output` | `overflow.test.ts:99` |
| `silent_overflow_via_usage` | `overflow.test.ts:142` |
| `from_env_requires_project_and_one_auth_method` | `google-vertex-token-resolution.test.ts:193` + `:204` |
| `client_id_decodes` | `anthropic-oauth.test.ts`（phase 20-2 新增，逐字节断言 `client_id=9d1c250a%2D…`） |
| `authorize_url_contains_pkce_and_state` | 同上（断言 `code_challenge` / `S256` / `state` / `response_type=code`） |

**外加一条 `fireworks_compat_disables_cache_on_tools`**：我最初把它列为缺口并写了测试，
运行时才发现 `fireworks-models.test.ts:56`（"sets Fireworks-specific compat…"）与 `:212`/`:183`
已经覆盖。已删除重复用例，并在文件里留了溯源注释。这是名字去重假阴性的一个实例。

### 2.3 真缺口，本次移植 —— 22 条

| # | oracle `#[test]` | 落点 |
|---|---|---|
| 1 | `handle_survives_unregister_after_lookup` | `ported/oracle-inline-core.test.ts` |
| 2 | `handle_survives_clear_after_lookup_for_simple_stream` | 同上 |
| 3 | `detects_anthropic_overflow` | 同上 |
| 4 | `detects_openai_and_gemini` | 同上 |
| 5 | `cross_model_thinking_becomes_text` | 同上 |
| 6 | `orphaned_tool_call_gets_synthetic_result` | 同上 |
| 7 | `creds_from_env_returns_none_without_keys` | 同上 |
| 8 | `cache_control_applied_to_system_and_last_user` | `ported/oracle-inline-request-bodies.test.ts` |
| 9 | `tools_get_cache_control_on_last` | 同上 |
| 10 | `body_has_messages_and_stream_options` | 同上 |
| 11 | `assistant_tool_calls_serialize` | 同上 |
| 12 | `image_user_content_uses_image_url` | 同上 |
| 13 | `body_uses_instructions_not_system_message` | 同上 |
| 14 | `thinking_budget_sets_generation_config` | 同上 |
| 15 | `finish_reason_mapping` | `ported/oracle-inline-provider-misc.test.ts` |
| 16 | `url_resolution` | 同上 |
| 17 | `deployment_name_defaults_to_model_id` | 同上 |
| 18 | `deployment_name_from_option` | 同上 |
| 19 | `parse_callback` | 同上 |
| 20 | `parse_callback_no_query` | 同上 |
| 21 | `body_has_converse_shape` | `ported/oracle-inline-bedrock-body.test.ts` |
| 22 | `tool_result_converts` | 同上 |

合计：**14 不可移植 + 10 已覆盖（+1 运行时发现的重复）+ 22 移植 = 46**。

## 3. 「一上来就红」的清单与归类

**归类为实现缺陷（regression / 已声明偏离 / oracle 缺陷照抄）的：0 条。**

初次运行确实有 5 条红，但逐条查下来**全部是我自己的 harness 错误**，不是实现问题。
它们没有第四类归属，因为它们根本不是「测试与实现的分歧」：

| 初红 | 真正原因 | 处置 |
|---|---|---|
| `body_has_messages_and_stream_options` 等 3 条 | `getModel("openai","gpt-4o-mini")` 解析出的 `api` 是 **openai-responses**，不是 openai-completions——选错了 provider | 改用 `groq/llama-3.3-70b-versatile`（`api: openai-completions`） |
| `image_user_content_uses_image_url` | groq 的 llama `input` 只有 `text`，图片先被 `downgradeUnsupportedImages` 降级成文本占位，测到的是降级逻辑 | 改用显式构造的、`input` 含 `image` 的 openai-completions 模型 |
| `body_uses_instructions_not_system_message` | codex 在构建载荷**之前**先从 token 解 accountId，假 key 不是 JWT 形状就在 `onPayload` 之前失败 | 用 JWT 形状的假 token |
| `parse_callback_no_query` | 第一版靠「超时 30s」来推断服务器没结算——那是卡住，不是断言 | 改为给手动输入退路，断言最终换 token 用的是手动 code |
| `fireworks_compat_disables_cache_on_tools` | 目录里的 fireworks 模型不带 `compat` 字段——因为该行为已由别处覆盖 | 删除重复用例，记入 §2.2 |

**这个结果本身值得说明**：22 条 oracle 断言全部一次通过，说明这些行为此前就是对的，
缺的只是**断言**。价值不在「发现了缺陷」，而在「这 22 处行为从此有人盯着」——
在此之前它们属于「约 470 个只验证了名字对得上」的那一批。

## 4. 负控（三条，全部实测）

criterion 要求任选 3 个新测试改坏实现证明会红。每次变异脚本都带 `assert` 确认变异真的落地——
phase 20-2 出过一次「变异没生效、负控假通过」，不再重演。

| # | 变异 | 结果 |
|---|---|---|
| 1 | `transform-messages.ts` 合成 toolResult 的 `isError: true` → `false` | `expected false to be true` **红** |
| 2 | `overflow.ts` 的 `/prompt is too long/i` 换成永不匹配的模式 | `expected false to be true` **红** |
| 3 | `anthropic.ts` 去掉 last-user 循环里的 `break`（cache_control 打到每一条 user） | `expected { type: 'ephemeral' } to be undefined` **红** |

第 3 条的第一次尝试因为定位不到判定标识而被 `assert` 拦下（脚本报「未定位到 last-user 判定」
并中止），这正是加断言的意义——若按 phase 20-2 那样不加，它会静默地什么都没改然后「通过」。

## 5. 工程检查

```
npm run build     成功
npm run check     7 道门禁全绿（surface-coverage 未匹配 40，基线 40）
bash test.sh      exit 0；合计 4228 passed / 0 failed
                  （agent 443 + ai 484 + coding-agent 2634 + mcp 38 + tui 612 + workers 17）
```

ai 包由 462 → **484**，正好是本 phase 新增的 22 条。
