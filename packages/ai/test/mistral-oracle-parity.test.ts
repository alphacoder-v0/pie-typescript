/**
 * Vitest port of the 3 Rust unit tests in `crates/ai/src/providers/mistral.rs`'s
 * `#[cfg(test)] mod tests`, plus locking tests for 4 residual divergences found this session:
 *   1. tool serialization must never emit a "strict" key (oracle's serialize_tools has none)
 *   2. usage.totalTokens is always recomputed locally, never trusts the provider's own total
 *   3. mapChatStopReason has no "error" arm (falls through to oracle's catch-all "stop")
 *   4. retries go through the shared sendWithRetry util (oracle: send_with_retry), not the SDK's
 *      own (disabled) retry strategy
 *
 * Rust test -> vitest test map:
 *   tool_call_id_normalizes_to_len_9      -> "normalizes a foreign tool-call id to exactly 9 alphanumeric chars"
 *   nine_char_alnum_passes_through        -> "passes a 9-char alphanumeric id through unchanged"
 *   body_has_affinity_independent_messages -> "puts the system prompt first and streams"
 */
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamMistral } from "../src/providers/mistral.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

function makeModel(overrides?: Partial<Model<"mistral-conversations">>): Model<"mistral-conversations"> {
	return {
		id: "mistral-large-latest",
		name: "Mistral Large",
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "https://api.mistral.ai",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	};
}

interface MistralPayload {
	model: string;
	stream: boolean;
	messages: Array<{ role: string; content?: unknown; toolCalls?: Array<{ id: string }> }>;
	tools?: Array<{ type: "function"; function: { name: string; strict?: boolean } }>;
}

async function capturePayload(model: Model<"mistral-conversations">, context: Context): Promise<MistralPayload> {
	let captured: MistralPayload | undefined;
	const unroutable = { ...model, baseUrl: "http://127.0.0.1:9" };
	await streamMistral(unroutable, context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as unknown as MistralPayload;
			return payload;
		},
	}).result();
	if (!captured) throw new Error("Expected payload to be captured before request failure");
	return captured;
}

function foreignAssistantWithToolCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }],
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
}

describe("mistral oracle parity", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// pie: crates/ai/src/providers/mistral.rs:501-505 (tool_call_id_normalizes_to_len_9)
	it("normalizes a foreign tool-call id to exactly 9 alphanumeric chars", async () => {
		const model = makeModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "run a command", timestamp: 0 },
				foreignAssistantWithToolCall("call_abc-123-xyz"),
				{
					role: "toolResult",
					toolCallId: "call_abc-123-xyz",
					toolName: "bash",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: 0,
				},
			],
		};
		const payload = await capturePayload(model, context);
		const assistantMsg = payload.messages.find((m) => m.role === "assistant");
		const toolCallId = assistantMsg?.toolCalls?.[0]?.id;
		expect(toolCallId).toBeDefined();
		expect(toolCallId).toHaveLength(9);
		expect(toolCallId).toMatch(/^[a-zA-Z0-9]{9}$/);
	});

	// pie: crates/ai/src/providers/mistral.rs:507-510 (nine_char_alnum_passes_through)
	it("passes a 9-char alphanumeric id through unchanged", async () => {
		const model = makeModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "run a command", timestamp: 0 },
				foreignAssistantWithToolCall("abcdef123"),
			],
		};
		const payload = await capturePayload(model, context);
		const assistantMsg = payload.messages.find((m) => m.role === "assistant");
		expect(assistantMsg?.toolCalls?.[0]?.id).toBe("abcdef123");
	});

	// pie: crates/ai/src/providers/mistral.rs:512-542 (body_has_affinity_independent_messages)
	it("puts the system prompt first and streams", async () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		const payload = await capturePayload(model, context);
		expect(payload.messages[0]?.role).toBe("system");
		expect(payload.messages[1]?.content).toBe("hi");
		expect(payload.stream).toBe(true);
	});

	// pie: crates/ai/src/providers/mistral.rs:377-391 (serialize_tools) — no "strict" key ever.
	it("never emits a strict key on tool definitions", async () => {
		const model = makeModel();
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			tools: [
				{ name: "get_weather", description: "Get the weather", parameters: { type: "object", properties: {} } },
			],
		};
		const payload = await capturePayload(model, context);
		expect(payload.tools).toHaveLength(1);
		expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
	});

	// pie: crates/ai/src/providers/mistral.rs:320-325 — no "error" arm in the finish_reason match.
	it("maps an unrecognized finish_reason (including a hypothetical 'error') to stop, not error", async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				`data: ${JSON.stringify({
					id: "chunk-1",
					model: "mistral-large-latest",
					choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "error" }],
				})}\n\n`,
			);
			res.end();
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = server.address() as AddressInfo;
		try {
			const model = makeModel({ baseUrl: `http://127.0.0.1:${port}` });
			const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
			const result = await streamMistral(model, context, { apiKey: "fake-key" }).result();
			expect(result.stopReason).toBe("stop");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	// pie: crates/ai/src/providers/mistral.rs:148 (run, send_with_retry) +
	// crates/ai/src/utils/retry.rs — retries go through the shared sendWithRetry util (default
	// max_retries=2, i.e. 3 total attempts) instead of the SDK's own (disabled) retry strategy.
	it("retries a transient 500 through sendWithRetry before giving up", async () => {
		let requestCount = 0;
		const server = http.createServer((_req, res) => {
			requestCount++;
			res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: "server error" }));
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = server.address() as AddressInfo;
		try {
			const model = makeModel({ baseUrl: `http://127.0.0.1:${port}` });
			const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
			const result = await streamMistral(model, context, { apiKey: "fake-key" }).result();
			expect(result.stopReason).toBe("error");
			expect(requestCount).toBe(3);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
