/**
 * `/goal` runtime wiring — the piece that makes `goal.ts` reachable from the CLI.
 *
 * `goal.ts` is a faithful port of oracle `crates/coding-agent/src/goal.rs` and, like its source,
 * takes an `&Arc<AgentHarness>`-shaped handle (`goal-deps.ts`'s `GoalHarness`) plus a lazily
 * settable `OnceLock` cell (`GoalHarnessCell`). Oracle fills that cell in `main.rs:808-811`, right
 * after `AgentHarness::new`. Nothing filled it on this side, so `/goal` had no reachable caller at
 * all (`migration/reviews/phase13/reachability-audit.md` §3).
 *
 * ## Why an adapter rather than repointing `goal.ts` at `core/agent-session.ts`
 *
 * The brief offered both. This module takes the adapter route because:
 *
 * 1. `goal.ts` stays a 1:1 port of `goal.rs`. Repointing it at `AgentSession` would make the
 *    ported file diverge from its Rust source in exactly the way RULEBOOK §7 ("the old code is the spec")
 *    warns against, and would put a `goal.ts -> core/agent-session.ts` import edge into a file
 *    whose oracle counterpart imports nothing of the kind.
 * 2. The chicken-and-egg the cell exists to solve is real here too: `stopHook(cell)` has to be
 *    constructible before the session it will observe exists, because the CLI builds the session
 *    inside `createAgentSessionRuntime`'s factory. Deleting the cell would just move that problem.
 * 3. It is reversible. If `AgentHarness` ever grows the public `session()` accessor that
 *    `goal-deps.ts` and `triggers/cron-deps.ts` both wait on, this file shrinks to nothing.
 *
 * ## Where the continuation loop lives
 *
 * Oracle wires `opts.on_turn_end = goal::stop_hook(cell)` and
 * `opts.turn_continuation_cap = goal::MAX_CONTINUATIONS` onto `AgentHarness` (main.rs:750-751), and
 * `AgentHarness::run_turn_with_continuation` drives the retry cycle. The CLI's runtime is
 * `core/agent-session.ts`, which has no such loop — so {@link GoalController} drives it from the
 * outside, on the session's own `agent_end` event. Both caps stay in force on this path:
 * `TRANSCRIPT_CHAR_LIMIT` (40,000 chars) inside `goal.ts`'s `transcriptFromMessages`, and
 * `MAX_CONTINUATIONS` (8) inside `evaluateStopHook` — which oracle's own comment (goal.rs:312-323)
 * describes as the check that always fires first, ahead of the harness's generic cap. The
 * harness-level cap is therefore redundant defense in depth on the oracle side too, and its
 * absence here costs no `/goal` behaviour.
 */

import {
	Agent,
	type AgentMessage,
	EvaluatorError,
	type EvaluatorOutput,
	type OnTurnEndHook,
	type ThinkingLevel,
} from "@pie/agent-core";
import type { Model, TextContent } from "@pie/ai";
import type { AgentSession, AgentSessionEvent } from "./core/agent-session.ts";
import { MAX_CONTINUATIONS, stopHook } from "./goal.ts";
import type { GoalHarness, GoalHarnessCell, GoalSessionEntry } from "./goal-deps.ts";

/**
 * Adapt a live {@link AgentSession} to the `GoalHarness` surface `goal.ts` consumes.
 *
 * `session()` maps onto `SessionManager`, whose `getEntries()` / `appendCustomEntry()` are the
 * product-path equivalents of oracle's `Session::entries()` / `Session::append_custom()` — the same
 * two calls `goal-deps.ts` documents. Both are synchronous here and are wrapped rather than
 * reimplemented, so `goal.ts`'s `await`s are honoured without changing its shape.
 */
export function createGoalHarness(session: AgentSession): GoalHarness {
	return {
		session: () => ({
			getEntries: async (): Promise<GoalSessionEntry[]> =>
				session.sessionManager.getEntries() as unknown as GoalSessionEntry[],
			appendCustomEntry: async (customType: string, data?: unknown): Promise<string> =>
				session.sessionManager.appendCustomEntry(customType, data),
		}),
		getModel: () => {
			const model = session.model;
			if (!model) {
				// `goal-deps.ts` types `getModel()` after `AgentHarness.getModel()`, which is
				// non-optional because that constructor requires a model. `AgentSession`'s resolver
				// can legitimately come up empty. Throwing routes through `evaluateStopHook`'s own
				// catch, which pauses the goal with the reason attached — the same user-visible
				// outcome as oracle's `None => pause` branch (goal.rs:250-261).
				throw new EvaluatorError("run", "goal evaluator unavailable: no model configured");
			}
			return model;
		},
		runEvaluator: (systemPrompt, userPrompt, model, thinkingLevel, signal) =>
			runEvaluator(session, systemPrompt, userPrompt, model, thinkingLevel, signal),
	};
}

/**
 * pie: agent_harness.rs:1953-2018 (`run_evaluator`) — a tool-less, in-memory evaluator sub-agent
 * whose last assistant text is the answer. Cost is deliberately NOT attributed to the parent
 * session, matching oracle's "same honesty rule the `trigger_result.cost_usd: null` audit follows":
 * the transcript is discarded and never reaches `sessionManager`.
 */
async function runEvaluator(
	session: AgentSession,
	systemPrompt: string,
	userPrompt: string,
	model: Model<any>,
	thinkingLevel: ThinkingLevel,
	signal: AbortSignal,
): Promise<EvaluatorOutput> {
	const evaluator = new Agent({
		initialState: {
			systemPrompt,
			model,
			thinkingLevel,
			// Oracle's explicit "Intentionally no before/after_tool_call hooks — evaluator has no
			// tools" comment; an empty tool list makes both moot.
			tools: [],
		},
		streamFn: session.agent.streamFn,
	});

	let lastAssistantText: string | undefined;
	const unsubscribe = evaluator.subscribe((event) => {
		if (event.type === "message_end" && "role" in event.message && event.message.role === "assistant") {
			const text = event.message.content
				.filter((block): block is TextContent => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (text.length > 0) lastAssistantText = text;
		}
	});
	const onAbort = () => evaluator.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await evaluator.prompt(userPrompt);
	} catch (error) {
		if (signal.aborted) throw new EvaluatorError("cancelled", "evaluator cancelled");
		const message = error instanceof Error ? error.message : String(error);
		throw new EvaluatorError("run", `evaluator agent failed: ${message}`, { cause: error });
	} finally {
		signal.removeEventListener("abort", onAbort);
		unsubscribe();
	}
	if (signal.aborted) throw new EvaluatorError("cancelled", "evaluator cancelled");
	return { lastAssistantText };
}

/**
 * The `OnceLock` half of oracle's `Arc<OnceLock<Arc<AgentHarness>>>` (main.rs:715, filled at
 * :808-811). `set` is idempotent-by-refusal like `OnceLock::set`, so a second call is a no-op
 * rather than a silent rebind.
 */
export class SettableGoalHarnessCell implements GoalHarnessCell {
	private value: GoalHarness | undefined;

	get(): GoalHarness | undefined {
		return this.value;
	}

	set(harness: GoalHarness): boolean {
		if (this.value !== undefined) return false;
		this.value = harness;
		return true;
	}
}

export interface GoalControllerOptions {
	session: AgentSession;
	/** Surfaced to the user when the hook pauses or stops the goal. */
	onNotice?: (message: string) => void;
}

/**
 * Drives `goal.ts`'s stop hook off the product session's turn boundary.
 *
 * pie: agent_harness.rs:1478-1560 (`run_turn_with_continuation`) — after a turn completes the hook
 * is consulted, and a `Continue` decision starts another prompt cycle with the hook's prompt as a
 * new user message. `AgentSession` has no such loop, so this listener is it: `agent_end` is the
 * product path's turn boundary, and `session.prompt()` is its "start another cycle".
 *
 * `willRetry` turns (auto-retry after a provider error) are skipped — oracle only reaches the hook
 * once a turn has actually finished, and re-running the evaluator against a half-failed transcript
 * would burn a continuation for nothing.
 */
export class GoalController {
	/** pie: main.rs:751 — `opts.turn_continuation_cap = Some(goal::MAX_CONTINUATIONS)`. */
	static readonly continuationCap = MAX_CONTINUATIONS;

	readonly harness: GoalHarness;
	readonly cell = new SettableGoalHarnessCell();
	private readonly session: AgentSession;
	private readonly hook: OnTurnEndHook;
	private readonly onNotice: ((message: string) => void) | undefined;
	private continuationCount = 0;
	private running = false;
	private unsubscribe: (() => void) | undefined;

	constructor(options: GoalControllerOptions) {
		this.session = options.session;
		this.onNotice = options.onNotice;
		this.harness = createGoalHarness(options.session);
		this.cell.set(this.harness);
		// pie: main.rs:750 — `opts.on_turn_end = Some(goal::stop_hook(goal_harness_cell.clone()))`.
		this.hook = stopHook(this.cell);
	}

	start(): void {
		if (this.unsubscribe) return;
		this.unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
			if (event.type !== "agent_end" || event.willRetry) return;
			void this.onTurnEnd();
		});
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	/** Reset between prompt cycles the user starts by hand, matching oracle's per-`prompt()`
	 * `continuation_count` (agent_harness.rs:1490). */
	resetContinuationCount(): void {
		this.continuationCount = 0;
	}

	private async onTurnEnd(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const decision = await this.hook(
				{
					transcript: this.session.messages as readonly AgentMessage[],
					continuationCount: this.continuationCount,
					lastUserPrompt: lastUserPromptOf(this.session.messages),
				},
				new AbortController().signal,
			);
			switch (decision.action.kind) {
				case "noop":
					return;
				case "stop":
					this.continuationCount = 0;
					this.onNotice?.("goal achieved");
					return;
				case "pause":
					this.continuationCount = 0;
					this.onNotice?.(`goal paused: ${decision.action.reason}`);
					return;
				case "continue": {
					this.continuationCount += 1;
					const prompt = decision.action.prompt;
					// Detached: `prompt()` resolves only when the whole next turn finishes, and this
					// listener runs inside the previous turn's `agent_end` dispatch.
					void this.session.prompt(prompt).catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						this.onNotice?.(`goal continuation failed: ${message}`);
					});
					return;
				}
			}
		} finally {
			this.running = false;
		}
	}
}

function lastUserPromptOf(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		return content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return undefined;
}
