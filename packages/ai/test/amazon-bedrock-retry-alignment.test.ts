/**
 * amazon-bedrock.ts cannot wire `sendWithRetry` (crates/ai/src/utils/retry.rs) into the AWS SDK v3
 * transport the way anthropic.ts / openai-completions.ts / openai-responses.ts do: this SDK
 * version's HTTP handlers expose no fetch/fetcher injection hook (`FetchHttpHandler` calls the
 * global `fetch` directly with no config override; the Node-side handlers are raw http(s)/http2
 * clients with no fetch involved at all). See the TODO(port) comment in
 * src/providers/amazon-bedrock.ts next to `BedrockRuntimeClientConfig` construction.
 *
 * Fallback: keep the AWS SDK's own built-in retry, but align its `maxAttempts` to oracle's retry
 * budget (crates/ai/src/utils/retry.rs:17, `DEFAULT_MAX_RETRIES` = 2 retries beyond the first
 * attempt = 3 total attempts by default) instead of drifting from it independently. This locks in
 * that alignment at the client-construction boundary — same mock harness as
 * bedrock-endpoint-resolution.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
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

import { getModel } from "../src/models.ts";
import type { BedrockOptions } from "../src/providers/amazon-bedrock.ts";
import { streamBedrock } from "../src/providers/amazon-bedrock.ts";
import type { Context } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

async function captureClientConfig(options: BedrockOptions): Promise<Record<string, unknown>> {
	bedrockMock.constructorCalls.length = 0;
	const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-7");
	await streamBedrock(model, context, { cacheRetention: "none", ...options }).result();
	expect(bedrockMock.constructorCalls).toHaveLength(1);
	return bedrockMock.constructorCalls[0];
}

describe("amazon-bedrock retry budget alignment (pie: utils/retry.rs DEFAULT_MAX_RETRIES fallback)", () => {
	it("defaults maxAttempts to oracle's retry budget (2 retries + 1 initial attempt = 3) when maxRetries is unset", async () => {
		const config = await captureClientConfig({});
		expect(config.maxAttempts).toBe(3);
	});

	it("aligns maxAttempts to options.maxRetries + 1 when the caller overrides the retry budget", async () => {
		const config = await captureClientConfig({ maxRetries: 5 });
		expect(config.maxAttempts).toBe(6);
	});

	it("aligns maxAttempts down to 1 total attempt when the caller disables retries", async () => {
		const config = await captureClientConfig({ maxRetries: 0 });
		expect(config.maxAttempts).toBe(1);
	});
});
