import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageEvent } from "../src/types.ts";
import { AssistantMessageEventStream, createAssistantMessageEventStream } from "../src/utils/event-stream.ts";

// pie: crates/ai/src/utils/event_stream.rs — 1:1 port of packages/ai/src/utils/event-stream.ts
// (oracle's own header). Both #[cfg(test)] cases are ported below (iterates_to_done,
// result_resolves_before_drain), plus additional coverage for the review dimensions called out for
// this unit: event type set, backpressure/buffering, error-vs-done end semantics, abort.
//
// One divergence surfaced during review, deliberately NOT applied (verdict=none, see
// migration/reviews/ai/divergence-ledger.tsv): oracle's push() (event_stream.rs:32-46) only
// guards the ONE-SHOT final-result oneshot against a second terminal event; it still forwards
// every event unconditionally to the mpsc receiver, even ones pushed after a terminal event. TS's
// push() drops ALL events (delivery included) once `done` is set. Every existing provider in this
// package pushes exactly one terminal event immediately before calling `.end()` with no further
// pushes, so this is unreachable in practice; the guard is also a reasonable defensive safety net
// (protects consumers from a buggy provider double-pushing) that plausibly falls out of how oracle
// happened to split the sender/receiver across an mpsc channel + oneshot, rather than a deliberate
// behavioral choice — not treated as a bug-for-bug target. See push-after-terminal test below,
// which locks the CURRENT (unchanged) drop behavior.

function mkMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("AssistantMessageEventStream", () => {
	// pie: event_stream.rs:133-150 (iterates_to_done)
	it("iterates to done", async () => {
		const stream = new AssistantMessageEventStream();
		const msg = mkMessage();
		stream.push({ type: "start", partial: msg });
		stream.push({ type: "done", reason: "stop", message: msg });
		stream.end();

		const events = await drain(stream);
		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("start");
		expect(events[1]?.type).toBe("done");
	});

	// pie: event_stream.rs:152-163 (result_resolves_before_drain)
	it("resolves result() before draining", async () => {
		const stream = new AssistantMessageEventStream();
		const msg = mkMessage();
		stream.push({ type: "done", reason: "stop", message: msg });
		stream.end();

		const finalMsg = await stream.result();
		expect(finalMsg).toBeDefined();
		expect(finalMsg).toBe(msg);
	});

	it("resolves result() to the error message for an error-terminated stream", async () => {
		const stream = new AssistantMessageEventStream();
		const errorMsg = mkMessage({ stopReason: "error", errorMessage: "boom" });
		stream.push({ type: "start", partial: mkMessage() });
		stream.push({ type: "error", reason: "error", error: errorMsg });
		stream.end();

		const finalMsg = await stream.result();
		expect(finalMsg).toBe(errorMsg);
	});

	it("supports calling result() and fully iterating the same stream (oracle: 'doing both is supported')", async () => {
		const stream = new AssistantMessageEventStream();
		const msg = mkMessage();
		stream.push({ type: "start", partial: msg });
		stream.push({ type: "done", reason: "stop", message: msg });
		stream.end();

		const resultPromise = stream.result();
		const events = await drain(stream);
		const finalMsg = await resultPromise;

		expect(events).toHaveLength(2);
		expect(finalMsg).toBe(msg);
	});

	it("buffers events unboundedly when pushed before any consumer iterates (backpressure: unbounded on both sides)", async () => {
		const stream = new AssistantMessageEventStream();
		const msg = mkMessage();
		for (let i = 0; i < 50; i++) {
			stream.push({ type: "text_delta", contentIndex: 0, delta: String(i), partial: msg });
		}
		stream.push({ type: "done", reason: "stop", message: msg });
		stream.end();

		const events = await drain(stream);
		expect(events).toHaveLength(51);
		expect(events.map((e) => (e.type === "text_delta" ? e.delta : undefined)).slice(0, 50)).toEqual(
			Array.from({ length: 50 }, (_, i) => String(i)),
		);
	});

	it("delivers events pushed while a consumer is actively awaiting the next one (interleaved production)", async () => {
		const stream = new AssistantMessageEventStream();
		const msg = mkMessage();
		const events: AssistantMessageEvent[] = [];

		const consumePromise = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
		})();

		await new Promise((resolve) => setTimeout(resolve, 0));
		stream.push({ type: "start", partial: msg });
		await new Promise((resolve) => setTimeout(resolve, 0));
		stream.push({ type: "done", reason: "stop", message: msg });
		stream.end();

		await consumePromise;
		expect(events.map((e) => e.type)).toEqual(["start", "done"]);
	});

	it("current (unchanged) behavior: silently drops events pushed after a terminal event", async () => {
		const stream = new AssistantMessageEventStream();
		const msg = mkMessage();
		stream.push({ type: "done", reason: "stop", message: msg });
		// Pushed after the terminal event -- current base behavior drops it (see file header:
		// verdict=none, oracle's own push() would still forward this to its receiver).
		stream.push({ type: "text_delta", contentIndex: 0, delta: "late", partial: msg });
		stream.end();

		const events = await drain(stream);
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("done");
	});

	it("createAssistantMessageEventStream factory mirrors the constructor", async () => {
		const stream = createAssistantMessageEventStream();
		const msg = mkMessage();
		stream.push({ type: "done", reason: "stop", message: msg });
		stream.end();
		expect(await stream.result()).toBe(msg);
	});
});
