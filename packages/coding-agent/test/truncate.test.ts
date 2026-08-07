import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatInclusiveTruncationNote,
	formatTruncationNote,
	splitLinesInclusive,
	truncateHead,
	truncateHeadInclusive,
	truncateTail,
} from "../src/core/tools/truncate.ts";

/**
 * Oracle parity tests for packages/coding-agent/src/core/tools/truncate.ts.
 *
 * Oracle: crates/coding-agent/src/tools/truncate.rs (pie @0a120dfd). This file is the shared
 * truncation primitive behind bash/read/ls/grep/find output truncation, so its constants and
 * note format are user-visible and parity-observable across those tools.
 */
describe("truncate oracle parity (crates/coding-agent/src/tools/truncate.rs)", () => {
	it("DEFAULT_MAX_LINES matches oracle (truncate.rs:4)", () => {
		expect(DEFAULT_MAX_LINES).toBe(2_000);
	});

	it("DEFAULT_MAX_BYTES matches oracle's 256 KiB cap, not the prior 50KB (truncate.rs:5)", () => {
		expect(DEFAULT_MAX_BYTES).toBe(256 * 1024);
	});

	describe("truncateHead", () => {
		// pie: crates/coding-agent/src/tools/truncate.rs:86-90 (no_truncation_when_within_limits)
		it("does not truncate when within limits (oracle: no_truncation_when_within_limits)", () => {
			const result = truncateHead("hi\nthere\n", { maxLines: 100, maxBytes: 1024 });
			expect(result.content).toBe("hi\nthere\n");
			expect(result.truncated).toBe(false);
		});

		// pie: crates/coding-agent/src/tools/truncate.rs:92-99 (truncates_by_line_count)
		// Oracle's assertion is `out == "a\nb\n"` (trailing "\n" kept, via split_inclusive('\n')).
		// This implementation reconstructs truncated output via Array#join("\n") over
		// content.split("\n") (an already-accepted architectural divergence shared by every
		// truncate.ts consumer -- see the DEFAULT_MAX_BYTES doc comment above and the
		// "totalLines is N+1" notes in tools.test.ts), so the last kept line never gets a
		// trailing separator re-appended. Content is otherwise identical.
		it("truncates by line count (oracle: truncates_by_line_count)", () => {
			const body = "a\nb\nc\nd\n";
			const result = truncateHead(body, { maxLines: 2, maxBytes: 1024 });
			expect(result.content).toBe("a\nb");
			expect(result.outputLines).toBe(2);
			expect(result.truncatedBy).toBe("lines");
			expect(result.truncated).toBe(true);
		});
	});

	describe("truncateTail", () => {
		// pie: crates/coding-agent/src/tools/truncate.rs:101-106 (tail_keeps_last). Uses a body
		// without a trailing newline to isolate tail-keeps-last-N-lines semantics from the
		// split("\n") trailing-newline reconstruction divergence noted above (oracle's own
		// body has a trailing "\n"; with it, the split("\n") architecture's synthetic trailing
		// empty element consumes one of the two line slots, so the tail would show only the
		// single real line "d" instead of "c"+"d" -- a pre-existing, already-accepted quirk of
		// the shared split("\n")-based line counting, not something this unit changes).
		it("keeps the last N lines (oracle: tail_keeps_last)", () => {
			const body = "a\nb\nc\nd";
			const result = truncateTail(body, { maxLines: 2, maxBytes: 1024 });
			expect(result.content).toBe("c\nd");
		});

		// Not an oracle test: oracle's truncate_tail never partially slices a line (it only
		// ever keeps whole lines, breaking with nothing kept if even the last line alone
		// exceeds max_bytes). This implementation's `lastLinePartial` edge case is a pi-only
		// UX addition with no oracle counterpart (verdict: none). Regression-tests that the
		// UTF-8 boundary walk in truncateStringToBytesFromEnd never splits a multi-byte
		// character (surrogate-pair-backed emoji, 4 bytes in UTF-8 / 2 UTF-16 code units).
		it("does not split a multi-byte UTF-8 character when partially truncating a tail line", () => {
			const content = "\u{1F600}".repeat(20); // 20 emoji, 80 bytes UTF-8, 1 line (no "\n")
			const result = truncateTail(content, { maxLines: 2000, maxBytes: 10 });

			expect(result.lastLinePartial).toBe(true);
			expect(result.outputBytes).toBeLessThanOrEqual(10);
			expect(result.content).not.toContain("�"); // no replacement chars from a split boundary
			expect(result.content).toBe("\u{1F600}\u{1F600}"); // 2 whole emoji = 8 bytes, fits in 10
		});
	});

	describe("formatTruncationNote", () => {
		// pie: crates/coding-agent/src/tools/truncate.rs:16-26 -- Truncation::note()
		it("formats oracle's exact truncation note text when content was dropped", () => {
			const result = truncateHead("a\nb\nc\nd\n", { maxLines: 2, maxBytes: 1024 });
			expect(formatTruncationNote(result)).toBe(
				`[truncated: kept ${result.outputLines}/${result.totalLines} lines, ${result.outputBytes} of ${result.totalBytes} bytes]`,
			);
		});

		it("returns undefined when nothing was truncated (oracle: truncated_lines == 0)", () => {
			const result = truncateHead("hi\nthere\n", { maxLines: 100, maxBytes: 1024 });
			expect(formatTruncationNote(result)).toBeUndefined();
		});
	});

	// The variant `read` uses. Unlike truncateHead above it is oracle 1:1, so oracle's own unit
	// tests transfer verbatim -- including the trailing "\n" that the split("\n") architecture
	// drops, which is exactly the reason read.ts needed its own primitive.
	describe("splitLinesInclusive", () => {
		// Rust: `"".split_inclusive('\n')` yields nothing; `"a\n".split_inclusive('\n')` yields
		// ["a\n"]. JS `"".split("\n")` yields [""] and `"a\n".split("\n")` yields ["a", ""], so
		// every newline-terminated file would be counted one line long.
		it("matches Rust's split_inclusive('\\n') line partitioning", () => {
			expect(splitLinesInclusive("")).toEqual([]);
			expect(splitLinesInclusive("\n")).toEqual(["\n"]);
			expect(splitLinesInclusive("a\nb\n")).toEqual(["a\n", "b\n"]);
			expect(splitLinesInclusive("a\nb")).toEqual(["a\n", "b"]);
		});
	});

	describe("truncateHeadInclusive", () => {
		// pie: crates/coding-agent/src/tools/truncate.rs:86-90 (no_truncation_when_within_limits)
		it("does not truncate when within limits (oracle: no_truncation_when_within_limits)", () => {
			const trunc = truncateHeadInclusive("hi\nthere\n", 100, 1024);
			expect(trunc.content).toBe("hi\nthere\n");
			expect(trunc.truncatedLines).toBe(0);
		});

		// pie: crates/coding-agent/src/tools/truncate.rs:92-99 (truncates_by_line_count). Oracle's
		// own assertion is `out == "a\nb\n"` -- terminator kept, which truncateHead cannot express.
		it("truncates by line count keeping terminators (oracle: truncates_by_line_count)", () => {
			const trunc = truncateHeadInclusive("a\nb\nc\nd\n", 2, 1024);
			expect(trunc.content).toBe("a\nb\n");
			expect(trunc.keptLines).toBe(2);
			expect(trunc.truncatedLines).toBe(2);
			expect(trunc.totalLines).toBe(4);
		});

		// pie: truncate.rs:35-42 -- the scan has no `break`. A line over budget is skipped and a
		// later, shorter line is still appended, so the kept set is not a contiguous prefix. This is
		// the behaviour truncateHead deliberately does NOT have (see its TODO(port)).
		it("skips an over-budget line and still keeps a later shorter one", () => {
			// "a\n" (2) + 20-byte line (21) + "b\n" (2): a 6-byte budget keeps the two short lines.
			const trunc = truncateHeadInclusive(`a\n${"x".repeat(20)}\nb\n`, 100, 6);
			expect(trunc.content).toBe("a\nb\n");
			expect(trunc.keptLines).toBe(2);
			expect(trunc.totalLines).toBe(3);
			expect(trunc.truncatedLines).toBe(1);
			expect(trunc.keptBytes).toBe(4);
		});

		it("counts bytes in UTF-8, not UTF-16 code units", () => {
			const trunc = truncateHeadInclusive("é\n", 100, 1024);
			expect(trunc.totalBytes).toBe(3); // 2 for 'é' + 1 for '\n'
			expect(trunc.keptBytes).toBe(3);
		});
	});

	describe("formatInclusiveTruncationNote", () => {
		// pie: crates/coding-agent/src/tools/truncate.rs:16-26 -- Truncation::note()
		it("formats oracle's exact note text when content was dropped", () => {
			const trunc = truncateHeadInclusive("a\nb\nc\nd\n", 2, 1024);
			expect(formatInclusiveTruncationNote(trunc)).toBe("[truncated: kept 2/4 lines, 4 of 8 bytes]");
		});

		it("returns undefined when nothing was truncated (oracle: truncated_lines == 0)", () => {
			const trunc = truncateHeadInclusive("hi\nthere\n", 100, 1024);
			expect(formatInclusiveTruncationNote(trunc)).toBeUndefined();
		});
	});
});
