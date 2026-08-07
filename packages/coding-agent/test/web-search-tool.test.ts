import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createWebSearchTool,
	createWebSearchToolDefinition,
	type WebSearchToolDetails,
} from "../src/tools/web-search.ts";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((c) => c.type === "text")?.text ?? "";
}

function listen(server: Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr === null || typeof addr === "string") throw new Error("expected AddressInfo");
			resolve(`http://127.0.0.1:${addr.port}/search`);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe("web_search tool", () => {
	// pie: crates/coding-agent/src/tools/web_search.rs:201-215 (#[cfg(test)] mod tests) --
	// ported verbatim.
	it("definition_lists_query_as_required", () => {
		const def = createWebSearchToolDefinition();
		const params = def.parameters as unknown as { required: string[] };
		expect(params.required).toContain("query");
	});

	it("should expose the oracle schema shape (name/description/additionalProperties)", () => {
		// pie: crates/coding-agent/src/tools/web_search.rs:179-198 (verbatim description)
		const def = createWebSearchToolDefinition();
		expect(def.name).toBe("web_search");
		expect(def.description).toBe(
			"Search the web. v1 backend: Brave Search. Requires BRAVE_SEARCH_API_KEY env var. Returns ranked results with title, URL, and description.",
		);
		const params = def.parameters as unknown as { additionalProperties: boolean };
		expect(params.additionalProperties).toBe(false);
	});

	describe("execute (network integration against a local mock Brave server)", () => {
		let server: Server | undefined;
		let originalApiKey: string | undefined;

		beforeEach(() => {
			originalApiKey = process.env.BRAVE_SEARCH_API_KEY;
		});

		afterEach(async () => {
			if (originalApiKey === undefined) {
				delete process.env.BRAVE_SEARCH_API_KEY;
			} else {
				process.env.BRAVE_SEARCH_API_KEY = originalApiKey;
			}
			if (server) {
				await close(server);
				server = undefined;
			}
		});

		it("renders Brave results (pie: web_search_e2e.rs::web_search_renders_brave_results)", async () => {
			const payload = JSON.stringify({
				web: {
					results: [
						{ title: "Rust", url: "https://rust-lang.org", description: "safe systems language" },
						{ title: "tokio", url: "https://tokio.rs", description: "async runtime" },
					],
				},
			});
			server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(payload);
			});
			const baseUrl = await listen(server);
			process.env.BRAVE_SEARCH_API_KEY = "test-token";

			const tool = createWebSearchTool({ baseUrl });
			const result = await tool.execute("call-1", { query: "rust async", count: 2 }, undefined, undefined);
			const text = getText(result);
			expect(text).toContain("Rust");
			expect(text).toContain("https://rust-lang.org");
			expect(text).toContain("tokio");
			const details = result.details as WebSearchToolDetails;
			expect(details.results).toBe(2);
		});

		it("errors when BRAVE_SEARCH_API_KEY is unset", async () => {
			delete process.env.BRAVE_SEARCH_API_KEY;
			const tool = createWebSearchTool();
			await expect(tool.execute("call-no-key", { query: "rust" }, undefined, undefined)).rejects.toThrow(
				"web_search backend not configured: set BRAVE_SEARCH_API_KEY env var",
			);
		});

		it("errors with oracle's exact message for a missing query", async () => {
			process.env.BRAVE_SEARCH_API_KEY = "test-token";
			const def = createWebSearchToolDefinition();
			await expect(
				def.execute("call-missing-query", {} as any, undefined, undefined, {} as Parameters<typeof def.execute>[4]),
			).rejects.toThrow("missing required arg: query");
		});

		it("returns 'no results for query' when Brave returns an empty result set", async () => {
			server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ web: { results: [] } }));
			});
			const baseUrl = await listen(server);
			process.env.BRAVE_SEARCH_API_KEY = "test-token";

			const tool = createWebSearchTool({ baseUrl });
			const result = await tool.execute("call-empty", { query: "no such thing" }, undefined, undefined);
			expect(getText(result)).toBe("no results for query: no such thing");
			const details = result.details as WebSearchToolDetails;
			expect(details).toEqual({ query: "no such thing", results: 0 });
		});

		it("surfaces a non-success backend status with a body snippet", async () => {
			server = createServer((_req, res) => {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("internal error");
			});
			const baseUrl = await listen(server);
			process.env.BRAVE_SEARCH_API_KEY = "test-token";

			const tool = createWebSearchTool({ baseUrl });
			await expect(tool.execute("call-500", { query: "rust" }, undefined, undefined)).rejects.toThrow(
				"search backend status 500: internal error",
			);
		});

		it("errors on malformed JSON with 'parse response: ...'", async () => {
			server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end("not json");
			});
			const baseUrl = await listen(server);
			process.env.BRAVE_SEARCH_API_KEY = "test-token";

			const tool = createWebSearchTool({ baseUrl });
			await expect(tool.execute("call-bad-json", { query: "rust" }, undefined, undefined)).rejects.toThrow(
				/^parse response: /,
			);
		});

		// pie: crates/coding-agent/src/tools/web_search.rs:97-101 -- negative/fractional counts
		// fall back to DEFAULT_RESULTS (10) rather than clamping up to 1; valid non-negative
		// integers clamp into [1, MAX_RESULTS].
		it.each([
			{ count: undefined, expected: 10 },
			{ count: -5, expected: 10 },
			{ count: 0, expected: 1 },
			{ count: 999, expected: 20 },
			{ count: 7, expected: 7 },
		])("resolves count=$count to $expected in the rendered header", async ({ count, expected }) => {
			server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ web: { results: [{ title: "t", url: "u", description: "d" }] } }));
			});
			const baseUrl = await listen(server);
			process.env.BRAVE_SEARCH_API_KEY = "test-token";

			const tool = createWebSearchTool({ baseUrl });
			const result = await tool.execute("call-count", { query: "q", count } as any, undefined, undefined);
			expect(getText(result)).toContain(`of ${expected}:`);
		});

		it("rejects immediately when the signal is already aborted", async () => {
			process.env.BRAVE_SEARCH_API_KEY = "test-token";
			const def = createWebSearchToolDefinition();
			const controller = new AbortController();
			controller.abort();
			await expect(
				def.execute(
					"call-pre-aborted",
					{ query: "rust" },
					controller.signal,
					undefined,
					{} as Parameters<typeof def.execute>[4],
				),
			).rejects.toThrow("cancelled");
		});
	});
});
