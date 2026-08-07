# phase 19 · 安全清扫

日期 2026-08-04。方法：grep 规则（本机无 gitleaks，phase 19 spec 允许二选一）+ `npm audit` +
`.claude/settings.json` deny 终审。

## 1. 硬编码密钥：src 树零命中

```
grep -rnEi "(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xoxb-|AKIA[0-9A-Z]{16}|
            -----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,})" packages/*/src workers/*/src
→ 0 命中

grep -rnEi "(api[_-]?key|secret|password|token)\s*[:=]\s*[\"'][A-Za-z0-9_\-]{20,}[\"']" packages/*/src
→ 0 命中
```

test 树有 20 处命中，**全部是合成值，且多数是负向断言**——即"这个值必须**不**出现在输出里"的
脱敏测试（`harness-e2e.test.ts:1353-1369`、`oauth.test.ts:512`、`debug.test.ts:93`）。
这类命中是脱敏覆盖存在的证据，不是泄漏。本报告只记录命中位置与计数，不复制任何匹配值。

追踪文件清单（`git ls-files` 过滤 `.env|.pem|.key|.p12|.crt|.json`）无凭据文件；
`migration/sources.env` 只含四个上游 SHA 与本地路径。`.gitignore` 覆盖 `.env`。

## 2. `npm audit`

### 2.1 已修复：undici TLS 证书校验绕过

**这一条不是"记录了事"，因为它落在凭据路径上。** `packages/coding-agent` 直接依赖 undici，
且 `src/core/http-dispatcher.ts:44-54` 调用 `setGlobalDispatcher` + `undici.install()`——
**替换的是整个进程的 `fetch` 实现**。也就是说每一次带 API key 发往 provider 的请求都走它。

| | |
|---|---|
| 通告 | undici vulnerable to TLS certificate validation bypass via dropped requestTls（CWE-295，high） |
| 影响范围 | `>=8.0.0 <8.5.0`；本仓原为 **8.3.0** |
| 处置 | 升到 **8.9.0**（非 major）。同时清掉该包其余 11 条 `<8.9.0` 通告（含 WebSocket DoS、Set-Cookie 头注入、跨用户缓存信息泄露、retry 拦截器响应错位等） |
| 验证 | `npm run build` / `npm test`（4081 passed / 0 failed）/ `npm run check` 全部 exit 0；shrinkwrap 已重生成 |

注：npm registry 在本环境有日期截止（2026-08-02），`8.10.0` 不可安装；8.9.0 是截止前的最高版本，
且已覆盖全部相关通告。

### 2.2 剩余 9 条：逐条定性

`total 9`（critical 3 / high 5 / low 1）。**没有一条落在发布包的凭据或执行路径上。**

| 包 | 级别 | 进入发布包？ | 定性 |
|---|---|---|---|
| `vitest` | critical | 否 | Vitest UI server 监听时可读/执行任意文件。**dev-only**，且本仓从不启动 UI server |
| `@vitest/coverage-v8` | critical | 否 | 同上，覆盖率工具 |
| `shell-quote` | critical | 否 | `quote()` 不转义换行。**不在发布树内**（`npm-shrinkwrap.json` 零命中）——本仓的 bash 工具不经它 |
| `vite` / `esbuild` / `postcss` | high / low / high | 否 | 全部是 dev server / 构建期路径遍历类，dev-only |
| `ws` | high | **是** | 内存耗尽 DoS。经 `@google/genai` / `openai` / `@mistralai/mistralai` 传递，三家都锁 `8.20.1` |
| `protobufjs` | high | **是** | JSON 转换时 Any 无界展开 DoS。经 `@google/genai` 传递 |
| `brace-expansion` | high | **是** | 指数级展开 DoS |

**三条进入发布包的都是 DoS 类**（可用性），**无机密性或完整性影响**，且都需要攻击者控制输入才能
触发——在本产品里那意味着攻击者已经控制了模型响应或 glob 模式。三者都锁在 vendor SDK 的依赖里，
单独提升需要动 `@google/genai` / `openai` / `@mistralai/mistralai` 的主版本，那是一次独立的、
需要自己回归验证的变更，不适合在最终审计的当口做。**记录并移交 backlog，不在本 phase 处置。**

### 2.3 已修复：`pi-ai` CLI 把 OAuth 令牌写进当前工作目录

phase 19 复查 ED14 时顺带发现，不在 `npm audit` 的覆盖面内。

`packages/ai/src/cli.ts` 的 `AUTH_FILE` 是**裸相对路径** `"auth.json"`：

```ts
const AUTH_FILE = "auth.json";
function saveAuth(auth) { writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), "utf-8"); }
```

`pi-ai login <provider>` 会把 access + refresh 令牌写到**用户当时所在的任意目录**，用默认权限。
在一个仓库里跑一次，凭据就落在源码旁边——本仓 `.gitignore` 只覆盖 `.env`，所以它不被忽略，
随时可能被提交；同机其他账户也可读。没有任何提示，也没有清理。

- **是发布面**：`packages/ai` 可发布（`files: ["dist","README.md"]`，无 `private`），
  `bin: {"pi-ai": "./dist/cli.js"}`。
- **oracle 没有对应物**：`crates/ai` 既无 `src/bin` 也无 `[[bin]]`，这是 pi 骨架带来的额外 CLI。
- **零测试、零模块引用**：全仓无任何文件 import 它。

处置：改为解析到用户配置目录（`PIE_DIR` → `PI_CODING_AGENT_DIR` → `~/.pie`，与
`coding-agent/src/config.ts` 的 `getAgentDir()` 优先级一致），目录 0700、文件 0600，
且成功提示改为打印**解析后的绝对路径**（用户需要知道令牌现在在哪，尤其因为它以前在 cwd）。
优先级逻辑是**手抄**而非 import——RULEBOOK §4 禁止 `ai` 依赖 `coding-agent`，两处需人工保持同步。

不产生格式冲突：存储形状与 `coding-agent/src/core/auth-storage.ts:715` 写出的
`Record<providerId, {type:"oauth"} & OAuthCredentials>` 逐字段相同，指向同一文件是**统一**而非碰撞。

**遗留给用户的决定**（已入 backlog，未自行处置）：oracle 根本不提供 `pi-ai` 这个 CLI。
本仓是 pie 的重写，是否应该继续发布这个骨架带来的二进制，是一个范围问题而不是安全问题——
安全问题本身已经修掉了。

## 3. `.claude/settings.json` deny 终审

deny 清单在整个迁移期间起过作用（CLAUDE.md standing rule 5：被 deny 挡住说明设计在起作用——
上报，不绕行）。本次运行中它多次挡住破坏性删除命令，每次都改用更窄的命令而非绕行。清单保持不变。

## 4. 结论

- src 树无硬编码密钥。
- 发布包唯一的机密性/完整性级依赖缺陷（undici CWE-295）**已修并验证**。
- 剩余全部为 dev-only 或 vendor SDK 传递的 DoS 类，逐条定性并移交 backlog。
