// Covers the divergence applied to packages/ai/src/models.ts for manifest unit `ai/models`
// (see migration/reviews/ai/divergence-ledger.tsv): oracle's crates/ai/src/models.rs exposes
// `list_models()` (flat catalog across all providers) and `list_apis()` (distinct api set) as
// part of its crate-root public surface (crates/ai/src/lib.rs `pub use models::{..., list_apis,
// list_models, ...}`), which had no TS counterpart in models.ts prior to this change (flagged by
// the ai/lib and ai/tests/models_catalog ledger entries as out of their batch's scope).
//
// Scope: these two functions cover the *static built-in catalog* only. Oracle's list_models()
// also merges in its process-global custom-model registry (register_custom_model /
// unregister_custom_model, populated from ~/.pie/models.json + <cwd>/.pie/models.json by
// crates/coding-agent/src/local_models.rs in production). That registry is NOT ported here — see
// the ai/models ledger entry for the full reasoning (stateful global registry + KnownProvider
// compile-time-typing tension + dependency on the not-yet-built coding-agent/local_models
// manifest unit) — flagged for the orchestrator rather than applied unilaterally.
import { describe, expect, it } from "vitest";
import { getModels, getProviders, listApis, listModels } from "../src/models.ts";

describe("models.ts catalog-wide surface (listModels/listApis)", () => {
	it("listModels returns the same models as flattening every provider via getModels", () => {
		const flat = listModels();
		const expected = getProviders().flatMap((provider) => getModels(provider));

		expect(flat.length).toBe(expected.length);
		expect(flat.length).toBeGreaterThan(900); // catalog has 32 providers / ~938+ models

		const flatIds = new Set(flat.map((m) => `${m.provider}/${m.id}`));
		const expectedIds = new Set(expected.map((m) => `${m.provider}/${m.id}`));
		expect(flatIds).toEqual(expectedIds);
	});

	it("listModels includes well-known models from multiple providers", () => {
		const flat = listModels();
		expect(flat.some((m) => m.provider === "anthropic")).toBe(true);
		expect(flat.some((m) => m.provider === "openai")).toBe(true);
		expect(flat.some((m) => m.provider === "amazon-bedrock")).toBe(true);
	});

	it("listApis returns the distinct set of api values across the catalog", () => {
		const apis = listApis();
		const expected = new Set(listModels().map((m) => m.api));

		expect(new Set(apis)).toEqual(expected);
		// No duplicates.
		expect(apis.length).toBe(new Set(apis).size);
	});

	it("listApis includes anthropic-messages (mirrors oracle's own smoke assertion)", () => {
		// Mirrors crates/ai/tests/models_catalog.rs::apis_include_anthropic_messages.
		expect(listApis()).toContain("anthropic-messages");
	});
});
