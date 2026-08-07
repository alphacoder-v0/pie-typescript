# Phase 14 收口记录

## 交付

4 个 manifest 单元全部 done（markdown / readline / spinner / tui），全局 193/205。
**phase 13 结转的 62 个 `it.skip` 全部清零**：41 个 commands dispatch + 19 个 tui_render + 2 个 spinner。
coding-agent 的 skip 从 107 降至 45；总测试 3711 通过 / 0 失败。parity S1 仍逐字节全绿。

## 各单元的关键判断

### tui.ts（行流渲染器，723 行新模块）
- **复刻 crossterm 的 256 色形式**（`\x1b[38;5;8m` 而非 `\x1b[90m`），依据 crossterm 0.28.1 `colored.rs:109-147`、`style.rs:208-211`。后果是 oracle 的**重放灰 ≠ 流式灰**——这个不对称有意保留。
- **保留 Rust 求值顺序**：quiet-dynamic-trace 的 `remove()` 在 `&&` 短路**之前**执行，故 trace id 无论走哪个分支都被消费。挪到短路之后行为就变了。
- **区分三种字符串长度**：`truncateChars` 按码点、`rustLines` 复刻 `str::lines()`（空串产生零行）、`trimStartAsciiWhitespace` 只认 ASCII 空白（不含 `\x0b`、不含 Unicode 空格）。

### commands dispatch（5 模块 2592 行）
- **`CommandSkill` 故意不带 `content` 字段**：把"任何 `/skill*` 路径都不得回显 SKILL.md 正文"这条不变量做成**类型上不可表达**，而非靠断言查。原断言在正文真的落盘的 install/remove 用例中仍全力生效。
- **`registryWithBuiltins()` 在数据半边有行找不到 handler 时抛错**——两个半边不可能各自演化。
- **一处有意的位置偏移**（已就地注明）：oracle 的 install/remove 工具自持 `SkillHarnessCell` 写后自行热重载，故 `commands.rs` 调用点不重载；本移植的工具无 harness 句柄，同样的用户可见效果**晚一帧**在 dispatcher 里产生。预览结果不重载，与 oracle 一致。

### spinner（8 项验收全交付，三处**超出** oracle 测试强度）
oracle 只断言 `contains` → 本移植逐帧断言精确等于 `FRAMES[i % 10] + " thinking"`；oracle 只测 clone 一侧 → 两个方向都测；oracle 不测 TTY 门 → 驱动 `isTTY` 两个分支并断言真实 `process.stderr.write` 调用序列。
**bug-for-bug 的要求是不弱化 oracle 断言，不是不许更强。**

### readline（**没有被文件名误导**）
`readline.rs:1-6` 自陈该模块已退化为纯斜杠命令前缀匹配器（TUI 自管输入部件）——无原始模式、无按键处理、**无历史**。因此 `history.ts` 未被触碰也未被 import。按文件名猜会写出大量无用代码。

### markdown（识别出"无可 diff 的面"，改为并列移植）
oracle 是逐行、无状态的手写字节扫描器；base 是基于 `marked` 的整文档组件树。零公共 API、零行为重叠。保持 base 字节不变（222 插入 / **0 删除**）——按 diff-port 硬做会删掉 TUI 真正在用的块级渲染器。

## 第 4 处 manifest 队列错误（与 spinner 同类危险）

`coding-agent/tui` 登记为 diff-port → `interactive-mode.ts`。但那个文件**没有行流路径**：本次工作前全仓 grep `renderEvent`/`renderHarnessEvent`/`renderPersisted`/`[thinking]`/`⚙` 零命中（编排者以 `git show HEAD` 复核）。
危害：out_path 指向的文件**存在但与本单元无关**，「out_path 存在 = 完成」会据无关文件误判完成。已改判 port + out_path `src/tui.ts`。

**四处队列错误的共同根因**：manifest 的 base/out 映射是 phase 2 按**文件名相似度**做的语义映射，**从未经过行为核对**。凡"base 与 oracle 公开面重合度未被验证"的行都应视为待核实。已记入 RULEBOOK §6。

## 一次被推翻的下级判断

commands-dispatch 单元报告 REPL 接线"无人认领"——因为我把 `coding-agent/tui` 行改判走了。听起来像我的重分类制造了孤儿。
**核实后不成立**：REPL 事件循环就是 oracle 的 `ui/mod.rs`，早已由 `coding-agent/ui/mod` 行认领（phase 15），且 ROADMAP phase 15 范围原文是「coding-agent ui/ 全模块 port」。它不知道 phase 15 的范围。它写进 manifest 的"需新开一行认领"已改正——留着会误导后续。

## flake 处置（与 phase 12 oauth 同一原则）

`promoted_dynamic_trigger_result_enters_parent_chat_context` 只在全工作区 CPU 竞争下失败。
**先查根因**：oracle 的 `wait_for_completed` 也是 5 秒上限（`dynamic_trigger_e2e.rs:455`），移植忠实。差异纯粹是 **Node 在 vitest worker 竞争下慢于 tokio**。
**处置**：上限是**夹具常量**而非行为契约（其职责是"等到工作完成"），放宽至 15 秒、4 处调用点断言一条未动、理由写进代码。
**不采用**"重跑就好"：放任 flake 会训练所有人跳过失败而不是读失败。

## 结转

- **phase 15**：`ui/` 全模块 port（含 REPL 接线——把 `interactive-mode.ts` 的 pi 式 if-链换成本 phase 交付的 `dispatch`，自动补全改用 `PIE_BUILTIN_COMMANDS`）
- **phase 17**：B17 需补特征测试（重放双括号 vs 实时单括号）；空白字符类统一到 Unicode `White_Space`（`slash-commands.ts:288-291` 的裸 `\s` 待改，`readline.ts` 已正确）
- **phase 19**：`sleepUnref` 去重（`otlp.ts` 与 `spinner.ts` 各一份）；`markdown.ts` 新渲染器是否需从 `packages/tui/src/index.ts` 导出
