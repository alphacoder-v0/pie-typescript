# Pilot A（openai-responses diff-port + retry port）review 闭环

## A1（对照 Rust 源）5 findings
| id | sev | 裁决 | 处置 |
|---|---|---|---|
| A1-F1 多 block 重放分组/排序偏离 convert_messages | HIGH | CONFIRMED | fixer#1：合并 text、function_call 后置 + 多 block 测试 |
| A1-F2 shared 流处理改动跨 provider 传播无锁定测试 | MEDIUM | CONFIRMED（行为正确、测试缺口） | fixer#3：azure/codex 各补 usage 测试 |
| A1-F3 system content string vs oracle 数组 | MEDIUM | CONFIRMED（属本单元请求体构造职责） | fixer#2：实现 oracle 形状 + 测试改回 |
| A1-F4 TypeError 重试判定宽于 reqwest 分类 | LOW | ACCEPTED-AS-APPROX | fixer#6：升格 TODO(port) 标记 |
| A1-F5 abort 断言弱 | LOW | CONFIRMED | fixer#7：断言 Abort 类 |

## A2（对照 RULEBOOK）6 findings
| id | sev | 裁决 | 处置 |
|---|---|---|---|
| A2-F1 B3 标注错站点/缺行号 | HIGH | CONFIRMED | RULEBOOK 新增 B3a（已应用）+ fixer#4 改标注 |
| A2-F2 B3 适用面未过 Deviation log 扩大 | HIGH | CONFIRMED（行为正确、流程违规） | Deviation log 已补记（编排者）；fixer#4 |
| A2-F3 分歧未置 TODO 标记 | MEDIUM | 合并入 A1-F3（直接实现） | fixer#2 |
| A2-F4 注释单方面宣称 RULEBOOK stale | MEDIUM | CONFIRMED（实质对：§1 已修订；措辞违规） | §1 修订已应用（编排者）+ fixer#5 改措辞 |
| A2-F5 retry 落位三处规则矛盾 | RULEBOOK-AMBIGUITY | CONFIRMED | §1 落位裁决已应用（依赖方向优先，ai 包） |
| A2-F6 compat 解析重复实现+不安全断言 | LOW | CONFIRMED | fixer#8 去重 |
