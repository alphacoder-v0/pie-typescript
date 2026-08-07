/**
 * Trigger supervisor for the CLI's product path.
 *
 * pie: `crates/coding-agent/src/main.rs:769-780` (the three-layer `before_trigger_action` chain),
 * `:817-825` (`register_notification_hook` for the MCP push adapters, `CronNotificationHook` and
 * `DynamicTriggerCheckHook`) and `:1031-1037` (`subscribe_harness` for
 * `fire_once_harness_listener` / `cron_harness_listener`). Oracle hangs all of that off
 * `AgentHarness`; this module is the same wiring against the coding agent's own
 * `core/agent-session.ts` runtime, which is what the CLI actually runs
 * (`migration/reviews/phase13/reachability-audit.md` §1: `agent/harness/agent-harness.ts` has no
 * CLI control flow into it).
 *
 * What this reproduces from `AgentHarness`, and what it does not:
 *
 * - **Reproduced.** Hook supervision (`hook.run(sink)` per adapter, sink drained serially),
 *   `TriggerRuntime.evaluate` admission (dedup window + cycle-hop suppression — the real
 *   `@pie/agent-core` class, so `BeforeTriggerActionContext.runtime` carries a live snapshot
 *   rather than a fabricated one), the `TriggerAction` resolution chain, all three
 *   `TriggerDelivery` branches, and the `trigger_execution_started` / `trigger_completed` /
 *   `trigger_failed` `HarnessEvent`s that `cronHarnessListener` and `fireOnceHarnessListener`
 *   are written against.
 * - **Not reproduced (TODO(port)).** `applyPromotion` (`agent_harness.rs:3022-3312`) — promoting
 *   a sub-agent summary into the parent chat needs the approval UI and the `PromoteAction`
 *   template renderer, neither of which exists on this side yet; `writeTriggerResultAudit`, which
 *   needs the harness's `Session::append_custom` surface that `triggers/cron-deps.ts`'s header
 *   already records as missing; and `abortTrigger`/`/triggers running`, which belong to the
 *   phase-14 command dispatcher. Each is additive: nothing below depends on them, and a trigger
 *   still fires, runs and completes without them.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	Agent,
	type AgentTool,
	AsyncQueue,
	type BeforeTriggerActionHook,
	type HarnessEvent,
	type HarnessListener,
	type NotificationHook,
	type NotificationStatusSnapshot,
	type RunningTriggerState,
	type StreamFn,
	type ThinkingLevel,
	type Trigger,
	TriggerRuntime,
} from "@pie/agent-core";
import type { Model, TextContent } from "@pie/ai";
import { parseTriggerPollIntervalSecs } from "../config.ts";
import { cronSidecarPath, triggerSidecarPath } from "../core/session-manager.ts";
import { defaultInboxPath } from "../inbox.ts";
import {
	CronNotificationHook,
	type CronRegistry,
	cronActionHook,
	cronHarnessListener,
	globalCronRegistry,
} from "./cron.ts";
import {
	beforeTriggerActionHook,
	DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS,
	DynamicTriggerCheckHook,
	type DynamicTriggerRegistry,
	directInjectActionHook,
	fireOnceHarnessListener,
	globalRegistry,
	setDynamicTriggerPollIntervalSecs,
} from "./dynamic.ts";

/** pie: agent_harness.rs:437 (`PROMOTION_BODY_CAP_BYTES`). */
const PROMOTION_BODY_CAP_BYTES = 4096;

/** pie: agent_harness.rs:467-471 (`preview_for_banner`). */
function previewForBanner(text: string, maxChars: number): string {
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	return `${chars.slice(0, maxChars).join("")}…`;
}

/** pie: agent_harness.rs:488-492 (`ensure_trigger_prefix`). */
function ensureTriggerPrefix(body: string, traceId: string): string {
	const expected = `[Trigger ${traceId}] `;
	return body.startsWith(expected) ? body : `${expected}${body}`;
}

/** Byte-budget truncation on a char boundary (oracle `truncate_on_char_boundary`). */
function truncateOnCharBoundary(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let out = "";
	let used = 0;
	for (const ch of text) {
		const size = Buffer.byteLength(ch, "utf8");
		if (used + size > maxBytes) break;
		out += ch;
		used += size;
	}
	return out;
}

/**
 * The slice of `core/agent-session.ts`'s `AgentSession` the three delivery paths need. Declared
 * structurally so `triggers/` keeps no import edge onto `core/` — a real `AgentSession` already
 * satisfies it (`agent` is a public readonly field; the rest are public getters/methods).
 */
export interface TriggerParentSession {
	readonly agent: {
		readonly streamFn?: StreamFn;
		readonly state: { systemPrompt: string; tools: AgentTool<any>[]; model?: Model<any> };
	};
	readonly model: Model<any> | undefined;
	readonly thinkingLevel: ThinkingLevel;
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void>;
	sendCustomMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;
}

export interface TriggerSupervisorOptions {
	/** pie: main.rs:817-825 — MCP push adapters first, then cron, then the dynamic checker. */
	hooks: NotificationHook[];
	/** pie: main.rs:773-780 — the fully composed `cronActionHook(directInjectActionHook(...))`. */
	beforeTriggerAction: BeforeTriggerActionHook;
	/** pie: main.rs:1032-1037 — `fireOnceHarnessListener` and `cronHarnessListener`. */
	listeners: HarnessListener[];
	parent: TriggerParentSession;
	/** Surface for hook-level failures; the CLI routes this to the UI's error line. */
	onError?: (message: string) => void;
}

/**
 * Owns the trigger sink, the hook tasks draining into it, and the dispatch loop consuming it.
 *
 * Lifetime is the interactive session's: {@link start} once the UI exists, {@link stop} on
 * shutdown. Oracle has no `stop` (tokio cancels the spawned tasks when the runtime drops); on this
 * side every hook's `run()` is an unbounded `setTimeout` loop that would keep Node's event loop
 * alive forever, so stopping is explicit — the same rationale `CronNotificationHook.stop()` and
 * `DynamicTriggerCheckHook.stop()` already document for themselves.
 */
export class TriggerSupervisor {
	private readonly sink = new AsyncQueue<Trigger>();
	private readonly runtime = new TriggerRuntime();
	private readonly options: TriggerSupervisorOptions;
	private readonly abort = new AbortController();
	/**
	 * pie: agent_harness.rs:923 (`running_triggers: Map<String, (RunningTriggerState, AbortController)>`)
	 * — the in-flight dispatches `/trigger status` lists and `/trigger abort` cancels. Entries live
	 * exactly as long as {@link dispatch} does.
	 */
	private readonly running = new Map<string, { state: RunningTriggerState; abort: AbortController }>();
	private started = false;
	private drain: Promise<void> | undefined;

	constructor(options: TriggerSupervisorOptions) {
		this.options = options;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		for (const hook of this.options.hooks) {
			// pie: `register_notification_hook` spawns each hook detached; a hook that throws must
			// not take the CLI down with it.
			void hook.run(this.sink).catch((error: unknown) => {
				this.options.onError?.(`trigger source ${hook.label()}: ${messageOf(error)}`);
			});
		}
		this.drain = this.runDrainLoop();
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.abort.abort();
		for (const hook of this.options.hooks) {
			(hook as { stop?: () => void }).stop?.();
		}
		this.sink.close();
		this.abortAllTriggers();
		await this.drain?.catch(() => {});
	}

	/**
	 * pie: agent_harness.rs:380-384 (`NotificationStatusSnapshot`) — what `/trigger status`
	 * (commands.rs:2181) reads. Every field comes from state this supervisor already owns; nothing is
	 * synthesized.
	 */
	notificationStatusSnapshot(): NotificationStatusSnapshot {
		return {
			hooks: this.options.hooks.map((hook) => hook.status()),
			runtime: this.runtime.snapshot(),
			running: [...this.running.values()].map((entry) => entry.state),
		};
	}

	/** pie: `AgentHarness::abort_trigger` (commands.rs:2269) — cancels one in-flight dispatch. */
	abortTrigger(traceId: string): void {
		this.running.get(traceId)?.abort.abort();
	}

	/** pie: `AgentHarness::abort_all_triggers` (commands.rs:2261). */
	abortAllTriggers(): void {
		for (const entry of this.running.values()) entry.abort.abort();
	}

	private async runDrainLoop(): Promise<void> {
		while (!this.abort.signal.aborted) {
			let trigger: Trigger | undefined;
			try {
				trigger = await this.sink.next(this.abort.signal);
			} catch {
				return; // aborted while waiting
			}
			if (trigger === undefined) return; // sink closed and drained
			const admitted = trigger;
			// pie: agent_harness.rs:2520-2532 (`spawn_trigger_action`) — dispatch is detached so a
			// long-running sub-agent never blocks the next inbound trigger.
			void this.dispatch(admitted).catch((error: unknown) => {
				this.emit({ type: "trigger_failed", traceId: admitted.trace_id, reason: messageOf(error) });
			});
		}
	}

	/** pie: agent_harness.rs:2355-2440 (`handle_trigger`) + :2544-2561 (`run_trigger_action`). */
	private async dispatch(trigger: Trigger): Promise<void> {
		const outcome = this.runtime.evaluate(trigger);
		if (outcome.type !== "accept") {
			// Deduped / cycle-suppressed triggers never reach a delivery path. Oracle emits its own
			// `trigger_deduped`/`trigger_cycle_suppressed` harness events here; neither listener
			// wired by the CLI reads them, so they are not synthesized.
			return;
		}
		// pie: agent_harness.rs:2520-2532 — the entry goes into `running_triggers` before any await,
		// so `/trigger status` sees an accepted trigger even while its action hook is still deciding.
		const entry = this.beginRunning(trigger);
		try {
			await this.deliver(trigger, entry.abort.signal);
		} finally {
			this.running.delete(trigger.trace_id);
		}
	}

	/** The delivery half of {@link dispatch}, split out so the `running` bookkeeping has one exit. */
	private async deliver(trigger: Trigger, signal: AbortSignal): Promise<void> {
		const action = await this.options.beforeTriggerAction({ trigger, runtime: this.runtime.snapshot() }, signal);
		const traceId = trigger.trace_id;

		if (action.delivery === "inject_summary") {
			// pie: agent_harness.rs:2570-2601. No model call: `payload_summary` IS the result.
			const summary = trigger.payload_summary ?? undefined;
			this.emitStarted(trigger, previewForBanner(summary ?? "(no summary)", 80));
			await this.options.parent.sendCustomMessage({
				customType: "trigger",
				content: summary ?? "",
				display: true,
				details: { trace_id: traceId, delivery: "inject_summary" },
			});
			this.emit({ type: "trigger_completed", traceId, summary, costUsd: 0, details: null });
			return;
		}

		if (action.delivery === "inject_and_run") {
			// pie: agent_harness.rs:2616-2664. The prompt is injected into the PARENT conversation
			// and one parent turn runs. `sendUserMessage` is the product path's single entry point
			// for exactly that serialization: it queues as a follow-up while a turn is in flight,
			// and starts a turn when idle.
			const body = ensureTriggerPrefix(truncateOnCharBoundary(action.prompt, PROMOTION_BODY_CAP_BYTES), traceId);
			this.emitStarted(trigger, previewForBanner(body, 80));
			await this.options.parent.sendUserMessage(body, { deliverAs: "followUp" });
			this.emit({ type: "trigger_completed", traceId, summary: body, costUsd: 0, details: null });
			return;
		}

		// pie: agent_harness.rs:2676-2816 (`run_sub_agent_delivery`) — a fully isolated sub-agent
		// that inherits the parent's model / system prompt / active tools / thinking level but
		// none of its conversation messages.
		this.emitStarted(trigger, previewForBanner(action.prompt, 80));
		const summary = await this.runSubAgent(action.prompt, signal);
		this.emit({ type: "trigger_completed", traceId, summary, costUsd: 0, details: null });
	}

	private async runSubAgent(prompt: string, signal: AbortSignal): Promise<string | undefined> {
		const parent = this.options.parent;
		const model = parent.model ?? parent.agent.state.model;
		if (!model) {
			// No credential resolved for this session (oracle always has `credential_less_default`);
			// a sub-agent with no model cannot run. Surface it as a failure rather than a silent
			// completion, so `cronHarnessListener` marks the job with the reason.
			throw new Error("no model configured");
		}
		const sub = new Agent({
			initialState: {
				systemPrompt: parent.agent.state.systemPrompt,
				model,
				thinkingLevel: parent.thinkingLevel,
				tools: parent.agent.state.tools,
			},
			streamFn: parent.agent.streamFn,
		});
		let finalText = "";
		const unsubscribe = sub.subscribe((event) => {
			if (event.type === "message_end" && "role" in event.message && event.message.role === "assistant") {
				const text = event.message.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (text.length > 0) finalText = text;
			}
		});
		const onAbort = () => sub.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await sub.prompt(prompt);
		} finally {
			signal.removeEventListener("abort", onAbort);
			unsubscribe();
		}
		return finalText.length > 0 ? finalText : undefined;
	}

	/**
	 * Register one accepted trigger as in-flight. Its controller is chained off the supervisor's, so
	 * `stop()` cancels every dispatch while `/trigger abort <trace>` cancels exactly one.
	 */
	private beginRunning(trigger: Trigger): { state: RunningTriggerState; abort: AbortController } {
		const abort = new AbortController();
		if (this.abort.signal.aborted) abort.abort();
		else this.abort.signal.addEventListener("abort", () => abort.abort(), { once: true });
		const entry = {
			state: {
				traceId: trigger.trace_id,
				sourceLabel: trigger.source_label,
				eventLabel: trigger.event_label,
				startedAt: new Date().toISOString(),
				// Filled in by `emitStarted`, once the action hook has decided what will actually run.
				promptPreview: "",
			} satisfies RunningTriggerState,
			abort,
		};
		this.running.set(trigger.trace_id, entry);
		return entry;
	}

	private emitStarted(trigger: Trigger, promptPreview: string): void {
		const entry = this.running.get(trigger.trace_id);
		if (entry !== undefined) entry.state = { ...entry.state, promptPreview };
		this.emit({
			type: "trigger_execution_started",
			traceId: trigger.trace_id,
			sourceLabel: trigger.source_label,
			eventLabel: trigger.event_label,
			promptPreview,
		});
	}

	private emit(event: HarnessEvent): void {
		for (const listener of this.options.listeners) {
			try {
				listener(event);
			} catch (error) {
				this.options.onError?.(`trigger listener: ${messageOf(error)}`);
			}
		}
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------------------------
 * Startup wiring — everything `main.rs` does between session creation and the first REPL tick.
 * ----------------------------------------------------------------------------------------- */

/** Same shape as `core/agent-session-services.ts`'s `AgentSessionRuntimeDiagnostic`, restated
 * locally so `triggers/` keeps no import edge onto `core/agent-session-services.ts`. */
export interface TriggerDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

export interface TriggerSubsystem {
	cronRegistry: CronRegistry;
	dynamicRegistry: DynamicTriggerRegistry;
	/** Effective `[triggers] poll_interval_secs`, after CLI > config > default resolution. */
	pollIntervalSecs: number;
	/** In `main.rs:817-825` registration order: MCP adapters, cron, dynamic. */
	hooks: NotificationHook[];
	/** pie: main.rs:773-780, fully composed. */
	beforeTriggerAction: BeforeTriggerActionHook;
	/** pie: main.rs:1032-1037. */
	listeners: HarnessListener[];
	/** pie: main.rs:903, :923-947, :991 — the startup lines oracle prints into the feed. */
	diagnostics: TriggerDiagnostic[];
}

/**
 * pie: main.rs:1282-1308 (`read_trigger_poll_interval_secs`). CLI overrides config; config
 * overrides the built-in default; a malformed config reports a diagnostic but does not block
 * startup.
 */
export async function readTriggerPollIntervalSecs(
	agentDir: string,
	cliOverride: number | undefined,
): Promise<{ secs: number; diagnostic?: string }> {
	if (cliOverride !== undefined) {
		return { secs: cliOverride };
	}
	const path = join(agentDir, "config.toml");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		// oracle: `let Ok(text) = tokio::fs::read_to_string(&path).await else { return default }`.
		return { secs: DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS };
	}
	try {
		const secs = parseTriggerPollIntervalSecs(text);
		return { secs: secs ?? DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS };
	} catch (error) {
		return {
			secs: DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS,
			// oracle main.rs:1301-1304, verbatim.
			diagnostic: `triggers: ignoring invalid poll interval in ${path}: ${messageOf(error)}`,
		};
	}
}

export interface LoadTriggerSubsystemOptions {
	/** `sessionManager.getSessionFile()`. `undefined` for `--no-session`: both registries stay
	 * in memory, exactly as oracle's in-memory session path leaves them. */
	sessionFile: string | undefined;
	agentDir: string;
	/** `--trigger-poll-secs`. pie: main.rs:119-122, consumed at :691-693. */
	cliPollIntervalSecs?: number;
	/** From `AgentSessionServices.mcp`. pie: main.rs:664-667, 774-778, 817-819. */
	mcp: {
		notificationHooks: NotificationHook[];
		injectSummaryServers: ReadonlySet<string>;
		injectAndRunServers: ReadonlySet<string>;
	};
}

/**
 * Load both session-scoped registries, resolve the dynamic poll interval, and compose the hook /
 * listener wiring oracle installs on `AgentHarness`.
 *
 * Ordering is oracle's and is load-bearing: the poll interval must be applied
 * (`set_dynamic_trigger_poll_interval_secs`, main.rs:693) BEFORE `DynamicTriggerCheckHook` is
 * constructed (main.rs:824), because the hook snapshots the module-level interval in its
 * constructor.
 */
export async function loadTriggerSubsystem(options: LoadTriggerSubsystemOptions): Promise<TriggerSubsystem> {
	const diagnostics: TriggerDiagnostic[] = [];
	const dynamicRegistry = globalRegistry();
	const cronRegistry = globalCronRegistry();

	// pie: main.rs:598, 613-616 — dynamic rules first, then cron (main.rs:617-619). A load
	// failure is reported and the registry stays empty; it never aborts startup.
	if (options.sessionFile !== undefined) {
		try {
			dynamicRegistry.loadFromPath(triggerSidecarPath(options.sessionFile));
		} catch (error) {
			// pie: main.rs:923-924 — `app.error_line(format!("dynamic triggers: {err}"))`.
			diagnostics.push({ type: "error", message: `dynamic triggers: ${messageOf(error)}` });
		}
		try {
			cronRegistry.loadFromPath(cronSidecarPath(options.sessionFile));
		} catch (error) {
			// pie: main.rs:936-937 — `app.error_line(format!("cron: {err}"))`.
			diagnostics.push({ type: "error", message: `cron: ${messageOf(error)}` });
		}
	}

	// pie: main.rs:691-693.
	const { secs: pollIntervalSecs, diagnostic: pollDiagnostic } = await readTriggerPollIntervalSecs(
		options.agentDir,
		options.cliPollIntervalSecs,
	);
	setDynamicTriggerPollIntervalSecs(pollIntervalSecs);
	if (pollDiagnostic !== undefined) {
		// pie: main.rs:903-905 — `app.error_line(diag)`.
		diagnostics.push({ type: "error", message: pollDiagnostic });
	}

	// pie: main.rs:925-934 / :938-947 — one line per non-empty registry, naming its storage path.
	const rules = dynamicRegistry.list();
	if (rules.length > 0) {
		diagnostics.push({
			type: "info",
			message: `loaded ${rules.length} dynamic trigger rule(s) from ${dynamicRegistry.storagePath() ?? "memory"}`,
		});
	}
	const jobs = cronRegistry.list();
	if (jobs.length > 0) {
		diagnostics.push({
			type: "info",
			message: `loaded ${jobs.length} cron job(s) from ${cronRegistry.storagePath() ?? "memory"}`,
		});
	}
	if (options.mcp.notificationHooks.length > 0) {
		// pie: main.rs:982-986.
		diagnostics.push({
			type: "info",
			message: `trigger sources: watching ${options.mcp.notificationHooks.length} configured MCP push source(s)`,
		});
	}
	// pie: main.rs:990-992 — printed unconditionally.
	diagnostics.push({
		type: "info",
		message: `triggers: local dynamic checker polls every ${pollIntervalSecs}s while enabled rules exist`,
	});

	return {
		cronRegistry,
		dynamicRegistry,
		pollIntervalSecs,
		// pie: main.rs:817-825 — MCP adapters, then cron, then the dynamic checker.
		hooks: [
			...options.mcp.notificationHooks,
			new CronNotificationHook(cronRegistry),
			new DynamicTriggerCheckHook(dynamicRegistry),
		],
		// pie: main.rs:773-780, exact nesting.
		beforeTriggerAction: cronActionHook(
			cronRegistry,
			directInjectActionHook(
				options.mcp.injectSummaryServers,
				options.mcp.injectAndRunServers,
				beforeTriggerActionHook(dynamicRegistry),
			),
		),
		// pie: main.rs:1032-1037.
		listeners: [fireOnceHarnessListener(dynamicRegistry), cronHarnessListener(cronRegistry, defaultInboxPath())],
		diagnostics,
	};
}
