# Phase 6（@pie/mcp）review 闭环

M1（vs Rust）10 findings + M2（vs RULEBOOK）8 findings，重叠互证 3 处。裁决：

| 合并项 | sev | 裁决 | 处置 |
|---|---|---|---|
| M1-F1=M2-F1 SSE body 错误升级为全停 | HIGH | CONFIRMED | fixer#1 静默丢弃（oracle http.rs:305-310） |
| M1-F2 POST 超时特化 timeout 码 | HIGH | CONFIRMED | fixer#2 统一 Transport |
| M1-F3=M2-F2 版本 0.75.4 vs 0.75.0 | MEDIUM | CONFIRMED | fixer#3 |
| M1-F4=M2-F4 tie-bias 反向 | MEDIUM | CONFIRMED | fixer#4 + both-ready 测试 |
| M2-F3 close 中断在途 POST | MEDIUM | CONFIRMED | fixer#5a |
| M1-F10 close 不 cancel SSE reader | LOW | CONFIRMED | fixer#5b |
| M1-F5 JSON.stringify 裸 TypeError | MEDIUM | CONFIRMED | fixer#6 |
| M1-F6=M2-F8 serde default 缺失 | MEDIUM | CONFIRMED | fixer#7 |
| M1-F7 秒数 round vs 截断 | LOW | CONFIRMED | fixer#8 |
| M2-F5 channel 双 recv 静默覆盖 | LOW-MED | CONFIRMED（invariant-throw 替代） | fixer#9 |
| M2-F6 死导出 | LOW | CONFIRMED | fixer#10 |
| M2-F7 引用不存在的 report | LOW | CONFIRMED | fixer#10 |
| M1-F8 无界通道 | LOW | ACCEPTED-AS-DISCLOSED（PERF(port) 已标） | 保持 |
| M1-F9 JSON.parse 1.0/1 塌缩 | LOW | PLATFORM-LIMIT | fixer#11 注记 + ED4 |
| M2 之前疑点（叶包 util/spawn） | — | 已由 §6 修订 sanctioned | 无操作 |
