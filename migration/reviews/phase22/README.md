# phase 22 — 给「只验证了名字对得上」的函数补行为证据

第四轮 supergoal（`.supergoal/pie-medium-149-low-td9AgT`）的落地区。

## 问题是什么

`check:surface-coverage` 证明 oracle 的 513 个公开函数在 TS 侧**都有同名对应物**，
未匹配只剩 40 个。但那个门禁的文件头自己写明：它守不住「移了但移错」。

上一轮把 473 个这样的函数分了三层（`scripts/classify-surface-risk.mjs`）：

| 层 | 判据 | 数量 | 上一轮的处置 |
|---|---|---|---|
| high | 命中凭据 / 网络 / 文件写 / parity-path 风险规则 | 45 | **100% 补齐行为证据** |
| medium | 未命中风险规则，但 depmap 里被 **≥2 个模块引用** | 149 | 仅记录 |
| low | 未命中风险规则，且被 <2 个模块引用 | 279 | 仅记录 |

本轮处理 medium 全量 + 从 low 里按新判据捞出的一批。

## 为什么不能直接「low 层不重要，跳过」

因为 low 的判据只是**扇入**，与重要度无关。按行号等距抽样 15 个（非挑选）就能看到：

| 函数 | 它是干什么的 | 错了会怎样 |
|---|---|---|
| `agent/src/harness/compaction/compaction.rs::estimate_context_tokens` | 上下文压缩的 token 估算 | 静默丢上下文——模型突然「忘了」前面说过的话，没有任何错误信息 |
| `coding-agent/src/lsp.rs::did_open` | LSP `textDocument/didOpen` 通知 | 语言服务器拿不到文件内容，诊断全空 |
| `agent/src/harness/session/session.rs::append_thinking_level_change` | 往会话 JSONL 追加一条思考等级变更 | 会话记录缺失或串行，不可逆 |

`classify-surface-risk.mjs` 的文件头自己也写了「`low` 层出错一样会伤人」。

## 本轮的三条判据（`scripts/classify-behavior-impact.mjs`）

只作用于 low 层，**与扇入无关**。每条都能独立说清「为什么这类函数出错会伤人」——
说不清的规则就是凑数，会把名册灌水成一个没人看的清单。

| 规则 | 定义 | 命中 | 为什么这类出错会伤人 |
|---|---|---|---|
| **B** `oracle-tested` | 函数名在其所在 `.rs` 的 `#[cfg(test)]` **块正文里被调用** | 70 | oracle 作者自己认为它有值得验证的行为——最客观的重要度代理，不掺我的判断 |
| **C** `mutating` | 函数名以状态变更动词开头（`save`/`write`/`append`/`delete`/`remove`/`set`/`apply`/`merge`/`persist`/`flush`/`insert`/`update`/`clear`/`store`/`commit`/`rename`/`move`/`create`） | 26 | 出错会写坏或丢掉持久化数据，后果不可逆 |
| **D** `fallible` | oracle 签名返回 `Result` | 56 | 有失败路径，而失败路径是移植中最容易走样的地方——`BUG(port)` 台账里多条正是错误处理 |

**B∪C∪D = 133 / 279**，未捞出 146。

### 判据 B 踩过一次坑，记在这里免得重犯

第一版写成「oracle 内联测试**名**含该函数名」，只命中 **17** 个，且漏掉
`ai/src/utils/hash.rs::short_hash`——oracle 那条测试叫 `produces_deterministic_output`，
名字里根本没有 `short_hash`，但测试体里调用了它。

改成「在 `cfg(test)` 块**正文**里被调用」后命中 **70**，四个探针全部捞出。
**不要退回名字匹配。**

## 名册

`roster.tsv`，283 行（1 表头 + 282 条），六列：

```
oracle_file	fn_name	oracle_line	source	rule_hit	batch
```

- `source`：`medium`（149）| `low`（133）
- `rule_hit`：medium 行为 `-`；low 行为命中规则的逗号连接（如 `B,D`），**不得为空**
- `batch`：`A`/`B`/`C`/`D`/`E1`/`E2`，由脚本算出

### 为什么要有 `oracle_line`

同一个 `.rs` 里可以有多个同名函数——不同 `impl` 块各自的构造器是最常见的一种。实测两例：

- `agent/src/harness/types.rs` 的 `new`：`FileError::new`(52) 与 `ExecutionError::new`(83)
- `ai/src/types.rs` 的 `text`：两个类型各自的构造器(269 / 288)

它们是**两个不同的函数**，不是重复数据，名册必须各留一行。所以唯一键是
`<oracle_file>::<fn_name>@<oracle_line>`，不能只用 `<file>::<fn>`。

这个缺陷是门禁第一次跑就抓出来的——名册当时按 `file::fn` 建键，两条撞车。
门禁在建成后的第一分钟就付清了自己的成本。

## 分批

| 批 | 主题 | 规模 | 主要文件 |
|---|---|---|---|
| A | 会话与历史 | 52 | `coding-agent/src/session/mod.rs` 15 · `agent/src/harness/session/session.rs` 15 · `history.rs` 7 |
| B | 触发器与目标 | 45 | `triggers/dynamic.rs` 12 · `triggers/cron.rs` 10 · `goal.rs` 8 · `inbox.rs` 6 |
| C | agent 主循环 | 49 | `agent_harness.rs` 13 · `agent.rs` 12 · `compaction.rs` 5 · `cost.rs` 5 |
| D | ai + mcp | 53 | `api_registry.rs` 6 · `utils/event_stream.rs` 6 · `ai/types.rs` 5 · mcp 9 |
| E1 | coding-agent 其余·上半 | 42 | `skills_state.rs` 8 · `config.rs` 7 |
| E2 | coding-agent 其余·下半 | 41 | `spinner.rs` 6 · `tools/mod.rs` 6 · `model_picker.rs` 5 |

校准 phase（phase 3）从**六批各取 5 个** = 30，先量出 `existing-test` 命中率再决定粒度。

## 证据表

`evidence.tsv`，三列：

```
fn_name	evidence_kind	evidence
```

- `fn_name`：名册的唯一键 `<oracle_file>::<fn_name>@<oracle_line>`
- `evidence_kind`：`existing-test` | `new-test`，**无第三类**
- `evidence`：`<path>:<line>`，且**那一行必须含 `expect(` 或 `assert`**

## 这套判据守不住什么

写在这里是因为它必须被知道，不是因为它可以被原谅。

1. **纯函数 + 不可失败 + oracle 没测的，三条规则都捞不到。**
   `ai/src/utils/hash.rs::short_hash` 差一点就是这种——它得救只是因为 oracle 恰好测了它。
   同类的还有 `coding-agent/src/spinner.rs` 里的纯格式化函数、`ai/src/utils/` 下的一批小工具。
   这类**本轮不补**：没有任何客观信号说它重要，硬补就退回主观挑选，
   而主观挑选无法复算、无法交接、下一轮没人能验证我当初为什么挑了这些而不是那些。

2. **规则 D（返回 `Result`）会把「几乎不可能失败」的也算进来。**
   一个只在 OOM 时返回 `Err` 的函数和一个解析用户输入的函数，在这条规则下同权。
   代价是名册里有一部分低价值项；收益是规则可枚举、可复算。这个交换是刻意的。

3. **规则 C 按函数名前缀匹配，会漏掉不以动词开头的变更函数。**
   例如一个叫 `bump_counter` 或 `mark_done` 的函数不会被 C 捞到。
   动词表刻意保守（不收 `handle`/`process` 这类语义模糊的），宁可漏掉，不可灌水。

4. **`existing-test` 证明「有一条断言涉及这个函数」，不证明「这条断言真的驱动了它」。**
   后者是抽查的活：每批抽 `max(5, ⌈本批 existing-test 数 / 3⌉)` 条，
   逐条回答「这条断言失败时，被测函数是否一定出错？」——答不上来就退回重找。
   门禁只能守形式（那一行确实是断言行），实质要人守。

## 门禁

`scripts/check-behavior-evidence.mjs`，已挂进 `npm run check`。四项校验：

1. 名册每行在 oracle 中真实存在（守 oracle 漂移与手抄错字）
2. 名册规模钉死 282，键唯一
3. `evidence_kind` 在允许集合内，同一函数不重复裁定
4. evidence 指向的文件存在，行号在范围内，**且那一行含 `expect(` 或 `assert`**

第 4 条是上一轮**三次同类失败**后从人守上移为机器守的规则（批次 A 指到 `it(...)` 行、
批次 B 一行被两条测试复用、批次 C 指到 setup 行）。逐字沿用，不得放宽。

**它明确不做的事**：不把「证据表 == 某个动态集合」当不变量。
上一轮第一版门禁正是这么写的，一移植就误报 15 条。名册是固定花名册，规模钉死。
