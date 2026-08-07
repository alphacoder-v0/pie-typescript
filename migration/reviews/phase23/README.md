# phase23 —— 第五轮（收尾轮）：证据无死角 513/513

the fifth round，11 phases。

## 判定标准（用户选定）

**oracle 的 513 个公开函数每一个都有行为证据**：
`existing-test`（指向真断言行）/ `new-test`（本轮新写）/ **已逐条论证的**不可移植裁定。

**不补 oracle 有而本仓没有的功能** —— 真能力缺口只论证与记录。

## 文件

| 文件 | 内容 |
|---|---|
| `closeout.md` | **本轮总结**。先读这个 |
| `roster.tsv` | 513 条名册（514 行）。`oracle_file / fn_name / oracle_line / source / rule_hit / batch` |
| `evidence.tsv` | 513 条证据（514 行）。`fn_name / evidence_kind / evidence / anchor` |
| `probe-calibration.md` | 三步核探针的**期望值**——写于脚本存在之前 |
| `probe-{notportable,unmatched40,F,G,H}.tsv` | 探针对各批产出的「TS 文件 / 行数 / 导出面」三元组 |
| `reaudit-notportable.md` | 60 条 `not-portable` 二次裁定（**改判 7 条，误判率 11.7%**）|
| `unmatched-40.md` | 40 条 surface-coverage 未匹配的裁定 + **双向误差量化** |
| `batch-f.md` · `batch-g.md` · `batch-h.md` | 146 条 low 层未捞出的裁定，按包分批 |

## 名册的分区

| 批 | 来源 | 条数 |
|---|---|---|
| `HIGH` | 第三轮 high 层 | 45 |
| `A`–`E2` | 第四轮 medium + low 捞出 | 282 |
| `U` | **本轮**：`check:surface-coverage` 报的未匹配 | 40 |
| `F` / `G` / `H` | **本轮**：low 层未被判据 B∪C∪D 捞出，按包分 | 58 / 52 / 36 |
| | **合计** | **513** |

分区互斥已实测：`45+149+279 = 473`（`phase21/risk-tiers.tsv` 全集），`473+40 = 513`，
`40 ∩ risk-tiers = 0`。

## 关键工具

- `scripts/build-roster-513.mjs` —— 把两张形态不同的证据表（high 45 条无行号 /
  phase22 282 条有行号）与 186 条待办并成一张。**从 oracle 源码重新扫描**，
  用与 `check-surface-coverage.mjs` 逐字相同的规则，保证 513 两边一致。
- `scripts/probe-ts-counterpart.mjs` —— **查文件与行数，不查符号名**。
  `run_web` 的误判（6 行占位与 1715 行完整实现给出相同的符号名信号）催生了它。
- `scripts/check-behavior-evidence.mjs` —— 门禁，终态 `ROSTER_SIZE=513` +
  `REQUIRE_COMPLETE=true`。

## ⚠ 513/513 不意味着什么

见 `closeout.md` §5。三条边界：**它是函数层不是行为层**（oracle 541 条内联测试仍有
92 条未被本仓测试语料提及）；**144 条不可移植里有 4 条是真能力缺口**（AWS Bedrock
二进制帧未移植）；**live provider 与性能仍无门禁**。
