# Phase 14 · 待在 phase 边界应用的修订

> RULEBOOK standing rule 1：法典在 loop 内只读，修订排队、在 phase 边界应用并记入 §6 Deviation log。

## 排队中的 RULEBOOK 修订

### A1 — 提议新增 §5 B15、B16（markdown.rs 的两个缺陷）

**来源**：phase 14 markdown 单元的 implementer 主动上报，**未自分配 id**——B13/B14 确立的姿态（实施者提议、编排者裁决）。两条均已 bug-for-bug 复刻并有测试锁定。

**B15 候选 — `markdown.rs:77` 的 Latin-1 乱码**
`bytes[i] as char` 是 Rust 里唯一的整数→char 转换，语义是 Latin-1 加宽。因此行内 span **之外**的每个非 ASCII 字节都变成自己的 U+0080..U+00FF 标量：`"héllo"` 渲染成 `"hÃ©llo"`，`"中"` 变成 `"ä¸­"`。span **之内**的文本逃过此劫，因为那里 oracle 复制的是 `&str` 切片。
TS 侧用 `String.fromCharCode(bytes[i])` 复刻，产出相同码点因而线上 UTF-8 相同；测试锁定了 in-span 与 out-of-span 两半。

**B16 候选 — `markdown.rs:22-23` 标题吞掉分隔空格**
`"## Section"` 渲染后 `##` 与 `Section` 之间的空格消失，且标题正文**从不经过 `render_inline`**，所以 `"## a **b**"` 保留字面量 `**b**`。已复刻。

**编排者倾向（待 phase 边界确认）**：**两条都采纳**。理由同 B14：§5 的定义是「必须复刻的缺陷」而它们已被复刻；不给 id 则 phase 19 的标记对账会漏掉。两条在 oracle 中**均不可达**（`markdown.rs:9` 带 `#![allow(dead_code)]`，除 `main.rs:29` 的 `mod markdown;` 外全 crate 零调用方），故不影响 parity、phase 18 优先级低——与 B14 同姿态。
**应用时需一并做**：在复刻站点补 `BUG(port): B15` / `B16` 标记。

## 记录（不改 manifest，但需留痕）

### 第三处 manifest 分类偏差：`coding-agent/markdown` 标为 diff-port，实际零重叠

| | oracle `markdown.rs` | pi base `markdown.ts` |
|---|---|---|
| 工作单位 | 单个逻辑行，对输入无状态（`render_line`） | 整文档 |
| 解析器 | 手写字节扫描，~110 行 | `marked` lexer + 块/行内 token 树 |
| 覆盖面 | 行内粗体/斜体/代码、ATX 标题、围栏 | + 列表、表格、引用、hr、链接/OSC 8、任务项、换行、padding、主题 |
| 样式 | 6 个硬编码 SGR 字面量 | 可注入 `MarkdownTheme` |
| API | `render_line(&str)`、`Renderer{in_fence}` | `class Markdown implements Component` |

**未改 classification**：与 `coding-agent/spinner` 那次不同，本次错误分类**没有造成工作被跳过**——implementer 识别出无可 diff 的面，改为在同一 out_path 内**并列移植**，pi 组件保持字节不变（222 插入 / 0 删除）。按 diff-port 硬做反而会删掉 TUI 真正在用的块级渲染器。
留此记录是为了让 phase 19 的对账知道：该行的 `diff-port` 标签名不副实，实际交付形态是 port-alongside。

### 两侧皆不可达
oracle 的 `markdown.rs` 是死模块；TS 侧的新渲染器也未从 `packages/tui/src/index.ts` 导出（implementer 的边界之外）。**待编排者决定**是否需要导出——若 phase 14 的 `tui.ts` 行流渲染层要用它，则需要。

### A2 — 提议新增 §5 B17（transcript 重放的双层括号）

**来源**：phase 14 tui 渲染层 implementer 主动上报，**未自分配 id**。

**事实**：oracle `tui.rs:493-497` 用 `"⚙ {}({})"` 包裹 `preview(...)` 的返回值，而 `preview` 自己（`tui.rs:432`）**已经带括号**。
后果：`--resume` 的 transcript 重放渲染成 `⚙ read((path="/tmp/x.rs"))`（双层括号），而实时的 `ToolExecutionStart` 行（`tui.rs:190`）渲染成 `⚙ read(path="/tmp/x.rs")`（单层）——**同一个工具调用在重放与实时两条路径上显示不同**。

**当前状态**：已 bug-for-bug 复刻并就地标注于 `packages/coding-agent/src/tui.ts:650`；**19 个 tui_render 测试不覆盖它**（那 19 个属 B/C/D 组，本条在 E 组的 `renderPersisted`）。

**编排者倾向**：**采纳为 B17**，并要求补一个特征测试锁定"重放双括号 vs 实时单括号"这一对比。该缺陷 judge 可观测（`--resume` 后的首屏输出），与 B14/B15/B16 的"两侧皆不可达"不同——**这条是活的**。

## 已应用的 manifest 更正（第四处，与 spinner 同类危险）

`coding-agent/tui`：diff-port → **port**，out_path 由 `modes/interactive/interactive-mode.ts` 改为 `src/tui.ts`，base 置空。
理由：oracle `tui.rs` 是行流式渲染器（可注入 sink + 跨调用 RenderState），base 是 pi 的组件树 TUI，**无行流路径**——本次工作前全仓 grep `renderEvent`/`renderHarnessEvent`/`renderPersisted`/`[thinking]`/`⚙` 零命中（编排者以 `git show HEAD` 复核）。
危害与 spinner 同类：out_path 指向的文件**存在但与本单元无关**，「out_path 存在 = 完成」会据无关文件误判完成。

**至此 phase 13/14 共发现 4 处队列错误**（spinner 分类、tests/tools 路径、tests/commands 指向另一单元的文件、tui 分类+路径），其中 3 处会直接制造假绿。
共同教训：**manifest 的 base_path/out_path 是 phase 2 依据文件名相似度做的语义映射，未经行为核对**。凡 base 与 oracle 的"公开面重合度"未被验证过的行，都应视为待核实。

## 待编排者在本 phase 内收口的三项（spinner/readline 单元上报）

### C1 — 空白字符类在各单元间不一致（**需统一，oracle 为准**）
Rust `char::is_whitespace` = Unicode `White_Space`；JS `\s` 与之**在两个码点上恰好相反**：`\s` 不含 U+0085（NEL）却含 U+FEFF（BOM）。
- `src/readline.ts`：**已显式写全正确集合并测试**（正确）
- `src/core/slash-commands.ts:288-291`：裸 `\s` + 一条开放 `TODO(port)`（不正确）
**裁决：oracle 为准，统一到 Unicode `White_Space` 集合。** 该文件此刻由 commands-dispatch agent 编辑中，故排队，待其完成后由编排者或后续 fixer 收口。

### C2 — `skill_shortcuts` 无规范落点
oracle `readline.rs:8` 从 `commands.rs:3061-3088` import 它，但**已标记 done** 的 `coding-agent/commands` 单元从未移植它（其 `slash-commands.ts:80-86` 的 `TODO(port)` 把 dispatch 半边整体推给了 `coding-agent/tui`）。
readline 单元只复刻了可达部分，作为**私有** helper `skillShortcutCommands` 放在 `readline.ts` 并标 `TODO(port)` 待规范版落地后删除。
另：oracle 的 `SkillShortcut.source` 在 TS 侧**完全没有对应物**——`packages/agent/src/harness/types.ts:46` 的 `Skill` 不带 `source` 字段。
**归属**：正在进行的 commands-dispatch 轮次需要同一个函数，应由它落地规范版。

### C3 — `sleepUnref` 重复实现
`otlp.ts:341` 与 `spinner.ts` 各有一份私有实现（两处都是为避免普通 `setTimeout` 把 CLI 事件循环撑住，而 oracle 的 task 随 runtime 一起消亡）。两处均已标 `TODO(port)`。
**归属 phase 19 去重**（与 `formatDurationDebug` 的抽取同类）。

## 记录：spinner 的 8 项验收清单全部交付，且三处**超出** oracle 测试强度

1. oracle 只断言 `contains`；本移植新增测试**逐帧分解**并断言每一帧精确等于 `FRAMES[i % 10] + " thinking"`。
2. oracle 只测了 clone 一侧；本移植**两个方向都测**（clone 释放不停、owner 释放停）。
3. oracle 不测 TTY 门；本移植驱动 `process.stderr.isTTY` 的**两个分支**并断言真实 `process.stderr.write` 调用序列。

`impl Drop`（`spinner.rs:110-116`）→ 显式 `dispose()`：`tsconfig.base.json` 锁 `lib: ["ES2022"]`，`Symbol.dispose` 未声明、`using` 不可用。
