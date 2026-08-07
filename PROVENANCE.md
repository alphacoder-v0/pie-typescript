# PROVENANCE

本仓库是 **pie 的 TypeScript 完整重写**，采用 "fork pi TS 骨架 + 逐能力移植 pie 增量" 路线。

## 上游与固定 SHA

| 角色 | 仓库 | SHA | 说明 |
|---|---|---|---|
| 迁移源 / 行为 oracle | github.com/c4pt0r/pie | `0a120dfd380fb7f009e09f2b7981b76c07b3fd95` | Rust 版 pie；行为对齐的唯一 spec（bug-for-bug） |
| TS 骨架 | github.com/earendil-works/pi | `4868222e3414554987bf4b05fbb393fc65080aa0` | pie 公开前最近的 pi 主线；packages/* 直接 vendor 自该 SHA |
| 参考（版本对齐） | 同上 | `12f5c00cc1332e04d18e2120b71731627174bcc7` | v0.75.0，与 pie Cargo workspace 版本一致 |
| 参考（当前） | 同上 | `4c01c709380621c5ff2719162cd7a7973dcb2799` | 2026-08-02 冻结头 |

workers/fefe-hub 直接复制自 pie oracle（该目录在上游即为 TypeScript）。

## 包名映射

| pi 上游包 | 本仓包 |
|---|---|
| @earendil-works/pi-ai | @pie/ai |
| @earendil-works/pi-agent-core | @pie/agent-core |
| @earendil-works/pi-coding-agent | @pie/coding-agent |
| @earendil-works/pi-tui | @pie/tui |
| （无，pie 独有 crate） | @pie/mcp（phase 6 新建） |

保留未改写的 @earendil-works 出现处（有意）：
- `tsconfig.json` 的 `pi-agent-old` 路径别名（指向不存在的 packages/agent-old，上游即如此，惰性）
- `packages/coding-agent/test/config.test.ts` 的全局安装布局 fixture 路径（任意路径组件，生产代码经 PI_PACKAGE_DIR/向上查找解析，不依赖 scope 字符串）
- `packages/coding-agent/src/migrations.ts` 等处指向上游 GitHub 的文档 URL

## .claude/settings.json 相对 kit 模板的调整

依据 kit `templates/settings.README.md` 自身指引与 README Step 4（cheap referee dissolve）：
1. 移除 `npm test` / `npx tsc` deny —— TS typecheck 便宜，溶解进翻译循环
2. 移除 `git commit` / `git checkout` deny —— 编排者与执行者同会话，batch 边界提交由编排者执行；loop 子代理由 prompt 禁止 git 写操作，此偏离记入 migration/RULEBOOK.md Deviation log
3. 保留 cargo 全 deny —— oracle 构建/测试一律经 `migration/parity/*.sh` 封装脚本于外部 checkout 执行

## License 链

- pi：MIT，Copyright (c) 2025 Mario Zechner（根 LICENSE 即其原文，随骨架 vendor）
- pie：MIT，Copyright (c) 2026 c4pt0r/dongxu（oracle 仓 LICENSE）
- 本仓：MIT；三方版权见 NOTICE

## Bootstrap 期间的骨架适配（phase 1，全部为可复核的最小改动）

1. **hermetic 构建**：`packages/ai` 的 build 原为 "generate-models（网络拉取 models.dev/OpenRouter 实时数据）→ tsc"，会把 vendored 的 `models.generated.ts`/`image-models.generated.ts` 刷成当日数据、与骨架测试的模型 ID 漂移。改为 build=仅 tsc；生成移入显式 `npm run regen-models`（opt-in）。生成文件已恢复为 pi@4868222e 的 vendored 版本。
2. **workers/fefe-hub 依赖精确固定**：typescript 5.9.3、wrangler 4.95.0（取自其 package-lock 已解析版本），满足根 check:pinned-deps 的精确版本要求（pie 上游用 ^ 范围）。
3. **check:ts-imports 排除 `workers/`、`migration-kit/`**：worker 是自带工具链（tsc+wrangler、`.js` 后缀导入约定）的 reuse 单元，不受 pi 源码约定管辖；migration-kit 为方法论 vendor。
4. **workers/fefe-hub/scripts/embed-html.mjs 路径适配**：`crates/coding-agent/src/ui/web_index.html` → `packages/coding-agent/src/ui/web_index.html`（资产已自 oracle 落位，ui TS 模块在 phase 15 移植）。
5. **根 test 脚本固定 `PI_NO_LOCAL_LLM=1`**：本机装有 ollama，骨架的 local-LLM 测试会自动 `ollama pull gpt-oss:20b`（13 GB）并对本地模型做真实推理——网络/磁盘重且非确定。上游自带该环境开关，本仓默认启用；需要时可显式 `PI_NO_LOCAL_LLM= npm test` 恢复。
6. **`npm test` 默认 hermetic**：根 `test` 改为调用上游自带的 `test.sh`（备份 `~/.pi/agent/auth.json`、unset 全部 provider 密钥、`PI_NO_LOCAL_LLM=1`），其内层改调 `test:raw`。原因：本机存在真实凭据（GEMINI_API_KEY 环境变量、pi auth.json 内 OAuth token），裸跑会对真实 provider 计费且非确定。裸跑仍可用 `npm run test:raw`。
7. **`packages/ai` 模型目录对齐 oracle 冻结快照（phase 7）**：条目 1 恢复的 pi@4868222e vendored 快照（32 providers / 942 models）与 oracle（pie@0a120dfd380fb7f009e09f2b7981b76c07b3fd95）冻结的目录（32/938）不一致——parity 场景 S1 逐字断言 `Supported providers (32), models (938): amazon-bedrock(84), ...`（`migration/parity/out/oracle/S1/help.norm`），bug-for-bug parity 要求 TS 目录与 oracle 目录严格相等。新增 `packages/ai/scripts/gen-models-from-oracle.mjs`：离线、确定性地从 oracle 的权威快照 `$ORACLE_PIE_DIR/crates/ai/src/models.generated.json`（`migration/sources.env` 的 `ORACLE_PIE_DIR`；该 JSON 由 oracle 自身的 `models_generated.rs` 文件头注明系从这份 TS 文件提取而来，结构可逆向）生成 `models.generated.ts`，保持原有 `export const MODELS` 契约、字段顺序与格式风格不变，仅替换数据。运行方式：`cd packages/ai && npm run regen-models`（现指向该离线脚本；原网络实时生成脚本改名为 `npm run regen-models:live` 予以保留）。差异仅为 pi 快照独有、oracle 快照冻结时尚未存在的 4 个模型（`fireworks/accounts-fireworks-models-deepseek-v4-flash`、`google/gemini-3.5-flash`、`openrouter/google-gemini-3.5-flash`、`vercel-ai-gateway/google-gemini-3.5-flash`）及共有 938 模型中 oracle 快照与 pi 实时数据不同步的字段值（cost/contextWindow/maxTokens）；经全量 `getModel()` 调用点审计，`packages/ai/test/` 无任何用例引用被移除的 4 个 ID，未改动任何测试。详见 `migration/reviews/ai/divergence-ledger.tsv` 的 `ai/models_generated` 行（verdict `applied`）。
7. **模型目录对齐 oracle 快照**（phase 7）：`packages/ai/src/models.generated.ts` 原为 pi@4868222e 的 vendored 快照（32 providers / 942 models），与 oracle pie@0a120dfd 冻结的 32/938 不符——而 parity 场景 S1 逐字断言 `Supported providers (32), models (938)`。改为从 oracle 的权威快照 `crates/ai/src/models.generated.json` 离线重生成（脚本 `packages/ai/scripts/gen-models-from-oracle.mjs`，`npm run regen-models`）；原联网重生成脚本保留为 `regen-models:live`。多出的 4 条（gemini-3.5-flash ×3、deepseek-v4-flash ×1）是 pi 快照日期较新引入，非行为增量。
8. **`packages/ai/src/utils/vertex-adc.ts` 惰性加载 node 内建**（phase 7）：该模块（pie 独有的 Vertex ADC service-account JWT 交换）需要 `node:crypto`/`node:fs`，但 `@pie/ai` 有浏览器打包面约束（`scripts/check-browser-smoke.mjs` 用 esbuild `platform:"browser"` 打整个包）。骨架既有的 node-touching 模块（`utils/node-http-proxy.ts`）靠改用 npm 包规避，ADC 无对应 npm 替代，故改为经变量 specifier 的动态 `import()`——静态 import 与字面量 `import("node:crypto")` 都会被 esbuild 解析并失败。`loadVertexServiceAccount`/`buildVertexJwt` 因此变为 async。

## 两侧皆无的新增行为（本仓自有）

1. **Rust-pie 凭据的只读兼容导入**（phase 19，ED14）：`packages/coding-agent/src/core/auth-storage.ts` 能读取 oracle 形状的 `auth.json`（`{version, providers:{id:{kind:"api_key"|"oauth",...}}}`，见 `$ORACLE_PIE_DIR/crates/coding-agent/src/auth.rs:25-73`）并映射进本仓的扁平 `Record<provider, AuthCredential>`。**两侧皆无**：oracle 只认自己的形状，pi 只认自己的形状；该导入是 phase 9/12 裁决「两侧共用 `~/.pie/auth.json`」派生出的升级路径要求——否则从 Rust pie 升级来的用户会静默显示为未登录，其凭据虽仍留在文件里却永不再被读取。写侧不变（仍只写 pi 扁平格式），故转换是单向的：首次 `/login`/`/logout`/OAuth 刷新会把整份文件改写成本仓格式，并带上全部已导入凭据。形状检测不只看 `version`（顶层键须 ⊆ `{version, providers}`、`providers` 须为普通对象、每条须是 `kind` tagged 且可完整映射；`providers` 为空时另需数值 `version`），任一条目不可映射则整份不导入并退回既有行为（与 oracle serde 的 all-or-nothing 一致，且不抛错）。`expires_at` 秒→毫秒；缺 `expires_at` 按 oracle `needs_refresh(None) == false` 视为不过期。本仓无字段可承载的 oracle 独有字段（今为 `scopes`）原样存入凭据的 `rustPieFields`，`set`/`remove` 与 OAuth 刷新回写均保留，绝不静默丢弃。
