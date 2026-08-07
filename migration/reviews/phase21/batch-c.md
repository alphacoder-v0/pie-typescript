# 批次 C — 模型与技能配置（32 条）

`skills_state.rs` 11 · `local_models.rs` 10 · `model_picker.rs` 8 · `builtin_skills.rs` 2 · `model.rs` 1。

**分布：covered 19 · not-portable 0 · gap 13。**

零 not-portable —— 这批全是纯逻辑与配置面，没有一条依赖 Rust 特有构造。

## 两处 spec 点名的特别注意

### 1. 两条 fixture 流式测试 —— 都是 gap

```
loaded_openai_responses_model_streams_text_from_local_fixture
loaded_openai_responses_model_streams_tool_call_from_local_fixture
```

oracle 这两条**起一个本地 HTTP 服务器、真的发请求、真的消费流**，断言拼回来的
文本是 `"OK"` / 工具调用是 `probe`。

本仓此前的覆盖分成两半，合起来仍漏掉 oracle 守的东西：

| 既有测试 | 它证明了什么 | 它没证明什么 |
|---|---|---|
| `local-models.test.ts` | 描述符字段、注册与否、覆盖优先级 | 零 HTTP，完全没碰适配器 |
| `models-json-harm.test.ts` | 请求**打到了**那个地址、带着凭据（`captured[0].authorization`） | `complete(...).catch(() => undefined)` 把流解析失败整个吞掉了——**没证明响应能被解析回来** |

所以 `api: "openai-responses"` 这个字段**是否真的选中了一个能用的适配器**，此前零证据。

**驱动证据**（判据 2 要求）：移植后的 `ported/local-models-stream-batch-c.test.ts` 里，

- 起服务器：`server.listen(0, "127.0.0.1")` + `await once(server, "listening")`（`loadModelServedBy`）
- 断言流内容：`expect(text).toBe("OK")` / `expect(names).toContain("probe")`

这两个值**只能来自 SSE 解析**——fixture body 里的 `"OK"` 与 `"probe"` 没有第二个来源。
第三条另外断言 `expect(captured.length).toBeGreaterThan(0)`，证明服务器确实被打到过。

### 2. 两条方向相反的失败模式 —— 分别核实，方向都对

```
local_models.rs   :: malformed_config_fails_closed_without_registering
                     → 配置坏了就【不注册任何东西】（fail-closed）
builtin_skills.rs :: parse_config_malformed_toml_degrades_to_empty_not_panic
                     → 配置坏了就【降级为空但不 panic】（degrade-to-empty）
```

| | TS 侧行为 | evidence | 方向 |
|---|---|---|---|
| `local_models` | `expect(() => loadAllFromPaths([bad], {})).toThrow(/parse/)` | `local-models.test.ts:217` | **fail-closed** ✓ |
| `builtin_skills` | `expect(() => parseBuiltinSkillsConfig("this is not valid toml [ [ [")).not.toThrow(...)` | `builtin-skills.test.ts:172` | **degrade-to-empty** ✓ |

两者方向与 oracle 一致，没有混为一谈。这一点值得单独核：如果 `local_models` 也做成了
degrade-to-empty，一个坏掉的 models.json 会静默注册出半个模型——而 models.json 的信任边界
（D3）恰恰依赖 fail-closed。

## 逐条裁定

### skills_state.rs（11）—— 1 covered / 10 gap

`skills-state.ts` 的**纯函数层此前零直接覆盖**：`setSkillState` / `removeSkillState` /
`applySkillsStateOverlay` / `loadSkillsState` / `saveSkillsState` 在全仓测试里没有一处直接调用，
只被 `set-skill-state-tool.test.ts` 等工具层测试间接走到——那些断言的是工具的 schema 形状、
权限分类与错误提示，不是覆盖层的语义。

| oracle 测试 | verdict |
|---|---|
| `set_and_save_persists` | covered `set-skill-state-tool.test.ts:82` |
| 其余 10 条（`apply_*` 4 · `set_upserts_not_duplicates` · `remove_drops_*` · `missing_file_*` · `malformed_file_*` · `save_then_load_round_trips` · `remove_and_save_clears_entry_on_disk`） | **gap** → `ported/skills-state-batch-c.test.ts` |

**`apply_is_source_aware` 与 remove 的 source-aware 半边最值得补**：同名不同来源的技能各有一条
覆盖记录，一旦 source 维度塌掉，「禁用用户的 foo」会连带禁用项目的 foo——用户看到的是一个
自己没关过的技能不见了，而且 `skills-state.json` 里查不到原因。

### local_models.rs（10）—— 7 covered / 3 gap

| oracle 测试 | verdict | evidence |
|---|---|---|
| `registers_ds4_model_from_explicit_env_url_and_allows_user_override` | covered | `local-models.test.ts:149` |
| `ds4_url_env_alias_registers_model` | covered | `:166` |
| `cli_base_url_registers_ds4_model_and_overrides_env_url` | covered | `:172` |
| `ds4_env_without_url_reports_base_url_config` | covered | `:177` |
| `loads_and_registers_custom_model` | covered | `:188` |
| `project_model_overrides_user_model_with_same_provider_and_id` | covered | `:208` |
| `malformed_config_fails_closed_without_registering` | covered | `:217` |
| `loaded_openai_responses_model_streams_text_from_local_fixture` | **gap** | → `ported/local-models-stream-batch-c.test.ts` |
| `loaded_openai_responses_model_streams_tool_call_from_local_fixture` | **gap** | → 同上 |
| `ds4_responses_model_uses_ds4_env_not_openai_env` | **gap** | → 同上 |

第三条 gap 也是 fixture 服务器测试：断言线上的 `Authorization` 用的是本 provider 的密钥，
另一个 provider 的值一个字节都不许出现。这是批次 B env-decoy 测试的**线上半边**——
那边证明查询不会取到诱饵，这边证明真发出去的字节里也没有诱饵。

### model_picker.rs（8）—— 全部 covered

`model-picker.test.ts` 逐条对应：`:73` `:97` `:126` `:205` `:216` `:226` `:237` `:274`。

### builtin_skills.rs（2）· model.rs（1）—— 全部 covered

`builtin-skills.test.ts:127` / `:172`；`local-models-registry-wiring.test.ts:99`。

## 抽查（判据 4）

**抽样规则先于结果确定**：batch=C 且 verdict=covered 的行按台账行号升序编号 1..19，
取编号 ≡ 0 (mod 3) → 3、6、9、12、15、18；不足 7 条补末条 19。
抽查数 = `max(5, ⌈19/3⌉)` = 7。

抽中 **#3 #6 #9 #12 #15 #18 #19**。

**抽查第三次抓到同一类错误**：#3 #6 #9 #18 指向的是 setup 行（`const path = write(`、
`loadAllFromPaths([], {...})`）而非断言行。批次 A 抓到过「指向 `it(...)` 行」，
批次 B 抓到过「同一行被两条 oracle 测试引用」。

**三次同类失败 → 按「复发失败上移」改规则，不改实例**：
`check-triage-ledger.mjs` 新增一条校验——`covered` 的 evidence 那一行必须含 `expect(` 或 `assert`。
新规则上线后立刻在**批次 A** 里又揪出一条我漏掉的（`trigger-wiring.test.ts:237` 是注释行
`// No config.toml at all -> built-in default.`，已改为 :238）。

全台账扫描后共修正 11 条 evidence（C 批 10 + A 批 1）。新规则配了负控：
把 `picker_view_windows_around_cursor` 的 evidence 改成 `model-picker.test.ts:257`
（`test("view windows around the cursor", () => {` 行）→ 门禁当场红；还原 → 绿。

这条规则**守不住**「那一行断言的是别的东西」——那仍然是抽查的活。机器守形式，人守实质。

抽查的 7 组 oracle↔TS 并排原文（修正后）：

| # | oracle 断言 | TS 断言 |
|---|---|---|
| 3 | `assert_eq!(get_model("ds4","deepseek-v4-flash").base_url, cli_url)` | `expect(getCustomModel("ds4","deepseek-v4-flash")?.baseUrl).toBe("http://127.0.0.1:9999/v1")` |
| 6 | `assert_eq!(loaded.models.len(), 1)` | `expect(loaded.models).toHaveLength(1)` |
| 9 | `assert!(get_model(&Provider::from("ds4"), "deepseek-v4-flash").is_some())` | `expect(registered).toBeDefined()` |
| 12 | `assert!(!p.back())` | `expect(p.back()).toBe(false)` |
| 15 | `assert!(p.enter().is_none())` | `expect(p.enter()).toBeUndefined()` |
| 18 | `assert_eq!(model.provider.0, "ds4")` | `expect(model.provider).toBe("ds4")` |
| 19 | `assert_eq!(state.overrides.len(), 1)` | `expect(state.overrides).toEqual([{ name: "foo", source: "user", enabled: false }])` |

全局去重复核：49 条 covered → 49 个各异 evidence 行，无重复。

## 负控（变异脚本带 assert）

| 变异目标 | 变异内容 | 结果 |
|---|---|---|
| `local-models.ts` | `api: raw.api` → 一律 `"openai-completions"`（忽略 models.json 的 api 字段） | 两条流式测试红（`Stream ended without finish_reason` = responses SSE 被 completions 适配器解析），第三条只断言线上凭据，正确保持绿 |
| 测试夹具（第三条专用） | 把诱饵值当密钥发出去 | 第三条红——证明那条否定断言**观测得到**，不是因为装置根本看不见任何东西 |
| `check-triage-ledger.mjs` 新规则 | evidence 改指 `test(...)` 行 | 门禁红并指名该行；还原 → 绿 |

`skills-state-batch-c.test.ts` 的 10 条是纯函数测试，其正确性由 oracle 断言的逐条对照保证
（每个 `it` 上方都贴了 oracle 原文）；它们与 `local-models` 的变异互不相干，因此共用
上面那次 `api` 变异作为「本文件不受该变异影响」的对照——10 条全程保持绿。

## 命令与结果

```
node scripts/check-triage-ledger.mjs   OK — 批次 C 剩余 TODO 0（covered 19 · not-portable 0 · gap 13）
npm run check                          exit 0（9 道门禁，含新增的断言行校验）
bash test.sh                           exit 0 — 4305 passed / 0 failed
                                       （agent 450 · ai 484 · coding-agent 2696 · mcp 46 · tui 612 · workers 17）
                                       批次 B 后 4292 → +13
```
