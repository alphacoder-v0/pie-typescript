/**
 * Port of oracle `crates/coding-agent/src/goal.rs`'s `#[cfg(test)] mod tests` (2 tests:
 * `parses_json_decision_inside_text`, `transcript_tail_is_bounded`) plus characterization tests
 * for the behavior the phase-11 task brief calls out explicitly: the evaluator is a SEPARATE
 * no-tool model call (not a reuse of the main turn's own response), the transcript is bounded to
 * the last 40,000 characters, auto-continuation stops at exactly `MAX_CONTINUATIONS` (8), and the
 * state machine's user-visible copy (pause/resume/error text, the continuation prompt, the
 * evaluator system prompt) matches oracle verbatim.
 *
 * Exercises `stopHook`/`current`/`set`/`pause`/`resume`/`clear` against a fake `GoalHarness` (see
 * `../../src/goal-deps.ts`) rather than a real `@pie/agent-core` `AgentHarness` — that's the exact
 * interface goal.ts's own runtime code depends on, and the underlying continuation/evaluator
 * mechanism itself (budget-cap re-check, `runEvaluator`'s `tools: []` isolation, cost/session
 * non-attribution) already has its own dedicated coverage in
 * `packages/agent/test/harness/agent-harness.test.ts`.
 */

import type { AgentMessage } from "@pie/agent-core";
import { EvaluatorError } from "@pie/agent-core";
import { describe, expect, it } from "vitest";
import {
	clear,
	current,
	isGoalActive,
	MAX_CONTINUATIONS,
	parseDecision,
	pause,
	resume,
	set,
	stopHook,
	tailChars,
} from "../../src/goal.ts";
import type { GoalHarness, GoalHarnessCell, GoalHarnessSession, GoalSessionEntry } from "../../src/goal-deps.ts";

interface FakeEvaluatorResponse {
	text?: string;
	error?: unknown;
}

interface CapturedEvaluatorCall {
	systemPrompt: string;
	userPrompt: string;
}

/** In-memory stand-in for `GoalHarness` (see `../../src/goal-deps.ts`'s header comment on why the
 * real `AgentHarness` can't be used directly: no public `session()` accessor yet). */
class FakeGoalHarness implements GoalHarness {
	readonly entries: GoalSessionEntry[] = [];
	readonly capturedEvaluatorCalls: CapturedEvaluatorCall[] = [];
	responses: FakeEvaluatorResponse[] = [];

	session(): GoalHarnessSession {
		return {
			getEntries: async () => this.entries,
			appendCustomEntry: async (customType, data) => {
				this.entries.push({ type: "custom", customType, data });
				return `entry-${this.entries.length}`;
			},
		};
	}

	getModel(): any {
		return { id: "faux-1", provider: "faux", api: "faux" };
	}

	async runEvaluator(
		systemPrompt: string,
		userPrompt: string,
		_model: any,
		_thinkingLevel: any,
		signal: AbortSignal,
	): Promise<{ lastAssistantText: string | undefined }> {
		this.capturedEvaluatorCalls.push({ systemPrompt, userPrompt });
		if (signal.aborted) throw new EvaluatorError("cancelled", "evaluator cancelled");
		const response = this.responses.shift();
		if (!response) throw new Error("FakeGoalHarness: no evaluator response queued");
		if (response.error) throw response.error;
		return { lastAssistantText: response.text };
	}
}

function cellFor(harness: GoalHarness): GoalHarnessCell {
	return { get: () => harness };
}

function decisionJson(ok: boolean, reason: string): string {
	return JSON.stringify({ ok, reason });
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantTextMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}

/* -------------------------------------------------------------------------------------------
 * Oracle #[cfg(test)] mod tests — ported verbatim (goal.rs:419-437).
 * ----------------------------------------------------------------------------------------- */

describe("goal.rs oracle unit tests (ported verbatim)", () => {
	it("parses_json_decision_inside_text", () => {
		const decision = parseDecision('```json\n{"ok":false,"reason":"missing tests"}\n```');
		expect(decision.ok).toBe(false);
		expect(decision.reason).toBe("missing tests");
	});

	it("transcript_tail_is_bounded", () => {
		const text = tailChars("abcdef", 3);
		expect(text).toContain("def");
		expect(text.endsWith("abcdef")).toBe(false);
	});
});

/* -------------------------------------------------------------------------------------------
 * State machine: set / current / pause / resume / clear — user-visible copy asserted verbatim.
 * ----------------------------------------------------------------------------------------- */

describe("goal state machine", () => {
	it("set() creates a pursuing goal at iterations 0 with no last_reason field", async () => {
		const harness = new FakeGoalHarness();
		const state = await set(harness, "create foo.txt");
		expect(state).toMatchObject({ condition: "create foo.txt", status: "pursuing", iterations: 0 });
		expect(state.last_reason).toBeUndefined();
		expect(Object.hasOwn(state, "last_reason")).toBe(false);
		await expect(current(harness)).resolves.toMatchObject({ status: "pursuing", condition: "create foo.txt" });
	});

	it("pause()/resume() round-trip, matching oracle's exact user-facing error text when misused", async () => {
		const harness = new FakeGoalHarness();
		await expect(pause(harness)).rejects.toThrow("no active goal; set one with /goal <condition>");
		await expect(resume(harness)).rejects.toThrow("no paused goal; set one with /goal <condition>");

		await set(harness, "ship the feature");
		const paused = await pause(harness);
		expect(paused.status).toBe("paused");

		await expect(resume(harness)).resolves.toMatchObject({ status: "pursuing" });
		// Resuming an already-pursuing goal is rejected with oracle's other exact error text.
		await expect(resume(harness)).rejects.toThrow("goal is not paused");
	});

	it("clear() on a session with no goal yet is a no-op success, not an error", async () => {
		const harness = new FakeGoalHarness();
		const cleared = await clear(harness);
		expect(cleared).toMatchObject({ condition: "", status: "cleared", iterations: 0 });
		await expect(current(harness)).resolves.toBeUndefined();
	});

	it("current() treats a cleared goal the same as no goal", async () => {
		const harness = new FakeGoalHarness();
		await set(harness, "x");
		await clear(harness);
		await expect(current(harness)).resolves.toBeUndefined();
	});

	it("isGoalActive: pursuing/paused/budget_limited are active; achieved/cleared are not", () => {
		const base = { condition: "x", iterations: 0, updated_at: "now" } as const;
		expect(isGoalActive({ ...base, status: "pursuing" })).toBe(true);
		expect(isGoalActive({ ...base, status: "paused" })).toBe(true);
		expect(isGoalActive({ ...base, status: "budget_limited" })).toBe(true);
		expect(isGoalActive({ ...base, status: "achieved" })).toBe(false);
		expect(isGoalActive({ ...base, status: "cleared" })).toBe(false);
	});
});

/* -------------------------------------------------------------------------------------------
 * stopHook — the OnTurnEndHook that drives /goal's auto-continuation loop.
 * ----------------------------------------------------------------------------------------- */

describe("stopHook", () => {
	it("is Noop when the harness cell was never initialized (before AgentHarness construction completes)", async () => {
		const cell: GoalHarnessCell = { get: () => undefined };
		const hook = stopHook(cell);
		const decision = await hook(
			{ transcript: [], continuationCount: 0, lastUserPrompt: undefined },
			new AbortController().signal,
		);
		expect(decision.action).toEqual({ kind: "pause", reason: "goal hook was not initialized" });
	});

	it("is Noop when there is no active goal", async () => {
		const harness = new FakeGoalHarness();
		const hook = stopHook(cellFor(harness));
		const decision = await hook(
			{ transcript: [], continuationCount: 0, lastUserPrompt: undefined },
			new AbortController().signal,
		);
		expect(decision.action).toEqual({ kind: "noop" });
		expect(harness.capturedEvaluatorCalls).toHaveLength(0);
	});

	it("is Noop for a paused goal — only status 'pursuing' triggers evaluation", async () => {
		const harness = new FakeGoalHarness();
		await set(harness, "x");
		await pause(harness);
		const hook = stopHook(cellFor(harness));
		const decision = await hook(
			{ transcript: [], continuationCount: 0, lastUserPrompt: undefined },
			new AbortController().signal,
		);
		expect(decision.action).toEqual({ kind: "noop" });
		expect(harness.capturedEvaluatorCalls).toHaveLength(0);
	});

	it(
		"runs a SEPARATE no-tool evaluator call per turn (not a reuse of the main turn's own " +
			"response), with the exact system/user prompt text",
		async () => {
			const harness = new FakeGoalHarness();
			await set(harness, "add tests");
			harness.responses.push({ text: decisionJson(true, "tests were added") });
			const hook = stopHook(cellFor(harness));

			await hook(
				{
					transcript: [userMessage("add tests"), assistantTextMessage("I added tests.")],
					continuationCount: 0,
					lastUserPrompt: "add tests",
				},
				new AbortController().signal,
			);

			expect(harness.capturedEvaluatorCalls).toHaveLength(1);
			const call = harness.capturedEvaluatorCalls[0]!;
			expect(call.systemPrompt).toBe(
				"You are evaluating a stop-condition hook in pie.\n" +
					"Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.\n" +
					"You cannot call tools. Only use explicit evidence in the transcript.\n" +
					"Your response must be a JSON object with one of these shapes:\n" +
					'{"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}\n' +
					'{"ok": false, "reason": "<quote what is missing or what blocks the condition>"}\n' +
					"Always include a reason field, quoting specific text from the transcript whenever possible.\n" +
					'If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.',
			);
			expect(call.userPrompt).toBe(
				"Goal condition:\nadd tests\n\nConversation transcript:\nUser: add tests\n\nAssistant: I added tests.",
			);
		},
	);

	it("Stops and marks the goal achieved when the evaluator says ok:true", async () => {
		const harness = new FakeGoalHarness();
		await set(harness, "create foo.txt");
		harness.responses.push({ text: decisionJson(true, "foo.txt exists in the transcript") });
		const hook = stopHook(cellFor(harness));

		const decision = await hook(
			{
				transcript: [userMessage("create foo.txt"), assistantTextMessage("done")],
				continuationCount: 0,
				lastUserPrompt: "create foo.txt",
			},
			new AbortController().signal,
		);

		expect(decision.action).toEqual({ kind: "stop" });
		expect(decision.payload).toMatchObject({
			goal_status: "achieved",
			ok: true,
			reason: "foo.txt exists in the transcript",
		});
		await expect(current(harness)).resolves.toMatchObject({ status: "achieved" });
	});

	it("Continues (auto-continuation) when the evaluator says ok:false, using the exact continuation-prompt copy", async () => {
		const harness = new FakeGoalHarness();
		await set(harness, "create foo.txt");
		harness.responses.push({ text: decisionJson(false, "no evidence foo.txt was created") });
		const hook = stopHook(cellFor(harness));

		const decision = await hook(
			{ transcript: [userMessage("create foo.txt")], continuationCount: 0, lastUserPrompt: "create foo.txt" },
			new AbortController().signal,
		);

		expect(decision.action.kind).toBe("continue");
		if (decision.action.kind === "continue") {
			expect(decision.action.prompt).toBe(
				"The current /goal is not satisfied yet.\n\n" +
					"Goal condition:\ncreate foo.txt\n\n" +
					"Goal evaluator says what is missing or blocking completion:\nno evidence foo.txt was created\n\n" +
					"Continue working toward the goal. Do not claim completion until the transcript contains explicit evidence that satisfies the condition.",
			);
		}
		expect(decision.payload).toMatchObject({ goal_status: "pursuing", ok: false, iterations: 1 });
		await expect(current(harness)).resolves.toMatchObject({ status: "pursuing", iterations: 1 });
	});

	it("auto-continuation stops after exactly MAX_CONTINUATIONS (8) 'not done' verdicts, pausing with oracle's exact copy", async () => {
		expect(MAX_CONTINUATIONS).toBe(8);
		const harness = new FakeGoalHarness();
		await set(harness, "finish the refactor");
		const hook = stopHook(cellFor(harness));
		const ctx = {
			transcript: [userMessage("finish the refactor")],
			continuationCount: 0,
			lastUserPrompt: "finish the refactor",
		};

		for (let i = 1; i < MAX_CONTINUATIONS; i++) {
			harness.responses.push({ text: decisionJson(false, `still missing step ${i}`) });
			const decision = await hook(ctx, new AbortController().signal);
			expect(decision.action.kind).toBe("continue");
			expect(decision.payload).toMatchObject({ goal_status: "pursuing", iterations: i });
		}

		// The 8th "not done" verdict trips the cap instead of continuing an 8th time.
		harness.responses.push({ text: decisionJson(false, "still missing the last step") });
		const finalDecision = await hook(ctx, new AbortController().signal);
		expect(finalDecision.action).toEqual({
			kind: "pause",
			reason: "goal continuation limit reached (8); resume with /goal resume",
		});
		expect(finalDecision.payload).toMatchObject({
			goal_status: "budget_limited",
			iterations: MAX_CONTINUATIONS,
			ok: false,
		});
		await expect(current(harness)).resolves.toMatchObject({
			status: "budget_limited",
			iterations: MAX_CONTINUATIONS,
		});

		// /goal resume is the documented recovery path out of budget_limited.
		const resumed = await resume(harness);
		expect(resumed.status).toBe("pursuing");
	});

	it("bounds the evaluator transcript to the last 40,000 chars (TRANSCRIPT_CHAR_LIMIT)", async () => {
		const harness = new FakeGoalHarness();
		await set(harness, "long task");
		harness.responses.push({ text: decisionJson(false, "not yet") });
		const hook = stopHook(cellFor(harness));

		const longText = "x".repeat(50_000);
		const decision = await hook(
			{ transcript: [assistantTextMessage(longText)], continuationCount: 0, lastUserPrompt: undefined },
			new AbortController().signal,
		);

		expect(decision.action.kind).toBe("continue");
		const call = harness.capturedEvaluatorCalls[0];
		expect(call).toBeDefined();
		expect(call!.userPrompt).toContain("[transcript truncated to last 40000 chars]");
		expect(call!.userPrompt.endsWith("x".repeat(200))).toBe(true);
	});

	it("does NOT truncate a transcript at or under the 40,000-char limit", async () => {
		const harness = new FakeGoalHarness();
		await set(harness, "short task");
		harness.responses.push({ text: decisionJson(true, "done") });
		const hook = stopHook(cellFor(harness));

		const shortText = "y".repeat(100);
		const decision = await hook(
			{ transcript: [assistantTextMessage(shortText)], continuationCount: 0, lastUserPrompt: undefined },
			new AbortController().signal,
		);

		expect(decision.action.kind).toBe("stop");
		const call = harness.capturedEvaluatorCalls[0];
		expect(call!.userPrompt).not.toContain("truncated");
		expect(call!.userPrompt).toContain(`Assistant: ${shortText}`);
	});

	it("pauses (not stops/continues) when the evaluator is cancelled, with oracle's exact reason text", async () => {
		const harness = new FakeGoalHarness();
		await set(harness, "x");
		const hook = stopHook(cellFor(harness));
		const controller = new AbortController();
		controller.abort();

		const decision = await hook(
			{ transcript: [], continuationCount: 0, lastUserPrompt: undefined },
			controller.signal,
		);

		expect(decision.action).toEqual({ kind: "pause", reason: "goal evaluator cancelled" });
		await expect(current(harness)).resolves.toMatchObject({
			status: "paused",
			last_reason: "goal evaluator cancelled",
		});
	});

	it("pauses when the evaluator returns no assistant text", async () => {
		const harness = new FakeGoalHarness();
		await set(harness, "x");
		harness.responses.push({ text: undefined });
		const hook = stopHook(cellFor(harness));

		const decision = await hook(
			{ transcript: [], continuationCount: 0, lastUserPrompt: undefined },
			new AbortController().signal,
		);

		expect(decision.action).toEqual({ kind: "pause", reason: "goal evaluator returned no text" });
	});

	it("pauses when the evaluator returns unparseable JSON, embedding a capped snippet in the reason", async () => {
		const harness = new FakeGoalHarness();
		await set(harness, "x");
		harness.responses.push({ text: "not json at all" });
		const hook = stopHook(cellFor(harness));

		const decision = await hook(
			{ transcript: [], continuationCount: 0, lastUserPrompt: undefined },
			new AbortController().signal,
		);

		expect(decision.action).toEqual({
			kind: "pause",
			reason: "goal evaluator failed: goal evaluator returned invalid JSON: not json at all",
		});
	});

	it("pauses when the underlying evaluator run throws", async () => {
		const harness = new FakeGoalHarness();
		await set(harness, "x");
		harness.responses.push({ error: new Error("provider exploded") });
		const hook = stopHook(cellFor(harness));

		const decision = await hook(
			{ transcript: [], continuationCount: 0, lastUserPrompt: undefined },
			new AbortController().signal,
		);

		expect(decision.action).toEqual({ kind: "pause", reason: "goal evaluator failed: provider exploded" });
	});
});
