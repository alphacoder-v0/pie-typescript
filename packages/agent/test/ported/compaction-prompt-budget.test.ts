/**
 * phase 20-4: ports the four inline tests about the **summary prompt budget** from upstream
 * `crates/agent/src/harness/compaction/compaction.rs`.
 *
 * There was nowhere to put them before, because this side had no such layer: the old approach sent
 * the whole prompt and halved it on retry after the provider refused with a context overflow.
 * Upstream trims to the budget **before** sending. The difference is set out above
 * `summarizationPromptBudget` in `compaction.ts`.
 *
 * The assertions are **upstream's**.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	serializeConversationForSummaryBudget,
	summarizationPromptBudget,
} from "../../src/harness/compaction/compaction.ts";
import type { AgentMessage } from "../../src/types.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

/** Upstream's `estimate_text_tokens`: one token per four ASCII characters, one token per non-ASCII
 * character. */
function estimateTextTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (const ch of text) {
		if ((ch.codePointAt(0) ?? 0) < 128) ascii++;
		else nonAscii++;
	}
	return Math.ceil(ascii / 4) + nonAscii;
}

describe("the summary prompt budget", () => {
	// pie: compaction.rs `summary_budget_leaves_room_for_output_and_estimate_error`
	// The budget has to sit **below** (window - output), leaving room for estimation error. Upstream's
	// comment is blunt about it: estimating tokens by character class underestimates code or CJK by
	// 20 to 30 percent, and Anthropic refuses outright when input + max_tokens exceeds the window. The
	// headroom is not caution, it is necessary.
	it("the budget is positive and leaves headroom below (window - output)", () => {
		const model = { contextWindow: 200_000, maxTokens: 64_000 } as never;
		const budget = summarizationPromptBudget(model, DEFAULT_COMPACTION_SETTINGS.reserveTokens);
		expect(budget).toBeGreaterThan(0);
		expect(budget).toBeLessThanOrEqual(Math.floor(((200_000 - 16_384) * 4) / 5));
	});

	// pie: compaction.rs `summary_budget_caps_single_oversized_message`
	// A single oversized message cannot be brought down by dropping messages — drop them all and that
	// one remains. So a tail truncation follows serialisation.
	it("even one oversized message is brought within budget, and the truncation is disclosed", () => {
		const conversation = serializeConversationForSummaryBudget([user("x".repeat(50_000))], 2_000);
		expect(estimateTextTokens(conversation)).toBeLessThanOrEqual(2_000);
		expect(conversation.startsWith("[compaction note: omitted older serialized content")).toBe(true);
	});

	// pie: compaction.rs `cjk_truncation_respects_token_budget`
	// A CJK character is roughly one token but three UTF-8 bytes, so estimating by bytes/4
	// underestimates by about a factor of three. This is the most discriminating case in the group:
	// any implementation that degrades to bytes/4 goes over budget right here.
	it("CJK-heavy content lands within the budget as well", () => {
		const conversation = serializeConversationForSummaryBudget([user("夏".repeat(50_000))], 2_000);
		expect(estimateTextTokens(conversation)).toBeLessThanOrEqual(2_000);
		expect(conversation.includes("[compaction note: omitted")).toBe(true);
	});

	// pie: compaction.rs `compact_trims_summarizer_prompt_before_provider_call`
	// Upstream asserts through an injected stream_fn that the text reaching the provider has already
	// been trimmed. The equivalent assertion here sits at the serialisation layer: 80 messages of 1600
	// characters each come to roughly 32k tokens, and after being brought into a 4000-token budget the
	// result has to (a) actually be smaller, (b) disclose what was dropped, and (c) not contain the
	// oldest one.
	it("trimmed before sending: the oldest content never reaches the provider", () => {
		const messages = Array.from({ length: 80 }, (_, i) => user(`old-msg-${i} ${"x".repeat(1600)}`));
		const conversation = serializeConversationForSummaryBudget(messages, 4_000);

		expect(estimateTextTokens(conversation)).toBeLessThan(4_000);
		expect(conversation.includes("[compaction note: omitted")).toBe(true);
		expect(conversation.includes("old-msg-0 ")).toBe(false);
	});
});
