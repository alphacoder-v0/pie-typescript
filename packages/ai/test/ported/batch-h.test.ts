/**
 * Batch H — of the low-tier functions in the ai and mcp packages that round four's criteria missed,
 * the ones that are implemented but have no test coverage.
 */

import { describe, expect, it } from "vitest";
import { isCloudflareProvider } from "../../src/providers/cloudflare.ts";

describe("cloudflare.rs::is_cloudflare_provider → isCloudflareProvider", () => {
	it("accepts exactly the two Cloudflare provider ids", () => {
		expect(isCloudflareProvider("cloudflare-workers-ai")).toBe(true);
		expect(isCloudflareProvider("cloudflare-ai-gateway")).toBe(true);
	});

	it("rejects everything else, including near-misses", () => {
		// This predicate gates the `{VAR}` base-URL substitution. A false positive routes a
		// non-Cloudflare provider through placeholder resolution and produces a malformed
		// endpoint; a false negative leaves `{ACCOUNT_ID}` literal in the URL.
		expect(isCloudflareProvider("cloudflare")).toBe(false);
		expect(isCloudflareProvider("anthropic")).toBe(false);
		expect(isCloudflareProvider("")).toBe(false);
	});
});
