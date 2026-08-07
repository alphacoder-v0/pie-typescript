# MIGRATION-REPORT — pie (Rust) → TypeScript

2026-08-04。本文件是整个迁移的交付记录：六步法怎么执行的、done-gate 的双计数、法典偏离汇总、
**未验证的边界**、以及交出去之后还剩什么。

上游钉死：oracle = [c4pt0r/pie](https://github.com/c4pt0r/pie) `0a120dfd`（行为合同）；
skeleton = [earendil-works/pi](https://github.com/earendil-works/pi) `4868222e`（TS 骨架）。
方法论 = Anthropic code-migration-kit 六步法的 redesign 变体。

---

## 1. 六步法执行记录

| 步 | kit 定义 | 本仓怎么做的 | 产物 |
|---|---|---|---|
| 1 | 建立事实源 | 四个上游 SHA 钉进 `migration/sources.env`，oracle 保持可运行且**只读**（`cargo` 在本仓被 deny，一切 oracle 操作走 `migration/parity/*.sh` 封装） | `sources.env`、`PROVENANCE.md`、`NOTICE` |
| 2 | 清点与分类 | 205 个单元入 `migration/manifest.tsv`，分类 port / diff-port / char-tests / reuse / excluded | `manifest.tsv`、`depmap/`、`inventory.tsv` |
| 3 | 立翻译法典 | `migration/RULEBOOK.md`：类型/并发/错误/依赖方向的逐条映射，loop 内**只读**，修订排队到 phase 边界 | RULEBOOK §1–§4 |
| 4 | 逐单元翻译 + 溶解检查 | implementer → 2 个对抗性 reviewer（一个对照 Rust 源、一个对照 RULEBOOK，分开上下文、只读）→ 分歧第三者裁决（默认 not-confirmed）→ fixer 只改 confirmed。tsc 溶解进单元循环 | `migration/reviews/<slice>/` |
| 5 | 廉价冒烟先于昂贵对账 | `migration/smoke/`（退出码与进程泄漏——parity 结构上看不到的两件事）、`parity/webui-smoke.sh` | `smoke/report.md`、`findings.md` |
| 6 | done-gate 双计数 | 见下节 | `parity/final-report.md` |

### 队列状态

`manifest.tsv` 205 行：**200 done**，5 pending 且全部是**已记录的排除项**
（4 个 example/debug 脚手架 + 1 个 oracle checkout 里的未追踪审计探针，不属于 pie@0a120dfd）。
分类分布：diff-port 101 · port 72 · char-tests 26 · excluded 5 · reuse 1。

完成判定始终是**落盘**的：`out_path` 文件存在 **且** `status=done`。这条规则在 phase 13/14
救了场——见 §4 的队列准确性一节。

---

## 2. done-gate 计数

> **2026-08-05 · phase 20-10：双计数变三计数。** 原来的两个计数各守一面，但都可能在
> 「名字对得上、行为不对」时通过——`check-surface-coverage.mjs` 的文件头自己写明了这一点。
> 本轮新增第三个：**oracle 内联单测移植率**（`scripts/check-inline-test-ports.mjs`，
> 已接入 `npm run check`）。三者的分工是：
>
> | 计数 | 守的是 | 当前值 |
> |---|---|---|
> | `check:manifest` | **文件层** — oracle 的 .rs 是否都登记 | 204/204，missing=0 extra=0 dups=0 |
> | `check:surface-coverage` | **签名层** — oracle 的 pub fn 是否都有同名物 | 513 个中未匹配 40（基线 40） |
> | `check:inline-test-ports` | **行为层** — oracle 自己写的断言是否有对应物 | 541 条中未匹配 219，**移植率 59.5%**（立项时 46%） |
>
> 第三个是最贴近「移植是否真的完整」的那个，因为它盯的是 oracle 亲手写下的行为期望。
> 它有两个方向的误差（散文命名导致假阴性、名字碰巧出现导致假阳性），所以是**基线守卫**
> 而非完整性证明——脚本文件头逐条写明了。门禁负控实测：基线调紧 1 条即失败；
> 无 oracle 时干净跳过，且「未配置」与「路径错」措辞不同。

## 2. done-gate 各计数明细

### (a) referee — parity judge

phase 17 收敛到**全 8 场景双侧逐字节零差异**（`migration/parity/final-report.md`）。phase 18 起
基线变为"逐字节等于 oracle，**除已声明项外**"。当前合法差异集，`npm ci` 干净环境复跑确认：

| 文件 | DIFF | 归属 |
|---|---|---|
| `S3/requests.norm` | 2 | D4 |
| `S3/run.norm` | 8 | D1 + D2 |
| `S3/session.norm` | 12 | D1 + D2 |
| `S5/req2body.norm` | 2 | D4 |
| `S6/session.norm` | 24 | D1 + D2 |
| `S8/list.norm` | 2 | D5 |
| `S8/resumeerr.norm` | 2 | D5 |
| `S8/resumeexit.norm` | 2 | D5 |

S1 / S2 / S4 / S7 整体 DIFF 0。**不在此表内的任何差异都是缺陷，不是"已知差异"。**

### (b) oracle 复跑

```
bash migration/parity/test-oracle.sh
cargo test --workspace  exit=0
34 binaries · 1398 passed · 0 failed · 0 ignored
```

这条基线不是形式主义：oracle **零失败**，因此 phase 17 验收里的 `inherited` 桶**结构上必须为空**。
不先跑它，`inherited` 就会变成一个安放任何不方便结果的垃圾桶。

### (c) TS 侧

```
npm ci && npm run build && npm run check && npm test   # 四者全 exit 0
agent 441 + ai 440 + coding-agent 2577 + mcp 38 + tui 612 + fefe-hub 17 = 4125 passed / 0 failed
776 skipped = 710 密闭模式下无 provider key 自跳过 + 66 逐条归档的已知缺口
```

`rs_count` 门槛 766（oracle 全域 `#[test]` + `#[tokio::test]` 函数数）。
**两个口径不可混用**：766 是源码中的测试函数个数，1398 是执行的测试实例数。

---

## 3. 有意偏离 oracle（D1–D8）

全文见 `migration/parity/intentional-divergences.md`。这些是"我们知道 oracle 是错的，于是选择不跟"：

| id | 内容 | 用户会感觉到什么 |
|---|---|---|
| D1 | usage 记账不再把缓存输入重复计数 | token 总数变小且正确（示例：210 → 110） |
| D2 | cost 按模型目录真实换算；budget cap 成为 loop 内硬门 | 金额不再恒为 $0；上限第一次真的拦得住循环内请求 |
| D3 | 项目级 `.pie/{mcp,lsp,models}` 需要显式信任 | 打开不受信任的仓库不再执行其中的任意命令 |
| D4 | 模型不能让 cron job 生效 | 模型建的定时任务默认禁用，需人工 `/cron enable` |
| D5 | 截断的尾行不再让整个会话报废 | 进程被杀后会话还能打开，丢的只是半条尾记录 |
| D6 | `LatestReplaces` 真正 replace | 去重窗口内的关联不再钉死在被取代的那条 trace |
| D7 | `pie session export\|import` 拒绝而非当成提示 | 打错子命令不再把命令行发到第三方 API |
| D8 | 畸形 `models.json` 致命且带原因 | 不再静默丢掉自定义模型表、悄悄换端点 |

另有 **ED1–ED25**（`explained-divergences.tsv`）：judge 不可观测、已论证的架构性差异。

---

## 4. Deviation log 汇总

`RULEBOOK.md` §6 共 **28 条**。按性质归类，最值得记住的几条：

**法典缺口（规则本身不够用）**
- §2.2 补 `tokio::time::timeout` 行——同一批次里出现三种不同映射才暴露。
- §2.1 补"非 serde 判别式也用 snake_case"——两个并行 agent 来回改三次，是真实缺口不是分歧。
- §2.3 叶包并发/spawn 例外（依赖方向不可反转，implementer 上报、编排者裁决）。

**台账治理（谁有权立项）**
- B13/B14/B15/B16/B17 都是 implementer **提议、不自分配 id**，编排者裁决后补入。
  确立的姿态：实施者以"不在表里"为由不立项属循环论证——§5 由编排者维护。

**队列准确性（最贵的一类）**
- phase 13/14 发现 **4 处** manifest 映射错误（spinner 分类、tests/tools 路径、
  tests/commands 指向另一单元的文件、tui 分类+路径），其中 3 处会直接制造**假绿**。
- 根因记录在案：phase 2 的 base/out 映射是按**文件名相似度**做的，未经行为核对。
- phase 17 又发现第 5 处，且是新类型：**行标着 done，但单元内有整块未移植**——
  系统提示与 25 个工具 schema 全是 pi 的。前四处靠交叉核对文件名能发现，这处只有逐字节
  比对请求体才会暴露。

**流程**
- reviewer 任务规模上限（≤6 单元或 ≤4 编号问题）、reviewer 禁跑长命令——各自源于多次 agent 停滞。
- 规则 6（同类失败第三次改因不改例）在 phase 18 **首次真正触发**：三处"flaky"查因后
  没有一处是 flaky，其中一处是产品缺陷。

---

## 5. unverified 边界（交出去之前必须知道的）

**这一节是本报告最重要的部分。** 下列事实是「我们没有验证」，不是「我们验证过没问题」。

> **2026-08-05 · phase 20-9：本节不再有「未验证」这种含糊态。** 每行现在要么划掉并标**已关闭**（附实证装置），要么明写**仍开放**并说清「为什么仍开放」与「重新评估的入口在哪」。七行的结局：4 已关闭 · 3 仍开放（各有理由，非遗漏）。
>
> **2026-08-05 · phase 21-9 更新：5 已关闭 · 2 仍开放 · 1 新记。** `--builtin-skill` 完成接线并关闭；live provider 与性能两条各自复核后**维持现状**，其重估条件已改写成「今天就能回答是/否」的形式并当场作答（均为否）——写成「以后再评估」正是它们挂了两轮的原因。另新记**第四条边界**：密闭测试入口仍向真实 `~/.pie/sessions/` 写入（cwd 隔离了、存储根没隔离），一行 `PIE_DIR` 实验证明可堵但会红 12 条依赖真实 `~/.pie` 的测试，属新工作，本轮不做。三条的代价 / 理由 / 可答重估入口逐条见 `migration/reviews/phase21/open-boundaries.md`。

| 边界 | 状态 |
|---|---|
| **live provider 行为**（**仍开放** — 结构性，非遗漏） | 776 个 skip 里有 710 个是密闭模式下无 provider key 自动跳过的 live-API 用例，**CI 里仍然没有真实 provider**。已补一次性证据：`migration/reviews/phase19/live-model-smoke.md` 用 Gemini 2.5 Flash 与 SiliconFlow/DeepSeek V4 Flash 各跑通一个真实任务（read→edit→bash，文件真的被改、测试真的通过），覆盖两个 API 家族与第三方 baseUrl 路由。但那是**一次性、不可重复、不进门禁**的证据。**为什么仍开放**：把真实 provider 放进门禁会让 CI 花钱、结果随上游限流与模型退役而抖动，且无凭据的机器（干净 clone、`npm ci` 复现）必须仍能跑通全套——这是**刻意的分工**，不是漏做：密闭那套是门禁，`npm run test:live` 是证据。**重新评估的入口**：若日后要把某几条 live 断言变成门禁，应挑「不花钱、不受限流影响」的那类（如 401 归因、baseUrl 路由），而不是整套照搬。**2026-08-05 · phase 21-9 复核：维持现状。** 重估条件写成了今天可答是/否的形式——「某 provider 的 SSE/错误信封协议近 90 天内出现 ≥2 次不兼容变更」，今天答**否**：三轮共 29 个 phase 未因上游协议变更改过 `packages/ai/test` 下任何 fixture，13 条声明偏离也无一源于协议漂移。代价已逐条写明（协议漂移不可见、凭据/网络路径无回归、模型退役与配额形态）——本机 `test:live` 唯一失败正是配额类而非代码类。详见 `migration/reviews/phase21/open-boundaries.md` |
| **性能**（**仍开放** — 记录而非门槛，刻意如此） | `migration/reviews/phase19/perf-baseline.md` 是**记录不是门槛**。审计明示两侧无公平基准。实测 TS 启动 ~860ms vs oracle ~7.5ms；Node 本身只占 4%，其余是应用模块图。**为什么仍开放**：两侧无公平基准（Rust 原生二进制 vs Node 模块图），设一个阈值只会得到一个随机器与负载漂移的假门禁。**重新评估的入口**：若启动时间成为真实抱怨，先做模块图的懒加载分析，再谈阈值。**2026-08-05 · phase 21-9 复核：维持现状。** 重估条件今天可答：「启动时间成为真实用户抱怨，或自测相对上次记录劣化 ≥50%」——今天答**否**（本仓无外部 issue 渠道；本轮 `src` 净改动为 phase 2 的 `mergedModels()`、phase 5 的一段注释、phase 9 的内置技能接线，均不在启动热路径上）。粗基准给得出但只在很窄范围成立，能用于「本仓与自己的过去比」，不能对外引用为「移植的性能代价」——不公平之处已逐条列明 |
| ~~**hooks**~~ **已关闭（2026-08-05 · phase 20-9）** | 决定是**接上**，不是继续声明未接。`main.ts` 现在在 `session.agent.subscribe(agentListener(feed))` 旁加载 hooks 并订阅 `runner.listener()`（对应 oracle `main.rs:842` + `:1039`），并补齐 `hooks: loaded N hook(s)` 与 hook 诊断两行（`main.rs:1015-1020`）。**端到端实测**：项目级 `hooks.toml` 写一条 `agent_end` 规则、置 `PIE_ALLOW_PROJECT_HOOKS=1`、对本地 fixture provider 跑完一轮 —— 输出 `hooks: loaded 1 hook(s)`，哨兵文件被真的写出。此前之所以说「未接线」，是**对现状的描述而不是一个决定**；零件早已齐备（`load` 签名、`runner.listener()` 类型、`session.agent.subscribe` 用法与紧邻的 feed 订阅完全同形），不接的代价是让一个已移植完的能力持续死着 |
| ~~**oracle 的信任门危害**~~ **已关闭（2026-08-04）** | phase 19 的怀疑是对的：`[servers.evil]` 确实不符 oracle schema。真实形状是 `[[server]]`（`mcp_loader.rs:25-31`，`McpConfig.server: Vec<ServerConfig>`），而 `McpConfig` 没有 `deny_unknown_fields`，所以复数键**成功解析成空列表**——那次审计正确地回答了一个错误的问题。用从反序列化器推出的 fixture 实测：oracle 在 `mcp.toml`（启动即 spawn）与 `lsp.toml`（首次编辑 `.txt` 时 lazy spawn）两条路径上**都真的执行了仓库里写的命令**（sentinel 落盘，内容 `pwned`）；同一批 fixture 在本仓 untrusted 下**不产生任何进程副作用**，trusted 后照常 spawn。装置：`migration/parity/oracle-probes/d3-trust-harm/run.sh`（双二进制，7/7，含 phase-19 错误形状的负控）+ `packages/coding-agent/test/project-trust-harm.test.ts`（9 用例，两侧共用同一 fixture 源以防漂移）。**2026-08-05 · phase 20-9 补齐第三条路径**：`models.json` 的 `base_url` 重定向此前只断言过「hostile baseUrl 不进注册表」——那是**中间状态**，与 mcp/lsp 探针观测「哨兵进程是否 spawn」的强度不对等。现补 `packages/coding-agent/test/models-json-harm.test.ts`：起一台真实本地 HTTP 服务器当「攻击者地址」，未信任时它**一条请求都收不到**；信任后收到，且请求带着 `Bearer sk-user-secret-key` 与对话内容——危害的具体形状被完整拍下来了。第二条用例即内建负控（证明这套装置不是「什么都观测不到」才通过） |
| **降级路径** | **仍开放，但已从「未验证」变为「已量化并作出决定」（2026-08-05 · phase 20-9）。** 三处不兼容逐条实测确认：①信封 —— 本仓写 pi 的扁平 `Record<provider, cred>`，oracle 读 `{version, providers}`（`auth.rs:60-70`）；②判别字段 —— 本仓 `type`，oracle `kind`（`#[serde(tag="kind")]`）；③值字段 —— 本仓 `key`，oracle `value`。**结论：接受，不提供转换器。** 反向的 `importRustPieStore` 已存在（ED14）因为用户会**迁入**本仓；降级方向意味着放弃这次移植，那时每个 provider 重跑一次 `/login` 是一条命令，而转换器是 oracle 没有的新增面、要长期维护。若日后改主意，入口是把 `importRustPieStore` 的映射反过来写 |
| ~~**browser-smoke 覆盖面**~~ **已关闭（2026-08-05 · phase 20-9）** | 入口集从 1 个扩到 3 个：`scripts/browser-smoke-entry.ts` + `packages/ai/src/index.ts` + `packages/agent/src/index.ts`，即**消费者真正会 import 的东西**。实测三者今天都能浏览器打包，所以这是零成本的真收紧。**门禁负控**：往 `packages/ai/src/index.ts` 塞一个 `node:fs` import，`check:browser-smoke` 当场失败；恢复后通过。**未**扩成整树 —— `ai/cli.ts`、`ai/utils/node-http-proxy.ts`、`ai/utils/oauth/anthropic.ts`、`agent/harness/env/nodejs.ts` 按设计就是 Node-only，整树打只会把门禁变成噪音。RULEBOOK §6 的 deviation log 已改为「已决定并落地」 |
| **`--builtin-skill`**（~~仍开放~~ **已关闭** — 2026-08-05 · phase 21-9） | phase 19 修好了校验（未知名硬失败），phase 21 补上了**接线**：解析结果经 `mergeSkillsWithBuiltins` （`core/skills.ts`）并入 `ResourceLoader` 的技能目录，`config.toml` 的 `[builtin_skills] enabled` 同路生效。**实证**（密闭 `env -i` + 临时 HOME）：无 flag `loaded 1 skill(s)` → `--builtin-skill karpathy-guidelines` `loaded 2 skill(s): karpathy-guidelines, probe-skill`；config 来源同结果；同名磁盘技能遮蔽内置（1 条、`(user)`、磁盘版描述）；未知名仍退出码 2。接线中查出两个**只有真跑二进制才暴露**的故障：①合并写进了 `tools/skill.ts` 而真正的消费方是 `ResourceLoader`（与 phase 2 的 `/model` 同型）；②`<builtin>/…` 合成路径撞上 `getDefaultSourceInfoForPath` 末尾的 `statSync`，CLI 在打印任何一行前 ENOENT。单测 6 条全部断言 `getSkills()`，负控 M1/M2/M3 全部检出。详见 `migration/reviews/phase21/open-boundaries.md` |

---

## 5b. 本轮（phase 20）新增声明与主要改动

**新增声明偏离 3 条**（`migration/parity/intentional-divergences.md`）：

| # | 内容 | 为什么不跟随 oracle |
|---|---|---|
| D11 | `NO_PROXY` 被遵守、非法代理 URL 显式报错 | oracle 的模块注释**承诺**处理 `NO_PROXY`，实现却从不读它；跟随等于主动删掉一个正确实现去复刻一处安全相关的静默失败 |
| D12 | `ExecutionErrorCode` 保留 `shell_unavailable` / `callback_error` | 这两种情形 oracle 根本没有对应站点（它无 shell 发现逻辑；Rust 回调不会抛）；折叠会丢诊断，换来的对齐是纯形式的 |
| D13 | 被中止的一轮仍在转录里留一条空 assistant 条目 | 危害更大的那半（**中止轮次被计费**）已修；抹掉空条目要动四条链路、20+ 测试文件的 30 处断言，风险高于收益。D13 写明了对齐入口与验收标准 |

**行为对齐（择要）**：`push_aborted` 载荷九个 provider 统一（中止不再计费）· Anthropic authorize URL
三处差异 · 摘要提示预算改为**发送前**裁剪（此前靠 provider 拒绝后重试，CJK 内容实测会超预算 2.8 倍）·
grep 长匹配行围绕匹配开窗（此前匹配落在 500 字符后就**看不到匹配**）· `--long=value` 整体不被解析 ·
重复选项按 clap 报错 · 会话命令后的未知 flag 不再被静默吞掉 · MCP 畸形响应在解析边界拒绝 ·
模板目录 `templates/` 与 `prompts/` 并读 · hooks 接线并端到端实证。

**新增测试**：约 70 条，分布在 4 个包；每个新增判定面都配了负控，且**每次变异脚本都带 assert
确认变异真的落地**——phase 20-2 出过一次「变异没生效、负控假通过」，此后不再重演。

---

## 5c. 本轮闭环（supergoal `pie-112-1vuLwY`，10 phases，2026-08-05）

立项时精确界定的三件事，全部有结论。完整收口见
`migration/reviews/phase21/closeout.md`。

### 121 条 oracle 内联测试逐条裁定 —— 无第四类

| 裁定 | 条数 | 形式要求（门禁强制） |
|---|---|---|
| `covered` | **83** | 给出 TS 具体**断言行**行号；门禁校验那一行确实含 `expect(` 或 `assert` |
| `not-portable` | **4** | ≥20 字理由 |
| `gap` | **34** | 全部移植，每条配负控 |

`check:triage-ledger` 是本轮新增的**第四道计数门禁**（裁定层，前三道分别是文件层
`check:manifest`、签名层 `check:surface-coverage`、行为层 `check:inline-test-ports`）。
它做三个方向的校验：名册每行在 oracle 中确实存在 · 名册规模钉死 121 ·
当前未匹配集合无遗漏。`TODO` 已于本 phase 移出允许集合——**从此新增一行就必须当场给结论**。

裁定过程撞出的两个真实用户可见缺陷：`/model` 看不见 `models.json` 声明的模型（已修）；
密闭测试入口仍向真实 `~/.pie/sessions/` 写入（记为新边界，见 §5 抬头）。
两个都不是读源码读出来的，是**写 oracle 忠实断言时撞出来的**。

### 473 个「只验证了名字」的函数 —— 风险分层 + high 层 100% 覆盖

| 层 | 数量 | 处置 |
|---|---|---|
| high | **45** | 100% 行为证据，逐个指向具体断言或 parity 场景 |
| medium | 149 | 记录 |
| low | 279 | 记录 |

分类器 `scripts/classify-surface-risk.mjs` 两次运行字节一致（确定性已证），
规则收紧两次且各自写明理由（`credential` 曾按文件粒度命中 290、`token` 吃掉
`CancellationToken`、`auth` 吃掉 `author`、`parity-path` 按模块粒度命中 81）。

### 三条边界

`--builtin-skill` **已关闭**（接线 + 五路端到端实证 + 6 条单测 + 3 个负控）；
live provider 与性能两条**维持现状**，重估入口改写成今天可答是/否的条件并当场作答（均为否）；
另新记第四条边界（存储根未隔离）。

### 计数前后对照

| 门禁 | 立项时 | 现在 |
|---|---|---|
| `check:manifest` | 204/204，missing 0 | 持平 |
| `check:surface-coverage` | 未匹配 40/513 | **不变**（本轮未移植新函数，持平是正确结果） |
| `check:inline-test-ports` | 未匹配 219/541 | **190**（−29） |
| `check:triage-ledger` | 不存在 | 121 条，TODO 0 |

`inline-test-ports` 只降 29 而非 121，因为 83 条 `covered` 的定义就是「名字没匹配上但行为有覆盖」，
它们**不会**让这个按名字匹配的计数下降。**这个数字不能当移植质量的唯一读数**——
本轮 83 条 covered 恰恰证明了「名字对不上 ≠ 行为没覆盖」。

### 全链

`npm ci` → `build` → `check` → `test.sh` 全 exit 0；**4319 passed / 0 failed**（基线 4273，只增不减）。
parity 差异集**恰等于**声明基线 8 项，S1/S2/S4/S7 与 S9–S12 全 DIFF 0；判定器自检 **3/3 DETECTED**。
`test:live` 唯一失败归类 environment（429 配额先于上下文溢出到达）。
本轮新增行中 `console.log` / `FIXME` / `XXX` / `HACK` / `@ts-ignore` / `eslint-disable` 计数为 **0**。
本轮**未新增任何声明偏离**——D1–D13 与 B1–B18 不变。

---

## 5d. 第四轮闭环（supergoal `pie-medium-149-low-td9AgT`，10 phases，2026-08-06）

用户选定的两件事都做完了。完整收口见 `migration/reviews/phase22/closeout.md`。

### 282 个「只验证了名字」的函数，全部有行为裁定

| 裁定 | 条数 | 形式要求（门禁强制） |
|---|---|---|
| `existing-test` | **185** | 指向 TS 具体断言行；门禁校验那一行含 `expect(` 或 `assert` |
| `new-test` | **37** | 本轮新写，先贴 oracle 行为依据再贴 TS 断言 |
| `not-portable` | **60** | ≥20 字理由 |

名册 = medium 层 149 全量 + 从 low 279 里按三条**可复算判据**捞出的 133
（B `oracle-tested`：函数名在其 `.rs` 的 `cfg(test)` 块正文里被调用 · C `mutating` · D `fallible`）。
`existing-test` 命中率 **83.3%**（分母不含 not-portable）。

`check:behavior-evidence` 是本轮新增的**第五道计数门禁**，已收紧为「未满 282 即失败」，
`npm run check` 现为 11 道。

### ⚠ 本轮最重要的发现：`check:surface-coverage` 显著低估缺口

282 条里有 **60 条**（21.3%）它算作「已匹配」而 TS 侧实际不存在同物——
整条 AWS Bedrock 二进制帧路径未移植、Rust 枚举方法在 TS 用字面量联合替代、
builder 链合并成单构造器、以及若干需真实 I/O 或只能 tautology 的。

**「513 个公开函数只剩 40 个未匹配」听起来像 92% 完成度，但那个数字只统计了名字。**
下一轮若要给出「移植完成度」，不能再引用它。这不是本轮引入的问题，是本轮发现的问题。

### 测试密闭性 —— 第四条边界关闭

`bash test.sh` 跑前跑后真实 `~/.pie/sessions` **增量 0**（此前每次泄漏 21 个会话目录 / 35 个文件）。

根因与 phase 21 记的不同：不是「12 条测试缺夹具」，而是它们设了优先级较低的
`PI_CODING_AGENT_DIR`，被 `PIE_DIR` 盖掉。改用 oracle 自己的变量后**断言一字未改**。
另解决了上一轮未记录的一面：16 条 grep/find 测试需要 `$PIE_DIR/bin/{fd,rg}`——
区分「隔离状态」与「隔离工具依赖」后软链解决。

### 计数前后对照

| 门禁 | 本轮开始 | 现在 |
|---|---|---|
| `check:manifest` | 204/204 missing 0 | 持平 |
| `check:surface-coverage` | 未匹配 40/513 | 持平（本轮不移植新函数） |
| `check:inline-test-ports` | 未匹配 190/541 | 持平（新增测试不提及 oracle 测试名） |
| `check:triage-ledger` | 121 条 TODO 0 | 持平 |
| `check:behavior-evidence` | 不存在 | **282/282，已收紧** |

### 全链

`npm ci` → `build` → `check` → `test.sh` 全 exit 0；**4397 passed / 0 failed**（基线 4319，只增不减）。
parity 差异集**恰等于**声明基线 8 项，S1/S2/S4/S7 与 S9–S12 全 DIFF 0；判定器自检 **3/3 DETECTED**。
`test:live` 26 条失败**全部 environment、0 regression**（25 条是本机无 Anthropic OAuth 凭据的 401，
1 条是已知的 Gemini 配额）。本轮新增行清洁度计数为 **0**；`src` **零改动**。
本轮**未新增任何声明偏离**——D1–D13 与 B1–B18 不变。

### 留给下一轮

low 层未捞出的 **146 个**（判据盲区：纯函数 + 不可失败 + oracle 没测的）·
`surface-coverage` 的 40 个未匹配 · `packages/tui/test` 未进门禁语料（致未匹配数虚高 6 条，方向保守）。

---

## 5e. 第五轮闭环（the fifth round，11 phases，2026-08-06）

用户选定的判定标准：**证据无死角 = oracle 的 513 个公开函数每一个都有行为证据**。达成。

详见 `migration/reviews/phase23/closeout.md`。

### 结果

| 裁定 | 条数 | 占比 |
|---|---|---|
| `existing-test` | **321** | 62.6% |
| `new-test` | **46** | 9.0% |
| `not-portable` | **144** | 28.1% |
| `dissolved-dependency` | 1 | 0.2% |
| `oracle-stub` | 1 | 0.2% |
| **合计** | **513** | 100% |

`existing-test` 命中率 = 321 / 369 = **87.0%**（分母不含三类「无实现可测」的裁定）。

本轮新增 186 条裁定（批 U 40 · F 58 · G 52 · H 36）：existing 87 · new 8 · not-portable 91。

### 本轮推翻的两个数

**这比 513/513 本身更有价值。**

| 数 | 值 | 说明 |
|---|---|---|
| `not-portable` 的**误判率** | **11.7%** | 第四轮 60 条复核出 **7 条错判**。五条同因：精确 grep 一个猜出来的 camelCase 名字，零命中就下结论——而真实 TS 名是 oracle 名的**扩展**（`receivedFrom` → `triggerRecordReceivedFrom`、`generateImages` → `generateImagesOpenRouter`、`isRetryableError` → `isRetryableErrorMessage`）。第六条 `run_web` 更重：理由写「零命中」，实测 `runWeb` **就在 `ui/web.ts:1497` 且被 `main.ts:1645` 调用**，那次 grep 根本没做 |
| `check:surface-coverage` 的**漏配率** | **30.0%** | 它报的 40 个「未匹配」里 **12 条 TS 侧有实现**，只是名字对不上它的 snake→camel/pascal 三变体（`generate_pkce` → **`generatePKCE`** 的 acronym 大写、`list_api_ids` → **`getApiProviders`** 的换动词换名词）|

### ⚠ `check:surface-coverage` 的双向误差

§5d 说它**低估**缺口。本轮补上另一半：**它同时也高估**。

- **高估** 12/40 = **30.0%**（报未匹配，其实有）
- **低估** **144 条** `not-portable` 它全算作「已匹配」（名字对上不代表行为在）

**两个方向同源：它只比对名字。** `check:behavior-evidence` 的 513/513 才是能回答
「行为在不在」的判据。**本轮不修它的匹配逻辑**——修了它仍然只比对名字，
保留原样并标注双向误差比让它看起来更准确要诚实。

### 513/513 不意味着什么

| 边界 | 说明 |
|---|---|
| **函数层 ≠ 行为层** | oracle 541 条内联测试中 **190 条**未匹配（第三轮裁定了 121 条，**仍有 92 条**未被本仓测试语料提及）。函数有证据 ≠ oracle 那条具体断言被复现 |
| **4 条真能力缺口** | AWS `vnd.amazon.eventstream` 二进制帧路径未移植；`bedrock-provider.ts` **只有 6 行占位**。513/513 **不代表 Bedrock 能用** |
| **live 与性能仍无门禁** | 两条边界第三轮已给出重估条件并当场答否，本轮维持 |
| **1 条证据偏弱** | `list_models` → `expect(models.length).toBeGreaterThan(0)`，证明的是「非空」不是「对」，已诚实标注 |

### 门禁

`check:behavior-evidence` 从 **282/282** 升到 **513/513** 且 `REQUIRE_COMPLETE = true`。
三个负控各自走完红→`assert`→绿：缺行（报「进度倒退」）· 假证据指注释行（报「不是断言行」）·
越界 `evidence_kind`（列出五个合法值）。

其余四个计数门禁**持平**：manifest 204/204 · surface-coverage 40/513 ·
inline-test-ports 190/541 · triage-ledger 121。

### 规模与验证

新增 3 个测试文件 / 15 例（**4397 → 4412**，只增不减）· 2 个脚本 · 7 份文档 ·
**`src` 触碰 0**（4 个改动文件全在 `test/` 下）。

`npm ci` → `build` → `check` → `test.sh` 四条 exit 全 0；密闭性增量 **0**；
parity 差异集**恰等**声明基线 8 项；self-check **3/3**；`test:live` 26 条全 environment、
**0 regression**；`src/cli/**` 本轮未触碰，S1 **DIFF 0**。

### 三次规则上移

1. **裁定键必须从名册生成**（同类失败第三次：phase 4 错 7 条行号 · phase 5 错 1 条文件名 ·
   phase 6 错 **14 条，连文件路径都发明了**）。改用 `awk` 从 `roster.tsv` 生成后一次通过。
2. **三步核替代符号名推断** —— `probe-ts-counterpart.mjs` 查文件与行数。
   三个校准探针的期望值**写于脚本存在之前**。
3. **探针自身的误配也记下来**：basename 退路把 `ai/src/event_stream.rs`（AWS 二进制帧）
   误配到 `utils/event-stream.ts`（oracle 另一个同名文件的对应物）。
   **三条正因人工复核才没被误判成「已移植」。**

## 6. 后续 backlog

`migration/post-parity-backlog.md` 是完整清点（154 条 grep 命中，非抽样）。按该交给谁排序：

**会无声变错（最该先修）**
- **V 桶 6 条**：硬编码的版本号字面量必须跟随 oracle 的 `Cargo.toml`，而 oracle 升版时**没有任何
  东西会提醒我们**。建议给 `npm run check` 加一条子检查把它变成硬失败。

**仍在台账上、phase 18 未修的 8 行（桶 Y，逐条论证过）**
- **B12** 最该先修：Responses 的 stopReason 只区分 `"incomplete"`，其余一切——**包括 API 明确
  报告的 `failed` / `cancelled`**——一律映射成 `Stop`，失败与取消被写进持久 transcript 呈现为正常结束。
- **B17** 次之：重放渲染双层括号，**judge 可观测**，是活的用户可见面。
- B7 / B10 / B11 / B14 / B15 / B16 逐条定级在案。

**状态面实测剩余 9 条（F7–F15）**
`migration/reviews/phase19/state-surfaces.md`。含未捕获异常泄漏安装路径、
usage 错误退出码与 oracle 不一致（1/0 vs 2）、`-c/--continue` 无会话时静默新建等。

**范围问题（留给用户决定，桶 W2）**
- 是否继续发布 `pi-ai` 这个 CLI——oracle 根本没有它。它把 OAuth 令牌写进 cwd 的**安全缺陷
  已在 phase 19 修掉**；剩下的是"要不要发布骨架带来的额外二进制"。
- TS 启动时间的惰性化改造。
- 三条随 vendor SDK 传递、进入发布包的 DoS 依赖（`ws` / `protobufjs` / `brace-expansion`）——
  单独提升需要动 `@google/genai` / `openai` / `@mistralai/mistralai` 的主版本。

---

## 7. 结论

kit Step 6 的 done-gate 达成并在干净环境复现：`npm ci` → `build` → `check` → `test` 四者 exit 0，
4125 个测试通过，parity 差异集恰好等于 D1–D8 的声明表。

需要说清楚的一件事：**"parity 全绿"从来不等于"移植正确"**。这次运行里最重的几个发现，
没有一个是 parity 自己报出来的——

- 系统提示与 25 个工具 schema 全是 pi 的（phase 17），靠逐字节比对请求体才暴露，而那一行在
  manifest 里标着 done；
- pie 相对 pi 的增量整块**零 importer**（phase 13 可达性审计），因为一个相对路径；
- `pie --version` 把版本号写到 stderr（phase 19），而判定器把两个流合并成一个文件，
  **结构上看不见**这一整类缺陷；
- `s8-bad-tail.sh` 的退出码断言写在 `|| true` 之后，**从来没有失败的能力**。

判定器本身也需要被判定。这次给它补了测试、提高了粒度、修了两处盲点——每一处都是先有一个
真实缺陷从旁边溜过去，才知道那里是盲点。
