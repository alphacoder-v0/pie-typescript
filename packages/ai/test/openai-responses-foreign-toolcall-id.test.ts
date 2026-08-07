/**
 * FLIPPED (phase 19, ED1 resolution). This file was inherited from pi and used to assert that a
 * foreign (Copilot-shaped) tool call id is hashed into an `fc_<hash>` and **sent** as the replayed
 * `function_call`'s `id`. Oracle sends no `id` on a function_call anywhere in the crate:
 * `crates/ai/src/providers/openai_responses.rs:702-705` builds exactly
 * `{type, call_id, name, arguments}`, and that one builder is what reaches the wire for all three
 * Responses-family providers — `openai_responses`, `azure_openai_responses` (which imports
 * `build_request_body` wholesale) and `openai_codex_responses` (whose own `build_request_body`
 * calls the same `convert_messages`, :189-192). Parity S9–S12 are the first scenarios to replay a
 * history containing tool calls, and they caught the extra key on `toolwire.norm`.
 *
 * The assertions are not weakened, they are re-pointed at what oracle actually guarantees: the
 * `function_call` item has oracle's exact four keys and no `id`, and the id that does matter —
 * `call_id`, the only handle the API pairs a `function_call` with its `function_call_output` —
 * still survives the 400+ char, `/`+`=`-bearing Copilot composite as a bounded, charset-legal
 * value on BOTH items. That pairing is the thing this test was really protecting; the `fc_<hash>`
 * was only ever needed to make the item-id half of pi's `|`-composite legal enough to transmit,
 * and with the composite gone from the wire there is nothing left to make legal.
 */
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, Context, ToolResultMessage, Usage } from "../src/types.ts";

const COPILOT_RAW_TOOL_CALL_ID =
	"call_4VnzVawQXPB9MgYib7CiQFEY|I9b95oN1wD/cHXKTw3PpRkL6KkCtzTJhUxMouMWYwHeTo2j3htzfSk7YPx2vifiIM4g3A8XXyOj8q4Bt6SLUG7gqY1E3ELkrkVQNHglRfUmWj84lqxJY+Puieb3VKyX0FB+83TUzn91cDMF/4gzt990IzqVrc+nIb9RRscRD070Du16q1glydVjWR0SBJsE6TbY/esOjFpqplogQqrajm1eI++f3eLi73R6q7hVusY0QbeFySVxABCjhN0lXB04caBe1rzHjYzul6MAXj7uq+0r17VLq+yrtyYhN12wkmFqHeqTyEei6EFPbMy24Nc+IbJlkP0OCg02W+gOnyBFcbi2ctvJFSOhSjt1CqBdqCnnhwUqXjbWiT0wh3DmLScRgTHmGkaI+oAcQQjfic65nxj+TnEkReA==";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("OpenAI Responses foreign tool call ID normalization", () => {
	it("replays a foreign Copilot tool call as oracle does: no item id, bounded call_id on both items", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: COPILOT_RAW_TOOL_CALL_ID,
					name: "edit",
					arguments: { path: "src/styles/app.css" },
				},
			],
			api: "openai-responses",
			provider: "github-copilot",
			model: "gpt-5.5",
			usage,
			stopReason: "toolUse",
			timestamp: Date.now() - 2000,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: COPILOT_RAW_TOOL_CALL_ID,
			toolName: "edit",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now() - 1000,
		};
		const context: Context = {
			systemPrompt: "You are concise.",
			messages: [{ role: "user", content: "Use the tool.", timestamp: Date.now() - 3000 }, assistant, toolResult],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]));
		const functionCall = input.find((item) => item.type === "function_call");

		expect(functionCall).toBeDefined();
		expect(functionCall?.type).toBe("function_call");
		if (!functionCall || functionCall.type !== "function_call") {
			throw new Error("Expected function_call item");
		}

		// pie: openai_responses.rs:702-705 — oracle emits these four keys and nothing else. Assert the
		// key set exactly, so a re-introduced `id` (or any other pi-only key) fails here rather than
		// only in parity.
		expect(Object.keys(functionCall).sort()).toEqual(["arguments", "call_id", "name", "type"]);
		expect(functionCall).not.toHaveProperty("id");
		expect(functionCall.id).toBeUndefined();

		// `call_id` is the handle the API actually pairs on, and it must survive the Copilot composite
		// as a legal, bounded value — the concern the old `fc_<hash>` assertion stood in for.
		const expectedCallId = COPILOT_RAW_TOOL_CALL_ID.split("|")[0];
		expect(functionCall.call_id).toBe(expectedCallId);
		expect(functionCall.call_id.length).toBeLessThanOrEqual(64);
		expect(functionCall.call_id).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(functionCall.name).toBe("edit");

		// The pairing survives end to end: the tool result addresses the same call_id.
		const functionCallOutput = input.find((item) => item.type === "function_call_output");
		expect(functionCallOutput).toBeDefined();
		if (!functionCallOutput || functionCallOutput.type !== "function_call_output") {
			throw new Error("Expected function_call_output item");
		}
		expect(functionCallOutput.call_id).toBe(expectedCallId);
	});
});
