/**
 * Tests for the curated model catalog + interactive picker state machine.
 *
 * Ported from the Rust unit tests in oracle crates/coding-agent/src/model_picker.rs:197-366.
 * Oracle's catalog tests reach into the process-global `pie_ai` registry; the TS port injects the
 * model list instead (see the module doc on `src/model-picker.ts`), so the equivalent tests feed
 * fixtures directly. No terminal and no real credentials are involved.
 */

import type { Api, Model } from "@pie/ai";
import { describe, expect, test } from "vitest";
import type { AuthStorage } from "../src/core/auth-storage.ts";
import {
	catalog,
	catalogWith,
	compareUtf8,
	ModelPickerState,
	type ProviderGroup,
	providerHasCredential,
	SUPPORTED_APIS,
} from "../src/model-picker.ts";

/** model_picker.rs:201-217 -- the fixture oracle registers into `pie_ai` for its catalog tests. */
function model(provider: string, id: string, api: string, name = id): Model<Api> {
	return {
		id,
		name,
		api,
		provider,
		baseUrl: "http://localhost:9999/v1",
		reasoning: false,
		input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

/** model_picker.rs:264-289 */
function twoGroups(): ProviderGroup[] {
	return [
		{
			provider: "anthropic",
			hasCredential: true,
			models: [
				{ id: "claude-haiku-4-5", name: "Haiku" },
				{ id: "claude-opus-4-8", name: "Opus" },
			],
		},
		{
			provider: "openai",
			hasCredential: false,
			models: [{ id: "gpt-5.2", name: "GPT" }],
		},
	];
}

// ============================================================================
// catalogWith (model_picker.rs:37-63)
// ============================================================================

describe("catalogWith", () => {
	// model_picker.rs:219-242
	test("keeps the openai and anthropic families only", () => {
		const groups = catalogWith(
			[
				model("picker-test-ds4", "deepseek-v4-flash", "openai-completions"),
				model("picker-test-bedrock", "claude-x", "bedrock-converse-stream"),
			],
			() => true,
		);
		const providers = groups.map((g) => g.provider);
		expect(providers).toContain("picker-test-ds4");
		expect(providers).not.toContain("picker-test-bedrock");
	});

	test("accepts every supported api family and nothing else", () => {
		const models = [
			...SUPPORTED_APIS.map((api, i) => model(`p${i}`, `m${i}`, api)),
			model("nope", "m", "google-generative-ai"),
		];
		expect(catalogWith(models, () => true).map((g) => g.provider)).toEqual(["p0", "p1", "p2", "p3"]);
	});

	// model_picker.rs:244-262
	test("sorts models by id and flags credentials per provider", () => {
		const groups = catalogWith(
			[
				model("openai", "gpt-5.2", "openai-responses"),
				model("anthropic", "claude-opus-4-8", "anthropic-messages"),
				model("anthropic", "claude-haiku-4-5", "anthropic-messages"),
			],
			(provider) => provider === "anthropic",
		);

		const anthropic = groups.find((g) => g.provider === "anthropic");
		expect(anthropic).toBeDefined();
		expect(anthropic!.hasCredential).toBe(true);
		expect(anthropic!.models.map((m) => m.id)).toEqual([...anthropic!.models.map((m) => m.id)].sort(compareUtf8));
		expect(anthropic!.models.map((m) => m.id)).toEqual(["claude-haiku-4-5", "claude-opus-4-8"]);

		const openai = groups.find((g) => g.provider === "openai");
		expect(openai).toBeDefined();
		expect(openai!.hasCredential).toBe(false);
	});

	// model_picker.rs:39,52 -- `BTreeMap` key order.
	test("returns providers in sorted order regardless of input order", () => {
		const groups = catalogWith(
			[
				model("zeta", "a", "openai-completions"),
				model("alpha", "a", "openai-completions"),
				model("mid", "a", "openai-completions"),
			],
			() => true,
		);
		expect(groups.map((g) => g.provider)).toEqual(["alpha", "mid", "zeta"]);
	});

	test("carries the model name through alongside the id", () => {
		const groups = catalogWith([model("anthropic", "claude-haiku-4-5", "anthropic-messages", "Haiku")], () => true);
		expect(groups[0].models).toEqual([{ id: "claude-haiku-4-5", name: "Haiku" }]);
	});

	test("an empty model list yields an empty catalog", () => {
		expect(catalogWith([], () => true)).toEqual([]);
	});
});

describe("compareUtf8", () => {
	test("orders by code point and by length on a shared prefix", () => {
		expect(compareUtf8("a", "b")).toBeLessThan(0);
		expect(compareUtf8("b", "a")).toBeGreaterThan(0);
		expect(compareUtf8("abc", "abc")).toBe(0);
		expect(compareUtf8("ab", "abc")).toBeLessThan(0);
	});

	test("sorts astral code points above the BMP, unlike UTF-16 order", () => {
		// U+1F600 is above U+FFFD, but its UTF-16 lead surrogate (U+D83D) is below it.
		expect(compareUtf8("\u{1F600}", "�")).toBeGreaterThan(0);
		expect("\u{1F600}" < "�").toBe(true);
	});
});

// ============================================================================
// providerHasCredential + catalog (commands.rs:941-958, model_picker.rs:32-35)
// ============================================================================

describe("providerHasCredential", () => {
	test("a non-blank provider env var counts as credentialed", () => {
		expect(providerHasCredential("anthropic", { env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" } })).toBe(true);
	});

	// commands.rs:944-947 -- `!v.trim().is_empty()`.
	test("a blank env var does not count", () => {
		expect(providerHasCredential("anthropic", { env: { ANTHROPIC_API_KEY: "   " } })).toBe(false);
		expect(providerHasCredential("anthropic", { env: {} })).toBe(false);
	});

	// commands.rs:952-958 -- the auth store is the second source.
	test("a stored credential counts even without env", () => {
		const authStorage = { get: (p: string) => (p === "anthropic" ? { type: "api-key" } : undefined) };
		expect(providerHasCredential("anthropic", { env: {}, authStorage: authStorage as unknown as AuthStorage })).toBe(
			true,
		);
		expect(providerHasCredential("openai", { env: {}, authStorage: authStorage as unknown as AuthStorage })).toBe(
			false,
		);
	});

	// commands.rs:3261-3272 -- another provider's key must not satisfy this provider.
	test("another provider's key does not satisfy this provider", () => {
		expect(providerHasCredential("anthropic", { env: { OPENAI_API_KEY: "sk-openai-should-not-count" } })).toBe(false);
	});
});

describe("catalog", () => {
	test("groups the injected registry and flags credentials from env", () => {
		const groups = catalog({
			modelRegistry: {
				getAll: () => [
					model("anthropic", "claude-haiku-4-5", "anthropic-messages"),
					model("openai", "gpt-5.2", "openai-responses"),
					model("bedrock", "claude-x", "bedrock-converse-stream"),
				],
			},
			env: { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
		});

		expect(groups.map((g) => [g.provider, g.hasCredential])).toEqual([
			["anthropic", true],
			["openai", false],
		]);
	});
});

// ============================================================================
// ModelPickerState (model_picker.rs:71-195)
// ============================================================================

describe("ModelPickerState", () => {
	// model_picker.rs:291-298
	test("navigates, descends and selects", () => {
		const p = new ModelPickerState(twoGroups());
		expect(p.enter()).toBeUndefined(); // descend into anthropic
		expect(p.level).toEqual({ kind: "models", providerIdx: 0 });
		p.down();
		expect(p.enter()).toBe("anthropic:claude-opus-4-8");
	});

	// model_picker.rs:300-309
	test("back returns to the providers level, then closes", () => {
		const p = new ModelPickerState(twoGroups());
		p.down(); // openai
		p.enter();
		expect(p.back()).toBe(false); // back to providers…
		expect(p.level).toEqual({ kind: "providers" });
		expect(p.cursor).toBe(1); // …with cursor restored to openai
		expect(p.back()).toBe(true); // top level: close
	});

	// model_picker.rs:311-320
	test("cursor clamps at both bounds", () => {
		const p = new ModelPickerState(twoGroups());
		p.up();
		expect(p.cursor).toBe(0);
		p.down();
		p.down();
		p.down();
		expect(p.cursor).toBe(1); // two providers, clamped
	});

	// model_picker.rs:322-331
	test("starts on the active model when descending", () => {
		const p = new ModelPickerState(twoGroups(), { provider: "anthropic", id: "claude-opus-4-8" });
		p.enter();
		expect(p.cursor).toBe(1); // active model preselected
		const { rows } = p.view(10);
		expect(rows[1].text).toContain("●");
		expect(rows[1].selected).toBe(true);
	});

	// model_picker.rs:117-122 -- an active model belonging to a *different* provider is ignored.
	test("ignores an active model from another provider when descending", () => {
		const p = new ModelPickerState(twoGroups(), { provider: "openai", id: "gpt-5.2" });
		p.enter(); // descends into anthropic (cursor 0)
		expect(p.cursor).toBe(0);
	});

	test("falls back to the first row when the active model is gone", () => {
		const p = new ModelPickerState(twoGroups(), { provider: "anthropic", id: "claude-retired" });
		p.enter();
		expect(p.cursor).toBe(0);
	});

	// model_picker.rs:333-356
	test("view windows around the cursor", () => {
		const groups: ProviderGroup[] = [
			{
				provider: "anthropic",
				hasCredential: true,
				models: Array.from({ length: 20 }, (_, i) => {
					const id = `m-${String(i).padStart(2, "0")}`;
					return { id, name: id };
				}),
			},
		];
		const p = new ModelPickerState(groups);
		p.enter();
		for (let i = 0; i < 15; i++) {
			p.down();
		}
		const { rows } = p.view(5);
		expect(rows).toHaveLength(5);
		expect(rows.some((r) => r.selected && r.text.includes("m-15"))).toBe(true);
		// model_picker.rs:185 -- scrolling down keeps the cursor on the last visible row.
		expect(rows[rows.length - 1].selected).toBe(true);
		expect(rows.map((r) => r.text)).toEqual(["m-11", "m-12", "m-13", "m-14", "m-15"]);
	});

	// model_picker.rs:184-185 -- window pins to the top before the cursor passes the fold.
	test("view pins to the top while the cursor is above the fold", () => {
		const p = new ModelPickerState(twoGroups());
		const { title, rows } = p.view(5);
		expect(title).toBe("Select provider");
		expect(rows.map((r) => r.text)).toEqual(["anthropic (2)", "openai (1) · no key"]);
		expect(rows[0].selected).toBe(true);
	});

	// model_picker.rs:184 -- `visible.max(1)`.
	test("view clamps a zero window to one row", () => {
		const p = new ModelPickerState(twoGroups());
		p.down();
		const { rows } = p.view(0);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ text: "openai (1) · no key", selected: true });
	});

	// model_picker.rs:162-181 -- model-level title and the active marker.
	test("model level titles the provider and marks the active model", () => {
		const p = new ModelPickerState(twoGroups(), { provider: "anthropic", id: "claude-haiku-4-5" });
		p.enter();
		const { title, rows } = p.view(10);
		expect(title).toBe("anthropic models");
		expect(rows.map((r) => r.text)).toEqual(["claude-haiku-4-5 ●", "claude-opus-4-8"]);
	});

	// model_picker.rs:358-365
	test("an empty catalog is inert", () => {
		const p = new ModelPickerState([]);
		expect(p.enter()).toBeUndefined();
		p.down();
		expect(p.cursor).toBe(0);
		expect(p.back()).toBe(true); // closes immediately
		expect(p.view(5)).toEqual({ title: "Select provider", rows: [] });
	});
});
