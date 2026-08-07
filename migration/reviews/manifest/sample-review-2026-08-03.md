# Manifest 抽样对抗复核（phase 2）

方法：seed=42 随机抽 10 个工作单元；两名独立对抗性 reviewer（分开上下文，均假定分类错误）；分歧由编排者第三方裁决（默认 not-confirmed）。

## 结论

| unit | A | B | 裁决 |
|---|---|---|---|
| coding-agent/markdown | correct | correct | correct |
| ai/providers/google_shared | correct | correct | correct |
| mcp/transport | correct | correct | correct |
| **ai/vertex_provider** | WRONG | WRONG | **CONFIRMED WRONG** → 改 diff-port base=google-vertex.ts |
| ai/utils/oauth/types | correct | correct | correct |
| ai/utils/oauth/github_copilot | correct | correct | correct |
| ai/providers/openai_codex_responses | correct | correct | correct |
| ai/providers/github_copilot_headers | correct | WRONG | not-confirmed：oracle 文件头自证 "TODO: 1:1 port of github-copilot-headers.ts"，祖先声明成立；B 发现的"当前实现为静态头 stub、与 base 动态头键集不重叠"记为该单元分歧注记（真正静态头常量在 oauth/github-copilot.ts 的 COPILOT_HEADERS） |
| coding-agent/history | correct | WRONG | not-confirmed：pie=磁盘持久 store（~/.pie/history、cap1000、/history 命令），pi editor=进程内数组（cap100）——工作单元本体为新持久层，port 成立；接线点（tui editor addToHistory/navigateHistory）已记入 rationale |
| ai/providers/anthropic | correct | correct | correct |

确认错误 1 项 → 触发 ai crate port 行全量返工（验收标准）。

## 返工（ai crate 12 个 port 行逐一内容级复查）

- vertex_provider → diff-port（确认项）
- bedrock_anthropic → diff-port base=providers/amazon-bedrock.ts（能力在 pi 的 SDK 消费側；SDK 采纳问题移交 RULEBOOK §1）
- sigv4 → diff-port base=bedrock-provider.ts（同上）
- vertex_adc → port 维持（pie-only ADC JWT exchange，文件头自证 closes pie#14 gap）
- event_stream / utils/aws_eventstream / utils/sse → port 维持（文件头自证 "No 1:1 TS counterpart — TS 用 AWS SDK / eventsource-parser"）
- utils/retry → port 维持 + 标注 409 分歧站点（审计确认的 DS4 适配）
- utils/abort → port 维持（TS 原生 AbortSignal）
- providers/mod / providers/images/mod / utils/mod → port 维持（module glue → TS barrel）

## 泛化机器检查（新增，防同类漏检）

`所有 port 行的 Rust 文件头若声明 "port of packages/..." 即为漏检`——全仓扫描 0 命中；diff-port 行头部声明与 base_path 全一致。该检查并入 gen_manifest 复核流程。

失败模式记录：pie 将单个 pi 文件拆成多个 Rust 模块时，纯名称匹配漏检 → 已通过 curated 覆盖 + 内容级复查 + 头部声明扫描三重缓解。
