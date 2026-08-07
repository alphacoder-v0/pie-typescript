import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspClient } from "../src/lsp.ts";

// pie: crates/coding-agent/src/lsp.rs -- oracle has no `#[cfg(test)]` module of its own (v1,
// unwired, "public API is `#[allow(dead_code)]`"). This suite exercises the port end to end
// against a real Content-Length-framed fixture LSP server (a local node child process, not an
// external network dependency), matching the wire-construct probe posture the migration brief
// asks for on framed-IO units.

/**
 * Minimal Content-Length-framed LSP fixture server: responds to `initialize`, pushes one
 * `textDocument/publishDiagnostics` notification on `textDocument/didOpen`, and answers
 * `shutdown`/`exit`. Deliberately byte-oriented (uses `Buffer`, not string `.length`) so a
 * Content-Length mis-computation on either side (client or this fixture) would break the round
 * trip rather than silently succeed -- the round-trip test below sends non-ASCII text for
 * exactly this reason.
 */
const FIXTURE_SERVER_SCRIPT = `
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	for (;;) {
		const headerEnd = buf.indexOf("\\r\\n\\r\\n");
		if (headerEnd === -1) break;
		const header = buf.subarray(0, headerEnd).toString("utf8");
		const m = /Content-Length: (\\d+)/.exec(header);
		if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
		const len = Number(m[1]);
		const bodyStart = headerEnd + 4;
		if (buf.length < bodyStart + len) break;
		const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");
		buf = buf.subarray(bodyStart + len);
		let msg;
		try { msg = JSON.parse(body); } catch { continue; }
		handle(msg);
	}
});

function send(obj) {
	const payload = JSON.stringify(obj);
	const header = "Content-Length: " + Buffer.byteLength(payload, "utf8") + "\\r\\n\\r\\n";
	process.stdout.write(header + payload);
}

function handle(msg) {
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
	} else if (msg.method === "textDocument/didOpen") {
		const uri = msg.params.textDocument.uri;
		send({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: {
				uri,
				diagnostics: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
						severity: 1,
						message: "fixture diagnostic " + msg.params.textDocument.text.length,
						source: "fixture",
					},
				],
			},
		});
	} else if (msg.method === "shutdown") {
		send({ jsonrpc: "2.0", id: msg.id, result: null });
	} else if (msg.method === "exit") {
		process.exit(0);
	}
	// "initialized" and any other notification: no response required.
}
`;

/** Fixture that answers EVERY request (regardless of method) with a JSON-RPC error, so
 * `initialize()` itself surfaces LspClient's error-response path via a real public API call. */
const ERROR_FIXTURE_SERVER_SCRIPT = `
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	for (;;) {
		const headerEnd = buf.indexOf("\\r\\n\\r\\n");
		if (headerEnd === -1) break;
		const header = buf.subarray(0, headerEnd).toString("utf8");
		const m = /Content-Length: (\\d+)/.exec(header);
		if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
		const len = Number(m[1]);
		const bodyStart = headerEnd + 4;
		if (buf.length < bodyStart + len) break;
		const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");
		buf = buf.subarray(bodyStart + len);
		let msg;
		try { msg = JSON.parse(body); } catch { continue; }
		if (msg.id !== undefined) {
			const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "fixture always errors" } });
			const header2 = "Content-Length: " + Buffer.byteLength(payload, "utf8") + "\\r\\n\\r\\n";
			process.stdout.write(header2 + payload);
		}
	}
});
`;

/**
 * Fixture whose replies are a *plan* of RAW wire strings, so a test can put bytes on the socket
 * that no well-behaved server would emit (malformed headers, non-conforming diagnostics,
 * responses carrying a `method` key). `{{id}}` / `{{uri}}` are substituted from the triggering
 * message. Answers `shutdown` normally so teardown never waits on the request timeout.
 */
const SCRIPTED_SERVER_SCRIPT = `
const fs = require("node:fs");
const PLAN = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	for (;;) {
		const headerEnd = buf.indexOf("\\r\\n\\r\\n");
		if (headerEnd === -1) break;
		const header = buf.subarray(0, headerEnd).toString("utf8");
		const m = /Content-Length: (\\d+)/.exec(header);
		if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
		const len = Number(m[1]);
		const bodyStart = headerEnd + 4;
		if (buf.length < bodyStart + len) break;
		const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");
		buf = buf.subarray(bodyStart + len);
		let msg;
		try { msg = JSON.parse(body); } catch { continue; }
		handle(msg);
	}
});

function frame(obj) {
	const payload = JSON.stringify(obj);
	return "Content-Length: " + Buffer.byteLength(payload, "utf8") + "\\r\\n\\r\\n" + payload;
}

function handle(msg) {
	if (msg.method === "initialize") {
		const raw = PLAN.onInitialize;
		if (raw) {
			for (const r of raw) process.stdout.write(r.replaceAll("{{id}}", String(msg.id)));
		} else {
			process.stdout.write(frame({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }));
		}
	} else if (msg.method === "textDocument/didOpen") {
		const uri = msg.params.textDocument.uri;
		for (const r of PLAN.onDidOpen || []) process.stdout.write(r.replaceAll("{{uri}}", uri));
		// A plan that deliberately kills the client's read pump must also let the process go: the
		// client can no longer observe a \`shutdown\` response, so teardown would otherwise burn the
		// full 15s request timeout while holding a vitest worker.
		if (PLAN.exitAfterDidOpen) process.exit(0);
	} else if (msg.method === "shutdown") {
		process.stdout.write(frame({ jsonrpc: "2.0", id: msg.id, result: null }));
	} else if (msg.method === "exit") {
		process.exit(0);
	}
}
`;

/**
 * Stub half of the recording fixture. `shutdown()` writes the `exit` frame and SIGKILLs the child
 * on the very next tick (lsp.ts, mirroring oracle's `start_kill` at lsp.rs:221), so a
 * single-process fixture is dead before it can read -- let alone record -- that last frame
 * (measured: `initialize`/`initialized`/`shutdown` land in the file, `exit` never does). So the
 * process `LspClient` spawns is an inert stub that holds the pipes and hands the inherited
 * stdin/stdout to a DETACHED grandchild, which is the one that speaks the protocol and records.
 * SIGKILL to the stub leaves the grandchild reading the same pipe, so the `exit` frame is still
 * observed. The grandchild exits on `exit`, or on stdin EOF if a test dies before shutting down.
 */
const RECORDING_STUB_SCRIPT = `
const { spawn } = require("node:child_process");
spawn(process.execPath, [process.argv[2], process.argv[3]], {
	stdio: ["inherit", "inherit", "ignore"],
	detached: true,
}).unref();
// Keep the stub alive (and its pipes open) until the client SIGKILLs it.
setInterval(() => {}, 1000);
`;

/**
 * Worker half of the recording fixture: appends every raw request body it receives to a file, so a
 * test can assert on the exact bytes the client put on the wire (used for the `exit`
 * notification's `params` key).
 */
const RECORDING_SERVER_SCRIPT = `
const fs = require("node:fs");
const OUT = process.argv[2];
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buf = Buffer.concat([buf, chunk]);
	for (;;) {
		const headerEnd = buf.indexOf("\\r\\n\\r\\n");
		if (headerEnd === -1) break;
		const header = buf.subarray(0, headerEnd).toString("utf8");
		const m = /Content-Length: (\\d+)/.exec(header);
		if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
		const len = Number(m[1]);
		const bodyStart = headerEnd + 4;
		if (buf.length < bodyStart + len) break;
		const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");
		buf = buf.subarray(bodyStart + len);
		fs.appendFileSync(OUT, body + "\\n");
		let msg;
		try { msg = JSON.parse(body); } catch { continue; }
		if (msg.method === "initialize" || msg.method === "shutdown") {
			const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "initialize" ? { capabilities: {} } : null });
			process.stdout.write("Content-Length: " + Buffer.byteLength(payload, "utf8") + "\\r\\n\\r\\n" + payload);
		} else if (msg.method === "exit") {
			process.exit(0);
		}
	}
});
`;

/** Wrap a JSON payload in an oracle-shaped `Content-Length` frame (UTF-8 byte length). */
function frame(payload: string): string {
	return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
}

const TRACER_URI = "file:///workspace/tracer.rs";
const SUBJECT_URI = "file:///workspace/subject.rs";

/** A diagnostic that satisfies every field constraint in lsp.rs:25-45. */
const WELL_FORMED_DIAGNOSTIC = {
	range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
	severity: 2,
	message: "well formed",
	source: "fixture",
};

function publishFrame(uri: string, diagnostics: unknown): string {
	return frame(
		JSON.stringify({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri, diagnostics },
		}),
	);
}

/** Frame the read pump must still deliver after the frame under test -- it proves the pump
 * processed (and dropped) the subject frame rather than merely being slow, so "no diagnostics"
 * assertions can never pass vacuously. */
const TRACER_FRAME = publishFrame(TRACER_URI, [WELL_FORMED_DIAGNOSTIC]);

describe("LspClient", () => {
	let dir: string;
	let clients: LspClient[];
	let planSeq: number;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-test-lsp-"));
		clients = [];
		planSeq = 0;
	});

	afterEach(async () => {
		for (const client of clients) {
			await client.shutdown();
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function writeScript(name: string, contents: string): string {
		const scriptPath = join(dir, name);
		writeFileSync(scriptPath, contents, "utf-8");
		return scriptPath;
	}

	async function spawnFixture(): Promise<LspClient> {
		const scriptPath = writeScript("fixture-lsp-server.cjs", FIXTURE_SERVER_SCRIPT);
		const client = await LspClient.spawn(process.execPath, [scriptPath]);
		clients.push(client);
		return client;
	}

	async function spawnScripted(plan: {
		onInitialize?: string[];
		onDidOpen?: string[];
		exitAfterDidOpen?: boolean;
	}): Promise<LspClient> {
		const scriptPath = writeScript("scripted-lsp-server.cjs", SCRIPTED_SERVER_SCRIPT);
		const planPath = join(dir, `plan-${++planSeq}.json`);
		writeFileSync(planPath, JSON.stringify(plan), "utf-8");
		const client = await LspClient.spawn(process.execPath, [scriptPath, planPath]);
		clients.push(client);
		return client;
	}

	/** Poll `path` until a recorded request body containing `needle` shows up (the recording
	 * grandchild reads the last frame after the client has already returned from `shutdown()`, so
	 * the write lands a scheduler tick or two later). Returns `undefined` on deadline. */
	async function waitForRecordedBody(path: string, needle: string, timeoutMs = 5_000): Promise<string | undefined> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			let contents = "";
			try {
				contents = readFileSync(path, "utf8");
			} catch {
				// Not created yet -- the grandchild appends on its first frame.
			}
			const hit = contents.split("\n").find((line) => line.length > 0 && line.includes(needle));
			if (hit !== undefined) return hit;
			if (Date.now() >= deadline) return undefined;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	/** Drive the scripted fixture: `initialize`, then `didOpen` on {@link SUBJECT_URI} to make it
	 * emit `onDidOpen`, then wait for the next diagnostics push. */
	async function pushAndAwait(plan: { onDidOpen: string[] }) {
		const client = await spawnScripted(plan);
		await client.initialize("file:///workspace");
		await client.didOpen(SUBJECT_URI, "rust", "fn main() {}");
		const pushed = await client.awaitDiagnostics(5_000);
		return { client, pushed };
	}

	it("initialize + didOpen + publishDiagnostics round trip, including a non-ASCII payload", async () => {
		const client = await spawnFixture();
		const initResult = await client.initialize("file:///workspace");
		expect(initResult).toEqual({ capabilities: {} });

		const uri = "file:///workspace/hello.txt";
		// Multi-byte text: if Content-Length were computed from JS string .length (UTF-16 code
		// units) instead of UTF-8 byte length anywhere in the framing (client write OR this
		// fixture's own byte-oriented parser), the frame boundary would be wrong and the fixture
		// would never see a parseable didOpen -- so this also exercises writeFramed's byte-length
		// correctness (RULEBOOK's write-tool ledger precedent: Buffer.byteLength, not .length).
		const text = "héllo 世界 🎉";
		await client.didOpen(uri, "plaintext", text);

		const pushed = await client.awaitDiagnostics(3_000);
		expect(pushed).toBeDefined();
		expect(pushed?.uri).toBe(uri);
		expect(pushed?.diagnostics).toHaveLength(1);
		expect(pushed?.diagnostics[0].message).toBe(`fixture diagnostic ${text.length}`);
		expect(pushed?.diagnostics[0].severity).toBe(1);
		expect(pushed?.diagnostics[0].range.start).toEqual({ line: 0, character: 0 });

		expect(client.diagnosticsFor(uri)).toEqual(pushed?.diagnostics);
		expect(client.diagnosticsFor("file:///workspace/never-opened.txt")).toEqual([]);
	});

	it("awaitDiagnostics resolves undefined when nothing is pushed within the timeout", async () => {
		const client = await spawnFixture();
		await client.initialize("file:///workspace");
		// No didOpen call -- the fixture never pushes anything for this uri.
		const result = await client.awaitDiagnostics(150);
		expect(result).toBeUndefined();
	});

	it("propagates a JSON-RPC error response as a rejected request (pie: lsp.rs:243-246)", async () => {
		const scriptPath = writeScript("error-fixture-lsp-server.cjs", ERROR_FIXTURE_SERVER_SCRIPT);
		const client = await LspClient.spawn(process.execPath, [scriptPath]);
		clients.push(client);
		await expect(client.initialize("file:///workspace")).rejects.toThrow(/LSP server error/);
	});

	// pie: lsp.rs:121-128 -- `serde_json::from_value::<PublishDiagnosticsParams>` validates the
	// payload down to every field of every diagnostic, and `if let Ok(p)` drops the WHOLE
	// notification when any of it fails: no `diagnostics.insert`, no `diag_tx.send`. Each case
	// below feeds the non-conforming notification first and a well-formed TRACER_FRAME second;
	// receiving the tracer proves the pump ran past the subject frame and discarded it.
	describe("publishDiagnostics payload validation (pie: lsp.rs:121-128)", () => {
		const goodRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
		const rejected: Array<[string, unknown]> = [
			["diagnostic missing `range` (lsp.rs:27 `range: DiagnosticRange`)", [{ message: "x" }]],
			["diagnostic missing `message` (lsp.rs:30 `message: String`)", [{ range: goodRange }]],
			["non-string `message` (lsp.rs:30 `String`)", [{ range: goodRange, message: 5 }]],
			["`severity` past u8::MAX (lsp.rs:29 `Option<u8>`)", [{ range: goodRange, message: "x", severity: 300 }]],
			["negative `severity` (lsp.rs:29 `u8` is unsigned)", [{ range: goodRange, message: "x", severity: -1 }]],
			["non-string `source` (lsp.rs:32 `Option<String>`)", [{ range: goodRange, message: "x", source: 7 }]],
			[
				"negative `line` (lsp.rs:43 `line: u32` is unsigned)",
				[{ range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } }, message: "x" }],
			],
			[
				"fractional `character` (lsp.rs:44 `character: u32` is integral)",
				[{ range: { start: { line: 0, character: 1.5 }, end: { line: 0, character: 2 } }, message: "x" }],
			],
			["`range` missing `end` (lsp.rs:38)", [{ range: { start: { line: 0, character: 0 } }, message: "x" }]],
			["`diagnostics` not an array (lsp.rs:50 `Vec<Diagnostic>`)", "not-an-array"],
			[
				"one malformed entry among well-formed ones -- serde fails the whole vector",
				[WELL_FORMED_DIAGNOSTIC, { message: "no range" }, WELL_FORMED_DIAGNOSTIC],
			],
		];

		it.each(rejected)("drops the entire notification: %s", async (_label, diagnostics) => {
			const { client, pushed } = await pushAndAwait({
				onDidOpen: [publishFrame(SUBJECT_URI, diagnostics), TRACER_FRAME],
			});
			// The tracer, not the subject: nothing was sent on the channel for SUBJECT_URI.
			expect(pushed?.uri).toBe(TRACER_URI);
			// ...and nothing was written to the cache either (lsp.rs:124-126 never ran).
			expect(client.diagnosticsFor(SUBJECT_URI)).toEqual([]);
		});

		const accepted: Array<[string, unknown]> = [
			["every field present and in range", [WELL_FORMED_DIAGNOSTIC]],
			["`severity`/`source` absent (lsp.rs:28,31 `#[serde(default)]`)", [{ range: goodRange, message: "x" }]],
			[
				"`severity`/`source` explicitly null (serde `Option` <- null == None)",
				[{ range: goodRange, message: "x", severity: null, source: null }],
			],
			[
				"`severity` at the u8 bounds",
				[
					{ range: goodRange, message: "x", severity: 0 },
					{ range: goodRange, message: "y", severity: 255 },
				],
			],
			[
				"unknown extra keys (no `deny_unknown_fields` on lsp.rs:25-33)",
				[{ range: goodRange, message: "x", code: "E0425", tags: [1], relatedInformation: [] }],
			],
			["an empty diagnostics vector", []],
		];

		it.each(accepted)("delivers the notification: %s", async (_label, diagnostics) => {
			const { client, pushed } = await pushAndAwait({
				onDidOpen: [publishFrame(SUBJECT_URI, diagnostics), TRACER_FRAME],
			});
			expect(pushed?.uri).toBe(SUBJECT_URI);
			expect(pushed?.diagnostics).toEqual(diagnostics);
			expect(client.diagnosticsFor(SUBJECT_URI)).toEqual(diagnostics);
		});
	});
	describe("oracle frame/dispatch fidelity (phase 12 reviewer B)", () => {
		it("does not settle an in-flight request on a frame whose `method` is a non-string (B-D15)", async () => {
			// pie: lsp.rs:113 gates the settle on `value.get("method").is_none()` -- KEY EXISTENCE.
			// `{"id":N,"method":5}` therefore is a server-initiated request oracle ignores, NOT a
			// response. The pre-fix port keyed off a string-typed binding, so `method:5` read as
			// "no method" and settled `initialize` with `null`.
			// The id is written literally rather than through the fixture's `{{id}}` placeholder:
			// the scripted fixture emits plan entries as RAW bytes, so a substitution that changes
			// the body's length after `frame()` has already stamped its Content-Length desynchronizes
			// the stream (the reader then eats into the next frame and the pump dies on a JSON parse
			// error -- which is what this test was actually measuring before). `1` is the right
			// literal: `nextId` starts at 1 (oracle `next_id: AtomicU64::new(1)`, lsp.rs:152, with
			// `fetch_add` returning the pre-increment value at lsp.rs:230) and `initialize` is the
			// first request a fresh client sends.
			const bogus = frame(JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 }));
			const real = frame(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
			const client = await spawnScripted({ onInitialize: [bogus, real] });
			const initResult = await client.initialize("file:///workspace");
			expect(initResult).toEqual({ capabilities: {} });
			expect(initResult).not.toBeNull();
		});

		it("resets an already-parsed Content-Length when a later header line fails to parse (B-D14)", async () => {
			// pie: lsp.rs:299-301 assigns `rest.parse().ok()` for EVERY line carrying the prefix, so
			// a malformed second header clears the good value and read_framed errors out, killing
			// the pump. The pre-fix port's `^Content-Length: (\d+)$` regex simply didn't match the
			// bad line and kept the stale length, happily reading the frame.
			const payload = JSON.stringify({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: { uri: SUBJECT_URI, diagnostics: [WELL_FORMED_DIAGNOSTIC] },
			});
			const poisoned = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\nContent-Length: abc\r\n\r\n${payload}`;
			// A well-formed tracer after the poisoned frame: if the pump survived, this would arrive.
			const tracer = frame(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "textDocument/publishDiagnostics",
					params: { uri: TRACER_URI, diagnostics: [WELL_FORMED_DIAGNOSTIC] },
				}),
			);
			const client = await spawnScripted({ onDidOpen: [poisoned, tracer], exitAfterDidOpen: true });
			await client.initialize("file:///workspace");
			await client.didOpen(SUBJECT_URI, "rust", "fn main() {}");
			expect(await client.awaitDiagnostics(1_000)).toBeUndefined();
			expect(client.diagnosticsFor(SUBJECT_URI)).toEqual([]);
			expect(client.diagnosticsFor(TRACER_URI)).toEqual([]);
		});

		it("puts an explicit `params: null` on the wire for the `exit` notification (B-D12)", async () => {
			// pie: lsp.rs:219 calls `notify("exit", None)`, and lsp.rs:263-268 feeds it to `json!`,
			// which serializes `None` as null rather than omitting the key. `JSON.stringify` drops
			// undefined-valued properties, so the pre-fix port shipped a shorter frame with no
			// `params` key at all -- different bytes and a different Content-Length every shutdown.
			const workerPath = writeScript("recording-lsp-worker.cjs", RECORDING_SERVER_SCRIPT);
			const stubPath = writeScript("recording-lsp-stub.cjs", RECORDING_STUB_SCRIPT);
			const outPath = join(dir, "wire.log");
			const client = await LspClient.spawn(process.execPath, [stubPath, workerPath, outPath]);
			await client.initialize("file:///workspace");
			await client.shutdown();

			const exitBody = await waitForRecordedBody(outPath, '"method":"exit"');
			expect(exitBody).toBeDefined();
			expect(JSON.parse(exitBody as string)).toEqual({ jsonrpc: "2.0", method: "exit", params: null });
			expect(exitBody).toContain('"params":null');
		});
	});
});
