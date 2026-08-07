# Phase 12 · 修复轮次闭环

评审拓扑：implementer（2 批）→ 3 个对抗性 reviewer（2 个对照 Rust 源分组、1 个对照 RULEBOOK）→ 编排者裁决 → 6 个 fixer（按文件切分，互不重叠）+ 编排者亲自修 4 项。

## 裁决汇总（编排者）

| 项 | 裁决 | 去向 |
|---|---|---|
| auth env-vs-stored 优先级 | 保留 base | ED13 |
| auth 落盘格式 | 保留 base | ED14 + phase 19 只读导入义务 |
| S8 解析器错误详情两侧措辞不同 | 归一化塌缩，判定力由新测试锁定 | ED15 + judge-validation 重验证 |
| OAuth 自动刷新（oracle 无） | 保留 base | ED16 |
| smol-toml 整数上界 | config 侧用 `integersAsBigInt` 解决未知节；pie 自有字段无解 | ED17 |
| `tokio::time::timeout` 表外构造，同批三种映射 | **补 RULEBOOK §2.2 行** | Deviation log 2026-08-05 |
| `.pie/lsp.toml` 无信任门 | **立 B13**（实施者以"不在表里"否决属循环论证） | RULEBOOK §5 |
| browser-smoke 只打单一入口，弱于 §2.3 字面 | 记录，不改规则 | Deviation log，phase 19 决定 |

## 修复轮次

| fixer | 文件 | 条目 | 结果 |
|---|---|---|---|
| A | session-manager.ts · config.ts | D1-1 预览、D1-2 徽章计数、D2-1 TOML 严格性、D2-2 标量节、PIE_DIR 波浪号 | 150 测试全绿；14 个新测试经"回退源码验红"确认非空断言 |
| B | session-archive.ts | D3-1 sidecar 校验、D3-2 缺 parentId、D3-3 空 transcript、D3-4 cron 崩溃、标记整改 | 15→19 测试；标记可 grep |
| C | auth-storage.ts · history.ts | B-D4 静默禁写(HIGH)、B-D5 原子落盘、格式标记、D4-1 CRLF | 57/57 + 消费方 70/70 无回归 |
| D | mcp-loader.ts | B-D3 数值校验、B-D1 惰性构造、B-D2 错误路径；后续切到 `getLoadError()` | 28 测试；**B5 复刻未被削弱**（两条特征测试按名确认） |
| E | oauth.ts | B-D9 响应校验、B-D8 前缀、3A 超时收敛、B-D10 文案、B-D11 bind 归类；追加 status Display、空串 code/state | 24 测试 |
| F | lsp.ts（行为轮） | B-D13 逐条校验（完成）；其余 4 条因 agent 停滞由编排者接手 | 见下 |
| 编排者 | lsp.ts · duration-format.ts · oauth.test.ts | B-D12/B-D14/B-D15/B-D17；抽取共享 `formatDurationDebug`；修 oauth flaky 测试 | tsgo 0 error |
| G | lsp.ts（合规轮） | 3A/3B/3C/4-3/4-5 | 进行中 |

## 两处方法论纠正（reviewer 提出，编排者采纳）

1. **实施者不得以"规则表里没有"为由否决应上报条目**（lsp.toml 案）。§5 由编排者维护；实施者的职责是提议而非自行否决。
2. **编排者给 fixer 的指令出过一次错**：让它按"未知状态码只打数字"实现 `StatusCode` 的回落。fixer 去查了 `http` 1.5.0 crate 源码，实际回落是 `<unknown status code>`，据此拒绝了该指令；它还把 62 条 canonical reason 与 Node 的表机械比对，找出 3 处差异（203/418 措辞、509 无对应）。按 oracle-as-spec 覆盖编排者口述，做法正确。

## 顺带修掉的测试缺陷（非产品缺陷）

`test/oauth.test.ts` 的 4 处回调测试用固定 `setTimeout(50)` 等待端口绑定。单独跑恒绿，仅在与 lsp 测试并发时因 worker 争抢暴露 `fetch failed`——最易被误判为"偶发、重跑就好"的一类。已改为轮询直到端口可连（`fetchWhenListening`），连跑 3 次稳定。

## 编排者自身的两个流程失误（记录以免复发）

1. 在自己新增的 3 个 lsp 测试**尚未验证通过**时就派了下一轮 fixer 去改同一文件。已发消息要求该 fixer 区分"编排者测试写错"与"重构改坏行为"，禁止静默处理。
2. 先前曾对用户表述 phase 12 可以收口——彼时尚未跑对抗性评审。补跑后抓出 25 条确认分歧，其中含 1 条 HIGH。**评审不是可选步骤。**

---

## 全量运行才暴露的两个问题（分包绿 ≠ 全量绿）

每个 fixer 都只跑了自己那几个测试文件并报告全绿，以下两条只在合并后的全量运行里现形：

1. **fixer 留下未跟踪的临时探针** `test/zz-probe.test.ts`——调查 B-D12 可观测性时建的脚手架，忘记删除。vitest 会把它收进验收套件并失败。已删除。
2. **编排者自己引入的连锁反应**：为 B-D14 加的测试故意打死读泵，导致 `shutdown()` 收不到响应、在 teardown 里耗满 15s 请求超时，同时占着一个 vitest worker。全套并发竞争被推高，把本就偏慢的 `agent-session-runtime` 某测试（单独跑 7.35s）挤过了 30s 上限。
   处置：**不调高那个测试的超时**（会把问题藏起来），改修根因——让"投毒"夹具在发完计划帧后自行退出，客户端后续写 `shutdown` 快速失败。`lsp.test.ts` 从 ~31s 降到 2.2s，为此加的 25s 钩子超时一并撤销。

## 编排者推翻 fixer 结论的一处（跨包一致性）

lsp 合规轮把 `clientInfo.version` 从硬编码 `0.75.0` 改为 `import { VERSION }`（= 0.75.4），理由是"避免字面量静默漂移"，并如实标记"若 parity 要求字节一致需复议"。

裁决：**改回硬编码 0.75.0**。仓库已有确立约定——5 处线上版本串（`ai/utils/headers.ts:12`、`mcp/client.ts:62`、`mcp/http.ts:34`、`tools/web-fetch.ts:35`、`tools/web-search.ts:30`）全部硬编码 0.75.0，且 **phase 6 的 MCP 评审已把"0.75.4 vs 0.75.0"判为 CONFIRMED 并修回**（`migration/reviews/mcp/findings.md`）。TS 包版本沿袭自 pi（0.75.4），跟随它等于保证与 oracle 不一致；"漂移"的正确解法是硬编码 + `TODO(port)` + phase 19 统一扫。

**连带发现**：fixer 引用的先例 `session-archive.ts:458` 本身就是错的——它把 0.75.4 写进 `.piesession` 清单的 `pie_version`，而 oracle 写 0.75.0。这是**持久化产物**，比握手串影响更大，且是 phase 12 新引入的。两处均已改回硬编码并标注。

此条说明对抗性评审的价值方向不是单向的：reviewer 以 LOW 级报出"硬编码会漂移"，fixer 照直修，反而引入了一处跨包不一致 + 一处持久化字节偏差。**修复本身也需要被裁决。**
