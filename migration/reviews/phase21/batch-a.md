# 批次 A — CLI 与命令面（31 条）

`coding-agent/src/commands.rs` 18 条 + `main.rs` 13 条。

**分布：covered 14 · not-portable 2 · gap 15。**

gap 占比 48%，预计是五个批次里最高的——这批从未被逐条核过，而 `commands.rs` 恰是本仓
「函数都在、测试却测的是别的东西」最集中的地方。

## 逐条裁定

### commands.rs（18）

| oracle 测试 | verdict | evidence / 理由 |
|---|---|---|
| `parse_splits_on_whitespace` | covered | `ported/commands.test.ts:21` |
| `parse_keeps_quoted_args_together` | covered | `ported/commands.test.ts:29` |
| `parse_returns_none_for_non_slash` | covered | `ported/commands.test.ts:37` |
| `model_spec_accepts_colon_slash_and_two_args` | covered | `ported/model-picker-overlay.test.ts:189`（colon :189 / slash :193 / two-args :194 / None :202，oracle 四条断言全覆盖） |
| `registry_lookup_by_name_and_alias` | covered | `ported/commands.test.ts:98` |
| `attach_skill_prompt_wraps_prompt_without_skill_body` | covered | `ported/commands-e2e.test.ts:1072` |
| `skill_source_label_maps_enum_variants` | covered | `ported/cli-skills.test.ts:198`（TS 的 `skillSourceLabel` 是恒等映射，:198/:199 断言 user/project） |
| `help_topic_renders_command_usage_and_aliases` | **gap** | → `ported/command-help-text.test.ts` |
| `help_unknown_topic_gives_recovery_hint` | **gap** | → 同上 |
| `model_credential_hint_uses_only_selected_provider_credentials` | **gap** | → `ported/commands-batch-a.test.ts` |
| `model_credential_hint_accepts_env_or_auth_store_for_selected_provider` | **gap** | → 同上 |
| `registry_and_help_do_not_expose_removed_hub_surface` | **gap** | → 同上 |
| `model_catalog_includes_custom_models_without_secret_fields` | **gap** | → 同上（**移植时发现真实缺陷**，见下） |
| `unknown_model_error_lists_candidates` | **gap** | → 同上 |
| `unknown_provider_error_lists_provider_candidates` | **gap** | → 同上 |
| `render_triggers_status_summarizes_runtime_hooks_and_running` | **gap** | → 同上 |
| `trigger_decision_details_explain_dedup_and_cycle_states` | **gap** | → 同上 |
| `skill_source_parse_error_is_fixed_and_bounded` | **gap** | → 同上 |

### main.rs（13）

| oracle 测试 | verdict | evidence / 理由 |
|---|---|---|
| `ui_mode_defaults_to_web_for_local_tty` | covered | `ported/ui-mode.test.ts:24` |
| `ui_mode_defaults_to_tui_for_remote_tty` | covered | `ported/ui-mode.test.ts:28` |
| `ui_mode_keeps_headless_for_non_tty` | covered | `ported/ui-mode.test.ts:32` |
| `explicit_ui_flags_override_default` | covered | `ported/ui-mode.test.ts:37` |
| `remote_tty_env_detects_ssh_and_mosh` | covered | `ported/ui-mode.test.ts:57` |
| `resume_flag_accepts_optional_session_id` | covered | `args.test.ts:384`（裸 :384 / 带 id :390 / 不吞 flag :396 / `--resume-id` 胜出 :403） |
| `trigger_poll_interval_defaults_to_ten_minutes_and_allows_overrides` | covered | `ported/trigger-wiring.test.ts:237`（默认 600 / config 60 :243 / CLI 15 :246） |
| `auth_wrapper_injects_provider_scoped_stored_key` | **gap** | → `ported/main-batch-a.test.ts` |
| `auth_wrapper_fails_closed_without_provider_scoped_key` | **gap** | → 同上 |
| `auth_wrapper_keeps_explicit_api_key` | **gap** | → 同上 |
| `base_url_override_requires_explicit_provider` | **gap** | → `cli-state-surfaces.test.ts` |
| `cli_parses_session_export_import_commands` | not-portable | **D7**（`intentional-divergences.md:281`）：`pie session export\|import` 有意不实现，改为拒绝并指向 REPL 内 `/session export\|import`。oracle 断言的是 clap 解析出的 `SessionCliCommand::Export` 字段，本仓无该执行路径 |
| `cli_session_import_ask_imports_disabled_first` | not-portable | 同 D7。oracle 走 `run_session_cli_command`，断言 CLI 层把 `ask` 降级为 `Off` 后再交互确认；本仓该子命令按 D7 不执行。归档层拒绝 `ask` 的那半边已由 `session-archive.test.ts:151` 覆盖 |

## 移植时发现的真实缺陷（已修）

### `/model` 命令看不见自定义模型

写 `model_catalog_includes_custom_models_without_secret_fields` 的移植测试时，
`modelCatalogText("help-test-provider")` 在 `registerCustomModel` 之后仍返回
`unknown provider 'help-test-provider'`。

**根因**：oracle 的 `list_models()` 是「内置 + 自定义注册表」，`get_model()` 更是**自定义优先**
（`crates/ai/src/models.rs:23-39`）。本仓 `packages/ai` 没有可变注册表（`local-models.ts` 文件头的
`TODO(port)` 记录了这一点），自定义模型只存在 `coding-agent/local-models.ts` 的 Map 里，并由
`main.ts:1085` 的 `modelRegistry.setLocalModels(...)` 并入 `ModelRegistry`。

**但 `/model` 命令路径从不读 `ModelRegistry`**——`slash-dispatch-session.ts` 直接用
`@pie/ai` 的 `listModels()`，那只有内置目录。

**用户可见后果**：在 `~/.pie/models.json` 里声明了自定义模型后，

- `pie --provider X --model Y` 能启动（走 `ModelRegistry`）
- `/model list X` 答 `unknown provider`
- `/model X:Y` 答 `unknown model in catalog`

即**能以自定义模型启动，却无法在运行时切换到它，也看不到它**。

**修复**：`slash-dispatch-session.ts` 新增 `mergedModels()` = `[...listCustomModels(), ...listModels()]`，
`modelGroups()` 与 `/model <spec>` 的查找都改用它。自定义放**前面**是刻意的：oracle 的
`get_model` 自定义优先，而 `.find()` 取首个匹配；若沿用 `list_models` 的 builtin-first 链序，
同 key 的自定义模型会被内置遮蔽，与 oracle 相反。

**为什么三道门禁都没发现**：`modelCatalogText` / `modelGroups` / `runModelCommand` 函数名齐全、
文件齐全、签名齐全——`check:manifest`（文件层）、`check:surface-coverage`（签名层）看不见它，
`check:inline-test-ports`（行为层）也只是把这条 oracle 测试记成「未匹配」，而未匹配是上界不是缺口。
**只有真的打开 oracle 的测试体、照它写一条断言，才会撞上。**

## 门禁自身的一次修正

第一版 `check-triage-ledger.mjs` 把「名册 == 当前未匹配集」当不变量。移植 15 条 gap 后，
新测试文件的注释里写了 oracle 测试名（可追溯性要求如此），归一化扫描命中了它们，
于是门禁报「台账多出 15 条」。

照那个定义走下去，121 条全移植完 = 门禁报 121 处错误，而「121 条都裁定过」反而无法表达。

已改为三个方向各自校验（名册每行在 oracle 中存在 / 名册规模钉死 121 / 当前未匹配的都在名册内），
反方向作为**进度指标**报出而非错误。三个方向各配了负控实测。详见
`README.md` 的「名册是固定的，不随移植进度变化」一节。

## 抽查（判据 3）

**抽样规则先于结果确定**：batch=A 且 verdict=covered 的行按台账行号升序编号 1..14，
取编号 ≡ 0 (mod 3) → 3、6、9、12；不足 5 条补末条 14。
抽查数 = `max(5, ⌈14/3⌉)` = 5。

抽中 **#3 #6 #9 #12 #14**（台账第 30 / 34 / 67 / 70 / 72 行）。

| # | oracle 断言 | TS 断言 |
|---|---|---|
| 3 | `assert_eq!(args, vec!["hello world".to_string(), "again".to_string()]);` | `expect(parseSlashCommand('/say "hello world" again')).toEqual({name:"say", argv:["hello world","again"]})` |
| 6 | `assert!(r.find("quit").is_some()); assert!(r.find("q").is_some()); assert!(r.find("exit").is_some());` | `expect(findPieCommand("quit")?.name).toBe("quit")`（:99 exit→quit，:100 q→quit，:102 nope→undefined） |
| 9 | `assert!(is_remote_tty_env(\|name\| name == "SSH_CONNECTION"));` | `expect(isRemoteTtyEnv((name) => name === "SSH_CONNECTION")).toBe(true)` |
| 12 | `assert_eq!(resolve_ui_mode(false, false, true, true), UiMode::Tui);` | `expect(resolveUiMode(false, false, true, true)).toBe("tui")` |
| 14 | `assert_eq!(resolve_ui_mode(false, false, false, false), UiMode::Headless);` | `expect(resolveUiMode(false, false, false, false)).toBe("headless")` |

**抽查抓到了一处我自己的错**：#12 与 #14 原本指向 `it(...)` 行而非断言行，违反 README 里
「evidence 指向那条断言所在的行」的规定。复核发现四条 ui-mode evidence 全部差一行
（23/27/31/36 → 24/28/32/37），已改正。

这正是抽查存在的理由——机器只能验证「那一行存在」，验证不了「那一行是不是断言行」。

## 负控（每条 gap 都配，变异脚本带 assert）

| 变异目标 | 变异内容 | 结果 |
|---|---|---|
| `slash-dispatch.ts` × 3 处 | 打掉 alias 行 / more-footer / unknown-topic 措辞 | `command-help-text.test.ts` 4 条中 3 条红（第 4 条不依赖被变异的行，正确保持绿） |
| `slash-dispatch-session.ts` | `mergedModels()` 退回「只有内置」 | 自定义模型目录那条当场红，其余 8 条绿 |
| `auth-storage.ts` | `getApiKey` 退化为「本 provider 没有就拿第一个」 | `fails closed` 那条红，其余 2 条绿 |
| `triage-ledger.tsv` × 2 | 改成 oracle 中不存在的 test_name / 删一行 | 门禁分别报「在 oracle 中不存在」「名册规模是 120」 |

每个变异脚本都先 `assert` 目标串出现次数符合预期、变异后标记确实在文件里，还原后再 `assert`
标记已消失——上一轮出过「变异命中了第一处同形代码、负控假通过」，这个 assert 是那次的产物。

## 命令与结果

```
node scripts/check-triage-ledger.mjs   OK — 批次 A 剩余 TODO 0（covered 14 · not-portable 2 · gap 15）
npm run check                          exit 0（9 道门禁）
bash test.sh                           exit 0 — 4290 passed / 0 failed
                                       （agent 450 · ai 484 · coding-agent 2681 · mcp 46 · tui 612 · workers 17）
                                       基线 4273 → +17，只增不减
bash migration/parity/run-parity.sh --scenarios S1
                                       exit 0 — S1 DIFF 0（--help 未漂移）
```
