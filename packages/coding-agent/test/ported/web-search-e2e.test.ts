/**
 * 1:1 port of oracle `crates/coding-agent/tests/web_search_e2e.rs` (pie @0a120dfd).
 *
 * Oracle module doc: "End-to-end test for the web_search tool against a hand-rolled local HTTP
 * server that mimics Brave Search's JSON shape."
 *
 * 1 oracle `#[tokio::test]` function -> 1 test here, name mirrored verbatim.
 *
 * Oracle's trailing comment (web_search_e2e.rs:76-79), reproduced because it explains why there
 * is exactly one test in this file: "The 'missing API key' path is covered by code review + the
 * explicit error message in execute(). We don't ship a test for it because env vars are global to
 * the process and races with the success test above. (cargo --test-threads=1 would work but
 * adding that requirement per file is uglier than the value provided.)"
 *
 * File-wide structural adaptations (naming/architecture translations, not weakened assertions):
 * - Oracle's hand-rolled `TcpListener` + literal HTTP/1.1 bytes become `node:http`'s
 *   `createServer` (the idiom of test/web-search-tool.test.ts). Nothing reaches the real network.
 * - Oracle `WebSearchTool::with_base_url(url)` becomes `createWebSearchTool({ baseUrl })`.
 * - Oracle's `unsafe { std::env::set_var(..) }` / `remove_var` becomes a save/restore of
 *   `process.env.BRAVE_SEARCH_API_KEY` so the hermetic runner's unset state is put back.
 * - Oracle's `result.content[0]` + `UserContentBlock::Text` match becomes `getText()`.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createWebSearchTool } from "../../src/tools/web-search.ts";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	if (block === undefined || block.type !== "text" || block.text === undefined) {
		throw new Error("expected text content");
	}
	return block.text;
}

let server: Server | undefined;
let originalApiKey: string | undefined;

/** pie: web_search_e2e.rs:14-35 (`spawn_mock`). */
function spawnMock(json: string): Promise<string> {
	server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(json);
	});
	const s = server;
	return new Promise((resolve) => {
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			if (addr === null || typeof addr === "string") throw new Error("expected AddressInfo");
			resolve(`http://127.0.0.1:${addr.port}/search`);
		});
	});
}

beforeEach(() => {
	originalApiKey = process.env.BRAVE_SEARCH_API_KEY;
});

afterEach(async () => {
	if (originalApiKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
	else process.env.BRAVE_SEARCH_API_KEY = originalApiKey;
	if (server !== undefined) {
		const s = server;
		server = undefined;
		await new Promise<void>((resolve) => s.close(() => resolve()));
	}
});

const cancel = new AbortController().signal;

// pie: web_search_e2e.rs:37-74
it("web_search_renders_brave_results", async () => {
	const payload = `{
        "web": {
            "results": [
                {"title":"Rust","url":"https://rust-lang.org","description":"safe systems language"},
                {"title":"tokio","url":"https://tokio.rs","description":"async runtime"}
            ]
        }
    }`;
	const url = await spawnMock(payload);
	const tool = createWebSearchTool({ baseUrl: url });

	// Inject the API key needed by the tool.
	process.env.BRAVE_SEARCH_API_KEY = "test-token";

	const res = await tool.execute("call-1", { query: "rust async", count: 2 }, cancel);
	const body = getText(res);
	expect(body, `title 1: ${body}`).toContain("Rust");
	expect(body, `url 1: ${body}`).toContain("https://rust-lang.org");
	expect(body, `title 2: ${body}`).toContain("tokio");
	const details = res.details as { results?: number };
	expect(details.results).toBe(2);
});
