/**
 * The single place token usage totals are finalized.
 *
 * PORT-DIVERGENCE: B1/B2 (RULEBOOK §5, oracle openai_responses.rs:542-564 and
 * openai_completions.rs:442-456). Oracle gives every provider its own `update_usage` that ends with
 * `total = input + output + cache_read + cache_write`, while keeping `input` at the provider's raw
 * value. For the OpenAI Responses/Completions APIs that raw value ALREADY contains the cached
 * tokens, so the cached portion lands in the total twice — the ledger's worked example
 * (input=100 / cacheRead=80 / cacheWrite=20 / output=10) reports 210 where the truth is 110.
 *
 * Phase 18 fixes that by splitting the problem in two:
 *
 *   1. Each provider normalizes ITS OWN API's semantics into an `uncachedInput` — the only step
 *      that cannot be shared, because the APIs disagree: OpenAI's `input_tokens`/`prompt_tokens`
 *      include the cached tokens, Anthropic's `input_tokens` and Bedrock's `inputTokens` exclude
 *      them. Every call site documents which of those it is.
 *   2. This helper owns the arithmetic — one formula, one clamp, one place to change.
 *
 * The total is always recomputed from the parts rather than taken from the provider's own reported
 * total. Vendors do not agree on what "total" means (AWS counts cache tokens in it, some
 * OpenAI-compatible servers do not report one at all, ds4's non-standard `cache_write_tokens` sits
 * outside anything OpenAI specifies), so a reported total is not a usable cross-provider input.
 * Recomputing is also what keeps the invariant the rest of the codebase relies on — and that
 * `test/total-tokens.test.ts` asserts against live providers — true by construction:
 * `totalTokens === input + output + cacheRead + cacheWrite`.
 */

import type { Api, Model, Usage } from "./types.ts";

/** The token counts of a `Usage`, without the cost block. */
export type UsageTokens = Omit<Usage, "cost">;

export interface UsageParts {
	/**
	 * Input tokens that were served fresh — neither read from nor written to the prompt cache.
	 * Callers whose API reports a prompt-token count that already includes the cached tokens must
	 * net them out before passing the value here (see the module doc).
	 */
	uncachedInput: number | undefined;
	/** Generated tokens, including any reasoning tokens the API folds into that count. */
	output: number | undefined;
	/** Input tokens served from the prompt cache. */
	cacheRead?: number | undefined;
	/** Input tokens newly written into the prompt cache by this request. */
	cacheWrite?: number | undefined;
}

/**
 * Normalizes one provider's reported token parts into a `Usage`'s token fields.
 *
 * Every part is clamped to a finite, non-negative number: `undefined`/`NaN` become 0, and a
 * provider that reports more cached tokens than raw input tokens yields `input: 0` rather than a
 * negative count that would then be subtracted back out of the total.
 *
 * Deliberately says nothing about `Usage.cost` — pricing needs the `Model`, which this helper does
 * not take; callers pair this with `computeCost` (below).
 */
export function finalizeUsage(parts: UsageParts): UsageTokens {
	const input = clampCount(parts.uncachedInput);
	const output = clampCount(parts.output);
	const cacheRead = clampCount(parts.cacheRead);
	const cacheWrite = clampCount(parts.cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + cacheRead + cacheWrite + output,
	};
}

function clampCount(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return value > 0 ? value : 0;
}

/** A catalog entry's per-million-token price table (`Model.cost` / `ImagesModel.cost`). */
export type ModelPricing = Model<Api>["cost"];

/**
 * Prices one message's token counts against a model's catalog rates. Returns a fresh cost block;
 * mutates nothing.
 *
 * PORT-DIVERGENCE: B3/B3a (RULEBOOK §5; oracle `crates/ai/src/providers/openai_responses.rs:542-564`
 * and every other provider). Oracle NEVER converts `Model::cost` into `Usage::cost` — no such
 * conversion exists anywhere in oracle's `ai` crate — so `Usage::cost` leaves the provider layer
 * all-zero, and the harness cost tracker (`crates/agent/src/harness/cost.rs:58-73`, a correct
 * sum-only fold over whatever it is handed) faithfully sums those zeros. Every cost the product
 * shows a user — `/cost`, the status-bar summary, the `budget_cap_usd` gate — is therefore $0 no
 * matter how much was actually spent. Phase 18 diverges by pricing at the provider layer, the only
 * layer that holds both the `Model` and the per-message token counts, which leaves the harness fold
 * unchanged.
 *
 * Each bucket is charged at its own rate, so `tokens.input` MUST already be the UNCACHED input:
 * cached tokens are billed at the (much cheaper) `cacheRead`/`cacheWrite` rates and must not also be
 * charged at the full input rate. `finalizeUsage` produces exactly that shape (see B1/B2 above);
 * providers whose API reports input net of cache (Anthropic, Bedrock, Gemini) satisfy it directly.
 */
export function computeCost(pricing: ModelPricing, tokens: UsageTokens): Usage["cost"] {
	const input = perMillion(pricing.input, tokens.input);
	const output = perMillion(pricing.output, tokens.output);
	const cacheRead = perMillion(pricing.cacheRead, tokens.cacheRead);
	const cacheWrite = perMillion(pricing.cacheWrite, tokens.cacheWrite);
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** Catalog rates are $/million tokens. Division first, matching `calculateCost`'s original order. */
function perMillion(ratePerMillion: number, tokens: number): number {
	return (ratePerMillion / 1000000) * tokens;
}
