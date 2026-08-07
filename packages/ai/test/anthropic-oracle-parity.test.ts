import type Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic, streamSimpleAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

// pie: unreachable local port, mirrors anthropic-thinking-disable.test.ts's `capturePayload` — the
// request never leaves the process because `onPayload` throws before the SDK sends anything.
async function captureSimplePayload(
	model: Model<"anthropic-messages">,
	context: Context,
	options: Record<string, unknown>,
): Promise<MessageCreateParamsStreaming> {
	let captured: MessageCreateParamsStreaming | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = { ...model, baseUrl: "http://127.0.0.1:9" };
	const s = streamSimpleAnthropic(payloadCaptureModel, context, {
		...options,
		apiKey: "fake-key",
		onPayload: (payload: unknown) => {
			captured = payload as MessageCreateParamsStreaming;
			throw new PayloadCaptured();
		},
	} as never);
	await s.result();
	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

// Locks 5 divergences found against crates/ai/src/providers/anthropic.rs during this session's
// review (unit ai/providers/anthropic). Uses the `client` injection point (see
// anthropic-sse-parsing.test.ts) so these run hermetically with no real API key.

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function messageStartEvent(usage: {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
}) {
	return {
		event: "message_start",
		data: JSON.stringify({ type: "message_start", message: { id: "msg_test", usage } }),
	};
}

function textDeltaEvents(text: string) {
	return [
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
	];
}

function messageDeltaEvent(
	stopReason: string,
	usage: Partial<{
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens: number;
		cache_creation_input_tokens: number;
	}>,
) {
	return {
		event: "message_delta",
		data: JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason }, usage }),
	};
}

function createCapturingFakeClient(response: Response): {
	client: Anthropic;
	getCapturedParams: () => MessageCreateParamsStreaming | undefined;
} {
	let captured: MessageCreateParamsStreaming | undefined;
	const client = {
		messages: {
			create: (params: MessageCreateParamsStreaming) => {
				captured = params;
				return { asResponse: async () => response };
			},
		},
	} as unknown as Anthropic;
	return { client, getCapturedParams: () => captured };
}

describe("anthropic oracle parity", () => {
	// pie: crates/ai/src/providers/anthropic.rs:539-547 (map_stop_reason)
	it.each([
		["refusal", "stop"],
		["sensitive", "stop"],
		["some_future_stop_reason", "stop"],
	])("maps stop_reason %s to %s (not error / not throw)", async (anthropicReason, expected) => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
		const response = createSseResponse([
			messageStartEvent({
				input_tokens: 5,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			}),
			...textDeltaEvents("hi"),
			messageDeltaEvent(anthropicReason, { output_tokens: 1 }),
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const { client } = createCapturingFakeClient(response);
		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.stopReason).toBe(expected);
		expect(result.errorMessage).toBeUndefined();
	});

	// pie: crates/ai/src/providers/anthropic.rs:556-573 (update_usage) — accumulates (`+=`) rather
	// than overwriting; a resent cache_read_input_tokens in message_delta gets ADDED to
	// message_start's value.
	it("accumulates usage across message_start and message_delta instead of overwriting", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
		const response = createSseResponse([
			messageStartEvent({
				input_tokens: 10,
				output_tokens: 0,
				cache_read_input_tokens: 5,
				cache_creation_input_tokens: 0,
			}),
			...textDeltaEvents("hi"),
			// A proxy resending cache_read_input_tokens here should ADD, not overwrite.
			messageDeltaEvent("end_turn", { output_tokens: 3, cache_read_input_tokens: 5 }),
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const { client } = createCapturingFakeClient(response);
		const result = await streamAnthropic(model, context, { client }).result();

		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(3);
		expect(result.usage.cacheRead).toBe(10); // 5 (message_start) + 5 (message_delta), not 5
		expect(result.usage.totalTokens).toBe(10 + 3 + 10 + 0);
	});

	// PORT-DIVERGENCE: B3a (RULEBOOK §5) — crates/ai/src/providers/anthropic.rs never computes
	// usage.cost, which (together with every sibling provider doing the same) pinned every
	// user-visible cost figure at $0. Phase 18 prices from the catalog at both usage sites in
	// streamAnthropic (message_start and message_delta), so this asserts the mid-stream value as well
	// as the final one: a regression that dropped the pricing at either site individually would still
	// look correct at the other.
	it("prices usage.cost from the catalog at every point in the stream", async () => {
		const model = getModel("anthropic", "claude-opus-4-6"); // a priced (non-zero-cost) model
		// Pin the rates the dollar figures below are derived from: $/million tokens.
		expect(model.cost).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
		const response = createSseResponse([
			messageStartEvent({
				input_tokens: 100_000,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			}),
			...textDeltaEvents("hi"),
			messageDeltaEvent("end_turn", { output_tokens: 50_000 }),
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const { client } = createCapturingFakeClient(response);
		const stream = streamAnthropic(model, context, { client });

		let sawTextStart = false;
		for await (const event of stream) {
			if (event.type === "text_start") {
				// Fires after message_start has priced its 100_000 input tokens but before message_delta
				// adds any output: $5/M * 100_000 = $0.50, and nothing else billed yet.
				sawTextStart = true;
				expect(event.partial.usage.cost).toEqual({
					input: 0.5,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.5,
				});
			}
		}
		expect(sawTextStart).toBe(true);

		// After message_delta: $5/M * 100_000 = $0.50 in, $25/M * 50_000 = $1.25 out, $1.75 total.
		const result = await stream.result();
		expect(result.usage.cost).toEqual({
			input: 0.5,
			output: 1.25,
			cacheRead: 0,
			cacheWrite: 0,
			total: 1.75,
		});
	});

	// pie: crates/ai/src/providers/anthropic.rs:162-170 (default_budget_for) — {minimal:1024,
	// low:4096, medium:8192, high:16384}, not simple-options.ts's shared generic {low:2048, ...}.
	it("uses oracle's low=4096 thinking-budget default (not the shared generic 2048) for non-adaptive models", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		const params = await captureSimplePayload(model, context, { reasoning: "low" });

		expect(params.thinking).toMatchObject({ type: "enabled", budget_tokens: 4096 });
	});

	// pie: crates/ai/src/providers/anthropic.rs:862-888 (temperature_dropped_when_thinking_enabled)
	// — no existing base test asserted this; already correctly implemented (verdict: none for this
	// point), porting oracle's test to lock it.
	it("drops temperature from the payload when thinking is enabled", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

		const params = await captureSimplePayload(model, context, { reasoning: "low", temperature: 0.7 });

		expect(params.temperature).toBeUndefined();
		expect(params.thinking).toMatchObject({ type: "enabled" });
	});

	// pie: crates/ai/src/providers/anthropic.rs:664-670 (convert_messages) — cache_control goes on
	// the last User-or-ToolResult source message via `rposition`, independent of whether an assistant
	// turn follows it. Previously base only checked the literal last params entry.
	it("applies cache_control to the last user message even when the conversation ends on an assistant turn", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [
				{ role: "user", content: "first question", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "an answer" }],
					api: "anthropic-messages",
					provider: "anthropic",
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
					timestamp: Date.now(),
				},
			],
		};
		const response = createSseResponse([
			messageStartEvent({
				input_tokens: 5,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			}),
			...textDeltaEvents("hi"),
			messageDeltaEvent("end_turn", { output_tokens: 1 }),
			{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
		]);

		const { client, getCapturedParams } = createCapturingFakeClient(response);
		await streamAnthropic(model, context, { client, cacheRetention: "short" }).result();

		const params = getCapturedParams();
		const messages = params?.messages ?? [];
		expect(messages).toHaveLength(2);
		expect(messages[1].role).toBe("assistant"); // conversation genuinely ends on assistant
		const userMessage = messages[0];
		expect(Array.isArray(userMessage.content)).toBe(true);
		const block = (userMessage.content as unknown as Array<Record<string, unknown>>)[0];
		expect(block.cache_control).toEqual({ type: "ephemeral" });
	});
});
