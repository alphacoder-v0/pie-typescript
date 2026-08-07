import { getModel, type Usage } from "@pie/ai";
import { describe, expect, it } from "vitest";
import { CostTracker, fullBreakdown, oneLineSummary, totalCost } from "../../src/harness/cost.ts";
import type { AgentEvent, AgentMessage } from "../../src/types.ts";
import { createUserMessage } from "./session-test-utils.ts";

function usageWithCost(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 10,
		cacheWrite: 5,
		totalTokens: 165,
		cost: { input: 0.001, output: 0.0005, cacheRead: 0.0001, cacheWrite: 0.00005, total: 0.00165 },
		...overrides,
	};
}

describe("CostTracker", () => {
	// pie: crates/agent/src/harness/cost.rs:130-148 (accumulates_usage_and_costs) — ported 1:1.
	it("accumulates usage and costs", () => {
		const tracker = new CostTracker();
		const usage = usageWithCost();
		tracker.record(usage);
		tracker.record(usage);
		const snapshot = tracker.snapshot();
		expect(snapshot.tokens.input).toBe(200);
		expect(snapshot.tokens.output).toBe(100);
		expect(snapshot.tokens.totalTokens).toBe(330);
		expect(snapshot.turnCount).toBe(2);
		expect(totalCost(snapshot)).toBeCloseTo(0.0033, 9);
	});

	// pie: crates/agent/src/harness/cost.rs:151-160 (reset_clears_all_counters) — ported 1:1.
	it("reset clears all counters", () => {
		const tracker = new CostTracker();
		tracker.record({ ...usageWithCost(), input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 });
		expect(tracker.snapshot().tokens.input).toBe(10);
		tracker.reset();
		expect(tracker.snapshot().tokens.input).toBe(0);
		expect(tracker.snapshot().turnCount).toBe(0);
	});

	// pie: cost.rs's CostSnapshot has no model-keyed breakdown anywhere -- every record() call
	// folds into the same single running total regardless of which model/turn produced it.
	it("accumulates into a single running total, not grouped per-model", () => {
		const tracker = new CostTracker();
		tracker.record(usageWithCost({ input: 1 }));
		tracker.record(usageWithCost({ input: 1000 }));
		expect(tracker.snapshot().tokens.input).toBe(1001);
		expect(tracker.snapshot().turnCount).toBe(2);
	});

	it("snapshot() returns an independent copy that later record() calls cannot mutate", () => {
		const tracker = new CostTracker();
		tracker.record(usageWithCost());
		const snapshot = tracker.snapshot();
		tracker.record(usageWithCost());
		expect(snapshot.tokens.input).toBe(100);
		expect(snapshot.tokens.cost.total).toBeCloseTo(0.00165, 9);
	});

	describe("PORT-DIVERGENCE: B3", () => {
		// pie: RULEBOOK §5 B3 (crates/agent/src/harness/cost.rs:58-73) + B3a (crates/ai/src/
		// providers/openai_responses.rs:542-564). The production provider path used to leave every
		// field under `usage.cost` at 0 even though real, non-zero token counts flowed through, so
		// every figure the `/cost` UI showed was $0. record() was never the bug — it sums exactly what
		// it is given — so B3 was emergent, and phase 18 fixes it upstream in packages/ai. These two
		// tests pin the fixed end-to-end behavior at the harness boundary.
		it("real provider usage (now priced by the provider layer) accumulates real dollars through asListener", () => {
			const tracker = new CostTracker();
			// The same token counts this test used before the flip, with cost now filled in exactly as
			// packages/ai's provider layer fills it: claude-sonnet-4-5 at $3/$15/$0.30/$3.75 per million.
			const model = getModel("anthropic", "claude-sonnet-4-5");
			expect(model.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
			const tokens = {
				input: 1_000_000,
				output: 500_000,
				cacheRead: 200_000,
				cacheWrite: 50_000,
				totalTokens: 1_750_000,
			};
			// Exactly what packages/ai's `computeCost` now returns for those rates and those tokens:
			// $3/M * 1M = $3 in, $15/M * 500k = $7.50 out, $0.30/M * 200k = $0.06 cache read,
			// $3.75/M * 50k = $0.1875 cache write, $10.7475 total. Spelled out rather than imported
			// from @pie/ai because this package resolves @pie/ai to packages/ai/dist, whose build can
			// lag src — and a harness-layer test should not depend on that build being current. The
			// provider layer's own pricing is verified in packages/ai's provider tests.
			const realProviderUsage: Usage = {
				...tokens,
				cost: { input: 3, output: 7.5, cacheRead: 0.06, cacheWrite: 0.1875, total: 10.7475 },
			};

			// Drive it through the listener seam, not record() directly: "real provider usage flowing
			// through asListener()" is the exact path B3 broke.
			const listener = tracker.asListener();
			const signal = new AbortController().signal;
			const message: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: realProviderUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			};
			listener({ type: "message_end", message }, signal);
			listener({ type: "message_end", message }, signal);

			const snapshot = tracker.snapshot();
			// Token counts accumulate exactly as before — the flip is about cost, not tokens.
			expect(snapshot.tokens.input).toBe(2_000_000);
			expect(snapshot.tokens.totalTokens).toBe(3_500_000);
			expect(snapshot.turnCount).toBe(2);
			// And cost now tracks the spend instead of staying pinned at 0.
			expect(snapshot.tokens.cost.input).toBeCloseTo(6, 9);
			expect(snapshot.tokens.cost.output).toBeCloseTo(15, 9);
			expect(snapshot.tokens.cost.cacheRead).toBeCloseTo(0.12, 9);
			expect(snapshot.tokens.cost.cacheWrite).toBeCloseTo(0.375, 9);
			expect(totalCost(snapshot)).toBeCloseTo(21.495, 9);
		});

		it("a faux/self-filled Usage.cost (bypassing the provider layer) still works, as it always did", () => {
			// This is exactly oracle's own accumulates_usage_and_costs fixture shape: a
			// hand-constructed Usage with non-zero cost, as if some caller filled in cost
			// out-of-band. The tracker cannot distinguish it from a real provider's output — which is
			// precisely why B3 went unnoticed, and why this path must keep working after the fix
			// rather than being replaced by it.
			const tracker = new CostTracker();
			tracker.record(usageWithCost());
			expect(totalCost(tracker.snapshot())).toBeGreaterThan(0);
		});
	});

	describe("asListener", () => {
		it("records assistant message_end events", () => {
			const tracker = new CostTracker();
			const listener = tracker.asListener();
			const assistant: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: usageWithCost(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const event: AgentEvent = { type: "message_end", message: assistant };
			listener(event, new AbortController().signal);
			expect(tracker.snapshot().turnCount).toBe(1);
			expect(tracker.snapshot().tokens.input).toBe(100);
		});

		it("ignores non-message_end events", () => {
			const tracker = new CostTracker();
			const listener = tracker.asListener();
			listener({ type: "agent_start" }, new AbortController().signal);
			listener({ type: "turn_start" }, new AbortController().signal);
			expect(tracker.snapshot().turnCount).toBe(0);
		});

		it("ignores message_end events for non-assistant messages (user/toolResult/custom)", () => {
			const tracker = new CostTracker();
			const listener = tracker.asListener();
			listener({ type: "message_end", message: createUserMessage("hello") }, new AbortController().signal);
			expect(tracker.snapshot().turnCount).toBe(0);
		});
	});
});

describe("oneLineSummary", () => {
	it("formats the one-line summary exactly like oracle's one_line_summary (cost.rs:95-105)", () => {
		const tracker = new CostTracker();
		tracker.record(usageWithCost());
		tracker.record(usageWithCost());
		const summary = oneLineSummary(tracker.snapshot());
		expect(summary).toBe("tokens: in=200 out=100 cached=30 total=330 | cost $0.0033");
	});

	it("formats zero state", () => {
		const tracker = new CostTracker();
		expect(oneLineSummary(tracker.snapshot())).toBe("tokens: in=0 out=0 cached=0 total=0 | cost $0.0000");
	});
});

describe("fullBreakdown", () => {
	// pie: crates/agent/src/harness/cost.rs:108-127 (full_breakdown) — the exact multi-line
	// layout was reconstructed by hand-simulating Rust's backslash-continuation string literal
	// rules (leading whitespace of each continued line stripped) against the oracle source.
	it("formats the full breakdown exactly like oracle's full_breakdown", () => {
		const tracker = new CostTracker();
		tracker.record(usageWithCost());
		tracker.record(usageWithCost());
		const breakdown = fullBreakdown(tracker.snapshot());
		expect(breakdown).toBe(
			"  turns:        2\n" +
				"\n" +
				"Tokens:\n" +
				"\n" +
				"  input         200\n" +
				"  output        100\n" +
				"  cache read    20\n" +
				"  cache write   10\n" +
				"  total         330\n" +
				"\n" +
				"Cost (USD):\n" +
				"\n" +
				"  input         $0.0020\n" +
				"  output        $0.0010\n" +
				"  cache read    $0.0002\n" +
				"  cache write   $0.0001\n" +
				"  total         $0.0033\n",
		);
	});
});
