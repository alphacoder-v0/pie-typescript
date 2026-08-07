# 编排者自查发现（phase 7 ledger 复核）

## O-F1 | MEDIUM | ai/utils/headers（ledger 判 none）
- oracle `crates/ai/src/utils/headers.rs:5-7`：`user_agent() -> "pie-ai-rs/{CARGO_PKG_VERSION}"`（= "pie-ai-rs/0.75.0"）
- 唯一调用点：`crates/ai/src/utils/node_http_proxy.rs:21` — 构造 reqwest client 时设为默认 User-Agent，影响所有走代理的 provider 请求
- TS `packages/ai/src/utils/headers.ts` 只有 `headersToRecord`，无 user_agent；TS 代理路径（undici ProxyAgent）不设该 UA
- 判定：wire 可观测分歧（HTTP User-Agent 头）。交 AI-1a 的 node_http_proxy 单元一并核实后处置。

## O-F2 | CONFIRMED MEDIUM | codex provider 多设 User-Agent
- oracle `crates/ai/src/providers/openai_codex_responses.rs:140-152` header 全集：content-type、accept、originator="pi"、OpenAI-Beta、chatgpt-account-id（有则）、session_id（有则）、options.headers —— **不设 User-Agent**（由 reqwest 默认或 node_http_proxy 的 "pie-ai-rs/0.75.0" 承担）
- TS `packages/ai/src/providers/openai-codex-responses.ts:1272-1275` 额外 `headers.set("User-Agent", "pi (${platform} ${release}; ${arch})")`
- 判定：wire 分歧（多一个头、值也与 oracle 的代理层 UA 不同）。originator="pi" 两侧一致，非分歧。
- 处置：交 fixer 与 O-F1 合并处理（统一 UA 策略：codex 不设 UA；代理路径设 "pie-ai-rs/0.75.0"）

# AI-2a（跨 provider 一致性）6 findings 裁决

| id | sev | 裁决 | 处置 |
|---|---|---|---|
| F1 google usage 公式与其余 5 处不同 | LOW | NOT-A-BUG（reviewer 自证：oracle google.rs:391-415 逐字如此，属 per-provider verbatim 移植） | 不动 |
| F2 cost 归零三形态（含 openai-responses-shared 外包给可选 callback 的地雷） | MEDIUM | CONFIRMED | fixer#5 统一为形态 A |
| F3 anthropic.ts 未接 sendWithRetry（oracle anthropic.rs:238 有） | HIGH | CONFIRMED | fixer#2 |
| F4 amazon-bedrock.ts 未接 sendWithRetry（oracle amazon_bedrock.rs:107 有）且无 TODO | HIGH | CONFIRMED | fixer#3 |
| F5 google/google-vertex 未接 retry（SDK 无钩子，有 TODO） | MEDIUM | ACCEPTED-AS-DOCUMENTED | fixer#4 统一注释措辞 |
| F6 openai-responses-shared mapStopReason default throw（oracle:523-538 为 Stop） | HIGH | CONFIRMED（真实回归） | fixer#1 |

# AI-1a（6 个 none 单元深查）10 findings 裁决

裁决依据：新增的 **BUG-scope rule**（bug-for-bug 边界 = judge 可观测性，RULEBOOK §2 开头）。

| id | sev | 单元 | 裁决 | 处置 |
|---|---|---|---|---|
| F1 ContentBlock::Image 变体缺失 | LOW | types | DORMANT | ED10，phase 17 复审 |
| F2 parse_partial_json 可失败 | CRITICAL* | json_parse | judge 不可观测 → 保留 TS 更强实现 | ED5 |
| F3 控制字符不转义 | CRITICAL* | json_parse | 同上 | ED5 |
| F4 无效转义不修复 | HIGH* | json_parse | 同上 | ED5 |
| F5 NO_PROXY 未实现 | CRITICAL* | node_http_proxy | judge 不可观测 → 保留 TS | ED6 |
| **F6 User-Agent（9 provider 全带 pie-ai-rs/{ver}）** | **HIGH** | node_http_proxy+headers | **judge 可观测 → 必须复刻** | **fixer AI-2** |
| F7 非法代理 URL 静默忽略 | MEDIUM | node_http_proxy | judge 不可观测 → 保留 TS | ED6 |
| F8 代理作用域（全局 vs 仅 bedrock） | MEDIUM | node_http_proxy | judge 不可观测 → 记录 | ED7（phase 13 CLI 组装时优先对齐） |
| F9 validation 是 stub 且从未调用 | CRITICAL* | validation | judge 不可观测 → 保留 TS 安全网 | ED8 |
| F10 faux provider 生产注册 | MEDIUM | register_builtins | judge 不可观测；两方论证并存 | ED9 |

\* reviewer 按"与 oracle 不一致"给的严重度；编排者按 BUG-scope 规则重新归类为"judge 不可观测的能力增强"，非缺陷。
hash 单元的 none 判定经核实无误。

**这批的方法论价值**：oracle 在 5 个 utils 单元上明显比 pi 骨架弱（多为自称 "TODO: 1:1 port" 的半成品）。若机械 bug-for-bug，等于主动删除工具参数校验、JSON 修复、NO_PROXY 等既有能力，换取一个 judge 根本验证不了的"一致"。BUG-scope 规则把这条线划在可观测性上，并要求编排者裁决而非实现者自决。

# AI-1b（另 6 个 none 单元）5 findings 裁决

**方向与 AI-1a 相反**：这批是 TS 骨架（继承自 pi）有缺陷、oracle 正确 → 移植 oracle 的正确行为，不是复刻缺陷。

| id | sev | 裁决 | 处置 |
|---|---|---|---|
| F5 anthropic OAuth 用 PKCE verifier 冒充 state（verifier 泄漏进浏览器可见 URL，PKCE 威胁模型失效；oracle anthropic.rs:148 用独立随机 state；同目录 openai-codex.ts 已是正确模式） | **CRITICAL 安全** | CONFIRMED | fixer AI-3 #1，立即修 |
| F1 StringEnum 真值判断丢弃合法假值 default | MEDIUM | CONFIRMED | fixer AI-3 #2 |
| F3 listImageModels 无参变体缺失（oracle lib.rs:32 导出） | MEDIUM | CONFIRMED | fixer AI-3 #3 |
| F2 register_custom_model/unregister_custom_model 无 TS 端口（导出面缺口） | HIGH | CONFIRMED 但归属 phase 13 | 见下 |
| F4 空输入 sentinel null vs {} | LOW | judge 不可观测（ED5 同族） | ED11 |

**F2 的 phase 13 交接**：oracle `models.rs:34-49` 有 Mutex 支撑的进程级 custom model registry，由 `coding-agent/local_models.rs` 合并 `~/.pie/models.json` 与 `<cwd>/.pie/models.json`（cwd 覆盖 user）填充；TS 侧等价用户行为由 `coding-agent/core/model-registry.ts` 独立实现，从不触碰 @pie/ai 的 registry。批次 D 已在 ai/models 行记录该架构分叉。**phase 13（coding-agent/local_models 单元）必须验证：用户放 models.json 后的可见行为（模型出现在 /model list、可被 --model 选中、cwd 覆盖 user）与 oracle 一致**——这是该分叉的唯一验收面。

unit 1（transform-messages）、unit 2（sanitize-unicode）、unit 4（overflow）的 none 判定经复核无误。

# 安全批修复记录（编排者亲自执行——fixer 第 7 次停滞后接手）

- `packages/ai/src/utils/oauth/anthropic.ts`：引入 `randomBytes(16).toString("hex")` 的独立 `expectedState`；authorize URL 的 state、回调服务器绑定、三处回调校验/回退全部改用它；`verifier` 现仅出现在 token 交换 POST 的 `code_verifier`（:204）。行内标 oracle 行号。
- 测试追加进既有 `packages/ai/test/anthropic-oauth.test.ts`（复用其 fetch mock 脚手架，而非新建重复脚手架）：断言 state 为 32 hex、逐次登录不同、≠ code_challenge、verifier 不出现在 authorize URL 任何位置、verifier 确实到达 token 交换。3/3 绿。
- `utils/typebox-helpers.ts`：真值判断 → `!== undefined`（falsy default/description 不再被丢）。
- `image-models.ts`：新增 `listAllImageModels()`（oracle image_models.rs:13-15 + lib.rs:32），经 `export *` 自动出包。
- 新测试 `typebox-helpers-defaults.test.ts`(4) + `image-models-list-all.test.ts`(2)，6/6 绿。
