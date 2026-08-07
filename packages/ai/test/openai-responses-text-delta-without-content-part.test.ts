/**
 * `response.output_text.delta` must never be dropped, whether or not the server sent a preceding
 * `response.content_part.added`.
 *
 * pie: crates/ai/src/providers/openai_responses.rs:374-400 (`on_text_delta`) — oracle keeps no
 * `ResponseOutputMessage.content` mirror at all: it appends the delta to the last text block,
 * synthesizing one (plus `TextStart`) when the last block is not text, and always emits `TextDelta`.
 * The skeleton required `content_part.added` to have seeded `currentItem.content` first and silently
 * skipped the delta otherwise, so an OpenAI-compatible server that streams
 * `output_item.added` -> `output_text.delta` (local servers such as ds4, and the parity SSE fixture
 * behind scenarios S3/S4/S5) streamed an empty reply while the final message still carried the text.
 *
 * Judge-observable: parity S4's `final.norm` greps the streamed assistant text out of the piped-TUI
 * stdout, which is fed exclusively by `text_delta` (ui/app-text.ts `printHeadlessUpdate`).
 */
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.2",
	name: "GPT-5.2",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

function buildOutput(): AssistantMessage {
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

const messageAdded = {
	type: "response.output_item.added",
	output_index: 0,
	item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
};

const contentPartAdded = {
	type: "response.content_part.added",
	part: { type: "output_text", text: "", annotations: [] },
};

async function runStream(...events: unknown[]): Promise<{
	output: AssistantMessage;
	emitted: AssistantMessageEvent[];
}> {
	const output = buildOutput();
	const stream = new AssistantMessageEventStream();
	const pushSpy = vi.spyOn(stream, "push");
	await processResponsesStream(eventsOf(...events), output, stream, model);
	return { output, emitted: pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent) };
}

function textDeltas(emitted: readonly AssistantMessageEvent[]): string[] {
	return emitted.filter((event) => event.type === "text_delta").map((event) => event.delta);
}

describe("openai-responses output_text.delta without content_part.added", () => {
	it("streams text_delta when the server skips response.content_part.added", async () => {
		const { output, emitted } = await runStream(
			messageAdded,
			{ type: "response.output_text.delta", item_id: "msg_1", delta: "fixture " },
			{ type: "response.output_text.delta", item_id: "msg_1", delta: "says hi" },
		);

		expect(textDeltas(emitted)).toEqual(["fixture ", "says hi"]);
		expect(output.content).toHaveLength(1);
		const block = output.content[0];
		expect(block?.type).toBe("text");
		if (!block || block.type !== "text") throw new Error("Expected text block");
		expect(block.text).toBe("fixture says hi");
	});

	it("still emits exactly one delta per event when content_part.added IS sent", async () => {
		const { output, emitted } = await runStream(messageAdded, contentPartAdded, {
			type: "response.output_text.delta",
			item_id: "msg_1",
			delta: "fixture says hi",
		});

		expect(textDeltas(emitted)).toEqual(["fixture says hi"]);
		const block = output.content[0];
		if (!block || block.type !== "text") throw new Error("Expected text block");
		expect(block.text).toBe("fixture says hi");
	});

	it("reconciles against output_item.done without duplicating the synthesized part", async () => {
		const { output, emitted } = await runStream(
			messageAdded,
			{ type: "response.output_text.delta", item_id: "msg_1", delta: "fixture says hi" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "fixture says hi", annotations: [] }],
				},
			},
		);

		expect(textDeltas(emitted)).toEqual(["fixture says hi"]);
		const textEnd = emitted.find((event) => event.type === "text_end");
		expect(textEnd).toBeDefined();
		const block = output.content[0];
		if (!block || block.type !== "text") throw new Error("Expected text block");
		expect(block.text).toBe("fixture says hi");
	});
});
