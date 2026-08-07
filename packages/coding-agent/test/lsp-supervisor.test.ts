import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AfterToolCallContext, AgentToolCall } from "@pie/agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@pie/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_BASE_DIR } from "../src/config.ts";
import {
	ENV_TRUST_PROJECT,
	getTrustStorePath,
	resetRunScopedTrustForTesting,
	resolveProjectKey,
	trustProject,
} from "../src/core/project-trust.ts";
import { asAfterToolCallHook, attachDiagnostics, LspSupervisor, parseLspConfigText } from "../src/lsp-supervisor.ts";

// pie: crates/coding-agent/src/lsp_supervisor.rs -- oracle has no `#[cfg(test)]` module of its
// own. This suite pins three things: (1) the lazy-spawn timing contrast with mcp-loader.ts's eager
// spawn, (2) equivalent-coverage unit tests for the config parsing / override / after-tool-call-
// hook behavior, and (3) the phase 18 trust gate.
//
// The B13 block used to pin the DEFECT (an untrusted repo's `.pie/lsp.toml` runs its command on
// the first matching write/edit). It now pins the FIX: the project file is not read at all unless
// the directory is trusted, so no lazy spawn can ever be armed from it.

/**
 * Content-Length-framed LSP fixture, same shape as `lsp.test.ts`'s, plus two additions for this
 * suite: (1) writes a marker file as its very first action so tests can observe "was this
 * process actually spawned" without inspecting the OS process table, and (2) self-exits on
 * stdin EOF so a test that spawns via `ensureOpen` without an explicit shutdown call (this
 * supervisor has no shutdown method -- neither does oracle's) doesn't leave an orphaned node
 * process behind once the test file's vitest worker exits and its own stdin pipes close.
 */
const FIXTURE_SERVER_SCRIPT = `
const fs = require("node:fs");
if (process.argv[2]) {
	fs.writeFileSync(process.argv[2], String(Date.now()));
}
process.stdin.on("end", () => process.exit(0));
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
						range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
						severity: 2,
						message: "fixture warning",
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
}
`;

function makeCtx(toolName: string, args: unknown): AfterToolCallContext {
	const toolCall = {
		type: "toolCall",
		id: "call-1",
		name: toolName,
		arguments: args as Record<string, unknown>,
	} as AgentToolCall;
	const assistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: "chat-completions",
		provider: "faux",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as AssistantMessage;
	return {
		assistantMessage,
		toolCall,
		args,
		result: { content: [] as (TextContent | ImageContent)[], details: undefined },
		isError: false,
		context: { systemPrompt: "", messages: [] },
	};
}

describe("LspSupervisor", () => {
	let tempHome: string;
	let tempCwd: string;
	let originalPieDir: string | undefined;
	let originalTrustEnv: string | undefined;
	/** Every chunk the code under test wrote to stderr, in order. */
	let stderrChunks: string[];

	/** Everything written to stderr since the test started, joined. */
	function stderrText(): string {
		return stderrChunks.join("");
	}

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "pi-test-lsp-sup-user-"));
		tempCwd = mkdtempSync(join(tmpdir(), "pi-test-lsp-sup-project-"));
		originalPieDir = process.env[ENV_BASE_DIR];
		process.env[ENV_BASE_DIR] = tempHome;
		originalTrustEnv = process.env[ENV_TRUST_PROJECT];
		delete process.env[ENV_TRUST_PROJECT];
		resetRunScopedTrustForTesting();
		stderrChunks = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
			stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
			return true;
		}) as typeof process.stderr.write);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetRunScopedTrustForTesting();
		if (originalPieDir === undefined) {
			delete process.env[ENV_BASE_DIR];
		} else {
			process.env[ENV_BASE_DIR] = originalPieDir;
		}
		if (originalTrustEnv === undefined) {
			delete process.env[ENV_TRUST_PROJECT];
		} else {
			process.env[ENV_TRUST_PROJECT] = originalTrustEnv;
		}
		rmSync(tempHome, { recursive: true, force: true });
		rmSync(tempCwd, { recursive: true, force: true });
	});

	function writeFixtureScript(dir: string): string {
		const scriptPath = join(dir, "fixture-lsp-server.cjs");
		writeFileSync(scriptPath, FIXTURE_SERVER_SCRIPT, "utf-8");
		return scriptPath;
	}

	function lspToml(id: string, extensions: string[], command: string, args: string[] = []): string {
		const extLiteral = extensions.map((e) => JSON.stringify(e)).join(", ");
		const argsLiteral = args.map((a) => JSON.stringify(a)).join(", ");
		return [
			"[[language]]",
			`id = ${JSON.stringify(id)}`,
			`extensions = [${extLiteral}]`,
			`command = ${JSON.stringify(command)}`,
			`args = [${argsLiteral}]`,
			"",
		].join("\n");
	}

	/** Write a project `.pie/lsp.toml` naming the fixture server. Returns `{ configPath, marker }`. */
	function writeProjectLspConfig(id = "plaintext", extensions = ["txt"]): { configPath: string; marker: string } {
		const scriptPath = writeFixtureScript(tempCwd);
		const marker = join(tempCwd, `project-${id}.marker`);
		const pieDir = join(tempCwd, ".pie");
		mkdirSync(pieDir, { recursive: true });
		const configPath = join(pieDir, "lsp.toml");
		writeFileSync(configPath, lspToml(id, extensions, process.execPath, [scriptPath, marker]), "utf-8");
		return { configPath, marker };
	}

	describe("PORT-DIVERGENCE: B13 -- project lsp.toml is trust-gated", () => {
		it("an untrusted repo's .pie/lsp.toml is not read, so no command is ever armed or run", async () => {
			// Oracle (lsp_supervisor.rs:76-103) reads this file unconditionally and spawns its
			// command on the first matching write/edit. Phase 18 diverges: nothing opts this
			// directory in, so the config never enters the extension table at all.
			expect(process.env[ENV_TRUST_PROJECT]).toBeUndefined();
			expect(process.env.PIE_ALLOW_PROJECT_HOOKS).toBeUndefined();

			const { marker } = writeProjectLspConfig();

			const supervisor = await LspSupervisor.load(tempCwd);
			expect(supervisor.isEmpty()).toBe(true);
			expect(supervisor.languageCount()).toBe(0);

			// Editing a file of the configured type was the whole trigger for the defect. It now
			// does nothing: the language is not registered, so there is nothing to spawn.
			const targetPath = join(tempCwd, "note.txt");
			writeFileSync(targetPath, "hello", "utf-8");
			const result = await attachDiagnostics(supervisor, makeCtx("write", { path: targetPath }));

			expect(result).toBeUndefined();
			expect(existsSync(marker)).toBe(false);
		});

		it("the skip is announced on stderr, naming the file and both ways to allow it", async () => {
			const { configPath } = writeProjectLspConfig();

			await LspSupervisor.load(tempCwd);

			expect(stderrText()).toBe(
				`pie: ignored untrusted project config ${configPath}; run \`pie --trust-project\` in ${resolveProjectKey(tempCwd)} or set ${ENV_TRUST_PROJECT}=1 to load it\n`,
			);
		});

		it("reading the gate never materializes the trust store (parity S7 snapshots ~/.pie)", async () => {
			writeProjectLspConfig();

			await LspSupervisor.load(tempCwd);

			expect(existsSync(getTrustStorePath())).toBe(false);
			expect(readdirSync(tempHome)).toEqual([]);
		});

		it("a trusted project .pie/lsp.toml is read and its command runs on the first matching edit", async () => {
			const { marker } = writeProjectLspConfig();
			trustProject(tempCwd);

			const supervisor = await LspSupervisor.load(tempCwd);
			expect(supervisor.languageCount()).toBe(1);
			// Still lazy: loading a trusted config spawns nothing on its own.
			expect(existsSync(marker)).toBe(false);

			const targetPath = join(tempCwd, "note.txt");
			writeFileSync(targetPath, "hello", "utf-8");
			await attachDiagnostics(supervisor, makeCtx("write", { path: targetPath }));

			expect(existsSync(marker)).toBe(true);
			// A trusted load with no name collision is quiet.
			expect(stderrText()).toBe("");
		});

		it(`${ENV_TRUST_PROJECT}=1 trusts the project for this run without persisting anything`, async () => {
			writeProjectLspConfig();
			process.env[ENV_TRUST_PROJECT] = "1";

			const supervisor = await LspSupervisor.load(tempCwd);
			expect(supervisor.languageCount()).toBe(1);
			expect(existsSync(getTrustStorePath())).toBe(false);
		});

		it(`an unrecognized ${ENV_TRUST_PROJECT} value does not opt in`, async () => {
			writeProjectLspConfig();
			process.env[ENV_TRUST_PROJECT] = "yes";

			const supervisor = await LspSupervisor.load(tempCwd);
			expect(supervisor.isEmpty()).toBe(true);
		});
	});

	describe("PORT-DIVERGENCE: B13 -- the project-vs-user language-id collision", () => {
		it("an untrusted project entry cannot shadow the user's same-id entry", async () => {
			// Oracle lsp_supervisor.rs:81-82 orders [user, project] and overwrites by id, so a
			// hostile repo could hijack the id of a server the user trusts. Untrusted, the project
			// entry does not exist at all and the USER's command is what runs.
			const userScript = writeFixtureScript(tempHome);
			const projectScript = writeFixtureScript(tempCwd);
			const userMarker = join(tempHome, "user-server.marker");
			const projectMarker = join(tempCwd, "project-server.marker");

			writeFileSync(
				join(tempHome, "lsp.toml"),
				lspToml("plaintext", ["txt"], process.execPath, [userScript, userMarker]),
				"utf-8",
			);
			const pieDir = join(tempCwd, ".pie");
			mkdirSync(pieDir, { recursive: true });
			writeFileSync(
				join(pieDir, "lsp.toml"),
				lspToml("plaintext", ["txt"], process.execPath, [projectScript, projectMarker]),
				"utf-8",
			);

			const supervisor = await LspSupervisor.load(tempCwd);
			expect(supervisor.languageCount()).toBe(1);

			const targetPath = join(tempCwd, "note.txt");
			writeFileSync(targetPath, "hello", "utf-8");
			await attachDiagnostics(supervisor, makeCtx("write", { path: targetPath }));

			expect(existsSync(userMarker)).toBe(true);
			expect(existsSync(projectMarker)).toBe(false);
		});

		it("a trusted project entry still overrides the user entry, but the swap is announced", async () => {
			// Decision: trust decides *whether* the project file is read; a project override is a
			// legitimate thing to want, so the project entry keeps winning. What phase 18 removes
			// is the silence.
			const userScript = writeFixtureScript(tempHome);
			const projectScript = writeFixtureScript(tempCwd);
			const userMarker = join(tempHome, "user-server.marker");
			const projectMarker = join(tempCwd, "project-server.marker");
			const userPath = join(tempHome, "lsp.toml");

			writeFileSync(userPath, lspToml("plaintext", ["txt"], process.execPath, [userScript, userMarker]), "utf-8");
			const pieDir = join(tempCwd, ".pie");
			mkdirSync(pieDir, { recursive: true });
			writeFileSync(
				join(pieDir, "lsp.toml"),
				lspToml("plaintext", ["txt"], process.execPath, [projectScript, projectMarker]),
				"utf-8",
			);
			trustProject(tempCwd);

			const supervisor = await LspSupervisor.load(tempCwd);
			expect(supervisor.languageCount()).toBe(1);
			expect(stderrText()).toBe(
				`pie: project lsp.toml language 'plaintext' overrides the same-named entry in ${userPath}\n`,
			);

			const targetPath = join(tempCwd, "note.txt");
			writeFileSync(targetPath, "hello", "utf-8");
			await attachDiagnostics(supervisor, makeCtx("write", { path: targetPath }));

			expect(existsSync(projectMarker)).toBe(true);
			expect(existsSync(userMarker)).toBe(false);
		});

		it("a trusted project entry with a fresh language id does not announce an override", async () => {
			const userScript = writeFixtureScript(tempHome);
			writeFileSync(
				join(tempHome, "lsp.toml"),
				lspToml("plaintext", ["txt"], process.execPath, [userScript, join(tempHome, "user.marker")]),
				"utf-8",
			);
			writeProjectLspConfig("markdown", ["md"]);
			trustProject(tempCwd);

			const supervisor = await LspSupervisor.load(tempCwd);
			expect(supervisor.languageCount()).toBe(2);
			expect(stderrText()).toBe("");
		});
	});

	describe("PORT-DIVERGENCE: B13 -- user-scope config is unaffected by the gate", () => {
		it("a user-level ~/.pie/lsp.toml loads in an untrusted directory, with no notice", async () => {
			const userScript = writeFixtureScript(tempHome);
			const userMarker = join(tempHome, "user-server.marker");
			writeFileSync(
				join(tempHome, "lsp.toml"),
				lspToml("plaintext", ["txt"], process.execPath, [userScript, userMarker]),
				"utf-8",
			);
			// The cwd is untrusted and carries no project config at all.
			expect(existsSync(join(tempCwd, ".pie", "lsp.toml"))).toBe(false);

			const supervisor = await LspSupervisor.load(tempCwd);
			expect(supervisor.languageCount()).toBe(1);

			const targetPath = join(tempCwd, "note.txt");
			writeFileSync(targetPath, "hello", "utf-8");
			await attachDiagnostics(supervisor, makeCtx("write", { path: targetPath }));

			expect(existsSync(userMarker)).toBe(true);
			// Critical for parity: a cwd with no project config must stay completely silent, so the
			// new notice cannot leak into a byte-compared scenario.
			expect(stderrText()).toBe("");
		});

		// phase 19 F5: `pie` run from `$HOME` makes `<cwd>/.pie` the user config dir itself, so the
		// "project" file the gate was judging was the user's own -- already loaded above as
		// `userPath`. HOME is never touched: `PIE_DIR` points the user config dir at
		// `<homeCwd>/.pie`, which is the same shape.
		it("running from the user config directory's parent: user config loads, no notice", async () => {
			const homeCwd = mkdtempSync(join(tmpdir(), "pi-test-lsp-homecwd-"));
			try {
				const userDir = join(homeCwd, ".pie");
				mkdirSync(userDir, { recursive: true });
				process.env[ENV_BASE_DIR] = userDir;
				const userScript = writeFixtureScript(userDir);
				const userMarker = join(homeCwd, "user-server.marker");
				writeFileSync(
					join(userDir, "lsp.toml"),
					lspToml("plaintext", ["txt"], process.execPath, [userScript, userMarker]),
					"utf-8",
				);

				const supervisor = await LspSupervisor.load(homeCwd);
				expect(supervisor.languageCount()).toBe(1);

				const targetPath = join(homeCwd, "note.txt");
				writeFileSync(targetPath, "hello", "utf-8");
				await attachDiagnostics(supervisor, makeCtx("write", { path: targetPath }));

				expect(existsSync(userMarker)).toBe(true);
				// The finding: the user's own lsp.toml must not be reported as an untrusted project
				// config, and the user must not be told to `--trust-project` their home directory.
				expect(stderrText()).toBe("");
			} finally {
				rmSync(homeCwd, { recursive: true, force: true });
			}
		});

		it(`${ENV_TRUST_PROJECT}=1 there does not read the user config twice into a self-override`, async () => {
			const homeCwd = mkdtempSync(join(tmpdir(), "pi-test-lsp-homecwd-trusted-"));
			try {
				const userDir = join(homeCwd, ".pie");
				mkdirSync(userDir, { recursive: true });
				process.env[ENV_BASE_DIR] = userDir;
				const userScript = writeFixtureScript(userDir);
				writeFileSync(
					join(userDir, "lsp.toml"),
					lspToml("plaintext", ["txt"], process.execPath, [userScript, join(homeCwd, "user.marker")]),
					"utf-8",
				);
				// The other half of the same false positive: trusted, the same file was read again
				// as "the project config" and every entry collided with itself.
				process.env[ENV_TRUST_PROJECT] = "1";

				const supervisor = await LspSupervisor.load(homeCwd);

				expect(supervisor.languageCount()).toBe(1);
				expect(stderrText()).toBe("");
			} finally {
				rmSync(homeCwd, { recursive: true, force: true });
			}
		});
	});

	describe("lazy spawn timing (contrast with mcp-loader.ts's eager spawn)", () => {
		it("loading project lsp.toml does not spawn a process; the first matching write/edit does", async () => {
			const scriptPath = writeFixtureScript(tempCwd);
			const markerPath = join(tempCwd, "spawned.marker");
			const pieDir = join(tempCwd, ".pie");
			mkdirSync(pieDir, { recursive: true });
			writeFileSync(
				join(pieDir, "lsp.toml"),
				lspToml("plaintext", ["txt"], process.execPath, [scriptPath, markerPath]),
				"utf-8",
			);
			// Spawn *timing* is what this block is about, so get past the trust gate deliberately
			// (PORT-DIVERGENCE B13 covers the gate itself).
			trustProject(tempCwd);

			const supervisor = await LspSupervisor.load(tempCwd);
			// Config was read and understood...
			expect(supervisor.isEmpty()).toBe(false);
			expect(supervisor.languageCount()).toBe(1);
			// ...but nothing was spawned yet -- contrast with mcp-loader.ts's `loadAll`, which
			// spawns every configured stdio server as part of the load itself.
			expect(existsSync(markerPath)).toBe(false);

			const targetPath = join(tempCwd, "hello.txt");
			writeFileSync(targetPath, "hello", "utf-8");

			const result = await attachDiagnostics(supervisor, makeCtx("write", { path: targetPath }));

			// NOW the marker exists: the first matching write triggered the lazy spawn.
			expect(existsSync(markerPath)).toBe(true);
			expect(result?.content?.some((b) => b.type === "text" && b.text.includes("fixture warning"))).toBe(true);
		});

		it("a non-matching tool call (read) never triggers a spawn", async () => {
			const scriptPath = writeFixtureScript(tempCwd);
			const markerPath = join(tempCwd, "spawned-read.marker");
			const pieDir = join(tempCwd, ".pie");
			mkdirSync(pieDir, { recursive: true });
			writeFileSync(
				join(pieDir, "lsp.toml"),
				lspToml("plaintext", ["txt"], process.execPath, [scriptPath, markerPath]),
				"utf-8",
			);
			trustProject(tempCwd);
			const supervisor = await LspSupervisor.load(tempCwd);
			expect(supervisor.languageCount()).toBe(1);

			const result = await attachDiagnostics(supervisor, makeCtx("read", { path: join(tempCwd, "hello.txt") }));

			expect(result).toBeUndefined();
			expect(existsSync(markerPath)).toBe(false);
		});

		it("an empty supervisor (no lsp.toml at all) short-circuits before touching args/path", async () => {
			const supervisor = await LspSupervisor.load(tempCwd);
			expect(supervisor.isEmpty()).toBe(true);
			const result = await attachDiagnostics(supervisor, makeCtx("write", { path: "/whatever.txt" }));
			expect(result).toBeUndefined();
		});
	});

	describe("asAfterToolCallHook", () => {
		it("returns a hook function with the AgentLoopConfig.afterToolCall-compatible signature", async () => {
			const supervisor = await LspSupervisor.load(tempCwd);
			const hook = asAfterToolCallHook(supervisor);
			const result = await hook(makeCtx("write", { path: "/whatever.txt" }));
			expect(result).toBeUndefined();
		});
	});

	describe("parseLspConfigText", () => {
		it("parses languages and defaults args to []", () => {
			const cfg = parseLspConfigText('[[language]]\nid = "rust"\nextensions = ["rs"]\ncommand = "rust-analyzer"\n');
			expect(cfg).toBeDefined();
			expect(cfg?.language).toEqual([{ id: "rust", extensions: ["rs"], command: "rust-analyzer", args: [] }]);
		});

		it("returns undefined for malformed TOML (oracle: silently continue, no diagnostic)", () => {
			expect(parseLspConfigText("not [ valid")).toBeUndefined();
		});

		it("returns undefined for a shape that doesn't match the schema", () => {
			expect(parseLspConfigText("language = 5\n")).toBeUndefined();
		});
	});

	describe("project overrides user by language id (trusted project)", () => {
		it("a project lsp.toml entry with the same id fully replaces (not merges with) the user entry", async () => {
			const scriptPath = writeFixtureScript(tempCwd);
			const markerPath = join(tempCwd, "spawned-override.marker");
			const userPath = join(tempHome, "lsp.toml");
			writeFileSync(userPath, lspToml("plaintext", ["txt"], "/definitely/not/a/real/path"), "utf-8");
			const pieDir = join(tempCwd, ".pie");
			mkdirSync(pieDir, { recursive: true });
			writeFileSync(
				join(pieDir, "lsp.toml"),
				lspToml("plaintext", ["md"], process.execPath, [scriptPath, markerPath]),
				"utf-8",
			);
			// Override semantics only apply once the project file is allowed in at all.
			trustProject(tempCwd);

			const supervisor = await LspSupervisor.load(tempCwd);
			expect(supervisor.languageCount()).toBe(1);
			// The replacement is announced, never silent (PORT-DIVERGENCE B13).
			expect(stderrText()).toBe(
				`pie: project lsp.toml language 'plaintext' overrides the same-named entry in ${userPath}\n`,
			);

			// The user config's "txt" extension is gone entirely (full replace, not a merge),
			// and "md" (project-only) now resolves using the *project's* command.
			const mdPath = join(tempCwd, "notes.md");
			writeFileSync(mdPath, "notes", "utf-8");
			const opened = await supervisor.ensureOpen(mdPath);
			expect(opened).toBeDefined();
			expect(existsSync(markerPath)).toBe(true);

			const txtPath = join(tempCwd, "hello.txt");
			writeFileSync(txtPath, "hello", "utf-8");
			const notOpened = await supervisor.ensureOpen(txtPath);
			expect(notOpened).toBeUndefined();
		});
	});
});
