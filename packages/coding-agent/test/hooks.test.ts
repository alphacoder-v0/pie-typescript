import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionCompactEvent } from "@pie/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_BASE_DIR } from "../src/config.ts";
import {
	type HookRule,
	HookRunner,
	type LoadedHooks,
	load,
	parseHookEvent,
	parseHooksFileText,
	pushRules,
} from "../src/hooks.ts";

// pie: crates/coding-agent/src/hooks.rs `#[cfg(test)] mod tests` -- ported with equivalent
// coverage. Test names mirror oracle's where a direct analog exists.

function makeRunner(rules: HookRule[]): HookRunner {
	return new HookRunner({
		rules,
		sessionId: "session-1",
		cwd: process.cwd(),
		modelProvider: "faux",
		modelId: "model",
		thinkingLevel: "off",
	});
}

function makeRule(event: HookRule["event"], overrides: Partial<HookRule> = {}): HookRule {
	return {
		event,
		command: undefined,
		webhook: undefined,
		headers: {},
		timeoutMs: 1_000,
		cwd: "project",
		onFailure: "warn",
		tool: undefined,
		source: "test",
		...overrides,
	};
}

let workDirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	workDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of workDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	workDirs = [];
});

describe("hooks: parsing", () => {
	it("parses hook rules and skips bad entries", () => {
		const text = `
allow_project_hooks = true

[[hook]]
event = "tool_end"
command = "echo ok"
tool = "bash"

[[hook]]
event = "compaction"
command = "echo compacted"

[[hook]]
event = "not_real"
command = "echo nope"
`;
		const result = parseHooksFileText(text);
		if ("error" in result) throw new Error(`unexpected parse error: ${result.error}`);
		const rules: HookRule[] = [];
		const diagnostics: string[] = [];
		pushRules(result, "test", rules, diagnostics);

		expect(rules).toHaveLength(2);
		expect(rules[0]!.event).toBe("tool_end");
		expect(rules[0]!.tool).toBe("bash");
		expect(rules[1]!.event).toBe("compaction");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toContain("unknown event");
	});

	it("skips a hook with neither command nor webhook", () => {
		const text = `
[[hook]]
event = "agent_start"
`;
		const result = parseHooksFileText(text);
		if ("error" in result) throw new Error("unexpected parse error");
		const rules: HookRule[] = [];
		const diagnostics: string[] = [];
		pushRules(result, "test", rules, diagnostics);
		expect(rules).toHaveLength(0);
		expect(diagnostics[0]).toContain("neither command nor webhook");
	});

	it("skips a hook explicitly disabled via enabled = false", () => {
		const text = `
[[hook]]
event = "agent_start"
command = "echo hi"
enabled = false
`;
		const result = parseHooksFileText(text);
		if ("error" in result) throw new Error("unexpected parse error");
		const rules: HookRule[] = [];
		const diagnostics: string[] = [];
		pushRules(result, "test", rules, diagnostics);
		expect(rules).toHaveLength(0);
		expect(diagnostics).toHaveLength(0);
	});

	it("rejects the whole file on a structurally invalid hooks.toml (wrong field type)", () => {
		const text = `
[[hook]]
event = "agent_start"
command = "echo hi"
timeout_ms = "not-a-number"
`;
		const result = parseHooksFileText(text);
		expect("error" in result).toBe(true);
	});

	it("parseHookEvent recognizes exactly the 11 oracle event names", () => {
		const known = [
			"agent_start",
			"agent_end",
			"turn_start",
			"turn_end",
			"message_start",
			"message_update",
			"message_end",
			"tool_start",
			"tool_update",
			"tool_end",
			"compaction",
		];
		for (const name of known) {
			expect(parseHookEvent(name)).toBe(name);
		}
		expect(parseHookEvent("not_real")).toBeUndefined();
	});
});

describe("hooks: opt-in gate for project hooks.toml", () => {
	let cwd: string;
	let agentDir: string;
	let savedBaseDir: string | undefined;
	let savedAllow: string | undefined;

	beforeEach(() => {
		cwd = tempDir("hooks-cwd-");
		agentDir = tempDir("hooks-agent-");
		savedBaseDir = process.env[ENV_BASE_DIR];
		savedAllow = process.env.PIE_ALLOW_PROJECT_HOOKS;
		process.env[ENV_BASE_DIR] = agentDir;
		delete process.env.PIE_ALLOW_PROJECT_HOOKS;
	});

	afterEach(() => {
		if (savedBaseDir === undefined) delete process.env[ENV_BASE_DIR];
		else process.env[ENV_BASE_DIR] = savedBaseDir;
		if (savedAllow === undefined) delete process.env.PIE_ALLOW_PROJECT_HOOKS;
		else process.env.PIE_ALLOW_PROJECT_HOOKS = savedAllow;
	});

	function writeProjectHooksToml(): void {
		mkdirSync(join(cwd, ".pie"), { recursive: true });
		writeFileSync(
			join(cwd, ".pie", "hooks.toml"),
			`
[[hook]]
event = "agent_start"
command = "echo project-hook-ran"
`,
			"utf-8",
		);
	}

	it("project hooks are NOT loaded without explicit allow (no env var, no allow_project_hooks)", async () => {
		writeProjectHooksToml();
		const loaded: LoadedHooks = await load(cwd, "session-1", undefined, undefined);
		expect(loaded.runner.isEmpty()).toBe(true);
		expect(loaded.diagnostics.some((d) => d.includes("project hooks ignored"))).toBe(true);
		expect(loaded.diagnostics.some((d) => d.includes("allow_project_hooks = true"))).toBe(true);
		expect(loaded.diagnostics.some((d) => d.includes("PIE_ALLOW_PROJECT_HOOKS=1"))).toBe(true);
	});

	it("project hooks load when PIE_ALLOW_PROJECT_HOOKS=1 is set", async () => {
		writeProjectHooksToml();
		process.env.PIE_ALLOW_PROJECT_HOOKS = "1";
		const loaded = await load(cwd, "session-1", undefined, undefined);
		expect(loaded.runner.isEmpty()).toBe(false);
		expect(loaded.runner.size()).toBe(1);
	});

	it("project hooks load when PIE_ALLOW_PROJECT_HOOKS=true (case-insensitive) is set", async () => {
		writeProjectHooksToml();
		process.env.PIE_ALLOW_PROJECT_HOOKS = "True";
		const loaded = await load(cwd, "session-1", undefined, undefined);
		expect(loaded.runner.size()).toBe(1);
	});

	it("an unrecognized PIE_ALLOW_PROJECT_HOOKS value does not opt in", async () => {
		writeProjectHooksToml();
		process.env.PIE_ALLOW_PROJECT_HOOKS = "yes";
		const loaded = await load(cwd, "session-1", undefined, undefined);
		expect(loaded.runner.isEmpty()).toBe(true);
	});

	it("project hooks load when the user's own hooks.toml sets allow_project_hooks = true", async () => {
		writeFileSync(join(agentDir, "hooks.toml"), "allow_project_hooks = true\n", "utf-8");
		writeProjectHooksToml();
		const loaded = await load(cwd, "session-1", undefined, undefined);
		expect(loaded.runner.size()).toBe(1);
	});

	it("user hooks always load regardless of the project gate", async () => {
		writeFileSync(
			join(agentDir, "hooks.toml"),
			`
[[hook]]
event = "agent_start"
command = "echo user-hook-ran"
`,
			"utf-8",
		);
		writeProjectHooksToml();
		const loaded = await load(cwd, "session-1", undefined, undefined);
		// User hook loads (1); project hook stays gated out.
		expect(loaded.runner.size()).toBe(1);
		expect(loaded.diagnostics.some((d) => d.includes("project hooks ignored"))).toBe(true);
	});

	it("no diagnostic is produced when there is simply no project hooks.toml at all", async () => {
		const loaded = await load(cwd, "session-1", undefined, undefined);
		expect(loaded.runner.isEmpty()).toBe(true);
		expect(loaded.diagnostics.some((d) => d.includes("project hooks ignored"))).toBe(false);
	});
});

describe("hooks: HookRunner execution", () => {
	it("command hook receives env and payload", async () => {
		const dir = tempDir("hooks-out-");
		const out = join(dir, "hook.out");
		const rule = makeRule("tool_end", {
			command: `printf '%s %s ' "$PIE_HOOK_EVENT" "$PIE_TOOL_NAME" > ${out}; test -s "$PIE_HOOK_PAYLOAD"`,
		});
		const runner = makeRunner([rule]);
		const ev: AgentEvent = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: null, terminate: undefined },
			isError: false,
		};
		await runner.handleEvent(ev, new AbortController().signal);
		const body = readFileSync(out, "utf-8");
		expect(body).toBe("tool_end bash ");
	});

	it("compaction hook receives env and payload with manual trigger + tokens_before", async () => {
		const dir = tempDir("hooks-out-");
		const out = join(dir, "hook.out");
		const rule = makeRule("compaction", {
			command: `printf '%s %s %s ' "$PIE_HOOK_EVENT" "$PIE_COMPACTION_TRIGGER" "$PIE_COMPACTION_TOKENS_BEFORE" > ${out}; grep -q '"compaction_summary":"summary text"' "$PIE_HOOK_PAYLOAD"`,
		});
		const runner = makeRunner([rule]);
		const ev: SessionCompactEvent = {
			type: "session_compact",
			fromHook: true,
			compactionEntry: {
				type: "compaction",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "summary text",
				firstKeptEntryId: "entry-0",
				tokensBefore: 42,
			},
		};
		await runner.handleCompactionEvent(ev, new AbortController().signal);
		const body = readFileSync(out, "utf-8");
		expect(body).toBe("compaction manual 42 ");
	});

	it("compaction hook reports 'auto' trigger when fromHook is false", async () => {
		const dir = tempDir("hooks-out-");
		const out = join(dir, "hook.out");
		const rule = makeRule("compaction", { command: `printf '%s' "$PIE_COMPACTION_TRIGGER" > ${out}` });
		const runner = makeRunner([rule]);
		const ev: SessionCompactEvent = {
			type: "session_compact",
			fromHook: false,
			compactionEntry: {
				type: "compaction",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "s",
				firstKeptEntryId: "entry-0",
				tokensBefore: 1,
			},
		};
		await runner.handleCompactionEvent(ev, new AbortController().signal);
		expect(readFileSync(out, "utf-8")).toBe("auto");
	});

	it("tool filter skips non-matching tool", async () => {
		const dir = tempDir("hooks-out-");
		const out = join(dir, "hook.out");
		const rule = makeRule("tool_end", { tool: "bash", command: `touch ${out}` });
		const runner = makeRunner([rule]);
		const ev: AgentEvent = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: { content: [], details: null, terminate: undefined },
			isError: false,
		};
		await runner.handleEvent(ev, new AbortController().signal);
		expect(existsSync(out)).toBe(false);
	});

	it("full HookPayload wire shape: all keys present, nulls for absent optional fields (probe)", async () => {
		const dir = tempDir("hooks-out-");
		const out = join(dir, "payload.json");
		const rule = makeRule("agent_start", { command: `cp "$PIE_HOOK_PAYLOAD" ${out}` });
		const runner = makeRunner([rule]);
		const ev: AgentEvent = { type: "agent_start" };
		await runner.handleEvent(ev, new AbortController().signal);
		const payload = JSON.parse(readFileSync(out, "utf-8"));

		expect(Object.keys(payload)).toEqual([
			"event",
			"session_id",
			"cwd",
			"model_provider",
			"model_id",
			"thinking_level",
			"source",
			"message_kind",
			"message_summary",
			"assistant_event",
			"tool_call_id",
			"tool_name",
			"tool_is_error",
			"tool_args",
			"tool_result_summary",
			"compaction_trigger",
			"compaction_tokens_before",
			"compaction_summary",
		]);
		expect(payload.event).toBe("agent_start");
		expect(payload.session_id).toBe("session-1");
		expect(payload.source).toBe("test");
		// Every field this event doesn't populate is explicit JSON null, not omitted.
		expect(payload.message_kind).toBeNull();
		expect(payload.tool_call_id).toBeNull();
		expect(payload.tool_is_error).toBeNull();
		expect(payload.compaction_tokens_before).toBeNull();
	});

	it("webhook hook posts JSON payload with pie/ User-Agent and custom headers", async () => {
		let seenBody = "";
		let seenHeaders: Record<string, string> = {};
		let seenMethod = "";
		const server: Server = createServer((req, res) => {
			seenMethod = req.method ?? "";
			seenHeaders = req.headers as Record<string, string>;
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				seenBody = Buffer.concat(chunks).toString("utf-8");
				res.writeHead(204);
				res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

		try {
			const rule = makeRule("turn_end", {
				webhook: `http://127.0.0.1:${address.port}/hook`,
				headers: { "X-Custom": "abc" },
			});
			const runner = makeRunner([rule]);
			const ev: AgentEvent = {
				type: "turn_end",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [],
					isError: false,
					timestamp: 0,
				},
				toolResults: [],
			};
			await runner.handleEvent(ev, new AbortController().signal);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}

		expect(seenMethod).toBe("POST");
		expect(seenHeaders["content-type"]).toBe("application/json");
		expect(seenHeaders["user-agent"]).toMatch(/^pie\//);
		expect(seenHeaders["x-custom"]).toBe("abc");
		expect(seenBody).toContain('"event":"turn_end"');
	});

	it("webhook non-2xx status is swallowed by on_failure=warn (no throw out of handleEvent)", async () => {
		const server: Server = createServer((_req, res) => {
			res.writeHead(500);
			res.end("boom");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected AddressInfo");

		try {
			const rule = makeRule("agent_start", {
				webhook: `http://127.0.0.1:${address.port}/hook`,
				onFailure: "warn",
			});
			const runner = makeRunner([rule]);
			await expect(
				runner.handleEvent({ type: "agent_start" }, new AbortController().signal),
			).resolves.toBeUndefined();
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("hooks: command timeout / cancellation kill the descendant process tree", () => {
	it.skipIf(process.platform === "win32")(
		"command hook timeout kills descendant process",
		async () => {
			const marker = `pie-hook-timeout-test-${randomBytes(6).toString("hex")}`;
			const rule = makeRule("tool_end", {
				timeoutMs: 100,
				command: `(sleep 30 && echo ${marker}) & wait`,
			});
			const runner = makeRunner([rule]);
			const started = Date.now();
			const ev: AgentEvent = {
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "bash",
				result: { content: [], details: null, terminate: undefined },
				isError: false,
			};
			await runner.handleEvent(ev, new AbortController().signal);
			expect(Date.now() - started).toBeLessThan(5_000);

			await new Promise((resolve) => setTimeout(resolve, 300));
			const survivors = await pgrepMarker(marker);
			expect(survivors).toBe("");
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"command hook cancellation kills descendant process",
		async () => {
			const marker = `pie-hook-cancel-test-${randomBytes(6).toString("hex")}`;
			const rule = makeRule("tool_end", {
				timeoutMs: 30_000,
				command: `(sleep 30 && echo ${marker}) & wait`,
			});
			const runner = makeRunner([rule]);
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 200);

			const started = Date.now();
			const ev: AgentEvent = {
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "bash",
				result: { content: [], details: null, terminate: undefined },
				isError: false,
			};
			await runner.handleEvent(ev, controller.signal);
			expect(Date.now() - started).toBeLessThan(5_000);

			await new Promise((resolve) => setTimeout(resolve, 300));
			const survivors = await pgrepMarker(marker);
			expect(survivors).toBe("");
		},
		10_000,
	);
});

async function pgrepMarker(marker: string): Promise<string> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve) => {
		const child = spawn("pgrep", ["-f", marker], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf-8");
		});
		child.on("close", () => resolve(out.trim()));
		child.on("error", () => resolve(""));
	});
}
