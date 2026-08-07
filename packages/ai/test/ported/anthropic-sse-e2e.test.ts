// Ported from oracle crates/ai/tests/anthropic_sse_e2e.rs (manifest unit ai/tests/anthropic_sse_e2e).
//
// Oracle's own header: "End-to-end test of the Anthropic provider's HTTP -> SSE -> event
// pipeline against a local mock server. ... This exercises the same SSE machinery every
// provider shares, so a regression here would also affect OpenAI Responses / Completions."
//
// Ported through stream() (packages/ai/src/stream.ts, this batch's unit) end-to-end via the real
// registered "anthropic-messages" provider, using the same fake-Anthropic-SDK-client injection
// point already established by test/anthropic-sse-parsing.test.ts (AnthropicOptions.client) rather
// than a raw TCP listener like the oracle test: base's Anthropic provider talks over the official
// @anthropic-ai/sdk client (not a hand-rolled reqwest+SSE stack), so a literal socket port would
// only be testing third-party SDK internals, not pie-ported behavior.
//
// Intentionally NOT ported: oracle's `retries_on_503_then_succeeds`,
// `abort_cancels_retry_sleep_before_second_request`, `abort_cancels_pending_sse_drain`. Those
// exercise pie's hand-rolled retry/reqwest-cancellation stack; retry.ts is out of scope for this
// batch (RULEBOOK: retry.ts pilot behavior must not be touched) and the equivalent guarantees are
// already locked in by test/retry.test.ts ("aborts promptly via AbortSignal instead of completing
// the retry backoff") and test/abort.test.ts's per-provider abort coverage.
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../../src/models.ts";
import { stream } from "../../src/stream.ts";
import type { Context, StopReason } from "../../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

const model = getModel("anthropic", "claude-haiku-4-5");

function userContext(text: string): Context {
	return { messages: [{ role: "user", content: text, timestamp: 0 }] };
}

describe("anthropic SSE e2e (ported: shared SSE machinery via stream())", () => {
	it("text_stream_produces_ordered_events: Start -> TextStart -> TextDelta* -> TextEnd -> Done", async () => {
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Hello" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: " world" },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 2 },
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const s = stream(model, userContext("hi"), { apiKey: "test-key", client: createFakeAnthropicClient(response) });
		const kinds: string[] = [];
		let text = "";
		let finalMessage: Awaited<ReturnType<typeof s.result>> | undefined;
		for await (const event of s) {
			kinds.push(event.type);
			if (event.type === "text_delta") text += event.delta;
			if (event.type === "done") finalMessage = event.message;
			if (event.type === "error") throw new Error(`unexpected error: ${event.error.errorMessage}`);
		}

		expect(text).toBe("Hello world");
		expect(kinds[0]).toBe("start");
		expect(kinds.at(-1)).toBe("done");
		const startIdx = kinds.indexOf("text_start");
		const deltaIdx = kinds.indexOf("text_delta");
		const endIdx = kinds.indexOf("text_end");
		expect(startIdx).toBeLessThan(deltaIdx);
		expect(deltaIdx).toBeLessThan(endIdx);

		expect(finalMessage).toBeDefined();
		expect(finalMessage!.usage.input).toBe(10);
		expect(finalMessage!.usage.output).toBe(2);
		expect(finalMessage!.responseId).toBe("msg_1");
	});

	it("tool_use_sets_tooluse_stop_reason", async () => {
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: { id: "msg_2", usage: { input_tokens: 5, output_tokens: 0 } },
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"city":' },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '"sf"}' },
				}),
			},
			{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: { output_tokens: 8 },
				}),
			},
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const s = stream(model, userContext("weather?"), {
			apiKey: "test-key",
			client: createFakeAnthropicClient(response),
		});
		let sawToolStart = false;
		let toolEndArgs: Record<string, unknown> | undefined;
		let doneReason: Extract<StopReason, "stop" | "length" | "toolUse"> | undefined;
		let doneArgs: Record<string, unknown> | undefined;
		for await (const event of s) {
			if (event.type === "toolcall_start") sawToolStart = true;
			if (event.type === "toolcall_end") toolEndArgs = event.toolCall.arguments;
			if (event.type === "done") {
				doneReason = event.reason;
				doneArgs = event.message.content.find((block) => block.type === "toolCall")?.arguments;
			}
			if (event.type === "error") throw new Error(`unexpected error: ${event.error.errorMessage}`);
		}

		expect(sawToolStart).toBe(true);
		expect(toolEndArgs?.city).toBe("sf");
		expect(doneArgs?.city).toBe("sf");
		expect(doneReason).toBe("toolUse");
	});

	// TODO(port): base's iterateAnthropicEvents (src/providers/anthropic.ts:399-401) does
	// `throw new Error(sse.data)` for an SSE `event: error` frame — the raw, unparsed SSE data
	// string becomes the thrown Error's message. Oracle's anthropic.rs:358-371 instead parses the
	// JSON payload and extracts `/error/message` (falling back to "anthropic error"), matching this
	// test's expectation of a clean "overloaded" string. This is a genuine base-pi discrepancy from
	// oracle discovered while porting this char-test, not an oracle bug to replicate — but
	// anthropic.ts is out of this batch's scope (RULEBOOK: batch-A providers, another agent's
	// territory). Skipped rather than silently asserting the current (wrong) raw-JSON value as if
	// it were correct; flagged in the batch-B report for the anthropic.ts owner.
	it.skip("http_error_becomes_error_event", async () => {
		const response = createSseResponse([
			{ event: "error", data: JSON.stringify({ type: "error", error: { message: "overloaded" } }) },
		]);

		const s = stream(model, userContext("hi"), { apiKey: "test-key", client: createFakeAnthropicClient(response) });
		let errorMessage: string | undefined;
		for await (const event of s) {
			if (event.type === "error") errorMessage = event.error.errorMessage;
		}

		expect(errorMessage).toBe("overloaded");
	});
});
