/**
 * `web_fetch` built-in tool. GETs a URL, returns the body as text (HTML stripped to a readable
 * plain-text form for v1; a proper readability pass is a follow-up under oracle issue #11).
 *
 * Guards: 15s timeout, 5 MiB body cap, plain GET only (no auth headers, at most 10 redirects).
 * Errors surface as thrown `Error`s so the LLM sees a clear message and can adjust.
 *
 * Body cap is enforced **streaming** via the response body's `ReadableStreamDefaultReader` --
 * we stop reading as soon as the accumulator passes `MAX_BODY_BYTES` and cancel the reader so
 * the connection closes, mirroring oracle's `Response::chunk` streaming cap (never buffers the
 * whole body in memory before checking the size).
 *
 * Port of oracle `crates/coding-agent/src/tools/web_fetch.rs` (pie @0a120dfd). No pi base
 * counterpart (pie-only capability) -- manifest fixes out_path at
 * `packages/coding-agent/src/tools/web-fetch.ts` (sibling to, not inside, `../core/tools/`).
 * Wired into the pie tool registry at `./index.ts` (this phase's `coding-agent/tools/mod` unit).
 */

import type { AgentTool } from "@pie/agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { wrapToolDefinition } from "../core/tools/tool-definition-wrapper.ts";

// pie: crates/coding-agent/src/tools/web_fetch.rs:24
const TIMEOUT_MS = 15_000;
// pie: crates/coding-agent/src/tools/web_fetch.rs:25
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// pie: crates/coding-agent/src/tools/web_fetch.rs:26
const MAX_REDIRECTS = 10;
// pie: crates/coding-agent/src/tools/web_fetch.rs:58 -- oracle:
// `format!("pie/{}", env!("CARGO_PKG_VERSION"))`. The oracle Cargo.toml (workspace + this crate)
// pins CARGO_PKG_VERSION at 0.75.0 as of the pie @0a120dfd snapshot this migration targets.
// TODO(port): version literal must track oracle Cargo.toml, not this npm package's
// package.json (same convention as packages/ai/src/utils/headers.ts's userAgent()).
const USER_AGENT = "pie/0.75.0";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

const webFetchSchema = Type.Object(
	{
		url: Type.String({ description: "Absolute http(s) URL to fetch." }),
	},
	{ additionalProperties: false },
);

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebFetchToolDetails {
	url: string;
	status: number;
	content_type: string;
	bytes: number;
	truncated: boolean;
}

/**
 * Follow redirects manually -- the platform `fetch()`'s built-in follower doesn't expose a
 * max-hop knob, so a hand-rolled loop is the only way to match oracle's
 * `reqwest::redirect::Policy::limited(10)` exactly (10 redirects allowed; the 11th errors).
 *
 * `combinedSignal` (timeout + external cancel, already `AbortSignal.any`-merged by the caller)
 * is passed to every hop's `fetch()` call and to the eventual body read -- oracle's `cancel`
 * token is checked continuously throughout `execute` (both the initial `send()` and every
 * `resp.chunk()` read in the streaming cap loop below), unlike `web_search.rs` which only
 * guards its single `send()` call. See `readBodyCapped` for the chunk-loop half of this.
 */
async function fetchFollowingRedirects(
	url: string,
	combinedSignal: AbortSignal,
	cancelSignal: AbortSignal | undefined,
): Promise<Response> {
	let currentUrl = url;
	let redirectCount = 0;
	for (;;) {
		let response: Response;
		try {
			response = await fetch(currentUrl, {
				method: "GET",
				redirect: "manual",
				signal: combinedSignal,
				headers: { "User-Agent": USER_AGENT },
			});
		} catch (err) {
			if (cancelSignal?.aborted) {
				// pie: crates/coding-agent/src/tools/web_fetch.rs:65-67 ("cancelled")
				throw new Error("cancelled");
			}
			// pie: crates/coding-agent/src/tools/web_fetch.rs:64 ("fetch failed: {e}")
			throw new Error(`fetch failed: ${errorMessage(err)}`);
		}
		const location = response.headers.get("location");
		const isRedirect = response.status >= 300 && response.status < 400 && location !== null;
		if (!isRedirect) {
			return response;
		}
		if (redirectCount >= MAX_REDIRECTS) {
			// pie: crates/coding-agent/src/tools/web_fetch.rs:64 -- reqwest surfaces
			// `Policy::limited` overflow as a `send()` error, folded into the same
			// "fetch failed: {e}" text oracle uses for every other send failure.
			throw new Error("fetch failed: too many redirects");
		}
		redirectCount++;
		currentUrl = new URL(location, currentUrl).toString();
	}
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/**
 * Stream-read the response body until either EOF or `cap` bytes have been accumulated. Returns
 * the captured bytes and whether the body was longer than the cap.
 *
 * pie: crates/coding-agent/src/tools/web_fetch.rs:109-144 (`read_body_capped`) -- the core of
 * the streaming cap: draining chunk-by-chunk (here, via the body's reader) caps memory at
 * `cap + one chunk` and lets the caller stop reading immediately once the cap is hit, instead
 * of buffering the entire body first.
 */
async function readBodyCapped(
	response: Response,
	cap: number,
	cancelSignal: AbortSignal | undefined,
): Promise<{ body: Uint8Array; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) {
		return { body: new Uint8Array(0), truncated: false };
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			let result: Awaited<ReturnType<typeof reader.read>>;
			try {
				result = await reader.read();
			} catch (err) {
				if (cancelSignal?.aborted) {
					// pie: crates/coding-agent/src/tools/web_fetch.rs:125-127 ("cancelled")
					throw new Error("cancelled");
				}
				// pie: crates/coding-agent/src/tools/web_fetch.rs:141 ("read body: {e}")
				throw new Error(`read body: ${errorMessage(err)}`);
			}
			if (result.done) {
				return { body: concatChunks(chunks, total), truncated: false };
			}
			const chunk = result.value;
			if (total + chunk.length > cap) {
				const remaining = cap - total;
				chunks.push(chunk.subarray(0, remaining));
				total += remaining;
				// pie: crates/coding-agent/src/tools/web_fetch.rs:79-81 -- oracle drops `resp`
				// once the cap is hit so the connection closes and the server stops streaming.
				await reader.cancel().catch(() => {});
				return { body: concatChunks(chunks, total), truncated: true };
			}
			chunks.push(chunk);
			total += chunk.length;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Minimal HTML -> text. Strips tags, decodes a small set of entities, collapses whitespace. Not
 * a readability pass (no main-content detection) -- good enough that the LLM can read a docs
 * page without drowning in markup.
 *
 * pie: crates/coding-agent/src/tools/web_fetch.rs:149-262 (`html_to_text` + `collapse_whitespace`
 * + `starts_with_at`). Oracle scans raw UTF-8 *bytes*, matching ASCII tag markers against an
 * ASCII-lowercased copy of the same byte length; this port scans UTF-16 code units instead
 * (JS's native string indexing) against a copy lowercased via `toAsciiLowerCase` below -- which,
 * like Rust's `to_ascii_lowercase()`, only touches `A`-`Z` and therefore preserves the original
 * string's length/index alignment exactly (unlike `String.prototype.toLowerCase()`, which can
 * change length for a handful of non-ASCII codepoints). The two scans agree index-for-index on
 * every ASCII tag/entity boundary oracle actually branches on.
 */
export function htmlToText(html: string): string {
	let out = "";
	let inTag = false;
	let inScriptOrStyle: string | null = null;
	const lower = toAsciiLowerCase(html);
	let i = 0;
	while (i < html.length) {
		if (inScriptOrStyle !== null) {
			if (lower.startsWith(inScriptOrStyle, i)) {
				i += inScriptOrStyle.length;
				inScriptOrStyle = null;
				continue;
			}
			i += codePointLength(html, i);
			continue;
		}
		const c = html[i];
		if (!inTag && c === "<") {
			if (lower.startsWith("<script", i)) {
				inScriptOrStyle = "</script>";
				i += "<script".length;
				continue;
			}
			if (lower.startsWith("<style", i)) {
				inScriptOrStyle = "</style>";
				i += "<style".length;
				continue;
			}
			inTag = true;
			// Treat block-level boundaries as newlines for readability.
			if (
				lower.startsWith("<br", i) ||
				lower.startsWith("<p", i) ||
				lower.startsWith("</p", i) ||
				lower.startsWith("<div", i) ||
				lower.startsWith("</div", i) ||
				lower.startsWith("<li", i) ||
				lower.startsWith("</li", i) ||
				lower.startsWith("<h", i)
			) {
				out += "\n";
			}
			i += 1;
			continue;
		}
		if (inTag) {
			if (c === ">") {
				inTag = false;
			}
			i += codePointLength(html, i);
			continue;
		}
		const chLen = codePointLength(html, i);
		out += html.slice(i, i + chLen);
		i += chLen;
	}
	// Decode a tiny set of HTML entities -- full table is overkill for v1.
	const decoded = out
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&nbsp;", " ");
	return collapseWhitespace(decoded);
}

/** ASCII-only lowercase -- mirrors Rust's `str::to_ascii_lowercase()` (only `A`-`Z` change). */
function toAsciiLowerCase(s: string): string {
	return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** UTF-16 code-unit width of the character starting at `i` (1, or 2 for a surrogate pair). */
function codePointLength(s: string, i: number): number {
	const cp = s.codePointAt(i);
	return cp !== undefined && cp > 0xffff ? 2 : 1;
}

/**
 * pie: crates/coding-agent/src/tools/web_fetch.rs:228-262 (`collapse_whitespace`).
 *
 * Regression note preserved from oracle: whitespace (space/tab) that sits *between* newlines is
 * dropped without resetting the consecutive-newline counter -- only a space that is actually
 * emitted resets it. Without this, indented HTML like `</p>\n   <p>` would collapse to `\n\n\n`
 * (two blank lines) instead of the intended `\n\n` (one blank line).
 */
export function collapseWhitespace(s: string): string {
	let out = "";
	let lastWasSpace = false;
	let consecutiveNewlines = 0;
	for (const c of s) {
		if (c === "\n") {
			consecutiveNewlines += 1;
			if (consecutiveNewlines <= 2) {
				out += "\n";
			}
			lastWasSpace = false;
			continue;
		}
		if (isUnicodeWhitespace(c)) {
			if (!lastWasSpace && !out.endsWith("\n")) {
				out += " ";
				lastWasSpace = true;
				consecutiveNewlines = 0;
			}
			continue;
		}
		consecutiveNewlines = 0;
		lastWasSpace = false;
		out += c;
	}
	return out.trim();
}

function isUnicodeWhitespace(c: string): boolean {
	return /\s/u.test(c);
}

export function createWebFetchToolDefinition(): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails> {
	return {
		name: "web_fetch",
		label: "web_fetch",
		// pie: crates/coding-agent/src/tools/web_fetch.rs:267 (verbatim)
		description:
			"Fetch a URL via HTTP GET. Returns headers + body. For HTML pages, tags are stripped to plain text. Body cap 5 MiB; 15s timeout.",
		promptSnippet: "Fetch a URL via HTTP GET (HTML stripped to plain text)",
		parameters: webFetchSchema,
		// pie: crates/coding-agent/src/tools/web_fetch.rs:38-40
		executionMode: "parallel",
		async execute(_toolCallId, { url }, signal, _onUpdate, _ctx) {
			// pie: crates/coding-agent/src/tools/web_fetch.rs:49-53 -- defensive re-check even
			// though the schema already requires `url`; kept because oracle re-checks it
			// explicitly (a `prepareArguments` compat shim could bypass schema validation).
			if (!url) {
				throw new Error("missing required arg: url");
			}
			if (signal?.aborted) {
				throw new Error("cancelled");
			}

			const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

			const response = await fetchFollowingRedirects(url, combinedSignal, signal);
			const status = response.status;
			// pie: crates/coding-agent/src/tools/web_fetch.rs:71-76
			const contentType = response.headers.get("content-type") ?? "";

			const { body, truncated } = await readBodyCapped(response, MAX_BODY_BYTES, signal);

			// pie: crates/coding-agent/src/tools/web_fetch.rs:83 (`String::from_utf8_lossy`)
			const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
			// pie: crates/coding-agent/src/tools/web_fetch.rs:84-88 -- case-sensitive substring
			// match against the raw header value (bug-for-bug: "text/HTML" would NOT match).
			const rendered = contentType.includes("html") ? htmlToText(text) : text;

			const header = `GET ${url}\nstatus: ${status}\ncontent-type: ${contentType}\nbytes: ${body.length}${
				truncated ? " (truncated)" : ""
			}\n\n`;

			const details: WebFetchToolDetails = {
				url,
				status,
				content_type: contentType,
				bytes: body.length,
				truncated,
			};

			return {
				content: [{ type: "text", text: `${header}${rendered}` }],
				details,
			};
		},
	};
}

export function createWebFetchTool(): AgentTool<typeof webFetchSchema> {
	return wrapToolDefinition(createWebFetchToolDefinition());
}
