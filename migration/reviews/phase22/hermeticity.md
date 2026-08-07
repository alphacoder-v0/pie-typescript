# 测试密闭性 —— 第四条边界的关闭

phase 21 记录了一条边界：**密闭测试入口仍向真实 `~/.pie/sessions/` 写入**。
本 phase 关闭它。

## 根因（与上一轮记录的不同）

上一轮写的是「12 条测试依赖真实 `~/.pie` 下的 `bin/` 与主题文件，各自需要自己的夹具」。
本轮逐条诊断后发现，那个描述**只对了一半**，而且错的那一半更重要：

`getAgentDir()` 的优先级是（`packages/coding-agent/src/config.ts:485-499`）：

```
PIE_DIR  >  PI_CODING_AGENT_DIR  >  ~/.pie
```

那 12 条测试**本来就在隔离**——它们各自 `mkdtempSync` 出临时目录，然后设
`PI_CODING_AGENT_DIR` 指过去。问题在于它们设的是**优先级较低**的那个变量。
`test.sh` 一旦设了 `PIE_DIR`，就把测试自己的隔离盖掉了，测试转而去读那个空的临时基目录。

所以不需要「补夹具」，需要让这些测试**也设 `PIE_DIR`**。

这个改法顺带更 oracle-忠实：oracle 的 `base_dir()` 就是 `${PIE_DIR:-$HOME/.pie}`
（`crates/coding-agent/src/config.rs:10-17`），根本没有第二个变量；
`PI_CODING_AGENT_DIR` 是 pi 骨架遗留的附加覆盖。测试用 pi 的变量而非 oracle 的变量，
本身就是个隐患——本轮只是让它显形了。

## 12 条的逐条处置

四个文件同因，改动形状一致：在原有的 `PI_CODING_AGENT_DIR` set/restore 旁**成对**加上 `PIE_DIR`。

| # | 文件 | 条数 | 原本依赖 | 改动 |
|---|---|---|---|---|
| 1-2 | `test/keybindings-migration.test.ts` | 2 | `runMigrations()` 内部 `getAgentDir()` 读到的 `keybindings.json` | 两处 set/restore 成对加 `ENV_BASE_DIR` |
| 3-4 | `test/theme-export.test.ts` | 2 | `getThemeExportColors()` 读到的 `themes/*.json` | `beforeEach`/`afterEach` 加 `PIE_DIR` |
| 5-11 | `test/package-command-paths.test.ts` | 7 | 包路径解析读到的 `settings.json` 与 `bin/` | `beforeEach`/`afterEach` 加 `ENV_BASE_DIR` |
| 12 | `test/suite/regressions/2791-fswatch-error-crash.test.ts` | 1 | 子进程里 `setTheme()` 读到的 `themes/` | 子进程脚本内 + `execFileSync` 的 `env` 两处都加 |

### 判据 2：断言变没变弱

**diff 为空 —— 断言一字未改。** 四个文件的 `expect(` 计数改动前后一致：

| 文件 | expect 条数 |
|---|---|
| `keybindings-migration.test.ts` | 5 |
| `theme-export.test.ts` | 2 |
| `package-command-paths.test.ts` | 44 |
| `2791-fswatch-error-crash.test.ts` | 1 |

改动全部落在环境变量的 set/restore 上，没有一行断言被触碰。
这落在 phase-2 规格判据 2 的路径①（diff 为空，只换了夹具来源）。

## `test.sh` 的两处改动

```bash
export PIE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pie-test-home.XXXXXX")"

mkdir -p "$PIE_DIR/bin"
for _tool in fd rg; do
    if [[ -e "$HOME/.pie/bin/$_tool" ]]; then
        ln -sf "$HOME/.pie/bin/$_tool" "$PIE_DIR/bin/$_tool"
    fi
done
```

### 为什么要软链 `fd` / `rg`

只做第一步（换 `PIE_DIR`）会让 **16 条 grep/find 工具测试**变红——
它们从 `getBinDir()` = `$PIE_DIR/bin` 取二进制，目录一空就找不到了。

**隔离的是「状态」，不是「工具依赖」。** 测试需要 `rg` 就像需要 `node` 一样；
密闭性关心的是「测试不读写用户的会话、设置、凭据」，不是「测试不使用机器上装的工具」。
真正要隔离的会话目录仍然是空的。

若开发者机器上没有这两个二进制，`for` 循环什么也不做，那 16 条照旧红——与隔离前的行为一致，
不是本改动引入的退步。

### 为什么 auth.json 备份逻辑保留不动

`test.sh` 开头有一段把 `$HOME/.pie/auth.json` 备份走、退出时恢复的逻辑。
`PIE_DIR` 隔离之后它看起来「多余」了，但**没有删**：

它守的是「测试意外写坏真实凭据」，与会话目录泄漏是**两件事**。
`test.sh` 的 47 行 `unset` 清掉了 provider key，但不能保证没有别的路径碰到 `auth.json`
（例如某个测试显式传了绝对路径）。删它需要单独论证并配实验，不能顺手带走。

## 实证

### 泄漏归零

| | 真实 `~/.pie/sessions` 条目数 |
|---|---|
| 跑 `bash test.sh` 前 | 3268 |
| 跑 `bash test.sh` 后 | 3268 |
| **增量** | **0** |

同一次运行里，**21 个会话目录 / 35 个文件**落在临时 `PIE_DIR` 内——
那就是此前每跑一次测试就泄漏进用户目录的量。

### 套件

`bash test.sh` exit 0 — **4319 passed / 0 failed**
（agent 450 · ai 488 · coding-agent 2706 · mcp 46 · tui 612 · workers 17）。
原来那 12 条全部转绿，测试数与隔离前持平（本 phase 不新增测试）。

### 未覆盖 `HOME` 的证明

```
grep -cE '^\s*(export\s+)?HOME=' test.sh  →  0
```

## 负控

三个变异，每个都先 `assert` 锚点唯一命中、变异标记确实写进文件，还原后再 `assert` 无残留。

| 变异 | 内容 | 结果 |
|---|---|---|
| M1 | `core/keybindings.ts` 的 `cursorUp: "tui.editor.cursorUp"` → `"MUTATED.cursorUp"` | `keybindings-migration.test.ts` exit 1 ✓ |
| M2 | `theme.ts` 的 `getThemeExportColors` 提前 `return {}` | `theme-export.test.ts` exit 1 ✓ |
| M3 | `config.ts` 让 `getAgentDir()` 忽略 `PIE_DIR` | **临时 PIE_DIR/sessions 0，真实 `~/.pie/sessions` +29** ✓ |

M1/M2 证明夹具没把测试改成「测夹具」——被测函数一改坏，测试照样红。
M3 是密闭性本身的负控：把 `PIE_DIR` 的优先级打掉，泄漏立刻回来。

### M3 的第一版没检出，值得记下来

第一版 M3 直接跑 `npx vitest run test/session-manager`，变异前后真实目录增量都是 0，看起来「没检出」。
两个原因叠加：

1. **外部本来就没设 `PIE_DIR`**，所以「忽略 `PIE_DIR`」这个变异无差别可言。
   负控必须在**被守护的条件成立时**施加，否则测的是空气。
2. **`test/session-manager` 根本不写会话到磁盘**。探针选错了目标。

改成「设 `PIE_DIR` + 跑 coding-agent 全包」之后才检出。
这与 phase 21 记的那条同型：**变异要落在真实的判定路径上，否则负控会假通过。**

### 负控的副作用（如实记录）

M3 变异期间，真实 `~/.pie/sessions` **增加了 29 个测试会话目录**——
那正是本 phase 要修的问题的一个现场实例。这些是测试垃圾，不是用户的真实会话，
可用 `find ~/.pie/sessions -maxdepth 1 -mmin -20 -type d` 精确定位。
**未自行删除**：那是用户 HOME 下的数据，去留由用户决定。

## 边界状态

phase 21 `open-boundaries.md` 记的第四条边界，**本 phase 关闭**。
当时写的重估入口是「这 4 个文件里的 12 条测试已各自获得不依赖真实 `~/.pie` 的夹具」，
今天的答案是**是**——只不过实现方式不是「补夹具」，而是「改用 oracle 自己的那个环境变量」。
