# Phase 12 · Reviewer A（对照 Rust 源）· 第一组 5 单元

范围：session/mod · config · session_archive · history · export
判定：9 条 CONFIRMED-DIVERGENCE + 5 条 UNSURE + 1 条 minor

## CONFIRMED（编排者裁决：全部交 fixer）

| # | 单元 | 分歧 | oracle | TS | 可观测输入 |
|---|---|---|---|---|---|
| D1-1 | session/mod | 首条 user 预览：oracle 无条件返回（含空文本），TS 跳过无文本的 | mod.rs:130-158 无条件 `return Some(preview)` | session-manager.ts:1755-1765 `if (!text) continue` | 首条 user 消息只含图片块 → oracle 预览为空串，TS 改显示第二条 |
| D1-2 | session/mod | automation sidecar 计数：oracle 整体反序列化失败→计数 0→无徽章；TS 逐字段宽松→出徽章 | mod.rs:275-279,295-308 `EnabledOnly{enabled:bool}` | session-manager.ts:1613-1624 `Array.isArray` + `=== true` | `<session>.cron.toml` 里 `enabled = "true"`（字符串）→ oracle 无徽章，TS 显示 "automation off" |
| D2-1 | config | 整文档 TOML 严格性反向：oracle 忽略未知节，smol-toml 因大整数拒绝整份文件 | config.rs:42-46,64-66 「Unknown sections and keys are ignored」 | config.ts:575-582 `parseToml(整份文档)` | `config.toml` 含无关节 `[foo] max = 9223372036854775807` → oracle 正常取默认值，TS 抛 `parse config.toml: integer value cannot be represented losslessly`（reviewer 实跑验证） |
| D2-2 | config | 顶层 `triggers`/`relay` 类型错误：oracle 报错，TS 静默回落默认 | config.rs:90-99 反序列化失败 | config.ts:592,616 `parsed.relay?.base_url` | `relay = "https://example.com"`（标量而非表）→ oracle 报错，TS 静默连默认 relay |
| D3-1 | session_archive | 导入的 sidecar 未做 schema 校验（**最高价值：唯一会写坏状态的**） | session_archive.rs:582-602 缺字段即 `Err`，整个 import 中止 | session-archive.ts:490-519 `as` 断言不校验 | `.piesession` 内 `sidecars/triggers.json` 缺 `version`/`created_at` → oracle 整体失败不落盘，TS 成功落盘一个 schema 非法的 rule |
| D3-2 | session_archive | 缺 `parentId` 键：oracle→None 放行，TS→抛「dangling parent reference」 | session_archive.rs:389-393 `Option` 缺键即 None | session-archive.ts:349-351 `entry.parentId !== null`（undefined 也进分支） | transcript 含无 `parentId` 的行 → oracle 接受，TS export/import 直接抛错 |
| D3-3 | session_archive | 空 transcript 专用错误分支丢失 | session_archive.rs:367-369 `session transcript is empty` | session-archive.ts:313-320 落到 `parse session metadata: ...` | 零字节 session 文件 → 错误文案不同（仅文案） |
| D3-4 | session_archive | cron sidecar 无 `jobs` 键时 `activateImported` 崩溃且留下部分状态 | session_archive.rs:347-353 `#[serde(default)]` → 空 vec，返回 (n,0) | session-archive.ts:691-703 `for (const job of file.jobs)` 无守卫 | 导入的 `<session>.cron.toml` 无 `[[jobs]]` + 非空 cronIds → TS `TypeError: file.jobs is not iterable`，且此时 trigger sidecar 已被改写 |
| D4-1 | history | CRLF：Rust `str::lines()` 去 `\r`，TS `split("\n")` 不去 | history.rs:28-32 | history.ts:57 | CRLF 结尾的 `~/.pie/history` → TS 条目带尾随 `\r`，污染 `/history` 输出并破坏相邻去重 |

### minor（同批处理）
- `PIE_DIR` 波浪号：oracle `config.rs:10-17` 用 `PathBuf::from(p)` **不做**展开；TS `config.ts:486-489` 走 `expandTildePath`。`PIE_DIR=~/piehome` 未经 shell 展开时两侧解析到不同目录。

## UNSURE（记录，不改）

1. `trigger_sidecar_path_for_session`/`cron_sidecar_path_for_session`（mod.rs:38-52,60-74）无 TS 对应；其 fallback（metadata 无 path → `<root>/<id>.triggers.json`）未移植。内存态 SessionManager 下无定义路径，可达性取决于 phase 13 接线。
2. `findSessionPathById` 用有界头部读，oracle `find_session_path` 做全量 `repo.open`：oracle 的 `--resume-id` 会因目录中**任一**更早排序的损坏 session 而失败，TS 不会。文件内有 B8 范围说明，读作有意决策。
3. `commitImport` 用 `loadEntriesFromFile`（仅逐行 JSON 解析）把关，oracle `session_archive.rs:461-465` 做 `repo.open → build_context()` 全图重放。TS 的暂存门更弱，但举不出具体反例。
4. `readTarArchive`（:243-266）把全零块当"跳过继续"而非归档结束，且不校验头部校验和；终止符之后追加的字节会被继续解析。手写 tar 在文件头已自陈局限。
5. `manifest.source.session_path`：oracle 用 transcript 内记录的 `metadata.path`，TS 用调用方传入的 `sessionPath`。pi 的 `SessionHeader` 无 `path` 字段，无替代方案。

## OK
- `export.rs` → `export.ts`：逐项核对通过。另澄清两点：工具调用参数**键序**一致（oracle 虽在 coding-agent 声明普通 serde_json，但 agent/ai crate 开了 `preserve_order`，cargo 工作区特性统一 → Map 保插入序，同 `JSON.stringify`）；`AgentMessage::Custom` 渲染差异因 TS 联合类型无 `payload` 字段而无解，文件内已注明。仅一处文案 nit：oracle 的 IO 错误带 `create exports dir {}` / `write {}` 上下文，TS 透传原始 fs 错误。
