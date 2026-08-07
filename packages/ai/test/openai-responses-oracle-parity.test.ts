/**
 * Vitest port of the 8 Rust unit tests in `crates/ai/src/providers/openai_responses.rs`'s
 * `#[cfg(test)] mod tests`, plus a couple of bonus tests locking in additional divergences found
 * while cross-checking the two sides (stop-reason mapping). Oracle test -> vitest test map:
 *
 *   url_does_not_double_v1                          -> describe("base URL normalization")
 *   body_includes_system_prompt                     -> "includes the system prompt as the first input item"
 *   long_retention_sets_24h_and_cache_key            -> "sets prompt_cache_retention 24h and prompt_cache_key for long retention"
 *   reasoning_block_emitted_when_effort_set          -> "emits a reasoning block when reasoning effort is set"
 *   thinking_replayed_as_reasoning_item_when_compat_requires -> "replays thinking as a reasoning item when compat requires it"
 *   thinking_dropped_without_compat_flag             -> "drops thinking content when the compat flag is not set"
 *   usage_reads_cached_and_cache_write_tokens        -> describe("usage accounting (PORT-DIVERGENCE: B1)")
 *   tool_call_serializes_as_function_call            -> "serializes a tool call as a function_call item"
 */
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import { convertResponsesMessages, processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

// pie: crates/ai/src/providers/openai_responses.rs:829-845 (mk_model)
function buildModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...overrides,
	};
}

function buildOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
	};
}

async function* eventsOf(...events: unknown[]): AsyncGenerator<ResponseStreamEvent> {
	for (const event of events) {
		yield event as ResponseStreamEvent;
	}
}

async function captureRequest(
	model: Model<"openai-responses">,
	context: Context,
	options: Parameters<typeof streamOpenAIResponses>[2] = {},
): Promise<{ url: string; payload: unknown }> {
	let capturedUrl = "";
	let capturedPayload: unknown;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		capturedUrl = typeof input === "string" ? input : input.toString();
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAIResponses(model, context, {
		apiKey: "test-key",
		...options,
		onPayload: (payload) => {
			capturedPayload = payload;
		},
	});
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	vi.restoreAllMocks();
	return { url: capturedUrl, payload: capturedPayload };
}

// pie: crates/ai/src/providers/openai_responses.rs:847-866 (url_does_not_double_v1)
//
// Note: oracle's build_responses_url is a hand-rolled function; the TS base has no direct
// counterpart because it delegates URL construction to the `openai` npm SDK's own baseURL/path
// joining. Empirically (verified against openai@6.26.0) that SDK does NOT insert a missing `/v1`
// for a bare-host baseURL, producing `.../responses` instead of `.../v1/responses` — a real
// divergence from oracle's normalized behavior, fixed via
// `normalizeOpenAIResponsesBaseUrl()` in openai-responses.ts.
describe("base URL normalization (pie: openai_responses.rs:756-766 build_responses_url)", () => {
	it.each([
		["https://api.openai.com", "https://api.openai.com/v1/responses"],
		["https://api.openai.com/v1", "https://api.openai.com/v1/responses"],
		["https://api.openai.com/v1/", "https://api.openai.com/v1/responses"],
		// Cloudflare AI Gateway sticks an `/openai` segment in front of `/v1`; provider is
		// deliberately NOT "cloudflare-ai-gateway" here so this exercises the generic
		// normalization path, not the dedicated Cloudflare base-URL resolver.
		["https://gateway.example.com/acct/gw/openai", "https://gateway.example.com/acct/gw/openai/v1/responses"],
	])("normalizes %s -> %s", async (baseUrl, expectedUrl) => {
		const model = buildModel({ provider: "opencode", baseUrl });
		const { url } = await captureRequest(model, {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		});
		expect(url).toBe(expectedUrl);
	});
});

// pie: crates/ai/src/providers/openai_responses.rs:868-884 (body_includes_system_prompt)
it("includes the system prompt as the first input item", async () => {
	const model = buildModel();
	const { payload } = await captureRequest(model, {
		systemPrompt: "be helpful",
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	});
	const input = (payload as { input: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }> })
		.input;
	// pie: crates/ai/src/providers/openai_responses.rs:668-672,882-883 — oracle encodes the
	// system message's content as `[{ type: "input_text", text }]`, not a bare string, and always
	// uses role "system" — there is no developer-role branch, regardless of model.reasoning.
	expect(input[0]?.role).toBe("system");
	expect(input[0]?.content?.[0]?.type).toBe("input_text");
	expect(input[0]?.content?.[0]?.text).toContain("be helpful");
});

// pie: crates/ai/src/providers/openai_responses.rs:886-906 (long_retention_sets_24h_and_cache_key)
it("sets prompt_cache_retention 24h and prompt_cache_key for long retention", async () => {
	const model = buildModel();
	const { payload } = await captureRequest(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ cacheRetention: "long", sessionId: "sess-1" },
	);
	const params = payload as { prompt_cache_key?: string; prompt_cache_retention?: string };
	expect(params.prompt_cache_key).toBe("sess-1");
	expect(params.prompt_cache_retention).toBe("24h");
});

// pie: crates/ai/src/providers/openai_responses.rs:908-927 (reasoning_block_emitted_when_effort_set)
it("emits a reasoning block when reasoning effort is set", async () => {
	const model = buildModel();
	const { payload } = await captureRequest(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ reasoningEffort: "high" },
	);
	const params = payload as { reasoning?: { effort?: string; summary?: string }; include?: string[] };
	expect(params.reasoning?.effort).toBe("high");
	expect(params.reasoning?.summary).toBe("auto");
	expect(params.include).toEqual(["reasoning.encrypted_content"]);
});

function assistantWithThinking(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "let me check" },
			{ type: "text", text: "done" },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
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
	};
}

// pie: crates/ai/src/providers/openai_responses.rs:956-988
// (thinking_replayed_as_reasoning_item_when_compat_requires)
it("replays thinking as a reasoning item when compat requires it", () => {
	const model = buildModel({ compat: { requiresReasoningContentOnAssistantMessages: true } });
	// pie: crates/ai/src/providers/openai_responses.rs:36-57 (resolve_compat) — production call
	// sites resolve this from `Model.compat` via `getCompat` (openai-responses.ts) and pass the
	// boolean through; this direct unit call stands in for that caller-side resolution.
	const input = convertResponsesMessages(model, { messages: [assistantWithThinking()] }, new Set(["openai"]), {
		replayReasoningContent: true,
	});

	const reasoningIdx = input.findIndex((item) => item.type === "reasoning");
	expect(reasoningIdx).toBeGreaterThanOrEqual(0);
	const reasoningItem = input[reasoningIdx] as { summary?: unknown };
	expect(reasoningItem.summary).toEqual([{ type: "summary_text", text: "let me check" }]);

	const assistantIdx = input.findIndex((item) => (item as { role?: string }).role === "assistant");
	expect(assistantIdx).toBeGreaterThanOrEqual(0);
	expect(reasoningIdx).toBeLessThan(assistantIdx); // reasoning item must precede the message it belongs to
});

// pie: crates/ai/src/providers/openai_responses.rs:990-1001 (thinking_dropped_without_compat_flag)
it("drops thinking content when the compat flag is not set", () => {
	const model = buildModel(); // no compat override -> requiresReasoningContentOnAssistantMessages defaults false
	const input = convertResponsesMessages(model, { messages: [assistantWithThinking()] }, new Set(["openai"]));
	expect(input.every((item) => item.type !== "reasoning")).toBe(true);
});

// pie: crates/ai/src/providers/openai_responses.rs:680-715 (convert_messages, Message::Assistant
// arm) — within one turn, all Text blocks merge into a single message item and all function_call
// items are deferred to the end of the turn (`out.extend(function_calls)` after the block loop),
// regardless of the blocks' original interleaved order.
describe("assistant turn item grouping/ordering (pie: openai_responses.rs:680-715 convert_messages)", () => {
	it("merges multiple Text blocks into one message item and moves a leading toolCall to the end", () => {
		const model = buildModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				// toolCall appears first in block order, ahead of both Text blocks.
				{ type: "toolCall", id: "call_1", name: "calc", arguments: { x: 1 } },
				{ type: "text", text: "part one " },
				{ type: "text", text: "part two" },
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		};
		// A matching toolResult keeps the fixture free of transformMessages' unrelated "No result
		// provided" synthetic-injection for orphaned tool calls (transform-messages.ts:166-171), which
		// would otherwise add an extra function_call_output item unrelated to this turn's grouping.
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "calc",
			content: [{ type: "text", text: "2" }],
			isError: false,
			timestamp: 1,
		};
		const input = convertResponsesMessages(model, { messages: [assistant, toolResult] }, new Set(["openai"]));
		// Only this turn's own items (the toolResult produces a separate function_call_output item).
		// pie: crates/ai/src/providers/openai_responses.rs:712-714 — the merged message item is a bare
		// `{role:"assistant", content:[...]}` with no `type` wrapper, so it's identified by `role`
		// rather than `item.type === "message"` (oracle has no message-type/status/id concept at all).
		const turnItems = input.filter(
			(item) => (item as { role?: string }).role === "assistant" || item.type === "function_call",
		);

		// Exactly 2 items for this turn: the merged message, then the function_call — not 3 (one
		// message per Text block, oracle's pre-merge shape) and not toolCall-first (the original
		// block order).
		expect(turnItems).toHaveLength(2);
		expect(turnItems.map((item) => (item as { role?: string }).role ?? item.type)).toEqual([
			"assistant",
			"function_call",
		]);

		// pie: crates/ai/src/providers/openai_responses.rs:685-688,712-714 — no `annotations` on the
		// content sub-item either; oracle's output_text item is exactly `{type, text}`.
		const message = turnItems[0] as { content?: Array<{ type?: string; text?: string }> };
		expect(message.content).toEqual([
			{ type: "output_text", text: "part one " },
			{ type: "output_text", text: "part two" },
		]);

		const functionCall = turnItems[1] as { call_id?: string; name?: string };
		expect(functionCall.call_id).toBe("call_1");
		expect(functionCall.name).toBe("calc");
	});
});

// pie: crates/ai/src/providers/openai_responses.rs:1003-1021
// (usage_reads_cached_and_cache_write_tokens) — PORT-DIVERGENCE: B1
describe("usage accounting (PORT-DIVERGENCE: B1)", () => {
	it("reads cached_tokens and the non-standard cache_write_tokens field", async () => {
		const model = buildModel();
		const output = buildOutput(model);
		await processResponsesStream(
			eventsOf({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 100,
						output_tokens: 10,
						input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
					},
				},
			}),
			output,
			new AssistantMessageEventStream(),
			model,
		);
		expect(output.usage.cacheRead).toBe(80);
		expect(output.usage.cacheWrite).toBe(20);
	});

	it("nets cached input out of `input` so totalTokens counts it exactly once", async () => {
		// PORT-DIVERGENCE: B1 (RULEBOOK §5). Oracle (openai_responses.rs:542-564) kept input at the
		// raw 100 and reported total=210; the ledger's own worked example calls 110 the correct
		// answer. 100/80/20/10 now yields input=0 (100 - 80 cacheRead - 20 cacheWrite) and
		// total = 0 + 80 + 20 + 10 = 110, which is also what the provider itself reports.
		const model = buildModel();
		const output = buildOutput(model);
		await processResponsesStream(
			eventsOf({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 100,
						output_tokens: 10,
						total_tokens: 110,
						input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
					},
				},
			}),
			output,
			new AssistantMessageEventStream(),
			model,
		);
		expect(output.usage.input).toBe(0); // raw input_tokens minus both cache buckets
		expect(output.usage.cacheRead).toBe(80);
		expect(output.usage.cacheWrite).toBe(20);
		expect(output.usage.output).toBe(10);
		expect(output.usage.totalTokens).toBe(110); // 0 + 80 + 20 + 10, no longer oracle's 210
	});
});

// pie: crates/ai/src/providers/openai_responses.rs:1023-1060 (tool_call_serializes_as_function_call)
it("serializes a tool call as a function_call item", () => {
	const model = buildModel();
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_123", name: "calc", arguments: { x: 1 } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
	const input = convertResponsesMessages(model, { messages: [assistant] }, new Set(["openai"]));
	const fc = input.find((item) => item.type === "function_call") as
		| { call_id?: string; name?: string; arguments?: string }
		| undefined;
	expect(fc).toBeDefined();
	expect(fc?.call_id).toBe("call_123");
	expect(fc?.name).toBe("calc");
	expect(fc?.arguments).toContain('"x":1');
});

// Bonus: locks in the stop-reason divergence found while cross-checking both sides (RULEBOOK item
// 5, "differences in stop-reason mapping"). pie: crates/ai/src/providers/openai_responses.rs:523-540
// (openai_stop_reason) — a function_call item in the response's own output array wins
// unconditionally over the response status, even over "incomplete" (length).
describe("stop reason mapping (pie: openai_responses.rs:523-540 openai_stop_reason)", () => {
	it("prioritizes a function_call in response.output over an incomplete status", async () => {
		const model = buildModel();
		const output = buildOutput(model);
		await processResponsesStream(
			eventsOf({
				type: "response.completed",
				response: {
					status: "incomplete",
					output: [{ type: "function_call", call_id: "call_1", name: "calc", arguments: "{}" }],
				},
			}),
			output,
			new AssistantMessageEventStream(),
			model,
		);
		expect(output.stopReason).toBe("toolUse");
	});

	it("falls back to status-based mapping when no function_call is present", async () => {
		const model = buildModel();
		const output = buildOutput(model);
		await processResponsesStream(
			eventsOf({
				type: "response.completed",
				response: { status: "incomplete", output: [{ type: "message", id: "m1", content: [] }] },
			}),
			output,
			new AssistantMessageEventStream(),
			model,
		);
		expect(output.stopReason).toBe("length");
	});

	// pie: crates/ai/src/providers/openai_responses.rs:523-538 (openai_stop_reason) — oracle's `match`
	// catch-all (`_ => StopReason::Stop`) maps any status value outside the known set to "stop"
	// instead of panicking. A status the OpenAI SDK's `ResponseStatus` union doesn't know about (e.g.
	// from a proxy/local server) must not throw.
	it("maps a status outside the known ResponseStatus set to stop instead of throwing", async () => {
		const model = buildModel();
		const output = buildOutput(model);
		await expect(
			processResponsesStream(
				eventsOf({
					type: "response.completed",
					response: { status: "some_future_vendor_status", output: [{ type: "message", id: "m1", content: [] }] },
				}),
				output,
				new AssistantMessageEventStream(),
				model,
			),
		).resolves.toBeUndefined();
		expect(output.stopReason).toBe("stop");
	});

	// BUG(port): B12 — crates/ai/src/providers/openai_responses.rs:531-538. Oracle's `match` only
	// special-cases "incomplete" => Length; "failed" and "cancelled" (like every other status) fall
	// through to the `_ => Stop` catch-all. The previous TS mapping special-cased "failed"/"cancelled"
	// to "error", which is a divergence — fix maps both to "stop" for bug-for-bug parity.
	it.each(["failed", "cancelled"] as const)("maps a %s status to stop, not error", async (status) => {
		const model = buildModel();
		const output = buildOutput(model);
		await processResponsesStream(
			eventsOf({
				type: "response.completed",
				response: { status, output: [{ type: "message", id: "m1", content: [] }] },
			}),
			output,
			new AssistantMessageEventStream(),
			model,
		);
		expect(output.stopReason).toBe("stop");
	});
});
