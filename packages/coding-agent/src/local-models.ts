/**
 * Local/custom model definitions loaded by the CLI before model resolution.
 *
 * Port of oracle crates/coding-agent/src/local_models.rs (whole file).
 *
 * This is intentionally a `coding-agent` concern: `pie-ai` already has the in-process custom
 * registry, while the CLI owns user/project configuration and user-visible diagnostics.
 *
 * Construct mapping notes:
 * - Oracle registers into the process-global `pie_ai::register_custom_model`
 *   (crates/ai/src/models.rs:41-50). `packages/ai` has no mutable registry yet — see the scope
 *   note at `packages/ai/src/models.ts:39-50` — and RULEBOOK §4 forbids `ai` reaching back into
 *   `coding-agent`, so the registry lives here for now.
 *   TODO(port): hoist {@link registerCustomModel}/{@link unregisterCustomModel}/{@link getCustomModel}
 *   into `packages/ai` when the `ai/models` unit lands its mutable-registry design, and make
 *   `ModelRegistry` read through it. Until then callers merge {@link LoadedLocalModels.models}
 *   into `ModelRegistry` explicitly.
 * - `serde_json::from_str::<ModelsFile>` maps to typebox validation (RULEBOOK §1, validation). Rust serde
 *   ignores unknown fields by default, so the schemas here do the same.
 * - `std::fs::read_to_string` stays synchronous: `load_all_from_paths_with_base_url` is a sync
 *   `pub fn` in oracle on the hard-sync CLI startup path (RULEBOOK §2.3 case ①).
 * - `anyhow::Context` → `new Error(msg, { cause })` (RULEBOOK §2.4).
 *
 * Note on scope: despite the "local model detection" framing, oracle performs **no** network
 * probing here — no ollama/DS4 endpoint is contacted. It only reads config files and registers a
 * DS4 descriptor when a base URL is configured.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@pie/ai";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
import { isProjectTrusted, noteUntrustedProjectConfig, projectConfigDirIsUserConfigDir } from "./core/project-trust.ts";

/** pie: local_models.rs:14-17 (`struct LoadedLocalModels`). */
export interface LoadedLocalModels {
	models: Model<Api>[];
}

// ---------------------------------------------------------------------------
// Custom model registry — stands in for pie_ai's process-global registry
// (oracle crates/ai/src/models.rs:15-50).
// ---------------------------------------------------------------------------

/** pie: oracle crates/ai/src/models.rs:19-21 — `format!("{}/{}", provider, id)`. */
function registryKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

const customModels = new Map<string, Model<Api>>();

/** pie: oracle crates/ai/src/models.rs:41-45 (`register_custom_model`). Last write wins. */
export function registerCustomModel(model: Model<Api>): void {
	customModels.set(registryKey(model.provider, model.id), model);
}

/** pie: oracle crates/ai/src/models.rs:47-50 (`unregister_custom_model`). */
export function unregisterCustomModel(provider: string, id: string): void {
	customModels.delete(registryKey(provider, id));
}

/** pie: oracle crates/ai/src/models.rs:23-30 (`get_model`), custom half only. */
export function getCustomModel(provider: string, id: string): Model<Api> | undefined {
	return customModels.get(registryKey(provider, id));
}

/** Snapshot of every registered custom model, in registration order. */
export function listCustomModels(): Model<Api>[] {
	return Array.from(customModels.values());
}

// ---------------------------------------------------------------------------
// models.json wire schema — mirrors oracle crates/ai/src/types.rs:558-598.
// Field names are the serde wire names; unknown keys are ignored, as serde does.
// ---------------------------------------------------------------------------

const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);

/** pie: oracle types.rs:97-110 — `ModelThinkingLevel` is `rename_all = "lowercase"`. */
const ThinkingLevelMapSchema = Type.Object({
	off: Type.Optional(ThinkingLevelMapValueSchema),
	minimal: Type.Optional(ThinkingLevelMapValueSchema),
	low: Type.Optional(ThinkingLevelMapValueSchema),
	medium: Type.Optional(ThinkingLevelMapValueSchema),
	high: Type.Optional(ThinkingLevelMapValueSchema),
	xhigh: Type.Optional(ThinkingLevelMapValueSchema),
});

/** pie: oracle types.rs:551-556 — `InputModality` is `rename_all = "lowercase"`. */
const InputModalitySchema = Type.Union([Type.Literal("text"), Type.Literal("image")]);

/** pie: oracle types.rs:558-567 — every field is required (`ModelCost` has no serde default). */
const ModelCostSchema = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
});

const U32 = Type.Integer({ minimum: 0, maximum: 4294967295 });

/**
 * pie: oracle types.rs:573-598 (`struct Model`). Required vs optional follows the serde
 * attributes exactly: `thinkingLevelMap`/`input`/`headers`/`compat` carry `#[serde(default)]`,
 * everything else is mandatory.
 */
const ModelSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	api: Type.String(),
	provider: Type.String(),
	baseUrl: Type.String(),
	reasoning: Type.Boolean(),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(InputModalitySchema)),
	cost: ModelCostSchema,
	contextWindow: U32,
	maxTokens: U32,
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(Type.Unknown()),
});

/** pie: local_models.rs:19-23 (`struct ModelsFile`). `models` carries `#[serde(default)]`. */
const ModelsFileSchema = Type.Object({
	models: Type.Optional(Type.Array(ModelSchema)),
});

const validateModelsFile = Compile(ModelsFileSchema);

type ModelsFile = Static<typeof ModelsFileSchema>;

function toModel(raw: Static<typeof ModelSchema>): Model<Api> {
	return {
		id: raw.id,
		name: raw.name,
		api: raw.api as Api,
		provider: raw.provider,
		baseUrl: raw.baseUrl,
		reasoning: raw.reasoning,
		thinkingLevelMap: raw.thinkingLevelMap,
		// pie: oracle `#[serde(default)]` on `input` yields an empty Vec when the key is absent.
		input: (raw.input ?? []) as ("text" | "image")[],
		cost: raw.cost,
		contextWindow: raw.contextWindow,
		maxTokens: raw.maxTokens,
		headers: raw.headers,
		compat: raw.compat,
	} as Model<Api>;
}

/** pie: local_models.rs:129-134 (`load_file`). Both anyhow contexts are reproduced verbatim. */
function loadFile(path: string): ModelsFile {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (cause) {
		throw new Error(`read ${path}`, { cause });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new Error(`parse ${path}`, { cause });
	}
	if (!validateModelsFile.Check(parsed)) {
		const detail =
			validateModelsFile
				.Errors(parsed)
				.map((error) => `${error.instancePath || "/"}: ${error.message}`)
				.join("; ") || "unknown schema error";
		throw new Error(`parse ${path}`, { cause: new Error(detail) });
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// DS4 built-in default
// ---------------------------------------------------------------------------

/**
 * pie: local_models.rs:92-127 (`ds4_model`).
 *
 * `compat` is `Option<serde_json::Value>` in oracle — free-form JSON, not a typed union — so the
 * eight keys below are carried verbatim even though TS splits them across
 * `OpenAICompletionsCompat` (seven of them) and `OpenAIResponsesCompat` (the last one). Narrowing
 * to `OpenAIResponsesCompat` would silently drop behaviour the local DS4 server depends on.
 */
export function ds4Model(baseUrl: string): Model<Api> {
	return {
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash (local DS4)",
		api: "openai-responses" as Api,
		provider: "ds4",
		baseUrl,
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
		},
		input: ["text"],
		// pie: `ModelCost::default()` — all four fields zero (oracle types.rs:558).
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 384_000,
		headers: undefined,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "deepseek",
			requiresReasoningContentOnAssistantMessages: true,
		},
	} as Model<Api>;
}

/** pie: local_models.rs:83-90 (`ds4_base_url_from_env`). Order is load-bearing: first non-blank wins. */
function ds4BaseUrlFromEnv(env: Record<string, string | undefined>): string | undefined {
	for (const key of ["DS4_BASE_URL", "DS4_URL"]) {
		const value = env[key]?.trim();
		if (value !== undefined && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

/** pie: local_models.rs:75-81 (`ds4_base_url`). A blank CLI value falls through to the env vars. */
export function ds4BaseUrl(
	cliBaseUrl?: string,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const trimmed = cliBaseUrl?.trim();
	if (trimmed !== undefined && trimmed.length > 0) {
		return trimmed;
	}
	return ds4BaseUrlFromEnv(env);
}

/**
 * pie: local_models.rs:66-73 (`register_builtin_local_defaults`).
 *
 * DS4 is a local OpenAI-compatible server, so its base URL is user/environment specific.
 * Register the conventional provider/model only when the URL is explicit; user/project
 * `models.json` entries with the same provider/id are loaded afterwards and override it.
 */
function registerBuiltinLocalDefaults(cliBaseUrl: string | undefined, env: Record<string, string | undefined>): void {
	const baseUrl = ds4BaseUrl(cliBaseUrl, env);
	if (baseUrl !== undefined) {
		registerCustomModel(ds4Model(baseUrl));
	}
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * pie: local_models.rs:38-64 (`load_all_from_paths_with_base_url`).
 *
 * Ordering is behavioural: the DS4 default is registered *before* the files are read, so a file
 * that fails to parse still leaves the DS4 default registered while none of that run's file
 * models are registered (oracle registers only after the whole loop succeeds).
 */
export function loadAllFromPathsWithBaseUrl(
	paths: readonly string[],
	cliBaseUrl?: string,
	env: Record<string, string | undefined> = process.env,
): LoadedLocalModels {
	const models: Model<Api>[] = [];
	registerBuiltinLocalDefaults(cliBaseUrl, env);

	for (const path of paths) {
		if (!existsSync(path)) {
			continue;
		}
		const file = loadFile(path);
		for (const raw of file.models ?? []) {
			const model = toModel(raw);
			const existing = models.findIndex((m) => m.provider === model.provider && m.id === model.id);
			if (existing >= 0) {
				models[existing] = model;
			} else {
				models.push(model);
			}
		}
	}

	for (const model of models) {
		registerCustomModel(model);
	}
	return { models };
}

/** pie: local_models.rs:33-36 (`load_all_from_paths`). */
export function loadAllFromPaths(
	paths: readonly string[],
	env: Record<string, string | undefined> = process.env,
): LoadedLocalModels {
	return loadAllFromPathsWithBaseUrl(paths, undefined, env);
}

/**
 * pie: local_models.rs:25-31 (`load_all`). Path order is load-bearing — project overrides user.
 * Async only because oracle's signature is async; it awaits nothing there either.
 *
 * PORT-DIVERGENCE: B5/B13 family (RULEBOOK §5). The ledger names `.pie/mcp.toml` and
 * `.pie/lsp.toml` as the untrusted-project-config holes; `<cwd>/.pie/models.json` is the third
 * file of the same family, read just as unconditionally by oracle. It is not RCE — the file
 * carries model definitions, not commands — but a `base_url` is enough: opening a hostile
 * repository silently repoints inference at an attacker's endpoint, and every prompt, file
 * excerpt, and tool result in the session goes there. Gating mcp.toml and lsp.toml while leaving
 * this one open would make the trust gate a fence with a gate-shaped hole beside it, so it is
 * gated identically.
 *
 * Reachability note: this was unreachable dead code until phase 17 wired `loadAll` up — it had
 * no importer at all, which is exactly why parity scenario S5's replay diverged. The hole is
 * live now in a way it was not when the ledger was written.
 */
export async function loadAll(
	cwd: string,
	cliBaseUrl?: string,
	env: Record<string, string | undefined> = process.env,
): Promise<LoadedLocalModels> {
	const paths = [join(getAgentDir(), "models.json")];
	// Skipped entirely when `<cwd>/.pie` *is* `~/.pie` (running from `$HOME`): the "project" path
	// would be the user path already in `paths`, so there is nothing to gate — and nothing to load
	// twice either. See `projectConfigDirIsUserConfigDir`.
	if (!projectConfigDirIsUserConfigDir(cwd)) {
		const projectPath = join(cwd, CONFIG_DIR_NAME, "models.json");
		if (isProjectTrusted(cwd)) {
			paths.push(projectPath);
		} else if (existsSync(projectPath)) {
			// Notify only when the file actually exists. An absent config is not a decision the user
			// needs to hear about, and a notice on every run in every untrusted directory is noise
			// that trains people to ignore the one time it matters.
			noteUntrustedProjectConfig(projectPath, cwd);
		}
	}
	return loadAllFromPathsWithBaseUrl(paths, cliBaseUrl, env);
}
