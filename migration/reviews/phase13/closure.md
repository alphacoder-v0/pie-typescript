# Phase 13 收口记录

## 交付

33 个 manifest 单元全部 done（17 源单元 + 16 char-tests），全局 189/205。

**里程碑：parity S1 双侧逐字节全绿**——项目第一次真正的双侧行为差分通过。此前所有 parity 结果都只有 oracle 单侧基线。
`--help` 复刻了 clap 4 的标签补齐、`[default:]`/`[possible values:]` 后缀顺序、doc 注释折行；动态模型目录行 `providers (32), models (938)` 的每个 provider 计数由 `@pie/ai` **独立算出**而非誊抄。

## 本 phase 的性质：从"移植完成"到"产品可用"

phase 13 的定义是「把 10–12 的器官接成活体」。开工后的可达性审计（`reachability-audit.md`）量化了一个此前不可见的事实：**pie 相对 pi 的核心增量全部是零导入者的孤儿模块**。根因是一条相对路径——`core/agent-session.ts:89` 的 `./tools/index.ts` 从 `core/` 解析到 `core/tools/index.ts`（pi 的 7 个基础工具），而非同级的 pie 工具注册表。

接线完成后：

| 台账项 | 接线前 | 接线后 |
|---|---|---|
| B6 / B7（cron 缺陷） | 产品路径上不存在 | **活**，经注册的 ToolDefinition 驱动 |
| B9（LatestReplaces 实为 first-wins） | 产品路径上不存在 | **活**（supervisor 用真 TriggerRuntime） |
| B10 / B11（task/memory 缺陷） | 复刻在死代码上 | **活** |
| B5 / B13（无信任门） | 已复刻但不可达 | **活**（B5 经 loadAll，B13 经 LspSupervisor） |
| 权限门 | **产品里完全不存在** | 存在（危险 bash 语料 + control-plane hook） |

B4（budget cap）与 skills 热重载仍是**产品路径上没有该功能**——属移植落位问题而非接线问题，留给 phase 17/18。

## 修掉的真实缺陷（非 oracle 差异，是 TS 侧自己的洞）

1. **凭据泄露**：`/login anthropic sk-…` 此前不匹配任何分支，被当普通聊天**发给模型**——粘贴的 API key 进入对话记录与 session JSONL。
2. **压缩回落方向相反**（两份实现均有）：oracle 保留最后一轮、摘要其余；TS 什么都不摘要。
3. **虚假压缩**（两份实现均有）：`compact()` 无「无内容可摘要」短路，比 oracle 早一个 prompt 触发压缩连带 hook webhook。该缺陷**正在掩盖**第 2 条。
4. **`fromHook` 语义错位**：手动 `/compact` 被上报成 `compaction_trigger: "auto"`。
5. **debug 流永不关闭**：provider 无终止事件时消费者永久等待。
6. **`AgentHarness` 从不填充 `onControlPlanePrompt`**：harness 内每个 prompt 分类的工具调用一律 fail-closed 拒绝。

## 队列本身的三处错误（收口抽查发现）

1. `coding-agent/spinner` 登记为 diff-port → **改判 port**。base（`Loader`）只在两个平凡常量上相符，spinner_e2e 断言的行为面一个都没有。不改则 phase 14 会照 diff-port 做浅比对，整个单元被静默跳过且账面为绿。
2. `tests/tools` 的 out_path 指向不存在的文件。
3. `tests/commands` 的 out_path 指向 `test/ported/commands.test.ts`——**那是源单元的测试**。撞名会让「out_path 存在 = 完成」规则据另一单元的文件误判完成。

第 3 条尤其值得记：队列的完成判定依赖路径唯一且正确，撞名会直接制造假绿。

## 编排者自身的三个错误

1. **完成门有洞**：一直让 agent 跑 `tsgo -p tsconfig.build.json`，而该配置**排除 `test/`**。七八个批次报告的"0 error"从未检查过自己写的测试。根 `npm run check` 一跑就出 3 个错，其中一个是 T4 把 `permissionClassification` 声明成"属性+函数类型"导致 `strictFunctionTypes` 下逆变、破坏了对 `ToolDefinition<any,any,any>` 的可赋值性。已改为方法写法（与同文件 `execute()` 一致）。
2. **自创了比仓库更严的隔离**：brief 模板里的 `HOME=$(mktemp -d)` 是我加的，它清空 `$HOME` 域的 fd/rg 工具缓存，制造 15 个 30s 超时假失败，被多轮 agent 反复当"环境问题"上报。仓库自己的 `test.sh` **不改 HOME**。已按 test.sh 修正。
3. **给 fixer 的指令有过一次事实错误**：让它按「未知状态码回落为纯数字」实现 `StatusCode`，fixer 查 `http` 1.5.0 crate 源码后推翻（实际是 `<unknown status code>`），并把 62 条 canonical reason 与 Node 的表机械比对找出 3 处差异。按 oracle-as-spec 覆盖编排者口述，做法正确。

## 结转 phase 14 的工作清单（已具体到断言）

- `commands.rs` 的 **dispatch 半边整体未移植**——`commands-e2e.test.ts` 有 41 个 `it.skip`，每个带 oracle 行号、该 dispatcher 必须产出的用户可见事实、以及已覆盖底层机制的测试指针。**这是现成的工作清单，不是欠债。**
- `tui_render_e2e.test.ts` 19 个 skip + `spinner-e2e.test.ts` 2 个 skip，文件末尾各附一份分组验收清单（A–E / 8 项）。
- `--thinking <bad>` 的退出码与 clap 措辞（oracle 退 2，TS 退 0 仅警告）、`pie session --help` 子命令页——两个 `it.fails`，实现一修好就会变成"预期失败却通过"。

## 仍诚实存在的缺口

- 10 个标志「已解析未消费」：`--builtin-skill --image --base-url --list-sessions --list-all-sessions --delete-session --web --tui --web-host --web-port`
- `/goal` 与 trigger supervisor 绑定启动时的会话，`/new`/`/resume`/`/fork` 后不跟随切换
- 交互式 control-plane 审批仍一律拒绝（`interactiveHook` 队列无消费者，接上会让工具调用永久挂起，故选 fail-closed）
- harness 侧 `control_plane_prompt` 审计条目未移植（`harness-e2e.test.ts` Group 8 的 4 个 skip）
