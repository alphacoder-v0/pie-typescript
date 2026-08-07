/**
 * phase 21 batch B — the two inline tests in upstream `crates/coding-agent/src/auth.rs`.
 *
 * The other 17 in batch B already have matching assertions here (see
 * `migration/reviews/phase21/batch-b.md`); these two are the only gaps:
 *
 * | upstream test | what was missing |
 * |---|---|
 * | `missing_file_loads_empty_store` | `auth-storage.test.ts:537` covers an auth.json with **blank content** (`""`, `"\n"`, spaces, CRLF). A file that does not exist at all takes the ENOENT branch, which is a different path from parsing an empty string, and had no assertion |
 * | `resolve_for_provider_uses_shared_provider_env_map` | `auth-storage.test.ts:743/764/775` cover env-beats-store, fall-back-to-store, and skip-blank-env, but **all with the single variable ANTHROPIC_API_KEY**. The point of the upstream test is a **decoy**: with another provider's env var also set, it must never satisfy this provider's lookup |
 *
 * The second is a security property. Once the env mapping degrades into "find any API key that is
 * set", the user's `OPENAI_API_KEY` goes to a deepseek endpoint — the other half of the risk the
 * fails-closed test on the store side covers in `main-batch-a.test.ts`.
 *
 * Hermetic: `PIE_DIR` points at a `mkdtemp` directory, restored and removed in `afterEach`; the real
 * `~/.pie/` is neither read nor written, and every credential value is synthetic, suffixed
 * `-synthetic`.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";

describe("AuthStore load/resolve (auth.rs:79-143)", () => {
	const ENV_NAMES = ["PIE_DIR", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
	let dir: string;
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pie-auth-batch-b-"));
		saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
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

	it("a missing auth.json loads as an empty store, and loading does not create it", () => {
		// pie: auth.rs:247-251
		//   let store = AuthStore::load_from(&dir.path().join("nope.json")).unwrap();
		//   assert!(store.providers.is_empty());
		//
		// Upstream's `load_from` has `if !path.exists() { return Ok(Self::default()); }` at :79-91 — a
		// missing file is a **normal empty state**, not an error. `auth-storage.test.ts:537` covers blank
		// content (`""`, `"\n"`, spaces, CRLF), which is the parse branch for "the file is there and
		// empty"; ENOENT is a different one.
		const missing = join(dir, "nope.json");
		expect(existsSync(missing), "precondition: this file has to not exist").toBe(false);

		const store = AuthStorage.create(missing);

		expect(store.list()).toEqual([]);
		expect(store.get("anthropic")).toBeUndefined();
		// Reading credentials must have no side effect: conjuring an empty auth.json for a user who never
		// logged in makes "has this user ever logged in" unanswerable from the filesystem (parity S7
		// caught the same class of problem).
		expect(existsSync(missing), "a read must not create the file").toBe(false);
		// A missing file is not an error, and must not latch a loadError that disables every later write.
		expect(store.getLoadError()).toBeUndefined();
	});

	it("the env map is provider-scoped: another provider's key is not a decoy that satisfies this one", async () => {
		// pie: auth.rs:254-269
		//   let _deepseek = EnvGuard::set("DEEPSEEK_API_KEY", "sk-deepseek-env");
		//   let _openai = EnvGuard::set("OPENAI_API_KEY", "sk-openai-should-not-count");
		//   assert_eq!(store.resolve_for_provider("deepseek").as_deref(), Some("sk-deepseek-env"));
		//   drop(_deepseek);
		//   let _deepseek_removed = EnvGuard::remove("DEEPSEEK_API_KEY");
		//   assert_eq!(store.resolve_for_provider("deepseek"), None);
		const store = AuthStorage.create(join(dir, "auth.json"));

		process.env.DEEPSEEK_API_KEY = "sk-deepseek-env-synthetic";
		process.env.OPENAI_API_KEY = "sk-openai-should-not-count-synthetic";
		expect(await store.getApiKey("deepseek", { includeFallback: false })).toBe("sk-deepseek-env-synthetic");

		// Remove the deepseek variable while the decoy OPENAI_API_KEY stays set: the lookup has to come
		// back empty rather than settle for the decoy. This is the path that sends the user's openai key
		// to a deepseek endpoint.
		delete process.env.DEEPSEEK_API_KEY;
		expect(
			await store.getApiKey("deepseek", { includeFallback: false }),
			"a present OPENAI_API_KEY still must not satisfy a deepseek lookup",
		).toBeUndefined();
	});
});
