/**
 * phase 20-3: ports the two cases asserting the Converse request body from upstream
 * `crates/ai/src/providers/amazon_bedrock.rs`.
 *
 * It is a file of its own because the AWS SDK has to be replaced with `vi.mock`, which is file-scoped
 * and hoisted, so mixing it in with other cases would catch them too.
 * The capture point is `ConverseStreamCommand.input`, the object actually handed to the SDK, with no
 * network request at all.
 *
 * The assertions are **upstream's**.
 */
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ inputs: [] as Array<Record<string, any>> }));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class ConverseStreamCommand {
		readonly input: Record<string, any>;
		constructor(input: Record<string, any>) {
			this.input = input;
			captured.inputs.push(input);
		}
	}

	class BedrockRuntimeClient {
		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
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

const { streamBedrock } = await import("../../src/providers/amazon-bedrock.ts");
const { getModel } = await import("../../src/models.ts");

const BEDROCK_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";

async function captureInput(
	context: Record<string, any>,
	options: Record<string, unknown> = {},
): Promise<Record<string, any>> {
	captured.inputs.length = 0;
	await streamBedrock(
		getModel("amazon-bedrock", BEDROCK_MODEL_ID) as never,
		context as never,
		{
			apiKey: "fake-key",
			...options,
		} as never,
	).result();
	if (captured.inputs.length === 0) throw new Error("ConverseStreamCommand was never constructed");
	return captured.inputs[0];
}

describe("amazon-bedrock: the Converse request body", () => {
	// pie: crates/ai/src/providers/amazon_bedrock.rs `body_has_converse_shape`
	// Each of the four fields lands where the Converse API requires: system is an array,
	// inferenceConfig carries maxTokens, and tools are wrapped under toolConfig.tools[].toolSpec. Put
	// any one of them elsewhere and AWS refuses the request outright.
	it("system, messages, inferenceConfig and toolConfig each land in place", async () => {
		const input = await captureInput(
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: 0 }],
				tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }],
			},
			{ maxTokens: 512 },
		);

		expect(input.system[0].text).toBe("sys");
		expect(input.messages[0].role).toBe("user");
		expect(input.messages[0].content[0].text).toBe("hi");
		expect(input.inferenceConfig.maxTokens).toBe(512);
		expect(input.toolConfig.tools[0].toolSpec.name).toBe("t");
	}, 20_000);

	// pie: crates/ai/src/providers/amazon_bedrock.rs `tool_result_converts`
	// Upstream asserts two things: toolUseId passes through unchanged, and with isError=false the
	// status is "success".
	it("a toolResult becomes toolUseId plus status=success", async () => {
		const input = await captureInput({
			messages: [
				{
					role: "toolResult",
					toolCallId: "tu_1",
					toolName: "t",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 0,
				},
			],
		});

		const block = input.messages[0].content[0];
		expect(block.toolResult.toolUseId).toBe("tu_1");
		expect(block.toolResult.status).toBe("success");
	}, 20_000);
});
