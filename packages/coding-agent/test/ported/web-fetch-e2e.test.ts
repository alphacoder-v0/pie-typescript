/**
 * 1:1 port of oracle `crates/coding-agent/tests/web_fetch_e2e.rs` (pie @0a120dfd).
 *
 * Oracle module doc: "End-to-end test for the web_fetch tool. Spins up a tiny TCP listener that
 * speaks just enough HTTP/1.1 to serve a single response, then drives WebFetchTool::execute
 * against it. Asserts the rendered output contains stripped text + the expected
 * status/content-type header line."
 *
 * 4 oracle `#[tokio::test]` functions -> 4 tests here, names mirrored verbatim.
 * (`_exec_mode_is_parallel` at web_fetch_e2e.rs:111-114 is `#[allow(dead_code)]` and never
 * called -- it is a Rust compile-time reachability check for `execution_mode()`, not a test, so
 * it has no runtime counterpart to port.)
 *
 * File-wide structural adaptations (naming/architecture translations, not weakened assertions):
 * - Oracle's hand-rolled `TcpListener` + literal HTTP/1.1 response bytes become `node:http`'s
 *   `createServer`, the idiom already used by test/web-fetch-tool.test.ts:16-27. The wire shape
 *   asserted on (status line + Content-Type) is identical; nothing here reaches the real network.
 * - Oracle `web_fetch::WebFetchTool` (a unit struct) becomes `createWebFetchTool()`.
 * - Oracle's `result.content[0]` + `UserContentBlock::Text` match becomes `getText()`.
 */

import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createWebFetchTool } from "../../src/tools/web-fetch.ts";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	if (block === undefined || block.type !== "text" || block.text === undefined) {
		throw new Error("expected text content");
	}
	return block.text;
}

let server: Server | undefined;

function listen(s: Server): Promise<string> {
	return new Promise((resolve) => {
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			if (addr === null || typeof addr === "string") throw new Error("expected AddressInfo");
			resolve(`http://127.0.0.1:${addr.port}/`);
		});
	});
}

/** pie: web_fetch_e2e.rs:16-40 (`spawn_http`). */
async function spawnHttp(body: string, contentType: string): Promise<string> {
	server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": contentType });
		res.end(body);
	});
	return listen(server);
}

afterEach(async () => {
	if (server !== undefined) {
		const s = server;
		server = undefined;
		await new Promise<void>((resolve) => s.close(() => resolve()));
	}
});

const cancel = new AbortController().signal;

// pie: web_fetch_e2e.rs:42-71
it("web_fetch_strips_html_to_text", async () => {
	const html = "<html><body><h1>Hi</h1><p>Hello &amp; <b>world</b></p><script>evil()</script></body></html>";
	const url = await spawnHttp(html, "text/html; charset=utf-8");
	const tool = createWebFetchTool();
	const result = await tool.execute("call-1", { url }, cancel);
	const body = getText(result);
	expect(body, `status header line: ${body}`).toContain("status: 200");
	expect(body, `ctype header line: ${body}`).toContain("text/html");
	expect(body, `missing heading: ${body}`).toContain("Hi");
	expect(body, `missing decoded entity: ${body}`).toContain("Hello & world");
	expect(body, `script body must be stripped: ${body}`).not.toContain("evil()");
});

// pie: web_fetch_e2e.rs:73-93
it("web_fetch_returns_plain_text_unchanged", async () => {
	const txt = "raw plain text\nline two\n";
	const url = await spawnHttp(txt, "text/plain");
	const tool = createWebFetchTool();
	const result = await tool.execute("call-2", { url }, cancel);
	const body = getText(result);
	expect(body).toContain("raw plain text");
	expect(body).toContain("line two");
});

// pie: web_fetch_e2e.rs:95-109
it("web_fetch_missing_url_errors", async () => {
	const tool = createWebFetchTool();
	// Oracle passes an untyped `serde_json::json!({})`; TS's `execute` is statically typed, so the
	// deliberate schema violation needs an explicit cast to reach the runtime guard under test
	// (src/tools/web-fetch.ts's "missing required arg: url" throw).
	await expect(tool.execute("call-3", {} as never, cancel)).rejects.toThrow(/missing required arg/);
});

/**
 * pie: web_fetch_e2e.rs:116-236. Oracle doc comments, ported:
 *
 * Tiny HTTP server that streams a body larger than the 5 MiB cap and records how many bytes it
 * managed to push before the client closed the socket. Used to prove that `web_fetch` enforces
 * the cap **streaming**: it must (a) report the cap as the rendered byte count + `truncated:
 * true`, and (b) not require the whole oversized body to fit in memory before truncating.
 *
 * The `MAX_BODY_BYTES` const is duplicated here on purpose -- keep the test independent of the
 * impl's internal constant; if the cap changes, both sides should be updated to keep the
 * assertion meaningful.
 */
const TEST_CAP_BYTES = 5 * 1024 * 1024;

/**
 * Oversized body must be truncated to the 5 MiB cap and surface `truncated: true`. The previous
 * `resp.bytes().await` implementation would buffer the entire body before truncating; this test
 * sends 5 MiB + 1 MiB and asserts the client only retains the cap.
 */
it("web_fetch_truncates_oversized_body_streaming", async () => {
	// 1 MiB of overshoot is plenty to prove we don't blindly slurp the whole thing.
	const total = TEST_CAP_BYTES + 1024 * 1024;
	// pie: web_fetch_e2e.rs:127-173 (`spawn_oversize_http`) -- streams 64 KiB chunks of 'A' and
	// stops as soon as the client hangs up.
	let written = 0;
	server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(total) });
		const chunk = Buffer.alloc(64 * 1024, "A");
		const writeMore = (): void => {
			if (res.destroyed || res.writableEnded) return;
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
	const url = await listen(server);

	const tool = createWebFetchTool();
	const result = await tool.execute("call-cap", { url }, cancel);

	const details = result.details as { truncated?: boolean; bytes?: number };
	const truncated = details.truncated ?? false;
	const bytes = details.bytes ?? 0;

	expect(truncated, `oversized body should set truncated=true, details=${JSON.stringify(result.details)}`).toBe(true);
	expect(bytes, `rendered byte count must equal the cap (got ${bytes})`).toBe(TEST_CAP_BYTES);

	const body = getText(result);
	expect(body, `header should mark response as truncated: ${body.slice(0, 200)}`).toContain("(truncated)");

	// Oracle waits for its server task to wind down so it can observe how many bytes it wrote,
	// then deliberately does NOT assert on that count ("TCP buffer sizes vary too much across
	// kernels"). The load-bearing assertions are the truncated flag + byte count above;
	// `written` is observed here for the same debugging value and likewise not asserted.
	void written;
}, 20_000);
