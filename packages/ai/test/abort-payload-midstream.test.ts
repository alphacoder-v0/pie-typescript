/**
 * Aborting midstream: content and usage have already accumulated, and the abort has to discard
 * them.
 *
 * pie: `crates/ai/src/utils/abort.rs:116-135` (`push_aborted`)。
 *
 * How this divides with `abort-payload.test.ts`: that file covers all nine providers through the
 * connection-refused path, where `output` is empty anyway, so it cannot discriminate on **cost** —
 * the old implementation returned zero there too. This file supplies the real discriminator: the
 * provider first receives a `message_start` carrying `input_tokens` and a text delta, and **then**
 * the abort fires.
 * The old implementation carried that content out along with non-zero usage and cost; upstream
 * returns an empty message with everything zeroed.
 *
 * This is exactly the harm D-2 describes in
 * `migration/reviews/phase19/surface-coverage-audit.md`: a caller that sums cost without filtering
 * on `stopReason` first bills for an aborted turn.
 */
import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
	abort: undefined as (() => void) | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function sseResponse(): Response {
		const encoder = new TextEncoder();
		const frames = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_midstream", usage: { input_tokens: 500, output_tokens: 0 } },
			})}\n\n`,
			`event: content_block_start\ndata: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			})}\n\n`,
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "partial content" },
			})}\n\n`,
		];
		let i = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (i < frames.length) {
					controller.enqueue(encoder.encode(frames[i++]));
					return;
				}
				// Three frames sent: both content and usage are now in the provider's accumulated state.
				// Abort here.
				mockState.abort?.();
				// The connection stays open but produces nothing further: the read loop sees signal.aborted
				// on its next pass and throws.
				controller.enqueue(encoder.encode(":\n\n"));
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		messages = {
			create: () => ({ asResponse: async () => sseResponse() }),
		};
	}
	return { default: FakeAnthropic };
});

const { streamAnthropic } = await import("../src/providers/anthropic.ts");
const { getModel } = await import("../src/models.ts");

describe("aborting midstream", () => {
	it("accumulated content, usage and cost are all discarded, matching the upstream empty message", async () => {
		const controller = new AbortController();
		mockState.abort = () => controller.abort();

		const model = getModel("anthropic", "claude-sonnet-4-5");
		// Precondition: the unit prices have to be non-zero, or even a failure to discard usage would
		// compute a zero cost and the assertion would be decorative.
		expect(model.cost.input).toBeGreaterThan(0);

		const msg = await streamAnthropic(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: "test-key", signal: controller.signal },
		).result();

		expect(msg.stopReason).toBe("aborted");
		// The discriminator: the old implementation returned "partial content", input=500 and cost>0
		// here.
		expect(msg.content).toEqual([]);
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.totalTokens).toBe(0);
		expect(msg.usage.cost.total).toBe(0);
		expect(msg.errorMessage).toBe("aborted");
		expect(msg.responseId).toBeUndefined();
	}, 20_000);
});
