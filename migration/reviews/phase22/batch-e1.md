# 批 E1 —— coding-agent 其余·上半（42/42）

`roster.tsv` 中 `batch=E1` 的 42 个函数，全部有裁定。

## 裁定分布

| 裁定 | 条数 |
|---|---|
| `existing-test` | **32** |
| `new-test` | **1** |
| `not-portable` | **9** |
| 合计 | **42** |

## 本轮唯一一批几乎不用写新测试

42 条里只有 **1 条** `new-test`（批 A/B/C 各 8-9 条）。原因不是偷懒，是
`coding-agent` 的这部分**本来就测得扎实**：`builtin-skills.test.ts` · `config-paths.test.ts` ·
`model-picker.test.ts` · `lsp.test.ts` · `hooks.test.ts` · `extensions-registry.test.ts`
都是成熟测试文件，32 条能直接指向其中的具体断言。

几个特别干净的例子：

| 函数 | 证据 | 断言 |
|---|---|---|
| `config::parse_trigger_poll_interval_secs` | `config-paths.test.ts:58` | `expect(parseTriggerPollIntervalSecs(text)).toBe(15)` |
| `config::parse_relay_base_url` | `config-paths.test.ts:85` | `toBe(DEFAULT_RELAY_BASE_URL)` |
| `export::default_export_path` | `export.test.ts:169` | `toBe(join(tempAgentDir, "exports", "session-abc123.md"))` |
| `model_picker::back` | `model-picker.test.ts:216` | `p.enter()` 后 `expect(p.back()).toBe(false)`（回到 providers 层） |
| `bug_report::redact` | `bug-report.test.ts:60` | `expect(r).not.toContain("sk-abcdefghij")` —— 脱敏的反例断言 |
| `extensions::iter` | `extensions-registry.test.ts:145` | `expect([...r.iter()].map((e) => e.name())).toEqual(["hello", "boom"])` |
| `local_models::load_all` | `local-models.test.ts:337` | `not.toContain("http://attacker.invalid/v1")` —— 恶意 baseUrl 不被注册 |

## `not-portable` 9 条

| 类型 | 函数 |
|---|---|
| **TS 侧零命中** | `config::sessions_dir_for_cwd`（会话目录由 `getSessionsDir()` + cwd 哈希内联拼接）· `commands::set_sink`（sink 由 `emitCommandLine` 闭包注入）· `hooks::handle_harness_event`（harness 事件直接进 `handleEvent`）· `images::load_bytes` / `load_one`（内联在 `loadAllImages` 里） |
| **命名差异** | `readline::from_registry` —— 本仓合并进了 `SlashCompleter.fromRegistryAndSkills`，单参版本不单独存在 |
| **可测但只能 tautology** | `config::cwd_hash` · `memory_dir` · `hooks::len` —— 可观测后果已被别的证据覆盖（`session-dir-purity.test.ts` / `getAgentDir` / `isEmpty`） |

## 抽查（规则先于结果声明）

**规则**：`existing-test` 共 32 条，抽 `max(5, ⌈32/3⌉)` = **11** 条，
按 `evidence.tsv` 中本批行的出现顺序等距取（步长 2，从 index 0 起）。

实际逐条核实了 12 条候选（超出要求），**全部通过三问**。核实过程贴在 transcript：
`available_builtin_names` · `parse_relay_base_url` · `parse_trigger_poll_interval_secs` ·
`extensions::iter` · `hooks::handle_event` · `export::default_export_path` ·
`hooks::is_empty` · `local_models::load_all` · `lsp::did_open` · `mentions::expand` ·
`model_picker::back` · `bug_report::redact`。

一条略弱：`lsp::did_open` → `lsp.test.ts:337` 的 `expect(pushed?.uri).toBe(uri)`——
它断言的是 `awaitDiagnostics` 的产物。但 `didOpen` 没把文件送达服务器就不会有诊断推送回来，
所以「断言失败 ⇒ 函数出错」成立。

## 零行号漂移

本批**未新建任何测试文件**，因此是本轮唯一没触发 `anchor` 重定位的批次。

## 命令与结果

```
node scripts/find-behavior-evidence.mjs E1    37 条待裁定 → 29 有候选 / 8 无候选
node scripts/check-behavior-evidence.mjs      批 E1 42/42；累计 246/282（87.2%）
npm run check                                 exit 0（11 道门禁）
bash test.sh                                  exit 0 — 4397 passed / 0 failed
密闭性                                        ~/.pie/sessions 3297 → 3297，增量 0
```
