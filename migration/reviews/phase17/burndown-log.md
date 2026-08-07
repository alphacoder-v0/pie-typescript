# Phase 17 · burndown 日志

## oracle 复跑基线（done-gate 双计数的另一半）

新增 `migration/parity/test-oracle.sh`（沿用 `build-oracle.sh` 的 SHA 漂移守卫）。

```
oracle: <ORACLE_PIE_DIR> @ 0a120dfd380fb7f009e09f2b7981b76c07b3fd95
cargo test --workspace  exit=0
test binaries=34  passed=1398  failed=0  ignored=0
```

**这条基线改变了分类的严格程度**：oracle 自身**零失败**，所以 phase 17 验收标准里的
`inherited` 桶**必须为空**——TS 侧任何失败都无处归因于「上游本来就坏」，只能是
`regression`（不允许）或 `environment`（须逐条记录）。
不跑这个基线，`inherited` 会变成一个方便的垃圾桶。

## 起点：全场景 parity（S1–S8）

```
S1 DIFF 0   S2 DIFF 0
S3/requests.norm  DIFF 1     S3/run.norm  DIFF 15    S3/session.norm  DIFF 6
S4/final.norm     DIFF 1
S5/replay.norm    DIFF 1     S5/req2body.norm  DIFF 1
S6/session.norm   DIFF 8
S7/files.norm     DIFF 3
S8/list.norm      DIFF 3     S8/resumeerr.norm DIFF 1
```

## S4 — 409 重试（DIFF 1 → **0**）

**根因不是重试**（`reqseq.norm` 本就是 0，两次请求都带鉴权），而是**流式缺陷**：
助手文本从未到达 stdout，尽管最终消息正确落盘、`--print` 模式也能显示。
插桩 `agentListener` 后发现 agent 发出了 `message_update{text_end}` 而 **零个 `text_delta`**，
而管道 TUI 的 headless 打印器只从 `text_delta` 渲染文本。

- 缺陷：`packages/ai/src/providers/openai-responses-shared.ts:421-437` 要求先收到
  `response.content_part.added` 把 `currentItem.content` 种上，否则**静默 `continue`**，
  于是每个 delta 都被丢弃。而 parity 的 SSE fixture（以及真实的 ds4 等 OpenAI 兼容服务端）
  发的是 `output_item.added` → `output_text.delta`，**没有** `content_part.added`。
- oracle：`crates/ai/src/providers/openai_responses.rs:374-400` 的 `on_text_delta`
  **根本不维护** `ResponseOutputMessage.content` 镜像——它追加到最后一个文本块、没有就现造一个，
  并且**总是**发 `TextDelta`。
- 处置：种上 `output_text` part 而非跳过。服务端确实发 `content_part.added` 时该改动为惰性。
- **连带**：这同时是 S3 `run.norm` 缺 `fixture says hi` 的原因。

## S5 — DS4 推理重放（replay DIFF 1 → **0**；req2body 仍 1，见下）

根因如预判：`local-models.ts` 的 `loadAll` **无调用方**。oracle `main.rs:551` 在
`model::auto_detect_model`（:552）**之前**调它，注册进 `pie_ai` 的进程级全局
（`crates/ai/src/models.rs:41-50`），所有解析器都读那里。

处置：`main.ts` 在 `--base-url` 守卫之后、`buildSessionOptions` 之前调
`loadLocalModels(cwd, parsed.baseUrl)` + `modelRegistry.setLocalModels(listCustomModels())`；
`model-registry.ts` 新增 `localModels` 字段并在 `loadModels()` 内重新应用，
使其在 `refresh()` 后存活——对应 oracle 全局在 models.json 重载后仍在。合并时本地优先，
对应 `get_model` 的 custom-first 查找。

**一处待裁决的有意偏离**：oracle 的 `?` 让畸形 models.json **致命**；本移植改为**警告+继续**
（代码内有 `TODO(port)`）。理由：`ModelRegistry` 已经在读**同一个路径**的 pi `{"providers":{…}}` 形状，
且容忍 JSON 注释与 schema 错误；把新增的这次重复读取提升为致命，会让一个**今天能用**的 JSONC
`models.json` 变成启动崩溃。judge 两侧均不可观测。→ ED 候选。

## S5 残留 → 升级为专项（**本阶段行为面最重的发现**）

`req2body.norm` 是**发给模型的真实请求体**。结构化比对后：

| 字段 | 状态 |
|---|---|
| `input[1..]`（推理重放，S5 的真正断言面） | **一致** |
| `model` / `reasoning` / `store` / `stream` / `include` | **一致** |
| 25 个工具的**名字与顺序** | **一致** |
| `input[0]` —— 系统提示 | **不一致** |
| `tools[*]` 定义 | **25 个无一相同** |
| `prompt_cache_key` | TS 独有 |

三处独立的未移植单元：
1. **系统提示**：oracle `main.rs:1180-1225` 的 `render_base_prompt`/`build_system_prompt`
   从未移植，CLI 至今发 pi 的 `core/system-prompt.ts:132` 文本。
   **而 `coding-agent/main` 在 manifest 里标着 `done`** —— 第 5 处队列准确性问题
   （前四处是映射错，这处是**标了 done 但单元内有整块未移植**）。
2. **工具定义**：名字与顺序对，但每个描述与 JSON schema 都是 pi 的
   （如 `edit` 收 `edits[]{oldText,newText}`，oracle 是 `old_string`/`new_string`），
   外加 pi 独有的 `strict:false`/`additionalProperties`。
3. **`prompt_cache_key`**：pi 的 openai-responses 缓存字段，oracle 不发。

**为什么这是最重的**：对一个 agent 而言，系统提示与工具契约就是行为本身——
同样的用户输入，两侧模型收到的指令与工具参数形状不同。

S4/S5 的 fixer **正确地停在了这里**没有越界（理由：会改变每个会话的行为、测试血溅面大、
且与 S3 的 `requests.norm` 共享同一首处差异——系统提示，第 29 字符）。已派专项单元。
