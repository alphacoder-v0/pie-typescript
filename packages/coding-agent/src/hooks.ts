/**
 * User-configured CLI hooks.
 *
 * Port of oracle `crates/coding-agent/src/hooks.rs` (pie @0a120dfd). Hooks observe agent/harness
 * events and run best-effort side effects (shell commands and/or HTTP webhooks). They never
 * mutate agent state and failures are surfaced as diagnostics only, never as prompt failures.
 *
 * **Opt-in gate (oracle: hooks.rs:152-215, `load()`)**: `~/.pie/hooks.toml` (user-scope) is
 * always read when present. `<cwd>/.pie/hooks.toml` (project-scope) is loaded ONLY when
 * explicitly allowed, via either:
 *   - `PIE_ALLOW_PROJECT_HOOKS=1` (or case-insensitive `true`) in the environment, or
 *   - `allow_project_hooks = true` in the USER's `~/.pie/hooks.toml`.
 * A project `hooks.toml` that exists but isn't allowed produces a diagnostic and contributes NO
 * rules -- this is the contrast the migration brief calls out against `mcp_loader.ts`'s B5 defect
 * (project MCP servers spawn unconditionally at startup with no trust gate at all).
 *
 * Channel mapping note: oracle registers two listeners against `AgentHarness` --
 * `listener()` (async, awaited inline, for the per-turn `AgentEvent` stream) and
 * `harness_listener()` (sync, internally `tokio::spawn`s, for the separate `HarnessEvent` stream
 * whose only variant this file cares about is `Compaction`). This port's `HarnessEvent`
 * (`packages/agent/src/harness/agent-harness.ts`) deliberately excludes a `Compaction` variant --
 * that concern already lives on `AgentHarnessOwnEvent`'s `session_compact` event (agent-harness.ts
 * header comment, agent_harness.rs:59-68 mapping). `harnessListener()` below is therefore typed
 * against `SessionCompactEvent`, the real TS-side analog, rather than the (compaction-less) TS
 * `HarnessEvent`. It still detaches via the canonical `detach()` helper (RULEBOOK §2.2), mirroring
 * oracle's `tokio::spawn` -- the harness must not block waiting for a hook command/webhook to run
 * before compaction bookkeeping continues.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentListener, AgentMessage, SessionCompactEvent, ThinkingLevel } from "@pie/agent-core";
import { detach } from "@pie/agent-core";
import type { AssistantMessageEvent, Model } from "@pie/ai";
import { parse as parseToml } from "smol-toml";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { CONFIG_DIR_NAME, getAgentDir, VERSION } from "./config.ts";
import { spawnProcess } from "./utils/child-process.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "./utils/shell.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_SUMMARY_CHARS = 2_000;

/** pie: hooks.rs:172 -- literal env var name, NOT derived from `APP_NAME` (same posture as
 * `config.ts`'s `ENV_BASE_DIR = "PIE_DIR"`). */
const ENV_ALLOW_PROJECT_HOOKS = "PIE_ALLOW_PROJECT_HOOKS";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// hooks.toml schema (RULEBOOK §1: smol-toml + typebox). Field names are wire names (the literal
// TOML keys users author) -- snake_case, matching oracle's serde struct verbatim.
// ─────────────────────────────────────────────────────────────────────────────────────────

const HookCwdSchema = Type.Union([Type.Literal("project"), Type.Literal("pie"), Type.Literal("home")]);
const OnFailureSchema = Type.Union([Type.Literal("warn"), Type.Literal("ignore")]);

/** pie: hooks.rs:94-113 (`HookRuleConfig`). Deliberately permissive of extra/unknown TOML keys
 * (no `additionalProperties: false`), matching serde's default (non-`deny_unknown_fields`)
 * struct deserialization. */
const HookRuleConfigSchema = Type.Object({
	event: Type.String(),
	command: Type.Optional(Type.String()),
	webhook: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	timeout_ms: Type.Optional(Type.Number()),
	enabled: Type.Optional(Type.Boolean()),
	cwd: Type.Optional(HookCwdSchema),
	on_failure: Type.Optional(OnFailureSchema),
	tool: Type.Optional(Type.String()),
});

/** pie: hooks.rs:86-92 (`HooksFile`). */
const HooksFileSchema = Type.Object({
	allow_project_hooks: Type.Optional(Type.Boolean()),
	hook: Type.Optional(Type.Array(HookRuleConfigSchema)),
});

type HookRuleConfig = Static<typeof HookRuleConfigSchema>;
type HooksFile = Static<typeof HooksFileSchema>;

const validateHooksFile = Compile(HooksFileSchema);

// ─────────────────────────────────────────────────────────────────────────────────────────
// Hook event vocabulary. Unit-only enum -> string literal union (RULEBOOK §2.1). Distinct from
// (shorter than) the underlying `AgentEvent.type` tag vocabulary -- e.g. hook event "tool_end"
// vs. `AgentEvent.type === "tool_execution_end"`.
// ─────────────────────────────────────────────────────────────────────────────────────────

const HOOK_EVENTS = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_start",
	"tool_update",
	"tool_end",
	"compaction",
] as const;

/** pie: hooks.rs:56-69 (`HookEvent`). */
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** pie: hooks.rs:582-598 (`HookEvent::parse`). */
export function parseHookEvent(s: string): HookEvent | undefined {
	return (HOOK_EVENTS as readonly string[]).includes(s) ? (s as HookEvent) : undefined;
}

/** pie: hooks.rs:71-77 (`HookCwd`). */
export type HookCwd = Static<typeof HookCwdSchema>;

/** pie: hooks.rs:79-84 (`OnFailure`). */
export type OnFailure = Static<typeof OnFailureSchema>;

/** pie: hooks.rs:43-54 (`HookRule`), camelCase internal shape (not wire-serialized). */
export interface HookRule {
	event: HookEvent;
	command?: string;
	webhook?: string;
	headers: Record<string, string>;
	timeoutMs: number;
	cwd: HookCwd;
	onFailure: OnFailure;
	tool?: string;
	source: string;
}

/**
 * Wire payload written to the hook's temp JSON file and posted as the webhook body.
 * pie: hooks.rs:115-135 (`HookPayload`). Field names/order are the literal serde field names
 * (`HookPayload` has NO `skip_serializing_if` -- every optional field is serialized with an
 * explicit JSON `null` rather than omitted, so these are typed `T | null`, NOT `T | undefined`
 * -- `undefined` would make `JSON.stringify` drop the key, diverging from oracle's wire shape).
 */
export interface HookPayload {
	event: string;
	session_id: string;
	cwd: string;
	model_provider: string;
	model_id: string;
	thinking_level: string;
	source: string;
	message_kind: string | null;
	message_summary: string | null;
	assistant_event: string | null;
	tool_call_id: string | null;
	tool_name: string | null;
	tool_is_error: boolean | null;
	tool_args: unknown | null;
	tool_result_summary: string | null;
	compaction_trigger: string | null;
	compaction_tokens_before: number | null;
	compaction_summary: string | null;
}

/** pie: hooks.rs:137-150 (`EventData`), internal-only (never serialized). */
interface EventData {
	event: HookEvent;
	messageKind?: string;
	messageSummary?: string;
	assistantEvent?: string;
	toolCallId?: string;
	toolName?: string;
	toolIsError?: boolean;
	toolArgs?: unknown;
	toolResultSummary?: string;
	compactionTrigger?: string;
	compactionTokensBefore?: number;
	compactionSummary?: string;
}

function basicEventData(event: HookEvent): EventData {
	return { event };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Loading: hooks.toml discovery + the opt-in gate.
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface LoadedHooks {
	runner: HookRunner;
	diagnostics: string[];
}

/**
 * Parse+validate raw hooks.toml text into a `HooksFile`. Pure/synchronous (no filesystem access)
 * so it can be exercised directly by tests, mirroring oracle's own test module calling
 * `toml::from_str::<HooksFile>(text).unwrap()` without touching disk.
 * pie: hooks.rs:231-241 (the `toml::from_str` half of `read_file`).
 */
export function parseHooksFileText(text: string): HooksFile | { error: string } {
	let parsed: unknown;
	try {
		parsed = parseToml(text);
	} catch (error) {
		return { error: errorMessage(error) };
	}
	if (!validateHooksFile.Check(parsed)) {
		return { error: "invalid hooks.toml shape" };
	}
	return parsed as HooksFile;
}

/** pie: hooks.rs:217-241 (`read_file`). */
async function readHooksFile(path: string, label: string, diagnostics: string[]): Promise<HooksFile | undefined> {
	if (!existsSync(path)) return undefined;
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch (error) {
		diagnostics.push(`hooks ${label}: read ${path} failed: ${errorMessage(error)}`);
		return undefined;
	}
	const result = parseHooksFileText(text);
	if ("error" in result) {
		diagnostics.push(`hooks ${label}: parse ${path} failed: ${result.error}`);
		return undefined;
	}
	return result;
}

/**
 * Validate + normalize each `[[hook]]` entry, skipping (with a diagnostic) entries that are
 * disabled, reference an unrecognized event name, or specify neither `command` nor `webhook`.
 * Mutates `rules`/`diagnostics` in place (matches oracle's `&mut Vec` out-params) -- exported so
 * tests can drive it directly off a parsed `HooksFile`, same as oracle's own test module.
 * pie: hooks.rs:243-283 (`push_rules`).
 */
export function pushRules(file: HooksFile, source: string, rules: HookRule[], diagnostics: string[]): void {
	const hooks = file.hook ?? [];
	hooks.forEach((cfg: HookRuleConfig, idx: number) => {
		if (cfg.enabled === false) return;

		const event = parseHookEvent(cfg.event);
		if (event === undefined) {
			diagnostics.push(`hooks ${source}: hook #${idx + 1} has unknown event "${cfg.event}"`);
			return;
		}

		const commandIsBlank = cfg.command === undefined || cfg.command.trim() === "";
		if (commandIsBlank && cfg.webhook === undefined) {
			diagnostics.push(`hooks ${source}: hook #${idx + 1} has neither command nor webhook`);
			return;
		}

		rules.push({
			event,
			command: commandIsBlank ? undefined : cfg.command,
			webhook: cfg.webhook,
			headers: cfg.headers ?? {},
			timeoutMs: cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS,
			cwd: cfg.cwd ?? "project",
			onFailure: cfg.on_failure ?? "warn",
			tool: cfg.tool,
			source,
		});
	});
}

function envAllowsProjectHooks(): boolean {
	const raw = process.env[ENV_ALLOW_PROJECT_HOOKS];
	if (raw === undefined) return false;
	return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Load hooks from `~/.pie/hooks.toml` (user, always read) and `<cwd>/.pie/hooks.toml` (project,
 * gated -- see this file's module doc). pie: hooks.rs:152-215 (`load`).
 */
export async function load(
	cwd: string,
	sessionId: string,
	model: Model<any> | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): Promise<LoadedHooks> {
	const modelProvider = model?.provider ?? "";
	const modelId = model?.id ?? "";
	const resolvedThinkingLevel = thinkingLevel ?? "off";

	const userPath = join(getAgentDir(), "hooks.toml");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "hooks.toml");
	const diagnostics: string[] = [];
	const rules: HookRule[] = [];

	const userFile = await readHooksFile(userPath, "user", diagnostics);

	// pie: hooks.rs:172-178 -- env var OR the user file's own `allow_project_hooks = true`.
	const allowProject = envAllowsProjectHooks() || (userFile?.allow_project_hooks ?? false);

	if (userFile) {
		pushRules(userFile, "user", rules, diagnostics);
	}

	if (existsSync(projectPath)) {
		if (allowProject) {
			const projectFile = await readHooksFile(projectPath, "project", diagnostics);
			if (projectFile) {
				pushRules(projectFile, "project", rules, diagnostics);
			}
		} else {
			// pie: hooks.rs:190-195 -- the opt-in gate: an existing-but-not-allowed project
			// hooks.toml contributes NO rules, only this diagnostic.
			diagnostics.push(
				`project hooks ignored at ${projectPath}; set allow_project_hooks = true in ${userPath} or ${ENV_ALLOW_PROJECT_HOOKS}=1`,
			);
		}
	}

	return {
		runner: new HookRunner({
			rules,
			sessionId,
			cwd,
			modelProvider,
			modelId,
			thinkingLevel: resolvedThinkingLevel,
		}),
		diagnostics,
	};
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// HookRunner -- event dispatch + hook execution.
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface HookRunnerOptions {
	rules: HookRule[];
	sessionId: string;
	cwd: string;
	modelProvider: string;
	modelId: string;
	thinkingLevel: string;
}

/** pie: hooks.rs:32-41 (`HookRunner`). No `client` field -- uses the global `fetch` (RULEBOOK §1)
 * rather than a persistent HTTP client instance. */
export class HookRunner {
	private readonly rules: readonly HookRule[];
	private readonly sessionId: string;
	private readonly cwd: string;
	private readonly modelProvider: string;
	private readonly modelId: string;
	private readonly thinkingLevel: string;

	constructor(options: HookRunnerOptions) {
		this.rules = options.rules;
		this.sessionId = options.sessionId;
		this.cwd = options.cwd;
		this.modelProvider = options.modelProvider;
		this.modelId = options.modelId;
		this.thinkingLevel = options.thinkingLevel;
	}

	/**
	 * How many rules were loaded.
	 *
	 * pie: `hooks.rs`'s `HookRunner::len()`. Startup (`main.rs:1015`) uses it to decide whether to
	 * print `hooks: loaded N hook(s)`, and `:1039` uses the emptiness
	 * check to decide whether to subscribe at all.
	 */
	get length(): number {
		return this.rules.length;
	}

	/** pie: hooks.rs:286-288 (`is_empty`). */
	isEmpty(): boolean {
		return this.rules.length === 0;
	}

	/** pie: hooks.rs:290-292 (`len`). */
	size(): number {
		return this.rules.length;
	}

	/** pie: hooks.rs:294-302 (`listener`) -- registered against the per-turn `AgentEvent` stream
	 * (e.g. `AgentHarness.subscribe()`); awaited inline by the caller. */
	listener(): AgentListener {
		return (event, signal) => this.handleEvent(event, signal);
	}

	/** pie: hooks.rs:304-313 (`harness_listener`) -- see this file's module doc for the channel
	 * remapping. Synchronous wrapper: detaches so a compaction hook never blocks the harness's own
	 * compaction bookkeeping (mirrors oracle's `tokio::spawn`). */
	harnessListener(): (event: SessionCompactEvent) => void {
		return (event: SessionCompactEvent) => {
			detach(
				() => this.handleCompactionEvent(event, new AbortController().signal),
				() => {
					// pie: hooks.rs:308-311 -- oracle's detached `tokio::spawn` has no error sink
					// either (a panic inside the spawned task is simply lost); `handleData` already
					// catches/drops every hook failure internally, so this is an unreached backstop.
				},
			);
		};
	}

	/** pie: hooks.rs:315-320 (`handle_event`). */
	async handleEvent(event: AgentEvent, signal: AbortSignal): Promise<void> {
		const data = eventDataFromAgentEvent(event);
		if (!data) return;
		await this.handleData(data, signal);
	}

	/** pie: hooks.rs:322-327 (`handle_harness_event`), narrowed to the one event this port can
	 * still receive on a harness-adjacent channel -- see this file's module doc. */
	async handleCompactionEvent(event: SessionCompactEvent, signal: AbortSignal): Promise<void> {
		await this.handleData(eventDataFromCompactionEvent(event), signal);
	}

	/** pie: hooks.rs:329-350 (`handle_data`). */
	private async handleData(data: EventData, signal: AbortSignal): Promise<void> {
		const matching = this.rules.filter((rule) => ruleMatches(rule, data));
		if (matching.length === 0) return;

		for (const rule of matching) {
			// pie: hooks.rs:340-342 -- checked before EVERY rule, not just once; a cancel that
			// fires mid-loop drops all remaining not-yet-started rules too.
			if (signal.aborted) return;
			const payload = this.payloadFor(rule, data);
			try {
				await this.runRule(rule, payload, signal);
			} catch {
				// pie: hooks.rs:344-348 -- oracle routes a `Warn`-mode failure through
				// `tracing::warn!`; this port has no logger reachable here (same posture as
				// `skills-state.ts`'s `loadSkillsState` doc comment -- RULEBOOK §1 forbids new
				// `console.*` in product paths), so the warning is dropped. An `Ignore`-mode
				// failure is dropped identically in both oracle and this port -- the `onFailure`
				// field is kept (not collapsed away) for 1:1 shape parity and forward
				// compatibility once a logger sink exists (see `rule.onFailure` below).
				void rule.onFailure;
			}
		}
	}

	/** pie: hooks.rs:352-373 (`payload_for`). Field order matches oracle's struct declaration
	 * order (serde default = declaration order, not sorted). */
	private payloadFor(rule: HookRule, data: EventData): HookPayload {
		return {
			event: data.event,
			session_id: this.sessionId,
			cwd: this.cwd,
			model_provider: this.modelProvider,
			model_id: this.modelId,
			thinking_level: this.thinkingLevel,
			source: rule.source,
			message_kind: data.messageKind ?? null,
			message_summary: data.messageSummary ?? null,
			assistant_event: data.assistantEvent ?? null,
			tool_call_id: data.toolCallId ?? null,
			tool_name: data.toolName ?? null,
			tool_is_error: data.toolIsError ?? null,
			tool_args: data.toolArgs ?? null,
			tool_result_summary: data.toolResultSummary ?? null,
			compaction_trigger: data.compactionTrigger ?? null,
			compaction_tokens_before: data.compactionTokensBefore ?? null,
			compaction_summary: data.compactionSummary ?? null,
		};
	}

	/** pie: hooks.rs:375-399 (`run_rule`). Command runs before webhook; a command failure
	 * short-circuits (the webhook does NOT run), matching oracle's `?`-propagating async block.
	 * The payload temp file is always removed afterward regardless of outcome. */
	private async runRule(rule: HookRule, payload: HookPayload, signal: AbortSignal): Promise<void> {
		const payloadJson = JSON.stringify(payload);
		const payloadPath = await writePayloadFile(payloadJson);
		try {
			if (rule.command !== undefined) {
				await this.runCommand(rule, rule.command, payload, payloadPath, signal);
			}
			if (rule.webhook !== undefined) {
				await this.runWebhook(rule, rule.webhook, payloadJson, signal);
			}
		} finally {
			await unlink(payloadPath).catch(() => {});
		}
	}

	/**
	 * pie: hooks.rs:401-495 (`run_command`). Spawns the hook command detached (its own process
	 * group on Unix) so a timeout/cancel can kill the whole descendant tree via the same
	 * `killProcessTree` helper `tools/bash.ts`'s bash tool already uses for the identical
	 * problem (oracle's own comment cites the same PR #41/#40 precedent this port reuses).
	 * stdout is discarded (oracle only ever routes it to `tracing::debug!`, which this port has
	 * no reachable sink for -- see `handleData`'s doc comment); stderr is captured for the
	 * failure message.
	 */
	private runCommand(
		rule: HookRule,
		command: string,
		payload: HookPayload,
		payloadPath: string,
		signal: AbortSignal,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeoutMs = rule.timeoutMs;
			const child = spawnProcess(shellProgram(), [shellArg(), command], {
				cwd: this.cwdFor(rule),
				detached: process.platform !== "win32",
				env: { ...process.env, ...envFor(payload, payloadPath) },
				stdio: ["ignore", "ignore", "pipe"],
				windowsHide: true,
			});

			if (child.pid) trackDetachedChildPid(child.pid);

			let stderrText = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrText += chunk.toString("utf-8");
			});

			let timedOut = false;
			let cancelled = false;
			let settled = false;

			const timeoutHandle = setTimeout(() => {
				timedOut = true;
				if (child.pid) killProcessTree(child.pid);
			}, timeoutMs);

			const onAbort = () => {
				cancelled = true;
				if (child.pid) killProcessTree(child.pid);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });

			const cleanup = () => {
				clearTimeout(timeoutHandle);
				signal.removeEventListener("abort", onAbort);
				if (child.pid) untrackDetachedChildPid(child.pid);
			};

			child.on("error", (err) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error(`spawn: ${errorMessage(err)}`));
			});

			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				cleanup();
				// pie: hooks.rs:447-460 -- cancel checked first (`biased`), so a cancel racing a
				// same-tick natural exit or timeout still reports as cancelled.
				if (cancelled) {
					reject(new Error("cancelled"));
					return;
				}
				if (timedOut) {
					reject(new Error(`timed out after ${timeoutMs}ms`));
					return;
				}
				if (code !== 0) {
					reject(new Error(`command exited ${code ?? -1}: ${stderrText.trim()}`));
					return;
				}
				resolve();
			});
		});
	}

	/** pie: hooks.rs:524-555 (`run_webhook`). */
	private async runWebhook(rule: HookRule, url: string, payloadJson: string, signal: AbortSignal): Promise<void> {
		const headers = new Headers();
		headers.set("Content-Type", "application/json");
		// pie: hooks.rs:198-201 -- literal "pie/" prefix (not derived from `APP_NAME`), matching
		// the crate's own hardcoded `format!("pie/{}", env!("CARGO_PKG_VERSION"))`.
		headers.set("User-Agent", `pie/${VERSION}`);
		for (const [key, value] of Object.entries(rule.headers)) {
			headers.set(key, value);
		}

		const timeoutSignal = AbortSignal.timeout(rule.timeoutMs);
		const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

		let response: Response;
		try {
			response = await fetch(url, { method: "POST", headers, body: payloadJson, signal: combinedSignal });
		} catch (error) {
			if (signal.aborted) throw new Error("cancelled");
			throw error;
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			const truncated = Array.from(text).slice(0, 500).join("");
			throw new Error(`webhook status ${response.status}: ${truncated}`);
		}
	}

	/** pie: hooks.rs:557-565 (`cwd_for`). */
	private cwdFor(rule: HookRule): string {
		switch (rule.cwd) {
			case "project":
				return this.cwd;
			case "pie":
				return getAgentDir();
			case "home":
				return homedir() || this.cwd;
		}
	}
}

/** pie: hooks.rs:568-580 (`HookRule::matches`). */
function ruleMatches(rule: HookRule, data: EventData): boolean {
	if (rule.event !== data.event) return false;
	if (rule.tool !== undefined && data.toolName !== rule.tool) return false;
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// AgentEvent / compaction -> EventData projection.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** pie: hooks.rs:617-693 (`EventData::from_agent_event`). */
function eventDataFromAgentEvent(event: AgentEvent): EventData | undefined {
	switch (event.type) {
		case "agent_start":
			return basicEventData("agent_start");
		case "agent_end":
			return basicEventData("agent_end");
		case "turn_start":
			return basicEventData("turn_start");
		case "turn_end":
			return {
				...basicEventData("turn_end"),
				messageKind: messageKind(event.message),
				messageSummary: messageSummary(event.message),
			};
		case "message_start":
			return {
				...basicEventData("message_start"),
				messageKind: messageKind(event.message),
				messageSummary: messageSummary(event.message),
			};
		case "message_update":
			return {
				...basicEventData("message_update"),
				messageKind: messageKind(event.message),
				messageSummary: messageSummary(event.message),
				assistantEvent: assistantEventName(event.assistantMessageEvent),
			};
		case "message_end":
			return {
				...basicEventData("message_end"),
				messageKind: messageKind(event.message),
				messageSummary: messageSummary(event.message),
			};
		case "tool_execution_start":
			return {
				...basicEventData("tool_start"),
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				toolArgs: event.args,
			};
		case "tool_execution_update":
			return {
				...basicEventData("tool_update"),
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				toolArgs: event.args,
				toolResultSummary: resultSummary(event.partialResult),
			};
		case "tool_execution_end":
			return {
				...basicEventData("tool_end"),
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				toolIsError: event.isError,
				toolResultSummary: resultSummary(event.result),
			};
		case "control_plane_prompt_resolved":
			// pie: hooks.rs:688-691 -- deferred; the embedder-side hook bridge doesn't currently
			// surface this event.
			return undefined;
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

/** pie: hooks.rs:712-724,743-747 (`EventData::from_harness_event` + `compaction_trigger`),
 * narrowed to the one reachable event -- see this file's module doc. */
function eventDataFromCompactionEvent(event: SessionCompactEvent): EventData {
	return {
		event: "compaction",
		compactionTrigger: event.fromHook ? "manual" : "auto",
		compactionTokensBefore: event.compactionEntry.tokensBefore,
		compactionSummary: truncate(event.compactionEntry.summary),
	};
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Text formatting helpers.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** pie: hooks.rs:793-800 (`message_kind`). `AgentMessage::Custom(c) => c.role` had no closed set
 * of roles in oracle; this port's pi-only custom message kinds (bashExecution/custom/
 * branchSummary/compactionSummary/...) have no oracle counterpart at all, so their TS `role` is
 * passed through as the closest analog. */
function messageKind(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return "user";
		case "assistant":
			return "assistant";
		case "toolResult":
			return "tool_result";
		default:
			return message.role;
	}
}

/** pie: hooks.rs:802-838 (`message_summary`). */
function messageSummary(message: AgentMessage): string {
	let text: string;
	switch (message.role) {
		case "user":
			text =
				typeof message.content === "string"
					? message.content
					: message.content.map((b) => (b.type === "text" ? b.text : `<image ${b.mimeType}>`)).join("\n");
			break;
		case "assistant":
			text = message.content
				.map((b) => {
					if (b.type === "text") return b.text;
					if (b.type === "thinking") return "<thinking>";
					return `<tool_call ${b.name}>`;
				})
				.join("\n");
			break;
		case "toolResult":
			text = message.content.map((b) => (b.type === "text" ? b.text : `<image ${b.mimeType}>`)).join("\n");
			break;
		default:
			// pie: hooks.rs:835 -- oracle's `Custom(c)` stringifies an arbitrary `payload` JSON
			// value here; this port's pi-only custom message kinds have no equivalent single
			// "payload" field, so the whole message is stringified as the closest analog.
			text = JSON.stringify(message);
	}
	return truncate(text);
}

/** pie: hooks.rs:840-851 (`result_summary`). `result`/`partialResult` are `any` at the
 * `AgentEvent` type level, so this is written defensively rather than assuming a well-typed
 * `AgentToolResult` shape. */
function resultSummary(result: unknown): string {
	const content =
		result !== null && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)
			? ((result as { content: unknown[] }).content as unknown[])
			: [];
	const text = content.map((block) => contentBlockText(block)).join("\n");
	return truncate(text);
}

function contentBlockText(block: unknown): string {
	if (block === null || typeof block !== "object") return "";
	const b = block as { type?: unknown; text?: unknown; mimeType?: unknown };
	if (b.type === "text" && typeof b.text === "string") return b.text;
	if (b.type === "image" && typeof b.mimeType === "string") return `<image ${b.mimeType}>`;
	return "";
}

/** pie: hooks.rs:853-868 (`assistant_event_name`). Oracle's wire strings use
 * "tool_call_start"/"tool_call_delta"/"tool_call_end"; this port's `AssistantMessageEvent.type`
 * spells those "toolcall_start"/"toolcall_delta"/"toolcall_end" (no underscore) -- remapped
 * explicitly below rather than passed through, to keep the payload's `assistant_event` field
 * byte-identical to oracle's wire value. */
function assistantEventName(ev: AssistantMessageEvent): string {
	switch (ev.type) {
		case "start":
			return "start";
		case "text_start":
			return "text_start";
		case "text_delta":
			return "text_delta";
		case "text_end":
			return "text_end";
		case "thinking_start":
			return "thinking_start";
		case "thinking_delta":
			return "thinking_delta";
		case "thinking_end":
			return "thinking_end";
		case "toolcall_start":
			return "tool_call_start";
		case "toolcall_delta":
			return "tool_call_delta";
		case "toolcall_end":
			return "tool_call_end";
		case "done":
			return "done";
		case "error":
			return "error";
		default: {
			const _exhaustive: never = ev;
			return _exhaustive;
		}
	}
}

/** pie: hooks.rs:870-877 (`truncate`). Rust's `.chars().count()` counts Unicode scalar values;
 * `Array.from(s)` iterates a JS string by code point (handling surrogate pairs), the closest TS
 * equivalent. */
function truncate(s: string): string {
	const chars = Array.from(s);
	if (chars.length <= MAX_SUMMARY_CHARS) return s;
	return `${chars.slice(0, MAX_SUMMARY_CHARS).join("")}…`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Command execution plumbing.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** pie: hooks.rs:749-783 (`env_for`). Only these 14 keys are ever set (7 always, 7 conditional on
 * the corresponding payload field being non-null) -- everything else in the payload is reachable
 * only by reading the `PIE_HOOK_PAYLOAD` JSON file. */
function envFor(payload: HookPayload, payloadPath: string): Record<string, string> {
	const env: Record<string, string> = {
		PIE_HOOK_EVENT: payload.event,
		PIE_HOOK_PAYLOAD: payloadPath,
		PIE_SESSION_ID: payload.session_id,
		PIE_CWD: payload.cwd,
		PIE_MODEL_PROVIDER: payload.model_provider,
		PIE_MODEL_ID: payload.model_id,
		PIE_THINKING_LEVEL: payload.thinking_level,
	};
	if (payload.message_kind !== null) env.PIE_MESSAGE_KIND = payload.message_kind;
	if (payload.assistant_event !== null) env.PIE_ASSISTANT_EVENT = payload.assistant_event;
	if (payload.tool_call_id !== null) env.PIE_TOOL_CALL_ID = payload.tool_call_id;
	if (payload.tool_name !== null) env.PIE_TOOL_NAME = payload.tool_name;
	if (payload.tool_is_error !== null) env.PIE_TOOL_IS_ERROR = String(payload.tool_is_error);
	if (payload.compaction_trigger !== null) env.PIE_COMPACTION_TRIGGER = payload.compaction_trigger;
	if (payload.compaction_tokens_before !== null) {
		env.PIE_COMPACTION_TOKENS_BEFORE = String(payload.compaction_tokens_before);
	}
	return env;
}

/** pie: hooks.rs:785-791 (`write_payload_file`). */
async function writePayloadFile(payloadJson: string): Promise<string> {
	const dir = join(tmpdir(), "pie-hooks");
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, `${randomUUID()}.json`);
	await writeFile(filePath, payloadJson, "utf-8");
	return filePath;
}

/** pie: hooks.rs:879-897 (`shell_program`/`shell_arg`). */
function shellProgram(): string {
	return process.platform === "win32" ? "cmd" : "sh";
}

function shellArg(): string {
	return process.platform === "win32" ? "/C" : "-c";
}
