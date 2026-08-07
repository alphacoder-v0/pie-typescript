import { MODELS } from "./models.generated.ts";
import type { Api, KnownProvider, Model, ModelThinkingLevel, Usage } from "./types.ts";
import { computeCost } from "./usage.ts";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

/**
 * Flat list of every built-in model across every known provider.
 * pie: crates/ai/src/models.rs `list_models()`.
 *
 * Scope note: oracle's `list_models()` also merges in models registered via its process-global
 * `register_custom_model`/`unregister_custom_model` registry (populated in production from
 * `~/.pie/models.json` + `<cwd>/.pie/models.json` by `crates/coding-agent/src/local_models.rs`).
 * That mutable registry has no port here — see divergence-ledger.tsv unit `ai/models` for why
 * (stateful-registry / `KnownProvider`-typing tension, flagged for the orchestrator; the merge
 * logic itself lives in the separate `coding-agent/local_models` manifest unit). This function
 * covers the static-catalog half only.
 */
export function listModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => getModels(provider));
}

/**
 * Distinct set of `api` values across the built-in catalog.
 * pie: crates/ai/src/models.rs `list_apis()`.
 */
export function listApis(): Api[] {
	return Array.from(new Set(listModels().map((model) => model.api)));
}

/**
 * Prices `usage` in place and returns the new cost block.
 *
 * This keeps the pi-skeleton's original in-place shape, which conflicts with the repo's immutability
 * rule, on purpose: it is part of `@pie/ai`'s exported surface and out-of-tree stream functions call
 * it purely for the side effect, discarding the return value (see
 * `packages/coding-agent/examples/extensions/custom-provider-anthropic/index.ts:459,542`). Making it
 * pure would silently pin those extensions' cost at $0 — the exact defect phase 18 exists to remove.
 * In-tree providers use the non-mutating `computeCost` instead; the arithmetic lives there, so there
 * is exactly one copy of it and the two shapes cannot drift.
 *
 * `usage.input` must already be the uncached input — see `computeCost`'s contract.
 */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost = computeCost(model.cost, usage);
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
