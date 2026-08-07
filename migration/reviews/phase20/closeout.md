# phase 20-10 · 覆盖率门禁与最终收口

## 1. 第三个计数进门禁

`scripts/check-inline-test-ports.mjs`，已接入 `npm run check`（在 `check:surface-coverage`
与 `check:manifest` 之间）。

```
check:inline-test-ports: OK — oracle 内联测试 541 条，未匹配 219 条（移植率 59.5%），基线 219
```

立项时是 46%，本轮到 **59.5%**。

**为什么需要第三个**：前两个都可能在「名字对得上、行为不对」时通过——
`check-surface-coverage.mjs` 的文件头自己写明了这点。三者分工：

| 计数 | 守的是 | 当前值 |
|---|---|---|
| `check:manifest` | **文件层** | 204/204，missing=0 extra=0 dups=0 |
| `check:surface-coverage` | **签名层** | 513 个 pub fn 中未匹配 40（基线 40） |
| `check:inline-test-ports` | **行为层** | 541 条断言中未匹配 219（基线 219） |

**方法两个方向的错**已写进脚本文件头：散文命名导致假阴性（phase 20-5 实测过：
按下划线原名 grep 时 `builtin_skills.rs` 的 19 条全被误判为缺口）；名字碰巧出现导致假阳性。
所以它是**基线守卫**，不是完整性证明。

### 门禁负控（两条，实测）

| # | 操作 | 结果 |
|---|---|---|
| 1 | 基线 219 → 218 | `FAIL — … 基线是 218，新增 1 条未匹配` **红** |
| 2a | `sources.env` 里删掉 `ORACLE_PIE_DIR` | `SKIP — sources.env 里没有 ORACLE_PIE_DIR`，exit 0 |
| 2b | `ORACLE_PIE_DIR` 指向不存在的路径 | `SKIP — ORACLE_PIE_DIR 指向 /nonexistent/path/xyz，但其下没有 crates/`，exit 0 |

2a 与 2b **措辞不同**——这是刻意的：混为一谈就分不清「环境正常缺失」与「配置写错了」，
而后者是需要有人处理的。

## 2. `npm ci` 干净环境全套

```
npm ci                                exit 0
npm run build                         exit 0
npm run check                         exit 0（8 道门禁，含新增的第三计数）
bash test.sh                          exit 0 — 4273 passed / 0 failed
                                      （agent 450 + ai 484 + coding-agent 2664 + mcp 46
                                        + tui 612 + workers 17）
bash migration/parity/run-parity.sh   exit 1（预期）— 差异文件恰好 8 个 = 声明基线
```

parity 差异集逐行核对：`S3/requests.norm 2` · `S3/run.norm 8` · `S3/session.norm 12` ·
`S5/req2body.norm 2` · `S6/session.norm 24` · `S8/list.norm 2` · `S8/resumeerr.norm 2` ·
`S8/resumeexit.norm 2`。S1/S2/S4/S7 与 S9–S12 全 DIFF 0。

## 3. judge 自检

```
[SELF] ALL SCENARIOS: DIFF 0
M1 (usage mutation):     DETECTED
M2 (catalog mutation):   DETECTED
M3 (corruption toggle):  DETECTED
MUTATIONS DETECTED: 3/3
```

oracle 自差分零差异，三处注入突变 3/3 检出——判定器本身仍然有判别力。

## 4. `npm run test:live`

```
exit 1 — 1 failed | 509 passed | 684 skipped（ai 包）
凭据：仅 GEMINI_API_KEY 在场
```

密闭下 ai 包是 484 passed，live 解冻了 **25 条**。

**唯一失败逐条归类**：

| 用例 | 归类 | 依据 |
|---|---|---|
| `context-overflow.test.ts > Google > gemini-2.5-flash - should detect overflow via isContextOverflow` | **environment**（非 regression） | 它必须发送超过模型上下文上限的输入才能触发溢出，而本账号配额恰是 1,000,000 tokens/分钟——**429 必然先于上下文错误到达**。报错正文自证：`limit: 1000000, model: gemini-2.5-flash`、`RESOURCE_EXHAUSTED`。该用例要求「账号配额 > 模型上下文窗口」，本账号不满足 |

与 phase 19 记录的是同一条，状态未变。

## 5. 清洁度

```
本轮 packages/*/src 下新增的 console.log                    ：无
本轮新增的 FIXME / XXX / HACK / @ts-ignore / eslint-disable ：无
```

## 6. 改动规模

```
42 files changed, 1227 insertions(+), 183 deletions(-)   （已跟踪文件）
+ 18 个新增文件（16 个测试 / 1 个 src / 1 个门禁脚本）
```

按区域：`ai/src` 10 · `coding-agent/src` 9 · `migration` 8 · `agent/src` 5 · `scripts` 2 ·
测试若干 · `package.json` · `MIGRATION-REPORT.md` · `mcp/src`。

**新增测试 +67 条**：agent +7 · ai +22 · coding-agent +30 · mcp +8。

## 7. MIGRATION-REPORT 更新

- §2 「done-gate 双计数」→「done-gate 计数」，新增三计数对照表与第三个计数的方法/误差说明。
- §5b（新增）本轮新增声明 D11/D12/D13 与主要行为对齐的择要。
- §5 七行全部改为**已关闭**（4 条，附实证装置）或**仍开放**（3 条，附「为什么」与「重估入口」），
  不留「未验证」含糊态。
