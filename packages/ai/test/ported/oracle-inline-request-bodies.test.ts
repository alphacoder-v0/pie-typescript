/**
 * phase 20-3: ports the group of inline tests in upstream `crates/ai` that assert on the **outbound
 * request body**.
 *
 * Upstream calls `build_request_body(...)` directly and asserts on the JSON. The equivalent here is
 * inlined in each provider and not exported, so this captures the real payload through the
 * `onPayload` hook just before the request goes out. That is stronger than calling an internal
 * function: it tests the bytes that actually go on the wire, not one intermediate return value.
 *
 * Models are chosen by their `api` field rather than their provider name: `getModel("openai",
 * "gpt-4o-mini")` resolves to the api **openai-responses**, so using it to test
 * openai_completions.rs would test the wrong provider. groq is used instead.
 * （`api: openai-completions`）。
 *
 * `baseUrl` points at `127.0.0.1:9`: `onPayload` has already run before the connection is attempted,
 * so once the payload is captured the request is free to fail. Nothing leaves the machine and no
 * real credential is needed.
 *
 * The assertions are **upstream's**. Each case names the `#[test]` it was ported from.
 */
import { describe, expect, it } from "vitest";
import { complete } from "../../src/index.ts";
import { getModel } from "../../src/models.ts";
import type { Api, Context, Model } from "../../src/types.ts";

/** Captures the payload a model is about to send for a given context and options. */
async function capture(
	model: Model<Api>,
	context: Context,
	options: Record<string, unknown> = {},
): Promise<Record<string, any>> {
	let captured: Record<string, any> | undefined;
	await complete({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey: "fake-key",
		...options,
		onPayload: (payload: unknown) => {
			captured = payload as Record<string, any>;
			return payload;
		},
	} as never);
	if (!captured) throw new Error("the payload was never captured: the request failed before onPayload ran");
	return captured;
}

/**
 * An explicitly constructed openai-completions model.
 *
 * The catalog's `groq/llama-3.3-70b-versatile` cannot be used for images: its `input` is `text` only,
 * so `downgradeUnsupportedImages` turns the image into a text placeholder first, and what gets
 * tested is the downgrade logic rather than the serialisation.
 */
function completionsVisionModel(): Model<Api> {
	return {
		id: "vision-completions",
		name: "Vision Completions",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as Model<Api>;
}

/** codex extracts accountId from the token before building the payload, so the fake key has to be
 * JWT-shaped. */
function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const userHi: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

// ─────────────────────────────────────────────────────────────────────────────
// providers/anthropic.rs — where cache_control lands
// ─────────────────────────────────────────────────────────────────────────────

describe("anthropic: cache_control lands on the last position only", () => {
	// pie: crates/ai/src/providers/anthropic.rs `cache_control_applied_to_system_and_last_user`
	// The **negative** assertion is the point: the first user message must not carry cache_control.
	// Asserting only that the last one carries it would also pass under an implementation that puts it
	// on every message — which scatters the cache breakpoints, the very thing to prevent.
	it("system carries cache_control, the last user message carries it, the first does not", async () => {
		const body = await capture(
			getModel("anthropic", "claude-sonnet-4-5"),
			{
				systemPrompt: "sys",
				messages: [
					{ role: "user", content: "first", timestamp: 0 },
					{ role: "user", content: "last", timestamp: 1 },
				],
			},
			{ cacheRetention: "short" },
		);

		expect(body.system[0].cache_control?.type).toBe("ephemeral");
		expect(body.messages).toHaveLength(2);
		expect(body.messages[0].content[0].cache_control).toBeUndefined();
		expect(body.messages[1].content[0].cache_control?.type).toBe("ephemeral");
	});

	// pie: crates/ai/src/providers/anthropic.rs `tools_get_cache_control_on_last`
	it("only the last tool carries cache_control", async () => {
		const body = await capture(
			getModel("anthropic", "claude-sonnet-4-5"),
			{
				messages: [{ role: "user", content: "hi", timestamp: 0 }],
				tools: [
					{ name: "a", description: "a", parameters: { type: "object", properties: {} } },
					{ name: "b", description: "b", parameters: { type: "object", properties: {} } },
				],
			},
			{ cacheRetention: "short" },
		);

		expect(body.tools).toHaveLength(2);
		expect(body.tools[0].cache_control).toBeUndefined();
		expect(body.tools[1].cache_control?.type).toBe("ephemeral");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// providers/openai_completions.rs
// ─────────────────────────────────────────────────────────────────────────────

describe("openai-completions: the shape of the request body", () => {
	// pie: crates/ai/src/providers/openai_completions.rs `body_has_messages_and_stream_options`
	it("system at messages[0], user at messages[1], stream_options.include_usage true", async () => {
		const body = await capture(getModel("groq", "llama-3.3-70b-versatile"), {
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		});
		expect(body.messages[0].role).toBe("system");
		expect(body.messages[1].role).toBe("user");
		expect(body.stream_options?.include_usage).toBe(true);
	});

	// pie: crates/ai/src/providers/openai_completions.rs `assistant_tool_calls_serialize`
	it("an assistant toolCall serialises as tool_calls, and its result as role=tool", async () => {
		const body = await capture(getModel("groq", "llama-3.3-70b-versatile"), {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "search", arguments: { q: "x" } }],
					api: "openai-completions",
					provider: "openai",
					model: "gpt-4o",
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
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "search",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: 1,
				},
			],
		});

		expect(body.messages[0].role).toBe("assistant");
		expect(body.messages[0].tool_calls[0].id).toBe("call_1");
		expect(body.messages[0].tool_calls[0].function.name).toBe("search");
		expect(body.messages[1].role).toBe("tool");
		expect(body.messages[1].tool_call_id).toBe("call_1");
		expect(body.messages[1].content).toBe("result");
	});

	// pie: crates/ai/src/providers/openai_completions.rs `image_user_content_uses_image_url`
	it("a user image block serialises as image_url holding a data: URI", async () => {
		const body = await capture(completionsVisionModel(), {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", data: "abc", mimeType: "image/png" },
					],
					timestamp: 0,
				},
			],
		});

		const parts = body.messages[0].content;
		expect(parts[0].type).toBe("text");
		expect(parts[1].type).toBe("image_url");
		expect(String(parts[1].image_url.url).startsWith("data:image/png;base64,")).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// providers/openai_codex_responses.rs
// ─────────────────────────────────────────────────────────────────────────────

describe("openai-codex-responses: instructions instead of a system message", () => {
	// pie: crates/ai/src/providers/openai_codex_responses.rs `body_uses_instructions_not_system_message`
	it("instructions carries the system prompt; store=false, tool_choice=auto, and no system role in input", async () => {
		const body = await capture(
			getModel("openai-codex", "gpt-5.3-codex"),
			{ systemPrompt: "be a coder", messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ apiKey: codexToken(), transport: "sse" },
		);

		expect(body.instructions).toBe("be a coder");
		expect(body.store).toBe(false);
		expect(body.tool_choice).toBe("auto");
		expect((body.input as Array<{ role?: string }>).every((m) => m.role !== "system")).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// providers/google.rs
// ─────────────────────────────────────────────────────────────────────────────

describe("google: the thinking budget goes into generationConfig", () => {
	// pie: crates/ai/src/providers/google.rs `thinking_budget_sets_generation_config`
	// Upstream also asserts includeThoughts is true: setting a budget while asking for no thinking
	// content is a combination with no meaning.
	it("thinkingBudget and includeThoughts go into thinkingConfig together", async () => {
		const body = await capture(getModel("google", "gemini-2.5-flash"), userHi, {
			thinking: { enabled: true, budgetTokens: 4096 },
		});
		const cfg = (body.config ?? body.generationConfig ?? {}) as Record<string, any>;
		const thinking = cfg.thinkingConfig ?? {};
		expect(thinking.thinkingBudget).toBe(4096);
		expect(thinking.includeThoughts).toBe(true);
	});
});
