# Operating manual — pie-typescript migration repo

本仓库唯一目标：把 pie（Rust @0a120dfd）完整重写为 TypeScript。方法论 = Anthropic code migration kit（vendored 于 `migration-kit/`）六步法的 redesign 变体。**在本仓做任何迁移相关工作前先读本文件与 `migration/RULEBOOK.md`。**

## 布局

| 路径 | 用途 |
|---|---|
| `packages/{ai,agent,coding-agent,tui}` | TS 骨架（pi@4868222e vendor，包名 @pie/*）+ 迁移落地区 |
| `packages/mcp` | pie 独有 crate 的纯 port（phase 6 起） |
| `workers/fefe-hub` | 自 pie oracle 复用（上游即 TS） |
| `migration/RULEBOOK.md` | 翻译规则唯一事实源；loop 内只读 |
| `migration/manifest.tsv` | 工作队列；输出文件存在 + status=done = 完成 |
| `migration/depmap/` · `inventory.tsv` | 依赖图 · gap 清单 |
| `migration/parity/` | 双运行差分 judge（oracle vs TS） |
| `migration/reviews/<slice>/` | 对抗性 review findings 闭环记录 |
| `migration/sources.env` | 四个上游 SHA + 本地路径（不可漂移） |
| `PROVENANCE.md` / `NOTICE` | 谱系与 license 链 |

## Standing rules（kit CLAUDE.md 八条的本仓适配，覆盖便利性）

1. **RULEBOOK 在任何 loop 内只读。** 修订排队，在 phase 边界应用并记入其 Deviation log。
2. **队列落盘。** 完成判定 = manifest 行的 out_path 文件存在且 status=done。禁止只在对话里记状态。
3. **Phase 边界即 gate。** 每 phase 以 SUPERGOAL_PHASE_VERIFY 证据块收尾；证据不足不得推进。
4. **Reviewer 对抗、分离、只读。** 每翻译单元 2 个 reviewer（一对照 Rust 源、一对照 RULEBOOK），分歧第三者裁决（默认 not-confirmed），fixer 只改 confirmed findings。
5. **禁令由配置执行。** `.claude/settings.json` deny 破坏性 git 与 cargo；被 deny 挡住说明设计在起作用——上报，不绕行。tsc/vitest 已按 Step 4 dissolve 放行进循环。
6. **复发失败上移。** 同类失败第三次：停修实例，改 rule，重生成受影响单元。
7. **老代码是 spec。** oracle（Rust pie）保持可运行；TS 测试失败先在 oracle 复跑分类 regression/inherited/environment；禁止删测/弱化断言换绿。缺陷行为 bug-for-bug 复刻并标 `BUG(port):`，修复只进 post-parity phase。
8. **UNKNOWN 是合法答案。** 规则未覆盖 → 最保守翻译 + `TODO(port):` + 继续。

## 常用命令

- `npm run build` / `npm test` / `npm run check` — 构建 / 全测 / lint+typecheck
- `bash migration/parity/run-parity.sh [--scenarios S1,...]` — 双运行差分
- oracle 操作一律走 `migration/parity/*.sh` 封装（外部 checkout，cargo 在本仓被 deny）

## 上游文档

- 骨架行为参考：pi 仓库文档（vendored README/docs）
- oracle 行为参考：`$ORACLE_PIE_DIR`（见 sources.env）的 README/docs/源码——**它是行为合同，不是本仓代码**
