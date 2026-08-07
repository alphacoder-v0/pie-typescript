/**
 * phase 21 batch A — the three auth-wrapper inline tests in upstream
 * `crates/coding-agent/src/main.rs`.
 *
 * Upstream's `apply_auth_to_simple_options` (main.rs:1225-1258) takes a **provider-scoped** key
 * lookup closure and puts the result into `SimpleStreamOptions.base.api_key`. Each of the three
 * tests holds one of its branches:
 *
 * | upstream test | the property it holds | the counterpart here |
 * |---|---|---|
 * | `auth_wrapper_injects_provider_scoped_stored_key` | finds this provider's stored key | `AuthStorage.getApiKey(p, {includeFallback:false})` |
 * | `auth_wrapper_fails_closed_without_provider_scoped_key` | finds nothing and leaves it empty, **never substituting another provider's** | the same |
 * | `auth_wrapper_keeps_explicit_api_key` | an explicit key wins over a stored one | `setRuntimeApiKey` → `runtimeOverrides` |
 *
 * There was no coverage before: `model-registry.test.ts` asserts header and baseUrl overrides only,
 * and nothing asserts **looking a key up by provider** at all. The middle one is a security
 * property: once it degrades into "find any key", the user's openai key goes to a ds4 endpoint.
 *
 * Hermetic: `PIE_DIR` points at a `mkdtemp` directory, restored and removed in `afterEach`; the real
 * `~/.pie/` is neither read nor written, and every credential value is synthetic, suffixed
 * `-synthetic`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";

describe("apply_auth_to_simple_options (main.rs:1225-1258)", () => {
	const ENV_NAMES = ["PIE_DIR", "DS4_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
	let dir: string;
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pie-auth-wrapper-"));
		saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
		// An env var wins over a stored key (auth-storage.ts:805-818; upstream auth.rs:129-143, "Env var
		// wins"), so these three have to run with no env var set, or they would not be testing the stored
		// key path at all.
		for (const n of ENV_NAMES) delete process.env[n];
		process.env.PIE_DIR = dir;
	});

	afterEach(() => {
		for (const [n, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[n];
			else process.env[n] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	const store = () => AuthStorage.create(join(dir, "auth.json"));

	it("injects the stored key for exactly the model's provider", async () => {
		// pie: main.rs:1364-1370
		//   let opts = apply_auth_to_simple_options(&model("ds4"), None, |provider| {
		//       assert_eq!(provider, "ds4");
		//       Some("stored-ds4-key".into())
		//   });
		//   assert_eq!(opts.base.api_key.as_deref(), Some("stored-ds4-key"));
		const s = store();
		s.set("ds4", { type: "api_key", key: "stored-ds4-key-synthetic" });
		expect(await s.getApiKey("ds4", { includeFallback: false })).toBe("stored-ds4-key-synthetic");
	});

	it("fails closed: another provider's stored key never stands in", async () => {
		// pie: main.rs:1383-1386
		//   let opts = apply_auth_to_simple_options(&model("ds4"), None, |_| None);
		//   assert_eq!(opts.base.api_key, None);
		//
		// Upstream's closure is provider-scoped by construction, so "another provider has a key" never
		// reaches a ds4 lookup there. This constructs the temptation explicitly: the store holds only an
		// openai key, and asking for ds4 has to come back empty.
		const s = store();
		s.set("openai", { type: "api_key", key: "stored-openai-key-synthetic" });
		expect(await s.getApiKey("ds4", { includeFallback: false })).toBeUndefined();
	});

	it("keeps an explicit runtime key instead of the stored one", async () => {
		// pie: main.rs:1373-1380
		//   let mut existing = SimpleStreamOptions::default();
		//   existing.base.api_key = Some("explicit-key".into());
		//   let opts = apply_auth_to_simple_options(&model("ds4"), Some(&existing), |_| {
		//       Some("stored-ds4-key".into())
		//   });
		//   assert_eq!(opts.base.api_key.as_deref(), Some("explicit-key"));
		const s = store();
		s.set("ds4", { type: "api_key", key: "stored-ds4-key-synthetic" });
		s.setRuntimeApiKey("ds4", "explicit-key-synthetic");
		expect(await s.getApiKey("ds4", { includeFallback: false })).toBe("explicit-key-synthetic");
	});
});
