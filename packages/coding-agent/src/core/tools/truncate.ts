/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 256KiB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

export const DEFAULT_MAX_LINES = 2000;
// pie: crates/coding-agent/src/tools/truncate.rs:5 -- oracle's DEFAULT_MAX_BYTES is 256 KiB,
// not 50KB. This constant is shared by bash/read/ls/grep/find, so the fix is centralized here.
export const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KiB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	maxLines: number;
	/** The max bytes limit that was applied */
	maxBytes: number;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 256KiB) */
	maxBytes?: number;
}

/**
 * Format bytes as human-readable size.
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * Format an oracle-parity truncation note.
 *
 * Returns `undefined` when nothing was dropped (mirrors oracle: `truncated_lines == 0`).
 */
// pie: crates/coding-agent/src/tools/truncate.rs:16-26 -- Truncation::note(); exact wording
// ("[truncated: kept K/N lines, X of Y bytes]") is oracle's canonical truncation notice.
// Exposed here for truncate.ts consumers (e.g. bash.ts) that hold a pi-shaped TruncationResult;
// callers on the oracle-shaped path use formatInclusiveTruncationNote below.
export function formatTruncationNote(result: TruncationResult): string | undefined {
	if (!result.truncated) {
		return undefined;
	}
	return `[truncated: kept ${result.outputLines}/${result.totalLines} lines, ${result.outputBytes} of ${result.totalBytes} bytes]`;
}

/** Oracle-shaped counterpart of Rust's `Truncation` struct. Byte counts are UTF-8 bytes. */
// pie: crates/coding-agent/src/tools/truncate.rs:7-14 (`struct Truncation`), field names verbatim.
export interface InclusiveTruncation {
	/** Content kept, with line terminators intact. */
	content: string;
	totalLines: number;
	keptLines: number;
	truncatedLines: number;
	totalBytes: number;
	keptBytes: number;
}

/**
 * Split like Rust's `str::split_inclusive('\n')`: every piece keeps its trailing newline, and an
 * empty string yields no pieces at all.
 *
 * This is NOT `String.prototype.split("\n")`, which drops terminators and synthesizes a trailing
 * empty element ("a\n" -> ["a", ""] vs Rust's ["a\n"]). The line *counts* differ for every
 * newline-terminated file, so oracle-facing arithmetic has to use this one.
 */
export function splitLinesInclusive(text: string): string[] {
	const lines: string[] = [];
	let start = 0;
	for (;;) {
		const index = text.indexOf("\n", start);
		if (index === -1) {
			break;
		}
		lines.push(text.slice(start, index + 1));
		start = index + 1;
	}
	if (start < text.length) {
		lines.push(text.slice(start));
	}
	return lines;
}

/**
 * Head truncation with oracle's exact semantics.
 *
 * pie: crates/coding-agent/src/tools/truncate.rs:29-51 (`truncate_head`), 1:1 — including the two
 * places it differs from {@link truncateHead} above:
 *   1. line terminators are preserved (`split_inclusive`), so the reassembled output is the
 *      original bytes rather than a `join("\n")` reconstruction;
 *   2. the scan never breaks. A line that does not fit the byte budget is *skipped*, and a later
 *      shorter line can still be appended — the kept lines need not be a contiguous prefix.
 *
 * {@link truncateHead} keeps its pi behaviour because grep/find/ls depend on its line
 * reconstruction; this is the variant `read` uses, where the exact bytes and the kept/total
 * counters both reach the model.
 */
export function truncateHeadInclusive(text: string, maxLines: number, maxBytes: number): InclusiveTruncation {
	const totalBytes = Buffer.byteLength(text, "utf-8");
	const out: string[] = [];
	let totalLines = 0;
	let keptLines = 0;
	let keptBytes = 0;
	for (const line of splitLinesInclusive(text)) {
		totalLines++;
		const lineBytes = Buffer.byteLength(line, "utf-8");
		if (keptLines < maxLines && keptBytes + lineBytes <= maxBytes) {
			out.push(line);
			keptLines++;
			keptBytes += lineBytes;
		}
	}
	return {
		content: out.join(""),
		totalLines,
		keptLines,
		// pie: truncate.rs:46 (`total_lines.saturating_sub(kept_lines)`).
		truncatedLines: Math.max(0, totalLines - keptLines),
		totalBytes,
		keptBytes,
	};
}

/**
 * pie: crates/coding-agent/src/tools/truncate.rs:16-26 (`Truncation::note`), wording verbatim.
 * `undefined` when nothing was dropped.
 */
export function formatInclusiveTruncationNote(trunc: InclusiveTruncation): string | undefined {
	if (trunc.truncatedLines === 0) {
		return undefined;
	}
	return `[truncated: kept ${trunc.keptLines}/${trunc.totalLines} lines, ${trunc.keptBytes} of ${trunc.totalBytes} bytes]`;
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// Check if first line alone exceeds byte limit
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// Collect complete lines that fit.
	// TODO(port): pie: crates/coding-agent/src/tools/truncate.rs:29-51 (truncate_head) never
	// breaks its scan -- once a line doesn't fit the byte budget it is *skipped*, not treated
	// as a stopping point, so a later shorter line can still be appended (kept_lines can be
	// non-contiguous with respect to the original line order). This implementation stops
	// (breaks) at the first line that doesn't fit, always producing a contiguous prefix. Still
	// not replicated *here*: grep/find/ls reconstruct their lines from this function's output
	// and depend on the contiguous-prefix shape. `read` -- the one tool whose kept/total
	// counters and exact bytes reach the model -- now goes through truncateHeadInclusive above,
	// which is oracle 1:1.
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// Work backwards from the end
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
			// take the end of the line (partial)
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// Start from the end, skip maxBytes back
	let start = buf.length - maxBytes;

	// Find a valid UTF-8 boundary (start of a character)
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}

/**
 * Shortens one grep match line to fit within `maxChars` **while keeping the match visible**.
 *
 * pie: `crates/coding-agent/src/tools/grep.rs:158-192` (`preview_match_line`).
 *
 * This used to cut from the head. When the match sits past the cut point — common in minified
 * code, long log lines and single-line JSON — the characters the model received **did not
 * contain the match at all**: grep reported a hit, then showed text where no hit is visible.
 * That is not merely less information, it is misleading.
 *
 * Upstream opens a window around the match instead: the budget goes to the match first, and
 * what remains is split evenly before and after, with a marker on whichever side was cut.
 *
 * With no match range, it falls back to cutting from the head, matching upstream.
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
	matchRange?: { start: number; end: number },
): { text: string; wasTruncated: boolean } {
	const chars = [...line];
	if (chars.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}

	if (!matchRange) {
		return { text: `${chars.slice(0, maxChars).join("")}...[line truncated]`, wasTruncated: true };
	}

	const matchStart = matchRange.start;
	const matchLen = Math.max(1, matchRange.end - matchRange.start);
	const visibleMatchLen = Math.min(matchLen, maxChars);
	const contextBudget = Math.max(0, maxChars - visibleMatchLen);
	const beforeBudget = Math.floor(contextBudget / 2);
	const afterBudget = contextBudget - beforeBudget;

	const startChar = Math.max(0, matchStart - beforeBudget);
	const endChar = matchStart + visibleMatchLen + afterBudget;

	let preview = "";
	if (startChar > 0) preview += "[line truncated]...";
	preview += chars.slice(startChar, Math.min(endChar, chars.length)).join("");
	if (endChar < chars.length) preview += "...[line truncated]";

	return { text: preview, wasTruncated: true };
}
