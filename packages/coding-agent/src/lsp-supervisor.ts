/**
 * LSP supervisor. Port of oracle `crates/coding-agent/src/lsp_supervisor.rs` (pie @0a120dfd) --
 * owns multiple `LspClient` instances keyed by language id, lazily spawns a server the first
 * time a file of that language is touched, and exposes an after-tool-call hook that attaches
 * diagnostics to write/edit tool results.
 *
 * Closes the after-edit half of c4pt0r/pie#12.
 *
 * ---
 *
 * Lazy-spawn timing (migration brief, "what matters here"): unlike `mcp-loader.ts` (which spawns every
 * configured stdio MCP server as soon as `loadAll` reads the config), `LspSupervisor.load`/
 * `fromConfig` below do NOT spawn anything. They only build the `by_ext` extension->language
 * table from `~/.pie/lsp.toml` + `<cwd>/.pie/lsp.toml`. The actual `LspClient.spawn` call happens
 * exactly once per language id, lazily, inside `clientForExt`, which is only reached via
 * `ensureOpen`, which is only reached from `attachDiagnostics` -- i.e. the FIRST time a
 * `write`/`edit` tool call touches a file whose extension matches a configured language.
 *
 * ---
 *
 * PORT-DIVERGENCE: B13 (RULEBOOK §5, oracle lsp_supervisor.rs:76-103) -- **project configs are
 * now trust-gated**.
 *
 * What oracle does: it reads project `<cwd>/.pie/lsp.toml` unconditionally, lets project entries
 * override user ones silently, and spawns the `command` it names the first time a matching
 * `write`/`edit` lands. Opening an untrusted repository and editing a file of the configured type
 * is therefore enough to run an arbitrary subprocess. Same class as B5; the only difference is
 * *when* the spawn happens (lazily, not at startup) -- deferring the spawn was never a mitigation
 * for reading the file in the first place.
 *
 * Why we now differ: phase 18 closes B5 and B13 together, because the lazy spawn makes B13 *more*
 * insidious, not less -- nothing visible happens at startup, so the user gets no moment at which
 * to notice. `<cwd>/.pie/lsp.toml` is now not read at all unless the project directory is trusted
 * (`core/project-trust.ts`: `~/.pie/trust.json`, `--trust-project`, or `PIE_TRUST_PROJECT=1`); an
 * existing-but-untrusted file is skipped with one stderr notice; and a trusted project entry that
 * shadows a same-named user entry still wins, but is announced instead of silent. The user-scope
 * `~/.pie/lsp.toml` is untouched by the gate.
 *
 * Ledger history: an earlier revision of this comment declined to open a ledger entry on the
 * grounds that it "isn't in the RULEBOOK §5 table". That reasoning was circular -- §5 is
 * maintained by the orchestrator, and an implementer's job is to propose an entry, not to veto
 * one. Entry added 2026-08-05 (phase 12 reviewer C); see RULEBOOK §6 Deviation log.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { AfterToolCallContext, AfterToolCallResult } from "@pie/agent-core";
import type { ImageContent, TextContent } from "@pie/ai";
import { parse as parseToml } from "smol-toml";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
import {
	isProjectTrusted,
	noteProjectEntryOverride,
	noteUntrustedProjectConfig,
	projectConfigDirIsUserConfigDir,
} from "./core/project-trust.ts";
import type { Diagnostic } from "./lsp.ts";
import { LspClient } from "./lsp.ts";

const DIAG_WAIT_MS = 800;

// ─────────────────────────────────────────────────────────────────────────────────────────
// lsp.toml schema (RULEBOOK §1: smol-toml + typebox). Field names are wire names -- snake_case,
// matching oracle's serde struct verbatim. pie: lsp_supervisor.rs:26-42.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** pie: lsp_supervisor.rs:32-42 (`LanguageConfig`). */
const LanguageConfigFileSchema = Type.Object({
	id: Type.String(),
	extensions: Type.Array(Type.String()),
	command: Type.String(),
	args: Type.Optional(Type.Array(Type.String())),
});

/** pie: lsp_supervisor.rs:26-30 (`LspConfig`). */
const LspConfigFileSchema = Type.Object({
	language: Type.Optional(Type.Array(LanguageConfigFileSchema)),
});

const validateLspConfigFile = Compile(LspConfigFileSchema);

type LanguageConfigFile = Static<typeof LanguageConfigFileSchema>;

/** pie: lsp_supervisor.rs:32-42 (`LanguageConfig`), `args` defaulted to `[]`. */
export interface LanguageConfig {
	/** Language id (matches LSP "languageId", e.g. "rust", "typescript"). */
	id: string;
	/** File extensions this server handles (without the leading dot). */
	extensions: string[];
	/** Command to spawn (e.g. "rust-analyzer"). */
	command: string;
	args: string[];
}

/** pie: lsp_supervisor.rs:26-30 (`LspConfig`), `language` defaulted to `[]`. */
export interface LspConfig {
	language: LanguageConfig[];
}

function normalizeLanguageConfig(raw: LanguageConfigFile): LanguageConfig {
	return { id: raw.id, extensions: raw.extensions, command: raw.command, args: raw.args ?? [] };
}

/** Parse lsp.toml text into a normalized `LspConfig`, or `undefined` on any parse/shape error
 * -- mirrors oracle's `load()` loop, which silently `continue`s past a bad file rather than
 * surfacing a diagnostic (lsp_supervisor.rs:87-94: `Err(_) => continue` for both the read and
 * the TOML parse step). */
export function parseLspConfigText(text: string): LspConfig | undefined {
	let parsed: unknown;
	try {
		parsed = parseToml(text);
	} catch {
		return undefined;
	}
	if (!validateLspConfigFile.Check(parsed)) return undefined;
	const file = parsed as Static<typeof LspConfigFileSchema>;
	return { language: (file.language ?? []).map(normalizeLanguageConfig) };
}

/**
 * Read + parse one lsp.toml, or `undefined` when it is absent/unreadable/unparseable -- mirrors
 * oracle's `load()` loop, which silently `continue`s past a bad file rather than surfacing a
 * diagnostic (lsp_supervisor.rs:87-94: `Err(_) => continue` for both the read and the TOML parse
 * step). Extracted from that loop so the user and project halves can be gated separately.
 */
async function readLspConfigFile(path: string): Promise<LspConfig | undefined> {
	if (!existsSync(path)) return undefined;
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch {
		return undefined;
	}
	return parseLspConfigText(text);
}

/** pie: lsp_supervisor.rs:44-49 (`struct LspSupervisor`). */
export class LspSupervisor {
	private readonly cwdUri: string;
	private readonly byExt: Map<string, LanguageConfig>;
	/** Keyed by language id. A rejected pending promise is deleted so the next call retries
	 * from scratch -- mirrors `tokio::sync::OnceCell::get_or_try_init`'s "failed init does not
	 * poison the cell" semantics (lsp_supervisor.rs:132-141). */
	private readonly clients = new Map<string, Promise<LspClient>>();
	private readonly openFiles = new Set<string>();

	private constructor(cwdUri: string, byExt: Map<string, LanguageConfig>) {
		this.cwdUri = cwdUri;
		this.byExt = byExt;
	}

	/** pie: lsp_supervisor.rs:51-74 (`from_config`). Building the extension table does NOT
	 * spawn anything -- see module doc "Lazy-spawn timing". */
	static fromConfig(cwd: string, cfg: LspConfig): LspSupervisor {
		const cwdUri = `file://${cwd}`;
		const byExt = new Map<string, LanguageConfig>();
		for (const lang of cfg.language) {
			for (const ext of lang.extensions) {
				byExt.set(ext, lang);
			}
		}
		return new LspSupervisor(cwdUri, byExt);
	}

	/**
	 * pie: lsp_supervisor.rs:76-104 (`load`). Load `~/.pie/lsp.toml` always, and -- when the
	 * project directory is trusted -- `<cwd>/.pie/lsp.toml` on top of it; project entries overlay
	 * user entries by language id.
	 *
	 * PORT-DIVERGENCE: B13 -- oracle reads both paths with no allow-flag, env gate, or trust
	 * prompt of any kind (lsp_supervisor.rs:81-82 is just `[user_path, project_path]`). The
	 * project half is now gated; see this file's module doc.
	 */
	static async load(cwd: string): Promise<LspSupervisor> {
		const byId = new Map<string, LanguageConfig>();
		const userPath = join(getAgentDir(), "lsp.toml");
		const projectPath = join(cwd, CONFIG_DIR_NAME, "lsp.toml");

		const userConfig = await readLspConfigFile(userPath);
		if (userConfig !== undefined) {
			for (const lang of userConfig.language) {
				byId.set(lang.id, lang);
			}
		}

		// ...unless `<cwd>/.pie` *is* `~/.pie` (running from `$HOME`), in which case `projectPath`
		// and `userPath` name the same file and the "project" config being gated is the user's own,
		// already loaded above. See `projectConfigDirIsUserConfigDir`.
		if (existsSync(projectPath) && !projectConfigDirIsUserConfigDir(cwd)) {
			if (isProjectTrusted(cwd)) {
				const projectConfig = await readLspConfigFile(projectPath);
				if (projectConfig !== undefined) {
					for (const lang of projectConfig.language) {
						// PORT-DIVERGENCE: B13 -- oracle swaps the user's server for the project's
						// with nothing surfaced. The project entry still wins (that is what a
						// project override is for) but the substitution is announced.
						if (byId.has(lang.id)) {
							noteProjectEntryOverride("lsp.toml", "language", lang.id, userPath);
						}
						// `Map.set` on an existing key preserves the key's original iteration
						// position -- same "override in place, new entries append in encounter
						// order" semantics as oracle's `Vec::position()` + in-place replace.
						byId.set(lang.id, lang);
					}
				}
			} else {
				noteUntrustedProjectConfig(projectPath, cwd);
			}
		}
		return LspSupervisor.fromConfig(cwd, { language: [...byId.values()] });
	}

	/** pie: lsp_supervisor.rs:106-108 (`is_empty`). */
	isEmpty(): boolean {
		return this.byExt.size === 0;
	}

	/** pie: lsp_supervisor.rs:110-114 (`language_count`). */
	languageCount(): number {
		const unique = new Set<string>();
		for (const lang of this.byExt.values()) unique.add(lang.id);
		return unique.size;
	}

	/**
	 * pie: lsp_supervisor.rs:116-142 (`client_for_ext`). Lazily get or spawn the LSP client for
	 * `ext`. Caches per language id. THIS is the one and only spawn site -- reached only via
	 * {@link ensureOpen}.
	 */
	private async clientForExt(ext: string): Promise<LspClient | undefined> {
		const lang = this.byExt.get(ext);
		if (lang === undefined) return undefined;
		let pending = this.clients.get(lang.id);
		if (pending === undefined) {
			pending = this.spawnAndInitialize(lang);
			this.clients.set(lang.id, pending);
		}
		try {
			return await pending;
		} catch {
			this.clients.delete(lang.id);
			return undefined;
		}
	}

	private async spawnAndInitialize(lang: LanguageConfig): Promise<LspClient> {
		const client = await LspClient.spawn(lang.command, lang.args);
		await client.initialize(this.cwdUri);
		return client;
	}

	/**
	 * pie: lsp_supervisor.rs:144-158 (`ensure_open`). Open the file in the relevant LSP if not
	 * already open. Returns the matching language id (for `did_open`'s required `languageId`).
	 */
	async ensureOpen(path: string): Promise<{ client: LspClient; langId: string } | undefined> {
		const ext = extname(path).replace(/^\./, "");
		if (ext === "") return undefined;
		const lang = this.byExt.get(ext);
		if (lang === undefined) return undefined;
		const client = await this.clientForExt(ext);
		if (client === undefined) return undefined;
		const uri = `file://${path}`;
		if (!this.openFiles.has(uri)) {
			let text: string;
			try {
				text = await readFile(path, "utf-8");
			} catch {
				return undefined;
			}
			try {
				await client.didOpen(uri, lang.id, text);
			} catch {
				return undefined;
			}
			this.openFiles.add(uri);
		}
		return { client, langId: lang.id };
	}
}

/** pie: lsp_supervisor.rs equivalent of `pie_agent_core::AfterToolCallHook` -- there is no
 * standalone named type for this shape in `@pie/agent-core` (it appears inline as
 * `AgentLoopConfig.afterToolCall`'s type); named here so `asAfterToolCallHook`'s return type is
 * self-documenting and directly assignable at any future wiring site. */
export type AfterToolCallHook = (
	context: AfterToolCallContext,
	signal?: AbortSignal,
) => Promise<AfterToolCallResult | undefined>;

/**
 * pie: lsp_supervisor.rs:161-170 (`as_after_tool_call`). Build an after-tool-call hook that
 * attaches LSP diagnostics to write/edit tool results. On non-edit tools, or when the
 * supervisor has no configured languages, resolves `undefined` (no override) -- the TS analog
 * of oracle's `AfterToolCallResult::default()`.
 *
 * NOT wired into `core/session-manager.ts`/`core/agent-session.ts` (both out of this unit's
 * scope) -- a future unit composes this with the harness's `AgentLoopConfig.afterToolCall`.
 */
export function asAfterToolCallHook(supervisor: LspSupervisor): AfterToolCallHook {
	return (ctx) => attachDiagnostics(supervisor, ctx);
}

/** pie: lsp_supervisor.rs:172-212 (`attach_diagnostics`). Exported so tests can drive it
 * directly off a supervisor + fixture context, same posture as `hooks.ts`'s exported `pushRules`. */
export async function attachDiagnostics(
	supervisor: LspSupervisor,
	ctx: AfterToolCallContext,
): Promise<AfterToolCallResult | undefined> {
	if (supervisor.isEmpty()) return undefined;
	const toolName = ctx.toolCall.name;
	if (toolName !== "write" && toolName !== "edit") return undefined;
	const args = ctx.args as Record<string, unknown> | undefined;
	const path = typeof args?.path === "string" ? args.path : undefined;
	if (path === undefined) return undefined;
	const opened = await supervisor.ensureOpen(path);
	if (opened === undefined) return undefined;
	// Wait briefly for diagnostics to arrive after the edit. If the LSP doesn't push within the
	// timeout, fall back to whatever cached diagnostics it already has for the URI.
	const uri = `file://${path}`;
	await opened.client.awaitDiagnostics(DIAG_WAIT_MS);
	const diags = opened.client.diagnosticsFor(uri);
	if (diags.length === 0) return undefined;
	const summary = renderDiagnostics(path, diags);
	const textBlock: TextContent = { type: "text", text: summary };
	const content: (TextContent | ImageContent)[] = [...ctx.result.content, textBlock];
	return { content };
}

/** pie: lsp_supervisor.rs:214-235 (`render_diagnostics`). */
function renderDiagnostics(path: string, diags: Diagnostic[]): string {
	let out = `\n\nLSP diagnostics for ${path}:\n`;
	for (const d of diags.slice(0, 20)) {
		const sev = severityLabel(d.severity);
		out += `  [${sev}] ${d.range.start.line + 1}:${d.range.start.character + 1}: ${d.message}\n`;
	}
	if (diags.length > 20) {
		out += `  (${diags.length - 20} more)\n`;
	}
	return out;
}

function severityLabel(severity: number | undefined): string {
	switch (severity) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "info";
		case 4:
			return "hint";
		default:
			return "diag";
	}
}
