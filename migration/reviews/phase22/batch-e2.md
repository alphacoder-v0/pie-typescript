# 批 E2 —— coding-agent 其余·下半（41/41）

`roster.tsv` 中 `batch=E2` 的 41 个函数，全部有裁定。**本批完成后名册满 282/282。**

## 裁定分布

| 裁定 | 条数 |
|---|---|
| `existing-test` | **27** |
| `new-test` | **2** |
| `not-portable` | **12** |
| 合计 | **41** |

与 E1 同源（`batch=E` 的 83 条按名册顺序对半拆），特征也一致：`coding-agent` 这部分
本来就有成熟测试（`spinner.test.ts` · `ui/feed.test.ts` · `skills-state-batch-c.test.ts` ·
各 `*-tool.test.ts`），27 条能直接指向具体断言。

几个例子：

| 函数 | 证据 | 断言 |
|---|---|---|
| `spinner::start` | `spinner.test.ts:181` | `expect(writes, "a non-TTY stderr must never be written to").toEqual([])` |
| `spinner::snapshot` | `spinner.test.ts:48` | 断言帧 0 在**同步渲染**里就已存在（`No await between startWith() and the snapshot`） |
| `ui/feed::push_user` | `ui/feed.test.ts:110` | `expect(rendered).toContain("you ▸ do the thing")` |
| `ui/feed::clear` | `ui/feed.test.ts:317` | `expect(feed.lines(80)).toEqual([])` |
| `readline::matches` | `readline.test.ts:35` | 裸斜杠列出命令与别名 |
| `skills_state::apply` | `skills-state-batch-c.test.ts:52` | `expect(out[0]?.disableModelInvocation).toBe(true)` |

## `not-portable` 12 条

| 类型 | 函数 |
|---|---|
| **工厂层不存在** | `tools/mod.rs` 的四个 cron/trigger 工具工厂（`remove_cron_job_tool` · `remove_trigger_tool` · `set_cron_job_state_tool` · `set_trigger_state_tool`）—— 本仓由 `triggers/` 下的模块直接注册进工具表 |
| **builder 风格 vs options 参数** | `install_skill::with_skills_root` · `skill_builder::with_skills_root` —— 本仓统一用 options 传 skills root |
| **TS 侧零命中** | `resume_picker::pick_blocking`（本仓无阻塞式选择器）· `ui/web::run_web`（oracle web UI 未移植）· `tools/mcp_adapter::new`（MCP 工具由 `mcp-loader.ts` 直接构造 ToolDefinition） |
| **拆成两步** | `skills_state::remove_and_save` —— 本仓是 `removeSkillState` + `saveSkillsState` 两个函数 |
| **需真实终端** | `ui/mod::new` · `ui/mod::run` |

### `ui/mod::new` / `run` 不是「没被验证」

它们是 TUI 主循环，密闭单测覆盖不到——但 **parity 场景 S2 把 oracle 与 TS 的 TUI 输出
逐字节比对**，那比任何单测都强。只是那个证据不落在 `evidence.tsv` 的 `<path>:<line>` 形态里，
所以记 `not-portable` 并在理由里指明由 S2 守。

## 抽查（规则先于结果声明）

**规则**：`existing-test` 共 27 条，抽 `max(5, ⌈27/3⌉)` = **9** 条，
按 `evidence.tsv` 中本批行的出现顺序等距取（步长 3，从 index 0 起）。

实际逐条核实了 13 条候选（超出要求），**抓出 2 处假阳性**：

### ⚠ 一处假阳性暴露了门禁规则的盲区

`skills_state::apply` 的候选指向 `skills-state-batch-c.test.ts:49` —— 那是一行**注释**：

```
//   assert!(skills[0].disable_model_invocation, "overlay disable applies");
```

这是移植测试里**抄录的 oracle 断言原文**。门禁的规则「evidence 那一行必须含 `expect(` 或
`assert`」对它**无效**——因为 `\bassert\b` 匹配到了 Rust 的 `assert!` 宏。

真证据在 `:52` 的 `expect(out[0]?.disableModelInvocation).toBe(true)`，已改指。

**这是那条规则的一个已知盲区，记在这里而不是悄悄绕过。** 加固方式（留给下一轮）：
把判据从「含 `assert`」收紧为「含 `assert.` 或 `assert(`」，排除 Rust 的 `assert!`；
或者要求该行不以 `//` 开头。

另一处：`hooks::len` 的候选指向 `agent-harness.test.ts:890`，与 hooks 完全无关。

## 命令与结果

```
node scripts/find-behavior-evidence.mjs E2    36 条待裁定 → 24 有候选 / 12 无候选
node scripts/check-behavior-evidence.mjs      批 E2 41/41
                                              **累计 282/282 —— 名册全部裁定完毕**
                                              existing-test 184 · new-test 37 · not-portable 61
                                              批 A 52/52 · B 45/45 · C 49/49 · D 53/53 · E1 42/42 · E2 41/41
npm run check                                 exit 0（11 道门禁）
bash test.sh                                  exit 0 — 4397 passed / 0 failed
密闭性                                        ~/.pie/sessions 3297 → 3297，增量 0
```
