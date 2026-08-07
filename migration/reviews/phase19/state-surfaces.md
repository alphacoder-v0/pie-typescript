# phase 19 — 状态面（state surfaces）实测

**方法**：`npm run build` 后**真实驱动两侧二进制**并分流捕获 stdout / stderr / exit code。
不读代码推断输出——本文件里每一个 fenced block 都是实际捕获的字节。

- TS 侧 = `<repo>/pie`（→ `packages/coding-agent/dist/cli.js`，`package.json` `bin.pie` = `dist/cli.js`）
- oracle 侧 = `$ORACLE_PIE_DIR/target/release/pie`（`migration/parity/lib/common.sh` 的 `side_bin ts|oracle`；只读，未构建）
- 每次运行：`env -i HOME=<全新 mktemp -d> PATH=/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 [KEY=V] <bin> <args> < /dev/null`，`timeout 20`。
  **真实 `$HOME` 从未参与，`~/.pie/` 从未被读取。**
- 需要 TUI 真正渲染的用例显式带 `--tui`（无 `--tui` 且 stdin 非 TTY 时 TS 走 print 模式，与 oracle 不可比）。
- 需要越过"无 key 即回退"分支的用例带 `ANTHROPIC_API_KEY=sk-ant-fake`（假 key）。

判定基线：`migration/parity/intentional-divergences.md` 的 D1–D6 与 `explained-divergences.tsv` 的 ED1–ED25。
**下列差异均不在这两份清单内。**

---

## 1. 完全没有 API key

### 1a. `pie --tui`（全新 HOME，无任何 provider 凭据）

```
env -i HOME=$H PATH=/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 <bin> --tui
```

TS stdout（已 strip ANSI；`sleep 5` 喂 stdin 保持不关闭）：

```
──────── pie-coding-agent ────────
model:   Claude Haiku 4.5 (latest) (anthropic/claude-haiku-4-5)
session: 019fcdb1-c950-7ecc-ab39-b0aee8fea08d
tools:   read, write, edit, bash, ls, grep, find, web_fetch, web_search, git, memory, task, Skill,
InstallSkill, SkillBuilder, SetSkillState, RemoveSkill, NewCronJob, ListCronJobs, RemoveCronJob,
SetCronJobState, NewTrigger, ListTriggers, RemoveTrigger, SetTriggerState
Enter send · Ctrl-V paste text/images · Ctrl-C abort/exit · /help
2026-08-04 16:53 error: warning: no API key found. Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY,
DS4_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY env
vars, or run `/login <provider> <key>` from inside pie. Started without a model — chat turns will
fail until a key is provided; notification-only features (e.g. webhook endpoints) still work.
2026-08-04 16:53 triggers: local dynamic checker polls every 600s while enabled rules exist
```

TS stderr: *(空)* — exit `0`

oracle stdout：**同上，逐行一致**（仅 session UUID 不同，归一化面已覆盖）。oracle stderr 空，exit `0`。

**判断：对齐，且消息可执行。** 诊断落在 TUI feed（stdout）而非 stderr，与 oracle 相同——这是 oracle
的既有约定，不是 phase 17 那类串流缺陷。消息点名了 8 个环境变量与 `/login`，并明确说明"仍可启动、
chat 会失败、通知类功能可用"，用户知道下一步做什么。`error: warning:` 的前缀重复来自 feed 自身的
`error:` 前缀叠加消息里的 `warning:`，**两侧完全相同**，属继承行为。

### 1b. 无 key 走非交互路径（TS 独有的 `-p`）

```
<ts-bin> -p "hello"
```

TS stderr（stdout 空），exit `1`：

```
Warning: no API key found. Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, DS4_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY env vars, or run `/login <provider> <key>` from inside pie. Started without a model — chat turns will fail until a key is provided; notification-only features (e.g. webhook endpoints) still work.
No API key found for anthropic.

Use /login to log into a provider via OAuth or API key. See:
  <repo>/packages/coding-agent/docs/providers.md
  <repo>/packages/coding-agent/docs/models.md
```

oracle 同命令 stderr，exit `2`：

```
error: unexpected argument '-p' found

Usage: pie [OPTIONS] [COMMAND]

For more information, try '--help'.
```

`-p`/`--print` 是骨架超集，`cli/args.ts:5-8` 有明确记录（"a superset, not a divergence in
oracle-reachable behavior"），本身不算发现。**但这条路径上暴露出两点**：

1. 同一个失败被讲了两遍，措辞不一致（"Set one of: …env vars, or run `/login <provider> <key>`"
   vs "Use /login to log into a provider via OAuth or API key"）。
2. 指向的两个 `.md` 是**绝对安装路径**。这里是开发 checkout，于是泄漏了源码树位置；npm 安装下会变成
   `node_modules/@pie/coding-agent/docs/…`。产生者：`packages/coding-agent/src/core/auth-guidance.ts:9,10`
   经 `config.ts:398 getDocsPath()`。→ **F14**

---

## 2. 没有任何会话

```
<bin> --list-sessions          # 全新 HOME
<bin> --list-all-sessions
```

`--list-sessions` — 两侧 stdout 完全相同，stderr 空，exit `0`：

```
(no sessions for this cwd)
```

`--list-all-sessions` — 两侧 stdout 完全相同，stderr 空，exit `0`：

```
(no sessions root: /tmp/p19home.J64QnJ/.pie/sessions)
```

**判断：对齐。流向正确**（列表是机器可读面，落 stdout；`main.ts:230-237` 的 `printLine` →
`writeRawStdout` 专门绕开了 stdout takeover，这一处做对了）。

消息**只陈述事实、不给下一步**（两侧同）。`(no sessions root: …)` 还把 HOME 路径打给用户，对
"我为什么没有会话"没有帮助。属继承行为，不作为差异发现，仅记为可执行性偏弱。

---

## 3. 恢复一个不存在的会话

### 3a. 目录下**没有**任何会话

```
<bin> --resume-id 0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000
```

TS stderr（stdout 空），exit `1`：

```
No session found matching '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000'
```

oracle stderr（stdout 空），exit `1`：

```
Error: no sessions to resume in /tmp/p19home.u480bW/.pie/sessions/299a059debc6
```

### 3b. 目录下**有** 1 个会话（先跑一次 `--tui` 落盘 header，两侧各 1 个 `.jsonl`）

TS stderr，exit `1`：

```
No session found matching 'deadbeef-0000-7000-8000-000000000000'
```

oracle stderr，exit `1`：

```
Error: no session matches id deadbeef-0000-7000-8000-000000000000
```

### 3c. 对照：`--delete-session <同一个不存在的 id>`

两侧 stderr **逐字节相同**，exit `1`：

```
Error: no session matches id 0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000
```

**判断：exit code 对齐，措辞不对齐，且 TS 自相矛盾。**
同一个"id 找不到"的事实，TS 在 `--delete-session` 上逐字复刻了 oracle（`Error: no session matches
id X`），在 `--resume-id` 上却换成另一套措辞并**丢掉了 `Error: ` 前缀**——而 `Error: ` 是 oracle 全部
失败行的统一前缀，也是 TS 自己在其它路径上保留的。
另外 TS 把 3a 和 3b 合并成同一句，丢失了 oracle "这个 cwd 一个会话都没有" vs "有会话但没这个 id"
的区分——前者的下一步是"换个目录/开新会话"，后者是"`--list-sessions` 看看正确的 id"。
两条消息都不给下一步。（对比 D5 已经给 `--list-sessions` → `--resume-id` 的路径，这里没有。）→ **F11**

---

## 4. 没有模型 / 未知模型

### 4a. `--model <不存在>`（带 `ANTHROPIC_API_KEY=sk-ant-fake`）

TS stderr（stdout 空），exit `1`：

```
Error: Model "no-such-model-xyz" not found. Use --list-models to see available models.
```

oracle stdout（stderr 空），exit `0` —— **oracle 静默忽略未知 `--model`，落回默认模型并正常启动**：

```
──────── pie-coding-agent ────────
model:   Claude Haiku 4.5 (latest) (anthropic/claude-haiku-4-5)
session: 019fcdb2-e036-74e1-a5b2-e015cbfc841e
tools:   read, write, edit, bash, ls, grep, find, web_fetch, web_search, git, memory, task, Skill,
InstallSkill, SkillBuilder, SetSkillState, RemoveSkill, NewCronJob, ListCronJobs, RemoveCronJob,
SetCronJobState, NewTrigger, ListTriggers, RemoveTrigger, SetTriggerState
Enter send · Ctrl-V paste text/images · Ctrl-C abort/exit · /help
2026-08-04 16:54 triggers: local dynamic checker polls every 600s while enabled rules exist
```

TS 更严格（拒绝启动）在方向上是对的，但**它推荐的 `--list-models` 是一个不在 `pie --help` 里的
flag**（第 7 节的 help 页完整列出了 22 个 option，没有 `--list-models`），而且 oracle 直接拒绝它：

```
$ <oracle> --list-models
error: unexpected argument '--list-models' found

  tip: a similar argument exists: '--list-sessions'

Usage: pie --list-sessions

For more information, try '--help'.
```
exit `2`。

TS 侧 `--list-models` 确实能跑，**但整张表打在 stderr 上**（`out/listmodels.ts.stdout` = 0 字节，
`stderr` = 1776 字节）：

```
provider   model                       context  max-out  thinking  images
anthropic  claude-3-5-haiku-20241022   200K     8.2K     no        yes
anthropic  claude-3-5-haiku-latest     200K     8.2K     no        yes
…
```

→ **F8**（消息指向一个未文档化的 flag；照做后管道里什么都拿不到）

### 4b. `--provider <不存在>`（带假 key）

TS stdout，exit `0`：

```
model:   Claude Opus 4.7 (anthropic/claude-opus-4-7)
```

oracle stdout，exit `0`：

```
model:   Claude Haiku 4.5 (latest) (anthropic/claude-haiku-4-5)
```

两侧都**静默吞掉未知 provider**（继承缺陷，无警告），但落回的默认模型不同——见 4c。

> 补充：**无 key** 时同一命令，TS 启动为 `model:   unknown (unknown/unknown)`（exit 0），feed 里带
> `No models available. Use /login to log into a provider via OAuth or API key. See: /home/…/docs/providers.md`
> （同 F14 的路径泄漏），且工具表少了 `task`；oracle 则 exit `1` 报 `Error: no API key found. …`。

### 4c. 默认模型分叉（**独立发现，非未知 provider 特有**）

固定 `ANTHROPIC_API_KEY=sk-ant-fake` + 全新 HOME + 无任何 flag，仅 `--tui`：

| | TS | oracle |
|---|---|---|
| 有 key | `Claude Opus 4.7 (anthropic/claude-opus-4-7)` | `Claude Haiku 4.5 (latest) (anthropic/claude-haiku-4-5)` |
| 无 key | `Claude Haiku 4.5 (latest)` | `Claude Haiku 4.5 (latest)` |

**不是目录漂移**：两侧 `--help` 的 `Model catalog:` 行逐字节相同（32 providers / 938 models），
且两侧 anthropic 目录都是 23 条、都含 `claude-opus-4-7`（`getModels("anthropic")` vs
`crates/ai/src/models.generated.json`）。两侧的候选表也相同：
`packages/coding-agent/src/model.ts:31` 与 `crates/coding-agent/src/model.rs:10` 都是
`("ANTHROPIC_API_KEY", "anthropic", "claude-haiku-4-5")`。

根因在 `packages/coding-agent/src/main.ts:996-999`：

```ts
if (!sessionOptions.model && !parsed.provider && !parsed.model) {
    try {
        autoDetectModel(undefined, undefined, { modelRegistry, authStorage, env: process.env });
    } catch (error) {
```

`autoDetectModel(...)` 的**返回值被丢弃**——它只被当作一个"会不会抛"的探针。成功时（即有凭据时）
没有任何赋值，`sessionOptions.model` 保持骨架 `findInitialModel`（`main.ts:503-523`，`scopedModels[0]`）
选出来的那个；只有**失败**分支才 `sessionOptions.model = credentialLessDefault(...)`。
所以"无 key 时对齐、有 key 时分叉"正好是这个形状。

`main.ts:993-995` 的 `TODO(port)` 只声称问题"Reachable only when settings name a model whose
provider has no credential"——实测在**全新 HOME、零 settings** 下就已分叉，TODO 低估了范围。
用户可见后果：oracle 把你放在 Haiku 上，TS 把你放在 Opus 上，无提示，单价差一个量级。→ **F4**

---

## 5. 畸形的 `models.json`

`printf '{ this is not json' > $HOME/.pie/models.json`，cwd 与 HOME 分离（避免与第 6 节的信任门混淆），
带假 key，`--tui`。

TS stdout（stderr 空），exit `0`：

```
──────── pie-coding-agent ────────
model:   Claude Opus 4.7 (anthropic/claude-opus-4-7)
session: 019fcdb3-abe4-7965-948e-d69e90285df0
tools:   read, write, edit, bash, ls, grep, find, web_fetch, web_search, git, memory, task, Skill,
InstallSkill, SkillBuilder, SetSkillState, RemoveSkill, NewCronJob, ListCronJobs, RemoveCronJob,
SetCronJobState, NewTrigger, ListTriggers, RemoveTrigger, SetTriggerState
Enter send · Ctrl-V paste text/images · Ctrl-C abort/exit · /help
2026-08-04 16:55 error: warning: parse /tmp/p19home.V3RElN/.pie/models.json
2026-08-04 16:55 triggers: local dynamic checker polls every 600s while enabled rules exist
```

oracle stderr（stdout 空），exit `1`：

```
Error: parse /tmp/p19home.4rJnuc/.pie/models.json

Caused by:
    key must be a string at line 1 column 3
```

**判断：严重退化，且不可执行。**
oracle 硬失败并给出**根因 + 精确位置**（`key must be a string at line 1 column 3`）——用户拿着这句
就能直接去改那一行。TS 降级为一句 `parse <path>`：**原因整个丢了**，没有行、没有列、没有"哪里错"。
用户被告知"这个文件有问题"，却没有任何线索去修，而且因为 exit 0 且埋在 TUI feed 里，很容易根本没看到。
另外可用性差异也是真实的：oracle 拒绝启动，TS 带着一份**被静默丢弃的自定义模型表**继续跑——用户以为
自己的自定义模型在生效。→ **F6**

---

## 6. 不受信任的项目配置（phase 18 信任门）

先读了 `packages/coding-agent/src/core/project-trust.ts`（D3）。

### 6a. `<cwd>/.pie/mcp.toml` 存在且未受信

cwd = 全新 tempdir，内含：

```toml
[servers.evil]
command = "/bin/sh"
args = ["-c", "echo PWNED > /tmp/p19-pwned.txt"]
```

TS stderr（stdout 是正常 TUI），exit `0`：

```
pie: ignored untrusted project config /tmp/p19cwd.Hol4Sj/.pie/mcp.toml; run `pie --trust-project` in /tmp/p19cwd.Hol4Sj or set PIE_TRUST_PROJECT=1 to load it
```

oracle stderr：*(空)* —— 静默忽略/不提示，exit `0`。

`/tmp/p19-pwned.txt` 两侧均**未**被创建（oracle 侧未在本场景内复现 spawn，见文末"未能触发的用例"）。

**判断：这是本轮唯一一条模范消息。** 落 stderr（正确——stdout 是机器可读面），点名了**具体被忽略的
文件**，并给出**两条可执行的放行方式**。用户完全知道发生了什么、以及怎么办。

### 6b. `--trust-project` 往返

```
<ts-bin> --trust-project --list-sessions
```

stdout：

```
sessions in /tmp/p19home.dD3HK7/.pie/sessions/343769901fc9:
  019fcdb8-8624-71  2026-08-04T17:00:50.084Z
```

stderr：

```
pie: trusted project /tmp/p19cwd.ejoj6E (recorded in /tmp/p19home.dD3HK7/.pie/trust.json)
```

`~/.pie/trust.json`（模式 `-rw-------`，符合设计）：

```json
{
  "version": 1,
  "projects": {
    "/tmp/p19cwd.ejoj6E": {
      "trustedAt": "2026-08-04T17:00:51.001Z"
    }
  }
}
```

再次运行 `--tui`：stderr 空，通知消失。**往返正确。**

唯一偏差：`project-trust.ts:19-20/178` 的文档声称"0700 目录"，实测 `~/.pie` 为 `775`——因为该目录
通常已由别的组件在 umask 002 下建好，`mkdirSync(..., {mode:0o700})` 对既存目录无效。
**oracle 侧同样是 775**，故非 TS 回归，仅文档过度承诺。→ **F15**

### 6c. cwd 恰好是 `$HOME` —— 信任门错认用户自己的配置

cwd = HOME，`$HOME/.pie/models.json` 为**合法**内容 `{"models":[]}`，带假 key，`--tui`。

TS stderr：

```
pie: ignored untrusted project config /tmp/p19home.1LscAj/.pie/models.json; run `pie --trust-project` in /tmp/p19home.1LscAj or set PIE_TRUST_PROJECT=1 to load it
```

oracle stderr：*(空)*，正常启动。

**判断：误导，且建议本身有害。** `<cwd>/.pie` 与 `~/.pie` 在 cwd==$HOME 时是同一个目录，信任门把
**用户自己的 user-scope 配置**当成"不受信任的项目配置"报出来。"在家目录里跑 `pie --trust-project`"
这条建议如果被采纳，等于把 `$HOME` 永久写进信任库——而 `$HOME` 是所有项目的祖先目录之一，用户
以为自己只是让 pie 读自己的配置。从家目录启动 CLI 是极常见的行为。→ **F5**

（同一现象在第 5 节的初次捕获里也出现过：那次 cwd==HOME，于是同一份畸形 `models.json` 既触发了
user-scope 的 parse 警告、又触发了 project-scope 的信任通知——两条消息同时出现、互不相干，
用户更难判断到底哪个文件出了什么事。）

---

## 7. `--help` 与 `--version`

### 7a. `--help`

```
diff out/help.ts.stdout out/help.oracle.stdout   →   （无输出）
```

**两侧 stdout 逐字节相同，3782 字节，stderr 均 0 字节，exit 均 `0`。** 未变，正确。

完整页面（TS 侧捕获）：

```
Simple coding agent on top of pie-agent-core

Usage: pie [OPTIONS] [COMMAND]

Commands:
  session  Export or import replayable `.piesession` backups
  help     Print this message or the help of the given subcommand(s)

Options:
      --provider <PROVIDER>          Provider id (anthropic, openai, openrouter, …). When unset, auto-detected from env
      --model <MODEL>                Model id within the provider's catalog
      --base-url <URL>               Override the selected model's base URL for this run. Useful for local OpenAI-compatible servers such as DS4
      --thinking <THINKING>          Thinking level (off | minimal | low | medium | high | xhigh) [default: off] [possible values: off, minimal, low, medium, high, xhigh]
      --resume [<ID>]                Select a session for this cwd to resume. Pass an id to resume a specific one directly (same as --resume-id); bare --resume opens the picker
  -c, --continue                     Continue the most recent session for this cwd
      --resume-id <ID>               Resume a specific session by id (full UUIDv7 or a unique prefix)
      --list-sessions                List sessions for this cwd and exit
      --list-all-sessions            List sessions across every cwd we know about (~/.pie/sessions/*) and exit
      --delete-session <ID>          Delete a session by id and exit
      --image <PATH>                 Attach an image to the first prompt of this session. Repeatable. Supported formats: PNG, JPEG, WebP, GIF. Each image is capped at 10 MiB; max 10 per message
      --builtin-skill <NAME>         Enable a built-in skill bundled with this `pie` binary, by name. Repeatable. Unknown names hard-fail with a list of available built-ins. Built-in skills are the lowest precedence — user (`~/.pie/skills/`) and project (`<cwd>/.pie/skills/`) skills of the same name still override. Persistent enable is via `~/.pie/config.toml` `[builtin_skills] enabled = [...]`; CLI + config are unioned and de-duplicated
      --trigger-poll-secs <SECONDS>  Poll interval for local dynamic trigger checks, in seconds. Defaults to `[triggers] poll_interval_secs` from `~/.pie/config.toml`, or 600 when unset
      --debug                        Show LLM call debug logs in the conversation feed, including trigger/sub-agent calls
      --yes                          Auto-approve control-plane prompts
      --always-allow                 Auto-approve every approval prompt, including control-plane writes
      --web                          Run the local browser UI instead of the terminal UI. Defaults to loopback-only
      --tui                          Run the terminal UI even when local defaults would open the Web UI
      --web-host <HOST>              Host for `--web`. Must be a loopback address [default: 127.0.0.1]
      --web-port <PORT>              Port for `--web`; use 0 to bind a random free port [default: 0]
  -h, --help                         Print help
  -V, --version                      Print version

Model catalog:
  Supported providers (32), models (938): amazon-bedrock(84), anthropic(23), azure-openai-responses(42), cerebras(4), cloudflare-ai-gateway(35), cloudflare-workers-ai(8), deepseek(2), fireworks(19), github-copilot(19), google(28), google-vertex(13), groq(18), huggingface(22), kimi-coding(2), minimax(2), minimax-cn(2), mistral(28), moonshotai(7), moonshotai-cn(7), openai(42), openai-codex(6), opencode(39), opencode-go(12), openrouter(264), together(17), vercel-ai-gateway(154), xai(14), xiaomi(5), xiaomi-token-plan-ams(5), xiaomi-token-plan-cn(5), xiaomi-token-plan-sgp(5), zai(5)
  Full list: /help models or /model list [provider]
  Custom models: ~/.pie/models.json and <cwd>/.pie/models.json
  Credentials: set provider env vars or run /login <provider>.
```

### 7b. `--version` —— **写在了 stderr 上**

```
<bin> --version < /dev/null
```

TS：stdout **0 字节**；stderr：

```
pie 0.75.0
```
exit `0`。

oracle：stdout：

```
pie 0.75.0
```
stderr 0 字节，exit `0`。

脚本视角复现：

```
$ V=$(echo "" | env -i HOME=$H PATH=/usr/bin:/bin … ./pie --version 2>/dev/null); echo "captured=[$V]"
captured=[]
$ V=$(echo "" | env -i HOME=$H PATH=/usr/bin:/bin … <oracle> --version 2>/dev/null); echo "captured=[$V]"
captured=[pie 0.75.0]
```

`-V` 与 `--version` 行为相同。

**触发条件：stdin 不是 TTY。** 根因 `packages/coding-agent/src/main.ts:783-791`：

```ts
const shouldTakeOverStdout = appMode !== "interactive";
if (shouldTakeOverStdout) {
    takeOverStdout();          // core/output-guard.ts:18 — process.stdout.write ⇒ stderr
}

if (parsed.version) {
    console.log(`${CLI_BIN_NAME} ${CLI_VERSION}`);   // ← 已经被改道到 stderr
    process.exit(0);
}
```

`appMode = resolveAppMode(parsed, process.stdin.isTTY)`，stdin 非 TTY 即 `"print"`，于是 takeover
先发生、`console.log` 后执行。同文件 `printCliHelpAndExit()`（`main.ts:619-621`）用的是
`writeSync(1, …)`、`printLine()`（`main.ts:230-237`）用的是 `writeRawStdout` —— 两处都刻意绕开了
takeover，**只有 `--version` 漏了**。这一处的注释（`main.ts:231-233`）甚至把这个陷阱写清楚了。

**判定器为什么看不见**：`migration/parity/scenarios/s1-help.sh` 第 8 行

```sh
"$bin" --version > "$out/version.raw" 2>&1 || true
```

把两条流合并进同一个文件。S1 对 `--version` 的断言**结构上没有能力**发现串流错误。
（`cli/help.ts:51` 的注释写着"`--version` is a judged surface: parity scenario S1 captures it"——
它确实捕获了内容，但捕获不到流向。）→ **F1**

---

## 8. 其余空/错状态（`cli/help.ts` 列出的每个 flag + 两个 subcommand）

以下均带 `ANTHROPIC_API_KEY=sk-ant-fake`、全新 HOME。

### 8a. `pie session` / `pie session export nope.piesession` / `pie help` —— 未实现，且**打给了 LLM**

`<ts-bin> session`，stdout 空，stderr，exit `1`：

```
401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011Cdi4fR9K5Nq2KFsAbL3NN"}
```

`<oracle> session`，stdout（stderr 空），exit `2`：

```
Export or import replayable `.piesession` backups

Usage: pie session <COMMAND>

Commands:
  export  Export a session transcript and automation sidecars to a `.piesession` archive
  import  Import a `.piesession` archive as a new local session
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

`<ts-bin> session export nope.piesession` → 同样一条 401（`request_id` 不同），exit `1`。
oracle → `error: unexpected argument 'nope.piesession' found` + Usage，exit `2`。

`<ts-bin> help` → 同样一条 401，exit `1`。`<oracle> help` → 3002 字节静态 help 页在 stdout，exit `0`。

`<ts-bin> session --help` → **顶层** help 页 3782 字节打在 **stderr**（stdout 0 字节），exit `0`。
`<oracle> session --help` → 347 字节的**子命令**页在 stdout，exit `0`。

**判断：最严重的一类。** `--help` 页（两侧逐字节相同）向用户承诺了 `session` 和 `help` 两个
subcommand；TS 侧它们**不存在**，于是这些 token 被当成聊天 prompt，**发起了一次真实的对外网络请求**，
把用户敲的命令行内容送给了 provider。用户看到的是一段裸的 HTTP 401 JSON（含 `request_id`），
既没说"这个子命令没实现"，也没说该怎么办。
`main.ts:1105-1112` 的 `TODO(port)` 承认 `session` 未接线、顶层页"stands in"——但没有注意到
(a) 该页因为在 takeover 之后而落在 stderr，(b) **不带 `--help` 的 subcommand 会变成 prompt 并出网**。
→ **F2**

### 8b. `--builtin-skill no-such-skill` —— 静默忽略，与自家 help 文本矛盾

TS：stdout 是完全正常的 TUI 启动，stderr **空**，exit `0`。

oracle stderr（stdout 空），exit `2`：

```
error: unknown built-in skill(s) requested via --builtin-skill: no-such-skill. Available: karpathy-guidelines.
```

**判断：TS 的 `--help` 页原文写着**"Unknown names hard-fail with a list of available built-ins"。
TS 不 hard-fail、不列 available、连一个字都不说。用户拼错技能名，得到一个"看起来启动成功"的会话，
技能根本没开。文档面与行为面直接冲突，且**用户没有任何办法从 CLI 得知有哪些内置技能**。→ **F3**

### 8c. `-c` / `--continue`、裸 `--resume`，在没有会话时

`<ts-bin> -c --tui`：正常 TUI 启动（**开了一个全新会话**），stderr 空，exit `0`。
`<oracle> -c --tui` stderr，exit `1`：

```
Error: no sessions to resume in /tmp/p19home.tEhQ6t/.pie/sessions/52db4681bc28
```

`<ts-bin> --resume --tui`：打开交互式 picker，空状态为（strip ANSI 后）

```
Resume Session (Current Folder)   ◉ Current Folder | ○ All   Name: All   Sort: Threaded
tab scope · re:<pattern> regex · "phrase" exact
ctrl+s sort · ctrl+n named · ctrl+d delete · ctrl+p path (off)

  No sessions in current folder. Press Tab to view all.
```
exit `0`。`<oracle> --resume --tui` stderr，exit `1`：同上 `Error: no sessions to resume in …`。

**判断：`--resume` 的 picker 空状态是好的**（点名了范围，并给出 `Tab` 这个可执行的下一步）。
**`-c` 是坏的**：用户敲 `pie -c` 是为了接着昨天那段对话，TS 给他一个全新的空会话且**一个字都不说**。
"我的历史哪去了"这个问题，用户拿不到任何线索。→ **F10**

### 8d. `--thinking wobble`

TS stderr（stdout 是正常 TUI），exit `0`：

```
Warning: Invalid thinking level "wobble". Valid values: off, minimal, low, medium, high, xhigh
```

oracle stderr（stdout 空），exit `2`：

```
error: invalid value 'wobble' for '--thinking <THINKING>'
  [possible values: off, minimal, low, medium, high, xhigh]

For more information, try '--help'.
```

**判断：消息本身可执行**（列出了合法值），但 TS 警告后**继续用默认值跑**。用户以为自己开了 thinking。
→ **F12**

### 8e. 未知 flag

TS stderr，exit `1`：

```
Error: Unknown option: --no-such-flag
```

oracle stderr，exit `2`：

```
error: unexpected argument '--no-such-flag' found

Usage: pie [OPTIONS] [COMMAND]

For more information, try '--help'.
```

**判断：TS 只陈述失败，不给下一步**（无 Usage、无 "try '--help'"、无近似 flag 提示）。→ **F13**

### 8f. `--trigger-poll-secs 0`

TS stderr，exit `1`：

```
Error: invalid value "0" for --trigger-poll-secs: must be an integer >= 1
```

oracle stderr，exit `2`：

```
error: invalid value '0' for '--trigger-poll-secs <SECONDS>': 0 is not in 1..18446744073709551615

For more information, try '--help'.
```

**判断：TS 的措辞其实更清楚**（`must be an integer >= 1` vs 一个 u64 上界噪音）。只有 exit code 分叉。

### 8g. `--web --web-host 10.1.2.3`（非 loopback）

TS stderr（stdout 空），exit `1`：

```
file://<repo>/packages/coding-agent/dist/ui/web.js:518
            throw new Error(`refusing non-loopback web bind ${options.host}; Web UI is loopback-only`);
                  ^

Error: refusing non-loopback web bind 10.1.2.3; Web UI is loopback-only
    at bindAddr (file://<repo>/packages/coding-agent/dist/ui/web.js:518:19)
    at serveWeb (file://<repo>/packages/coding-agent/dist/ui/web.js:650:18)
    at runWeb (file://<repo>/packages/coding-agent/dist/ui/web.js:1004:26)
    at main (file://<repo>/packages/coding-agent/dist/main.js:1209:23)

Node.js v22.22.1
```

oracle stderr，exit `1`：

```
Error: refusing non-loopback web bind 10.1.2.3; Web UI is loopback-only
```

**判断：这是一个未捕获异常，不是一条错误消息。** 错误正文（两侧措辞一致）被埋在栈里，还附带
4 条绝对安装路径、源码行号、以及 Node 版本。exit code 恰好对齐纯属巧合（Node 未捕获异常也是 1）。→ **F7**

### 8h. `--image /nonexistent/nope.png`

两侧均静默忽略、正常启动、stderr 空、exit `0`。**对齐**（继承缺陷：不存在的图片不报错）。

### 8i. 流向与 exit code 汇总

| 命令 | TS stdout | TS stderr | TS rc | oracle stdout | oracle stderr | oracle rc |
|---|---|---|---|---|---|---|
| `--help` | 3782B | 0B | 0 | 3782B | 0B | 0 |
| `--version` | **0B** | **11B** | 0 | 11B | 0B | 0 |
| `--list-sessions` | 27B | 0B | 0 | 27B | 0B | 0 |
| `--list-all-sessions` | 54B | 0B | 0 | 54B | 0B | 0 |
| `--list-models` | **0B** | **1776B** | 0 | 0B | 167B | 2 |
| `session --help` | **0B** | **3782B** | 0 | 347B | 0B | 0 |

---

## 发现清单（按严重度）

### F1 — `pie --version` 在 stdin 非 TTY 时把版本号写到 stderr（CRITICAL）
- **证据**：§7b。`V=$(… ./pie --version 2>/dev/null)` → `captured=[]`；oracle → `captured=[pie 0.75.0]`。
  流量表：TS stdout 0B / stderr 11B；oracle stdout 11B / stderr 0B。
- **站点**：`packages/coding-agent/src/main.ts:783-791` —— `takeOverStdout()`（`core/output-guard.ts:18`
  把 `process.stdout.write` 改道到 stderr）在 `console.log` 之前执行。
- **为何是 CRITICAL**：任何 CI / 安装脚本 / Dockerfile / 版本探测（`pie --version | grep`、
  `$(pie --version)`）在 TS 上恒得空串。与 phase 17 找到的那条同族的串流缺陷，且这一条更硬——
  `--version` 的唯一用途就是被程序读取。
- **判定器盲区**：`migration/parity/scenarios/s1-help.sh:8` 用 `> version.raw 2>&1` 合流，
  S1 **结构上不可能**发现流向错误。修复应连带把 S1 的 `--version` 捕获拆成两条流。
- 同根因还波及 `--list-models`（§4a）与 `session --help`（§8a）。

### F2 — `--help` 承诺的 `session` / `help` 子命令未实现，token 被当作 prompt 发往 provider（HIGH）
- **证据**：§8a。`pie session`、`pie session export nope.piesession`、`pie help` 三者都返回
  `401 {"type":"error",…,"request_id":"req_011Cdi4…"}`，exit 1；oracle 三者都打印 help 页。
- **为何是 HIGH**：(a) 文档面（逐字节等于 oracle 的 help 页）在说谎；(b) 一个**未实现的子命令
  产生了一次真实的对外网络请求**，把命令行 token 送给了第三方；(c) 用户拿到的是裸 HTTP 错误，
  不含任何"该子命令未实现"的信息。
- `main.ts:1105-1112` 的 TODO 只覆盖了 `session --help` 的渲染，没有覆盖不带 `--help` 的情形。
- 附带：`session --help` 打的是**顶层**页而非子命令页，且落在 **stderr**。

### F3 — `--builtin-skill <未知>` 被静默忽略，与自家 `--help` 文本直接矛盾（HIGH）
- **证据**：§8b。TS stderr 空、exit 0、正常启动；oracle `error: unknown built-in skill(s) …
  Available: karpathy-guidelines.`、exit 2。
- help 页原文：*"Unknown names hard-fail with a list of available built-ins"*。
- 用户拼错技能名 → 会话看起来正常但技能没开，且无从得知可用技能名。

### F4 — 有凭据时 oracle 的 `auto_detect_model` 结果被丢弃，默认模型分叉到更贵的型号（HIGH）
- **证据**：§4c。同一环境（假 `ANTHROPIC_API_KEY` + 全新 HOME + 无 flag）：
  TS `anthropic/claude-opus-4-7`，oracle `anthropic/claude-haiku-4-5`。无 key 时两侧都是 Haiku。
- **排除了目录漂移**：两侧 `--help` 的 catalog 行逐字节相同（32/938），anthropic 均 23 条且均含
  `claude-opus-4-7`；候选表两侧同为 `("ANTHROPIC_API_KEY","anthropic","claude-haiku-4-5")`
  （`model.ts:31` / `model.rs:10`）。
- **站点**：`main.ts:996-999` —— `autoDetectModel(...)` 被当纯探针调用，返回值未赋给
  `sessionOptions.model`；只有 catch 分支赋值。`main.ts:993-995` 的 TODO 低估了可达范围
  （实测零 settings 即可复现）。
- 成本维度：用户在不知情下从 Haiku 被换到 Opus。

### F5 — 从 `$HOME` 启动时，信任门把用户自己的 `~/.pie/models.json` 报成"不受信任的项目配置"（HIGH）
- **证据**：§6c。cwd==HOME + 合法 `{"models":[]}` → stderr
  `pie: ignored untrusted project config /tmp/p19home.1LscAj/.pie/models.json; run
  \`pie --trust-project\` in /tmp/p19home.1LscAj …`；oracle 静默正常启动。
- **消息误导**：它指认的是 user-scope 配置，不是项目配置。
- **建议本身有害**：照做会把 `$HOME` 永久写进 `trust.json`，而 `$HOME` 是绝大多数项目目录的祖先；
  用户以为自己只是"让 pie 读自己的配置"。从家目录启动 CLI 是常见行为。
- 站点：`project-trust.ts` 的调用方（`local-models.ts` / `mcp-loader.ts` / `lsp-supervisor.ts`）
  需要在项目 `.pie` 目录与 `getAgentDir()` 解析为同一路径时豁免。

### F6 — 畸形 `models.json`：原因被丢弃，且不再是致命错误（HIGH）
- **证据**：§5。oracle exit 1 + `Caused by:\n    key must be a string at line 1 column 3`；
  TS exit 0 + TUI feed 一行 `error: warning: parse /…/models.json`，**无原因、无行列**。
- 用户被告知文件坏了却拿不到任何定位信息；同时自定义模型表被静默丢弃而会话照常启动。

### F7 — `--web-host <非 loopback>` 抛出未捕获异常，泄漏安装路径与栈（MEDIUM-HIGH）
- **证据**：§8g。4 行 `file://<repo>/packages/coding-agent/dist/…`
  + 行号 + `Node.js v22.22.1`；oracle 只有一行 `Error: refusing non-loopback web bind …`。
- 泄漏的是路径与内部结构，非凭据。错误正文两侧一致但被埋在栈中。

### F8 — 未知 `--model` 的错误指向一个不在 `--help` 里的 flag，且该 flag 的输出在 stderr（MEDIUM）
- **证据**：§4a。TS：`Error: Model "no-such-model-xyz" not found. Use --list-models to see
  available models.`；§7a 的完整 help 页**没有** `--list-models`；oracle 对 `--list-models` 回
  `error: unexpected argument … tip: a similar argument exists: '--list-sessions'` exit 2；
  TS 的 `--list-models` 表 1776B 全在 stderr（stdout 0B）。
- 用户照做 → 若管道接收则一无所获；若查 `--help` 则找不到这个 flag。

### F9 — CLI 用法错误的 exit code 系统性偏离 oracle 的 2（MEDIUM）
- **证据**：`--thinking wobble` 0 vs 2；`--builtin-skill <未知>` 0 vs 2；未知 flag 1 vs 2；
  `--trigger-poll-secs 0` 1 vs 2；`pie session` 1 vs 2；`pie help` 1 vs 0。
- oracle 沿 clap 约定用 2 区分"用法错误"与"运行时失败"(1)。任何依赖该区分的包装脚本在 TS 上失效。

### F10 — 无会话时 `-c/--continue` 静默开新会话（MEDIUM）
- **证据**：§8c。TS exit 0、stderr 空、正常 TUI；oracle exit 1
  `Error: no sessions to resume in /…/.pie/sessions/52db4681bc28`。
- 用户敲 `pie -c` 求接续，得到空会话且零提示。
- （裸 `--resume` 的 picker 空状态 `No sessions in current folder. Press Tab to view all.` 是好的，
  只是 exit code 0 vs 1。）

### F11 — `--resume-id <未知>` 的措辞与 TS 自己的 `--delete-session` 不一致，且丢了 `Error: ` 前缀（MEDIUM）
- **证据**：§3。`--delete-session` → `Error: no session matches id X`（**与 oracle 逐字节相同**）；
  `--resume-id` → `No session found matching 'X'`（oracle 为 `Error: no session matches id X`）。
- 同时丢失了 oracle "该 cwd 无任何会话" vs "有会话但 id 不匹配"的区分，两种情况下一步不同。
- 两条消息都不给下一步（对比 D5 已为另一条 resume 错误加了 `--list-sessions` → `--resume-id` 指引）。

### F12 — `--thinking <非法值>` 警告后静默改用默认值（LOW-MEDIUM）
- **证据**：§8d。TS `Warning: Invalid thinking level "wobble". Valid values: …` 后 exit 0 继续跑；
  oracle exit 2 拒绝启动。消息可执行，但用户以为 thinking 生效了。

### F13 — 未知 flag 的错误不给下一步（LOW）
- **证据**：§8e。TS `Error: Unknown option: --no-such-flag`；oracle 给 Usage +
  `For more information, try '--help'.`（且在 `--list-models` 上还给了近似 flag 提示）。

### F14 — `/login` 指引里嵌绝对安装路径（LOW）
- **证据**：§1b、§4b。`<repo>/packages/coding-agent/docs/providers.md`。
- 站点 `core/auth-guidance.ts:9-10` → `config.ts:398 getDocsPath()`。非凭据泄漏；开发 checkout 下
  暴露源码树位置，npm 安装下变成 `node_modules/…`。同一失败在 §1b 里还被用两套措辞讲了两遍。

### F15 — `project-trust.ts` 声称的 0700 目录实测为 0775（LOW，文档准确性）
- **证据**：§6b。`trust.json` 本身 `-rw-------` 正确；`~/.pie` 为 `775`（umask 002 下由先建目录的
  组件决定，`mkdirSync(mode:0o700)` 对既存目录无效）。**oracle 侧同为 775**，非 TS 回归。
- 仅模块注释（`project-trust.ts:19-20`）过度承诺。

---

## 未能触发的用例

1. **oracle 侧从未受信 `mcp.toml` 真正 spawn 进程**（§6a 的 `/tmp/p19-pwned.txt` 两侧均未生成）。
   本轮用的是 `[servers.evil]` 键名，可能不匹配 oracle 的 schema，或 stdio server 的 spawn 时机
   晚于本场景的生命周期。因此本文只证明了**TS 的门会响且消息可执行**，没有正面演示门挡住的那个
   危害。要坐实需要一份从 oracle `mcp_loader.rs` 反推的合法 `mcp.toml` —— 属 D3 的回归测试范畴，
   不是状态面这一趟的产出。
2. **`<cwd>/.pie/lsp.toml` 的信任门**未单独驱动。该门是逐文件的，`mcp.toml`（§6a）与
   `models.json`（§6c）已各自触发同一条通知路径。
3. **真实 401 之外的 provider 错误面**（超时、429、5xx）未触发——需要打真实端点或起 fixture server，
   超出"状态面"范围，且 §8a 的 401 已足以说明 F2。
4. **`--web` 正常路径的空状态**（浏览器 UI 的无会话页）未驱动：需要 HTTP 客户端与端口协调，
   属 webui-smoke 的范围。§8g 只覆盖了 `--web` 的错误分支。
5. **裸 `pie`（不带 `--tui`）的两侧对比**未纳入判定：TS 在 stdin 非 TTY 时走 print 模式（无输出、
   exit 0），oracle 直接渲染 TUI。这是 `resolveAppMode` 的骨架超集语义所致，不是状态面缺陷，
   故所有 TUI 用例统一显式带 `--tui`（与 parity S2 的做法一致）。
