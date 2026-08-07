// Locks in two behaviors ported from the oracle's (partial) Bedrock provider,
// crates/ai/src/providers/amazon_bedrock.rs — see migration/reviews/ai/divergence-ledger.tsv
// unit ai/providers/amazon_bedrock.
//
// 1. Usage accounting (update_usage, oracle lines 348-360): totalTokens is recomputed as
//    input+output+cacheRead+cacheWrite instead of trusting the SDK-provided TokenUsage.totalTokens.
//    This is NOT a bug-for-bug divergence, despite what this header claimed until the phase 19 diff
//    review. AWS reports `inputTokens` EXCLUSIVE of the cache buckets, so the four-way sum IS the
//    AWS total — AWS's own prompt-caching example is inputTokens 4 + outputTokens 106 +
//    cacheWriteInputTokens 2349 = totalTokens 2459. (Contrast RULEBOOK §5 B1/B2, where OpenAI's
//    prompt-token count DOES include the cached tokens and the same sum really would double-count;
//    that is what src/usage.ts `finalizeUsage` exists for.) What this test pins is that the
//    provider DERIVES the total from the four buckets rather than trusting the reported field —
//    observable only when the payload is internally inconsistent, which the fixture below
//    deliberately makes it.
// 2. mapStopReason (oracle map_stop_reason, lines 339-346): unrecognized stop reasons fall through
//    to Stop, not an error state. This one IS a genuine bug-for-bug divergence.
//
// A third item used to live here: "usage.cost is never computed by the oracle provider"
// (ledger row B3a — "the ai provider layer does not compute usage.cost", RULEBOOK §5). That is now
// a deliberate
// PORT-DIVERGENCE: phase 18 prices usage.cost from the catalog in handleMetadata, so the cost
// assertions below are the flipped form of the old assert-it-stays-zero ones.
import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	streamEvents: [] as unknown[],
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		async send(): Promise<{ $metadata: { httpStatusCode: number }; stream: AsyncIterable<unknown> }> {
			const events = bedrockMock.streamEvents;
			return {
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {
					for (const event of events) {
						yield event;
					}
				})(),
			};
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

const { getModel } = await import("../src/models.ts");
const { streamBedrock } = await import("../src/providers/amazon-bedrock.ts");

const context = {
	messages: [{ role: "user" as const, content: "hello", timestamp: Date.now() }],
};

const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");

describe("bedrock usage accounting (oracle amazon_bedrock.rs update_usage)", () => {
	it("sums cacheRead + cacheWrite into totalTokens instead of trusting the SDK-reported total", async () => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{
				metadata: {
					usage: {
						inputTokens: 100,
						outputTokens: 10,
						// Deliberately inconsistent with the four buckets: real AWS would report
						// 100 + 10 + 80 + 20 = 200 here, since its `inputTokens` excludes the cache
						// buckets. Reporting 110 instead is what makes "derived from the parts" and
						// "trusted the reported field" distinguishable in the assertion below.
						totalTokens: 110,
						cacheReadInputTokens: 80,
						cacheWriteInputTokens: 20,
					},
				},
			},
			{ messageStop: { stopReason: "end_turn" } },
		];

		const response = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		expect(response.usage.input).toBe(100);
		expect(response.usage.output).toBe(10);
		expect(response.usage.cacheRead).toBe(80);
		expect(response.usage.cacheWrite).toBe(20);
		// Derived from the four buckets: 100 + 10 + 80 + 20 = 210, not the 110 the payload reported.
		// 210 is also the AWS-correct total for these buckets — `inputTokens` excludes cache tokens,
		// so nothing here is counted twice; it is the fixture's 110 that is wrong, on purpose.
		expect(response.usage.totalTokens).toBe(210);

		// PORT-DIVERGENCE: B3a — each bucket is billed at its OWN catalog rate (claude-sonnet-4-5:
		// $3/$15/$0.30/$3.75 per million), which is why the cache tokens must not also be charged at
		// the full input rate. Note the cost is computed from the four buckets, NOT from the
		// totalTokens asserted above.
		expect(model.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		expect(response.usage.cost.input).toBeCloseTo(0.0003, 12); // $3/M * 100
		expect(response.usage.cost.output).toBeCloseTo(0.00015, 12); // $15/M * 10
		expect(response.usage.cost.cacheRead).toBeCloseTo(0.000024, 12); // $0.30/M * 80
		expect(response.usage.cost.cacheWrite).toBeCloseTo(0.000075, 12); // $3.75/M * 20
		expect(response.usage.cost.total).toBeCloseTo(0.000549, 12);
	});

	it("prices usage.cost from the catalog (PORT-DIVERGENCE: B3a)", async () => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{
				metadata: {
					usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
				},
			},
			{ messageStop: { stopReason: "end_turn" } },
		];

		const response = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		// $3/M * 100 = $0.0003 in, $15/M * 10 = $0.00015 out, no cache buckets in this fixture.
		expect(response.usage.cost.input).toBeCloseTo(0.0003, 12);
		expect(response.usage.cost.output).toBeCloseTo(0.00015, 12);
		expect(response.usage.cost.cacheRead).toBe(0);
		expect(response.usage.cost.cacheWrite).toBe(0);
		expect(response.usage.cost.total).toBeCloseTo(0.00045, 12);
	});
});

describe("bedrock stop-reason mapping (bug-for-bug: oracle amazon_bedrock.rs map_stop_reason)", () => {
	it("maps an unrecognized stop reason to stop, not error", async () => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockStart: { contentBlockIndex: 0, start: {} } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hi" } } },
			{ contentBlockStop: { contentBlockIndex: 0 } },
			// "content_filtered" has no arm in oracle's 4-case match and falls through to Stop.
			{ messageStop: { stopReason: "content_filtered" } },
		];

		const response = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		expect(response.stopReason).toBe("stop");
		expect(response.errorMessage).toBeUndefined();
	});

	it("still maps the SDK-recognized reasons unchanged", async () => {
		bedrockMock.streamEvents = [{ messageStart: { role: "assistant" } }, { messageStop: { stopReason: "tool_use" } }];

		const response = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		expect(response.stopReason).toBe("toolUse");
	});
});
