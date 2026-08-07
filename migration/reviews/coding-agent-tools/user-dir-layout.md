# 全局分歧：用户目录根与布局（编排者裁决）

## 发现路径

phase 9 批次 C（install_skill）报告它把 oracle 的 `~/.pie/skills/` 移植成了 `getAgentDir()/skills`，理由是"字面 `.pie` 路径对 pi 自己的 skill loader 不可见"。理由本身成立，但暴露的是**全局产品身份分歧**，不该由单个工具单元决定。

## 两侧事实

| | oracle（pie @0a120dfd） | TS 骨架（继承 pi） |
|---|---|---|
| 根目录 | `~/.pie/`（`config.rs:10-17`，`PIE_DIR` 可覆盖） | `~/.pi/agent/`（`config.ts:449` 的 `CONFIG_DIR_NAME=".pi"` + `getAgentDir()` 多一层 `agent/`） |
| sessions | `<base>/sessions/<cwd-hash>/<uuidv7>.jsonl` | `<agentDir>/sessions/...` |
| memory | `<base>/memory/`（全局，非 per-cwd） | 待定 |
| skills | `<base>/skills/` | `<agentDir>/skills/` |
| cwd 哈希 | `sha256(cwd)` 前 6 字节 hex（12 字符） | `encodeCwd()` slug（phase 8 批次 B2 已标记为架构差异） |

## judge 可观测性：**是**

parity S8 捕获的 oracle 输出逐字包含 `<HOME>/.pie/sessions`（见 `migration/parity/out/oracle/S8/list.norm`）。`--list-sessions` 直接打印该路径。phase 17 双侧跑 S8 时，TS 若输出 `~/.pi/agent/sessions` 必红。

按 BUG-scope 规则（RULEBOOK §2 开头）：judge 可观测 → **必须对齐 oracle**。

## 裁决

1. **根目录改 `.pie`**：骨架已提供配置点 `packages/coding-agent/package.json` 的 `piConfig.configDir`（当前 `".pi"`）。改为 `".pie"`。
2. **去掉多余的 `agent/` 层**：oracle 是 `~/.pie/sessions`，不是 `~/.pie/agent/sessions`。`getAgentDir()` 需对齐。
3. **env 覆盖变量**：oracle 用 `PIE_DIR`；TS 的 `ENV_AGENT_DIR` 由 `APP_NAME` 派生（当前 `PI_CODING_AGENT_DIR`）。需确认 `piConfig.name` 改为 `pie` 后是否自动变成 `PIE_CODING_AGENT_DIR`，以及是否需要额外支持 oracle 的 `PIE_DIR` 名字。
4. **cwd 哈希对齐**：`sha256(cwd)[:6]` hex，替换 base 的 `encodeCwd()` slug（phase 8 批次 B2 已把这个标记为待 phase 12 调和的架构差异——**本裁决即是那个调和**）。
5. **install-skill 的目标目录**：批次 C 的 `getAgentDir()/skills` 在根目录修正后自动变成 `~/.pie/skills`，与 oracle 一致，无需再改该单元。

## 影响面与执行

改动集中在 `packages/coding-agent/src/config.ts` 与 `package.json` 的 `piConfig`，但会波及所有读用户目录的单元（sessions/memory/skills/models.json/config.toml/themes）。**由编排者派专项 fixer 统一执行**，不由各工具单元自行处理。

phase 12（session/config/auth/loaders）与 phase 13（CLI 组装）在此基础上工作，不应再各自决定目录布局。

---

# 附带发现：skill 同名覆盖方向相反（编排者核实，纳入同批修复）

批次 D 在 `core/skills.ts` 观察到一个"user 覆盖 project"的去重顺序问题并按原样继承。编排者核实：**这是真分歧，方向与 oracle 相反**。

| | 行为 |
|---|---|
| oracle（`skills.rs:5,14-16`） | "project 级 skill 可覆盖同名的 user 级 skill"；project 目录**后加载**，同名时**覆盖**先前的 |
| TS（`core/skills.ts:423-438`） | **先到先得**：`if (existing) { 记 collision 诊断; 丢弃后来者 }`，先加载的胜出 |

判定：judge 可观测（决定同名 skill 哪个生效 → 进系统提示的 skill 目录 → 模型行为），按 BUG-scope 规则**必须对齐 oracle**。

注意与 phase 8 的关系：批次 E 已对齐了 `@pie/agent-core` 的 `harness/skills.ts`（发现顺序 builtin < user < project）。本处是 **coding-agent 侧的 `core/skills.ts`**，是另一份实现，未被那次修改覆盖。两处都要正确。

修法：把 collision 分支改为"后来者覆盖 + 仍记诊断"（诊断的 winner/loser 字段要相应对调），并补测试断言 project 同名 skill 胜出。**与用户目录布局裁决一并由专项 fixer 执行**。
