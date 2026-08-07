import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";

// Ports the remaining oracle #[test]s from crates/ai/src/providers/transform_messages.rs (259-352)
// that aren't already exercised by transform-messages-copilot-openai-to-anthropic.test.ts. Full
// line-by-line comparison against oracle found NO behavior divergence for this unit (verdict: none)
// — these tests lock that finding empirically.

function targetModel(): Model<"anthropic-messages"> {
	// pie: crates/ai/src/providers/transform_messages.rs:224-240 (target_model) — no image support
	return {
		id: "claude-x",
		name: "Claude X",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
	};
}

function assistantFrom(
	provider: string,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	// pie: crates/ai/src/providers/transform_messages.rs:242-257 (assistant_from)
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider,
		model: "gpt",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

describe("transformMessages oracle parity", () => {
	// pie: crates/ai/src/providers/transform_messages.rs:278-295 (errored_assistant_is_skipped)
	it("skips errored assistant turns entirely", () => {
		const model = targetModel();
		const messages: Message[] = [
			assistantFrom("openai", [{ type: "text", text: "partial" }], "error"),
			{ role: "user", content: "next", timestamp: 0 },
		];

		const out = transformMessages(messages, model);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("user");
	});

	it("skips aborted assistant turns entirely", () => {
		const model = targetModel();
		const messages: Message[] = [
			assistantFrom("openai", [{ type: "text", text: "partial" }], "aborted"),
			{ role: "user", content: "next", timestamp: 0 },
		];

		const out = transformMessages(messages, model);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("user");
	});

	// pie: crates/ai/src/providers/transform_messages.rs:326-352 (images_downgraded_for_non_vision_model)
	it("downgrades images to a text placeholder for a non-vision model", () => {
		const model = targetModel();
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "look at this" },
					{ type: "image", data: "abc", mimeType: "image/png" },
				],
				timestamp: 0,
			},
		];

		const out = transformMessages(messages, model);
		const user = out[0] as Extract<Message, { role: "user" }>;
		const blocks = user.content as { type: string; text?: string }[];
		expect(blocks).toHaveLength(2);
		expect(blocks[1].type).toBe("text");
		expect(blocks[1].text).toContain("image omitted");
	});

	// pie: crates/ai/src/providers/transform_messages.rs:23-44 (replace_images_with_placeholder) —
	// consecutive images collapse into a single placeholder instead of one-per-image.
	it("collapses consecutive images into a single placeholder", () => {
		const model = targetModel();
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "image", data: "a", mimeType: "image/png" },
					{ type: "image", data: "b", mimeType: "image/png" },
					{ type: "text", text: "two images above" },
				],
				timestamp: 0,
			},
		];

		const out = transformMessages(messages, model);
		const user = out[0] as Extract<Message, { role: "user" }>;
		const blocks = user.content as { type: string; text?: string }[];
		expect(blocks).toHaveLength(2);
		expect(blocks[0].type).toBe("text");
		expect(blocks[0].text).toContain("image omitted");
		expect(blocks[1].text).toBe("two images above");
	});
});
