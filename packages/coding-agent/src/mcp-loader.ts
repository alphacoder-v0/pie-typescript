/**
 * MCP server configuration loader. Port of oracle `crates/coding-agent/src/mcp_loader.rs` (pie
 * @0a120dfd). Reads `~/.pie/mcp.toml` (and `<cwd>/.pie/mcp.toml`), spawns each configured stdio
 * server, runs the initialize+tools/list handshake, and returns the resulting `AgentTool` list
 * ready to append to `defaultTools()`.
 *
 * Failure is non-fatal at the load level: a server that fails to start emits a startup
 * diagnostic and is skipped. The agent runs without it.
 *
 * ---
 *
 * PORT-DIVERGENCE: B5 (RULEBOOK §5, oracle mcp_loader.rs:98-139, 239-253) -- **project configs
 * are now trust-gated**.
 *
 * What oracle does: it reads project `.pie/mcp.toml` unconditionally on every load and spawns a
 * stdio server's `command` immediately once its config parses -- no confirmation, no allowlist, no
 * environment override to suppress it -- and a same-named project entry silently overrides the
 * user's `~/.pie/mcp.toml` entry. Anyone who clones an untrusted repository and opens it gets an
 * arbitrary subprocess spawned on their machine with no prompt. That was reproduced bug-for-bug
 * through phase 17 because parity required it.
 *
 * Why we now differ: this is the most serious item on the §5 ledger -- remote code execution on
 * `cd`. Phase 18 deliberately diverges. `<cwd>/.pie/mcp.toml` is not read at all unless the
 * project directory is trusted (`core/project-trust.ts`: `~/.pie/trust.json`, `--trust-project`,
 * or `PIE_TRUST_PROJECT=1`). An existing-but-untrusted file is skipped with one stderr notice --
 * staying silent would be worse than the bug, because the user would not know their config was
 * ignored. Trusting a project does not restore the *silent* override either: a trusted project
 * entry still wins over a same-named user entry, but the substitution is announced (see
 * `noteProjectEntryOverride`). The user-scope `~/.pie/mcp.toml` is untouched by the gate.
 *
 * `hooks.ts` already had the equivalent (coarser) opt-in for project `.pie/hooks.toml` via
 * `allow_project_hooks`/`PIE_ALLOW_PROJECT_HOOKS`; this closes the same hole for MCP.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@pie/agent-core";
import {
	createHttpMcpTransportOptions,
	type HttpMcpAuth,
	HttpMcpTransport,
	type HttpMcpTransportOptions,
	McpClient,
	StdioTransport,
} from "@pie/mcp";
import { parse as parseToml } from "smol-toml";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import {
	isProjectTrusted,
	noteProjectEntryOverride,
	noteUntrustedProjectConfig,
	projectConfigDirIsUserConfigDir,
} from "./core/project-trust.ts";
import { McpAgentTool } from "./tools/mcp-adapter.ts";
import { McpNotificationHook } from "./triggers/mcp-notification-hook.ts";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// mcp.toml schema (RULEBOOK §1: smol-toml + typebox). Field names are wire names (the literal
// TOML keys users author) -- snake_case, matching oracle's serde struct verbatim.
// pie: mcp_loader.rs:24-77.
// ─────────────────────────────────────────────────────────────────────────────────────────

const ServerKindSchema = Type.Union([Type.Literal("stdio"), Type.Literal("streamable_http")]);

/** pie: mcp_loader.rs:66-70 (`HttpAuthConfig`). */
const HttpAuthConfigFileSchema = Type.Object({
	kind: Type.String(),
	token_keychain_ref: Type.Optional(Type.String()),
});

/**
 * The `u64` / `usize` numeric fields below. Oracle declares these as Rust unsigned integers
 * (mcp_loader.rs:40-42 `Option<u64>`/`Option<usize>`, mcp_loader.rs:74-76 same), so serde refuses
 * a negative or fractional TOML value at *deserialization* time. That failure is not scoped to
 * the offending field or even to the offending `[[server]]` -- `toml::from_str::<McpConfig>` fails
 * for the whole document, so `read_config` (mcp_loader.rs:191-199) takes its `parse failed` branch
 * and returns `None`, dropping **every** server declared in that file. Modelling these as bare
 * `Type.Number()` would accept `-1` / `1.5` and let the rest of the file's servers (including
 * stdio `command`s) spawn where oracle starts none of them -- i.e. strictly more permissive than
 * the B5 defect this port pins. `Type.Integer({ minimum: 0 })` reproduces serde's domain.
 */
const UnsignedIntSchema = Type.Integer({ minimum: 0 });

/** pie: mcp_loader.rs:72-77 (`ReconnectConfig`). */
const ReconnectConfigFileSchema = Type.Object({
	initial_ms: Type.Optional(UnsignedIntSchema),
	max_ms: Type.Optional(UnsignedIntSchema),
	max_attempts: Type.Optional(UnsignedIntSchema),
});

/** pie: mcp_loader.rs:30-56 (`ServerConfig`). Deliberately permissive of extra/unknown TOML
 * keys (no `additionalProperties: false`), matching serde's default struct deserialization. */
const ServerConfigFileSchema = Type.Object({
	name: Type.String(),
	kind: Type.Optional(ServerKindSchema),
	command: Type.Optional(Type.String()),
	args: Type.Optional(Type.Array(Type.String())),
	endpoint: Type.Optional(Type.String()),
	auth: Type.Optional(HttpAuthConfigFileSchema),
	request_timeout_ms: Type.Optional(UnsignedIntSchema),
	sse_idle_timeout_ms: Type.Optional(UnsignedIntSchema),
	body_cap_bytes: Type.Optional(UnsignedIntSchema),
	reconnect: Type.Optional(ReconnectConfigFileSchema),
	inject_summary: Type.Optional(Type.Boolean()),
	inject_and_run: Type.Optional(Type.Boolean()),
});

/** pie: mcp_loader.rs:24-28 (`McpConfig`). */
const McpConfigFileSchema = Type.Object({
	server: Type.Optional(Type.Array(ServerConfigFileSchema)),
});

const validateMcpConfigFile = Compile(McpConfigFileSchema);

type ServerConfigFile = Static<typeof ServerConfigFileSchema>;

/** pie: mcp_loader.rs:58-64 (`ServerKind`), unit-only enum -> string literal union
 * (RULEBOOK §2.1). Default `"stdio"` matches `#[derive(Default)]` on the Rust enum. */
export type ServerKind = Static<typeof ServerKindSchema>;

/** pie: mcp_loader.rs:66-70 (`HttpAuthConfig`). */
export interface HttpAuthConfig {
	kind: string;
	token_keychain_ref?: string;
}

/** pie: mcp_loader.rs:72-77 (`ReconnectConfig`). */
export interface ReconnectConfig {
	initial_ms?: number;
	max_ms?: number;
	max_attempts?: number;
}

/** pie: mcp_loader.rs:30-56 (`ServerConfig`), defaults normalized in (kind, args, inject_*). */
export interface ServerConfig {
	name: string;
	kind: ServerKind;
	command?: string;
	args: string[];
	endpoint?: string;
	auth?: HttpAuthConfig;
	request_timeout_ms?: number;
	sse_idle_timeout_ms?: number;
	body_cap_bytes?: number;
	reconnect?: ReconnectConfig;
	inject_summary: boolean;
	inject_and_run: boolean;
}

/** pie: mcp_loader.rs:24-28 (`McpConfig`), normalized (server defaults to `[]`). */
export interface McpConfig {
	server: ServerConfig[];
}

function normalizeServerConfig(raw: ServerConfigFile): ServerConfig {
	return {
		name: raw.name,
		kind: raw.kind ?? "stdio",
		command: raw.command,
		args: raw.args ?? [],
		endpoint: raw.endpoint,
		auth: raw.auth,
		request_timeout_ms: raw.request_timeout_ms,
		sse_idle_timeout_ms: raw.sse_idle_timeout_ms,
		body_cap_bytes: raw.body_cap_bytes,
		reconnect: raw.reconnect,
		inject_summary: raw.inject_summary ?? false,
		inject_and_run: raw.inject_and_run ?? false,
	};
}

/**
 * Parse mcp.toml text into a normalized `McpConfig`, or an error string. Pure function (no I/O)
 * so tests can drive it directly, same posture as `hooks.ts`'s `parseHooksFileText`.
 */
export function parseMcpConfigText(text: string): McpConfig | { error: string } {
	let parsed: unknown;
	try {
		parsed = parseToml(text);
	} catch (error) {
		return { error: errorMessage(error) };
	}
	if (!validateMcpConfigFile.Check(parsed)) {
		return { error: "invalid mcp.toml shape" };
	}
	const file = parsed as Static<typeof McpConfigFileSchema>;
	return { server: (file.server ?? []).map(normalizeServerConfig) };
}

/**
 * Output of loading. Holds tools (to register with the agent), diagnostics (startup failures to
 * print to the user), and notification hooks (one per MCP server that successfully connected --
 * the caller is expected to register each with the harness once it's built so MCP server pushes
 * drive the runtime trigger pipeline). pie: mcp_loader.rs:79-96 (`LoadedMcp`).
 */
export interface LoadedMcp {
	tools: AgentTool<any>[];
	diagnostics: string[];
	clientCount: number;
	serverNames: string[];
	notificationHooks: McpNotificationHook[];
	/** Names of servers configured with `inject_summary = true`. The caller wires these into
	 * `triggers::direct_inject_action_hook` so their pushes bypass the sub-agent. */
	injectSummaryServers: Set<string>;
	/** Names of servers configured with `inject_and_run = true` -- injected summary plus one
	 * model turn in the parent context. */
	injectAndRunServers: Set<string>;
}

/**
 * Load and connect every MCP server from the user config plus -- when the project directory is
 * trusted -- the project config. Project entries with the same `name` as a user entry override,
 * and the override is announced. pie: mcp_loader.rs:98-140 (`load_all`).
 */
export async function loadAll(cwd: string): Promise<LoadedMcp> {
	const diagnostics: string[] = [];
	const projectPath = join(cwd, CONFIG_DIR_NAME, "mcp.toml");
	const userPath = join(getAgentDir(), "mcp.toml");

	// A `Map` preserves the *original* insertion position on overwrite, matching oracle's
	// `Vec::position()` + in-place replace -- new names still append in encounter order.
	const configsByName = new Map<string, ServerConfig>();

	// User scope is always read; the trust gate below is about the *project* file only.
	const userConfig = await readConfig(userPath, diagnostics, "user");
	if (userConfig !== undefined) {
		for (const s of userConfig.server) {
			configsByName.set(s.name, s);
		}
	}

	// PORT-DIVERGENCE: B5 -- see module doc. Oracle reads `projectPath` here unconditionally (its
	// `load_all` just iterates `[user, project]`), so a `.pie/mcp.toml` shipped inside a freshly
	// cloned repository spawned its `command` on the next startup. The gate below is the fix: the
	// project file is not even read unless the directory is trusted, and an untrusted-but-present
	// file gets exactly one stderr notice so the omission is never silent.
	// ...unless `<cwd>/.pie` *is* `~/.pie` (running from `$HOME`), in which case `projectPath` and
	// `userPath` name the same file and the "project" config being gated is the user's own, already
	// loaded above. See `projectConfigDirIsUserConfigDir`.
	if (existsSync(projectPath) && !projectConfigDirIsUserConfigDir(cwd)) {
		if (isProjectTrusted(cwd)) {
			const projectConfig = await readConfig(projectPath, diagnostics, "project");
			if (projectConfig !== undefined) {
				for (const s of projectConfig.server) {
					// PORT-DIVERGENCE: B5 -- oracle replaces the user's entry silently. Trust decides
					// *whether* the project file is read; it is not a licence to hide the swap.
					if (configsByName.has(s.name)) {
						noteProjectEntryOverride("mcp.toml", "server", s.name, userPath);
					}
					configsByName.set(s.name, s);
				}
			}
		} else {
			noteUntrustedProjectConfig(projectPath, cwd);
		}
	}
	const configs = [...configsByName.values()];

	const injectSummaryServers = new Set(configs.filter((c) => c.inject_summary).map((c) => c.name));
	const injectAndRunServers = new Set(configs.filter((c) => c.inject_and_run).map((c) => c.name));

	const connected = await connectAll(configs);
	return {
		tools: connected.tools,
		diagnostics: [...diagnostics, ...connected.diagnostics],
		clientCount: connected.clientCount,
		serverNames: connected.serverNames,
		notificationHooks: connected.notificationHooks,
		injectSummaryServers,
		injectAndRunServers,
	};
}

interface ConnectAllResult {
	tools: AgentTool<any>[];
	notificationHooks: McpNotificationHook[];
	diagnostics: string[];
	clientCount: number;
	serverNames: string[];
}

/**
 * Connect to each configured server. Returns the tools collected, the `McpNotificationHook` per
 * successful connection, per-server failure diagnostics, and the number of servers that
 * actually connected.
 *
 * `clientCount` reports **successful** connections, not attempted ones -- the TUI startup
 * banner prints "connected to N server(s)" using this field (see oracle's code-review item #9,
 * 2026-05-22, cited in mcp_loader.rs:146-149).
 *
 * pie: mcp_loader.rs:150-184 (`connect_all`).
 */
export async function connectAll(configs: ServerConfig[]): Promise<ConnectAllResult> {
	const tools: AgentTool<any>[] = [];
	const notificationHooks: McpNotificationHook[] = [];
	const diagnostics: string[] = [];
	const serverNames: string[] = [];
	for (const s of configs) {
		try {
			const { tools: serverTools, hook } = await connectOne(s);
			tools.push(...serverTools);
			notificationHooks.push(hook);
			serverNames.push(s.name);
		} catch (error) {
			diagnostics.push(`mcp server '${s.name}' failed: ${errorMessage(error)}`);
		}
	}
	return { tools, notificationHooks, diagnostics, clientCount: serverNames.length, serverNames };
}

/** pie: mcp_loader.rs:186-209 (`read_config`). */
async function readConfig(path: string, diagnostics: string[], label: string): Promise<McpConfig | undefined> {
	if (!existsSync(path)) return undefined;
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch (error) {
		diagnostics.push(`mcp config (${label}, ${path}): read failed: ${errorMessage(error)}`);
		return undefined;
	}
	const result = parseMcpConfigText(text);
	if ("error" in result) {
		diagnostics.push(`mcp config (${label}, ${path}): parse failed: ${result.error}`);
		return undefined;
	}
	return result;
}

/** pie: mcp_loader.rs:211-237 (`connect_one`). */
async function connectOne(s: ServerConfig): Promise<{ tools: AgentTool<any>[]; hook: McpNotificationHook }> {
	const client = s.kind === "stdio" ? await connectStdio(s) : await connectStreamableHttp(s);
	await client.initialize("pie-coding-agent");
	// Take the server-push notification receiver before any other consumer can claim it.
	// `takeNotifications` returns non-undefined exactly once per client; the only correct
	// moment is here, immediately after `initialize` (pie: mcp_loader.rs:219-227).
	const rx = client.takeNotifications();
	if (rx === undefined) {
		throw new Error("McpClient.takeNotifications returned undefined -- receiver already consumed");
	}
	const hook = new McpNotificationHook(s.name, rx);

	const mcpTools = await client.toolsList();
	const tools: AgentTool<any>[] = mcpTools.map((tool) => new McpAgentTool(client, tool));
	return { tools, hook };
}

/**
 * pie: mcp_loader.rs:239-253 (`connect_stdio`).
 *
 * PORT-DIVERGENCE: B5 site -- `StdioTransport.spawn` below still runs as soon as a stdio server's
 * config reaches it, exactly as oracle does. What changed is *which configs reach it*: `loadAll`
 * no longer feeds it entries from an untrusted project `.pie/mcp.toml`. The gate is deliberately
 * at the config-read boundary rather than here, so an untrusted file is never parsed, never
 * merged, and never able to shadow a user entry -- not merely blocked from spawning.
 */
async function connectStdio(s: ServerConfig): Promise<McpClient> {
	if (s.endpoint !== undefined || s.auth !== undefined) {
		throw new Error(`stdio MCP server '${s.name}' must not set endpoint or auth; remove streamable_http fields`);
	}
	if (s.command === undefined) {
		throw new Error(`stdio MCP server '${s.name}' missing command`);
	}
	// pie: mcp_loader.rs:239-253 -- immediate spawn, unchanged. Reachability is gated in `loadAll`.
	const transport = await StdioTransport.spawn(s.command, s.args);
	return new McpClient(transport);
}

/** pie: mcp_loader.rs:256-312 (`connect_streamable_http`). */
async function connectStreamableHttp(s: ServerConfig): Promise<McpClient> {
	if (s.command !== undefined || s.args.length > 0) {
		throw new Error(`streamable_http MCP server '${s.name}' must set endpoint, not command/args`);
	}
	if (s.endpoint === undefined) {
		throw new Error(`streamable_http MCP server '${s.name}' missing endpoint`);
	}
	let opts: HttpMcpTransportOptions = createHttpMcpTransportOptions(s.endpoint);
	opts = { ...opts, auth: await resolveHttpAuth(s.auth) };
	if (s.request_timeout_ms !== undefined) {
		if (s.request_timeout_ms === 0) {
			throw new Error(`streamable_http MCP server '${s.name}' request_timeout_ms must be positive`);
		}
		opts = { ...opts, requestTimeoutMs: s.request_timeout_ms };
	}
	if (s.sse_idle_timeout_ms !== undefined) {
		if (s.sse_idle_timeout_ms === 0) {
			throw new Error(`streamable_http MCP server '${s.name}' sse_idle_timeout_ms must be positive`);
		}
		opts = { ...opts, sseIdleTimeoutMs: s.sse_idle_timeout_ms };
	}
	if (s.body_cap_bytes !== undefined) {
		if (s.body_cap_bytes === 0) {
			throw new Error(`streamable_http MCP server '${s.name}' body_cap_bytes must be positive`);
		}
		opts = { ...opts, bodyCapBytes: s.body_cap_bytes };
	}
	if (s.reconnect !== undefined) {
		if (s.reconnect.initial_ms === 0 || s.reconnect.max_ms === 0) {
			throw new Error(`streamable_http MCP server '${s.name}' reconnect delays must be positive`);
		}
		opts = {
			...opts,
			reconnectPolicy: {
				initialDelayMs: s.reconnect.initial_ms ?? 500,
				maxDelayMs: s.reconnect.max_ms ?? 30_000,
				maxAttempts: s.reconnect.max_attempts,
			},
		};
	}
	const transport = HttpMcpTransport.connect(opts);
	return new McpClient(transport);
}

/**
 * pie: mcp_loader.rs:314-322 (`resolve_http_auth`).
 *
 * Two ordering/error-propagation details are load-bearing here and are easy to lose in
 * translation, so they are spelled out:
 *
 * 1. The `auth === undefined` early return must happen **before** the credential store is
 *    constructed (oracle mcp_loader.rs:315-317: the `let ... else { return }` precedes
 *    `AuthStore::load()` on :319). A server with no `auth` key must not touch `~/.pie` at all.
 *    Writing this as `resolveHttpAuthFromStore(auth, AuthStorage.create())` would evaluate the
 *    argument first, and `AuthStorage.create()` is not inert -- `FileAuthStorageBackend`'s
 *    `withLock` runs `ensureParentDir()` + `ensureFileExists()`, materializing `~/.pie/` (0700)
 *    and an `auth.json` (0600) containing `{}`, plus a transient lock directory. Constructing a
 *    credential file as a side effect of reading an *unauthenticated* server's config is a
 *    strictly wider footprint than oracle's.
 * 2. A store that fails to load is an error, not an empty store (oracle mcp_loader.rs:319-320
 *    propagates via `?`). `AuthStorage.reload()` swallows the throw instead, latching it where
 *    `getLoadError()` exposes it, so we re-raise it here with oracle's wording. Without this, a
 *    corrupt `~/.pie/auth.json` degrades into an empty lookup and the user is told
 *    "configured bearer credential was not found" -- i.e. "you are not logged in" -- when the
 *    real fault is a damaged credential store, and `/login` would not fix it.
 */
async function resolveHttpAuth(auth: HttpAuthConfig | undefined): Promise<HttpMcpAuth> {
	// (1) pie: mcp_loader.rs:315-317 -- early return precedes store construction.
	if (auth === undefined) {
		return { kind: "none" };
	}
	const store = AuthStorage.create();
	// (2) pie: mcp_loader.rs:319-320 -- `AuthStore::load()` is fallible and its failure aborts this
	// server's connect. `getLoadError()` is the load-specific latch for exactly that condition: a
	// missing, empty, or whitespace-only credential file is not an error (oracle's `AuthStore` is
	// likewise happy to load an empty store), only a real read/parse failure sets it. So a defined
	// result here is precisely oracle's `Err` arm.
	const loadError = store.getLoadError();
	if (loadError !== undefined) {
		throw new Error(`failed to load local credential store: ${errorMessage(loadError)}; ${httpAuthRecovery()}`);
	}
	return resolveHttpAuthFromStore(auth, store);
}

/**
 * pie: mcp_loader.rs:324-343 (`resolve_http_auth_from_store`). Split out from `resolveHttpAuth`
 * so tests can inject `AuthStorage.inMemory(...)` instead of touching the real `~/.pie/
 * auth.json`, same split oracle's own test module uses (`resolve_http_auth_from_store` takes an
 * explicit `&AuthStore` for exactly this reason).
 *
 * Construct mapping note: oracle's `crate::auth::AuthStore` (the *simple* provider-credential
 * store, distinct from this port's richer `AuthStorage`) is the manifest's curated pi
 * counterpart for `crates/coding-agent/src/auth.rs` (this phase's `coding-agent/auth` unit,
 * `core/auth-storage.ts`) -- reused here rather than re-implementing a second parallel token
 * store, matching oracle's own reuse of the *same* `AuthStore` type for both LLM provider
 * credentials and MCP bearer `token_keychain_ref` lookups.
 */
export async function resolveHttpAuthFromStore(
	auth: HttpAuthConfig | undefined,
	store: AuthStorage,
): Promise<HttpMcpAuth> {
	if (auth === undefined) {
		return { kind: "none" };
	}
	if (auth.kind !== "bearer") {
		throw new Error("unsupported streamable_http auth kind; expected bearer");
	}
	const tokenRef = auth.token_keychain_ref;
	if (tokenRef === undefined) {
		throw new Error("bearer auth requires token_keychain_ref");
	}
	const token = await store.getApiKey(tokenRef);
	if (token === undefined) {
		throw new Error(`configured bearer credential was not found; ${httpAuthRecovery()}`);
	}
	return { kind: "bearer", token };
}

/** pie: mcp_loader.rs:345-348 (`http_auth_recovery`). Static placeholder text -- deliberately
 * does NOT echo the real `token_keychain_ref` (see mcp-loader.test.ts's leak-check test). */
function httpAuthRecovery(): string {
	return "run /login <configured-token-ref>";
}
