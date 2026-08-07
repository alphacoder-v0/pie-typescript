/**
 * char-tests port of oracle `crates/coding-agent/tests/spinner_e2e.rs` (pie @0a120dfd).
 *
 * Oracle module doc: "End-to-end test for the spinner's integration with the agent's event stream.
 * Drives a real AgentHarness + a faux StreamFn whose first text delta arrives only after a
 * deliberate delay. Subscribes the same kind of listener main.rs installs (calls `stop_sync` on
 * TextDelta / tool execution, but not ThinkingDelta). Captures the spinner's stderr-equivalent via
 * the BufferSink test hook. Asserts: Frame 0 is in the captured buffer BEFORE the LLM event arrives
 * (synchronous render); multiple frames render during the delay (animation actually runs); on first
 * text delta the `\r\x1b[2K` clear is appended; after stop, no further frames are written (animation
 * task exits)."
 *
 * Oracle test functions: 2. Ported (running): 2. `it.skip`: 0.
 *
 * ── WHY BOTH WERE SKIPPED, AND WHAT UNBLOCKED THEM ───────────────────────────────────────────
 * RESOLVED in phase 14: `packages/coding-agent/src/spinner.ts` now exists as a real port of
 * `spinner.rs` (manifest unit `coding-agent/spinner`, reclassified diff-port -> port on
 * 2026-08-04 on the strength of the analysis below), and both bodies run unmodified against it.
 * The analysis is kept verbatim as the record of why the original mapping was wrong.
 *
 * The unit under test — oracle `crates/coding-agent/src/spinner.rs` — had NO counterpart in this
 * repo. `packages/coding-agent/src/spinner.ts` did not exist, and nothing in `src/` wrote a
 * braille frame to stderr. manifest.tsv line 198 filed the port as
 *   `coding-agent/spinner  crates/coding-agent/src/spinner.rs -> packages/tui/src/components/loader.ts  diff-port  phase 14`
 * but that mapping only covers the *animation* half. `packages/tui/src/components/loader.ts`
 * (`Loader extends Text`) matches oracle on exactly two facts and on nothing else:
 *   - `DEFAULT_FRAMES` === oracle `FRAMES` (spinner.rs:33), same 10 braille glyphs, same order;
 *   - `DEFAULT_INTERVAL_MS` 80 === oracle `FRAME_MS` (spinner.rs:34).
 * Everything these two tests actually assert is absent from `Loader`:
 *   - no injectable sink (oracle `SpinnerSink`, spinner.rs:38-40) — `Loader` writes into the TUI
 *     component tree via `ui.requestRender()`, so there is no observable byte stream at all;
 *   - no `\r\x1b[2K` line-clear on stop (oracle `stop_sync`, spinner.rs:100-107) — `Loader.stop()`
 *     only calls `clearInterval` and emits nothing;
 *   - no stop-flag/idempotence contract (oracle swaps an `AtomicBool` and returns early on the
 *     second call) — `Loader.stop()` is silently repeatable but that is unobservable;
 *   - no `enabled` gate wired to `stderr().is_terminal()` (spinner.rs:125-128);
 *   - no clone-does-not-stop-on-drop semantics (spinner.rs:86-95, 110-116), which is the whole
 *     reason listener code can `spin.stopSync()` from inside a per-event closure.
 * So this is a GAP, not a rename: phase 14's `coding-agent/spinner` unit has to deliver a real
 * port surface (a stderr spinner with an injectable sink), not merely diff `Loader`. The bodies
 * below are written in full against that surface so that the moment it lands, dropping `.skip`
 * runs oracle's assertions verbatim. See the "phase 14 acceptance" list at the bottom of this file.
 *
 * ── CONSTRUCT MAPPING (what the skipped bodies assume) ───────────────────────────────────────
 * - `spinner::SpinnerSink` (`fn write(&self, bytes: &[u8])`) -> {@link SpinnerSink} `write(chunk: string)`.
 *   Oracle's sink takes bytes and the test immediately does `String::from_utf8_lossy`; the
 *   TS side has no reason to round-trip through `Uint8Array`, so the port surface is string-typed
 *   and {@link BufferSink} concatenates. Every assertion below is on the decoded string either way.
 * - `spinner::BufferSink` is declared inside `src/spinner.rs` but is documented there as
 *   "test sink ... Public-but-test-only so the integration tests under `tests/spinner_e2e.rs` can
 *   use it via path-include" (spinner.rs:52-58). It is therefore reproduced HERE as a test-local
 *   class rather than demanded from the port — it carries no product behavior.
 * - `spinner::start_with(label, sink, enabled) -> SpinnerHandle` -> `startWith(label, sink, enabled)`;
 *   `SpinnerHandle::stop_sync()` -> `stopSync()`; `SpinnerHandle::clone()` -> `clone()`.
 * - `AgentHarnessOptions { stream_fn: Some(delayed_thinking_then_text_stream(..)) }`: the TS
 *   `AgentHarness` has no `streamFn` slot (documented at agent-harness.ts:1613 — it builds its own
 *   stream fn from the model's registered API provider). Same substitution the sibling port
 *   `test/ported/export-e2e.test.ts` already uses: `registerFauxProvider` from `@pie/ai`. Oracle's
 *   hand-rolled "ThinkingDelta, then sleep(text_delay_ms), then TextDelta + Done" stream becomes a
 *   faux response whose content is `[thinking, text]` plus a `tokensPerSecond` throttle, so the
 *   first `text_delta` still lands only after the thinking block has streamed for ~500ms
 *   (oracle: 450ms). The property the test depends on — the listener's stop trigger arrives well
 *   after several 80ms frame ticks — is preserved; the exact millisecond is not load-bearing
 *   (oracle samples at 250ms and 250+120ms, both comfortably inside the thinking window).
 * - `harness.agent().subscribe(...)` -> `harness.subscribe(...)` (the TS harness merges oracle's
 *   `AgentListener` and `HarnessListener` channels into one `AgentHarnessEvent` stream; same
 *   convention as `test/ported/hooks-e2e.test.ts:203`).
 * - `tokio::select! { prompt_fut => panic!(), sleep(250ms) => {} }` -> `Promise.race`, asserting the
 *   sleep wins. Same assertion ("the prompt must NOT have completed yet"), no weakening.
 * - `AgentHarnessOptions` in TS additionally requires `env` and `getApiKeyAndHeaders`, neither of
 *   which exists on oracle's option struct; `NodeExecutionEnv` is imported through its source path
 *   because the `@pie/agent-core` bucket does not re-export it (identical note in export-e2e.test.ts).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHarnessEvent } from "@pie/agent-core";
import { AgentHarness, InMemorySessionStorage, Session } from "@pie/agent-core";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	registerFauxProvider,
} from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../agent/src/harness/env/nodejs.ts";

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Port surface demanded from phase 14's `coding-agent/spinner` unit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** pie: spinner.rs:38-40 (`trait SpinnerSink`). See the header note on bytes -> string. */
interface SpinnerSink {
	write(chunk: string): void;
}

/** pie: spinner.rs:79-116 (`struct SpinnerHandle`). */
interface SpinnerHandle {
	/** pie: spinner.rs:100-107 (`stop_sync`). Idempotent; emits the clear escape on the caller's turn. */
	stopSync(): void;
	/** pie: spinner.rs:86-95 (`impl Clone`). The clone must NOT stop the spinner when discarded. */
	clone(): SpinnerHandle;
}

interface SpinnerPort {
	/** pie: spinner.rs:132-170 (`start_with`). */
	startWith(label: string, sink: SpinnerSink, enabled: boolean): SpinnerHandle;
}

/**
 * Deliberately typed `string` (not a literal) so the compiler left the specifier alone while the
 * module did not exist yet and a literal specifier would have been a hard `tsgo` resolution error,
 * which would have forced these bodies to be deleted — exactly the outcome this file exists to
 * prevent. Phase 14 landed the surface at exactly this path, so the indirection is now inert; it is
 * kept so the file keeps compiling if the module is ever moved again. The *assertions* below are
 * the binding artifact; retarget this constant rather than relaxing anything underneath it.
 */
const SPINNER_MODULE: string = "../../src/spinner.ts";

async function loadSpinner(): Promise<SpinnerPort> {
	return (await import(SPINNER_MODULE)) as SpinnerPort;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Test-local fixtures (oracle's own test scaffolding, not product behavior).
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** pie: spinner.rs:33 (`FRAMES`) — also the glyph set spinner_e2e.rs:190 counts over. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** pie: spinner.rs:105 / spinner.rs:120 — the line-clear escape `\r\x1b[2K`. */
const CLEAR_LINE = "\r\u001b[2K";

/** pie: spinner.rs:56-77 (`BufferSink`) — appends every write to an in-memory buffer. */
class BufferSink implements SpinnerSink {
	private buf = "";

	write(chunk: string): void {
		this.buf += chunk;
	}

	/** pie: spinner.rs:68-70 (`as_string`). */
	asString(): string {
		return this.buf;
	}
}

/**
 * pie: spinner_e2e.rs:106-119 (`should_stop_on`) — "Predicate matching what main.rs installs":
 * tool execution boundaries, and message updates carrying a text or tool-call delta. A
 * ThinkingDelta deliberately does NOT stop the spinner.
 */
function shouldStopOn(event: AgentHarnessEvent): boolean {
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") return true;
	if (event.type === "message_update") {
		const inner = event.assistantMessageEvent;
		return inner.type === "text_delta" || inner.type === "toolcall_delta";
	}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let registrations: FauxProviderRegistration[] = [];
let tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * pie: spinner_e2e.rs:49-103 (`delayed_thinking_then_text_stream`) — "A faux stream that emits a
 * thinking delta, then waits before emitting text + done. Lets the spinner animate while the model
 * is still thinking." `tokensPerSecond: 6` over an ~11-character thinking block (~3 estimated
 * tokens) reproduces oracle's `text_delay_ms = 450` to within a frame tick.
 */
function delayedThinkingThenTextProvider(): FauxProviderRegistration {
	const registration = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", name: "Faux" }],
		tokensPerSecond: 6,
	});
	registrations.push(registration);
	return registration;
}

afterEach(() => {
	for (const registration of registrations) registration.unregister();
	registrations = [];
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * Tests
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("spinner_e2e (char-tests port)", () => {
	/**
	 * pie: spinner_e2e.rs:121-207. Was skipped until `src/spinner.ts` landed `startWith`/`stopSync`
	 * with an injectable sink (see the header). Everything else in this body — the harness, the faux
	 * thinking-then-text stream, the listener predicate — already resolved against ported code.
	 */
	it("spinner_shows_during_thinking_then_clears_on_first_delta", async () => {
		const spinner = await loadSpinner();
		const sink = new BufferSink();
		// pie: spinner_e2e.rs:123-127
		const spin = spinner.startWith("thinking", sink, true);

		// pie: spinner_e2e.rs:130-135. Frame 0 must already be there before any agent event fired.
		const initial = sink.asString();
		expect(
			initial.includes("⠋") && initial.includes("thinking"),
			`synchronous frame 0 missing: ${JSON.stringify(initial)}`,
		).toBe(true);

		// pie: spinner_e2e.rs:137-148. Wire the agent + listener.
		const env = new NodeExecutionEnv({ cwd: tempDir("pie-ported-spinner-cwd-") });
		const registration = delayedThinkingThenTextProvider();
		registration.setResponses([fauxAssistantMessage([fauxThinking("considering"), fauxText("hello")])]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env,
			session,
			model: registration.getModel(),
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});

		// pie: spinner_e2e.rs:150-158
		const unsubscribe = harness.subscribe((event) => {
			if (shouldStopOn(event)) spin.stopSync();
		});

		// pie: spinner_e2e.rs:160-166. The prompt must NOT settle before the delayed text arrives.
		const promptPromise = harness.prompt("hi");
		const firstToSettle = await Promise.race([
			promptPromise.then(() => "prompt-completed" as const),
			sleep(250).then(() => "still-thinking" as const),
		]);
		expect(firstToSettle, "prompt completed before delayed text").toBe("still-thinking");

		// pie: spinner_e2e.rs:168-174. The animation must still be running mid-thinking.
		const beforeMoreFrames = sink.asString().length;
		await sleep(120);
		const afterMoreFrames = sink.asString().length;
		expect(afterMoreFrames, `spinner stopped during thinking; len stayed at ${beforeMoreFrames}`).toBeGreaterThan(
			beforeMoreFrames,
		);

		// pie: spinner_e2e.rs:176-177. Drive the prompt to completion; first text delta stops it.
		await promptPromise;
		unsubscribe();

		const captured = sink.asString();

		// pie: spinner_e2e.rs:183-187. 1. The synchronous clear from stopSync must be in there.
		expect(captured, `stop_sync clear escape missing: ${JSON.stringify(captured)}`).toContain(CLEAR_LINE);

		// pie: spinner_e2e.rs:189-197. 2. At least two distinct frame glyphs (animation ran >1 tick).
		const distinctFrames = FRAMES.filter((frame) => captured.includes(frame)).length;
		expect(
			distinctFrames,
			`expected >=2 distinct frames during the delay, got ${distinctFrames}\n${JSON.stringify(captured)}`,
		).toBeGreaterThanOrEqual(2);

		// pie: spinner_e2e.rs:199-206. 3. A second stopSync after the listener already fired is a no-op.
		const beforeDoubleStop = sink.asString().length;
		spin.stopSync();
		const afterDoubleStop = sink.asString().length;
		expect(afterDoubleStop, "stop_sync after listener-fired stop should be a no-op").toBe(beforeDoubleStop);
	});

	/**
	 * pie: spinner_e2e.rs:209-233. Oracle doc: "Regression: stopping the spinner BEFORE the listener
	 * fires (e.g. error path) leaves the buffer in a sane state — frame 0 + a clear — and the
	 * animation task exits without adding more frames."
	 * Was skipped for the same missing surface. Note this one needs no agent at all: it is the
	 * tightest possible acceptance probe for phase 14 and was the first to go green.
	 */
	it("explicit_stop_works_without_any_agent_event", async () => {
		const spinner = await loadSpinner();
		const sink = new BufferSink();
		// pie: spinner_e2e.rs:214-219
		const spin = spinner.startWith("thinking", sink, true);

		// pie: spinner_e2e.rs:221-222. Don't wire any listener. Stop immediately.
		spin.stopSync();

		// pie: spinner_e2e.rs:224-226
		const s = sink.asString();
		expect(s, `frame 0: ${JSON.stringify(s)}`).toContain("⠋");
		expect(s.endsWith(CLEAR_LINE), `trailing clear: ${JSON.stringify(s)}`).toBe(true);

		// pie: spinner_e2e.rs:228-232. Wait past a frame interval — nothing more may be appended.
		const before = s.length;
		await sleep(200);
		const after = sink.asString().length;
		expect(after, "animation task continued past stop").toBe(before);
	});
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * PHASE 14 ACCEPTANCE — `coding-agent/spinner` (manifest.tsv:198)  [DELIVERED 2026-08-04]
 *
 * Deliver a spinner surface with the following observable contract, then drop `.skip` above.
 * All eight points are implemented in `packages/coding-agent/src/spinner.ts` and the `.skip`s are
 * gone; the list is kept as the contract those tests are asserting, not as an open TODO.
 *
 *  1. `startWith(label, sink, enabled)` renders frame 0 SYNCHRONOUSLY on the caller's turn —
 *     before any `await`, before the animation timer's first tick. Oracle's rationale
 *     (spinner.rs:7-11): listeners run inline off the agent loop's early `emit()`, and their
 *     `stopSync()` would otherwise beat the timer's first draw. In Node terms: do the first draw
 *     eagerly, do NOT defer it to `setInterval`/`setTimeout`/a microtask.
 *  2. Each frame is written as the exact byte sequence `\r\x1b[2K{glyph} {label}`
 *     (spinner.rs:118-122), glyphs cycling through the 10 braille frames in order, every 80ms.
 *  3. `stopSync()` (a) flips the stop flag and (b) writes `\r\x1b[2K` synchronously on the
 *     caller's turn — never from the timer callback, which would race the renderer's stdout.
 *  4. `stopSync()` is idempotent: the second and later calls write NOTHING.
 *  5. After `stopSync()`, the animation timer must stop appending within one frame interval —
 *     i.e. the timer is cleared (or its callback returns early on the flag) so a 200ms wait
 *     appends exactly zero bytes.
 *  6. `clone()` yields a handle that shares the stop flag and the sink but does NOT stop the
 *     spinner when it goes out of scope; only the ORIGINAL handle carries stop-on-dispose
 *     (spinner.rs:16-18). In TS there is no `Drop`, so the equivalent is: no disposal hook on
 *     clones, and any owner-side auto-stop must be explicit (e.g. `[Symbol.dispose]`).
 *  7. `enabled === false` makes the spinner totally silent — no frame 0, no frames, no clear
 *     (spinner.rs:137-144). Production picks `enabled` from "is stderr a TTY" (spinner.rs:126).
 *  8. The sink is injectable so a test can observe the exact stream; production writes to stderr
 *     with a flush per write (spinner.rs:42-50).
 *
 * Oracle also carries six `#[cfg(test)]` unit tests inside spinner.rs itself (spinner.rs:172-258)
 * covering points 1/2/3/4/6/7 individually. They belong to the `coding-agent/spinner` unit's own
 * port, not to this integration-test file, and are ported in `test/spinner.test.ts`:
 *   first_frame_renders_synchronously_in_start (:176)  stop_sync_emits_line_clear_immediately (:206)
 *   spinner_animates_multiple_frames_over_time (:189)  stop_sync_is_idempotent (:221)
 *   dropping_clone_does_not_stop_owner (:235)          disabled_spinner_writes_nothing (:250)
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
