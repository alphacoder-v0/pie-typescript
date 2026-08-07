/**
 * char-tests port of oracle `crates/coding-agent/tests/hooks_e2e.rs` (pie @0a120dfd).
 *
 * Oracle module doc: "End-to-end test for user-configured webhook hooks. This drives a real
 * AgentHarness, loads hooks from a PIE_DIR-scoped hooks.toml, subscribes the hook listener, and
 * verifies that the agent's turn_end event is delivered as an HTTP POST."
 *
 * Oracle test functions: 3. Ported (running): 3. `it.skip`: 0.
 *
 * Construct mapping notes (shared by all three tests):
 * - `MemorySessionStorage` -> `InMemorySessionStorage`; `AgentHarnessOptions::new(model, session)`
 *   + `opts.stream_fn` -> `new AgentHarness({ env, session, model, getApiKeyAndHeaders })` with
 *   the canned replies queued on a `registerFauxProvider` registration (the TS `AgentHarness` has
 *   no `stream_fn` slot -- agent-harness.ts:1613 -- and builds its stream fn from the model's
 *   registered API provider). Oracle's `faux_stream(text)` returns the SAME text for every
 *   invocation, so every registration below queues N identical responses rather than a sequence.
 * - `env` / `getApiKeyAndHeaders` have no counterpart on oracle's option struct; both are TS-side
 *   requirements. `NodeExecutionEnv` is not re-exported from the `@pie/agent-core` bucket (only
 *   from its `/node` subpath, which this package's vitest alias does not map to source), so it is
 *   imported through its source path -- the same module the `@pie/agent-core` alias resolves to.
 * - `harness.agent().subscribe(loaded.runner.listener())` (hooks_e2e.rs:188): oracle has TWO
 *   buses (the inner `Agent`'s `AgentEvent` bus and the harness's own `HarnessEvent` bus). TS's
 *   `AgentHarness.subscribe()` is a single MERGED bus (`AgentEvent | AgentHarnessOwnEvent`), so
 *   the forwarder below narrows to the `AgentEvent` half -- exactly the set oracle's
 *   `AgentListener` could ever observe.
 * - `harness.subscribe_harness(loaded.runner.harness_listener())` (hooks_e2e.rs:257,316):
 *   compaction is NOT a variant of TS's `HarnessEvent`; it lives on `AgentHarnessOwnEvent` as
 *   `session_compact`, and `hooks.ts`'s `harnessListener()` is typed against `SessionCompactEvent`
 *   accordingly (its module doc records this already-adjudicated channel remap). The forwarder
 *   below therefore routes `session_compact` off the merged bus into `harnessListener()`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@pie/agent-core";
import { AgentHarness, InMemorySessionStorage, Session } from "@pie/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../agent/src/harness/env/nodejs.ts";
import { ENV_BASE_DIR } from "../../src/config.ts";
import { type HookRunner, load } from "../../src/hooks.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────
// Fixtures / teardown. pie: hooks_e2e.rs:27-51 (`ENV_LOCK` + `EnvGuard`). vitest runs the tests
// of one file sequentially, so the process-global `PIE_DIR` needs a save/restore guard but no
// mutex.
// ─────────────────────────────────────────────────────────────────────────────────────────

interface CaptureServer {
	server: Server;
	/** Every accepted socket, so teardown can destroy them. Oracle's listener is dropped with the
	 * test (`capture_one_request` accepts exactly one connection and the runtime reaps the rest);
	 * a node `net.Server.close()` instead waits for live sockets, and the harness DOES open more
	 * than one (a second compaction event fires a second POST that this listener never answers).
	 */
	sockets: Array<{ destroy: () => void }>;
}

let registrations: FauxProviderRegistration[] = [];
let tempDirs: string[] = [];
let servers: CaptureServer[] = [];
let envRestore: Array<() => void> = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** pie: hooks_e2e.rs:29-51 (`EnvGuard::set` + its `Drop`). */
function setEnv(key: string, value: string): void {
	const old = process.env[key];
	envRestore.push(() => {
		if (old === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = old;
		}
	});
	process.env[key] = value;
}

afterEach(async () => {
	for (const restore of envRestore.reverse()) restore();
	envRestore = [];
	for (const registration of registrations) registration.unregister();
	registrations = [];
	for (const { server, sockets } of servers) {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	servers = [];
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

/**
 * pie: hooks_e2e.rs:53-69 (`faux_model`) -- `context_window` is the one field the three tests
 * vary, so it is a parameter here (oracle hardcodes `1`; see the per-test notes).
 */
function fauxProvider(contextWindow: number): FauxProviderRegistration {
	const registration = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", name: "Faux", contextWindow, maxTokens: 0 }],
	});
	registrations.push(registration);
	return registration;
}

/** pie: hooks_e2e.rs:71-99 (`faux_stream`) -- one constant reply for every provider call. */
function constantReplies(registration: FauxProviderRegistration, text: string): void {
	registration.setResponses(Array.from({ length: 16 }, () => fauxAssistantMessage(text)));
}

/** pie: hooks_e2e.rs:140-149 (`content_length`). */
function contentLength(headers: string): number | undefined {
	for (const line of headers.split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		if (line.slice(0, idx).trim().toLowerCase() !== "content-length") continue;
		const parsed = Number.parseInt(line.slice(idx + 1).trim(), 10);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

/**
 * pie: hooks_e2e.rs:101-134 (`capture_one_request`). A raw TCP listener (not an HTTP server) so
 * the test can assert on the exact request line and header bytes the hook runner puts on the
 * wire, exactly as oracle does.
 */
async function captureOneRequest(): Promise<{ url: string; request: Promise<string> }> {
	const server = createServer();
	const entry: CaptureServer = { server, sockets: [] };
	servers.push(entry);
	server.on("connection", (socket) => entry.sockets.push(socket));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("expected an AddressInfo");
	const url = `http://127.0.0.1:${address.port}/pie-hook`;

	const request = new Promise<string>((resolve, reject) => {
		server.once("connection", (socket) => {
			let buf = Buffer.alloc(0);
			let done = false;
			socket.on("data", (chunk: Buffer) => {
				if (done) return;
				buf = Buffer.concat([buf, chunk]);
				const headerEnd = buf.indexOf("\r\n\r\n");
				if (headerEnd === -1) return;
				const headers = buf.subarray(0, headerEnd).toString("utf8");
				const bodyEnd = headerEnd + 4 + (contentLength(headers) ?? 0);
				if (buf.length < bodyEnd) return;
				done = true;
				// pie: hooks_e2e.rs:127-130
				socket.write("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
				socket.end();
				resolve(buf.subarray(0, bodyEnd).toString("utf8"));
			});
			socket.on("error", reject);
			// pie: hooks_e2e.rs:111,123 (`assert!(n > 0, "client closed before ...")`).
			socket.on("close", () => {
				if (!done) reject(new Error("client closed before the request was complete"));
			});
		});
	});
	// A losing race branch (below) must not surface as an unhandled rejection.
	request.catch(() => {});
	return { url, request };
}

/** pie: hooks_e2e.rs:192-195 / :263-266 / :325-328 (`tokio::time::timeout(Duration::from_secs(3), request)`). */
async function awaitRequest(request: Promise<string>, what: string): Promise<string> {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} timed out`)), 3_000);
	});
	try {
		return await Promise.race([request, deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** The `AgentEvent.type` tags (types.ts:519-545) -- the half of TS's merged harness bus that
 * corresponds to oracle's separate `Agent` bus. See this file's header note. */
const AGENT_EVENT_TYPES = new Set<string>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"control_plane_prompt_resolved",
]);

/** pie: hooks_e2e.rs:188 (`harness.agent().subscribe(loaded.runner.listener())`). */
function subscribeAgentEvents(harness: AgentHarness, runner: HookRunner): () => void {
	const listener = runner.listener();
	return harness.subscribe((event, signal) => {
		if (!AGENT_EVENT_TYPES.has(event.type)) return;
		return listener(event as AgentEvent, signal ?? new AbortController().signal);
	});
}

/** pie: hooks_e2e.rs:257,316 (`harness.subscribe_harness(loaded.runner.harness_listener())`). */
function subscribeCompaction(harness: AgentHarness, runner: HookRunner): () => void {
	const listener = runner.harnessListener();
	return harness.subscribe((event) => {
		if (event.type === "session_compact") listener(event);
	});
}

function bodyOf(rawRequest: string): Record<string, unknown> {
	const separator = rawRequest.indexOf("\r\n\r\n");
	expect(separator, "request must contain a body separator").toBeGreaterThanOrEqual(0);
	return JSON.parse(rawRequest.slice(separator + 4)) as Record<string, unknown>;
}

describe("hooks_e2e", () => {
	/** pie: hooks_e2e.rs:151-221 */
	it("user_webhook_hook_receives_turn_end_from_agent_harness", async () => {
		// pie: hooks_e2e.rs:153-157
		const pieDir = tempDir("pie-ported-hooks-piedir-");
		const cwd = tempDir("pie-ported-hooks-cwd-");
		setEnv(ENV_BASE_DIR, pieDir);
		const { url: webhookUrl, request } = await captureOneRequest();

		// pie: hooks_e2e.rs:159-170
		writeFileSync(
			join(pieDir, "hooks.toml"),
			`
[[hook]]
event = "turn_end"
webhook = "${webhookUrl}"
timeout_ms = 3000

[hook.headers]
X-Pie-Test = "webhook-e2e"
`,
			"utf-8",
		);

		// pie: hooks_e2e.rs:172-181
		const registration = fauxProvider(1);
		constantReplies(registration, "webhook ack");
		const model = registration.getModel();
		const loaded = await load(cwd, "session-webhook-e2e", model, "off");
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.runner.size()).toBe(1);

		// pie: hooks_e2e.rs:183-189
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd }),
			session,
			model,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		subscribeAgentEvents(harness, loaded.runner);

		// pie: hooks_e2e.rs:190
		await harness.prompt("trigger webhook");

		// pie: hooks_e2e.rs:192-206
		const rawRequest = await awaitRequest(request, "webhook request");
		expect(rawRequest.startsWith("POST /pie-hook HTTP/1.1\r\n"), `unexpected request line: ${rawRequest}`).toBe(true);
		expect(rawRequest.toLowerCase().includes("x-pie-test: webhook-e2e"), `custom header missing: ${rawRequest}`).toBe(
			true,
		);

		// pie: hooks_e2e.rs:208-220
		const payload = bodyOf(rawRequest);
		expect(payload.event).toBe("turn_end");
		expect(payload.session_id).toBe("session-webhook-e2e");
		expect(payload.cwd).toBe(cwd);
		expect(payload.model_provider).toBe("faux");
		expect(payload.model_id).toBe("faux");
		expect(payload.thinking_level).toBe("off");
		expect(payload.source).toBe("user");
		expect(payload.message_kind).toBe("assistant");
		expect(payload.message_summary).toBe("webhook ack");
	});

	/** pie: hooks_e2e.rs:223-280
	 *
	 * Previously `it.skip`, blocked on two agent-core defects that are now fixed; both the
	 * assertions and the `contextWindow: 1` fixture below are oracle's, unadapted.
	 *   - D1 (`fromHook` semantics): oracle's `do_compact(from_hook, ..)` takes the flag as a
	 *     PARAMETER -- `force_compact` passes `true` (agent_harness.rs:1946-1951),
	 *     `run_auto_compaction` passes `false` (:2020-2039) -- and forwards it verbatim onto
	 *     `HarnessEvent::Compaction { from_hook, .. }` (:2109-2113), which
	 *     `crates/coding-agent/src/hooks.rs:743-747` maps to "manual"/"auto".
	 *     `agent-harness.ts` now threads the same parameter through `doCompact`.
	 *   - D2 (empty-summary short circuit): this test relies on the auto-compaction pass over a
	 *     1-turn transcript being a no-op -- `compaction.rs:643-651` returns an EMPTY summary
	 *     when `entries_to_summarize` is empty and `do_compact` (agent_harness.rs:2088-2090,
	 *     2098-2099) drops it before persisting or emitting. `compaction.ts`'s `compact()` now
	 *     short-circuits the same way, so `contextWindow: 1` no longer produces a spurious
	 *     auto-compaction POST that would steal this test's single captured request.
	 */
	it("compaction_webhook_receives_manual_force_compact_from_harness_bus", async () => {
		// pie: hooks_e2e.rs:225-229
		const pieDir = tempDir("pie-ported-hooks-piedir-");
		const cwd = tempDir("pie-ported-hooks-cwd-");
		setEnv(ENV_BASE_DIR, pieDir);
		const { url: webhookUrl, request } = await captureOneRequest();

		// pie: hooks_e2e.rs:231-239
		writeFileSync(
			join(pieDir, "hooks.toml"),
			`
[[hook]]
event = "compaction"
webhook = "${webhookUrl}"
timeout_ms = 3000
`,
			"utf-8",
		);

		// pie: hooks_e2e.rs:241-250 (`faux_model()`, hooks_e2e.rs:53-69 -- `context_window: 1`)
		const registration = fauxProvider(1);
		constantReplies(registration, "manual summary");
		const model = registration.getModel();
		const loaded = await load(cwd, "session-manual-compaction-e2e", model, "off");
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.runner.size()).toBe(1);

		// pie: hooks_e2e.rs:252-257
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd }),
			session,
			model,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		subscribeCompaction(harness, loaded.runner);

		// pie: hooks_e2e.rs:259-261
		await harness.prompt("first turn");
		await harness.prompt("second turn");
		const outcome = await harness.compact();
		expect(outcome.ran).toBe(true);

		// pie: hooks_e2e.rs:263-279
		const rawRequest = await awaitRequest(request, "manual compaction webhook request");
		const payload = bodyOf(rawRequest);
		expect(payload.event).toBe("compaction");
		expect(payload.session_id).toBe("session-manual-compaction-e2e");
		expect(payload.source).toBe("user");
		expect(payload.compaction_trigger).toBe("manual");
		expect(payload.compaction_summary).toBe("manual summary");
		expect(Number(payload.compaction_tokens_before ?? 0), `payload: ${JSON.stringify(payload)}`).toBeGreaterThan(0);
	});

	/** pie: hooks_e2e.rs:282-342 */
	it("compaction_webhook_receives_auto_compaction_from_harness_bus", async () => {
		// pie: hooks_e2e.rs:284-288
		const pieDir = tempDir("pie-ported-hooks-piedir-");
		const cwd = tempDir("pie-ported-hooks-cwd-");
		setEnv(ENV_BASE_DIR, pieDir);
		const { url: webhookUrl, request } = await captureOneRequest();

		// pie: hooks_e2e.rs:290-298
		writeFileSync(
			join(pieDir, "hooks.toml"),
			`
[[hook]]
event = "compaction"
webhook = "${webhookUrl}"
timeout_ms = 3000
`,
			"utf-8",
		);

		// pie: hooks_e2e.rs:300-309 -- `context_window: 1` is what makes `should_compact`
		// (threshold = 80% of the window) fire as soon as the transcript is non-empty.
		const registration = fauxProvider(1);
		constantReplies(registration, "auto summary");
		const model = registration.getModel();
		const loaded = await load(cwd, "session-auto-compaction-e2e", model, "off");
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.runner.size()).toBe(1);

		// pie: hooks_e2e.rs:311-316
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd }),
			session,
			model,
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		subscribeCompaction(harness, loaded.runner);

		// pie: hooks_e2e.rs:318-323. Oracle's compaction lands on the THIRD prompt (its
		// `find_cut_point` initializes `target = entries.len()` -- compaction.rs:258-269 -- so
		// nothing is summarizable until two full turns precede the current one); TS's
		// `findCutPoint` falls back the other way (`cutIndex = cutPoints[0]`, compaction.ts:390),
		// so it can land on the SECOND prompt instead. Either way this is the threshold-triggered
		// automatic path, which is what the assertions below pin -- and the faux provider answers
		// every call with the same text, so the captured payload is identical regardless of which
		// prompt triggered it. Compaction settings are left at their defaults, exactly as oracle
		// does (hooks_e2e.rs never touches them).
		await harness.prompt("first turn");
		await harness.prompt("second turn");
		await harness.prompt("third turn triggers auto compaction first");

		// pie: hooks_e2e.rs:325-341
		const rawRequest = await awaitRequest(request, "auto compaction webhook request");
		const payload = bodyOf(rawRequest);
		expect(payload.event).toBe("compaction");
		expect(payload.session_id).toBe("session-auto-compaction-e2e");
		expect(payload.source).toBe("user");
		expect(payload.compaction_trigger).toBe("auto");
		expect(payload.compaction_summary).toBe("auto summary");
		expect(Number(payload.compaction_tokens_before ?? 0), `payload: ${JSON.stringify(payload)}`).toBeGreaterThan(0);
	});
});
