import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	collapseWhitespace,
	createWebFetchTool,
	createWebFetchToolDefinition,
	htmlToText,
	type WebFetchToolDetails,
} from "../src/tools/web-fetch.ts";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((c) => c.type === "text")?.text ?? "";
}

function listen(server: Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr === null || typeof addr === "string") throw new Error("expected AddressInfo");
			resolve(`http://127.0.0.1:${addr.port}`);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe("web_fetch tool", () => {
	// pie: crates/coding-agent/src/tools/web_fetch.rs:282-365 (#[cfg(test)] mod tests) -- ported
	// verbatim against the exported `htmlToText`/`collapseWhitespace` helpers.
	describe("htmlToText / collapseWhitespace (ported oracle unit tests)", () => {
		it("strips_html_tags_and_decodes_entities", () => {
			const html = "<html><body><h1>Title</h1><p>Hello &amp; world</p><script>alert(1)</script></body></html>";
			const text = htmlToText(html);
			expect(text).toContain("Title");
			expect(text).toContain("Hello & world");
			expect(text).not.toContain("alert");
		});

		it("html_to_text_preserves_non_ascii_text", () => {
			const html = "<html><body><p>你好，世界</p><div>emoji: 🦀</div></body></html>";
			const text = htmlToText(html);
			expect(text).toContain("你好，世界");
			expect(text).toContain("emoji: 🦀");
		});

		it("html_to_text_handles_replacement_char_from_truncated_utf8", () => {
			const html = "<html><body><script>const x = 'ignored � text';</script><p>done �</p></body></html>";
			const text = htmlToText(html);
			expect(text).toBe("done �");
		});

		it("html_to_text_handles_nbsp_inside_script_without_byte_boundary_panic", () => {
			const html = "<html><body><script>const x = 'ignored text';</script><p>done</p></body></html>";
			const text = htmlToText(html);
			expect(text).toBe("done");
		});

		it("collapse_whitespace_keeps_paragraph_breaks", () => {
			const s = "a   b\n\n\n\nc";
			expect(collapseWhitespace(s)).toBe("a b\n\nc");
		});

		it("collapse_whitespace_caps_blank_lines_through_indented_html", () => {
			const s = "\npara1\n\n   \npara2\n\n   \npara3\n";
			const collapsed = collapseWhitespace(s);
			expect(collapsed).toBe("para1\n\npara2\n\npara3");
			expect(collapsed).not.toContain("\n\n\n");
		});

		it("html_to_text_indented_paragraphs_have_single_blank_line_between", () => {
			const html = "<html><body>\n   <p>para1</p>\n   <p>para2</p>\n   <p>para3</p>\n</body></html>";
			const text = htmlToText(html);
			expect(text).toContain("para1");
			expect(text).toContain("para2");
			expect(text).toContain("para3");
			expect(text).not.toContain("\n\n\n");
		});
	});

	it("should expose the oracle schema shape (name/description/required/additionalProperties)", () => {
		// pie: crates/coding-agent/src/tools/web_fetch.rs:264-280 (verbatim description)
		const def = createWebFetchToolDefinition();
		expect(def.name).toBe("web_fetch");
		expect(def.description).toBe(
			"Fetch a URL via HTTP GET. Returns headers + body. For HTML pages, tags are stripped to plain text. Body cap 5 MiB; 15s timeout.",
		);
		const params = def.parameters as unknown as { additionalProperties: boolean; required: string[] };
		expect(params.additionalProperties).toBe(false);
		expect(params.required).toEqual(["url"]);
	});

	describe("execute (network integration against a local http server)", () => {
		let server: Server | undefined;

		afterEach(async () => {
			if (server) {
				await close(server);
				server = undefined;
			}
		});

		it("returns plain text unchanged with a status/content-type header", async () => {
			server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("raw plain text\nline two\n");
			});
			const base = await listen(server);
			const tool = createWebFetchTool();
			const result = await tool.execute("call-1", { url: base }, undefined, undefined);
			const text = getText(result);
			expect(text).toContain("status: 200");
			expect(text).toContain("content-type: text/plain");
			expect(text).toContain("raw plain text");
			expect(text).toContain("line two");
			const details = result.details as WebFetchToolDetails;
			expect(details.status).toBe(200);
			expect(details.truncated).toBe(false);
		});

		it("strips html to text (pie: web_fetch_e2e.rs::web_fetch_strips_html_to_text)", async () => {
			const html = "<html><body><h1>Hi</h1><p>Hello &amp; <b>world</b></p><script>evil()</script></body></html>";
			server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(html);
			});
			const base = await listen(server);
			const tool = createWebFetchTool();
			const result = await tool.execute("call-2", { url: base }, undefined, undefined);
			const text = getText(result);
			expect(text).toContain("status: 200");
			expect(text).toContain("text/html");
			expect(text).toContain("Hi");
			expect(text).toContain("Hello & world");
			expect(text).not.toContain("evil()");
		});

		it("errors with oracle's exact message for a missing url", async () => {
			const def = createWebFetchToolDefinition();
			await expect(
				def.execute("call-3", {} as any, undefined, undefined, {} as Parameters<typeof def.execute>[4]),
			).rejects.toThrow("missing required arg: url");
		});

		it("follows up to 10 redirects and reaches the final response", async () => {
			// /r/N redirects to /r/N-1; /r/0 serves final content. Requesting /r/10 needs exactly
			// 10 redirects -- the oracle-parity boundary (`Policy::limited(10)` allows 10).
			server = createServer((req, res) => {
				const match = req.url?.match(/^\/r\/(\d+)$/);
				const n = match ? Number(match[1]) : Number.NaN;
				if (Number.isNaN(n)) {
					res.writeHead(404);
					res.end();
					return;
				}
				if (n === 0) {
					res.writeHead(200, { "Content-Type": "text/plain" });
					res.end("final content");
					return;
				}
				res.writeHead(302, { Location: `/r/${n - 1}` });
				res.end();
			});
			const base = await listen(server);
			const tool = createWebFetchTool();
			const result = await tool.execute("call-redirect-ok", { url: `${base}/r/10` }, undefined, undefined);
			expect(getText(result)).toContain("final content");
		});

		it("errors with 'too many redirects' past the 10-redirect cap", async () => {
			server = createServer((req, res) => {
				const match = req.url?.match(/^\/r\/(\d+)$/);
				const n = match ? Number(match[1]) : Number.NaN;
				if (Number.isNaN(n)) {
					res.writeHead(404);
					res.end();
					return;
				}
				if (n === 0) {
					res.writeHead(200, { "Content-Type": "text/plain" });
					res.end("final content");
					return;
				}
				res.writeHead(302, { Location: `/r/${n - 1}` });
				res.end();
			});
			const base = await listen(server);
			const tool = createWebFetchTool();
			await expect(
				tool.execute("call-redirect-fail", { url: `${base}/r/11` }, undefined, undefined),
			).rejects.toThrow("fetch failed: too many redirects");
		});

		it("truncates an oversized body streaming, without buffering the whole thing (pie: web_fetch_e2e.rs::web_fetch_truncates_oversized_body_streaming)", async () => {
			const CAP = 5 * 1024 * 1024;
			const total = CAP + 1024 * 1024; // 1 MiB of overshoot
			server = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "text/plain" });
				const chunk = Buffer.alloc(64 * 1024, "A");
				let written = 0;
				const writeMore = () => {
					if (written >= total) {
						res.end();
						return;
					}
					const toWrite = Math.min(chunk.length, total - written);
					written += toWrite;
					const ok = res.write(toWrite === chunk.length ? chunk : chunk.subarray(0, toWrite));
					if (ok) writeMore();
					else res.once("drain", writeMore);
				};
				writeMore();
			});
			const base = await listen(server);
			const tool = createWebFetchTool();
			const result = await tool.execute("call-cap", { url: base }, undefined, undefined);
			const details = result.details as WebFetchToolDetails;
			expect(details.truncated).toBe(true);
			expect(details.bytes).toBe(CAP);
			expect(getText(result)).toContain("(truncated)");
		}, 20_000);

		it("rejects immediately when the signal is already aborted", async () => {
			const def = createWebFetchToolDefinition();
			const controller = new AbortController();
			controller.abort();
			await expect(
				def.execute(
					"call-pre-aborted",
					{ url: "http://127.0.0.1:1" },
					controller.signal,
					undefined,
					{} as Parameters<typeof def.execute>[4],
				),
			).rejects.toThrow("cancelled");
		});

		it("throws 'cancelled' when aborted mid-wait for a slow response", async () => {
			server = createServer((_req, res) => {
				setTimeout(() => {
					res.writeHead(200, { "Content-Type": "text/plain" });
					res.end("too slow");
				}, 2000);
			});
			const base = await listen(server);
			const def = createWebFetchToolDefinition();
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 50);
			const started = Date.now();
			await expect(
				def.execute(
					"call-cancel",
					{ url: base },
					controller.signal,
					undefined,
					{} as Parameters<typeof def.execute>[4],
				),
			).rejects.toThrow("cancelled");
			expect(Date.now() - started).toBeLessThan(1500);
		});
	});
});
