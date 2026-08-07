# phase 20-7 · CLI 解析器缺口

四项，每项都先对 oracle 二进制实测取基准，再改，再逐字节比对。

## 1. `--long=value` 整体不被解析

**不是某个选项漏了。** 分派循环按精确 flag 名逐支 `else if` 匹配（`arg === "--thinking"`），
`--thinking=high` 一支都命中不了，一路落到末尾的 `unknownFlags` 兜底。

改前实测：

```
pie --thinking=bogus
  oracle  exit=2  error: invalid value 'bogus' for '--thinking <THINKING>'
                    [possible values: off, minimal, low, medium, high, xhigh]
  本仓    exit=2  error: unexpected argument '--thinking' found

pie --thinking bogus          ← 空格形式，两侧一字不差
```

`--web-port=99999` / `--model=X` 同形。而 `--long=value` 是 GNU/clap 的标准写法。

**处置**：在分派循环之前加一次 clap 风格展开 `expandLongEqualsValue`，把 `--flag=value`
拆成 `--flag` `value` 两个 token。只对 `valueOptionSpec` 认得的带值选项展开——布尔 flag 的
`--yes=1` 与完全未知的 `--nope=1` 保持原路径，免得把 value 当位置参数吞掉。

展开之后**每一支既有分支都不用改**，值校验与错误文案自动对齐。改后逐字节一致。

## 2. 重复选项被静默接受

改前是「最后一个赢」并继续跑：

```
pie --resume-id a --resume-id b
  oracle  exit=2  error: the argument '--resume-id <ID>' cannot be used multiple times
                  Usage: pie [OPTIONS] [COMMAND]
  本仓    exit=1  Error: no sessions to resume in <dir>     ← 跑去找 b 的会话了
```

把用户的打字错误吞成了一次真实操作。

**处置**：新增 `argumentRepeated(label)`（文案与 Usage 行逐字对齐 oracle 实测），
在解析循环里对**oracle 声明的**带值选项做重复检测。

**先量再改**：逐个对二进制实测哪些选项禁止重复——

| 选项 | oracle |
|---|---|
| `--resume-id` / `--model` / `--thinking` / `--provider` / `--base-url` / `--web-host` / `--web-port` / `--trigger-poll-secs` / `--delete-session` | exit 2，禁止重复 |
| `--image` | **exit 0，可重复** |
| `--builtin-skill` | **clap 层面接受重复**（exit 2 来自未知 skill 名的硬失败，见 phase 19 F3） |
| `--tools` / `--extension` | oracle 压根不认识（`unexpected argument`）——骨架超集，不适用 |

**第一版我没排除可重复的那两个**，直接把 `--image a.png --image b.png` 打成了错误。
`args.test.ts` 的 "--image and --builtin-skill are repeatable" 当场抓住
（`expected [ 'a.png' ] to deeply equal [ 'a.png', 'b.png' ]`）。已收窄，并从二进制这一侧
补了一条同向的回归测试。

## 3. 会话命令后的未知 flag 被静默吞掉

```
pie --list-sessions --no-such-flag
  oracle  exit=2  error: unexpected argument '--no-such-flag' found
                  Usage: pie --list-sessions
  本仓    exit=0  （静默照跑，一个字都不说）
```

**原因不是没检查，是顺序**：未知长 flag 在本仓走的是「先收着、等扩展认领、认领不到再报」
那条路（`agent-session-services.ts:153-161`，扩展机制要的；oracle 没有扩展所以立刻就报），
而会话管理命令在加载扩展**之前**就退出了，那道检查永远轮不到。

静默吞掉一个打错的 flag，用户会以为它生效了。

**处置**：在会话命令短路之前补同一道检查——那条路径不加载任何扩展，此刻的未知 flag
就是确定无人认领的。同时补上 clap 的**上下文相关 Usage 行**：oracle 实测
`Usage: pie --list-sessions` / `pie --list-all-sessions` / `pie --delete-session <ID>`，
不是顶层用法。三条改后均逐字节一致。

## 4. `pie --list-sessions extra` —— 声明为骨架超集

```
pie --list-sessions extra
  oracle  exit=2  error: unrecognized subcommand 'extra'
  本仓    exit=0
```

查下去发现这**不是 `--list-sessions` 特有的**：

```
pie "hello world"
  oracle  exit=2  error: unrecognized subcommand 'hello world'
pie hello
  oracle  exit=2  error: unrecognized subcommand 'hello'
                    tip: a similar subcommand exists: 'help'
```

**oracle 根本没有位置参数形式的提问。** 它只在交互式里接受提示词。而本仓接受
`pie "fix this bug"`——那是 pi 的核心非交互用法。

**结论：声明为骨架超集，不对齐。** 理由与 `args.ts` 头部对其余骨架 flag 的处置一致：
「removing them would delete working pi surface that oracle simply never grew — they are
a superset, not a divergence in oracle-reachable behavior」。对齐这一条等于删掉
`pie "<prompt>"` 这个用法本身，而 `--list-sessions extra` 只是它的一个切面。

## 5. 实测对比汇总（改后）

全部通过 `cmp` 逐字节比对 stderr + 退出码：

```
pie --thinking=bogus                     ✓ 逐字节一致 (exit=2)
pie --web-port=99999                     ✓ 逐字节一致 (exit=2)
pie --thinking=high --list-sessions      ✓ 逐字节一致 (exit=0)
pie --resume-id a --resume-id b          ✓ 逐字节一致 (exit=2)
pie --model x --model y                  ✓ 逐字节一致 (exit=2)
pie --thinking high --thinking low       ✓ 逐字节一致 (exit=2)
pie --web-port 1 --web-port 2            ✓ 逐字节一致 (exit=2)
pie --image a.png --image b.png …        ✓ 逐字节一致 (exit=0)
pie --list-sessions --no-such-flag       ✓ 逐字节一致 (exit=2)
pie --list-all-sessions --nope           ✓ 逐字节一致 (exit=2)
pie --delete-session x --nope            ✓ 逐字节一致 (exit=2)
pie --list-sessions                      ✓ 逐字节一致 (exit=0)
```

## 6. 工程检查

```
npm run build                      成功
npm run check                      7 道门禁全绿
bash test.sh                       exit 0；4259 passed / 0 failed
bash migration/parity/run-parity.sh  exit=1（预期），差异文件恰好 8 个 = 声明基线
                                   **S1 不在差异集内 → `pie --help` 逐字节不变**
```

新增测试 `packages/coding-agent/test/cli-parser-gaps.test.ts` 12 条（含 3 条负控方向的用例）。
