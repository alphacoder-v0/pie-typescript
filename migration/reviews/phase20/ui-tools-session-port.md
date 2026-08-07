# phase 20-6 · 移植 oracle UI / tools / session 内联单测

## 1. 去重

沿用 phase 5 修正后的归一化方法（两侧 `[^a-z0-9]+ → 空格` 后子串匹配）：

| | 下划线 grep | 归一化后 |
|---|---|---|
| `ui/mod.rs` | 33 | **28** |
| `tools/*.rs` | 11 | 11 |
| `session/mod.rs` | 7 | 7 |
| 合计 | 51（= ROADMAP 的上界） | **46** |

差额 5 全部出在 `ui/mod.rs`——同 phase 5 的原因：TS 用散文命名。

## 2. 逐条裁定

### 2.1 `ui/mod.rs` 28 条：27 条已覆盖

`packages/coding-agent/test/ported/ui-app.test.ts` **本来就是 `ui/mod.rs` 的刻意移植**，
每个 `it` 都标注了精确的 `mod.rs:NNNN-NNNN` 行号区间，只是用散文命名，所以按名字去重看不见。
逐条对上（括号内是 TS 行号）：

宽/窄布局 5 条（:297 / :328 / :347 / :368 / :396）· 输入框与状态栏 4 条（:271 / :285 / :502 / :509）·
键与滚动 3 条（:457 / :485 / :841）· 队列 2 条（:533 / :551）· 图片附件 6 条（:611 / :619 / :631 / :639 / :650 / :676）·
脱敏与错误文案 2 条（:385 / :696）· 控制面板卡片 2 条（:744 / :760）· 补全 1 条（:442）·
转录重放 2 条（:861 / :883）· cron 面板 1 条（:406）。

**唯一未匹配**：`finished_turn_refreshes_goal_panel_state`。TS 全仓搜 goal panel 零命中——
本仓对应面在 `ui-app.test.ts` 的 turn queue 段里只断言了计数刷新（:571），没有断言 goal 面板本身。
**记为已知缺口，未移植**（纯渲染状态，无安全含义）。

### 2.2 `tools/*.rs` 11 条：9 条已覆盖，**2 条暴露实现缺口**

已覆盖：`edit` 3 条（`tools.test.ts:342` / `:408` / `:585`）· `find` 3 条（:1026 / :1046 / :1081）·
`grep finds_matches_in_file_tree`（:958）· `bash ok_path_still_works`（:604）·
`skill disabled_skill_refuses_body_via_steering_path`（`skill-tool.test.ts:88` 明确引用了该测试名）。

**缺口两条，见 §3。**

### 2.3 `session/mod.rs` 7 条：全部已覆盖

`session-manager/pie-session-helpers.test.ts`：sidecar 路径 :45 / :52 · 删除 :194 ·
legacy id 匹配 :160 · 无 id 恢复取最近 :181。

## 3. 本 phase 的实质发现：grep 长匹配行会把匹配本身切掉

`truncates_very_long_matching_lines` 与 `long_line_preview_keeps_late_match_visible`
不只是缺测试，是**缺实现**。

本仓的 `truncateLine` 原本是朴素头部截断：

```ts
return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
```

当匹配出现在第 500 个字符之后——压缩过的 JS、长日志行、单行 JSON 都很常见——
模型拿到的 500 个字符里**根本不含那个匹配**。grep 报告「这里有匹配」，然后给出一段
看不到匹配的文本。那不是少给信息，是误导。

负控实测的报错正是这个 bug 的原貌：

```
→ expected 'grep: 1 hits\na.txt:1: prefixprefixpr…' to contain 'NEEDLE'
```

**处置：按 `grep.rs:158-192` (`preview_match_line`) 实现围绕匹配开窗。** 预算先留给匹配本身
（`min(matchLen, maxChars)`），剩下的一半给前文一半给后文；被切掉的那一侧加方向正确的标记
（`[line truncated]...` 前切 / `...[line truncated]` 后切）。`matchRange` 缺省时退回头部截断，
对应 oracle 的 `match_range: None` 分支。两个调用点（`grep.ts` 的上下文块与单行输出）都接了匹配位置。

## 4. 顺带修掉的一个**间歇性**回归——由完整 test.sh 抓出

phase 3 我把 `parse_callback` / `parse_callback_no_query` 放进了
`ported/oracle-inline-provider-misc.test.ts`。它们要驱动 `loginAnthropic`，而后者绑定**固定端口
53692**——`anthropic-oauth.test.ts` 用的是同一个端口。vitest 并行跑不同文件就会
`EADDRINUSE`；`describe.sequential` 只在文件内串行，跨文件不管用。

phase 3/4/5 的全量 `test.sh` 都恰好没撞上（调度顺序决定），phase 6 撞上了，5 个用例同时红。
**间歇性失败比确定性失败更糟**，因为它会训练人去重跑而不是去查。

处置：把那两条迁进 `anthropic-oauth.test.ts`，与其余占用该端口的用例同处一个
`describe.sequential`；原处留下说明。**连跑 ai 包 6 次，6/6 通过。**

顺带修了两个类型错误（phase 4 的 `timeoutSecs` 应为 `timeout`(ms)；phase 5 的
`SessionTreeEntry` 不是 session-manager 的导出名）——此前我在读 `npm run check` 输出时
只 grep 了 `^error` 前缀，漏看了 tsgo 行首带路径的报错格式。

## 5. 负控（实测）

| # | 变异 | 结果 |
|---|---|---|
| 1 | `truncateLine` 忽略 `matchRange`，退回朴素头部截断 | 2 条红：`to contain 'NEEDLE'` / `to contain 'ZZZ'` |

变异脚本带 `assert` 确认落地。另有三条**单元语义**断言（短行原样、无匹配位置退回头部、
窗口内容不超预算）作为形状护栏。

## 6. 工程检查

```
npm run build   成功
npm run check   7 道门禁全绿
bash test.sh    exit 0；合计 4247 passed / 0 failed
                （agent 450 + ai 484 + coding-agent 2646 + mcp 38 + tui 612 + workers 17）
```

## 7. 诚实边界

46 条里移植 2 条（那两条正是唯一的实现缺口），43 条经逐条比对判定为已覆盖并给出了 TS 行号，
1 条（`finished_turn_refreshes_goal_panel_state`）记为已知缺口未移植。
`ui/mod.rs` 那 27 条的「已覆盖」结论强度较高——`ui-app.test.ts` 每条都标了 oracle 行号区间，
是可核对的对应关系，不是主观判断。
