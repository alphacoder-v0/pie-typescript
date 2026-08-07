# phase 20-8 · G-a 的 10 条 MEDIUM 逐条处置

结局分布：**4 条对齐 · 1 条部分修复 · 5 条声明保留**。
每条都写明为什么，不用「低优先级」这种不可判定的理由。

---

## 已对齐（4 条）

### 1. `mcp/protocol.ts:12` — 畸形 MCP 响应零校验 ✅

oracle 靠 serde 硬拒（`protocol.rs:47-53` 的 `name: String` 无 `Option` 无 `default`、
`ToolContent` 的 `#[serde(tag="type")]`），`client.rs:282` 的 `?` 把违规变成一条 `McpError`。
本仓是裸 `raw.name as string` / `raw.content as ToolContent[]`，零校验。

**为什么这条值得改**：MCP server 是**任何人都能写的第三方进程**。一个 `name: undefined`
的工具进了目录，之后调用它时的失败会归因到别处去。校验缺失的代价不是「少一层保险」，
是**把可归因的协议错误变成了不可归因的行为异常**。

处置：在 `normalizeMcpTool` / `normalizeMcpToolCallResult`（serde 会失败的同一位置）补校验，
抛 `McpError.protocol(...)`。文件头那段「不做运行时校验，与 providers/*.ts 先例一致」的说明已改写——
那条类比不成立：provider 响应来自少数几家有合同约束的厂商，MCP server 不是。

测试：`packages/mcp/test/malformed-response-rejection.test.ts` 8 条（含 2 条负控）。
负控实测：去掉 name 校验 → `expected a protocol error, but nothing was thrown` ×2 **红**。

### 2. `prompt-templates.ts:262` — 模板目录名 ✅

oracle 是 `<cwd>/.pie/templates/` 与 `<PIE_DIR|~/.pie>/templates/`（`templates.rs:16-19`）；
本仓两处都写死了 `prompts/`。**pie 用户已有的模板一个都不加载**，斜杠命令报未知，
且没有任何提示——静默的全量失效。

**结论（criterion 要求的那条）：两个都读，不改名。** `prompts/` 是 pi 的既有位置
（`migrations.ts:140` 还有一条 `commands/ → prompts/` 的迁移），改名会让 pi 用户的模板
反过来全部消失。多读一个目录相对 oracle 是超集，与本仓对骨架 flag 的一贯处置同类；
少读 oracle 那个则是实打实的缺陷。顺序上 `templates/` 排在后面，pi 用户的优先级现状不变。

测试：`packages/coding-agent/test/ported/oracle-templates-dir.test.ts` 3 条（含 1 条负控方向）。

### 3. `anthropic-sse-e2e.test.ts:187` — SSE error 帧的消息 ✅

oracle 抽 `/error/message`，兜底 `"anthropic error"`（`anthropic.rs:358-366`）；
本仓 `throw new Error(sse.data)` 把整条 JSON 扔进 `errorMessage`。用户读到的是
`{"type":"error","error":{"message":"overloaded"}}` 而不是 `overloaded`。上游正忙时这条路径很常走。

处置：新增模块私有的 `anthropicSseErrorMessage(data)`，逐字对齐 oracle 的抽取与兜底。

### 4. `google-vertex.ts:355` — Vertex 重试 ✅

**2026-08-04 已修**（与 `google.ts:359` 同一处改动，见 backlog 表首的落地说明）。本次复核确认仍在。

---

## 部分修复（1 条）

### 5. `main.ts:1326` — 六行启动输出缺失 ⚠️

oracle `main.rs:884-1023` 在 banner 之后逐条报告加载了什么。本仓**一行都没有**：
用户拿不到「技能/模板加载成功」的启动确认，也看不到 loader 诊断——而那恰恰是某个技能
悄悄没生效时你要找的信号，没有它只能靠「怎么用不了」去反推。

**本次落地四行**（`services.resourceLoader.getSkills()/getPrompts()` 在 banner 处可达）：

```
loaded N skill(s): a, b, …
loaded N template(s): x, y, …
templates loader: N diagnostic(s), first: <msg>
skills loader: N diagnostic(s), first: <msg>
```

格式与「非空才打」的条件逐字对齐 oracle。实测：播种一个技能与一个模板后启动，
输出 `loaded 23 skill(s): demo, …`。

**未落地两行，理由具体**：
- `loaded N local model(s)` — 本地模型的加载结果在 banner 处不在作用域（`local-models.ts`
  的注册发生在更早、结果没有回传到这一层）。补它要改 `createAgentSessionServices` 的返回形状。
- `hooks: loaded N hook(s)` / hook 诊断 — `hooks.ts` 的 `HookRunner` 在本仓**零 importer**
  （`main.ts:159` 的 `TODO(port)` 已记录：`cli_hooks` 恒为 `false`）。这一行的前置条件是
  hooks 先被接线，属另一条待办，不是本条的一部分。

---

## 声明保留（5 条）

### 6. `ui/terminal-driver.ts:21` — 光标位置

oracle 渲染 tui-textarea，其默认 `cursor_style` 是 `Modifier::REVERSED`——**画一个反显单元、
从不移动硬件光标**；本仓把硬件光标停在输入区最后一行末尾。

**保留理由**：这是两套 TUI 栈的渲染模型差异，不是逻辑缺陷。原判定自己写明「按键仍然落对地方」——
编辑行为正确，只有光标的视觉位置在多行/行中编辑时不同。对齐它意味着改写光标渲染层
去模拟 ratatui 的反显单元，改动面覆盖整个输入组件，换来的是观感一致。
**不值当，且没有正确性后果。**

### 7. `main.ts:961` — auto-detect 只在 settings/CLI 都没定模型时才跑

oracle 无条件按 CANDIDATES 的 env 顺序检测，且 oracle **根本没有 settings 默认模型**。

**保留理由**：差异的根源是「本仓有 settings 默认模型这个 oracle 没有的概念」。
oracle 之所以能无条件检测，正因为它没有可尊重的用户设置。本仓若照抄，
就会**无视用户在 settings 里显式指定的模型**——那不是对齐，是把一个 pi 功能改坏。
原判定描述的坏情形（settings 指向无凭据 provider）真实存在，但正确的修法是
「settings 模型不可用时回落到 auto-detect」，而不是「无条件覆盖 settings」。
该修法属新行为设计，不是移植缺陷，出本次范围。

### 8. `main.ts:1228` — `mainRunRx` 无推送方

`App.startTriggeredTurn` 永不触发，丢掉状态行与 busy/spinner，且触发轮跑在 `turn.fut` 之外。

**保留理由**：原判定自己写明「轮次本身照跑」——功能在，缺的是 UI 反馈与 Ctrl-C 归属。
且**仅在配置了 `inject_and_run` 触发器/cron 时可达**。接线要打通 trigger runtime 到 UI 的
一整条通路，属 phase 9 的「hooks 零 importer 不触发」同一族问题，在那里一并评估更合适。

### 9. `install-skill.ts:28` — 装完不热重载

oracle 调 `harness.reload_skills_from_disk()` 重建 system prompt。

**保留理由**：原判定自己写明可绕过——`tools/skill.ts` 每次调用都重扫磁盘，
**刚装的技能立刻就能调用**。差的只是 system prompt 里的技能目录到 `/skills reload`
或重启前是陈旧的，即模型可能不知道有这个技能、但用得了。热重载要在活着的 harness 上
重建 system prompt，触及会话状态的可变性，风险高于收益。

### 10. `ui/index.ts:425` — `/model` 选择器不查 auth store

用 `/login` 配好的 provider 在选择器与 web 徽章上显示 " · no key"。

**保留理由**：显示错误、行为正确——选中它照样能用。修法是给 `AppConfig` 注入
`catalog`/`authStorage`（`main.ts:1406-1435` 从不注入），属接线待办；
本次未做是因为它与第 8 条同属「UI 层接线」族，且没有正确性后果。

---

## 工程检查

```
npm run build                        成功
npm run check                        7 道门禁全绿
bash test.sh                         exit 0；4270 passed / 0 failed
bash migration/parity/run-parity.sh  exit=1（预期），差异文件恰好 8 个 = 声明基线
```

`packages/mcp` 由 38 → **46**（新增 8 条），coding-agent 2658 → **2661**（新增 3 条）。

## backlog 状态

`migration/post-parity-backlog.md` 的 G-a 表已**逐行**加前缀：4 条 `[已修 2026-08-05 · phase 20-8]`、
1 条 `[部分修复 …]`；未加前缀的五条即声明保留，表首的说明块指向本文档。
