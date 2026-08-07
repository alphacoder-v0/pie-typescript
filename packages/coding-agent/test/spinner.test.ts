import { describe, expect, test, vi } from "vitest";
import { type SpinnerSink, start, startWith } from "../src/spinner.ts";

// pie: crates/coding-agent/src/spinner.rs:172-258 -- full port of the #[cfg(test)] module
// (6 tests), plus one test beyond oracle for the `Drop`-equivalent noted at the bottom.

/** pie: spinner.rs:33 (`FRAMES`) -- the glyph set spinner.rs:198 counts over. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** pie: spinner.rs:105 / spinner.rs:120 -- the line-clear escape `\r\x1b[2K`. */
const CLEAR_LINE = "\r\x1b[2K";

/**
 * pie: spinner.rs:52-77 (`BufferSink`) -- "Test sink that appends every write to an in-memory
 * buffer." Oracle declares it inside `src/spinner.rs` only so the `tests/spinner_e2e.rs`
 * integration file can path-include it; it carries no product behaviour, so it lives in the tests
 * on this side (the same call the char-tests port `test/ported/spinner-e2e.test.ts:131` made).
 */
class BufferSink implements SpinnerSink {
	private buf = "";

	write(chunk: string): void {
		this.buf += chunk;
	}

	/** pie: spinner.rs:68-70 (`as_string`). */
	asString(): string {
		return this.buf;
	}

	/** pie: spinner.rs:65-67 (`snapshot`) -- only its length is ever asserted on. */
	get length(): number {
		return this.buf.length;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("spinner (port of spinner.rs #[cfg(test)])", () => {
	// pie: spinner.rs:176-187
	test("first frame renders synchronously in startWith", () => {
		const sink = new BufferSink();
		const h = startWith("thinking", sink, true);
		// No await between startWith() and the snapshot -- frame 0 MUST already be there.
		const body = sink.asString();
		expect(body.includes("⠋"), `frame 0 missing from synchronous render: ${JSON.stringify(body)}`).toBe(true);
		expect(body.includes("thinking"), `label missing: ${JSON.stringify(body)}`).toBe(true);
		// Oracle's `_h` binding stops the spinner when it drops out of the test's scope
		// (spinner.rs:110-116); TS has no destructor, so the equivalent is explicit.
		h.dispose();
	});

	// pie: spinner.rs:189-204
	test("spinner animates multiple frames over time", async () => {
		const sink = new BufferSink();
		const h = startWith("thinking", sink, true);
		// Let the animation loop drive 3-4 frames.
		await sleep(300);
		h.stopSync();
		const body = sink.asString();
		// At least two distinct frame glyphs should have been emitted.
		const distinct = FRAMES.filter((frame) => body.includes(frame)).length;
		expect(
			distinct,
			`expected >=2 distinct frames, got ${distinct} in ${JSON.stringify(body)}`,
		).toBeGreaterThanOrEqual(2);
	});

	// pie: spinner.rs:206-219
	test("stopSync emits the line clear immediately", () => {
		const sink = new BufferSink();
		const h = startWith("thinking", sink, true);
		// Snapshot before stop. Nothing is awaited in between, so no frame can slip in.
		const before = sink.asString();
		h.stopSync();
		const after = sink.asString();
		const cleared = after.slice(before.length);
		expect(cleared, `stopSync must emit the clear escape immediately, got ${JSON.stringify(cleared)}`).toBe(
			CLEAR_LINE,
		);
	});

	// pie: spinner.rs:221-233
	test("stopSync is idempotent", () => {
		const sink = new BufferSink();
		const h = startWith("thinking", sink, true);
		h.stopSync();
		const afterFirst = sink.length;
		h.stopSync();
		const afterSecond = sink.length;
		expect(afterSecond, "second stopSync must be a no-op").toBe(afterFirst);
	});

	// pie: spinner.rs:235-248
	test("disposing a clone does not stop the owner", async () => {
		const sink = new BufferSink();
		const h = startWith("thinking", sink, true);
		// pie: spinner.rs:239 `drop(h.clone())`. A clone carries `stop_on_drop: false`
		// (spinner.rs:86-95), so discarding it must not touch the shared stop flag; `dispose()` is
		// the strongest TS form of "it went out of scope".
		h.clone().dispose();
		const before = sink.length;
		await sleep(120);
		const after = sink.length;
		h.stopSync();
		expect(after, "disposing a temporary clone must not stop the spinner").toBeGreaterThan(before);
	});

	// pie: spinner.rs:250-257
	test("disabled spinner writes nothing", async () => {
		const sink = new BufferSink();
		const h = startWith("thinking", sink, false);
		await sleep(200);
		h.stopSync();
		expect(sink.length, "disabled spinner must be silent").toBe(0);
	});

	/**
	 * Beyond oracle's own unit tests: the other half of spinner.rs:110-116 (`impl Drop`). Oracle
	 * gets this for free from the borrow checker -- the OWNER handle returned by `start_with`
	 * carries `stop_on_drop: true` -- so it never needed a test. In TS the drop glue is the
	 * explicit `dispose()`, which makes the owner/clone asymmetry a thing that can regress, hence
	 * this test and its sibling above.
	 */
	test("disposing the owner stops the spinner and emits the clear", async () => {
		const sink = new BufferSink();
		const h = startWith("thinking", sink, true);
		h.dispose();
		const afterDispose = sink.asString();
		expect(afterDispose.endsWith(CLEAR_LINE), `trailing clear: ${JSON.stringify(afterDispose)}`).toBe(true);
		await sleep(200);
		expect(sink.length, "animation loop continued past the owner's disposal").toBe(afterDispose.length);
	});

	/**
	 * Beyond oracle: the exact emitted byte sequence. Oracle's own tests only ever assert
	 * `contains`, so nothing there pins the `\r\x1b[2K{glyph} {label}` shape of a frame
	 * (spinner.rs:118-122) nor the order the 10 glyphs cycle in (spinner.rs:33, `idx % len`). Both
	 * are what the terminal actually sees, so they are asserted structurally here: the stream must
	 * decompose into consecutive `CLEAR_LINE`-prefixed frames whose glyphs walk FRAMES in order,
	 * terminated by the bare clear from `stopSync`.
	 */
	test("the emitted stream is exactly clear + glyph + label, cycling FRAMES in order", async () => {
		const sink = new BufferSink();
		const h = startWith("thinking", sink, true);
		expect(sink.asString(), "frame 0 is not byte-exact").toBe(`${CLEAR_LINE}⠋ thinking`);
		await sleep(250);
		h.stopSync();

		const parts = sink.asString().split(CLEAR_LINE);
		// A leading "" (the stream opens with CLEAR_LINE) and a trailing "" (the bare stop clear).
		expect(parts[0]).toBe("");
		expect(parts[parts.length - 1]).toBe("");
		const frames = parts.slice(1, -1);
		expect(frames.length, "expected at least frame 0 plus one animated frame").toBeGreaterThanOrEqual(2);
		frames.forEach((frame, index) => {
			expect(frame, `frame ${index} out of sequence`).toBe(`${FRAMES[index % FRAMES.length]} thinking`);
		});
	});

	/**
	 * Beyond oracle: the production entry point. pie: spinner.rs:124-128 (`start`) picks `enabled`
	 * from `std::io::stderr().is_terminal()` and pairs it with the real `StderrSink`
	 * (spinner.rs:42-50) -- acceptance points 7 and 8, and the only two with no other coverage
	 * (every other test injects a sink and forces `enabled`). Both branches of the gate are driven
	 * by swapping `process.stderr.isTTY`, which is restored in `finally`.
	 */
	test("start() gates on stderr being a TTY and writes real escapes to it", () => {
		const writes: string[] = [];
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as unknown as typeof process.stderr.write);
		const originalIsTty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
		try {
			// Not a terminal -> totally silent, exactly like `startWith(..., enabled = false)`.
			Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
			start("thinking").stopSync();
			expect(writes, "a non-TTY stderr must never be written to").toEqual([]);

			// A terminal -> frame 0 on the caller's turn, then the clear from stopSync.
			Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
			start("thinking").stopSync();
			expect(writes).toEqual([`${CLEAR_LINE}⠋ thinking`, CLEAR_LINE]);
		} finally {
			if (originalIsTty === undefined) {
				delete (process.stderr as { isTTY?: boolean }).isTTY;
			} else {
				Object.defineProperty(process.stderr, "isTTY", originalIsTty);
			}
			spy.mockRestore();
		}
	});
});
