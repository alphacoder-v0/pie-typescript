# 批次 E — 渲染、输入、媒体与 ai 剩余（26 条）

`markdown.rs` 6 · `images.rs` 5 · `mentions.rs` 5 · `readline.rs` 2 · `clipboard_image.rs` 1 ·
`ai/providers/faux.rs` 2 · `ai/utils/overflow.rs` 2 · `ai/providers/anthropic.rs` 1 ·
`ai/utils/abort.rs` 1 · `ai/vertex_provider.rs` 1。

**分布：covered 26 · not-portable 0 · gap 0。**

五个批次里唯一零缺口的一批。原因也清楚：这批是**用户可见字节**，上一轮的 parity 场景与
`markdown-stream.test.ts` 这类「逐字节对齐」的测试早就把它们盯住了——
`markdown-stream.test.ts` 的 describe 标题直接写着 `markdown.rs streaming renderer
(oracle #[cfg(test)] ports)`，六个 `it` 与 oracle 的六条**同名**。

## markdown.rs（6）—— 判据 3 要求指向具体 ANSI 转义序列

| oracle 测试 | evidence | 那一行断言了什么 |
|---|---|---|
| `bold_inline_emits_ansi` | `markdown-stream.test.ts:16` | `assert.ok(s.includes("\x1b[1m"))` |
| `italic_inline_emits_ansi` | `:26` | `assert.ok(s.includes("\x1b[3m"))` |
| `code_inline_emits_ansi` | `:33` | `assert.ok(s.includes(CODE))`，`CODE` 由 `:77` 钉死为 `"\x1b[2;36m"` |
| `heading_marked` | `:41` | `assert.ok(s.includes(HEADING))`，同组常量在 `:73-77` 逐条钉死 |
| `renderer_tracks_fence_across_lines` | `:49` | 围栏跨行时状态延续 |
| `unclosed_backtick_is_left_alone` | `:61` | `assert.strictEqual(s, "partial \`code")` —— 原样返回 |

判据 3 说「不是『渲染没崩』这类弱断言」。这里满足得比要求更彻底：`:72-77` 有一条独立用例
把 `RESET`/`BOLD`/`ITALIC`/`DIM`/`CODE` 五个 SGR 字面量逐个 `strictEqual` 到具体字节串，
所以即使某条用例改用常量名断言，常量本身也被钉住了。

## 其余 20 条

| oracle 测试 | evidence |
|---|---|
| `infer_png` / `infer_jpeg` / `infer_webp` | `image-attachments.test.ts:34` / `:39` / `:47` |
| `load_one_rejects_unknown_format` | `:57` —— 三条 `infer_*` 的负控，单独一行 |
| `load_one_round_trips_a_png` | `:85` —— 路径读入与字节读入产出同一 base64 |
| `extracts_simple_mention` / `extracts_multiple_with_punctuation` / `ignores_at_inside_email` | `mentions.test.ts:38` / `:43` / `:48` |
| `expand_returns_input_unchanged_when_no_mentions` | `:109` |
| `expand_reads_files_and_falls_back_to_error_block_on_missing` | `:120` |
| `lists_commands_and_aliases_for_bare_slash` / `no_completion_once_argument_typed` | `readline.test.ts:35` / `:48` |
| `encodes_rgba_clipboard_image_as_png` | `clipboard-paste.test.ts:66` —— 同一夹具 `(1,1,[255,0,0,255])`，`:71` 断言 PNG 魔数 |
| `falls_back_to_canned_message` | `faux-provider.test.ts:42` —— 比 oracle 强：oracle 只断言 `is_some()`，这里断言 canned 内容本身 |
| `replays_queued_text_and_tool_call` | `:62` —— text + toolCall 同轮回放，`:66` 断言 `stopReason: "toolUse"` |
| `excludes_rate_limit` | `overflow.test.ts:71` |
| `length_stop_zero_output` | `:101` |
| `long_retention_adds_ttl` | `cache-retention.test.ts:87` —— `cache_control` 等于 `{type:"ephemeral", ttl:"1h"}` |
| `next_or_abort_stops_pending_stream` | `abort-payload.test.ts:126` —— 见下 |
| `from_env_requires_project_and_one_auth_method` | `google-vertex-token-resolution.test.ts:210` |

### `next_or_abort_stops_pending_stream` 值得单说

oracle 测的是一个**原语**：已取消的 token + 一个永不产出的流 → `next_or_abort` 立刻返回
`Aborted`（不挂起）。TS **没有** `nextOrAbort` 这个原语——中止检查内联在各 provider 的流循环里。

判 covered 的依据是**行为等价而非结构等价**：`abort-payload.test.ts:121` 用的正是一个
**预先 `controller.abort()`** 的 signal，跑完九个 provider 并断言 `stopReason === "aborted"`，
用例挂着 20 秒超时——实现若挂起，它必红。这就是 oracle 那条守的东西。

`abort.test.ts` 那组同名的 "should handle immediate abort" 是 **live provider** 测试
（`{ retry: 3 }`，密闭时跳过），不能拿来当密闭证据。

## `excludes_rate_limit` 与本机 test:live 的已知失败

这条断言的是「429 / rate limit 不算上下文溢出」。它与 phase 19/20 记录的那条 `test:live`
environment 类失败是同一个主题的两面：

- **密闭侧**（这条）：给一个 rate-limit 错误，`isContextOverflow` 必须答 false —— 已覆盖。
- **live 侧**：那条用例要触发真实的上下文溢出，但本账号配额（1,000,000 tokens/分钟）
  小于模型上下文窗口，429 必然先到，于是永远测不到溢出分支。

所以密闭侧的覆盖是完整的，live 侧的失败是账号条件不满足，两者不冲突。

## 抽查（判据 4）

**抽样规则先于结果确定**：batch=E 且 verdict=covered 的行按台账行号升序编号 1..26，
取编号 ≡ 0 (mod 3)，需要 `max(5, ⌈26/3⌉)` = 9 个；该规则在 26 条内产出 8 个
（3、6、9、12、15、18、21、24），即全部符合条件者，故实际抽 8 条。

| # | oracle 断言 | TS 断言 |
|---|---|---|
| 3 | `assert_eq!(text, "hi there"); assert_eq!(tool_name, Some("weather"))` | `expect(response.content).toEqual([…thinking, toolCall, text…])` |
| 6 | `m.stop_reason = Length; m.usage.output = 0; assert!(is_context_overflow(&m, Some(200_000)))` | `expect(isContextOverflow(message, 1048576)).toBe(true)` |
| 9 | `assert_eq!(infer_mime(&jpeg_bytes), Some("image/jpeg"))` | `expect(inferMime(...)).toBe("image/jpeg")`（断言体跨三行，evidence 指 `expect(` 所在的 :39） |
| 12 | `assert!(load_one(unknown).is_err())` | `expect(inferMime(new Uint8Array(Buffer.from("not an image")))).toBeUndefined()` |
| 15 | `assert!(s.contains(CODE))` | `assert.ok(s.includes(CODE))` |
| 18 | `assert!(open.contains(DIM))` | `assert.ok(open.includes(DIM))` |
| 21 | `assert_eq!(expand("just a regular prompt", dir).prompt, "just a regular prompt")` | `expect(result.prompt).toBe("just a regular prompt")` |
| 24 | `assert!(extract_mentions("ping user@host.com").is_empty())` | `expect(extractMentions("ping user@host.com")).toEqual([])` |

一处调整：`infer_jpeg` 我一度把 evidence 指到 `:41`（`.toBe("image/jpeg")` 那行，可读性更好），
**门禁当场拒绝**——它只认含 `expect(` 的行，而折行断言的续行不含。规则没错，`:39` 才是
`expect(` 所在处；已改回并把折行的事记进 note。这是 phase 4 新增的那条规则第二次替我挡住手滑。

全局去重复核：**83 条 covered → 83 个各异 evidence 行，无重复**。

## 负控

本批零 gap，无新增测试，判据 5 的前提为空。既有 26 条断言的判别力由它们各自所在文件的
既有负控保障（例如 `markdown-stream.test.ts:72-77` 把 SGR 常量逐个钉死，任何一个常量改动
都会让引用它的用例转红）。

## 全台账收官（判据 2 / 6）

```
剩余 TODO: 0
合计：121 条 — covered 83 · not-portable 4 · gap 34
```

**真缺口 34 条**，规划时按 ai/agent 的比例外推是 20–35，落在区间上沿。

四条 not-portable 逐条有据：

| oracle 测试 | 理由 |
|---|---|
| `cli_parses_session_export_import_commands` | D7（已声明）：`pie session export\|import` 有意不实现 |
| `cli_session_import_ask_imports_disabled_first` | 同 D7 |
| `needs_refresh_evaluates_expiry_slack` | oracle 自身的死代码（零生产调用点），slack 烘焙在 mint 时刻且 TS 已复刻 |
| `export_manifest_uses_explicit_leaf_target_not_leaf_row_id` | pi 的 `SessionEntry` 联合无 `leaf` 变体；我一度误判为缺陷，被 tsgo 驳回 |

各批分布：

| 批 | 主题 | covered | not-portable | gap |
|---|---|---|---|---|
| A | CLI 与命令面（31） | 14 | 2 | **15** |
| B | 凭据与安全（19） | 16 | 1 | 2 |
| C | 模型与技能配置（32） | 19 | 0 | **13** |
| D | 会话归档与恢复（13） | 8 | 1 | 4 |
| E | 渲染 / 输入 / 媒体 / ai（26） | 26 | 0 | 0 |
| | **合计 121** | **83** | **4** | **34** |

缺口高度集中在 A 与 C（28/34 = 82%）。这两批的共同点是**从未被逐条核过**，而 B 与 E
上一轮已按安全面 / 用户可见字节做过针对性覆盖。

## 命令与结果

```
node scripts/check-triage-ledger.mjs   OK — 剩余 TODO 0（全 121 条）
npm run check                          exit 0（9 道门禁）
bash test.sh                           exit 0 — 4309 passed / 0 failed
                                       本批零 gap，无新增测试，数字与批次 D 后相同
```
