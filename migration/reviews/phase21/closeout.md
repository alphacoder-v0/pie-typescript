# 本轮收口（supergoal `pie-112-1vuLwY`，10 phases）

立项时要收的三件事，全部有结论。**不留「回头再看」。**

上一轮的收口在 `migration/reviews/phase20/closeout.md`；本文件只写本轮。

---

## 1. 三个计数的前后对照

| 门禁 | 立项时 | 现在 | 变化 |
|---|---|---|---|
| `check:manifest`（文件层） | 204/204，missing 0 | 204/204，missing 0 | 持平（本来就满） |
| `check:surface-coverage`（签名层） | 未匹配 40 / 513 | 未匹配 40 / 513 | **不变** |
| `check:inline-test-ports`（行为层） | 未匹配 219 / 541 | 未匹配 **190** / 541 | **−29** |
| `check:triage-ledger`（裁定层） | 不存在 | 121 条，TODO 0 | **新增** |

### 为什么 `surface-coverage` 一条没降

这个门禁按**函数名**匹配。本轮没有移植任何新函数——G2 的产出是给 473 个「只验证了名字」
的函数**分层并补行为证据**，不是新增实现。40 这个数字要降，只能靠移植新函数或改名匹配规则，
两者本轮都不该做。**持平是正确结果，不是停滞。**

### 为什么 `inline-test-ports` 只降 29 而不是 121

这是本轮最容易被误读的数字，值得说清楚：

121 条的裁定分布是 **covered 83 · not-portable 4 · gap 34**。

- **covered 83 条不会让这个数字动**——它们的定义就是「oracle 测试名没匹配上，但那个行为
  在 TS 侧有具体断言覆盖」。名字仍然不匹配，计数当然不降。
- **not-portable 4 条也不会动**——它们本来就不该有对应物。
- **只有 gap 34 条**在移植后，其测试体提及了 oracle 测试名，才离开未匹配集合。

29 < 34，差额来自若干条 gap 合并进同一个测试用例（一个用例覆盖多条同源 oracle 断言）。

**结论：这个计数不能当移植质量的唯一读数。** 它测的是「名字对得上」，
而本轮 83 条 covered 恰恰证明了「名字对不上 ≠ 行为没覆盖」。裁定台账
（`check:triage-ledger`）才是这一层的真读数——而它现在是 121/121，TODO 0。

---

## 2. 121 条裁定的总分布与去向

| 裁定 | 条数 | 去向 |
|---|---|---|
| `covered` | 83 | 每条给出 TS 具体**断言行**行号；门禁强制那一行必须含 `expect(` 或 `assert` |
| `not-portable` | 4 | 每条给出 ≥20 字的理由（Rust 类型系统特性 / pi 骨架无对应联合分支等） |
| `gap` | 34 | 全部移植，分布在 8 个新测试文件里，每条配负控 |

**无第四类**，这是立项时定的硬约束，做到了。

裁定过程本身查出的两个**真实用户可见缺陷**：

1. **`/model` 看不见 models.json 声明的模型**（phase 2）。oracle 的 `get_model` 先查自定义注册表
   再查内置表（`models.rs:23-32`），TS 侧只查内置。修复：`mergedModels()` 自定义在前。
2. **密闭测试入口向真实 `~/.pie/sessions/` 写入**（phase 5）。已累积 3634 个文件。
   一行 `PIE_DIR` 可堵但会红 12 条测试，记为第四条边界（见 `open-boundaries.md`）。

两个都不是「读源码读出来的」，是**写 oracle 忠实断言时撞出来的**。

---

## 3. 风险分层与 high 层覆盖

473 个「只验证了名字」的函数，按四条规则分层（分类器 `scripts/classify-surface-risk.mjs`，
两次运行字节一致，确定性已证）：

| 层 | 数量 | 处置 |
|---|---|---|
| high | 45 | **100% 行为证据**（46 行证据表，逐个指向具体断言或 parity 场景） |
| medium | 149 | 记录，不本轮补 |
| low | 279 | 记录，不本轮补 |

分类器调过两次（记在 `risk-tiering.md`）：`credential` 按文件粒度匹配命中 290 个（high 曾达 336），
`token` 裸匹配吃掉 `CancellationToken`，`auth` 裸匹配吃掉 `author`，`parity-path` 按模块粒度命中 81。
两次收紧都写明了理由——**收紧规则不等于放低标准**，前提是每次收紧都能说清「被排除的那些为什么不该算」。

---

## 4. 三条边界的最终状态

| 边界 | 状态 | 今日重估答案 |
|---|---|---|
| `--builtin-skill` 未并入 skill loader | **已关闭** | — |
| live provider 不进门禁 | **维持现状** | 「近 90 天 ≥2 次不兼容协议变更」→ **否** |
| 性能无公平基准 | **维持现状** | 「真实抱怨 或 自测劣化 ≥50%」→ **否** |
| （新记）测试写真实 `~/.pie/sessions/` | **记录，本轮不修** | 「12 条测试已各自有夹具」→ **否**（0/12） |

每条重估入口都写成了**今天就能回答是/否的条件**，并当场作答。写成「以后再评估」正是前两条
在报告里挂了两轮的原因。

---

## 5. 改动规模

| 类别 | 数量 |
|---|---|
| `src` 触碰文件 | 7（`slash-dispatch-session.ts` · `session-archive.ts` · `builtin-skills.ts` · `tools/skill.ts` · `core/skills.ts` · `core/resource-loader.ts` · `main.ts`） |
| 新增测试文件 | 9 |
| 新增测试用例（新文件） | 45 |
| 套件总数 | 4273 → **4319**（+46，只增不减） |
| 新增门禁脚本 | 2（`check-triage-ledger.mjs` 391 行 · `classify-surface-risk.mjs` 269 行） |
| 新增裁定/分层数据 | `triage-ledger.tsv` 122 行 · `risk-tiers.tsv` 474 行 · `high-tier-evidence.tsv` 46 行 |
| 新增文档 | `migration/reviews/phase21/` 13 个文件 |

`src` 的**净行为改动只有两处**：phase 2 的 `mergedModels()`（真缺陷修复）与 phase 9 的
内置技能接线。其余全是测试、门禁、文档与注释。

---

## 6. 本轮新增的声明偏离

**无。** D1–D13 不变，`BUG(port)` 台账 B1–B18 不变。

phase 9 的接线有一处结构性差异（合并点在 `refreshSkills()` 而非 harness 构造），
但**行为等价**——由端到端探针（A/B/C/D/E 五路）与 6 条单测共同证明，不构成偏离。

---

## 7. 两次「同型错误」的记录

本轮踩了**同一个坑两次**，值得单独记：

> **注册表的价值等于读它的消费方集合。**

- phase 2：`/model` 只读内置模型表，看不见 `models.json` 注册的模型。
- phase 9：`--builtin-skill` 把解析结果发布进注册表，但改的是 `tools/skill.ts` 的
  `loadEffectiveSkills`——而 `/skills`、启动行、系统提示目录读的全是
  `ResourceLoader.getSkills()`。build 干净、测试全绿、功能静默无效。

第二次是在**端到端探针**下暴露的，不是单测。所以 `builtin-skill-wiring.test.ts` 的
全部断言都打在 `ResourceLoader.getSkills()` 上——断言 `enabledBuiltinSkills()` 的写法
在坏版本上照样绿。

这条已写进 phase 9 的记录与 `open-boundaries.md`。**下次新增任何注册表，先列消费方清单。**

---

## 8. 全链验证

```
npm ci                                   exit 0
npm run build                            exit 0
npm run check                            exit 0（9 道门禁）
bash test.sh                             exit 0 — 4319 passed / 0 failed
                                         agent 450 · ai 488 · coding-agent 2706
                                         · mcp 46 · tui 612 · workers 17
bash migration/parity/run-parity.sh      exit 1（预期）— 差异集恰等于声明基线 8 项
                                         S3/requests 2 · S3/run 8 · S3/session 12
                                         · S5/req2body 2 · S6/session 24
                                         · S8/list 2 · S8/resumeerr 2 · S8/resumeexit 2
                                         S1/S2/S4/S7 与 S9–S12 全 DIFF 0
bash migration/parity/run-parity.sh --self-check
                                         exit 0 — MUTATIONS DETECTED: 3/3
npm run test:live                        exit 1 — 1 failed / 3713 passed
                                         唯一失败归类 environment（见下）
```

`test:live` 的唯一失败：`context-overflow.test.ts` 的 Gemini 用例。
依据是**实际收到的响应**——`code: 429, "You exceeded your current quota"`，而非用例期待的
`input token count … exceeds the maximum`。该用例要求「账号配额 > 模型上下文窗口」，
本账号不满足，429 必然先到。**不是 regression，不是 inherited。**
在场凭据仅 `GEMINI_API_KEY`（另有 `~/.sf-key`，0600）——**只报变量名，值从未打印**。

清洁度：本轮新增行中 `console.log` / `FIXME` / `XXX` / `HACK` / `@ts-ignore` /
`eslint-disable` 计数**全部为 0**。（`main.ts` 里现存的 11 处 `console.log` 中 6 处是注释里
提及该 API、5 处是既有的用户可见 CLI 输出，均非本轮新增。）
