/**
 * Locks in that the shared `processResponsesStream` usage-accounting behavior — including
 * PORT-DIVERGENCE: B1's fix for the double-counting of cached input into totalTokens — propagates
 * uniformly to every provider that wires the shared SSE pipeline up, not just openai-responses.ts.
 * Feeds a synthetic event array directly into `processResponsesStream` (no network, no
 * provider-specific auth/transport) for the azure-openai-responses and openai-codex-responses
 * provider APIs.
 *
 * pie: crates/ai/src/providers/openai_responses.rs:542-564 (update_usage) — PORT-DIVERGENCE: B1.
 * Oracle reports total=210 for the ledger example by keeping the raw (cache-inclusive) input_tokens
 * and then adding the cache buckets on top; phase 18 nets the cache buckets out of `input` so the
 * total counts them exactly once. See test/openai-responses-oracle-parity.test.ts's
 * "usage accounting (PORT-DIVERGENCE: B1)" describe block for the openai-responses.ts-driven
 * coverage of the same ledger entry.
 */
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function buildOutput<TApi extends string>(model: Model<TApi>): AssistantMessage {
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

// 100/80/20/10 -> total=110 (oracle reported 210). Same ledger example as RULEBOOK §5 B1 / the
// openai-responses.ts-driven test.
const b1Usage = {
	input_tokens: 100,
	output_tokens: 10,
	total_tokens: 110,
	input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
};

describe("processResponsesStream usage accounting cross-provider propagation (PORT-DIVERGENCE: B1)", () => {
	it("counts cached input exactly once in totalTokens for azure-openai-responses", async () => {
		const model: Model<"azure-openai-responses"> = {
			id: "gpt-4o-mini",
			name: "GPT-4o mini",
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			baseUrl: "https://example.openai.azure.com/openai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		};
		const output = buildOutput(model);
		await processResponsesStream(
			eventsOf({ type: "response.completed", response: { status: "completed", usage: b1Usage } }),
			output,
			new AssistantMessageEventStream(),
			model,
		);
		expect(output.usage.input).toBe(0); // raw input_tokens minus both cache buckets
		expect(output.usage.cacheRead).toBe(80);
		expect(output.usage.cacheWrite).toBe(20);
		expect(output.usage.totalTokens).toBe(110); // 0 + 80 + 20 + 10, no longer oracle's 210
	});

	it("counts cached input exactly once in totalTokens for openai-codex-responses", async () => {
		const model: Model<"openai-codex-responses"> = {
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		};
		const output = buildOutput(model);
		await processResponsesStream(
			eventsOf({ type: "response.completed", response: { status: "completed", usage: b1Usage } }),
			output,
			new AssistantMessageEventStream(),
			model,
		);
		expect(output.usage.input).toBe(0); // raw input_tokens minus both cache buckets
		expect(output.usage.cacheRead).toBe(80);
		expect(output.usage.cacheWrite).toBe(20);
		expect(output.usage.totalTokens).toBe(110); // 0 + 80 + 20 + 10, no longer oracle's 210
	});
});
