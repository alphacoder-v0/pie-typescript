/**
 * Batch U — of the 40 entries `check:surface-coverage` reports as unmatched, the ones that **are
 * implemented here but have no test coverage at all**.
 *
 * None of the 40 ever entered a roster; `risk-tiers.tsv` covers 473. The gate calls them unmatched,
 * but on inspection most are **misses in the heuristic**: its three variants of snake_case to
 * camelCase and PascalCase cannot match a name that keeps an acronym uppercase (`generate_pkce`
 * becomes `generatePKCE`, not `generatePkce`).
 *
 * This file covers the intersection of missed-by-the-heuristic and genuinely untested: the
 * implementation is there, and no `test/` anywhere references it.
 */

import { describe, expect, it } from "vitest";
import {
	clearApiProviders,
	getApiProviders,
	registerApiProvider,
	unregisterApiProviders,
} from "../../src/api-registry.ts";
import { buildBaseOptions } from "../../src/providers/simple-options.ts";
import { generatePKCE } from "../../src/utils/oauth/pkce.ts";
import { sanitizeSurrogates } from "../../src/utils/sanitize-unicode.ts";

describe("pkce.rs::generate_pkce → generatePKCE", () => {
	it("derives the challenge from the verifier, and both are URL-safe base64", async () => {
		const { verifier, challenge } = await generatePKCE();
		// RFC 7636 §4.1: verifier is 43–128 chars from the unreserved set.
		expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
		// §4.2: challenge is BASE64URL(SHA256(verifier)) — 32 bytes → 43 chars, no padding.
		expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
	});

	it("never repeats a verifier across calls", async () => {
		const a = await generatePKCE();
		const b = await generatePKCE();
		// A reused verifier lets an interceptor replay the code exchange — the whole point of PKCE.
		expect(a.verifier).not.toBe(b.verifier);
	});
});

describe("sanitize_unicode.rs::sanitize_surrogates_u16 → sanitizeSurrogates", () => {
	it("leaves well-formed text untouched, including astral-plane pairs", () => {
		// U+1F600 is a valid surrogate PAIR — it must survive.
		expect(sanitizeSurrogates("hello 😀 世界")).toBe("hello 😀 世界");
	});

	it("replaces a lone surrogate so the string can be JSON-encoded", () => {
		// \uD800 with no trailing pair is unpaired. The receiving end (a provider's JSON parser)
		// rejects the payload, and that failure surfaces as an opaque 400 rather than
		// "your prompt had a bad character".
		const lone = `a${String.fromCharCode(0xd800)}b`;
		const cleaned = sanitizeSurrogates(lone);
		expect(cleaned).not.toContain(String.fromCharCode(0xd800));
	});
});

describe("api_registry.rs::list_api_ids → getApiProviders", () => {
	it("lists exactly the registered api ids, and drops them by source on unregister", () => {
		clearApiProviders();
		const noop = (() => {
			throw new Error("not called");
		}) as never;
		// `unregisterApiProviders` keys on the REGISTERING SOURCE, not on the api name — an
		// extension that registered three apis is removed as a unit when it unloads.
		registerApiProvider({ api: "anthropic-messages", stream: noop, streamSimple: noop }, "ext-a");
		registerApiProvider({ api: "openai-completions", stream: noop, streamSimple: noop }, "ext-b");

		expect(
			getApiProviders()
				.map((p) => p.api)
				.sort(),
		).toEqual(["anthropic-messages", "openai-completions"]);

		unregisterApiProviders("ext-a");
		expect(getApiProviders().map((p) => p.api)).toEqual(["openai-completions"]);
		clearApiProviders();
	});
});

describe("simple_options.rs::translate_base → buildBaseOptions", () => {
	it("threads the api key through and keeps caller options", () => {
		const model = { id: "m", api: "anthropic-messages", provider: "anthropic", name: "m" } as never;
		const out = buildBaseOptions(model, { temperature: 0.5 }, "sk-test");
		// The key must reach the transport layer; dropping it silently turns into a 401 that
		// looks like "wrong credentials" rather than "we never sent them".
		expect(out.apiKey).toBe("sk-test");
		expect(out.temperature).toBe(0.5);
	});

	it("tolerates absent options", () => {
		const model = { id: "m", api: "anthropic-messages", provider: "anthropic", name: "m" } as never;
		expect(buildBaseOptions(model).apiKey).toBeUndefined();
	});
});
