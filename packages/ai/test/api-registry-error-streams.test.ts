// Locks in a bug-for-bug divergence ported from the oracle registry, crates/ai/src/api_registry.rs
// — see migration/reviews/ai/divergence-ledger.tsv unit ai/api_registry.
//
// RegisteredHandle::stream/stream_simple (oracle:117-124, 128-141) return error_stream(...) for
// the api-mismatch guard, not a throw ("Mismatched api: X expected Y", oracle:119-123, 135-139).
// Oracle's own doc comment: "Per the TS contract, providers must encode failures in the returned
// stream rather than throw — same applies to the registry-level guard." wrapStream/wrapStreamSimple
// previously threw synchronously here; this test locks in the error-stream behavior instead.
// Mirrors oracle's own dedicated test captured_handle_still_returns_mismatch_error_stream
// (crates/ai/src/api_registry.rs:314-334), which had no TS counterpart before this file.
import { afterEach, describe, expect, it } from "vitest";
import { clearApiProviders, getApiProvider, registerApiProvider } from "../src/api-registry.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const TEST_API = "test-registry-error-api";

function testModel(api: string) {
	return {
		id: "m1",
		name: "Test Model",
		api: api as never,
		provider: "test-provider",
		baseUrl: "",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function doneStream(): AssistantMessageEventStream {
	const s = new AssistantMessageEventStream();
	s.push({
		type: "done",
		reason: "stop",
		message: {
			role: "assistant",
			content: [],
			api: TEST_API,
			provider: "test-provider",
			model: "m1",
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
		},
	});
	return s;
}

afterEach(() => {
	clearApiProviders();
});

describe("api-registry error streams (bug-for-bug: oracle api_registry.rs error_stream)", () => {
	it("returns an error-stream event (not a throw) when a captured handle is invoked with a mismatched model.api", async () => {
		registerApiProvider({
			api: TEST_API as never,
			stream: () => doneStream(),
			streamSimple: () => doneStream(),
		});

		const handle = getApiProvider(TEST_API as never);
		expect(handle).toBeDefined();

		// Same pattern as oracle's captured_handle_still_returns_mismatch_error_stream test: the
		// handle was looked up for TEST_API, but the model passed in claims a different api.
		expect(() => handle!.stream(testModel("other-api"), { messages: [] })).not.toThrow();

		const s = handle!.stream(testModel("other-api"), { messages: [] });
		const events = [];
		for await (const event of s) {
			events.push(event);
		}
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "error",
			reason: "error",
			error: { stopReason: "error", errorMessage: `Mismatched api: other-api expected ${TEST_API}` },
		});
	});

	it("streamSimple returns the same error-stream shape for a mismatched model.api", async () => {
		registerApiProvider({
			api: TEST_API as never,
			stream: () => doneStream(),
			streamSimple: () => doneStream(),
		});

		const handle = getApiProvider(TEST_API as never);
		const s = handle!.streamSimple(testModel("other-api"), { messages: [] });
		const result = await s.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(`Mismatched api: other-api expected ${TEST_API}`);
	});
});
