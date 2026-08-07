# 批 H —— ai + mcp 包 36 条 → **513/513**

本 phase 结束时名册满额。

## 裁定分布

| 裁定 | 条数 |
|---|---|
| `existing-test` | **22** |
| `new-test` | **1** |
| `not-portable` | **13** |
| 合计 | **36** |

`not-portable` 占比 **36.1%** —— 本轮四批中最低（U 70% · F 43.1% · G 48.1% · H 36.1%）。
原因是 ai 包的核心路径（stream / models / google_shared / mcp client）测试语料最扎实。

## 新写的测试

`packages/ai/test/ported/batch-h.test.ts`，2 例，覆盖 `isCloudflareProvider`：

它是 `{VAR}` base-URL 替换的开关。**假阳性**会把非 Cloudflare 的 provider 送进占位符解析、
产出畸形 endpoint；**假阴性**会让 `{ACCOUNT_ID}` 原样留在 URL 里。测试同时钉死了
两个正例与三个反例（含 `"cloudflare"` 这个近似串）。

## `not-portable` 13 条的形态

| 形态 | 条数 | 例 |
|---|---|---|
| **真能力缺口** | 1 | `bedrock_provider::register` —— `bedrock-provider.ts` 只有 6 行占位，注册的是空壳 |
| **TypeBox 替代自建** | 3 | oracle 手写 `boolean()`/`number()`/`object()` 产 JSON Schema；本仓直接用 `Type.Boolean()` 等，只为 `StringEnum` 保留自建包装（因为 TypeBox 的 falsy-default 行为需要修正）|
| **ES module 替代幂等守卫** | 2 | 两个 `register_builtins::ensure` —— 本仓在模块顶层注册，ES module 天然只求值一次 |
| **oracle 的占位函数** | 2 | 两个 `placeholder()` —— Rust 需要非空模块，TS 不需要 |
| **全局注册表不存在** | 2 | `register_custom_model` / `unregister_custom_model` —— 本仓自定义模型由 coding-agent 的 local-models.ts 在各自作用域管理，ai 层无全局可变注册表 |
| **拆成多个函数** | 1 | `copilot_headers` → `buildCopilotDynamicHeaders` + `hasCopilotVisionInput` + `inferCopilotInitiator` |
| **构造器 private** | 1 | `mcp/client::new` —— 本仓经 `connect()` 建实例 |
| **对象字面量替代构造器** | 1 | `faux_thinking` |

判据 3：**13/13 条理由含 `packages/` 路径或 TS 标识符**。

## 抽查（规则先于结果声明）

**规则**：23 条非 not-portable 等距抽 `max(5, ⌈23/5⌉)` = **5** 条（实取 6），
步长 4，从 index 0 起。抽中 #0 · #4 · #8 · #12 · #16 · #20。

**6/6 通过三问。** 其中 **2 条发现同测试块内有更强断言，已上调**：

| 抽中 | 原证据 | 上调为 |
|---|---|---|
| `stream.rs::stream@19` | `agent-loop.test.ts:117` `expect(messages.length).toBe(2)` | `:119` `expect(messages[1].role).toBe("assistant")` —— 断言**角色序列**而非仅条数 |
| `client.rs::take_notifications@179` | `client-fixture.test.ts:211` `expect(receiver).toBeDefined()` | `:215` `expect(first?.method).toBe("notifications/tools/listChanged")` —— 断言**通知方法名**而非「有东西」 |

一条**保留并标注为偏弱**：`models.rs::list_models@34` → `bedrock-models.test.ts:29`
的 `expect(models.length).toBeGreaterThan(0)`。同测试块内没有更强的断言，
且 `list_models` 返回的是全量目录（内容随 MODELS 常量表变化，钉死具体条数会让
每次加模型都红）。**「有模型」确实是它能给的最强不变量**，但它证明的是「非空」不是「对」。

## 513/513 达成

```
check:behavior-evidence: OK — 名册 513 条，逐条在 oracle 中存在；已裁定 513/513
  existing-test 321 · new-test 46 · not-portable 144（existing 命中率 87.5%）
  批 HIGH 45/45 · A 52/52 · B 45/45 · C 49/49 · D 53/53 · E1 42/42 · E2 41/41
  批 U 40/40 · F 58/58 · G 52/52 · H 36/36
  全部裁定完毕，可把 REQUIRE_COMPLETE 置 true，让门禁从此不接受遗漏。
```

## 命令与结果

```
node scripts/probe-ts-counterpart.mjs --batch H   36 条 → stub 2 · substantial+named 18 · substantial 16
node scripts/check-behavior-evidence.mjs          批 H 36/36；**累计 513/513**
npm run check                                     exit 0（11 门禁）
bash test.sh                                      exit 0 — 4412 passed / 0 failed（+2）
密闭性                                            ~/.pie/sessions 3316 → 3316，增量 0
```
