/**
 * The seam between `local-models.ts` and `ModelRegistry`.
 *
 * Oracle registers local/custom models into the `pie_ai` process global
 * (crates/ai/src/models.rs:41-50) that `get_model` / `list_models` read, so
 * `crates/coding-agent/src/main.rs:551`'s `local_models::load_all(&cwd, cli_base_url)` is all that
 * `model::auto_detect_model` (:552) and every other resolver need. On this side the equivalent
 * merged view is `ModelRegistry`, and `local-models.ts` keeps its own map (see its header note), so
 * `main.ts` must publish one into the other. Without that publish, `pie --provider ds4 --model
 * deepseek-v4-flash` died with `Unknown provider "ds4"` (parity S5) even though the descriptor had
 * been registered.
 *
 * Hermetic: no network and no ollama/DS4 probing (oracle does none either — `local_models.rs` only
 * reads config files). Every call passes an explicit synthetic `env`, the models.json path points
 * into a temp dir but is never created, and the DS4 base URL is an unreachable loopback literal
 * that is never dialed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { listCustomModels, loadAllFromPathsWithBaseUrl, unregisterCustomModel } from "../src/local-models.ts";
import { autoDetectModel } from "../src/model.ts";

const DS4_URL = "http://127.0.0.1:9999/v1";

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pie-local-models-wiring-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
	unregisterCustomModel("ds4", "deepseek-v4-flash");
});

function newRegistry(): ModelRegistry {
	// `models.json` intentionally does not exist: built-in catalog only, so anything found for
	// provider `ds4` can only have come through `setLocalModels`.
	return ModelRegistry.create(AuthStorage.create(join(dir, "auth.json")), join(dir, "models.json"));
}

describe("local-models -> ModelRegistry wiring", () => {
	it("does not know the ds4 provider before the local registry is published", () => {
		const registry = newRegistry();
		expect(registry.find("ds4", "deepseek-v4-flash")).toBeUndefined();

		// The exact parity S5 failure this wiring exists to prevent (model-resolver.ts:370).
		const resolved = resolveCliModel({
			cliProvider: "ds4",
			cliModel: "deepseek-v4-flash",
			modelRegistry: registry,
		});
		expect(resolved.model).toBeUndefined();
		// Flipped for phase 19 F8: the message used to end "Use --list-models to see available
		// providers/models", and `--list-models` is in neither side's `--help` — oracle rejects the
		// flag outright ("tip: a similar argument exists: '--list-sessions'"). It now leads with
		// `/model list`, which the `Model catalog:` block of `pie --help` documents byte-identically
		// on both sides, and mentions `--list-models` second as the spelling that works here.
		expect(resolved.error).toBe(
			'Unknown provider "ds4". Run `/model list` inside pie, or `pie --list-models`, to see available providers and models.',
		);
	});

	it("resolves --provider ds4 --model deepseek-v4-flash once the local registry is published", () => {
		loadAllFromPathsWithBaseUrl([], undefined, { DS4_BASE_URL: DS4_URL });
		const registry = newRegistry();
		registry.setLocalModels(listCustomModels());

		const found = registry.find("ds4", "deepseek-v4-flash");
		expect(found).toBeDefined();
		expect(found?.baseUrl).toBe(DS4_URL);
		expect(found?.api).toBe("openai-responses");

		const resolved = resolveCliModel({
			cliProvider: "ds4",
			cliModel: "deepseek-v4-flash",
			modelRegistry: registry,
		});
		expect(resolved.error).toBeUndefined();
		expect(resolved.model?.provider).toBe("ds4");
		expect(resolved.model?.id).toBe("deepseek-v4-flash");
	});

	it("feeds autoDetectModel, oracle's model.rs:28-34 explicit-override path", () => {
		loadAllFromPathsWithBaseUrl([], DS4_URL, {});
		const registry = newRegistry();
		registry.setLocalModels(listCustomModels());

		const model = autoDetectModel("ds4", "deepseek-v4-flash", { modelRegistry: registry, env: {} });
		expect(model.provider).toBe("ds4");
		expect(model.baseUrl).toBe(DS4_URL);
	});

	it("keeps published local models across refresh(), like oracle's process-global registry", () => {
		loadAllFromPathsWithBaseUrl([], undefined, { DS4_URL: DS4_URL });
		const registry = newRegistry();
		registry.setLocalModels(listCustomModels());
		expect(registry.find("ds4", "deepseek-v4-flash")).toBeDefined();

		registry.refresh();
		expect(registry.find("ds4", "deepseek-v4-flash")?.baseUrl).toBe(DS4_URL);
	});

	it("registers nothing when no DS4 base url is configured (local_models.rs:66-73)", () => {
		loadAllFromPathsWithBaseUrl([], undefined, {});
		const registry = newRegistry();
		registry.setLocalModels(listCustomModels());
		expect(registry.find("ds4", "deepseek-v4-flash")).toBeUndefined();
	});

	it("does not disturb the built-in catalog", () => {
		const before = newRegistry().getAll().length;
		loadAllFromPathsWithBaseUrl([], DS4_URL, {});
		const registry = newRegistry();
		registry.setLocalModels(listCustomModels());
		expect(registry.getAll().length).toBe(before + 1);
	});
});
