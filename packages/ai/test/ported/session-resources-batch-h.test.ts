/**
 * phase 21, closing coverage in the high tier — behavioral evidence for
 * `ai/src/session-resources.ts`.
 *
 * `cleanupSessionResources` lands in the **high** tier of the phase 7 layering, matched by the
 * `credential` rule, yet no test anywhere referenced it — the only one of the 45 high-tier functions
 * with genuinely no behavioral coverage.
 *
 * ## The upstream basis, which runs the opposite way from the other new tests
 *
 * ```rust
 * // oracle crates/ai/src/session_resources.rs:1-8
 * //! Pooled resource cleanup between sessions. 1:1 stub of
 * //! `packages/ai/src/session-resources.ts`. Closes pooled HTTP clients, drops OAuth refresh
 * //! timers, etc.
 * pub fn cleanup_session_resources() {
 *     // TODO: when we add pooled reqwest clients / OAuth refresh tasks, tear them down here.
 * }
 * ```
 *
 * Upstream is an **empty stub**, and its own doc comment describes itself as a 1:1 stub of
 * `packages/ai/src/session-resources.ts` — **upstream copied the TypeScript**, not the other way
 * round. So there is no upstream assertion to copy; the only contract available is what this
 * implementation itself promises:
 *
 *   1. every registered cleanup callback runs, and receives the `sessionId`
 *   2. the value `registerSessionResourceCleanup` returns can unregister it
 *   3. one callback throwing **does not stop** the rest, and the failures are collected into an
 *      `AggregateError`
 *
 * The third is where this function carries weight: if one provider's cleanup throwing broke the
 * chain on a session switch, the HTTP connection pools and OAuth timers behind it would leak, while
 * the user saw only one error message.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanupSessionResources, registerSessionResourceCleanup } from "../../src/session-resources.ts";

describe("cleanupSessionResources (ai/src/session_resources.rs)", () => {
	const unregisters: (() => void)[] = [];

	afterEach(() => {
		// The registry is module-level; leaving it dirty pollutes other tests in the same process.
		for (const off of unregisters.splice(0)) off();
	});

	function register(fn: (sessionId?: string) => void) {
		const off = registerSessionResourceCleanup(fn);
		unregisters.push(off);
		return off;
	}

	it("calls every registered cleanup with the session id", () => {
		const seen: (string | undefined)[] = [];
		register((id) => seen.push(id));
		register((id) => seen.push(id));

		cleanupSessionResources("sess-1");

		expect(seen).toEqual(["sess-1", "sess-1"]);
	});

	it("the returned unregister actually removes the callback", () => {
		const seen: string[] = [];
		const off = register(() => seen.push("a"));
		register(() => seen.push("b"));

		off();
		cleanupSessionResources("sess-2");

		expect(seen, "after unregistering, a must not be called again").toEqual(["b"]);
	});

	it("one throwing cleanup does not stop the rest; failures aggregate", () => {
		// This is the point. If one provider's cleanup throwing broke the chain on a session switch, the
		// HTTP connection pools and OAuth timers behind it would all leak, while the user saw one error
		// message. The leak itself is silent.
		const seen: string[] = [];
		register(() => {
			seen.push("first");
			throw new Error("first failed");
		});
		register(() => seen.push("second"));
		register(() => {
			seen.push("third");
			throw new Error("third failed");
		});

		let caught: unknown;
		try {
			cleanupSessionResources("sess-3");
		} catch (error) {
			caught = error;
		}

		expect(seen, "callbacks after the throwing one still have to run").toEqual(["first", "second", "third"]);
		expect(caught).toBeInstanceOf(AggregateError);
		expect((caught as AggregateError).errors).toHaveLength(2);
		expect((caught as AggregateError).message).toBe("Failed to cleanup session resources");
	});

	it("is a no-op when nothing is registered", () => {
		// The upstream stub is an empty function; with an empty registry this side likewise has to do
		// nothing and throw nothing.
		expect(() => cleanupSessionResources()).not.toThrow();
	});
});
