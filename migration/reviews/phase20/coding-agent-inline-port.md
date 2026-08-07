# phase 20-5 · 移植 oracle `crates/coding-agent` 核心内联单测

## 1. 去重方法本身在这一批被修正了

第一轮按 oracle 测试名（下划线形式）grep，得 397 总数 / 196 已引用 / **201 未引用**。

但读 `builtin-skills.test.ts` 时发现：本仓的 it 名是 oracle 测试名的**逐字散文化翻译**——
`available_names_is_sorted_and_contains_karpathy` 写作 `"available names is sorted and contains karpathy"`。
下划线形式的 grep 一条都匹配不上，于是 19 条全被误判为缺口。

改用**归一化去重**（两侧都做 `[^a-z0-9]+ → 空格` 再做子串匹配）重算：

```
201  下划线 grep 判为未引用
-39  归一化后匹配上（builtin_skills 19→2 是最大一块）
────
162  仍未匹配
```

按 ROADMAP 的 phase 5/6 切分：

| | 实测 | ROADMAP |
|---|---|---|
| UI / tools / session（phase 6） | 51 | 51 ✓ |
| 核心（phase 5） | 116 | 143 |

phase 6 那侧完全吻合。核心侧 116 < 143，差额来自上面那 39 条归一化后新认定的覆盖
（ROADMAP 的 143 是按下划线 grep 得出的口径）。**六个点名文件的条数 20/19/13/11/11/10
与 ROADMAP 逐个一致**，说明文件分类正确，差额只出在总数口径。

**这条方法学教训应当记住**：按名字去重在 `crates/ai` 里假阴性还算少，到了 coding-agent
就成了主要误差源——因为这个包的 TS 测试是照着 oracle 一条条翻译过来的。

## 2. 六个点名文件的覆盖状况

| 文件 | 条数 | 已覆盖 | 本次移植 | 未移植（及理由） |
|---|---|---|---|---|
| `builtin_skills.rs` | 19 | 17（`builtin-skills.test.ts:16-180`，逐条散文翻译） | — | 2（frontmatter 剥离的边界，已由 :189-211 六条更细的用例覆盖） |
| `commands.rs` | 20 | 5（`ported/commands.test.ts:19/:27/:35/:95/:105`） | **2**（不得泄密两条） | 13（`/model` 目录渲染、trigger 状态渲染、skill 来源标签等，均为渲染细节，无安全含义） |
| `main.rs` | 13 | 8（`cli-state-surfaces.test.ts` F1–F14 覆盖 ui 模式、resume 标志、trigger 轮询间隔等） | — | 3 条 auth wrapper：**TS 结构不同**，oracle 的 `apply_auth_to_simple_options` 在本仓对应 `preflightAuth` 机制，差异已在 `agent-session.ts:330-346` 长注释里记录 |
| `skills_state.rs` | 11 | 7（`set-skill-state-tool.test.ts:64/:73/:119` 等覆盖 overlay 读写与 source 感知） | — | 4（磁盘 round-trip 细节） |
| `local_models.rs` | 11 | 9（`local-models.test.ts:92-243`，含 fails-closed、project 覆盖 user、别名等） | **1**（ds4 凭据作用域的否定半边） | 1（fixture 流式，需本地 SSE + 模型注册，成本高、无安全含义） |
| `session_archive.rs` | 10 | 7（`session-archive.test.ts`，含 :180 拒绝覆盖已有输出） | **1**（路径穿越校验） | 2（manifest leaf 选取细节） |

**六个文件全部有覆盖**，无一为零。

## 3. 本次移植的 4 条（+3 条负控）

选取标准是**安全与数据丢失**，不是凑数：

| oracle `#[test]` | 为什么选它 | 落点 |
|---|---|---|
| `model_help_summary_lists_builtin_providers_without_secrets` | `/model` 帮助出现 `API_KEY` / `auth.json` 就把凭据来源暴露给任何跑 `--help` 的人，包括 CI 日志 | `ported/commands-no-secret-leak.test.ts` |
| `collect_trigger_audit_rows_uses_preview_safe_fields_only` | `evaluator_decision.raw_payload` 是外部系统送来的原始载荷，可能含密钥或个人数据 | 同上 |
| `rejects_unsafe_archive_paths` | 归档是外部输入；路径不校验就是 zip-slip | `ported/archive-path-and-ds4-scope.test.ts` |
| `ds4_..._fails_closed_without_ds4_env_even_when_openai_env_exists` | ds4 走 openai-responses 家族，「顺手回落到 OPENAI_API_KEY」是很自然的实现滑坡——那等于把用户的 OpenAI 密钥发给第三方端点 | 同上 |

后两条各自带一个**同文件内的负控**（把哨兵串放进预览安全字段必须出现；DS4_API_KEY 在场必须解析得出），
防止否定断言因为「什么都没渲染 / 压根没接上」而假通过。

## 4. 「一上来就红」

**归类为实现缺陷的：0 条。** 4 条移植测试全部一次通过。

`validateArchivePath` 为可测性从模块私有改为 `export`（纯函数，无行为改动）——oracle 也是直接测它。

## 5. 负控（两条变异式 + 两条内建，全部实测）

| # | 变异 | 结果 |
|---|---|---|
| 1 | `validateArchivePath` 不再拒绝 `..` 与 `.` | `expected [Function] to throw an error` ×2 **红** |
| 2 | 审计行把整个 `evaluator_decision` 塞进 `details` | `expected '…' not to contain 'must-not-render'` **红** |

变异脚本均带 `assert` 确认落地。内建的两条见 §3。

## 6. 工程检查

```
npm run build   成功
npm run check   7 道门禁全绿
bash test.sh    exit 0；合计 4242 passed / 0 failed
                （agent 450 + ai 484 + coding-agent 2641 + mcp 38 + tui 612 + workers 17）
```

coding-agent 包 2634 → **2641**，正好是本 phase 新增的 7 条（4 条移植 + 3 条负控/补充）。

## 7. 诚实边界

核心侧 116 条里本次只移植了 4 条。**这不是把剩下 112 条都判定为已覆盖**——§2 的表里逐文件
写明了哪些已覆盖、哪些未移植及理由。未移植的绝大多数是渲染细节（帮助文本排版、状态摘要措辞、
枚举标签映射），它们的行为差异后果是「显示得不一样」，而本次的选取标准是安全与数据丢失。

若日后要把这批补齐，入口是 §1 的归一化去重方法：枚举 oracle `#[cfg(test)]` 块内的
`#[test]` / `#[tokio::test]` 函数名，两侧归一化后子串匹配，未命中的逐条读测试体裁定。
