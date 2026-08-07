/**
 * Tool Call ID Normalization Tests
 *
 * Tests that tool call IDs from OpenAI Responses API (github-copilot, openai-codex, opencode)
 * are properly normalized when sent to other providers.
 *
 * Historically this port captured Responses ids as pi's `{call_id}|{id}` composite, where `{id}`
 * (the server's per-item id) can be 400+ chars with special characters (+, /, =) — the source of
 * the oversized ids this file guards against. Since the ED1 resolution the capture side records
 * `call_id` alone, matching oracle (`crates/ai/src/providers/openai_responses.rs:356`); composites
 * survive only in transcripts written by earlier builds, and are split back to their `call_id` head
 * wherever they reach a wire.
 *
 * Regression test for: https://github.com/earendil-works/pi-mono/issues/1022
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { completeSimple, getEnvApiKey } from "../src/stream.ts";
import type { AssistantMessage, Message, Tool, ToolResultMessage } from "../src/types.ts";
import { resolveApiKey } from "./oauth.ts";

// Resolve API keys
const copilotToken = await resolveApiKey("github-copilot");
const openrouterKey = getEnvApiKey("openrouter");
const codexToken = await resolveApiKey("openai-codex");

// Simple echo tool for testing
const echoToolSchema = Type.Object({
	message: Type.String({ description: "Message to echo back" }),
});

const echoTool: Tool<typeof echoToolSchema> = {
	name: "echo",
	description: "Echoes the message back",
	parameters: echoToolSchema,
};

/**
 * Test 1: Live cross-provider handoff
 *
 * 1. Use github-copilot gpt-5.2-codex to generate a tool call
 * 2. Switch to openrouter openai/gpt-5.2-codex and complete
 * 3. Switch to openai-codex gpt-5.5 and complete
 *
 * Both should succeed without "call_id too long" errors.
 */
describe("Tool Call ID Normalization - Live Handoff", () => {
	it.skipIf(!copilotToken || !openrouterKey)(
		"github-copilot -> openrouter should normalize pipe-separated IDs",
		async () => {
			const copilotModel = getModel("github-copilot", "gpt-5.2-codex");
			const openrouterModel = getModel("openrouter", "openai/gpt-5.2-codex");

			// Step 1: Generate tool call with github-copilot
			const userMessage: Message = {
				role: "user",
				content: "Use the echo tool to echo 'hello world'",
				timestamp: Date.now(),
			};

			const assistantResponse = await completeSimple(
				copilotModel,
				{
					systemPrompt: "You are a helpful assistant. Use the echo tool when asked.",
					messages: [userMessage],
					tools: [echoTool],
				},
				{ apiKey: copilotToken },
			);

			expect(assistantResponse.stopReason, `Copilot error: ${assistantResponse.errorMessage}`).toBe("toolUse");

			const toolCall = assistantResponse.content.find((c) => c.type === "toolCall");
			expect(toolCall).toBeDefined();
			expect(toolCall!.type).toBe("toolCall");

			// FLIPPED (phase 19, ED1 resolution). This used to assert `toolCall.id` contains "|", i.e.
			// pi's `${call_id}|${item_id}` composite. Oracle captures the tool call id as `call_id` and
			// nothing else — `crates/ai/src/providers/openai_responses.rs:356` reads `item["call_id"]`,
			// and `:702-705` replays only `{type, call_id, name, arguments}` — so the composite no
			// longer exists to assert. Parity S9–S12 caught it in both the session record and on the
			// wire.
			//
			// Note what this does to the bug this file guards (pi-mono#1022, "call_id too long"): the
			// 400+ char, `+`/`/`/`=`-bearing half that had to be normalized away was the *item* id,
			// which pi itself glued on at capture time. Dropping the composite removes the oversized id
			// at its source rather than downstream. The assertion below is therefore strengthened, not
			// weakened — it now pins the property the issue was actually about (the id that leaves this
			// provider is short and charset-legal), instead of pinning the composite that caused it.
			if (toolCall?.type === "toolCall") {
				expect(toolCall.id).not.toContain("|");
				expect(toolCall.id).toMatch(/^[a-zA-Z0-9_-]+$/);
				expect(toolCall.id.length).toBeLessThanOrEqual(64);
				console.log(`Tool call ID from github-copilot: ${toolCall.id}`);
			}

			// Create tool result
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: (toolCall as any).id,
				toolName: "echo",
				content: [{ type: "text", text: "hello world" }],
				isError: false,
				timestamp: Date.now(),
			};

			// Step 2: Complete with openrouter (uses openai-completions API)
			const openrouterResponse = await completeSimple(
				openrouterModel,
				{
					systemPrompt: "You are a helpful assistant.",
					messages: [
						userMessage,
						assistantResponse,
						toolResult,
						{ role: "user", content: "Say hi", timestamp: Date.now() },
					],
					tools: [echoTool],
				},
				{ apiKey: openrouterKey },
			);

			// Should NOT fail with "call_id too long" error
			expect(openrouterResponse.stopReason, `OpenRouter error: ${openrouterResponse.errorMessage}`).not.toBe(
				"error",
			);
			expect(openrouterResponse.errorMessage).toBeUndefined();
		},
		60000,
	);

	it.skipIf(!copilotToken || !codexToken)(
		"github-copilot -> openai-codex should normalize pipe-separated IDs",
		async () => {
			const copilotModel = getModel("github-copilot", "gpt-5.2-codex");
			const codexModel = getModel("openai-codex", "gpt-5.5");

			// Step 1: Generate tool call with github-copilot
			const userMessage: Message = {
				role: "user",
				content: "Use the echo tool to echo 'test message'",
				timestamp: Date.now(),
			};

			const assistantResponse = await completeSimple(
				copilotModel,
				{
					systemPrompt: "You are a helpful assistant. Use the echo tool when asked.",
					messages: [userMessage],
					tools: [echoTool],
				},
				{ apiKey: copilotToken },
			);

			expect(assistantResponse.stopReason, `Copilot error: ${assistantResponse.errorMessage}`).toBe("toolUse");

			const toolCall = assistantResponse.content.find((c) => c.type === "toolCall");
			expect(toolCall).toBeDefined();

			// Create tool result
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: (toolCall as any).id,
				toolName: "echo",
				content: [{ type: "text", text: "test message" }],
				isError: false,
				timestamp: Date.now(),
			};

			// Step 2: Complete with openai-codex (uses openai-codex-responses API)
			const codexResponse = await completeSimple(
				codexModel,
				{
					systemPrompt: "You are a helpful assistant.",
					messages: [
						userMessage,
						assistantResponse,
						toolResult,
						{ role: "user", content: "Say hi", timestamp: Date.now() },
					],
					tools: [echoTool],
				},
				{ apiKey: codexToken },
			);

			// Should NOT fail with ID validation error
			expect(codexResponse.stopReason, `Codex error: ${codexResponse.errorMessage}`).not.toBe("error");
			expect(codexResponse.errorMessage).toBeUndefined();
		},
		60000,
	);
});

/**
 * Test 2: Prefilled context with exact failing IDs from issue #1022
 *
 * Uses the exact tool call ID format that caused the error:
 * "call_xxx|very_long_base64_with_special_chars+/="
 */
describe("Tool Call ID Normalization - Prefilled Context", () => {
	// Exact tool call ID from issue #1022 JSONL
	const FAILING_TOOL_CALL_ID =
		"call_pAYbIr76hXIjncD9UE4eGfnS|t5nnb2qYMFWGSsr13fhCd1CaCu3t3qONEPuOudu4HSVEtA8YJSL6FAZUxvoOoD792VIJWl91g87EdqsCWp9krVsdBysQoDaf9lMCLb8BS4EYi4gQd5kBQBYLlgD71PYwvf+TbMD9J9/5OMD42oxSRj8H+vRf78/l2Xla33LWz4nOgsddBlbvabICRs8GHt5C9PK5keFtzyi3lsyVKNlfduK3iphsZqs4MLv4zyGJnvZo/+QzShyk5xnMSQX/f98+aEoNflEApCdEOXipipgeiNWnpFSHbcwmMkZoJhURNu+JEz3xCh1mrXeYoN5o+trLL3IXJacSsLYXDrYTipZZbJFRPAucgbnjYBC+/ZzJOfkwCs+Gkw7EoZR7ZQgJ8ma+9586n4tT4cI8DEhBSZsWMjrCt8dxKg==";

	// Build prefilled context with the failing ID
	function buildPrefilledMessages(): Message[] {
		const userMessage: Message = {
			role: "user",
			content: "Use the echo tool to echo 'hello'",
			timestamp: Date.now() - 2000,
		};

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: FAILING_TOOL_CALL_ID,
					name: "echo",
					arguments: { message: "hello" },
				},
			],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.2-codex",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now() - 1500,
		};

		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: FAILING_TOOL_CALL_ID,
			toolName: "echo",
			content: [{ type: "text", text: "hello" }],
			isError: false,
			timestamp: Date.now() - 1000,
		};

		const followUpUser: Message = {
			role: "user",
			content: "Say hi",
			timestamp: Date.now(),
		};

		return [userMessage, assistantMessage, toolResult, followUpUser];
	}

	it.skipIf(!openrouterKey)(
		"openrouter should handle prefilled context with long pipe-separated IDs",
		async () => {
			const model = getModel("openrouter", "openai/gpt-5.2-codex");
			const messages = buildPrefilledMessages();

			const response = await completeSimple(
				model,
				{
					systemPrompt: "You are a helpful assistant.",
					messages,
					tools: [echoTool],
				},
				{ apiKey: openrouterKey },
			);

			// Should NOT fail with "call_id too long" error
			expect(response.stopReason, `OpenRouter error: ${response.errorMessage}`).not.toBe("error");
			if (response.errorMessage) {
				expect(response.errorMessage).not.toContain("call_id");
				expect(response.errorMessage).not.toContain("too long");
			}
		},
		30000,
	);

	it.skipIf(!codexToken)(
		"openai-codex should handle prefilled context with long pipe-separated IDs",
		async () => {
			const model = getModel("openai-codex", "gpt-5.5");
			const messages = buildPrefilledMessages();

			const response = await completeSimple(
				model,
				{
					systemPrompt: "You are a helpful assistant.",
					messages,
					tools: [echoTool],
				},
				{ apiKey: codexToken },
			);

			// Should NOT fail with ID validation error
			expect(response.stopReason, `Codex error: ${response.errorMessage}`).not.toBe("error");
			if (response.errorMessage) {
				expect(response.errorMessage).not.toContain("id");
				expect(response.errorMessage).not.toContain("additional characters");
			}
		},
		30000,
	);
});
