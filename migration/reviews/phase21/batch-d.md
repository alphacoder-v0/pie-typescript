# 批次 D — 会话归档与恢复（13 条）

`session_archive.rs` 7 · `resume_picker.rs` 5 · `agent_session.rs` 1。

**分布：covered 8 · not-portable 1 · gap 4。**

## 两条数据安全项（spec 规定不接受 not-portable）

| oracle 测试 | verdict | evidence | 那一行断言了什么 |
|---|---|---|---|
| `export_refuses_to_overwrite_existing_output` | covered | `session-archive.test.ts:188` | `rejects.toThrow(/exists/)`；:189 还断言**原有字节未被改动**——比 oracle 强 |
| `failed_sidecar_write_cleans_up_partial_import` | **gap → 已移植** | `ported/session-archive-batch-d.test.ts` | 见下 |

`failed_sidecar_write_cleans_up_partial_import` 此前没有对应断言。`session-archive.test.ts:323`/`:341`
覆盖的是 **schema 校验中止**——那发生在任何写之前，所以「已写成功的 sidecar 要不要删」这一问
根本不会被触发。oracle 那条让**写本身**中途失败（在 cron sidecar 路径上放一个目录），断言三件事：
无孤儿会话、无 `.tmp`、**先写成功的 trigger sidecar 也要被删掉**。

移植时的一处适配：`importSession` 每次用新的 `uuidv7()` 作会话 id，无法预置目标路径。
改用 sidecar 的**父目录**做拦截点（`chmod 0o555`），三条否定断言合并为一句
「失败的导入不得在目标目录留下任何文件」——等价且更严。

## 逐条裁定

### session_archive.rs（7）

| oracle 测试 | verdict | evidence / 理由 |
|---|---|---|
| `export_refuses_to_overwrite_existing_output` | covered | `session-archive.test.ts:188` |
| `import_records_source_provenance_in_metadata` | covered | `:85` —— `importedFrom` 的 sessionId/cwd/exportedAt/pieVersion 四字段 :85-88 |
| `import_summary_records_originally_enabled_automation_and_activates_it` | covered | `:247` —— originallyEnabledTriggers/Cron :247-248，激活侧 :252 |
| `export_manifest_uses_last_entry_as_leaf_without_explicit_leaf_row` | **gap** | `:456` 用的是**单条目**会话，区分不了「最后一条」与「唯一一条」 → 移植为两条目会话 |
| `import_rejects_manifest_active_leaf_that_does_not_match_session_jsonl` | **gap** | `:175` 测的是 **checksum** 不匹配（内容被改过）；这条是 manifest 与 jsonl 算出的 leaf 不一致，走 `validateArchiveContent` 里另一个分支 |
| `failed_sidecar_write_cleans_up_partial_import` | **gap** | 见上 |
| `export_manifest_uses_explicit_leaf_target_not_leaf_row_id` | **not-portable** | 见下 |

### resume_picker.rs（5）—— 全部 covered

manifest 把它映到 `cli/session-picker.ts`。`session-picker.test.ts` 逐条对应：
`:42` `:49` `:85` `:103` `:181`。

### agent_session.rs（1）

`retryable_patterns_match_ts_regex` → **gap**。`isRetryableErrorMessage` 零直接测试；
`suite/agent-session-retry-events.test.ts` 只把 `"overloaded_error"` 当**夹具**用，没有断言过模式表本身。
移植后照抄 oracle 的 8 条正例 + 3 条否定。否定那三条才是重点：把 `Unauthorized` /
`model not found` / `bad request` 判成可重试，等于对着一个永远不会好的错误反复烧钱和时间。

## 一次误判，被 tsgo 当场驳回

`export_manifest_uses_explicit_leaf_target_not_leaf_row_id` 我一度判成**真实缺陷**并改了
`session-archive.ts`：`parseSessionJsonl` 是无条件 `activeLeafId = entry.id`，而 oracle 是
`Leaf { target_id } => target_id.clone()`；`@pie/agent` 的 `jsonl-storage.ts:347` 确实会写
`{"type":"leaf", targetId:…}` 行，看起来严丝合缝。

**`npm run check` 里的 `tsgo` 报了 TS2367**：`SessionEntry` 联合与 `"leaf"` 没有交集。

查下去才发现判错了：`.piesession` 读的是 **pi `SessionManager` 格式**，其 `SessionEntry` 联合
（`session-manager.ts:157-166`）根本没有 `leaf` 变体——leaf 是**从 parentId 树推导**的，不写标记行。
`@pie/agent` 的 `LeafEntry` 属于另一套存储格式，这个归档从不读它。`session-archive.ts` 文件头的
适配说明 1 本来就写明了这件事，是我没先读完就动手。

已撤销 src 改动，改判 **not-portable**，并把「为什么不能加这个分支」写进了那段代码的注释——
下一个人不必再走一遍。

**这次是类型检查器挡住了一个会被我写进报告的错误结论。** 它也说明为什么 `npm run check`
必须是每个 phase 的强制命令，而不是最后跑一次。

## 抽查（判据 4）

**抽样规则先于结果确定**：batch=D 且 verdict=covered 的行按台账行号升序编号 1..8，
取编号 ≡ 0 (mod 3) → 3、6；不足 5 条依次补末尾未选中的 → 8、7、5。
抽查数 = `max(5, ⌈8/3⌉)` = 5。抽中 **#3 #5 #6 #7 #8**。

| # | oracle 断言 | TS 断言 |
|---|---|---|
| 3 | `export_session(...).await.unwrap_err()`（目标已存在时拒绝） | `await expect(exportSession(sourcePath, archive, false)).rejects.toThrow(/exists/)` |
| 5 | `assert_eq!(origin["sessionId"], summary.session_id)` | `expect(importedHeader.importedFrom.sessionId).toBe(exportSummary.sessionId)` |
| 6 | `assert_eq!(summary.originally_enabled_triggers, vec!["was-enabled"])` | `expect(imported.originallyEnabledTriggers).toEqual(["was-enabled"])` |
| 7 | `assert_eq!(window(0, 5, 10), (0, 5))` | `expect(visibleWindow(0, 5, 10)).toEqual({ start: 0, end: 5 })` |
| 8 | `assert_eq!(key_action(Key::Up), Action::Up)` | `expect(keyAction(key("up"))).toBe("up")` |

门禁新增的「evidence 必须是断言行」规则让本批**一次通过**，无需事后修正——上一批的规则升级
立刻见效。全局去重复核：57 条 covered → 57 个各异 evidence 行，无重复。

## 负控

误判期间做过一次变异（把 leaf 分支短路回「无条件取 entry.id」），当时两条 leaf 用例转红；
误判撤销后那两条用例已随之删除，此处仅记录当时的观测，不作为现行证据。

现行 4 条移植测试各自的守护面互不重叠，共用一次全量回归作对照：`session-archive.test.ts`
既有 19 条与新增 4 条同跑，**24 条全绿**，说明新增断言没有与既有断言互相掩护。

## 密闭性（判据 3）—— 顺带查出一个既存泄漏

本批移植的测试全部走 `mkdtemp`，实测**零写入**真实 `~/.pie/sessions`：

```
本轮 7 个新测试文件：跑前 3634 → 跑后 3634  （差 0）
```

但按判据 3 逐字核对 `~/.pie` 时发现：**跑一次 `bash test.sh`，真实 `~/.pie/sessions/` 会多出
十几个会话文件**（已累积 3634 个）。

归因：测试把 **cwd** 隔离到了 `/tmp/pi-runtime-*`，但**存储根没隔离**——`SessionManager` 的
存储根来自 `getAgentDir()`，也就是真实 `$HOME/.pie`，再按 cwd 哈希分目录。泄漏文件的首行自证
（cwd 是临时目录，path 却在真实目录下）：

```json
{"id":"<uuidv7>","createdAt":"2026-08-05T20:32:05.948Z",
 "cwd":"/tmp/pi-runtime-events-<epoch>-<rand>",
 "path":"/home/<user>/.pie/sessions/<cwd-hash>/<uuidv7>.jsonl"}
```

**这不是本轮引入的**（3634 个文件跨越了很多轮），但它直接违反本轮的硬约束「绝不读写真实 `~/.pie/`」。

做了一次有界实验：在 `test.sh` 里 `export PIE_DIR="$(mktemp -d)"`。

| | 结果 |
|---|---|
| 泄漏 | **堵住** —— 真实 `~/.pie/sessions` 0 新增 |
| 代价 | **12 条测试红**，分布在 4 个文件：`package-command-paths.test.ts`、`theme-export.test.ts`、`suite/regressions/2791-fswatch-error-crash.test.ts` 等 |

那 12 条依赖真实 `~/.pie` 下的 `bin/` 与主题文件，各自需要自己的夹具。**不是一行修复，超出本 phase
范围**，实验已还原（`test.sh` 与备份逐字节一致，套件恢复 4309 全绿）。

留给 phase 10 / MIGRATION-REPORT §5 作为一条**新的开放边界**：
「密闭测试入口仍向真实 `~/.pie/sessions` 写入；堵住它需要先给 4 个文件的 12 条测试补夹具。」

## 命令与结果

```
node scripts/check-triage-ledger.mjs   OK — 批次 D 剩余 TODO 0（covered 8 · not-portable 1 · gap 4）
npm run check                          exit 0（9 道门禁；误判那次它是 exit 2，见上）
bash test.sh                           exit 0 — 4309 passed / 0 failed
                                       （agent 450 · ai 484 · coding-agent 2700 · mcp 46 · tui 612 · workers 17）
                                       批次 C 后 4305 → +4
```
