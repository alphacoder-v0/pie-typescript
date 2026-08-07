# 共享并发 util 的对抗复核（phase 8，T2）

这 4 个 util 被 phase 10-15 每个单元 import，语义错误污染整条下游链路——故单独立评。

| id | sev | 裁决 | 处置 |
|---|---|---|---|
| F1 selectN 分支 reject 时跳过败者 abort（无 try/finally） | **CRITICAL** | CONFIRMED | fixer#1 + reject 路径测试（原测试的 loser 分支自己 catch 掉了 reject，等于没测） |
| F2 AsyncQueue.next()/Signal.wait() 无 AbortSignal，落败 waiter 会偷走后续值 | HIGH | CONFIRMED | fixer#2 |
| F3 未实现 `select!{biased}` 顺序偏向（oracle ≥4 处用，含 agent_harness cancel-vs-completion） | HIGH | CONFIRMED | fixer#3 新增 selectBiased，参照 mcp raceCancellable 的 queueMicrotask 模式 |
| F4 detach 的两条逃逸路径（onError 自身 reject；fn 同步抛出） | MEDIUM | CONFIRMED | fixer#4 |
| F5 async-mutex 不可重入的静默死锁无文档无测试 | MEDIUM | CONFIRMED（行为忠实 tokio，只补文档+特征测试） | fixer#5 |
| F6 closed 标志合并 sender-dropped 与 receiver-dropped 两种 mpsc 状态 | LOW | ACKNOWLEDGED | 记此处；phase 10 若遇到依赖 send() 失败识别 receiver-dropped 的 oracle 站点，再扩展 |
| F7 mcp 叶包 util 混入非并发工具（errorMessage/utf8ByteLength/decodeUtf8Strict） | LOW | ACKNOWLEDGED | phase 19 复盘挪出 |

**方法论价值**：这批缺陷全部是"测试绿但语义错"——原实现的 240 个测试全过，因为测试只覆盖了 happy path（select 只测 resolve、detach 只测 async fn 抛错、mutex 从不重入）。tokio 原语的语义细节（公平性、取消传播、平局偏向、重入）必须逐条对照原语文档核对，不能靠"能跑通"验收。

# trigger wire 形状复核（T1a，2 文件对）

| id | sev | 裁决 | 处置 |
|---|---|---|---|
| F1 NotificationHookStatus 的 last_event_at/last_ack_at/last_error/requires_attention 用 `?:`（省略），oracle 无 skip_serializing_if → 应为 `T \| null`（始终发 null） | **CRITICAL** | CONFIRMED（编排者亲验 oracle notification_hook.rs:104-130 逐字段无 serde 属性） | fixer |
| F2 trigger.test.ts:127-140 的 round-trip 断言两边都是 `JSON.parse(JSON.stringify(record))`，恒真 | MEDIUM | CONFIRMED | fixer：改为与原始 typed record 比对 |
| F3 无 TriggerRecord decode 函数，unknown-field 容忍测试没走解析逻辑 | LOW | CONFIRMED | fixer：补 decodeTriggerRecord 或用既有 decodeTrigger 模式 |

**讽刺点（值得记）**：implementer 自己在 `trigger.ts:12-19` 写了 null-vs-omitted 不对称的警告文档，并在 `Trigger.payload_summary` 上正确应用，却在同批的 notification-hook.ts 四个字段上全踩了。**写下规则不等于遵守规则**——wire 形状必须逐字段机器核对，不能靠实现者的注意力。

# trigger 逻辑复核（T1b，2 文件对）

| id | sev | 裁决 | 处置 |
|---|---|---|---|
| F1 `get config()` 返回私有对象直接引用（可被外部 mutate 污染内部状态、绕过 MAX_DEDUP_WINDOW_MS 钳制）；oracle 返回 Copy 值 | MEDIUM | CONFIRMED | fixer#4 |
| F2 计数器 `+= 1` vs oracle `saturating_add(1)` | LOW | CONFIRMED（实践不可达） | fixer#5 注释或钳制 |

**正面确认（同等重要，记档以免后续误改）**：
- **B9 first-wins 复刻正确**：TS 没有"修好"LatestReplaces，且额外加了超出 oracle 的 bug-for-bug 回归测试。
- dedup 窗口边界算术（`>=`/`<`）、key 构造、dedup-before-cycle 顺序、pre-block hop 计数、三种 ReplacementPolicy 行为、进程内状态生命周期——逐行匹配。
- **permission 文件对零发现**：9 条 regex 源码逐字符相同（含 `String.raw` vs `r"..."` 的转义等价）、2 条 rm 谓词的标志排列/`--` 终止符/长选项静默忽略/程序名路径剥离/引号剥离/`${HOME}` 重写/`;`&&`||`|` 子句切分（含 `||` vs `|` 消歧顺序）全部等价；evaluate 的短路顺序与字段探测顺序（command→cmd→bash→script→裸串，含空值继续下探）一致；34 条危险语料（任务书写的 33 是笔误）逐条保留未弱化。

# phase 10 交接项（trigger fixer 发现）

`packages/coding-agent/src/triggers/cron-deps.ts:207-231` 有一份**独立的、camelCase 的** `NotificationHookStatus`/`notificationHookStatusPending` stub，标着 `// TODO(port): replace with @pie/agent-core export (phase 8)`。phase 5 pilot 建它时 agent-core 侧尚不存在。

现在 `packages/agent/src/harness/notification-hook.ts` 已落地（snake_case wire-exact，且刚修完 null-vs-omitted）。**phase 10 移植 triggers/loops/inbox 时必须**：
1. 把 cron.ts 及其它 cron-deps 消费者切到 `@pie/agent-core` 的真实导出；
2. 删除 cron-deps.ts 中所有已被真实实现取代的 stub（其余仍缺的保留 TODO(port)）；
3. **注意大小写**：stub 是 camelCase，真实实现是 snake_case（wire 形状）——切换时要改调用点，不能只改 import。

同类交接：cron-deps.ts 里的 TriggerSource/Trigger/TriggerRecord/HookState/AgentTool 等 stub，现在 agent-core 侧都有了真身。
