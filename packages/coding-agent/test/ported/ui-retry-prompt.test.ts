/**
 * Tests for the port of oracle `crates/coding-agent/src/agent_session.rs:85-217` — the auto-retry
 * wrapper the no-image `user_prompt_turn` runs inside (`ui/kernel.rs:121-124`).
 *
 * Oracle carries no `#[cfg(test)]` module in `agent_session.rs`; these are net-new and each `it()`
 * names the oracle line range it pins. The sibling suites
 * (`test/agent-session-retry.test.ts`, `test/ported/agent-session-retry-rewind.test.ts`) cover pi's
 * *other* `AgentSession` — the `AgentSessionConfig`-built class — which cannot wrap a bare
 * `AgentHarness` and therefore never exercises this path.
 */

import type { AssistantMessage, Model } from "@pie/ai";
import { describe, expect, it } from "vitest";
import { ReplKernel } from "../../src/ui/kernel.ts";
import {
	assistantErrorMessage,
	defaultRetryPolicy,
	promptWithRetry,
	type RetryHarness,
	type RetryPolicy,
	type RetrySession,
	retryPolicyFrom,
	rewindFailedAssistant,
} from "../../src/ui/retry-prompt.ts";

/* ── stubs ──────────────────────────────────────────────────────────────────────────────── */

function assistant(overrides: Record<string, unknown> = {}): AssistantMessage {
	return { role: "assistant", content: [], stopReason: "stop", ...overrides } as unknown as AssistantMessage;
}

interface StubSession extends RetrySession {
	movedTo: (string | null)[];
}

function stubSession(entries: Record<string, unknown> = {}, leaf: string | null = null): StubSession {
	const movedTo: (string | null)[] = [];
	return {
		movedTo,
		getLeafId: async () => leaf,
		getEntry: async (id: string) => entries[id] as never,
		moveTo: async (entryId) => {
			movedTo.push(entryId);
			return undefined;
		},
	};
}

interface StubHarness extends RetryHarness {
	calls: string[];
	models: Model<any>[];
	session(): StubSession;
}

/** `outcomes` is consumed one per attempt; an `Error` is thrown, an `AssistantMessage` resolved. */
function stubHarness(outcomes: (AssistantMessage | Error)[], session = stubSession()): StubHarness {
	const calls: string[] = [];
	const models: Model<any>[] = [];
	let index = 0;
	const next = async (label: string): Promise<AssistantMessage> => {
		calls.push(label);
		const outcome = outcomes[index++] ?? assistant();
		if (outcome instanceof Error) throw outcome;
		return outcome;
	};
	return {
		calls,
		models,
		prompt: (text) => next(`prompt:${text}`),
		continue: () => next("continue"),
		setModel: async (model) => {
			models.push(model);
		},
		session: () => session,
	};
}

const NO_WAIT = { sleep: async (): Promise<void> => {} };

const FAST: RetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 4 };

/* ── settings ───────────────────────────────────────────────────────────────────────────── */

describe("RetrySettings — agent_session.rs:25-47", () => {
	it("defaults are oracle's shipped literals (agent_session.rs:36-47)", () => {
		// `main.rs:861` always builds `RetrySettings::default()`, so these ARE the behavior.
		expect(defaultRetryPolicy()).toEqual({
			enabled: true,
			maxRetries: 5,
			baseDelayMs: 1000,
			maxDelayMs: 60_000,
			fallbackModel: undefined,
		});
	});

	it("widens this repo's RetrySettings by filling the cap oracle hardcodes", () => {
		expect(retryPolicyFrom({ maxRetries: 1 })).toEqual({
			enabled: true,
			maxRetries: 1,
			baseDelayMs: 1000,
			maxDelayMs: 60_000,
			fallbackModel: undefined,
		});
	});
});

/* ── classification ─────────────────────────────────────────────────────────────────────── */

describe("assistant_error_message — agent_session.rs:159-170", () => {
	it("is undefined for a healthy assistant", () => {
		expect(assistantErrorMessage(assistant())).toBeUndefined();
		expect(assistantErrorMessage(undefined)).toBeUndefined();
	});

	it("returns the error message when the turn stopped with an error", () => {
		expect(assistantErrorMessage(assistant({ stopReason: "error", errorMessage: "overloaded" }))).toBe("overloaded");
	});

	it("substitutes oracle's literal when the error carries no message (agent_session.rs:166-168)", () => {
		expect(assistantErrorMessage(assistant({ stopReason: "error" }))).toBe("assistant stopped with an error");
	});
});

/* ── the loop ───────────────────────────────────────────────────────────────────────────── */

describe("AgentSession::prompt — agent_session.rs:85-150", () => {
	it("returns after one prompt when the turn succeeds (agent_session.rs:90-100)", async () => {
		const harness = stubHarness([assistant()]);
		await promptWithRetry(harness, FAST, "hello", NO_WAIT);
		expect(harness.calls).toEqual(["prompt:hello"]);
	});

	it("retries with continue(), not prompt(), so the turn resumes (agent_session.rs:90-95)", async () => {
		const harness = stubHarness([new Error("overloaded_error"), assistant()]);
		await promptWithRetry(harness, FAST, "hello", NO_WAIT);
		expect(harness.calls).toEqual(["prompt:hello", "continue"]);
	});

	it("re-examines a RESOLVED call that carried an error assistant (agent_session.rs:97-100)", async () => {
		// The provider encoded the failure in the stream, so `prompt()` resolved — oracle still
		// classifies it through the retry policy.
		const harness = stubHarness([assistant({ stopReason: "error", errorMessage: "rate limit" }), assistant()]);
		await promptWithRetry(harness, FAST, "hi", NO_WAIT);
		expect(harness.calls).toEqual(["prompt:hi", "continue"]);
	});

	it("does not retry a NON-retryable error (agent_session.rs:110-112)", async () => {
		const harness = stubHarness([new Error("invalid api key")]);
		await expect(promptWithRetry(harness, FAST, "hi", NO_WAIT)).rejects.toThrow("invalid api key");
		expect(harness.calls).toEqual(["prompt:hi"]);
	});

	it("does not retry at all when the policy is disabled (agent_session.rs:106-108)", async () => {
		const harness = stubHarness([new Error("overloaded")]);
		await expect(promptWithRetry(harness, { ...FAST, enabled: false }, "hi", NO_WAIT)).rejects.toThrow("overloaded");
		expect(harness.calls).toEqual(["prompt:hi"]);
	});

	it("gives up after max_retries and surfaces the LAST error (agent_session.rs:114-133)", async () => {
		const harness = stubHarness([new Error("overloaded 1"), new Error("overloaded 2"), new Error("overloaded 3")]);
		await expect(promptWithRetry(harness, FAST, "hi", NO_WAIT)).rejects.toThrow("overloaded 3");
		// attempt 0 (prompt) + two retries (continue) = maxRetries of 2.
		expect(harness.calls).toEqual(["prompt:hi", "continue", "continue"]);
	});

	it("backs off exponentially, capped (agent_session.rs:135-142 + :213-217)", async () => {
		const waits: number[] = [];
		const harness = stubHarness([
			new Error("overloaded"),
			new Error("overloaded"),
			new Error("overloaded"),
			new Error("overloaded"),
			assistant(),
		]);
		await promptWithRetry(harness, { enabled: true, maxRetries: 5, baseDelayMs: 100, maxDelayMs: 250 }, "hi", {
			sleep: async (ms) => void waits.push(ms),
		});
		// 100 * 2^0, 2^1, 2^2 then clamped at maxDelayMs.
		expect(waits).toEqual([100, 200, 250, 250]);
	});

	it("rewinds the failed assistant before each retry (agent_session.rs:144-146)", async () => {
		const session = stubSession(
			{ leaf: { type: "message", parentId: "parent", message: { role: "assistant", stopReason: "error" } } },
			"leaf",
		);
		const harness = stubHarness([new Error("overloaded"), assistant()], session);
		await promptWithRetry(harness, FAST, "hi", NO_WAIT);
		expect(session.movedTo).toEqual(["parent"]);
	});

	it("swaps to the fallback model exactly once, then restarts at attempt 0 (agent_session.rs:114-133)", async () => {
		const fallback = { provider: "anthropic", id: "claude-haiku-4-5" } as unknown as Model<any>;
		const harness = stubHarness([
			new Error("overloaded a"),
			new Error("overloaded b"),
			new Error("overloaded c"),
			// after the swap, attempt resets to 0 → a fresh `prompt(text)`
			assistant(),
		]);
		await promptWithRetry(harness, { ...FAST, fallbackModel: ["anthropic", "claude-haiku-4-5"] }, "hi", {
			...NO_WAIT,
			findModel: () => fallback,
		});
		expect(harness.models).toEqual([fallback]);
		expect(harness.calls).toEqual(["prompt:hi", "continue", "continue", "prompt:hi"]);
	});

	it("reports a distinct message when the fallback swap itself fails (agent_session.rs:125-128)", async () => {
		const harness = stubHarness([new Error("overloaded a"), new Error("overloaded b"), new Error("overloaded c")]);
		harness.setModel = async () => {
			throw new Error("model registry offline");
		};
		await expect(
			promptWithRetry(harness, { ...FAST, fallbackModel: ["x", "y"] }, "hi", {
				...NO_WAIT,
				findModel: () => ({}) as Model<any>,
			}),
		).rejects.toThrow("fallback set_model failed: model registry offline");
	});

	it("falls through to the original error when the fallback model is unknown", async () => {
		const harness = stubHarness([new Error("overloaded a"), new Error("overloaded b"), new Error("overloaded c")]);
		await expect(
			promptWithRetry(harness, { ...FAST, fallbackModel: ["nope", "nope"] }, "hi", {
				...NO_WAIT,
				findModel: () => undefined,
			}),
		).rejects.toThrow("overloaded c");
		expect(harness.models).toEqual([]);
	});
});

/* ── rewind ─────────────────────────────────────────────────────────────────────────────── */

describe("rewind_failed_assistant — agent_session.rs:172-210", () => {
	it("is a no-op when there is no leaf (agent_session.rs:186-190)", async () => {
		const session = stubSession({}, null);
		await rewindFailedAssistant(session);
		expect(session.movedTo).toEqual([]);
	});

	it("is a no-op when the leaf is not a message entry (agent_session.rs:192-201)", async () => {
		const session = stubSession({ leaf: { type: "custom" } }, "leaf");
		await rewindFailedAssistant(session);
		expect(session.movedTo).toEqual([]);
	});

	it("is a no-op when the leaf assistant did NOT fail (agent_session.rs:203)", async () => {
		const session = stubSession(
			{ leaf: { type: "message", parentId: "p", message: { role: "assistant", stopReason: "stop" } } },
			"leaf",
		);
		await rewindFailedAssistant(session);
		expect(session.movedTo).toEqual([]);
	});

	it("moves to null when the failed entry is the root (agent_session.rs:204-208 `as_deref`)", async () => {
		const session = stubSession(
			{ leaf: { type: "message", parentId: null, message: { role: "assistant", stopReason: "error" } } },
			"leaf",
		);
		await rewindFailedAssistant(session);
		expect(session.movedTo).toEqual([null]);
	});

	it("wraps a leaf-lookup failure in oracle's context string (agent_session.rs:186-190)", async () => {
		const session: RetrySession = {
			getLeafId: async () => {
				throw new Error("disk gone");
			},
			getEntry: async () => undefined,
			moveTo: async () => undefined,
		};
		await expect(rewindFailedAssistant(session)).rejects.toThrow("session retry leaf lookup: disk gone");
	});

	it("wraps a rewind failure in oracle's context string (agent_session.rs:204-208)", async () => {
		const session: RetrySession = {
			getLeafId: async () => "leaf",
			getEntry: async () =>
				({ type: "message", parentId: "p", message: { role: "assistant", stopReason: "error" } }) as never,
			moveTo: async () => {
				throw new Error("branch locked");
			},
		};
		await expect(rewindFailedAssistant(session)).rejects.toThrow("session retry rewind: branch locked");
	});
});

/* ── the kernel seam ────────────────────────────────────────────────────────────────────── */

describe("ReplKernel.setUserPromptRunner — kernel.rs:106-127", () => {
	function kernelHarness(calls: string[]) {
		return {
			async prompt(text: string, options?: { images?: unknown[] }) {
				calls.push(options?.images === undefined ? `prompt:${text}` : `promptWithImages:${text}`);
				return undefined;
			},
			getModel: () => ({ input: ["text", "image"] }),
		} as never;
	}

	it("routes the NO-IMAGE branch through the installed retry wrapper", async () => {
		const calls: string[] = [];
		const kernel = new ReplKernel(kernelHarness(calls), {});
		kernel.setUserPromptRunner(async (text) => {
			calls.push(`retryWrapper:${text}`);
		});
		await kernel.userPromptTurn("hello", []);
		expect(calls).toEqual(["retryWrapper:hello"]);
	});

	it("leaves the HAS-IMAGE branch un-retried, exactly as oracle does (kernel.rs:116-119)", async () => {
		const calls: string[] = [];
		const kernel = new ReplKernel(kernelHarness(calls), {});
		kernel.setUserPromptRunner(async (text) => {
			calls.push(`retryWrapper:${text}`);
		});
		await kernel.userPromptTurn("look", [{ type: "image" } as never]);
		expect(calls).toEqual(["promptWithImages:look"]);
	});

	it("degrades to a single bare prompt when no wrapper is installed", async () => {
		const calls: string[] = [];
		const kernel = new ReplKernel(kernelHarness(calls), {});
		await kernel.userPromptTurn("hello", []);
		expect(calls).toEqual(["prompt:hello"]);
	});

	it("keeps isStreaming() true across a retried turn, so a triggered turn still defers", async () => {
		const calls: string[] = [];
		const kernel = new ReplKernel(kernelHarness(calls), {});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		kernel.setUserPromptRunner(async () => {
			await gate;
		});
		const turn = kernel.userPromptTurn("hello", []);
		// pie: ui/mod.rs:1010-1013 reads this to decide whether to skip the triggered turn.
		expect(kernel.isStreaming()).toBe(true);
		release();
		await turn;
		expect(kernel.isStreaming()).toBe(false);
	});
});
