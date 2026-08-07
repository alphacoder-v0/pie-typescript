# 批 G —— coding-agent 包 52 条

## 裁定分布

| 裁定 | 条数 |
|---|---|
| `existing-test` | **27** |
| `new-test` | 0 |
| `not-portable` | **25** |
| 合计 | **52** |

`not-portable` 占比 **48.1%**，低于 60% 闸门。

**本批零新写测试**——coding-agent 的测试语料成熟（`lsp.test.ts` · `lsp-supervisor.test.ts` ·
`relay.test.ts` · `tools-index.test.ts` · 各 `*-tool.test.ts`），27 条能直接指向具体断言。

## ⚠ 本批最重要的产出不是裁定，是一次规则上移

第一版裁定表是**手写**的，52 条里 **14 条键错**。而且这次错的不只是行号——**文件路径也是我发明的**：

| 我写的 | 名册里的真值 |
|---|---|
| `hooks.rs::is_empty@106` | `lsp_supervisor.rs::is_empty@106` |
| `hooks.rs::load@78` | `lsp_supervisor.rs::load@78` |
| `hooks.rs::agent_listener@21` | `ui/listener.rs::agent_listener@21` |
| `lsp.rs::from_config@52` | `lsp_supervisor.rs::from_config@52` |
| `lsp_supervisor.rs::listener@102` | `tui.rs::listener@102` |
| `ui/mod.rs::error_line@93` | `tui.rs::error_line@93` |
| `ui/mod.rs::user_message@1262` | `main.rs::user_message@1262` |
| `extensions/mod.rs::banner@47` | `tui.rs::banner@47` |
| `mcp_loader.rs::load_all@16` | `templates.rs::load_all@16` |
| `ui/relay.rs::new@49` | **批 G 里根本没有这一条** |

成因：定位工具的输出为了可读做了截断（只显示 `::` 之后的部分），我据此回填完整键时
把文件路径和行号一起猜了。**猜出来的键与真实键长得一样，肉眼分不出。**

### 「自动按名册校正」这个补救让事情更糟

我先试了「同一 `(file, fn)` 只有一个行号时自动改」。它把 `error_line@93` 改成了
`error_line@288`——而后者**已经在表里**，Python dict 的重复键**静默覆盖**，
错误从「报错」变成「悄悄少几条」。

### 规则上移（同类失败第三次）

| phase | 错的条数 | 错在哪 |
|---|---|---|
| 4（批 U 40 条）| 7 | oracle 行号写错 |
| 5（批 F 58 条）| 1 | 键的文件名写错 |
| 6（批 G 52 条）| **14** | **文件路径 + 行号都发明了** |

**停修实例，改规则**：裁定表的键**必须从名册生成**，不手写：

```bash
awk -F'\t' '$6=="<BATCH>"{printf "%s::%s@%s\n",$1,$2,$3}' roster.tsv | sort
```

重做后**一次通过**（`批 G：新增 52 条，名册 52 条全覆盖`）。
已存记忆 `adjudication-keys-must-be-generated-from-roster`。

写入脚本的三道 assert（键在名册中 / evidence 是断言行 / 该批全覆盖）是**最后一道**防线，
不是第一道——第一道是不让错的键产生。

## `not-portable` 25 条的形态

| 形态 | 条数 | 例 |
|---|---|---|
| **需真实终端** | 3 | `ui/mod.rs` 的 `banner` / `system_line` / `error_line` —— TS 侧在 `ui/index.ts:434/450/455` 确实存在（注释标着 `pie: mod.rs:248-282`），但只在渲染循环里调用，全仓 test 零引用，由 **parity S2** 逐字节守 |
| **oracle 双份，本仓合一** | 7 | `tui.rs` 与 `ui/mod.rs` 各有一套 `banner`/`system_line`/`error_line`；`hooks.rs` 有 `listener` 与 `harness_listener` 两个订阅入口 |
| **工厂层不存在** | 4 | 四个 cron/trigger 工具工厂 —— 本仓由 `triggers/tool-definitions.ts` 直接产 ToolDefinition |
| **构造器合并/工厂化** | 5 | `otlp::new` · `memory::new` · `task::new` · `tui::new` · `lsp_supervisor::from_config` |
| **builder → options** | 1 | `web_search::with_base_url` |
| **监听器工厂不存在** | 5 | `ui/listener.rs` 的两个 + `tui.rs` 的两个 + `main.rs::user_message` |

判据 3 的机器验证：**25/25 条理由含 `packages/` 路径或 TS 标识符**。

## 抽查（规则先于结果声明）

**规则**：27 条非 not-portable 等距抽 `max(5, ⌈27/5⌉)` = **6** 条（实取 7），
步长 4，从 index 0 起。抽中 #0 · #4 · #8 · #12 · #16 · #20 · #24。

**7/7 通过三问。** 其中两条抽中时发现**同一测试块内有更强的断言**，已上调：

| 抽中 | 原证据 | 上调为 |
|---|---|---|
| `wrap_stream_fn` | `debug.test.ts:384` `expect(updates.length).toBeGreaterThan(0)` | `:385` `expect(updates.every((u) => u.kind === "plain" && u.level === "system"))` —— 断言的是**内容**不只是**数量** |
| `skills::load_all` | `skills.test.ts:26` `expect(diagnostics).toEqual([])` | `:27` `expect(skills).toEqual([...])` —— 断言加载出的技能本身，不只是「没有诊断」 |

这符合校准文档的规则：**锚点/证据要换只能在同一测试块内换**，不能换到另一个块。

## 命令与结果

```
node scripts/probe-ts-counterpart.mjs --batch G   52 条 → no-file 1 · substantial+named 16 · substantial 35
node scripts/check-behavior-evidence.mjs          批 G 52/52；累计 477/513
npm run check                                     exit 0（11 门禁）
bash test.sh                                      exit 0 — 4410 passed / 0 failed
密闭性                                            ~/.pie/sessions 3316 → 3316，增量 0
```
