/**
 * Characterization tests for `src/model.ts`.
 * pie: crates/coding-agent/src/model.rs `mod tests` (:129-171) plus the behavior `main.rs:553-567`
 * depends on (the `"no API key found"` prefix that gates the credential-less startup fallback).
 */

import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { autoDetectModel, CANDIDATES, credentialLessDefault, NO_API_KEY_ERROR_PREFIX } from "../../src/model.ts";

function registry(auth = AuthStorage.inMemory()): ModelRegistry {
	return ModelRegistry.inMemory(auth);
}

describe("model auto-detection (pie model.rs)", () => {
	it("credential_less_default is a catalog model", () => {
		// pie: model.rs:134-139
		const modelRegistry = registry();
		const m = credentialLessDefault(modelRegistry);
		expect(m.id).not.toBe("");
		expect(modelRegistry.find(m.provider, m.id)).toBeDefined();
	});

	it("credential_less_default resolves the first candidate entry", () => {
		// pie: model.rs:74-79 — CANDIDATES[0] is anthropic/claude-haiku-4-5.
		const modelRegistry = registry();
		const m = credentialLessDefault(modelRegistry);
		expect([m.provider, m.id]).toEqual([CANDIDATES[0][1], CANDIDATES[0][2]]);
	});

	it("explicit provider+model override wins over env detection", () => {
		// pie: model.rs:28-34 / :160-170
		const modelRegistry = registry();
		const resolved = autoDetectModel("openai", "gpt-4o-mini", {
			modelRegistry,
			env: { ANTHROPIC_API_KEY: "sk-test" },
		});
		expect(resolved.provider).toBe("openai");
		expect(resolved.id).toBe("gpt-4o-mini");
	});

	it("an unknown explicit override reports the catalog candidates", () => {
		// pie: model.rs:33 + :119-121
		const modelRegistry = registry();
		expect(() => autoDetectModel("anthropic", "nope-not-a-model", { modelRegistry })).toThrow(
			/^model not found in catalog: provider=anthropic id=nope-not-a-model\. Candidates: /,
		);
	});

	it("an unknown explicit provider lists known providers", () => {
		// pie: model.rs:89-103 — the ds4 local hint fires only for provider=ds4.
		const modelRegistry = registry();
		expect(() => autoDetectModel("not-a-provider", "x", { modelRegistry })).toThrow(
			/^model provider not found in catalog: provider=not-a-provider\. Known providers: /,
		);
	});

	it("a lone --provider or a lone --model falls through to env detection", () => {
		// pie: model.rs:28 — `if let (Some(p), Some(id))` requires BOTH.
		const modelRegistry = registry();
		const resolved = autoDetectModel("openai", undefined, {
			modelRegistry,
			env: { ANTHROPIC_API_KEY: "sk-test" },
		});
		expect(resolved.provider).toBe("anthropic");
	});

	it("detects by env in CANDIDATES order, first set wins", () => {
		// pie: model.rs:37-48
		const modelRegistry = registry();
		const resolved = autoDetectModel(undefined, undefined, {
			modelRegistry,
			env: { OPENAI_API_KEY: "sk-a", GROQ_API_KEY: "sk-b" },
		});
		expect(resolved.provider).toBe("openai");
		expect(resolved.id).toBe("gpt-4o-mini");
	});

	it("treats a whitespace-only env var as unset", () => {
		// pie: model.rs:38-41 — `.map(|v| !v.trim().is_empty())`
		const modelRegistry = registry();
		const resolved = autoDetectModel(undefined, undefined, {
			modelRegistry,
			env: { ANTHROPIC_API_KEY: "   ", OPENAI_API_KEY: "sk-a" },
		});
		expect(resolved.provider).toBe("openai");
	});

	it("falls back to the auth store when no env var is set (issue #13)", () => {
		// pie: model.rs:36 + :42
		const auth = AuthStorage.inMemory({ groq: { type: "api_key", key: "gsk-test" } });
		const modelRegistry = registry(auth);
		const resolved = autoDetectModel(undefined, undefined, {
			modelRegistry,
			authStorage: auth,
			env: {},
		});
		expect(resolved.provider).toBe("groq");
	});

	it("reports the no-API-key error with the exact prefix main.rs matches on", () => {
		// pie: model.rs:61-68 + main.rs:558-565 (`e.to_string().starts_with("no API key found")`).
		const modelRegistry = registry();
		let message = "";
		try {
			autoDetectModel(undefined, undefined, { modelRegistry, env: {} });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message.startsWith(NO_API_KEY_ERROR_PREFIX)).toBe(true);
		expect(message).toBe(
			"no API key found. Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, DS4_API_KEY, OPENROUTER_API_KEY, " +
				"GROQ_API_KEY, MISTRAL_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY env vars, or run `/login <provider> <key>` " +
				"from inside pie.",
		);
	});
});
