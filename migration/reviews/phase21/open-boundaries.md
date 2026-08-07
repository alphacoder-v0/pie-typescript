# 三条开放边界的结论

MIGRATION-REPORT §5 里仍有三行「仍开放」。本 phase 给每一行一个结论。

**每节三段，缺一不可**：代价（维持现状损失了什么）· 理由（为什么仍然维持）·
重估入口（**什么条件出现时该改变这个决定**）。

重估入口必须写成**今天就能回答「是 / 否」的条件**，并当场作答。写成「以后再评估」
「视情况而定」的，等于没写——那正是这三行在报告里挂了两轮的原因。

---

## 边界 1 — `--builtin-skill` 未并入 skill loader（**本 phase 关闭**）

### 现状（关闭前）

phase 19 修好了**校验**（未知名称硬失败），但解析出的名字**没有并入 skill loader**，
`config.toml` 的 `[builtin_skills] enabled` 也没被读。用户传 `--builtin-skill <已知名>`
不会报错，也不生效——**静默无效**。

接线的记录见本文件末尾「边界 1 的接线」。

---

## 边界 2 — live provider 不进门禁（**维持现状**）

### 代价

密闭门禁看不见的东西，具体是这些：

1. **上游协议漂移**。provider 加字段、废字段、改错误码，密闭 fixture 不会跟着变。
   本仓的 fixture 是**当初抄下来的那一份**，它永远「正确」。
2. **凭据与网络路径的回归**。`getApiKey` 的解析链、`baseUrl` 路由、代理与 `NO_PROXY`
   处理（D11）—— 这些只有真的发一次请求才会暴露。
3. **模型退役 / 配额形态**。本机 `npm run test:live` 当前唯一的失败正是这一类的近亲：
   Gemini `context-overflow` 用例要触发真实的上下文溢出，但本账号配额是
   1,000,000 tokens/分钟，**429 必然先于溢出错误到达**。该用例要求「账号配额 > 模型上下文窗口」，
   本账号不满足——归类为 environment 而非 regression。

代价是真实的。`test:live` 是**证据**而不是门禁，意味着没有人被强制去跑它；
它是否被跑取决于纪律，而纪律会松。

### 理由

三条，都不是「懒得做」：

1. **CI 不该烧钱**。710 个 live 用例每次全绿要打真实 provider，成本按次计。
2. **CI 不该因第三方限流而红**。上面那条 Gemini 失败就是活例——它红不是因为代码错了，
   是因为账号配额与模型上下文窗口的比例不满足。一个会因别人的限流策略而红的门禁，
   会训练所有人忽略它。
3. **凭据不该进 CI**。干净 clone + `npm ci` 的机器必须能跑通全套——这是本仓「可复现」
   的底线。把 provider key 放进 CI secrets 就是给一台共享机器发一份长期凭据。

所以这是**刻意的分工**：`bash test.sh`（4313 条，密闭）是门禁，
`npm run test:live` 是证据。不是漏做。

### 重估入口（今天可答是 / 否）

> **条件**：某个 provider 的 SSE / 错误信封协议，在最近 90 天内出现 ≥2 次**不兼容**变更
> （即密闭 fixture 需要跟着改才能反映真实行为）。

**今天的答案：否。** 本轮与前两轮共 29 个 phase 里，没有一次因上游协议变更而修改过
`packages/ai/test` 下的 fixture；`intentional-divergences.md` 的 13 条声明也没有一条源于协议漂移。

若哪天答案变成「是」，正确的做法**不是**把 710 条整套搬进门禁，而是挑出
「不花钱、不受限流影响」的那一类做成门禁——例如 401 的归因、`baseUrl` 路由的落点、
`NO_PROXY` 的遵守。这些用一个**本地** HTTP fixture 就能测，本轮 phase 4 的
`local-models-stream-batch-c.test.ts` 已经示范了这套装置怎么搭。

---

## 边界 3 — 性能无公平基准（**维持现状**）

### 代价

1. **无法回答「TS 版比 Rust 版慢多少」**。这是用户会问的第一个问题，而现在只能给
   一个带一堆前提的数字。
2. **发现不了性能回归**。没有阈值就没有告警；启动时间从 860ms 涨到 2s，
   除非有人手动去量，否则不会有任何东西变红。

第二条比第一条重要：跨语言的绝对对比意义有限，但**本仓与自己的过去比**是有意义的，
而现在连这个都没有自动化。

### 理由

`migration/reviews/phase19/perf-baseline.md` 已经把话说清楚，这里只提炼：
**一个不公平的数字比没有数字更糟——它会被引用。**

需要控制而当前控制不了的变量至少有四类：静态链接的 Rust 二进制 vs Node 的模块图、
JIT 预热、进程模型、provider 延迟。在这些没被隔离之前设阈值，得到的是一个
随机器与负载漂移的假门禁——它红的时候没人知道是代码退步了还是机器忙。

### 粗基准（判据 6 要求：给出，或明说给不出）

**给得出，但只在一个很窄的范围内成立。** 已有的实测（phase 19，同机、同 ext4 分区、
`npm run build` 紧接测量）：

```
TS 启动     ~860 ms
oracle 启动 ~7.5 ms
其中 Node 运行时本身只占 ~4%，其余是应用模块图
```

**它不公平在哪**（不写清楚就不该给这个数字）：

- Rust 侧是静态链接的原生二进制，冷启动只有 `exec` + 少量 syscall；
  TS 侧要起 Node、解析并执行一整棵模块图。这不是同一件事的两种实现，是两种交付形态。
- 测量在一台 251 GiB 内存里已用 198 GiB 的机器上做的，页缓存状态不可复现。
- 未做多次采样与分位数统计，是单点数。

**它不能用来做什么**：不能作为验收阈值，不能对外引用为「移植的性能代价」，
不能用来比较两侧的**运行时**性能（它只测了启动）。

**它能用来做什么**：作为本仓与自己未来版本比较的一个锚点——同机、同方法重测，
若 860ms 变成 2000ms，那是本仓自己的退步，与 Rust 无关。

### 重估入口（今天可答是 / 否）

> **条件**：启动时间成为一条真实的用户抱怨（issue / 反馈里出现），
> 或本仓自测的启动时间相对上一次记录劣化 ≥50%。

**今天的答案：否。** 本仓无面向外部用户的 issue 追踪；`perf-baseline.md` 是唯一记录点，
本轮未重测（本轮改动全在测试与文档，`src` 净改动只有 phase 2 的 `mergedModels()`
与 phase 5 的一段注释，不触及启动路径）。

若答案变成「是」，第一步**不是**设阈值，而是做模块图的懒加载分析——
先知道那 860ms 里哪些是必须的，再谈门槛。

---

## 本 phase 新发现的第四条边界

phase 5 的密闭性核查查出一条此前没记录的：

> **密闭测试入口仍向真实 `~/.pie/sessions/` 写入。**

跑一次 `bash test.sh`，真实 `~/.pie/sessions/` 会多出十几个会话文件（已累积 3634 个）。
归因：测试把 **cwd** 隔离到了 `/tmp/pi-runtime-*`，但**存储根没隔离**——`SessionManager`
的存储根来自 `getAgentDir()`，也就是真实 `$HOME/.pie`，再按 cwd 哈希分目录。

### 代价

违反本仓「测试必须密闭」的硬约束。具体损失：跑测试会污染开发者的真实会话目录；
`~/.pie/sessions` 的内容不再能反映「用户真的开过哪些会话」。

### 理由（为什么本轮不修）

做过一次有界实验：`test.sh` 里 `export PIE_DIR="$(mktemp -d)"`。

| | 结果 |
|---|---|
| 泄漏 | **堵住** —— 真实 `~/.pie/sessions` 0 新增 |
| 代价 | **12 条测试红**，分布在 `package-command-paths.test.ts`、`theme-export.test.ts`、`suite/regressions/2791-fswatch-error-crash.test.ts` 等 4 个文件 |

那 12 条依赖真实 `~/.pie` 下的 `bin/` 与主题文件，各自需要自己的夹具。不是一行修复。
本轮的范围是「裁定 121 条 + 分层 473 个 + 三条边界」，把 12 条测试改夹具属于新工作，
硬塞进来会让本轮的每一条结论都带上「顺手改了别的东西」的不确定性。

实验已还原，`test.sh` 与备份逐字节一致，套件恢复 4313 全绿。

### 重估入口（今天可答是 / 否）

> **条件**：这 4 个文件里的 12 条测试已各自获得不依赖真实 `~/.pie` 的夹具。

**今天的答案：否**（0/12 已改）。一旦答案变成「是」，`test.sh` 加一行
`export PIE_DIR="$(mktemp -d)"` 即可收口——实验已经证明那一行是充分的。

---

## 边界 1 的接线

### 接线前后：一句话

传 `--builtin-skill karpathy-guidelines`，技能目录**从 1 条变成 2 条**。接线前是 1 条——
名字被校验、被解析、被丢掉。

### oracle ↔ TS 逐段对照

**① 解析两个来源**

```rust
// oracle: crates/coding-agent/src/main.rs:690-702
let config_enabled_builtins = read_builtin_skills_config(&config::base_dir()).await;
let resolved_builtins =
    match builtin_skills::resolve_builtins(&cli.builtin_skill, &config_enabled_builtins) {
        Ok(r) => r,
        Err(e) => { eprintln!("error: {e}"); std::process::exit(2); }
    };
```

```ts
// TS: packages/coding-agent/src/main.ts（本 phase 之前就已存在，phase 19 的 F3）
configEnabledBuiltins = parseBuiltinSkillsConfig(readFileSync(join(agentDir, "config.toml"), "utf8"));
const resolvedBuiltins = resolveBuiltins(parsed.builtinSkills ?? [], configEnabledBuiltins);
// catch: UnknownBuiltinSkillError → stderr `error: …` + process.exit(2)
```

**② 合并进技能目录 —— 这一段此前完全缺失，是本 phase 补的**

```rust
// oracle: main.rs:703-706
let mut combined_skills = builtin_skills::merge_with_user_project(
    resolved_builtins.skills.clone(),
    &loaded_skills.skills,
);
```

```ts
// TS: packages/coding-agent/src/core/skills.ts（新增 mergeSkillsWithBuiltins）
return { ...loaded, skills: mergeWithUserProject(asSkills, loaded.skills) };
// 调用点：core/resource-loader.ts updateSkillsFromPaths()
const withBuiltins = mergeSkillsWithBuiltins(skillsResult);
```

**③ 合成路径**

```rust
// oracle: builtin_skills.rs:141-152
file_path: format!("<builtin>/{}/SKILL.md", spec.name),
source: SkillSource::Builtin,
```

```ts
// TS: core/skills.ts
export const BUILTIN_SKILL_BASE_DIR = "<builtin>";
filePath: b.filePath,          // `<builtin>/<name>/SKILL.md`，与 oracle 同格式
sourceInfo: createSyntheticSourceInfo(b.filePath, { source: "builtin", … })
```

**④ 顺序差异（唯一一处刻意的结构性偏离，行为等价）**

oracle 在**构造 harness 时**合并：磁盘目录先加载好，解析完内置再 `merge`，合并结果直接
`opts.skills = combined_skills`。本仓的 session 建得更早——技能目录在解析内置**之前**就装好了。
所以解析点必须显式说一句「现在重新合并」：

```ts
setEnabledBuiltinSkills(resolvedBuiltins.skills);
session.resourceLoader.refreshSkills();   // 本 phase 新增的窄接口
```

`refreshSkills()` 只重跑已解析路径的技能合并，不做 `reload()` 的 settings 重载 / 包管理器解析 /
扩展重解析。等价性由端到端探针与单测共同证明（下两节）。

### 端到端实证（密闭：`env -i` + 临时 HOME，无任何凭据入环境）

配方取自 `migration/parity/lib/common.sh` 的 `run_pie`——与 parity 场景同一套。
磁盘上放一条 `probe-skill` 作对照物，看启动行 `loaded N skill(s)`：

| # | 条件 | 启动行 |
|---|---|---|
| A | 无 flag、无 config | `loaded 1 skill(s): probe-skill` |
| B | `--builtin-skill karpathy-guidelines` | `loaded 2 skill(s): karpathy-guidelines, probe-skill` |
| C | `config.toml` 的 `[builtin_skills] enabled = ["karpathy-guidelines"]` | `loaded 2 skill(s): karpathy-guidelines, probe-skill` |
| D | `--builtin-skill no-such-skill` | `error: unknown built-in skill(s) …. Available: karpathy-guidelines.`，**退出码 2** |
| E | 磁盘上放同名 `karpathy-guidelines` | `loaded 1 skill(s): karpathy-guidelines`，`/skills` 显示 `(user)` + 磁盘版描述 |

B/C 证明两个来源都真的生效；顺序（内置在前）与 oracle 的
`merge_with_user_project` 一致；D 证明 phase 19 的硬失败没被这次改动破坏；
E 证明遮蔽方向是「用户/项目压过内置」，不是反过来。

### 接线过程中的两个真实故障（都由端到端探针查出，单测查不出）

**① 发布了，但真正的消费方不读。** 第一版把合并写进 `tools/skill.ts` 的
`loadEffectiveSkills`。build 干净、注册表填得好好的，`--builtin-skill` 依然**静默无效**——
`/skills`、启动行、系统提示目录读的全是 `services.resourceLoader.getSkills()`，
那条路径由 `core/resource-loader.ts` 自己的 `loadSkills(...)` 供数，跟我改的那个函数没关系。
这与 phase 2 的 `/model` 缺陷是**同一型**：注册表的价值等于读它的消费方集合。
教训落到了测试里——`builtin-skill-wiring.test.ts` 全部断言打在 `ResourceLoader.getSkills()` 上，
断言 `enabledBuiltinSkills()` 的写法在坏版本上照样绿。

**② 合成路径撞上 `statSync`。** 接好之后 CLI 直接 ENOENT 崩在打印任何一行之前：
`<builtin>/karpathy-guidelines/SKILL.md` 是 oracle 自己的格式、按定义不存在，而
`getDefaultSourceInfoForPath` 的兜底分支以 `statSync(normalizedPath)` 结尾。原判据只认
**整段** `<...>`，认不出「首段是 `<...>`」。改的是那个判据，不是路径格式——
路径格式必须与 oracle 逐字一致。

两个都不是「想不到的边角」，都是**只有把二进制真的跑起来才会暴露**的东西。

### 单测与负控

`packages/coding-agent/test/builtin-skill-wiring.test.ts`，6 条，全部断言 `getSkills()`：
无请求不引入内置 · 内置在前 · 同名遮蔽（1 条、描述取磁盘版）· config 来源同样生效 ·
合成路径不落盘 · `refreshSkills` 的增量恰为内置本身（且没挤掉别的）。

断言取**差分**形态（内置有没有出现 / 是不是只有一条），不是「目录恰等于这个列表」。
理由不是放水：`test.sh` 对环境变量密闭，但**存储根不密闭**——按硬约束不得覆盖 `HOME`，
于是 loader 连开发者真实 `~/.pie/skills` 一起扫了（本机 21 条，干净 CI 上 0 条）。
绝对列表断言在这台机器上根本不可判定，差分形态测的是同一个行为且不受这个噪声影响。
这条噪声的来源正是本文件上一节记的**第四条边界**。

负控三个变异，每个都先 `assert` 锚点唯一命中、变异标记确实写进文件，还原后再 `assert` 无残留：

| 变异 | 内容 | 结果 |
|---|---|---|
| M1 | `resource-loader.ts` 跳过内置合并（复刻故障①的形态） | 套件变红 ✓ |
| M2 | `skills.ts` 合并方向反转（内置遮蔽磁盘） | 套件变红 ✓ |
| M3 | 合成路径识别退回「整段 `<...>`」（复刻故障②） | 套件变红 ✓ |

还原后复跑仍绿。

### 命令与结果

```
npm run build                          exit 0
npm run check                          exit 0（9 道门禁）
                                       surface-coverage 未匹配 40/513（基线 40）
                                       inline-test-ports 未匹配 190/541（基线 219）
                                       triage-ledger 121 条，TODO 0
bash test.sh                           exit 0 — 4319 passed / 0 failed
                                       （agent 450 · ai 488 · coding-agent 2706 · mcp 46 · tui 612 · workers 17）
                                       基线 4290 → +29，只增不减
bash migration/parity/run-parity.sh --scenarios S1
                                       ALL SCENARIOS: DIFF 0 — PARITY: GREEN
                                       （`main.ts` 与 cli 相邻改动未动 `pie --help` 一个字节）
```

### 顺带修掉的接口债

`ResourceLoader` 接口新增 `refreshSkills()` 后，仓内 5 处内联 stub loader
（`examples/sdk/12-full-control.ts`、`test/sdk-codex-cache-probe-tool-loop.ts`、
`test/sdk-skills.test.ts` ×2、`test/utilities.ts`）由 tsgo 逐个报出并补齐。
这正是「接口是必填的」该有的样子——漏一个就编译不过，不会有 stub 悄悄行为不一致。
