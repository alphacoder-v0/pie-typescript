/**
 * `web_search` tool. Pluggable backend; v1 ships Brave Search via env credential
 * `BRAVE_SEARCH_API_KEY`. Returns ranked results as formatted text.
 *
 * When the backend is unavailable (no API key or empty results), the tool returns a clear
 * error/message so the LLM knows to fall back to `web_fetch` against a known URL.
 *
 * Port of oracle `crates/coding-agent/src/tools/web_search.rs` (pie @0a120dfd). No pi base
 * counterpart (pie-only capability) -- manifest fixes out_path at
 * `packages/coding-agent/src/tools/web-search.ts` (sibling to, not inside, `../core/tools/`).
 * Wired into the pie tool registry at `./index.ts` (this phase's `coding-agent/tools/mod` unit).
 */

import type { AgentTool } from "@pie/agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { wrapToolDefinition } from "../core/tools/tool-definition-wrapper.ts";

// pie: crates/coding-agent/src/tools/web_search.rs:20
const TIMEOUT_MS = 15_000;
// pie: crates/coding-agent/src/tools/web_search.rs:21
const DEFAULT_RESULTS = 10;
// pie: crates/coding-agent/src/tools/web_search.rs:22
const MAX_RESULTS = 20;
// pie: crates/coding-agent/src/tools/web_search.rs:33
const DEFAULT_BASE_URL = "https://api.search.brave.com/res/v1/web/search";
// pie: crates/coding-agent/src/tools/web_search.rs:111 -- oracle:
// `format!("pie/{}", env!("CARGO_PKG_VERSION"))`. Same version-literal caveat as web-fetch.ts's
// USER_AGENT -- TODO(port): must track oracle Cargo.toml, not this npm package's package.json.
const USER_AGENT = "pie/0.75.0";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const webSearchSchema = Type.Object(
	{
		query: Type.String({ description: "Free-text search query." }),
		count: Type.Optional(Type.Integer({ description: "How many results to request (1-20, default 10)." })),
	},
	{ additionalProperties: false },
);

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
	query: string;
	results: number;
}

export interface WebSearchToolOptions {
	/**
	 * Override the backend URL -- used by tests against a local mock server. Production callers
	 * leave this unset (defaults to Brave Search's production endpoint).
	 * pie: crates/coding-agent/src/tools/web_search.rs:37-42 (`with_base_url`)
	 */
	baseUrl?: string;
}

interface BraveResult {
	title?: string;
	url?: string;
	description?: string;
}

/**
 * pie: crates/coding-agent/src/tools/web_search.rs:51-71 (`BraveResponse`/`BraveWeb`/
 * `BraveResult`) -- serde's `#[serde(default)]` on each field means a missing `web` or
 * `web.results` defaults to empty rather than erroring; a genuinely malformed *shape* (wrong
 * JSON type at the top level, or `web`/`web.results` present but not an object/array) is a hard
 * parse error in serde. This port mirrors that top-level strictness but, for individual result
 * fields (`title`/`url`/`description`), falls back to `undefined` on a type mismatch rather than
 * hard-erroring, where serde would reject the whole payload -- TODO(port): no oracle test
 * exercises malformed per-field types, so exact serde-reject-on-type-mismatch fidelity for those
 * leaf fields is deferred.
 */
function parseBraveResults(text: string): BraveResult[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		// pie: crates/coding-agent/src/tools/web_search.rs:139 ("parse response: {e}")
		throw new Error(`parse response: ${errorMessage(err)}`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("parse response: expected a JSON object");
	}
	const web = (parsed as Record<string, unknown>).web;
	if (web === undefined || web === null) {
		return [];
	}
	if (typeof web !== "object") {
		throw new Error('parse response: expected "web" to be an object');
	}
	const results = (web as Record<string, unknown>).results;
	if (results === undefined || results === null) {
		return [];
	}
	if (!Array.isArray(results)) {
		throw new Error('parse response: expected "web.results" to be an array');
	}
	return results.map((r): BraveResult => {
		const rec = typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {};
		return {
			title: typeof rec.title === "string" ? rec.title : undefined,
			url: typeof rec.url === "string" ? rec.url : undefined,
			description: typeof rec.description === "string" ? rec.description : undefined,
		};
	});
}

/**
 * pie: crates/coding-agent/src/tools/web_search.rs:97-101 -- `params.get("count").and_then(|v|
 * v.as_u64())` returns `None` (falling back to `DEFAULT_RESULTS`, NOT clamped up to 1) for
 * anything that isn't a non-negative integer JSON number -- negative counts and fractional
 * counts both fall through to the default rather than being clamped. Only a valid non-negative
 * integer gets `.clamp(1, MAX_RESULTS)` applied. Preserved bug-for-bug.
 */
function resolveCount(count: unknown): number {
	if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
		return Math.min(Math.max(count, 1), MAX_RESULTS);
	}
	return DEFAULT_RESULTS;
}

export function createWebSearchToolDefinition(
	options?: WebSearchToolOptions,
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
	return {
		name: "web_search",
		label: "web_search",
		// pie: crates/coding-agent/src/tools/web_search.rs:182 (verbatim)
		description:
			"Search the web. v1 backend: Brave Search. Requires BRAVE_SEARCH_API_KEY env var. Returns ranked results with title, URL, and description.",
		promptSnippet: "Search the web via Brave Search (requires BRAVE_SEARCH_API_KEY)",
		parameters: webSearchSchema,
		// pie: crates/coding-agent/src/tools/web_search.rs:81-83
		executionMode: "parallel",
		async execute(_toolCallId, { query, count: rawCount }, signal, _onUpdate, _ctx) {
			// pie: crates/coding-agent/src/tools/web_search.rs:92-96 -- defensive re-check even
			// though the schema already requires `query` (same rationale as web-fetch.ts).
			if (!query) {
				throw new Error("missing required arg: query");
			}
			const count = resolveCount(rawCount);

			// pie: crates/coding-agent/src/tools/web_search.rs:103-107
			const apiKey = process.env.BRAVE_SEARCH_API_KEY;
			if (!apiKey) {
				throw new Error("web_search backend not configured: set BRAVE_SEARCH_API_KEY env var");
			}

			if (signal?.aborted) {
				throw new Error("cancelled");
			}

			const url = new URL(baseUrl);
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(count));

			// pie: crates/coding-agent/src/tools/web_search.rs:121-126 -- oracle's `tokio::select!`
			// only guards the `send()` half of the request; the subsequent `resp.text()` body
			// read has NO cancellation check (unlike web_fetch.rs, which re-checks `cancel` on
			// every streamed chunk). Preserved bug-for-bug: `signal` is only wired into the
			// initial `fetch()` call below (via `combinedSignal`, header-wait phase only), not
			// into the later `response.text()` read.
			const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
			let response: Response;
			if (signal) {
				const sendController = new AbortController();
				const combinedSignal = AbortSignal.any([timeoutSignal, sendController.signal]);
				const fetchPromise = fetch(url, {
					method: "GET",
					signal: combinedSignal,
					headers: {
						"X-Subscription-Token": apiKey,
						Accept: "application/json",
						"User-Agent": USER_AGENT,
					},
				});
				let onAbort: () => void;
				const cancelPromise = new Promise<never>((_resolve, reject) => {
					onAbort = () => {
						sendController.abort();
						reject(new Error("cancelled"));
					};
					signal.addEventListener("abort", onAbort, { once: true });
				});
				try {
					response = await Promise.race([fetchPromise, cancelPromise]);
				} catch (err) {
					if (err instanceof Error && err.message === "cancelled") throw err;
					// pie: crates/coding-agent/src/tools/web_search.rs:122 ("search failed: {e}")
					throw new Error(`search failed: ${errorMessage(err)}`);
				} finally {
					signal.removeEventListener("abort", onAbort!);
				}
			} else {
				try {
					response = await fetch(url, {
						method: "GET",
						signal: timeoutSignal,
						headers: {
							"X-Subscription-Token": apiKey,
							Accept: "application/json",
							"User-Agent": USER_AGENT,
						},
					});
				} catch (err) {
					throw new Error(`search failed: ${errorMessage(err)}`);
				}
			}

			const status = response.status;
			// pie: crates/coding-agent/src/tools/web_search.rs:128-131 -- body is always read
			// (regardless of status) before the status check below, no cancellation guard here.
			let text: string;
			try {
				text = await response.text();
			} catch (err) {
				throw new Error(`read body: ${errorMessage(err)}`);
			}
			if (!response.ok) {
				// pie: crates/coding-agent/src/tools/web_search.rs:132-137 -- first 500 Unicode
				// scalar values (not UTF-16 code units) of the body.
				const snippet = Array.from(text).slice(0, 500).join("");
				throw new Error(`search backend status ${status}: ${snippet}`);
			}

			const results = parseBraveResults(text);

			if (results.length === 0) {
				// pie: crates/coding-agent/src/tools/web_search.rs:142-149
				return {
					content: [{ type: "text", text: `no results for query: ${query}` }],
					details: { query, results: 0 },
				};
			}

			// pie: crates/coding-agent/src/tools/web_search.rs:152-156 -- `{query:?}` is Rust's
			// Debug format for a string (double-quoted, escaped); `JSON.stringify` is the closest
			// TS equivalent for the common case of a plain-text query with no exotic control
			// characters.
			let body = `web_search ${JSON.stringify(query)} — top ${results.length} of ${count}:\n\n`;
			results.forEach((r, i) => {
				const title = r.title ?? "(no title)";
				const resultUrl = r.url ?? "(no url)";
				const desc = r.description ?? "";
				body += `${i + 1}. ${title}\n   ${resultUrl}\n`;
				if (desc.length > 0) {
					body += `   ${desc}\n`;
				}
				body += "\n";
			});

			const details: WebSearchToolDetails = { query, results: results.length };

			return {
				content: [{ type: "text", text: body }],
				details,
			};
		},
	};
}

export function createWebSearchTool(options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(options));
}
