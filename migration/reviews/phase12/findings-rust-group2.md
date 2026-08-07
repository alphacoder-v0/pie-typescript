# Phase 12 · Reviewer B（对照 Rust 源）· 第二组 5 单元

范围：mcp_loader · auth · oauth · lsp · lsp_supervisor
判定：11 条 CONFIRMED + 1 条待裁决 + 6 条 LOW/UNSURE

## 三个重点问题的结论

1. **B5 复刻正确**：读取时机、覆盖方向（`[user, project]` + Map 覆写保位 ≡ oracle 的 `Vec::position()` 就地替换）、无条件立即 spawn、未误加门——四项全部一致。但方向上出了**反向**问题（D3：丢了 oracle 的数值校验，使 oracle 会整份拒绝的配置在 TS 侧照常 spawn，等于把 B5 放大）。
2. **oauth 两项主张独立核实为真**：`oauth.rs` 确实零调用点（排除自身后 grep 零命中，文件头 `#![allow(dead_code)]`）；拒绝 inline key 的 usage 串与 `commands.rs` 逐字节一致（含 `<provider>` 后的双空格）。
3. **lsp 懒 spawn 确认**：全仓 `LspClient.spawn` 在 src 下唯一出现于 `lsp-supervisor.ts:189`，调用链 `attachDiagnostics → ensureOpen → clientForExt → spawnAndInitialize`，且在工具名/路径/扩展名三重命中之后。`load()`/`fromConfig()` 不起进程。

## CONFIRMED（编排者裁决：交 fixer）

### mcp-loader.ts
| # | 级别 | 分歧 | 可观测输入 |
|---|---|---|---|
| B-D1 | MED | 无 auth 时也创建 `~/.pie/auth.json`：oracle `mcp_loader.rs:314-317` 在 `AuthStore::load()` **之前**早退；TS `mcp-loader.ts:369-371` 实参先求值，`AuthStorage.create()` 无条件跑 `ensureParentDir`+`ensureFileExists` | 机器无 auth.json + 配一个不带 `auth` 字段的 streamable_http 服务器 → oracle 不碰凭据目录，TS 创建 `~/.pie/`(0700) 与内容 `{}` 的 auth.json(0600) |
| B-D2 | LOW-MED | 凭据库加载失败的错误路径丢失：oracle `mcp_loader.rs:319-320` 包 `failed to load local credential store: {e}`；TS `reload()` 把异常吞进 `loadError` 从不抛 | auth.json 损坏 + 一个 bearer auth 服务器 → oracle 归因"库坏了"，TS 误报成"没登录" |
| B-D3 | MED | **数值字段校验丢失（放大 B5）**：oracle `mcp_loader.rs:40-42,76` 的 `Option<u64>`/`Option<usize>` 遇负数/小数整份文件解析失败→全部服务器不启动；TS `Type.Optional(Type.Number())` 只查 `=== 0` | `.pie/mcp.toml` 写 `request_timeout_ms = -1` → oracle 打印 parse failed 且该文件**所有**服务器（含 stdio `command`）一个不启，TS 全部照常 spawn |

### auth-storage.ts（ED13/ED14 已裁决，不重复）
| # | 级别 | 分歧 | 可观测输入 |
|---|---|---|---|
| B-D4 | **HIGH** | 空白/损坏 auth.json 静默禁用所有写入：oracle `auth.rs:86-88` 对 `text.trim().is_empty()` 返回空库、解析失败经 Result 上抛；TS `parseStorageData` 只对 falsy 返回 `{}`，`"\n"` 是 truthy → JSON.parse 抛 → 被 `loadError` 吞 → `persistProviderChange` 此后永远 early-return | `~/.pie/auth.json` 只含一个换行 → oracle 视为空库正常保存；TS 的 `set()` 只改内存**一声不吭地不落盘**，用户看到登录成功、重启后凭据消失 |
| B-D5 | MED | 落盘非原子 + 权限窗口：oracle `auth.rs:99-115` 写 tmp→chmod 0600→rename；TS `writeFileSync` 直接覆写目标后才 chmod，`ensureFileExists` 亦然 | 写入中被杀/磁盘满 → oracle 旧文件完好，TS 留下截断文件（随即触发 B-D4 的静默写禁用）；另有 umask 0644 可读窗口 |

### oauth.ts（全部落在 oracle 死代码区，但 TS 侧将被接线）
| # | 级别 | 分歧 | 可观测输入 |
|---|---|---|---|
| B-D8 | MED | refresh 失败错误前缀错了：oracle `oauth.rs:148-151` 是 `refresh endpoint {status}`，`exchange_code`(:173) 才是 `token endpoint`；TS 两者共用 `postForm` 都报 `token endpoint` | refresh 端点返回 400 → 无法区分刷新失败与首次换码失败 |
| B-D9 | MED | token 响应零校验：oracle `from_str::<TokenResponse>` 的 `access_token` 必填；TS 是 `JSON.parse(text) as TokenResponse` 纯断言 | 端点回 HTTP 200 + `{"error":"invalid_grant"}` → oracle 报 missing field 并失败，TS 成功 resolve 出 `access_token === undefined` 并一路流进 auth store |
| B-D10 | LOW | 超时文案 `after {timeout:?}`（`120s`）vs `after 120000ms` | 任一超时 |
| B-D11 | LOW | bind 失败归错类：oracle 对 `TcpListener::bind` 单独加 context；TS 把 server 所有 error（含 EADDRINUSE）统一包成 `OAuth callback read failed` | redirect 端口被占用 |

### lsp.ts
| # | 级别 | 分歧 | 可观测输入 |
|---|---|---|---|
| B-D12 | MED | `exit` 通知线上字节不同：oracle `json!` 把 None 序列化为 `params:null`；TS `JSON.stringify` 把 `undefined` 的 key 整个丢掉 | 每次 `shutdown()` → LSP 服务器收到的帧内容与 Content-Length 都不同 |
| B-D13 | MED | publishDiagnostics 逐条校验丢失：oracle `from_value::<PublishDiagnosticsParams>` 任一条不合规即**整条通知丢弃**；TS `isPublishDiagnosticsParams` 只查 uri 是 string、diagnostics 是数组 | 推送缺 `range` 的 diagnostic → oracle 忽略，TS 写缓存并在 `lsp-supervisor.ts:277` 读 `d.range.start.line` 抛 TypeError，异常从 after-tool-call 钩子逃逸 |
| B-D14 | LOW | 重复/畸形 Content-Length：oracle 后一条解析失败会把已解析值**重置为 None**；TS 只在正则命中时赋值，保留前值 | 一帧含 `Content-Length: 42` 后跟 `Content-Length: abc` |
| B-D15 | LOW | `method` 非字符串：oracle 判据是 `is_none()`，TS 是 `typeof === "string"` | 服务器回 `{"id":1,"method":5}` → oracle 不兑现在途请求（等到 15s 超时），TS 兑现并返回 null |
| B-D17 | LOW | 请求超时文案 `after 15s` vs `after 15000ms` | 任一请求超时 |

## 编排者裁决：不修，记为 ED16

**B-D6（OAuth 自动刷新）**：oracle `auth.rs:139-143` 的 `resolve_for_provider` 对 Oauth 分支直接返回 `access_token`，**从不刷新**（`needs_refresh` 是死代码）；TS 过期即刷新并回写。这与 ED13/ED14 同源：我们**有意**保留 TS 侧可用的 OAuth。单独立项为 ED16，不作为缺陷修复。

**B-D7**（`needs_refresh` 的 slack 参数缺失、epoch 秒 vs 毫秒）：oracle 该函数零调用点，不可观测，仅记录。

## LOW / UNSURE（记录，不修）

- **B-D16**：`diagnosticsFor` 返回内部数组引用，oracle 返回 `cloned()`。当前无调用方改动返回值。
- **UNSURE-1**：`urldecode` 的 `charCodeAt` 在 >0xFF 时会被 `Buffer.from` 截断，但唯一真实路径 `req.url` 经 node:http 按 latin1 解析后逐字节回环结果相同，且函数未导出 → 给不出稳定可观测输入。
- **lsp-supervisor LOW**：`lsp-supervisor.ts:180-185` 在 promise 拒绝时无条件 `clients.delete(lang.id)`，未校验被删的仍是自己那个 pending；并发下可能重复 spawn。oracle 的 `OnceCell::get_or_try_init` 结构上不可能。当前工具调用基本串行，无稳定复现输入。

## OK
- **lsp_supervisor.ts**：懒 spawn 唯一路径确认；`[~/.pie, <cwd>/.pie]` 顺序、按 id 覆写保位、读/解析失败静默 continue、同扩展名后出现的 language 胜出、`renderDiagnostics` 的 take(20)/`(N more)`/`line+1:character+1`/severity 映射——逐项一致。

## 跨单元 wiring gap（非翻译分歧，交 phase 13 记账）

`loadAll`、`LspSupervisor.load`、`asAfterToolCallHook` 三者在 TS 侧**均无生产调用点**（oracle 分别在 `main.rs:660` 与 `main.rs:783-786` 启动时挂载）。后果：
1. B5 缺陷已逐字复刻但当前在 TS 二进制中**不可达**；
2. LSP 诊断附着功能整体未生效。

phase 13（CLI 组装）必须接线这三处，否则 phase 17 的 parity 会因"功能没跑起来"而假绿。
