# phase 21 — 121 条未裁定 oracle 内联测试的逐条裁定

## 这批 121 条是怎么来的

`scripts/check-inline-test-ports.mjs` 扫 oracle 的 `#[cfg(test)]` 块，抽出 541 条
`#[test]` / `#[tokio::test]` 函数名，两侧做 `[^a-z0-9]+ → 空格` 归一化后在本仓
`packages/*/test/**.ts` 语料里找子串。**未匹配 219 条。**

那 219 不是缺口数，是**上界**——脚本文件头自己写明了两个方向的误差：

- **假阴性（高估缺口）**：本仓测试用散文命名。phase 20-5 实测过，按下划线原名 grep 时
  `builtin_skills.rs` 的 19 条全被误判为缺口，归一化后降到 2 条。
- **假阳性（低估缺口）**：名字碰巧出现在注释或另一条测试的描述里就算命中。名字在 ≠ 行为被断言。

所以 219 条里的每一条都要人打开 oracle 的测试体、读懂它断言什么、再去 TS 里找对应断言。
上一轮 supergoal（pie-AU3RVU）核过其中 **98** 条并留下了 TS 行号，剩 **121 条从未逐条看过**。
本轮把这 121 条裁完。

## 台账 schema

`triage-ledger.tsv`，制表符分隔，122 行（1 表头 + 121 条）：

```
oracle_file	test_name	batch	verdict	evidence	note
```

| 字段 | 含义 |
|---|---|
| `oracle_file` | 相对 oracle 根、去掉 `crates/` 前缀的路径 |
| `test_name` | oracle 里的 `fn` 名（原下划线形式） |
| `batch` | A–E，见下方分批表 |
| `verdict` | `covered` \| `not-portable` \| `gap` \| `TODO` |
| `evidence` | `covered` → `<ts_path>:<line>`；`gap` → 移植后的测试文件路径；`not-portable` → 空 |
| `note` | `not-portable` 必填理由（≥20 字符）；其余可选 |

台账由 `node scripts/check-triage-ledger.mjs --generate` 从 oracle **实扫**生成，不是手抄。

### 名册是固定的，不随移植进度变化

门禁校验三件事，**三个方向各不相同**：

| # | 校验 | 守的是 |
|---|---|---|
| a | 名册每一行都是 oracle 里真实存在的 `#[test]` | oracle 漂移、手抄错字 |
| b | 名册规模恰为 **121** | 「把难判的那几条悄悄删掉」 |
| c | 当前仍未匹配的 oracle 测试**都在名册内** | 「oracle 新增了测试却没人裁定」 |

**反方向不查**，这一条是 phase 2 用一次门禁误报换来的：移植一条 `gap` 时，新测试文件的注释里
会写上 oracle 的测试名（可追溯性要求如此），归一化子串扫描于是**命中**了它，该条正当地退出
「未匹配」集合。第一版门禁把「名册 == 当前未匹配集」当成不变量，一移植就报「台账多出条目」；
照那个定义走下去，121 条全移植完 = 门禁报 121 处错误，而「121 条都裁定过」这个事实反而无法
表达。

所以名册里的条目退出「未匹配」集合是**进度**，脚本把它当指标报出来（`名册中仍未被本仓测试
语料提及：N 条`），不是错误。

## 三类 verdict 的判定标准（写死，五个批次共用）

不设第四类。`TODO` 只是「还没看」，不是裁定结果。

### `covered`

本仓存在一条测试，它断言的**行为**与 oracle 那条测试断言的行为相同。**不要求同名、不要求同粒度**
——本仓测试是散文命名的，粒度也常常不同（oracle 一条 = 本仓一个 `describe` 里的两条，或反过来）。

`evidence` 指向**那条断言所在的行**，不是 `describe` 行、不是文件首行、不是 import 行。

**不算 `covered` 的情况**（这些是 `gap`）：
- 本仓有测试调用了同一个函数，但断言的是别的东西
  （oracle 断言 `unknown_model_error_lists_candidates` 会列出候选模型名，本仓只断言了抛错）
- 本仓的断言比 oracle 弱一个数量级（oracle 断言具体 ANSI 转义序列，本仓只断言「渲染结果非空」）
- 只有类型层面的对应（TS 里有个同名函数，但没有任何测试断言它的输出）

### `not-portable`

该测试断言的是 Rust / 平台特有的东西，在 TS 侧**物理上不存在对应面**：

- Rust 类型系统行为（trait 解析、生命周期、`impl` 特化）
- `unsafe` 语义、内存布局
- 特定 crate 的内部表示
- Rust 专有的 panic 语义（`should_panic` 断言的是 `panic!` 而非 `Err`）

`note` 必须说清**是上述哪一类**。**不接受**「TS 不适用」「不涉及」「没有对应概念」这类空话——
它们是所有难题的垃圾桶。

某些批次有更严的规则：批次 B 的 8 条凭据泄漏相关项、批次 D 的 2 条数据安全项，
**都不接受 `not-portable`**，除非能论证 TS 侧物理上不存在该泄漏面 / 该数据破坏路径。

### `gap`

行为在 oracle 有明确期望，本仓无对应断言。**必须移植**，`evidence` 指向移植后的测试文件。

移植两条纪律（都来自本仓踩过的坑，详见
`.supergoal/pie-112-1vuLwY/phases/TRIAGE-DISCIPLINE.md`）：

1. **先看 oracle，再写 TS。** 照着 TS 现有行为写断言，测试当然绿——但它固化的是 bug，不是
   oracle 合同。上一轮的 `truncateLine`（长行截断丢掉了匹配本身）与 oauth authorize-URL
   （多了个 `code=true`、参数顺序不对）两个真缺口都是先读 oracle 才发现的。
2. **配负控，且负控必须证明变异真的落地。** 上一轮出过一次假通过：`replace(target, ..., 1)`
   命中了文件里第一处同形代码而非目标分支，测试照样绿，看起来像「这条断言毫无价值」，
   实际是变异根本没生效。变异脚本必须带 `assert`。

## 分批（按判定视角切，不按数量切）

同一判定视角的条目放一起，人才不会在「凭据脱敏」和「markdown 渲染」之间反复切换心智模型。

| 批 | 主题 | oracle 文件 | 条数 |
|---|---|---|---|
| **A** | CLI 与命令面 | `commands.rs` 18 · `main.rs` 13 | **31** |
| **B** | 凭据与安全 | `auth.rs` 6 · `mcp_loader.rs` 5 · `debug.rs` 3 · `bug_report.rs` 2 · `ai/utils/oauth/anthropic.rs` 2 · `hooks.rs` 1 | **19** |
| **C** | 模型与技能配置 | `skills_state.rs` 11 · `local_models.rs` 10 · `model_picker.rs` 8 · `builtin_skills.rs` 2 · `model.rs` 1 | **32** |
| **D** | 会话归档与恢复 | `session_archive.rs` 7 · `resume_picker.rs` 5 · `agent_session.rs` 1 | **13** |
| **E** | 渲染 / 输入 / 媒体 / ai 剩余 | `markdown.rs` 6 · `images.rs` 5 · `mentions.rs` 5 · `readline.rs` 2 · `clipboard_image.rs` 1 · `ai/providers/faux.rs` 2 · `ai/utils/overflow.rs` 2 · `ai/providers/anthropic.rs` 1 · `ai/utils/abort.rs` 1 · `ai/vertex_provider.rs` 1 | **26** |

**合计 121。** 分批表在 `scripts/check-triage-ledger.mjs` 的 `BATCH_OF_FILE` 里是数据，
门禁校验每行的 `batch` 值合法——但**这张表和那份数据是两处**，改一处要同步另一处。

## 抽查纪律（对抗橡皮图章）

121 条逐条读是枯燥重复劳动。最容易的失败模式不是判错，是**判懒**：看到 TS 里有个名字相近的
文件就写 `covered`，从不打开那一行看断言到底断言了什么。这样做出来的台账看起来是 121/121，
**实际证据强度为零**——比没有台账更糟，因为它让后来的人以为这里查过了。

**每个批次 phase 必须抽查 `max(5, ⌈本批 covered 条数 / 3⌉)` 条**，把 oracle 断言原文与
`evidence` 指向的那一行 TS 断言原文**并排贴进 transcript**。

加下限 5 是因为 D 批只有 13 条，纯 1/3 会退化成 3 条，样本太小说明不了什么。

**抽样必须先定规则再看结果**，规则可复述（例如「把本批 `covered` 按台账行号升序编号，取编号
≡ 0 (mod 3) 的」）。**不许跑完再挑好看的**：事后挑选证明的是「存在几条做对了」，抽查要证明的是
「随便挑一条都做对了」，两者不是一回事。

## 这套装置守不住什么

`check-triage-ledger.mjs` 能验证 `evidence` 指向的那一行**存在**，**不能**验证那一行
**真的断言了 oracle 断言的东西**。后者只有人读才能判断。

所以：**机器守形式，抽查守实质，两者缺一不可**。门禁绿 + 无抽查 = 一张漂亮的空表。

它也不能防止有人把难判的条目一律写成 `not-portable` 再编 20 个字。那靠的是抽查，以及
批次 B / D 里「这几条不接受 `not-portable`」的硬规则。
