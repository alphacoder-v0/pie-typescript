/**
 * Model auto-detection. Picks the first provider with credentials in env and resolves a
 * reasonable default model id from the embedded pie-ai catalog.
 *
 * pie: crates/coding-agent/src/model.rs (full-file port).
 *
 * Construct mapping notes:
 * - Oracle calls the process-global `pie_ai::get_model` / `pie_ai::list_models`, which merge the
 *   static catalog with models registered by `local_models.rs` (`register_custom_model`). The TS
 *   equivalent of that merged view is `ModelRegistry` (`core/model-registry.ts`), so both are
 *   taken as injected dependencies rather than importing `@pie/ai`'s static-catalog-only
 *   `getModel`/`listModels` (see `packages/ai/src/models.ts:39-50` for why the static functions
 *   cannot see custom models).
 * - `crate::auth::AuthStore::load().unwrap_or_default()` maps to the already-ported
 *   `core/auth-storage.ts` `AuthStorage` (manifest unit `coding-agent/auth`); `store.get(provider)`
 *   keeps its `Option`→`undefined` shape.
 * - `anyhow::bail!` → `throw new Error(...)` (RULEBOOK §2.4).
 */

import type { Api, Model } from "@pie/ai";
import type { AuthStorage } from "./core/auth-storage.ts";
import type { ModelRegistry } from "./core/model-registry.ts";

/**
 * Resolution candidates in priority order. Each is (env var, provider id, default model id).
 * First env var that's set wins.
 *
 * pie: model.rs:9-18 — order is load-bearing (first match wins) and must not be re-sorted.
 */
export const CANDIDATES: ReadonlyArray<readonly [env: string, provider: string, modelId: string]> = [
	["ANTHROPIC_API_KEY", "anthropic", "claude-haiku-4-5"],
	["OPENAI_API_KEY", "openai", "gpt-4o-mini"],
	["DS4_API_KEY", "ds4", "deepseek-v4-flash"],
	["OPENROUTER_API_KEY", "openrouter", "openai/gpt-4o-mini"],
	["GROQ_API_KEY", "groq", "llama-3.3-70b-versatile"],
	["MISTRAL_API_KEY", "mistral", "mistral-large-latest"],
	["GEMINI_API_KEY", "google", "gemini-2.0-flash"],
	["GOOGLE_API_KEY", "google", "gemini-2.0-flash"],
] as const;

/** Injected view of the two process-global lookups oracle's `model.rs` reaches for. */
export interface ModelDetectionDeps {
	modelRegistry: ModelRegistry;
	/** `crate::auth::AuthStore::load().unwrap_or_default()` (model.rs:36). Omit to skip the
	 * stored-credential fallback, matching a `load()` that yielded the default (empty) store. */
	authStorage?: AuthStorage;
	/** `std::env::var` (model.rs:38). Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

/** pie: model.rs:62 — the exact prefix `main.rs:561` matches on to decide whether to fall back to
 * {@link credentialLessDefault} instead of aborting startup. Keep in sync with both sites. */
export const NO_API_KEY_ERROR_PREFIX = "no API key found";

/**
 * Returns the resolved model + provider id of the chosen entry. If the catalog doesn't
 * contain the default model id, throws so the caller can ask the user to specify a model
 * explicitly.
 *
 * pie: model.rs:23-69 (`auto_detect_model`).
 */
export function autoDetectModel(
	overrideProvider: string | undefined,
	overrideModel: string | undefined,
	deps: ModelDetectionDeps,
): Model<Api> {
	const { modelRegistry } = deps;
	const env = deps.env ?? process.env;

	// Explicit overrides win. pie: model.rs:28-34 — BOTH must be present; a lone --provider or a
	// lone --model falls through to env detection.
	if (overrideProvider !== undefined && overrideModel !== undefined) {
		const m = modelRegistry.find(overrideProvider, overrideModel);
		if (m) {
			return m;
		}
		throw new Error(explicitModelNotFoundMessage(modelRegistry, overrideProvider, overrideModel, true));
	}

	// Detect by env, with the auth.json store as fallback (issue #13). pie: model.rs:36-60.
	for (const [envName, provider, modelId] of CANDIDATES) {
		const raw = env[envName];
		const envSet = raw !== undefined && raw.trim() !== "";
		const stored = deps.authStorage?.get(provider) !== undefined;
		if (!envSet && !stored) {
			continue;
		}
		const m = modelRegistry.find(provider, modelId);
		if (m) {
			return m;
		}
		// Catalog miss — pick *any* model for this provider as a fallback so the agent
		// still runs. pie: model.rs:49-53.
		const any = firstModelForProvider(modelRegistry, provider);
		if (any) {
			return any;
		}
		if (provider === "ds4") {
			throw new Error(explicitModelNotFoundMessage(modelRegistry, provider, modelId, true));
		}
	}

	// pie: model.rs:61-68 — message text is asserted by parity S2 (empty-env print mode).
	throw new Error(
		`${NO_API_KEY_ERROR_PREFIX}. Set one of: ${CANDIDATES.map((c) => c[0]).join(
			", ",
		)} env vars, or run \`/login <provider> <key>\` from inside pie.`,
	);
}

/**
 * Catalog default used when no credential exists anywhere. Lets pie start for
 * notification-only sessions (e.g. summary-mode webhook endpoints); the first model
 * turn surfaces the auth error instead, and `/login` or an env key fixes it live.
 *
 * pie: model.rs:74-79 (`credential_less_default`). The Rust `.expect("embedded model catalog is
 * never empty")` is an allocation-guard (RULEBOOK §2.4) — crash, never silently degrade.
 */
export function credentialLessDefault(modelRegistry: ModelRegistry): Model<Api> {
	const [, provider, modelId] = CANDIDATES[0];
	const model = modelRegistry.find(provider, modelId) ?? modelRegistry.getAll()[0];
	if (!model) {
		throw new Error("embedded model catalog is never empty");
	}
	return model;
}

/** pie: model.rs:81-122 (`explicit_model_not_found_message`). Provider grouping uses a `BTreeMap`
 * (sorted by provider id) and the per-provider candidate list is sorted then truncated to 12 —
 * both orderings are user-visible text, so they are reproduced exactly. */
export function explicitModelNotFoundMessage(
	modelRegistry: ModelRegistry,
	provider: string,
	id: string,
	showLocalHint: boolean,
): string {
	const byProvider = new Map<string, string[]>();
	for (const model of modelRegistry.getAll()) {
		const bucket = byProvider.get(model.provider);
		if (bucket) {
			bucket.push(model.id);
		} else {
			byProvider.set(model.provider, [model.id]);
		}
	}
	// BTreeMap iteration order == sorted keys.
	const sortedProviders = [...byProvider.keys()].sort();

	const models = byProvider.get(provider);
	if (!models) {
		const providers = sortedProviders.map((p) => `${p}(${byProvider.get(p)?.length ?? 0})`).join(", ");
		const hint =
			showLocalHint && provider === "ds4"
				? " For local DS4, pass --base-url http://127.0.0.1:8000/v1, set DS4_BASE_URL, or add ds4 to ~/.pie/models.json."
				: "";
		return `model provider not found in catalog: provider=${provider}. Known providers: ${providers}${hint}`;
	}

	const sorted = [...models].sort();
	const candidates = sorted.slice(0, 12).join(", ");
	const more =
		sorted.length > 12 ? `; run \`/model list ${provider}\` inside pie for all ${sorted.length} models` : "";
	return `model not found in catalog: provider=${provider} id=${id}. Candidates: ${candidates}${more}`;
}

/** pie: model.rs:124-127 (`first_model_for_provider`). */
function firstModelForProvider(modelRegistry: ModelRegistry, provider: string): Model<Api> | undefined {
	return modelRegistry.getAll().find((m) => m.provider === provider);
}
