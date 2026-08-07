/**
 * Unit coverage for the shared helpers in packages/ai/src/usage.ts:
 *
 * - `finalizeUsage` — the single place PORT-DIVERGENCE: B1/B2 (RULEBOOK §5) puts the token-total
 *   arithmetic. Provider-level coverage lives in test/openai-responses-oracle-parity.test.ts,
 *   test/openai-responses-shared-usage-propagation.test.ts and
 *   test/openai-completions-tool-choice.test.ts.
 * - `computeCost` — the single place PORT-DIVERGENCE: B3/B3a puts the pricing arithmetic.
 *   Provider-level coverage lives in test/anthropic-oracle-parity.test.ts,
 *   test/bedrock-usage-and-stop-reason.test.ts, test/google-oracle-parity.test.ts,
 *   test/google-vertex-oracle-parity.test.ts and
 *   test/openai-responses-copilot-provider.test.ts.
 */
import { describe, expect, it } from "vitest";
import { computeCost, finalizeUsage } from "../src/usage.ts";

describe("finalizeUsage", () => {
	it("counts cached input exactly once on the RULEBOOK §5 B1/B2 worked example", () => {
		// The provider reported input=100 with 80 of those served from cache and 20 written to it,
		// plus 10 generated tokens. Oracle reported total=210; the correct total is 110.
		expect(
			finalizeUsage({
				uncachedInput: 100 - 80 - 20,
				output: 10,
				cacheRead: 80,
				cacheWrite: 20,
			}),
		).toEqual({
			input: 0,
			output: 10,
			cacheRead: 80,
			cacheWrite: 20,
			totalTokens: 110,
		});
	});

	it("keeps the total equal to the sum of the parts when nothing is cached", () => {
		expect(
			finalizeUsage({
				uncachedInput: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
			}),
		).toEqual({
			input: 100,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 110,
		});
	});

	it("treats omitted cache fields as zero", () => {
		expect(finalizeUsage({ uncachedInput: 7, output: 3 })).toEqual({
			input: 7,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
		});
	});

	it("treats explicitly undefined parts as zero", () => {
		expect(
			finalizeUsage({
				uncachedInput: undefined,
				output: undefined,
				cacheRead: undefined,
				cacheWrite: undefined,
			}),
		).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		});
	});

	it("returns an all-zero block for an all-zero report", () => {
		expect(finalizeUsage({ uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		});
	});

	it("clamps a negative uncachedInput to zero instead of subtracting it from the total", () => {
		// A server that reports more cached tokens than raw input tokens (cacheRead 90 + cacheWrite 20
		// against input 100) must not drive `input` negative and shrink the total below the cache
		// buckets it actually reported.
		expect(
			finalizeUsage({
				uncachedInput: 100 - 90 - 20,
				output: 5,
				cacheRead: 90,
				cacheWrite: 20,
			}),
		).toEqual({
			input: 0,
			output: 5,
			cacheRead: 90,
			cacheWrite: 20,
			totalTokens: 115,
		});
	});

	it("clamps non-finite counts to zero", () => {
		expect(
			finalizeUsage({
				uncachedInput: Number.NaN,
				output: Number.POSITIVE_INFINITY,
				cacheRead: 4,
				cacheWrite: 0,
			}),
		).toEqual({
			input: 0,
			output: 0,
			cacheRead: 4,
			cacheWrite: 0,
			totalTokens: 4,
		});
	});

	it("always recomputes the total rather than trusting any caller-supplied one", () => {
		// finalizeUsage takes no `total` input at all — vendors disagree on what a reported total
		// includes, so `totalTokens === input + output + cacheRead + cacheWrite` holds by construction.
		const usage = finalizeUsage({ uncachedInput: 11, output: 13, cacheRead: 17, cacheWrite: 19 });
		expect(usage.totalTokens).toBe(usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
		expect(usage.totalTokens).toBe(60);
	});
});

describe("computeCost", () => {
	// Shaped like a real catalog entry: $/million tokens, cache read far cheaper than fresh input.
	const pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

	it("bills each bucket at its own per-million rate", () => {
		expect(
			computeCost(pricing, {
				input: 1_000_000,
				output: 500_000,
				cacheRead: 200_000,
				cacheWrite: 50_000,
				totalTokens: 0,
			}),
		).toEqual({ input: 3, output: 7.5, cacheRead: 0.06, cacheWrite: 0.1875, total: 10.7475 });
	});

	it("charges cached tokens once, at the cache rate — never also at the full input rate", () => {
		// This is the whole point of pairing it with finalizeUsage: 100 prompt tokens of which 80 were
		// cache reads must cost 20 * $3/M + 80 * $0.30/M, not 100 * $3/M + 80 * $0.30/M.
		const tokens = finalizeUsage({ uncachedInput: 100 - 80, output: 0, cacheRead: 80, cacheWrite: 0 });
		const cost = computeCost(pricing, tokens);
		expect(cost.input).toBeCloseTo(0.00006, 12); // $3/M * 20
		expect(cost.cacheRead).toBeCloseTo(0.000024, 12); // $0.30/M * 80
		expect(cost.total).toBeCloseTo(0.000084, 12);
		// The naive "price the raw prompt count" figure this must NOT produce.
		expect(cost.total).not.toBeCloseTo((3 / 1000000) * 100 + (0.3 / 1000000) * 80, 12);
	});

	it("keeps total equal to the sum of its four parts", () => {
		const cost = computeCost(pricing, { input: 11, output: 13, cacheRead: 17, cacheWrite: 19, totalTokens: 60 });
		expect(cost.total).toBeCloseTo(cost.input + cost.output + cost.cacheRead + cost.cacheWrite, 15);
	});

	it("returns an all-zero block for a free model", () => {
		expect(
			computeCost(
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				{
					input: 1_000_000,
					output: 1_000_000,
					cacheRead: 1_000_000,
					cacheWrite: 1_000_000,
					totalTokens: 4_000_000,
				},
			),
		).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	});

	it("does not mutate its arguments (unlike the legacy calculateCost shape)", () => {
		const tokens = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100 };
		const frozenPricing = Object.freeze({ ...pricing });
		const cost = computeCost(frozenPricing, Object.freeze(tokens));
		expect(tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100 });
		expect(frozenPricing).toEqual(pricing);
		expect(cost.total).toBeGreaterThan(0);
	});
});
