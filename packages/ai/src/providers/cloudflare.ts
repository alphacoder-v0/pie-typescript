import type { Api, Model } from "../types.ts";

/** Workers AI direct endpoint. */
export const CLOUDFLARE_WORKERS_AI_BASE_URL =
	"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1";

/** AI Gateway Unified API. https://developers.cloudflare.com/ai-gateway/usage/unified-api/ */
export const CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat";

/** AI Gateway → OpenAI passthrough. Used until /compat supports /v1/responses. */
export const CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai";

/** AI Gateway → Anthropic passthrough. */
export const CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic";

export function isCloudflareProvider(provider: string): boolean {
	return provider === "cloudflare-workers-ai" || provider === "cloudflare-ai-gateway";
}

/** Substitute `{VAR}` placeholders in a Cloudflare baseUrl from process.env. */
export function resolveCloudflareBaseUrl(model: Model<Api>): string {
	const url = model.baseUrl;
	if (!url.includes("{")) return url;
	// pie: crates/ai/src/providers/cloudflare.rs:36-58 (resolve_cloudflare_base_url) — oracle walks
	// `{...}` placeholders char-by-char with no charset restriction on the name (any bytes up to the
	// next `}`, or to end-of-string if unterminated). A `[A-Z_][A-Z0-9_]*` regex would instead leave
	// non-matching `{...}` text unsubstituted (no throw) instead of attempting the env lookup and
	// erroring — so this mirrors the manual walk instead of a charset-restricted regex.
	let out = "";
	let i = 0;
	while (i < url.length) {
		const ch = url[i];
		if (ch === "{") {
			let j = i + 1;
			let name = "";
			while (j < url.length && url[j] !== "}") {
				name += url[j];
				j++;
			}
			const value = process.env[name];
			if (!value) {
				throw new Error(`${name} is required for provider ${model.provider} but is not set.`);
			}
			out += value;
			i = j + 1;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}
