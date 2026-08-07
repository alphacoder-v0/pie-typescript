import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugHttpMcpAuth } from "@pie/mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_BASE_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	ENV_TRUST_PROJECT,
	getTrustStorePath,
	resetRunScopedTrustForTesting,
	resolveProjectKey,
	trustProject,
} from "../src/core/project-trust.ts";
import {
	connectAll,
	loadAll,
	parseMcpConfigText,
	resolveHttpAuthFromStore,
	type ServerConfig,
} from "../src/mcp-loader.ts";

// pie: crates/coding-agent/src/mcp_loader.rs `#[cfg(test)] mod tests` -- ported with equivalent
// coverage, plus a dedicated B5 block (RULEBOOK §5) not present in oracle's own test module.
//
// Phase 18 flipped that block: it used to pin the DEFECT (an untrusted project `.pie/mcp.toml`
// spawns its stdio server on load). It now pins the FIX -- the project file is not read at all
// unless the directory is trusted -- plus the trusted path, the announced name collision, and the
// invariant that user-scope `~/.pie/mcp.toml` is unaffected by the gate.

/**
 * Minimal MCP server, framed like the fixture in `packages/mcp/test/stdio-integration.test.ts`,
 * run as a real subprocess via a small `.cjs` file (not embedded inline via `node -e` so it can
 * be referenced as a `command`/`args` pair from a real `.pie/mcp.toml` TOML file). Not an
 * external process in the "reaches the network" sense -- just a local node child process reading
 * newline-delimited JSON-RPC from stdin.
 */
const ECHO_SERVER_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	const { id, method } = msg;
	if (method === "notifications/initialized") return;
	let result;
	if (method === "initialize") {
		result = { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture-echo", version: "1.0.0" } };
	} else if (method === "tools/list") {
		result = { tools: [{ name: "echo", description: "echo text back", inputSchema: { type: "object" } }] };
	} else if (method === "tools/call") {
		result = { content: [{ type: "text", text: "echo-ok" }], isError: false };
	} else {
		return;
	}
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
});
`;

function writeEchoServerScript(dir: string): string {
	const scriptPath = join(dir, "echo-server.cjs");
	writeFileSync(scriptPath, ECHO_SERVER_SCRIPT, "utf-8");
	return scriptPath;
}

function stdioServerToml(name: string, command: string, args: string[] = []): string {
	const argsLiteral = args.map((a) => JSON.stringify(a)).join(", ");
	return `[[server]]\nname = ${JSON.stringify(name)}\ncommand = ${JSON.stringify(command)}\nargs = [${argsLiteral}]\n`;
}

describe("mcp-loader", () => {
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
		tempHome = mkdtempSync(join(tmpdir(), "pi-test-mcp-user-"));
		tempCwd = mkdtempSync(join(tmpdir(), "pi-test-mcp-project-"));
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

	/** Write a project `.pie/mcp.toml` naming the fixture echo server. Returns its path. */
	function writeProjectEchoConfig(name = "fixture"): string {
		const scriptPath = writeEchoServerScript(tempCwd);
		const pieDir = join(tempCwd, ".pie");
		mkdirSync(pieDir, { recursive: true });
		const configPath = join(pieDir, "mcp.toml");
		writeFileSync(configPath, stdioServerToml(name, process.execPath, [scriptPath]), "utf-8");
		return configPath;
	}

	describe("PORT-DIVERGENCE: B5 -- project mcp.toml is trust-gated", () => {
		it("an untrusted project mcp.toml is not read and its stdio server is never spawned", async () => {
			// Oracle (mcp_loader.rs:98-139, 239-253) reads this file unconditionally and spawns the
			// command it names. Phase 18 diverges: nothing here opts the directory in, so nothing
			// in it may run.
			expect(process.env[ENV_TRUST_PROJECT]).toBeUndefined();
			expect(process.env.PIE_ALLOW_PROJECT_HOOKS).toBeUndefined();

			writeProjectEchoConfig();
			// No user-scope mcp.toml at all -- so anything that loads can only have come from the
			// project file.
			expect(existsSync(join(tempHome, "mcp.toml"))).toBe(false);

			const loaded = await loadAll(tempCwd);
			expect(loaded.clientCount).toBe(0);
			expect(loaded.serverNames).toEqual([]);
			expect(loaded.tools).toEqual([]);
			expect(loaded.notificationHooks).toEqual([]);
			// The skip is not a parse failure -- the file was never read, so no diagnostic.
			expect(loaded.diagnostics).toEqual([]);
		});

		it("the skip is announced on stderr, naming the file and both ways to allow it", async () => {
			const configPath = writeProjectEchoConfig();

			await loadAll(tempCwd);

			// Exact wording, pinned: silence would be worse than the original bug.
			expect(stderrText()).toBe(
				`pie: ignored untrusted project config ${configPath}; run \`pie --trust-project\` in ${resolveProjectKey(tempCwd)} or set ${ENV_TRUST_PROJECT}=1 to load it\n`,
			);
		});

		it("reading the gate never materializes the trust store (parity S7 snapshots ~/.pie)", async () => {
			writeProjectEchoConfig();

			await loadAll(tempCwd);

			expect(existsSync(getTrustStorePath())).toBe(false);
			expect(readdirSync(tempHome)).toEqual([]);
		});

		it("a trusted project mcp.toml is read and its stdio server is spawned", async () => {
			writeProjectEchoConfig();
			trustProject(tempCwd);

			const loaded = await loadAll(tempCwd);
			expect(loaded.diagnostics).toEqual([]);
			expect(loaded.clientCount).toBe(1);
			expect(loaded.serverNames).toEqual(["fixture"]);
			expect(loaded.tools.map((t) => t.name)).toEqual(["echo"]);
			expect(loaded.notificationHooks).toHaveLength(1);
			// A trusted load is quiet -- no skip notice, no override notice (nothing collides).
			expect(stderrText()).toBe("");
		});

		it(`${ENV_TRUST_PROJECT}=1 trusts the project for this run without persisting anything`, async () => {
			writeProjectEchoConfig();
			process.env[ENV_TRUST_PROJECT] = "1";

			const loaded = await loadAll(tempCwd);
			expect(loaded.clientCount).toBe(1);
			expect(loaded.serverNames).toEqual(["fixture"]);
			// The CI/headless escape hatch is run-scoped: it must not write a trust record.
			expect(existsSync(getTrustStorePath())).toBe(false);
		});

		it(`an unrecognized ${ENV_TRUST_PROJECT} value does not opt in`, async () => {
			writeProjectEchoConfig();
			process.env[ENV_TRUST_PROJECT] = "yes";

			const loaded = await loadAll(tempCwd);
			expect(loaded.clientCount).toBe(0);
			expect(loaded.serverNames).toEqual([]);
		});
	});

	describe("PORT-DIVERGENCE: B5 -- the project-vs-user name collision", () => {
		it("an untrusted project server cannot shadow the user's same-named entry", async () => {
			// Oracle lets the project entry win silently, so a hostile repo could hijack the name
			// of a server the user trusts. Untrusted, the project entry does not exist at all: the
			// USER's server is the one that connects.
			const userScript = writeEchoServerScript(tempHome);
			writeFileSync(join(tempHome, "mcp.toml"), stdioServerToml("fixture", process.execPath, [userScript]), "utf-8");
			const pieDir = join(tempCwd, ".pie");
			mkdirSync(pieDir, { recursive: true });
			writeFileSync(
				join(pieDir, "mcp.toml"),
				stdioServerToml("fixture", "/definitely/not/a/real/path/for/mcp-loader-test"),
				"utf-8",
			);

			const loaded = await loadAll(tempCwd);
			// If the project entry had won, its bogus command would have produced a spawn failure
			// diagnostic and zero clients.
			expect(loaded.diagnostics).toEqual([]);
			expect(loaded.clientCount).toBe(1);
			expect(loaded.serverNames).toEqual(["fixture"]);
		});

		it("a trusted project server still overrides the user entry, but the swap is announced", async () => {
			// Decision: trust decides *whether* the project file is read; a project override is a
			// legitimate thing to want, so the project entry keeps winning. What phase 18 removes
			// is the silence -- oracle substitutes the user's server with nothing surfaced.
			const userPath = join(tempHome, "mcp.toml");
			writeFileSync(
				userPath,
				stdioServerToml("fixture", "/definitely/not/a/real/path/for/mcp-loader-test"),
				"utf-8",
			);
			writeProjectEchoConfig("fixture");
			trustProject(tempCwd);

			const loaded = await loadAll(tempCwd);
			// The project's working echo server won: a clean connect, not the user's broken command.
			expect(loaded.diagnostics).toEqual([]);
			expect(loaded.clientCount).toBe(1);
			expect(loaded.serverNames).toEqual(["fixture"]);
			expect(stderrText()).toBe(
				`pie: project mcp.toml server 'fixture' overrides the same-named entry in ${userPath}\n`,
			);
		});

		it("a trusted project server with a fresh name does not announce an override", async () => {
			const userScript = writeEchoServerScript(tempHome);
			writeFileSync(
				join(tempHome, "mcp.toml"),
				stdioServerToml("user-server", process.execPath, [userScript]),
				"utf-8",
			);
			writeProjectEchoConfig("project-server");
			trustProject(tempCwd);

			const loaded = await loadAll(tempCwd);
			expect(loaded.serverNames).toEqual(["user-server", "project-server"]);
			expect(stderrText()).toBe("");
		});
	});

	describe("PORT-DIVERGENCE: B5 -- user-scope config is unaffected by the gate", () => {
		it("a user-level ~/.pie/mcp.toml loads in an untrusted directory, with no notice", async () => {
			const userScript = writeEchoServerScript(tempHome);
			writeFileSync(
				join(tempHome, "mcp.toml"),
				stdioServerToml("user-server", process.execPath, [userScript]),
				"utf-8",
			);
			// The cwd is untrusted and has no project config at all.
			expect(existsSync(join(tempCwd, ".pie", "mcp.toml"))).toBe(false);

			const loaded = await loadAll(tempCwd);
			expect(loaded.diagnostics).toEqual([]);
			expect(loaded.clientCount).toBe(1);
			expect(loaded.serverNames).toEqual(["user-server"]);
			expect(loaded.tools.map((t) => t.name)).toEqual(["echo"]);
			// Critical for parity: a cwd with no project config must stay completely silent, so the
			// new notice cannot leak into a byte-compared scenario.
			expect(stderrText()).toBe("");
		});

		it("a directory with no project config emits nothing whether trusted or not", async () => {
			trustProject(tempCwd);

			const loaded = await loadAll(tempCwd);
			expect(loaded.clientCount).toBe(0);
			expect(loaded.diagnostics).toEqual([]);
			expect(stderrText()).toBe("");
		});

		// phase 19 F5: `pie` run from `$HOME` makes `<cwd>/.pie` the user config dir itself, so the
		// "project" file the gate was judging was the user's own -- already loaded above as
		// `userPath`. HOME is never touched: `PIE_DIR` points the user config dir at
		// `<homeCwd>/.pie`, which is the same shape.
		it("running from the user config directory's parent: user config loads, no notice", async () => {
			const homeCwd = mkdtempSync(join(tmpdir(), "pi-test-mcp-homecwd-"));
			try {
				const userDir = join(homeCwd, ".pie");
				mkdirSync(userDir, { recursive: true });
				process.env[ENV_BASE_DIR] = userDir;
				const script = writeEchoServerScript(userDir);
				writeFileSync(
					join(userDir, "mcp.toml"),
					stdioServerToml("user-server", process.execPath, [script]),
					"utf-8",
				);

				const loaded = await loadAll(homeCwd);

				expect(loaded.diagnostics).toEqual([]);
				expect(loaded.serverNames).toEqual(["user-server"]);
				expect(loaded.clientCount).toBe(1);
				// The whole finding: the user's own config must not be reported as an untrusted
				// project config, and the user must not be told to `--trust-project` their home.
				expect(stderrText()).toBe("");
			} finally {
				rmSync(homeCwd, { recursive: true, force: true });
			}
		});

		it(`${ENV_TRUST_PROJECT}=1 there does not read the user config twice into a self-override`, async () => {
			const homeCwd = mkdtempSync(join(tmpdir(), "pi-test-mcp-homecwd-trusted-"));
			try {
				const userDir = join(homeCwd, ".pie");
				mkdirSync(userDir, { recursive: true });
				process.env[ENV_BASE_DIR] = userDir;
				const script = writeEchoServerScript(userDir);
				writeFileSync(
					join(userDir, "mcp.toml"),
					stdioServerToml("user-server", process.execPath, [script]),
					"utf-8",
				);
				// The other half of the same false positive: with the directory trusted, the same
				// file was read a second time as "the project config" and every entry collided with
				// itself -- announcing that the user's server overrides the user's server.
				process.env[ENV_TRUST_PROJECT] = "1";

				const loaded = await loadAll(homeCwd);

				expect(loaded.serverNames).toEqual(["user-server"]);
				expect(loaded.clientCount).toBe(1);
				expect(stderrText()).toBe("");
			} finally {
				rmSync(homeCwd, { recursive: true, force: true });
			}
		});
	});

	describe("connectAll", () => {
		it("client_count reflects successful connections, not attempts (oracle code-review item #9)", async () => {
			const configs: ServerConfig[] = [
				{
					name: "broken-a",
					kind: "stdio",
					command: "/definitely/not/a/real/path/for/mcp/test-a",
					args: [],
					inject_summary: false,
					inject_and_run: false,
				},
				{
					name: "broken-b",
					kind: "stdio",
					command: "/definitely/not/a/real/path/for/mcp/test-b",
					args: [],
					inject_summary: false,
					inject_and_run: false,
				},
			];
			const result = await connectAll(configs);
			expect(result.clientCount).toBe(0);
			expect(result.serverNames).toEqual([]);
			expect(result.tools).toEqual([]);
			expect(result.notificationHooks).toEqual([]);
			expect(result.diagnostics).toHaveLength(2);
			expect(result.diagnostics.some((d) => d.includes("broken-a"))).toBe(true);
			expect(result.diagnostics.some((d) => d.includes("broken-b"))).toBe(true);
		});

		it("empty config list reports zero", async () => {
			const result = await connectAll([]);
			expect(result.tools).toEqual([]);
			expect(result.notificationHooks).toEqual([]);
			expect(result.diagnostics).toEqual([]);
			expect(result.clientCount).toBe(0);
			expect(result.serverNames).toEqual([]);
		});

		it("streamable_http server with command/args set is rejected, not spawned as stdio", async () => {
			const configs: ServerConfig[] = [
				{
					name: "custom-http",
					kind: "streamable_http",
					command: "node",
					args: ["server.js"],
					endpoint: "https://mcp.example.com/mcp",
					inject_summary: false,
					inject_and_run: false,
				},
			];
			const result = await connectAll(configs);
			expect(result.clientCount).toBe(0);
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toContain("must set endpoint, not command/args");
		});
	});

	describe("parseMcpConfigText", () => {
		it("deserializes a streamable_http config with a bearer token ref", () => {
			const result = parseMcpConfigText(`
[[server]]
name = "remote-docs"
kind = "streamable_http"
endpoint = "https://mcp.example.com/mcp"
auth = { kind = "bearer", token_keychain_ref = "mcp-example:default" }
request_timeout_ms = 30000
sse_idle_timeout_ms = 60000
body_cap_bytes = 1048576
`);
			expect("error" in result).toBe(false);
			if ("error" in result) return;
			expect(result.server).toHaveLength(1);
			const server = result.server[0];
			expect(server.name).toBe("remote-docs");
			expect(server.kind).toBe("streamable_http");
			expect(server.endpoint).toBe("https://mcp.example.com/mcp");
			expect(server.auth?.token_keychain_ref).toBe("mcp-example:default");
		});

		it("defaults kind to stdio, args to [], and inject_* to false", () => {
			const result = parseMcpConfigText('[[server]]\nname = "x"\ncommand = "echo"\n');
			expect("error" in result).toBe(false);
			if ("error" in result) return;
			expect(result.server[0].kind).toBe("stdio");
			expect(result.server[0].args).toEqual([]);
			expect(result.server[0].inject_summary).toBe(false);
			expect(result.server[0].inject_and_run).toBe(false);
		});

		it("returns an error for malformed TOML", () => {
			const result = parseMcpConfigText("not [ valid toml");
			expect("error" in result).toBe(true);
		});

		it("returns an error for a shape that doesn't match the schema", () => {
			const result = parseMcpConfigText("server = 5\n");
			expect("error" in result).toBe(true);
		});

		// pie: mcp_loader.rs:40-42 (`Option<u64>`/`Option<usize>`) and mcp_loader.rs:74-76 (same for
		// `ReconnectConfig`). serde cannot deserialize a negative or fractional TOML value into an
		// unsigned integer, and `toml::from_str::<McpConfig>` (mcp_loader.rs:191) fails for the whole
		// document when any single field does -- there is no per-field or per-server salvage.
		describe("unsigned-integer fields reject out-of-domain values (serde u64/usize parity)", () => {
			const outOfDomain: ReadonlyArray<readonly [string, string]> = [
				["request_timeout_ms negative", "request_timeout_ms = -1"],
				["request_timeout_ms fractional", "request_timeout_ms = 1.5"],
				["sse_idle_timeout_ms negative", "sse_idle_timeout_ms = -1"],
				["sse_idle_timeout_ms fractional", "sse_idle_timeout_ms = 0.5"],
				["body_cap_bytes negative", "body_cap_bytes = -1"],
				["body_cap_bytes fractional", "body_cap_bytes = 1048576.5"],
				["reconnect.initial_ms negative", "reconnect = { initial_ms = -1 }"],
				["reconnect.max_ms negative", "reconnect = { max_ms = -1 }"],
				["reconnect.max_attempts negative", "reconnect = { max_attempts = -1 }"],
				["reconnect.max_attempts fractional", "reconnect = { max_attempts = 2.5 }"],
			];

			for (const [label, line] of outOfDomain) {
				it(`${label} fails the whole file, dropping every server in it`, () => {
					// Two servers in one file: the offending streamable_http entry, and an innocent
					// stdio entry whose `command` oracle would never reach (whole-document parse
					// failure). If the TS schema accepted the bad value, `loader` would happily hand
					// this stdio `command` to `StdioTransport.spawn` -- strictly more permissive than
					// oracle, i.e. an amplification of B5, not a faithful port of it.
					const result = parseMcpConfigText(`
[[server]]
name = "remote-docs"
kind = "streamable_http"
endpoint = "https://mcp.example.com/mcp"
${line}

[[server]]
name = "innocent-stdio"
command = "/bin/echo"
`);
					expect("error" in result).toBe(true);
					if (!("error" in result)) return;
					expect(result.error).toBe("invalid mcp.toml shape");
				});
			}

			it("accepts the in-domain values oracle accepts (0 included -- rejected later at connect time)", () => {
				const result = parseMcpConfigText(`
[[server]]
name = "remote-docs"
kind = "streamable_http"
endpoint = "https://mcp.example.com/mcp"
request_timeout_ms = 30000
sse_idle_timeout_ms = 0
body_cap_bytes = 1048576
reconnect = { initial_ms = 500, max_ms = 30000, max_attempts = 0 }
`);
				expect("error" in result).toBe(false);
				if ("error" in result) return;
				expect(result.server[0].request_timeout_ms).toBe(30000);
				expect(result.server[0].sse_idle_timeout_ms).toBe(0);
				expect(result.server[0].reconnect).toEqual({ initial_ms: 500, max_ms: 30000, max_attempts: 0 });
			});
		});

		// End-to-end companion to the unit cases above: the *file-scoped* blast radius, observed
		// through `loadAll`. pie: mcp_loader.rs:107 -- `read_config` returning `None` means the
		// file contributes zero `ServerConfig`s, so nothing in it is ever spawned.
		it("a single out-of-domain number in project mcp.toml prevents every server in that file from spawning", async () => {
			const scriptPath = writeEchoServerScript(tempCwd);
			const pieDir = join(tempCwd, ".pie");
			mkdirSync(pieDir, { recursive: true });
			const projectToml = join(pieDir, "mcp.toml");
			writeFileSync(
				projectToml,
				`[[server]]\nname = "remote-docs"\nkind = "streamable_http"\nendpoint = "https://mcp.example.com/mcp"\nrequest_timeout_ms = -1\n\n${stdioServerToml("fixture", process.execPath, [scriptPath])}`,
				"utf-8",
			);
			// This case is about the *file-scoped* blast radius of a bad value, which only becomes
			// observable once the file is read at all -- so trust the directory (PORT-DIVERGENCE B5).
			trustProject(tempCwd);

			const loaded = await loadAll(tempCwd);
			// The fixture stdio server is NOT spawned even though its own config is well-formed.
			expect(loaded.clientCount).toBe(0);
			expect(loaded.serverNames).toEqual([]);
			expect(loaded.tools).toEqual([]);
			expect(loaded.diagnostics).toHaveLength(1);
			expect(loaded.diagnostics[0]).toBe(
				`mcp config (project, ${projectToml}): parse failed: invalid mcp.toml shape`,
			);
		});
	});

	describe("resolveHttpAuthFromStore", () => {
		it("resolves bearer auth from the store without leaking the token in debug output", async () => {
			const token = "mcp_token_should_not_leak";
			const store = AuthStorage.inMemory({
				"remote-docs:default": { type: "api_key", key: token },
			});
			const auth = await resolveHttpAuthFromStore(
				{ kind: "bearer", token_keychain_ref: "remote-docs:default" },
				store,
			);
			expect(auth).toEqual({ kind: "bearer", token });
			const debug = debugHttpMcpAuth(auth);
			expect(debug).not.toContain(token);
			expect(debug).toContain("<redacted>");
		});

		it("missing auth diagnostic does not echo the token ref", async () => {
			const store = AuthStorage.inMemory({});
			const secretLikeRef = "secret_ref_should_not_leak";
			try {
				await resolveHttpAuthFromStore({ kind: "bearer", token_keychain_ref: secretLikeRef }, store);
				expect.unreachable("expected resolveHttpAuthFromStore to reject");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				expect(message).not.toContain(secretLikeRef);
				expect(message).toContain("<configured-token-ref>");
			}
		});

		it("returns none auth when no auth config is given", async () => {
			const store = AuthStorage.inMemory({});
			const auth = await resolveHttpAuthFromStore(undefined, store);
			expect(auth).toEqual({ kind: "none" });
		});

		it("rejects non-bearer auth kinds", async () => {
			const store = AuthStorage.inMemory({});
			await expect(resolveHttpAuthFromStore({ kind: "basic" }, store)).rejects.toThrow(
				/unsupported streamable_http auth kind/,
			);
		});
	});

	// `resolveHttpAuth` (the real-store wrapper, pie: mcp_loader.rs:314-322) is module-private in
	// both oracle and this port, so it is exercised through `connectAll`, matching how the loader
	// actually reaches it. `ENV_BASE_DIR` points at `tempHome` for the whole describe block, so
	// `AuthStorage.create()` resolves to `<tempHome>/auth.json`.
	describe("resolveHttpAuth (real credential store)", () => {
		/**
		 * `request_timeout_ms = 0` is the cheapest deterministic stop *after* auth resolution:
		 * `connectStreamableHttp` resolves auth (mcp_loader.rs:269) before validating the timeout
		 * (mcp_loader.rs:270-278), so this reaches the code under test and then bails without any
		 * network I/O.
		 */
		function httpServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
			return {
				name: "remote-docs",
				kind: "streamable_http",
				args: [],
				endpoint: "https://mcp.example.com/mcp",
				inject_summary: false,
				inject_and_run: false,
				...overrides,
			};
		}

		it("a server without an auth config never materializes the credential store", async () => {
			// pie: mcp_loader.rs:315-317 -- the `None` early return happens before
			// `AuthStore::load()`, so oracle does not touch the credential directory at all here.
			expect(readdirSync(tempHome)).toEqual([]);

			const result = await connectAll([httpServerConfig({ request_timeout_ms: 0 })]);

			// Proves auth resolution ran (we got past it) and then stopped before any network I/O.
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toContain("request_timeout_ms must be positive");
			expect(result.clientCount).toBe(0);

			// The observable point: no `auth.json`, no lock residue, nothing at all.
			expect(existsSync(join(tempHome, "auth.json"))).toBe(false);
			expect(readdirSync(tempHome)).toEqual([]);
		});

		it("a corrupt credential store surfaces a load failure, not a 'not logged in' diagnostic", async () => {
			// pie: mcp_loader.rs:319-320 -- `AuthStore::load()`'s error is mapped to
			// "failed to load local credential store: {e}; {recovery}" and propagated with `?`.
			writeFileSync(join(tempHome, "auth.json"), "{ this is not valid json", "utf-8");

			const result = await connectAll([
				httpServerConfig({ auth: { kind: "bearer", token_keychain_ref: "mcp-example:default" } }),
			]);

			expect(result.clientCount).toBe(0);
			expect(result.diagnostics).toHaveLength(1);
			const diagnostic = result.diagnostics[0];
			expect(diagnostic).toMatch(/^mcp server 'remote-docs' failed: failed to load local credential store: /);
			expect(diagnostic).toContain("run /login <configured-token-ref>");
			// Must NOT be misattributed to a missing credential -- `/login` cannot repair a damaged
			// store, so reporting this as "you have not logged in" sends the user down a dead end.
			expect(diagnostic).not.toContain("configured bearer credential was not found");
			// Same leak guarantee as the injected-store path: the ref is never echoed.
			expect(diagnostic).not.toContain("mcp-example:default");
		});

		it("a readable but empty credential store still reports the missing-credential diagnostic", async () => {
			// Control for the case above: a *loadable* store that simply lacks the credential must
			// keep oracle's distinct message (mcp_loader.rs:341), so the new load-error branch has
			// not swallowed the ordinary lookup miss.
			writeFileSync(join(tempHome, "auth.json"), "{}", "utf-8");

			const result = await connectAll([
				httpServerConfig({ auth: { kind: "bearer", token_keychain_ref: "mcp-example:default" } }),
			]);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toContain("configured bearer credential was not found");
			expect(result.diagnostics[0]).not.toContain("failed to load local credential store");
		});
	});
});
