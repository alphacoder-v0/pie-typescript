// Ported from oracle crates/ai/tests/models_catalog.rs (manifest unit ai/tests/models_catalog).
//
// Oracle's own header: "Smoke test for `models_generated.rs`. Validates the JSON catalog parses,
// the loader produces a non-empty list, and a handful of well-known models resolve through
// `get_model`."
//
// API-shape notes (src/models.ts is out of this batch's scope; only its already-existing exports
// are used read-only here):
// - Oracle's `list_models()` takes no provider and returns every catalog model across all
//   providers; base's `getModels(provider)` is scoped per-provider (its `getModel`/`getModels`
//   generics are also compile-time-checked against literal model ids, unlike oracle's runtime
//   `Option`-returning lookup) — ported below via `getProviders().flatMap(getModels)`, which is
//   the closest base-side equivalent to a full catalog dump.
// - Oracle's `list_apis()` returns the distinct set of `.api` values across the *catalog*
//   (crates/ai/src/models.rs:52-58, built from BUILTIN_MODELS, not from the api-registry's
//   registered providers). Base has no `listApis` export at all — this appears to be a genuine gap
//   in packages/ai/src/models.ts's public surface relative to oracle's lib.rs (`pub use
//   models::{..., list_apis, ...}`), discovered while auditing packages/ai/src/index.ts against
//   oracle's lib.rs for this batch's `ai/lib` unit. models.ts/models.rs are not assigned to this
//   batch, so the equivalent set is computed inline here from the existing catalog exports rather
//   than adding a new `listApis` export to models.ts.
import { describe, expect, it } from "vitest";
import { getModel, getModels, getProviders } from "../../src/models.ts";

function allCatalogModels() {
	return getProviders().flatMap((provider) => getModels(provider));
}

describe("models catalog (ported smoke test)", () => {
	it("catalog_is_populated: has hundreds of entries", () => {
		const all = allCatalogModels();
		expect(all.length).toBeGreaterThan(100);
	});

	it("known_anthropic_model_resolves: round-trips through getModel", () => {
		const anthropicModels = getModels("anthropic");
		expect(anthropicModels.length).toBeGreaterThan(0);

		const first = anthropicModels[0];
		const resolved = getModel("anthropic", first.id as never);
		expect(resolved).toBeDefined();
		expect(resolved.provider).toBe("anthropic");
		expect(resolved.id).toBe(first.id);
	});

	it("apis_include_anthropic_messages: catalog-wide api set", () => {
		const apis = new Set<string>(allCatalogModels().map((model) => model.api as string));
		expect(apis.has("anthropic-messages")).toBe(true);
	});

	it("unknown_model_returns_none: getModel returns undefined for an unknown id", () => {
		// Escape hatch for base's compile-time-checked getModel<TProvider, TModelId> generics
		// (oracle's get_model takes an arbitrary runtime &str and returns Option<Model>).
		const resolved = getModel("anthropic", "does-not-exist-xyz" as never);
		expect(resolved).toBeUndefined();
	});
});
