/**
 * Session-level `/goal` stop hook.
 *
 * Port of oracle `crates/coding-agent/src/goal.rs` (pie @0a120dfd, 437 lines). A goal is stored
 * as append-only session metadata, then evaluated after each successful model turn. The
 * evaluator is a SEPARATE model call with no tools and only a bounded text transcript — it never
 * reuses the main turn's own response. It returns structured JSON; missing evidence defaults to
 * "not done".
 *
 * Depends on `@pie/agent-core`'s `AgentHarness.runEvaluator()` / `OnTurnEndHook` / `continue()` /
 * `run_turn_with_continuation`-equivalent continuation machinery, ported alongside this unit as a
 * phase-11 prerequisite per `migration/reviews/agent/gap-continuation.md` (phase 8 flagged the
 * gap; that document names this exact unit as the consumer). `GoalHarness`/`GoalHarnessCell` (see
 * `./goal-deps.ts`) stand in for the one piece of that surface still not public on the real
 * `AgentHarness` class (`session()`), mirroring `triggers/cron-deps.ts`'s identical, earlier
 * precedent.
 */

import {
	EvaluatorError,
	type EvaluatorOutput,
	type OnTurnEndContext,
	type OnTurnEndHook,
	type TurnEndDecision,
} from "@pie/agent-core";
import type { GoalHarness, GoalHarnessCell, GoalSessionEntry } from "./goal-deps.ts";
import { emit } from "./logging.ts";

export const CUSTOM_TYPE = "goal_state";
/** pie: goal.rs:18 (`TRANSCRIPT_CHAR_LIMIT`). Module-private in oracle too (no `pub`) — the
 * evaluator transcript is bounded to the last 40,000 *characters* (code points, not UTF-16 code
 * units — see {@link tailChars}), independent of `AgentHarness`'s own compaction thresholds. */
const TRANSCRIPT_CHAR_LIMIT = 40_000;
/** pie: goal.rs:19 (`pub const MAX_CONTINUATIONS: u32 = 8`). Wired as the harness's
 * `turnContinuationCap` by the embedder (oracle: `main.rs:751`,
 * `opts.turn_continuation_cap = Some(goal::MAX_CONTINUATIONS)`) AND enforced independently here
 * via `state.iterations` — the two caps are set to the same value so they trip in lockstep; this
 * hook's own check fires first in practice (see the doc comment on the budget-limited branch
 * below). */
export const MAX_CONTINUATIONS = 8;

/** pie: goal.rs:21-29 (`GoalStatus`, `#[serde(rename_all = "snake_case")]`). Unit-only enum ->
 * string literal union (RULEBOOK §2.1); the string values themselves already equal the wire
 * (snake_case) form serde produces. */
export type GoalStatus = "pursuing" | "paused" | "achieved" | "budget_limited" | "cleared";

const GOAL_STATUSES: readonly GoalStatus[] = ["pursuing", "paused", "achieved", "budget_limited", "cleared"];

/** pie: goal.rs:43-52 (`GoalState`). Field names equal the wire (JSON) names exactly (RULEBOOK
 * §2.1) — no camelCase rename; `last_reason` is omitted (not `null`) when absent, matching serde's
 * `skip_serializing_if = "Option::is_none"`. */
export interface GoalState {
	condition: string;
	status: GoalStatus;
	iterations: number;
	last_reason?: string;
	updated_at: string;
}

/** pie: goal.rs:54-61 (`GoalState::active`). */
export function isGoalActive(state: GoalState): boolean {
	return state.status === "pursuing" || state.status === "paused" || state.status === "budget_limited";
}

/** pie: goal.rs:63-67 (`EvaluatorDecision`, private in oracle — exported here only because
 * {@link parseDecision} is; see that function's doc comment). Both fields are required — a
 * missing or mistyped `ok`/`reason` fails validation the same way serde's non-`#[serde(default)]`
 * struct deserialization would. */
export interface EvaluatorDecision {
	ok: boolean;
	reason: string;
}

/** pie: goal.rs:69-72 (`current`). Reads the FULL unfiltered entry list (`Session::entries()`,
 * not `Session::branch()`) and returns the latest `goal_state` custom entry, treating a
 * `"cleared"` status the same as "no goal" — a session read failure also resolves to `undefined`
 * (oracle: `.entries().await.ok()?`, short-circuiting via `Option`). */
export async function current(harness: GoalHarness): Promise<GoalState | undefined> {
	let entries: GoalSessionEntry[];
	try {
		entries = await harness.session().getEntries();
	} catch {
		return undefined;
	}
	const state = latestFromEntries(entries);
	if (!state || state.status === "cleared") return undefined;
	return state;
}

/** pie: goal.rs:74-84 (`set`). */
export async function set(harness: GoalHarness, condition: string): Promise<GoalState> {
	const state: GoalState = {
		condition,
		status: "pursuing",
		iterations: 0,
		updated_at: rfc3339Now(),
	};
	await appendState(harness, state);
	return state;
}

/** pie: goal.rs:86-94 (`pause`). No status guard beyond "a non-cleared goal exists" — pausing an
 * already-`achieved`/`budget_limited` goal is allowed, bug-for-bug with oracle (no extra check). */
export async function pause(harness: GoalHarness): Promise<GoalState> {
	const state = await current(harness);
	if (!state) throw new Error("no active goal; set one with /goal <condition>");
	const nextState: GoalState = { ...state, status: "paused", updated_at: rfc3339Now() };
	await appendState(harness, nextState);
	return nextState;
}

/** pie: goal.rs:96-107 (`resume`). */
export async function resume(harness: GoalHarness): Promise<GoalState> {
	const state = await current(harness);
	if (!state) throw new Error("no paused goal; set one with /goal <condition>");
	if (state.status !== "paused" && state.status !== "budget_limited") {
		throw new Error("goal is not paused");
	}
	const nextState: GoalState = { ...state, status: "pursuing", updated_at: rfc3339Now() };
	await appendState(harness, nextState);
	return nextState;
}

/** pie: goal.rs:109-121 (`clear`). When no goal exists yet, synthesizes an empty already-cleared
 * state (matches oracle's `unwrap_or_else`) rather than throwing — `/goal clear` on a session that
 * never had a goal is a no-op success, not an error. */
export async function clear(harness: GoalHarness): Promise<GoalState> {
	const existing = await current(harness);
	const base: GoalState = existing ?? {
		condition: "",
		status: "cleared",
		iterations: 0,
		updated_at: rfc3339Now(),
	};
	const nextState: GoalState = { ...base, status: "cleared", updated_at: rfc3339Now() };
	await appendState(harness, nextState);
	return nextState;
}

/** pie: goal.rs:123-130 (`append_state`). oracle maps the session error to `String`; TS just lets
 * whatever `appendCustomEntry` throws propagate (RULEBOOK §2.1 `Result<T,E>` -> throw). */
async function appendState(harness: GoalHarness, state: GoalState): Promise<void> {
	await harness.session().appendCustomEntry(CUSTOM_TYPE, state);
}

/** pie: goal.rs:132-145 (`latest_from_entries`). Walks entries newest-first; an entry that is the
 * right custom type but fails `parseGoalState` validation is SKIPPED, not treated as "no goal" —
 * the scan continues to older entries (mirrors `Iterator::find_map`'s "closure returned `None` ->
 * try the next item" semantics for BOTH "wrong type" and "failed to parse" cases alike). */
function latestFromEntries(entries: readonly GoalSessionEntry[]): GoalState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		const state = parseGoalState(entry.data);
		if (state) return state;
	}
	return undefined;
}

/** pie: goal.rs:143 (`serde_json::from_value(data.clone()?).ok()`) — the runtime-validation
 * counterpart of serde's typed deserialization: `condition`/`status`/`updated_at` are required
 * and type-checked (an unrecognized `status` string fails, matching serde's enum-variant
 * matching); `iterations` defaults to 0 when absent/non-numeric (`#[serde(default)]`);
 * `last_reason` is kept only when it's a string. */
function parseGoalState(data: unknown): GoalState | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.condition !== "string") return undefined;
	if (typeof record.status !== "string" || !GOAL_STATUSES.includes(record.status as GoalStatus)) return undefined;
	if (typeof record.updated_at !== "string") return undefined;
	const iterations = typeof record.iterations === "number" ? record.iterations : 0;
	const state: GoalState = {
		condition: record.condition,
		status: record.status as GoalStatus,
		iterations,
		updated_at: record.updated_at,
	};
	if (typeof record.last_reason === "string") state.last_reason = record.last_reason;
	return state;
}

/** pie: goal.rs:147-156 (`transcript_from_messages`). */
function transcriptFromMessages(messages: readonly OnTurnEndContext["transcript"][number][], maxChars: number): string {
	const lines: string[] = [];
	for (const message of messages) {
		const line = agentMessageText(message);
		if (line !== undefined) lines.push(line);
	}
	return tailChars(lines.join("\n\n"), maxChars);
}

/** pie: goal.rs:158-202 (`agent_message_text`). Returns `undefined` for any message whose `role`
 * isn't `"user"`/`"assistant"`/`"toolResult"` (base's `AgentMessage` also carries custom
 * non-LLM variants — mirrors oracle's `let AgentMessage::Llm(message) = message else { return
 * None; };` guard) and for assistant/tool-result messages whose extracted text is blank. */
function agentMessageText(message: OnTurnEndContext["transcript"][number]): string | undefined {
	if (message.role === "user") {
		return `User: ${userContentText(message.content)}`;
	}
	if (message.role === "assistant") {
		const text = message.content
			.map((block) => {
				if (block.type === "text") return block.text;
				if (block.type === "thinking") return block.thinking;
				if (block.type === "toolCall") return block.name;
				return undefined;
			})
			.filter((part): part is string => part !== undefined)
			.join("\n");
		return text.trim().length === 0 ? undefined : `Assistant: ${text}`;
	}
	if (message.role === "toolResult") {
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		return text.trim().length === 0 ? undefined : `ToolResult(${message.toolName} error=${message.isError}): ${text}`;
	}
	return undefined;
}

/** pie: goal.rs:204-216 (`user_content_text`). */
function userContentText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? (block.text ?? "") : "[image]")).join("\n");
}

/**
 * Build the runtime stop hook used by `/goal`. pie: goal.rs:218-235 (`stop_hook`). The harness
 * owns hook execution, but the hook itself needs a handle back to the live harness so it can read
 * goal state, run a tool-less evaluator, and persist the updated goal state — `harnessCell` is
 * filled by the embedder immediately after constructing the harness (oracle: `main.rs` fills the
 * `OnceLock` right after `AgentHarness::new`).
 */
export function stopHook(harnessCell: GoalHarnessCell): OnTurnEndHook {
	return async (ctx, signal) => {
		const harness = harnessCell.get();
		if (!harness) {
			return { action: { kind: "pause", reason: "goal hook was not initialized" } };
		}
		return evaluateStopHook(harness, ctx, signal);
	};
}

/** pie: goal.rs:237-332 (`evaluate_stop_hook`). */
async function evaluateStopHook(
	harness: GoalHarness,
	ctx: OnTurnEndContext,
	signal: AbortSignal,
): Promise<TurnEndDecision> {
	const initial = await current(harness);
	if (!initial || initial.status !== "pursuing") {
		return { action: { kind: "noop" } };
	}

	const transcript = transcriptFromMessages(ctx.transcript, TRANSCRIPT_CHAR_LIMIT);
	// pie: goal.rs:250-261 (`let model = ... harness.agent().state().model.clone(); match model {
	// None => ... }`) — oracle's inner `Agent::state().model` is `Option<Model>` because a bare
	// `Agent` may not have a model set yet. Base's `AgentHarness.getModel()` is non-optional (the
	// constructor requires a `model`), so that branch has no reachable TS equivalent and is
	// intentionally not ported — see divergence-ledger.tsv.
	const model = harness.getModel();

	let output: EvaluatorOutput;
	try {
		output = await harness.runEvaluator(
			evaluatorSystemPrompt(),
			evaluatorUserPrompt(initial.condition, transcript),
			model,
			"off",
			signal,
		);
	} catch (error) {
		const reason =
			error instanceof EvaluatorError && error.kind === "cancelled"
				? "goal evaluator cancelled"
				: `goal evaluator failed: ${errorMessage(error)}`;
		return pauseAndPersist(harness, initial, reason);
	}

	if (!output.lastAssistantText) {
		return pauseAndPersist(harness, initial, "goal evaluator returned no text");
	}

	let decision: EvaluatorDecision;
	try {
		decision = parseDecision(output.lastAssistantText);
	} catch (error) {
		return pauseAndPersist(harness, initial, `goal evaluator failed: ${errorMessage(error)}`);
	}

	let state: GoalState = {
		...initial,
		iterations: initial.iterations + 1,
		last_reason: decision.reason,
		updated_at: rfc3339Now(),
	};

	if (decision.ok) {
		state = { ...state, status: "achieved" };
		await persistStateBestEffort(harness, state);
		return { action: { kind: "stop" }, payload: goalPayload(state, true) };
	}

	// pie: goal.rs:312-323 — this hook-local counter is checked (and set to the SAME value,
	// MAX_CONTINUATIONS = the harness's own turnContinuationCap wired by the embedder) BEFORE the
	// harness's own generic continuation-cap check ever gets a chance to fire: this branch always
	// returns a `Pause` (not `Continue`) on the boundary iteration, so `runTurnWithContinuation`'s
	// own `continuationCount >= turnContinuationCap` short-circuit is redundant-but-consistent
	// defense in depth, never the one that actually trips for `/goal`.
	if (state.iterations >= MAX_CONTINUATIONS) {
		state = { ...state, status: "budget_limited" };
		await persistStateBestEffort(harness, state);
		return {
			action: {
				kind: "pause",
				reason: `goal continuation limit reached (${MAX_CONTINUATIONS}); resume with /goal resume`,
			},
			payload: goalPayload(state, false),
		};
	}

	await persistStateBestEffort(harness, state);
	return {
		action: { kind: "continue", prompt: continuationPrompt(state.condition, decision.reason) },
		payload: goalPayload(state, false),
	};
}

/** pie: goal.rs:334-352 (`persist_pause` + `pause_decision`, fused since every call site here
 * chains them identically). */
async function pauseAndPersist(harness: GoalHarness, state: GoalState, reason: string): Promise<TurnEndDecision> {
	const nextState: GoalState = { ...state, status: "paused", last_reason: reason, updated_at: rfc3339Now() };
	await persistStateBestEffort(harness, nextState);
	return { action: { kind: "pause", reason }, payload: goalPayload(nextState, undefined) };
}

/** pie: goal.rs:341-345 (`persist_state_best_effort`). Best-effort: a persistence failure does
 * not change the returned `TurnEndDecision` — it's only logged, matching oracle's
 * `tracing::warn!`. That warning now reaches the real subscriber (`logging.ts`, installed by
 * `main.ts` at startup — phase 13 T5-a); `console.error` was the stopgap while no sink existed,
 * and is gone because in interactive mode it would have been written straight over the TUI. */
async function persistStateBestEffort(harness: GoalHarness, state: GoalState): Promise<void> {
	try {
		await appendState(harness, state);
	} catch (error) {
		// pie: goal.rs:343 — message text verbatim.
		emit("warn", "pie::goal", `persist goal state failed: ${errorMessage(error)}`);
	}
}

/** pie: goal.rs:354-364 (`goal_payload`). */
function goalPayload(state: GoalState, ok: boolean | undefined): Record<string, unknown> {
	return {
		goal_status: state.status,
		condition: state.condition,
		ok: ok ?? null,
		reason: state.last_reason ?? null,
		iterations: state.iterations,
		max_continuations: MAX_CONTINUATIONS,
		updated_at: state.updated_at,
	};
}

/** pie: goal.rs:366-368 (`evaluator_user_prompt`). User-visible text — reproduced verbatim. */
function evaluatorUserPrompt(condition: string, transcript: string): string {
	return `Goal condition:\n${condition}\n\nConversation transcript:\n${transcript}`;
}

/** pie: goal.rs:370-379 (`evaluator_system_prompt`). User-visible text — reproduced verbatim
 * (RULEBOOK §2.1 "format!/Display -> template literal, matched character for character against oracle output"). */
function evaluatorSystemPrompt(): string {
	return `You are evaluating a stop-condition hook in pie.
Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.
You cannot call tools. Only use explicit evidence in the transcript.
Your response must be a JSON object with one of these shapes:
{"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
{"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
Always include a reason field, quoting specific text from the transcript whenever possible.
If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.`;
}

/** pie: goal.rs:381-398 (`parse_decision`). Tries the whole trimmed text first; on ANY failure
 * (invalid JSON OR valid-JSON-wrong-shape) falls back to extracting the substring between the
 * first `{` and last `}` and retrying — matches oracle's `.or_else(...)` fallback exactly, e.g.
 * unwrapping a ```` ```json ... ``` ```` fenced response. Exported for the same reason
 * {@link tailChars} is: oracle's own `#[cfg(test)] parses_json_decision_inside_text` tests this
 * pure function directly via same-module private access. */
export function parseDecision(text: string): EvaluatorDecision {
	const trimmed = text.trim();
	let decision = tryParseEvaluatorDecision(trimmed);
	if (!decision) {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start !== -1 && end !== -1 && end >= start) {
			decision = tryParseEvaluatorDecision(trimmed.slice(start, end + 1));
		}
	}
	if (!decision) {
		throw new Error(`goal evaluator returned invalid JSON: ${tailChars(trimmed, 300)}`);
	}
	if (decision.reason.trim().length === 0) {
		throw new Error("goal evaluator returned an empty reason");
	}
	return decision;
}

function tryParseEvaluatorDecision(text: string): EvaluatorDecision | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const record = parsed as Record<string, unknown>;
	if (typeof record.ok !== "boolean" || typeof record.reason !== "string") return undefined;
	return { ok: record.ok, reason: record.reason };
}

/** pie: goal.rs:401-405 (`continuation_prompt`). User-visible text — reproduced verbatim. */
function continuationPrompt(condition: string, reason: string): string {
	return `The current /goal is not satisfied yet.\n\nGoal condition:\n${condition}\n\nGoal evaluator says what is missing or blocking completion:\n${reason}\n\nContinue working toward the goal. Do not claim completion until the transcript contains explicit evidence that satisfies the condition.`;
}

/**
 * pie: goal.rs:407-416 (`tail_chars`). Code-point aware (`Array.from`, matching Rust's
 * `.chars().count()`/`.chars().skip(...)`, NOT UTF-16 code-unit length) — same technique already
 * established by `agent-harness.ts`'s `previewForBanner`/`capControlPlaneAuditLabel`. Exported
 * (GAP fix, same rationale as `agent-harness.ts`'s `evaluatePromotionCondition`): oracle's own
 * `#[cfg(test)]` module tests this directly via same-module private access, an ability a separate
 * TS test file doesn't have without an explicit export.
 */
export function tailChars(text: string, maxChars: number): string {
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	const tail = chars.slice(chars.length - maxChars).join("");
	return `[transcript truncated to last ${maxChars} chars]\n${tail}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `chrono::Utc::now().to_rfc3339()` (goal.rs's timestamp source) renders a `+00:00` UTC offset,
 * not JS `Date.prototype.toISOString()`'s `Z` suffix. Mirrors `triggers/cron.ts`'s own
 * `toRfc3339Offset` helper (same conversion, same rationale) rather than importing it — that one
 * is module-private to cron.ts and this is the only other call site so far; not worth promoting to
 * a shared util for one duplicate. Low-stakes: `updated_at` is an internal, self-consumed
 * timestamp with no wire fixture asserting an exact byte-for-byte format.
 */
function rfc3339Now(): string {
	return toRfc3339Offset(new Date().toISOString());
}

function toRfc3339Offset(iso: string): string {
	if (!iso.endsWith("Z")) return iso;
	const zulu = iso.slice(0, -1);
	const dot = zulu.indexOf(".");
	if (dot === -1) return `${zulu}+00:00`;
	return zulu.slice(dot + 1) === "000" ? `${zulu.slice(0, dot)}+00:00` : `${zulu}+00:00`;
}
