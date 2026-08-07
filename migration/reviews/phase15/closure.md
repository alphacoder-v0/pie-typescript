# Phase 15 收口记录

## 交付

7 个 manifest 单元（ui/{feed,kernel,listener,relay,web,mod} + workers/fefe-hub）。
oracle 6886 行 Rust → TS；`ui/mod` 3409 行拆为 5 文件（800 行上限）。
workers/fefe-hub 纳入根 `build`/`test`（不进 `workspaces`——它是带 wrangler 的 Cloudflare Worker，加进去会改变整个 monorepo 的依赖解析图）。

## WebUI 冒烟：新增 `migration/parity/webui-smoke.sh`，PASS

验收标准明写「curl 脚本断言」。单元测试在进程内驱动 router，**证明不了"真的监听了端口、真的能被外部进程用 HTTP 取到"**。该脚本起真实 `node:http` 服务、用真 curl 打，且跑的是**构建产物**（与 `./pie` 同口径）。

结果：`GET /` 200 + `text/html` + body 与 `web_index.html` **逐字节相同**（69581）；`/events` 200 + `text/event-stream` + `no-cache` + publish 后送达 snapshot 帧；未知路径 404。

### 冒烟实证的两件事（读代码得不到）

**1. 证实了 web 单元预判的构建缺口。** 首轮 `GET /` 返回 **500**——正是它报告里写的「`copy-assets` 未把 `web_index.html` 复制进 `dist/ui/`，构建版会在 `indexHtml()` 处抛错」。已补进 `copy-assets` 与 `copy-binary-assets`（Bun 构建那条同缺）。

**2. 纠正了编排者自己写错的断言。** 原断言「连上 SSE 后数秒内应收到 snapshot」持续 FAIL。查 oracle `web.rs:683-701`：`events` 处理器**只订阅广播、不在连接时补发快照**——空闲应用上什么都不发才是正确行为。**移植是对的，断言是错的。**
若当时把这条 FAIL 当移植缺陷派给 fixer，就会有人去给 TS 加一个 oracle 没有的初始快照重放——**用真实的行为偏离去满足错误的断言**。
改为「保持连接 → POST /prompt 触发 publish → 断言送达」。

## 各单元的关键判断

### web（1708 行）
- **保住了 Node 会静默丢掉的严格性**：Rust `base64::STANDARD` 是规范且严格的，而 `Buffer.from(s,"base64")` 接受无填充、URL-safe `-`/`_`、内嵌空白、非规范尾部比特。专门写了 `decodeBase64Strict` 全部拒掉。
- **IPv6 loopback 精确语义**：`Ipv6Addr::is_loopback` 只认 `::1`，故 `::ffff:127.0.0.1`（v4-mapped）**被拒绝**，并加了回归测试防止后人"好心地"解包该映射。WebUI 默认 loopback-only 是安全边界。
- axum 0.8.9 的可观测行为逐条复刻：`Json`/`Html`/SSE 的 content-type、404 fallback、405+`Allow`、无尾斜杠重定向、415/400/422/413 拒绝、2 MiB `DefaultBodyLimit`。

### relay（1078 行）
- `qrcode` crate 不在 §1 白名单 → **从零移植 QR 编码器**（~470 行：字节模式、EC level M、版本 1-10、标准掩码与惩罚），并用一个**独立写的临时解码器**做 v1/v2/v5/v6/v10 往返验证（含多块交织与版本信息块）。
- §2.2 映射逐站点列表已在报告中给出，无手搓 `Promise.race`。

### ui/mod（3409 行 → 5 文件）
- **纠正了编排者 brief 的错误**：`--tui`/WebUI 分支在 **`main.rs:1071-1105`**，不在 `ui/mod.rs`。未与 pi 的 `resolveAppMode`（回答 interactive/print/json/rpc，是另一个问题）融合，单独落 `ui/ui-mode.ts`，14 个测试（TTY/env 探针均注入）。
- **闭合了 kernel 留下的重试缺口**：把 oracle 自己的薄包装（`agent_session.rs:85-217`）移植为 `ui/retry-prompt.ts`，经 `ReplKernel.setUserPromptRunner` 装入，且**在 `track()` 内部执行**以保证 `isStreaming()` 跨重试仍准确（有测试锁定；否则 `startTriggeredTurn` 的跳过守卫会静默失效）。可重试正则**未复制**——从 `core/agent-session.ts` 提取为 `isRetryableErrorMessage` 两处共用。
- **拒绝把 dispatch 嫁接进 `interactive-mode.ts`**，理由成立：那条 if-链分发的是 **pi 的**命令（`/settings`、`/scoped-models`、`/export`）到组件树选择器，pie 的 `CommandOutcome` 联合无对应 arm；oracle 的 REPL 就是刚交付的 `App`——`interactive-mode.ts` 是**要被替换的东西**，不是要嫁接的。已给出 `main.ts` 的精确 4 步。
- **一处结构性偏离（明说）**：oracle 经 ratatui 绘制，§1 不许加依赖 → `App.render()` 返回 `Frame`（ratatui 本会收到的同样的行，以 `FeedLine[]` 表示），`frameText()` 对应 oracle 的 `buffer_text()`。oracle 断言的每个字符串原样断言；**不断言的是单元格级摆放**——oracle 断言摆放处（「状态线在最后五行」）改为对布局矩形断言，那才是真正决定它的东西。

### feed/kernel
- 三种"长度"按 oracle 实际用法分别处理：码点（`truncate_chars`、每行上限）、UTF-8 字节（`hidden_bytes`、每省略行 +1 换行）、显示宽度（`charWidth` 对 C0/DEL/C1 返回 0，复刻 Rust `None.unwrap_or(0)`，顺带修正制表符）。
- `is_streaming()` 无对应物（`AgentHarness.phase` 私有）→ kernel 内在途计数器，**失败时保守抛 `busy` 而非静默跳过**。

## 一处编排者错误

用 `json.dumps(indent=2)` 改根 `package.json`，把全文 tab 缩进换成空格——118 行差异里只有 4 行是实质改动。由并行 agent 在报告中指出（它据 mtime 早于自己首次写入 + 内容是 workers 接线判断"不是我的，但值得在 phase gate 前还原"）。已还原并改用文本级最小编辑（4 增 2 删）。
**教训：改 JSON 配置文件不要用 `json.dumps` 重写全文。**

## 结转

- **phase 16（Smoke: run it）**：`main.ts` 切到 `App`——4 步已在 `ui/index.ts` 报告中给出；步骤 1 需要 `CommandHarness` 形状的适配器，而**已移植的 `AgentHarness` 缺 `skills()`/`session()`/`templates()`**（`slash-dispatch-deps.ts:12-35` 已记录该缺口）。
- **phase 17**：`feed.ts` 的 `WebFeedBlock.timestamp?: string` 会省略键，而 oracle 的 `Option<String>` 无 `skip_serializing_if`、serde 输出 `"timestamp": null`——功能等价，严格 wire 差分会显出来。
- **phase 19**：`relay.ts` 1078 行超 800 上限（QR 编码器占 470，建议抽 `src/ui/qr.ts`）；`web.ts` 1708 行；`rustLines` 在 `feed.ts` 与 `tui.ts` 各一份；`src/debug.ts:46-65` 的占位类型现可换成 `ui/feed.ts` 的真实导出。
