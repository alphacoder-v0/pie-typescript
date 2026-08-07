/**
 * Active-prompt spinner. Animates a braille frame to stderr while the agent is between
 * "user submitted" and "LLM is producing content" -- then clears its line and exits the
 * moment the first content delta arrives.
 *
 * Port of oracle `crates/coding-agent/src/spinner.rs` (pie @0a120dfd). Oracle's own module
 * header records the four design points this port has to preserve verbatim:
 *
 * 1. **Render frame 0 synchronously inside `startWith()`.** `tokio::spawn` only queues the task;
 *    the executor doesn't run it until the current task yields. The agent loop's early `emit()`
 *    calls run listeners inline, and the listener's `stopSync()` would beat the spawned task's
 *    first draw. We render frame 0 on the caller's turn (spinner.rs:7-11, :147-148). The Node
 *    hazard is identical and sharper: a `setInterval`/`setTimeout`/microtask-deferred first draw
 *    would land after any synchronous listener.
 * 2. **`stopSync()` flips the flag AND clears on the caller's turn.** The animation task only
 *    checks the flag at frame boundaries (80ms); cleanup there would race renderer writes
 *    (spinner.rs:12-15, :100-107).
 * 3. **Only the original handle auto-stops on disposal.** Listener code clones the handle for each
 *    event; those short-lived clones must be able to call `stopSync()` explicitly without stopping
 *    the spinner merely by going out of scope (spinner.rs:16-18, :86-95, :110-116). TS has no
 *    `Drop`, so oracle's drop glue becomes the explicit {@link SpinnerHandle.dispose} below --
 *    clones simply carry `stopOnDispose = false`, so disposing one is a no-op.
 * 4. **Stop on first content delta, not on `AgentStart`.** The caller wires this via
 *    `should_stop_spinner_on` in oracle `main.rs`; that predicate belongs to the `coding-agent/main`
 *    unit, not here (spinner.rs:20-21).
 *
 * Tests inject their own {@link SpinnerSink} so the exact emitted byte stream is observable without
 * touching the process's real stderr (spinner.rs:23-24).
 */

import { detach } from "@pie/agent-core";

/** pie: spinner.rs:33 (`FRAMES`). Order is user-visible -- it is the animation sequence. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** pie: spinner.rs:34 (`FRAME_MS`). */
const FRAME_MS = 80;

/**
 * CR + `ESC [ 2 K` (erase entire line). pie: spinner.rs:105 (`stop_sync`) and spinner.rs:120
 * (`draw_frame`) build this same sequence; every frame is prefixed with it and `stop_sync` emits
 * it bare so the caller's next write lands on a clean line.
 */
const CLEAR_LINE = "\r\x1b[2K";

/**
 * Where the spinner writes. Production wraps stderr; tests wrap an in-memory buffer so the byte
 * stream is observable.
 *
 * pie: spinner.rs:38-40 (`trait SpinnerSink`). Oracle's method takes `&[u8]` and its only reader
 * (`BufferSink::as_string`, spinner.rs:68-70) immediately runs `String::from_utf8_lossy` over the
 * accumulated buffer; the spinner never emits anything but UTF-8 text it built with `format!`, so
 * the TS surface is string-typed and skips the round-trip. This is the shape the char-tests port
 * `test/ported/spinner-e2e.test.ts` was written against.
 */
export interface SpinnerSink {
	write(chunk: string): void;
}

/** pie: spinner.rs:42-50 (`StderrSink`). */
class StderrSink implements SpinnerSink {
	write(chunk: string): void {
		try {
			process.stderr.write(chunk);
		} catch {
			// pie: spinner.rs:46-48 discards the result of BOTH `write_all` and `flush`
			// (`let _ = ...`): a spinner must never take down the turn it is decorating. This is
			// the one place RULEBOOK §2.4's "never silently swallow" yields to §0's bug-for-bug
			// rule -- oracle's behaviour on a broken stderr is "the animation silently stops".
		}
	}
}

/**
 * State shared by a handle and every clone of it.
 *
 * pie: spinner.rs:80 (`stop: Arc<AtomicBool>`). RULEBOOK §2.2's `Mutex`/atomic row: the critical
 * section (read-then-set in {@link SpinnerHandle.stopSync}) does not cross an `await`, so a plain
 * field on a shared object is the atomic swap's single-threaded equivalent.
 */
interface SpinnerState {
	stopped: boolean;
}

/** pie: spinner.rs:79-116 (`struct SpinnerHandle` + its `Clone`/`Drop` impls). */
export class SpinnerHandle {
	private readonly state: SpinnerState;
	private readonly sink: SpinnerSink;
	private readonly enabled: boolean;
	private readonly stopOnDispose: boolean;

	/** @internal Construct through {@link start} / {@link startWith}. */
	constructor(state: SpinnerState, sink: SpinnerSink, enabled: boolean, stopOnDispose: boolean) {
		this.state = state;
		this.sink = sink;
		this.enabled = enabled;
		this.stopOnDispose = stopOnDispose;
	}

	/**
	 * Idempotent stop. Flips the flag, then synchronously emits the line-clear escape so any
	 * subsequent write by the caller lands on a clean line.
	 *
	 * pie: spinner.rs:100-107. Oracle's `stop.swap(true, SeqCst)` returns the PREVIOUS value and
	 * bails when it was already `true` -- so the clear escape is written exactly once no matter how
	 * many listeners call this. The `enabled` guard (spinner.rs:104) is why a disabled spinner
	 * stays byte-for-byte silent even across a stop.
	 */
	stopSync(): void {
		if (this.state.stopped) {
			return;
		}
		this.state.stopped = true;
		if (this.enabled) {
			this.sink.write(CLEAR_LINE);
		}
	}

	/**
	 * pie: spinner.rs:86-95 (`impl Clone`). The clone shares the stop flag and the sink but is
	 * explicitly NOT the owner: `stop_on_drop: false`. That is what lets per-event listener
	 * closures hold a clone and call {@link stopSync} without stopping the spinner just by going
	 * out of scope.
	 */
	clone(): SpinnerHandle {
		return new SpinnerHandle(this.state, this.sink, this.enabled, false);
	}

	/**
	 * pie: spinner.rs:110-116 (`impl Drop`). TS has no destructor, so oracle's implicit
	 * "the owning handle stops the spinner when it falls out of scope" becomes an explicit call.
	 * Deliberately NOT wired to `Symbol.dispose`/`using`: `tsconfig.base.json` pins
	 * `lib: ["ES2022"]`, which does not declare `Symbol.dispose`.
	 *
	 * Disposing a {@link clone} is a no-op, which is the whole point of design note 3.
	 */
	dispose(): void {
		if (this.stopOnDispose) {
			this.stopSync();
		}
	}
}

/** pie: spinner.rs:118-122 (`draw_frame`). */
function drawFrame(sink: SpinnerSink, idx: number, label: string): void {
	const icon = FRAMES[idx % FRAMES.length];
	sink.write(`${CLEAR_LINE}${icon} ${label}`);
}

/**
 * `tokio::time::sleep` (spinner.rs:156) inside the detached animation loop.
 *
 * The timer is `unref`'d so a still-running spinner cannot hold the Node event loop open -- oracle's
 * spawned task simply dies with the tokio runtime when `main` returns, and an ordinary `setTimeout`
 * would instead keep the CLI alive. Same reasoning, same shape as `otlp.ts:341` (`sleepUnref`);
 * RULEBOOK §2.2's ban on hand-rolled `new Promise` + `setTimeout` governs the `tokio::time::timeout`
 * row -- a race whose loser must be aborted -- and this is a plain sleep with no race.
 *
 * TODO(port): this is the second copy of `sleepUnref` in the package (`otlp.ts:341` is the first).
 * Both are private; consolidating them into a shared util is a phase 19 de-duplication item, not a
 * behavioural change.
 */
function sleepUnref(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms).unref();
	});
}

/**
 * Production entry point -- writes to stderr when stderr is a TTY, no-ops on pipes/CI.
 *
 * pie: spinner.rs:124-128 (`start`). `std::io::stderr().is_terminal()` -> `process.stderr.isTTY`
 * (typed `boolean | undefined`, hence the explicit `=== true`).
 */
export function start(label: string): SpinnerHandle {
	const enabled = process.stderr.isTTY === true;
	return startWith(label, new StderrSink(), enabled);
}

/**
 * Test entry point -- inject a custom sink + force-enable.
 *
 * pie: spinner.rs:130-170 (`start_with`).
 */
export function startWith(label: string, sink: SpinnerSink, enabled: boolean): SpinnerHandle {
	const state: SpinnerState = { stopped: false };

	// pie: spinner.rs:138-145 -- a disabled spinner starts no animation and, thanks to the
	// `enabled` guard in `stopSync`, never writes a single byte. It is still the OWNER handle
	// (`stop_on_drop: true`, spinner.rs:143).
	if (!enabled) {
		return new SpinnerHandle(state, sink, enabled, true);
	}

	// pie: spinner.rs:147-148 -- "Render frame 0 right now, no waiting for the executor to pick up
	// the spawned task." Design note 1: this MUST stay synchronous, before any await/timer.
	drawFrame(sink, 0, label);

	// pie: spinner.rs:150-163 -- detached `tokio::spawn` running `loop { sleep; check flag; draw }`.
	// RULEBOOK §2.2 maps detached spawns onto the single `detach()` helper. The flag is re-checked
	// after every sleep (spinner.rs:157-159), so at most one frame interval elapses between
	// `stopSync()` and the loop's exit and NOTHING is drawn after the stop.
	detach(
		async () => {
			// pie: spinner.rs:152 (`AtomicUsize::new(1)`) + spinner.rs:160
			// (`fetch_add(1)` returns the pre-increment value, so drawn indices are 1, 2, 3, ...).
			let frame = 1;
			for (;;) {
				await sleepUnref(FRAME_MS);
				if (state.stopped) {
					break;
				}
				drawFrame(sink, frame, label);
				frame += 1;
			}
		},
		(error) => {
			// Defensive only: the loop body is a sleep plus `sink.write`, and the production
			// `StderrSink` swallows its own IO errors (spinner.rs:46-48), so only a caller-supplied
			// sink can land here. Oracle's equivalent is a panic inside the detached task whose
			// `JoinHandle` is dropped -- the animation dies and the error is discarded. RULEBOOK
			// §2.4 forbids a silent catch, so it is surfaced the way `otlp.ts:129-134` surfaces its
			// pump's failure. The stop flag is deliberately left untouched: a later `stopSync()`
			// must still emit its clear escape, exactly as it would in oracle.
			console.error(`(spinner stopped: ${error instanceof Error ? error.message : String(error)})`);
		},
	);

	// pie: spinner.rs:164-169 -- the handle returned by `start_with` is the OWNER.
	return new SpinnerHandle(state, sink, enabled, true);
}
