# Phase 13 · 待在 phase 边界应用的修订与待办

> RULEBOOK standing rule 1：法典在 loop 内只读，修订排队、在 phase 边界应用并记入 §6 Deviation log。
> 本文件是 phase 13 进行期间累积的队列，**不要在 loop 内直接改 RULEBOOK**。

## 排队中的 RULEBOOK 修订

### A1 — 提议新增 §5 B14（otlp 的 renamed layer 永不导出）

**来源**：phase 13 批次 D（otlp 单元 implementer 主动上报，未自行分配 id——这是正确姿态，见 B13 的先例：实施者应提议而非自决）。

**事实**：oracle `crates/coding-agent/src/otlp.rs:78-86` 的 `with_service_name` → `clone_for_rename` 返回一个带全新 `pending`/`open` 的 `Inner`，但**从不为它 spawn flush pumper**（只有 `otlp.rs:68-74` 的 `new` 会 spawn）。因此经由「改名后的 layer」记录的 span 会永远排队、永不导出。

**当前状态**：已 bug-for-bug 复刻，带内联注释与一个锁定可观测部分的测试；但**未打 `BUG(port): B<n>` 标记**，因为 implementer 不自分配 id。

**编排者倾向（待 phase 边界确认）**：**采纳为 B14**。理由：§5 的定义是「必须复刻的缺陷」，它已被复刻；不给 id 则 phase 19 的标记对账会漏掉它。同时在表中注明**两侧皆不可达**（oracle 无调用方，TS 亦无），因此 parity 不受影响、phase 18 优先级低——与 `oauth.rs` 整体是死代码却仍照实移植是同一姿态。

**应用时需一并做**：在复刻站点补 `BUG(port): B14` 标记（否则 §5 的「每项站点标记」要求不满足）。

## 排队中的接线待办（phase 13 内完成，不进 RULEBOOK）

### W1 — `logging.ts` 尚未被 main 调用
批次 D 交付了 `logging.ts`，它是**本仓此前缺失的日志 sink**：先前多个单元留下过「no logger reachable here」的注释（`hooks.ts:422`、`skills-state.ts:123`、`goal.ts:339`、`tools/remove-skill.ts:218`）。
需要：`main.ts` 启动时调 `init(sessionId)`、持有 handle 至进程结束、把 `handle.logPath` 传进 `/diag` 命令上下文（oracle `commands.rs:182` 的 `CommandCtx.log_path`）。
**顺带**：上述 4 处「无 logger」注释现在有 sink 了，应复查是否该改为真实日志调用。

### W2 — `debug.ts` 尚未被 main 接线
需要：debug 标志开启时用 `wrapStreamFn(base, feedQueue)` 包住 harness 的 `StreamFn`。

### W3 — `otlp.ts` 无需接线
`logging.ts` 内部已调 `tryLayer()`。仅记录，无待办。

### W4 — `redact` 三份拷贝收口（已派给批次 C）
`debug.ts` 内联了 oracle 的完整 10 条模式（§3 最保守翻译，带 TODO），`cron-deps.ts:139-151` 有 2 条模式的 stub，权威实现应在 `bug-report.ts`。已指示批次 C 落地真身并把两处改为 import。

## 排队中的架构裁决（等可达性审计结果）

### R1 — `packages/agent/src/harness/agent-harness.ts` 在产品路径上无调用方
已核实：`packages/coding-agent/src` 从不 import 真身，只有 `triggers/cron-deps.ts:171` 的本地 duck-typed 同名接口。CLI 走 pi 自己的 `core/agent-session.ts`。
影响面：phase 8 的 41 个单元里，凡落在 `harness/` 且未被 coding-agent import 的，其行为在产品上不存在，而 parity 会因「功能没跑」而假绿。
前例：phase 12 的 B8 就是这么被发现的（复刻在 CLI 不用的 `jsonl-storage.ts`，真实路径是 `session-manager.ts`）。
**处置待可达性审计的三张表出来后统一裁决。**

## 已作废的结转项（记录以免复发）

- ~~「phase 13 必须把 `/compact` 接到既有的 `compact()`」~~ —— **前提错误，作废**。批次 A 查证 `/compact` 早已接好：`modes/interactive/interactive-mode.ts:2576` → `handleCompactCommand` → `core/agent-session.ts:1665` 的 `session.compact()`。该待办由编排者从 phase 8/11 结转而来，属陈旧信息，且曾被写进给用户的交接说明。

---

## 接线与交付进度（编排者维护，2026-08-04）

### 已完成
- **17 个源单元全部移植**：批次 A（main/commands/agent_session/model）、B（templates/mentions/resume_picker/model_picker）、C（images/clipboard_image/local_models/control_plane_prompt/bug_report）、D（logging/debug/otlp/extensions）
- **`pie` 启动器已就位**（仓库根，可执行）。在 parity 的 `env -i` + `PATH=/usr/bin:/bin:/usr/local/bin` 下验证可启动；刻意指向**构建产物** `packages/coding-agent/dist/cli.js` 而非源码，因为该 PATH 下的 `/usr/bin/node` 是 v22.x（开发环境是 v24.x）。
- `redact` 三处收口（bug-report.ts 为真身）

### T5-b — `--help` 输出与 oracle 形态完全不同（**新发现，phase 13 阻塞项**）

oracle 的 `--help` 是 clap 生成的：
```
Simple coding agent on top of pie-agent-core

Usage: pie [OPTIONS] [COMMAND]

Commands:
  session  Export or import replayable `.piesession` backups
  help     Print this message or the help of the given subcommand(s)

Options:
      --provider <PROVIDER>  ...
```
当前 TS 侧输出的是 pi 自己的：
```
pi - AI coding assistant with read, bash, edit, write tools

Usage:
  pi [options] [@files...] [messages...]

Commands:
  pi install <source> [-l]  ...
```
差距不只是程序名，而是**整个帮助面的结构与选项集**：oracle 有 `--provider/--model/--base-url/--thinking/--resume/--continue/--resume-id/--list-sessions/--list-all-sessions/--delete-session/--image/--builtin-skill/--trigger-poll-secs/--debug/--yes/--always-allow/--web/--tui/--web-host/--web-port`，pi 是另一套。

这是 phase 13 验收标准第 2 条（`./pie --help` 与 oracle 结构一致，parity S1 全绿）的直接对象，需要单独一轮。

**顺带确证**：oracle 的 `--yes`（Auto-approve control-plane prompts）与 `--always-allow`（Auto-approve every approval prompt, including control-plane writes）证明**权限门是真实产品功能**，佐证 T4 接线的必要性。

### 待办（按优先级）
| # | 项 | 状态 |
|---|---|---|
| T1 | pie 工具注册表接进 CLI（B10/B11 复活） | 进行中 |
| T4 | 权限门接进工具执行路径 | 进行中（与 T1 同轮） |
| T5-b | `--help` 面对齐 oracle（含 bin 改名 pi→pie） | **未开始，阻塞 S1** |
| T2 | triggers（cron/dynamic/inbox）接进 main（B6/B7 复活） | 未开始 |
| T3 | `goal.ts` 接进命令面 | 未开始 |
| T5-a | logging/debug 接进 main | 未开始 |
| — | 批次 B 的三处接线（mentions.expand / model-picker catalog / loadPromptTemplatesWithDiagnostics） | 未开始 |
| — | 16 个 char-tests 单元 | 未开始 |
