import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCloudflareBaseUrl } from "../src/providers/cloudflare.ts";
import type { Api, Model } from "../src/types.ts";

// pie: crates/ai/src/providers/cloudflare.rs:29-60 (resolve_cloudflare_base_url) — oracle self-
// declares "1:1 port of packages/ai/src/providers/cloudflare.ts" and substitutes `{...}` placeholders
// by walking the string char-by-char with NO charset restriction on the captured name. The base
// implementation previously used a `[A-Z_][A-Z0-9_]*` regex, which silently left non-matching
// `{...}` text unsubstituted instead of attempting the env lookup (and throwing when unset). This
// file ports oracle's two #[test]s (lines 85-98) and locks the oracle-faithful (unrestricted) fix.

function modelWithBase(base: string): Model<Api> {
	return {
		id: "m",
		name: "m",
		api: "openai-completions" as Api,
		provider: "cloudflare-workers-ai",
		baseUrl: base,
		reasoning: false,
		input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
	} as unknown as Model<Api>;
}

describe("resolveCloudflareBaseUrl", () => {
	const ORIGINAL_ENV = { ...process.env };

	beforeEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	// pie: crates/ai/src/providers/cloudflare.rs:86-92 (passthrough_when_no_placeholder)
	it("passes through a URL with no placeholders", () => {
		expect(resolveCloudflareBaseUrl(modelWithBase("https://example.com/v1"))).toBe("https://example.com/v1");
	});

	// pie: crates/ai/src/providers/cloudflare.rs:94-98 (errors_on_missing_env)
	it("throws when a referenced env var is missing", () => {
		delete process.env.CLOUDFLARE_MISSING_VAR_XYZ;
		expect(() => resolveCloudflareBaseUrl(modelWithBase("https://x/{CLOUDFLARE_MISSING_VAR_XYZ}/v1"))).toThrow();
	});

	it("substitutes the standard uppercase-underscore placeholders", () => {
		process.env.CLOUDFLARE_ACCOUNT_ID = "acct123";
		const url = resolveCloudflareBaseUrl(
			modelWithBase("https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"),
		);
		expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1");
	});

	it("throws with the oracle error message shape when the env var is unset", () => {
		delete process.env.CLOUDFLARE_MISSING_VAR_XYZ;
		expect(() => resolveCloudflareBaseUrl(modelWithBase("https://x/{CLOUDFLARE_MISSING_VAR_XYZ}/v1"))).toThrow(
			"CLOUDFLARE_MISSING_VAR_XYZ is required for provider cloudflare-workers-ai but is not set.",
		);
	});

	it("attempts substitution for a non-uppercase placeholder name (oracle has no charset restriction)", () => {
		// oracle's char-walk would try `std::env::var("lower_case_var")` here and error when unset;
		// a `[A-Z_][A-Z0-9_]*`-restricted regex would instead leave `{lower_case_var}` untouched.
		delete process.env.lower_case_var;
		expect(() => resolveCloudflareBaseUrl(modelWithBase("https://x/{lower_case_var}/v1"))).toThrow(
			"lower_case_var is required for provider cloudflare-workers-ai but is not set.",
		);
	});

	it("substitutes a non-uppercase placeholder name when the env var is set", () => {
		process.env.lower_case_var = "resolved";
		expect(resolveCloudflareBaseUrl(modelWithBase("https://x/{lower_case_var}/v1"))).toBe("https://x/resolved/v1");
	});
});
