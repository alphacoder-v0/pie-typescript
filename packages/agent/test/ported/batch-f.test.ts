/**
 * Batch F — the low-tier functions in the agent package that round four's criteria B, C and D
 * missed between them.
 *
 * Those three were: upstream calls it in cfg(test), the name is a state-changing verb, or it returns
 * a Result. What they missed is precisely the pure, infallible, untested-upstream kind. Those are
 * inconspicuous and still harmful when wrong: let the token estimate drift and compaction fires at
 * the wrong moment, or not at all, which **silently loses context**.
 */

import { describe, expect, it } from "vitest";
import { estimateTextTokens, estimateTokens } from "../../src/harness/compaction/compaction.ts";
import { createCustomMessage } from "../../src/harness/messages.ts";

describe("compaction.rs::estimate_text_tokens → estimateTextTokens", () => {
	it("charges non-ASCII more than ASCII for the same character count", () => {
		// A CJK character costs far more tokens than an ASCII letter. Counting them the same
		// systematically underestimates usage in a Chinese conversation, so compaction holds off until
		// the provider refuses outright.
		const ascii = estimateTextTokens("aaaaaaaaaa");
		const cjk = estimateTextTokens("你你你你你你你你你你");
		expect(cjk).toBeGreaterThan(ascii);
	});

	it("grows with length and returns 0 for empty input", () => {
		expect(estimateTextTokens("")).toBe(0);
		expect(estimateTextTokens("aaaaaaaaaaaaaaaaaaaa")).toBeGreaterThan(estimateTextTokens("aaaaa"));
	});
});

describe("compaction.rs::estimate_tokens → estimateTokens", () => {
	it("counts a plain string user message", () => {
		const msg = { role: "user", content: "hello world" } as never;
		expect(estimateTokens(msg)).toBe(estimateTextTokens("hello world"));
	});

	it("sums the text blocks of a structured user message", () => {
		const msg = {
			role: "user",
			content: [
				{ type: "text", text: "alpha" },
				{ type: "text", text: "beta" },
			],
		} as never;
		// Summing matters: dropping the second block understates the turn, and the
		// understatement compounds across a long conversation.
		expect(estimateTokens(msg)).toBe(estimateTextTokens("alpha") + estimateTextTokens("beta"));
	});
});

describe("messages.rs::custom → createCustomMessage", () => {
	it("takes an ISO timestamp but stores epoch milliseconds", () => {
		const m = createCustomMessage("note", "remember this", true, { k: 1 }, "2026-01-01T00:00:00Z");
		expect(m.customType).toBe("note");
		expect(m.display).toBe(true);
		// The parameter is an ISO string, the field is a number. Storing the string verbatim
		// would break every `timestamp` comparison downstream — and it would do so silently,
		// because `"2026-…" > "2025-…"` happens to sort correctly for same-format strings.
		expect(m.timestamp).toBe(Date.parse("2026-01-01T00:00:00Z"));
	});

	it("keeps display=false distinguishable from display=true", () => {
		// `display` decides whether the entry reaches the UI. Defaulting it to true would
		// leak internal bookkeeping messages into the user's transcript.
		const hidden = createCustomMessage("audit", "internal", false, undefined, "2026-01-01T00:00:00Z");
		expect(hidden.display).toBe(false);
	});
});
