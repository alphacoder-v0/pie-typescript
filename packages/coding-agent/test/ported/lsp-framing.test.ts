/**
 * char-tests port of oracle `crates/coding-agent/tests/lsp_framing.rs` (pie @0a120dfd).
 *
 * Oracle module doc: "End-to-end test of the LSP Content-Length framing by spawning a mock server
 * (a small Python one-liner) that responds to `initialize` and pushes one diagnostic. We don't
 * ship a Python dep here; the test skips gracefully when Python isn't available, matching the
 * pattern used by the git tool tests."
 *
 * Oracle test functions: 1. Ported: 1. Skipped: 0.
 *
 * DEVIATION (fixture language only, zero assertion impact): oracle's mock server is a `python3 -c`
 * one-liner guarded by a `python_available()` early-return. This port spawns the byte-identical
 * protocol mock as a **node** child process (`process.execPath`, a CJS script written to a temp
 * dir), matching the fixture convention already established by `test/lsp.test.ts` in this package
 * and the migration brief's "LSP tests use a local node subprocess fixture, never a real language
 * server". Consequences: (a) the `python3`-missing skip branch (lsp_framing.rs:71-74) has no
 * counterpart -- node is always present when vitest is running, so the test can never silently
 * no-op; (b) every wire byte the mock emits (`Content-Length` computed over UTF-8 *bytes*, CRLF
 * header terminator, diagnostic payload) is reproduced verbatim from lsp_framing.rs:21-67.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspClient } from "../../src/lsp.ts";

/**
 * pie: lsp_framing.rs:21-67 (`MOCK_SERVER`). Same state machine, same responses, same wire
 * framing -- `initialize` -> capabilities result; `initialized` -> one `publishDiagnostics` push
 * on `file:///tmp/x.rs`; `shutdown` -> null result; `exit` -> terminate.
 */
const MOCK_SERVER = `
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	for (;;) {
		const headerEnd = buf.indexOf("\\r\\n\\r\\n");
		if (headerEnd === -1) break;
		const headers = buf.subarray(0, headerEnd).toString("utf8");
		const m = /Content-Length:\\s*(\\d+)/i.exec(headers);
		if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
		const n = Number(m[1]);
		const bodyStart = headerEnd + 4;
		if (buf.length < bodyStart + n) break;
		const body = buf.subarray(bodyStart, bodyStart + n).toString("utf8");
		buf = buf.subarray(bodyStart + n);
		let msg;
		try { msg = JSON.parse(body); } catch { continue; }
		handle(msg);
	}
});

function write(obj) {
	const s = JSON.stringify(obj);
	process.stdout.write("Content-Length: " + Buffer.byteLength(s, "utf8") + "\\r\\n\\r\\n" + s);
}

function handle(msg) {
	const method = msg.method;
	if (method === "initialize") {
		write({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
	} else if (method === "initialized") {
		// publish one diagnostic on a known uri
		write({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: {
				uri: "file:///tmp/x.rs",
				diagnostics: [{
					range: { start: { line: 3, character: 0 }, end: { line: 3, character: 4 } },
					severity: 1,
					message: "expected \\\`;\\\`, found \\\`}\\\`",
					source: "mock",
				}],
			},
		});
	} else if (method === "shutdown") {
		write({ jsonrpc: "2.0", id: msg.id, result: null });
	} else if (method === "exit") {
		process.exit(0);
	}
}
`;

describe("lsp_framing", () => {
	let dir: string;
	/** Set while a spawned client still owns a live child process; cleared by the explicit
	 * `shutdown()` the test body performs (oracle does the same at lsp_framing.rs:90). Kept as a
	 * safety net so an early assertion failure still reaps the child -- but NOT shut down twice:
	 * the second `shutdown()` writes to an already-SIGKILLed stdin and would block for the full
	 * 15s request timeout (lsp.ts `requestTimeoutMs`), which is a property of oracle's
	 * `shutdown` too (lsp.rs:214-223 sends the request unconditionally). */
	let pending: LspClient | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pie-ported-lsp-framing-"));
		pending = undefined;
	});

	afterEach(async () => {
		if (pending) await pending.shutdown();
		pending = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	/** pie: lsp_framing.rs:69-91 */
	it("lsp_client_round_trips_initialize_and_receives_diagnostics", async () => {
		const scriptPath = join(dir, "mock-lsp-server.cjs");
		writeFileSync(scriptPath, MOCK_SERVER, "utf-8");

		// pie: lsp_framing.rs:75-77 (`LspClient::spawn("python3", &["-c", MOCK_SERVER])`)
		const client = await LspClient.spawn(process.execPath, [scriptPath]);
		pending = client;
		// pie: lsp_framing.rs:78 (`client.initialize("file:///tmp/").await.expect("initialize")`)
		await client.initialize("file:///tmp/");

		// pie: lsp_framing.rs:80-83 (`await_diagnostics(Duration::from_secs(3))`)
		const received = await client.awaitDiagnostics(3_000);
		expect(received, "diagnostics arrived").toBeDefined();
		if (!received) throw new Error("unreachable");

		// pie: lsp_framing.rs:84-89
		expect(received.uri).toBe("file:///tmp/x.rs");
		expect(received.diagnostics.length).toBe(1);
		const d = received.diagnostics[0];
		expect(d.message, d.message).toContain("expected");
		expect(d.range.start.line).toBe(3);

		// pie: lsp_framing.rs:90 (`client.shutdown().await`)
		await client.shutdown();
		pending = undefined;
	});
});
