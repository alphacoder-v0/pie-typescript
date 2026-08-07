# 473 个「只验证了名字」的函数 —— 风险分层

`check-surface-coverage.mjs` 数的是「oracle 的 513 个 `pub fn` 是否都有同名物」，未匹配 40。
剩下 **473 个只验证了名字**——那个脚本的文件头自己写明：「名字存在 ≠ 行为正确，本检查只能
守住『整块没移』这一类，守不住『移错了』」。

473 个逐个补行为验证不是一个有界任务。本 phase 只做一件事：**把它们按「值不值得花代价去差分」
排个序**，并把排序规则钉成可复算的脚本（`scripts/classify-surface-risk.mjs`），
让下一个人能重跑、能反驳、能改。

```
high 45 · medium 149 · low 279   （合计 473）
```

## 四条规则

每条都可枚举判定，粒度都是**函数**（不是文件——见下方「两次收紧」）。

| 规则 | 判定 | 命中 | 为什么这一维值得单列 |
|---|---|---|---|
| `credential` | 函数名或函数体含 `api_key` / `apikey` / `access_token` / `refresh_token` / `id_token` / `token_keychain` / `auth_store` / `authorization` / `oauth` / `secret` / `credential` / `bearer` / `password` | 24 | 出错就是把密钥发错地方、或写进日志/错误消息。批次 A 的 `/model` 缺陷与批次 B 的 env-decoy 都在这一维 |
| `filesystem` | 函数体含 `fs::write` / `fs::create_dir` / `fs::remove` / `fs::rename` / `fs::set_permissions` / `write_all` / `OpenOptions` | 14 | 出错就是丢用户数据，或留下一个 0644 的凭据文件。批次 D 的 `failed_sidecar_write_cleans_up_partial_import` 在这一维 |
| `user-visible` | 函数名属 `render` / `format` / `print` / `display` / `summar` / `preview` / `describe` / `emit` / `to_string` / `fmt` 族 | 9 | 出错就是用户看到错的字节。parity 只覆盖 12 个场景走到的那些，其余全靠单测 |
| `parity-path` | 模块在 12 个 parity 场景驱动的闭包内 **且** 该函数产出用户可见字节或写盘 | 9 | 判定器**已经**在看的热路径 |

命中 ≥1 条 → `high`；命中 0 条但在 `migration/depmap/edges.tsv` 里被 ≥2 个模块引用 → `medium`；
其余 → `low`。

一个函数可命中多条（24+14+9+9 = 56 > 45，差额是多重命中）。

## 两次收紧（判据 3 要求写明调了什么、为什么）

上界守卫按设计触发了两次。两次都不是「把界放宽」，而是**规则本身太糙**。

### 第一次：336 → 148（`credential` 从文件级降到函数级）

首跑 `high = 336`，`credential` 一条就命中 **290** 个。原因：规则测的是
`CREDENTIAL_RE.test(整个文件源文本)`。几乎每个文件里某处都出现过 `auth` 或 `token`，于是
`agent/src/agent.rs :: abort` 这种与凭据毫无关系的函数也被判高危。

**这样的分层等于没分层**——45/473 是一张可行动的清单，336/473 只是把问题换了个说法。

收紧为与 `filesystem` 同级的粒度（按**函数体**判）。那一条从一开始就只命中 14 个，
正说明函数级粒度是对的。

### 第二次：148 → 45（去掉裸 `token`/`auth`，并给 `parity-path` 加输出面条件）

148 仍然超界。逐个查命中原因：

- `agent.rs :: abort` 的函数体是
  `if let Some(token) = self.inner.active_cancel.lock().as_ref() { token.cancel(); }`
  —— 命中的是 **`CancellationToken`**，与凭据无关。裸 `auth` 同理会吃到 `author`。
  改为只保留与凭据强绑定的写法（`access_token` / `auth_store` / `authorization` / …）。
  `credential` 命中数 55 → **24**。
- `parity-path` 命中 **81**：原规则只看「模块在闭包内」，于是把闭包内每个函数都算成高危，
  其中大多是纯计算辅助。判定器盯的是**输出**——一个不产出任何东西的辅助函数即便在热路径上，
  也不是判定器能观测的面。收紧为「模块在闭包内 **且** 该函数产出用户可见字节或写盘」，
  命中数 → **9**。

两次收紧**掉出 high 层的都是同一类**：因为「所在文件 / 模块里别处提到过某个词」而被连坐的函数。
它们没有消失，落到了 medium（149）与 low（279）里。

## 每层样本

### high（45）—— 按规则分组

```
[credential] 24 个
    ai/src/bedrock_provider.rs :: from_env
    ai/src/bedrock_provider.rs :: invoke
    ai/src/env_api_keys.rs :: get_env_api_key
    ai/src/session_resources.rs :: cleanup_session_resources
    ai/src/sigv4.rs :: sign

[filesystem] 14 个
    agent/src/harness/session/jsonl_repo.rs :: create
    agent/src/harness/session/jsonl_repo.rs :: delete
    agent/src/harness/session/jsonl_storage.rs :: create
    coding-agent/src/bug_report.rs :: build
    coding-agent/src/export.rs :: save

[user-visible] 9 个
    agent/src/harness/skills.rs :: format_skill_invocation
    agent/src/harness/system_prompt.rs :: format_skills_for_system_prompt
    coding-agent/src/export.rs :: render
    coding-agent/src/export.rs :: render_context
    coding-agent/src/markdown.rs :: render_line

[parity-path] 9 个
    coding-agent/src/bug_report.rs :: build
    coding-agent/src/export.rs :: render
    coding-agent/src/export.rs :: render_context
    coding-agent/src/export.rs :: save
    coding-agent/src/inbox.rs :: append
```

### medium（149）· low（279）

```
medium 前 5：
    agent/src/agent.rs :: abort / continue_ / convert_to_llm / drain / enqueue
low 前 5：
    agent/src/harness/agent_harness.rs :: abort / abort_all_triggers / abort_trigger / agent / as_audit_str
```

`agent.rs` 的那批落到 medium（被 ≥2 个模块引用），`agent_harness.rs` 的落到 low——
后者虽然是个大文件，但在 depmap 里的入度不足 2。**这是分层的一个已知弱点**，见下。

## 这套分层守不住什么

分层是**优先级排序，不是安全证明**。至少这四类会漏：

1. **间接路径**。规则按函数体的标识符匹配，`fn a()` 自己不碰凭据但调用了 `fn b()`，而 `b` 碰
   —— `a` 会被判 low。例如 `agent_harness.rs :: abort_trigger` 落在 low，但它下游的取消路径
   可能触到会话文件的写入。要堵住这一类得做真正的调用图分析，不是标识符匹配。

2. **`medium` / `low` 的入度判据依赖 depmap 的粒度**。`edges.tsv` 是**模块级**（340 条边），
   一个巨型模块（`agent_harness.rs`，几千行）与一个十行的小模块在这里是同一个节点。
   `agent_harness.rs` 的函数因此整体落到 low，尽管它是整个 harness 的门面。

3. **`parity-path` 的闭包是近似的**。12 个场景跑的是二进制，没有「场景 → 模块」的真映射；
   这里用「场景脚本里出现的 CLI 关键词 → 入口模块 → depmap 传递闭包」代替。方向偏保守
   （闭包偏大 → 更多函数进 high），但仍可能漏掉只在运行期动态到达的模块。

4. **`low` 层出错一样会伤人**，只是概率与影响面更小。把它标成 low 不等于说它对；
   只是说在预算有限时，先看 high 那 45 个的期望收益更高。

这一节的存在本身是纪律：本仓的三个计数门禁（`check:manifest` / `check:surface-coverage` /
`check:inline-test-ports`）文件头都各有一段「它守不住什么」。一个不写明自身盲区的判定面，
会让人误以为过了就没事了。

## 复算

无随机、无时间、无并发，目录遍历全部 `.sort()`。同一输入两次运行输出逐字节相同：

```
$ node scripts/classify-surface-risk.mjs > run1.txt; cp risk-tiers.tsv tsv1
$ node scripts/classify-surface-risk.mjs > run2.txt; cp risk-tiers.tsv tsv2
$ diff run1.txt run2.txt   # 空
$ diff tsv1 tsv2           # 空
```

`risk-tiers.tsv` **474 行** = 473 个匹配函数 + 表头，与
`check:surface-coverage` 的 `513 − 40 = 473` 逐条吻合。

## 下一步（phase 8）

high 层 45 个中的每一个，都要有行为证据：既有测试的 `<path>:<line>`，或新增的特征测试，
或新增的 parity 场景。`high-tier-evidence.tsv` 的行数必须等于 45。
