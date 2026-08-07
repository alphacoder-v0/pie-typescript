/**
 * char-tests port of the `#[cfg(test)] mod tests` in oracle
 * `crates/coding-agent/src/ui/feed.rs:784-1044` (pie @0a120dfd).
 *
 * All 17 oracle tests are ported one-for-one, keeping oracle's test names and assertion strength
 * (no relaxed `toContain` where oracle used `assert_eq!`, no dropped sub-assertions). A trailing
 * `describe` block adds coverage for the parts of the module oracle exercises only indirectly
 * through `ui/mod.rs` / `ui/web.rs`: `web_blocks`, `style_for_level`, `push_plain_untimed`,
 * `push_*_at`, and the empty-input edge of `compact_tool_output_lines`.
 */

import { describe, expect, it } from "vitest";
import {
	compactToolContentBlocks,
	compactToolOutputLines,
	Feed,
	type FeedLine,
	formatTimestampLabel,
	type Level,
	strWidth,
	TOOL_OUTPUT_HEAD_LINES,
	TOOL_OUTPUT_MAX_LINE_CHARS,
	TOOL_OUTPUT_TAIL_LINES,
	wrapStr,
} from "../../src/ui/feed.ts";

/**
 * pie: feed.rs:788-799 (`fn plain_text`). Oracle flattens each `Line`'s spans and joins rows with
 * `\n`; this port's `FeedLine` already carries the whole row as one string.
 */
function plainText(lines: readonly FeedLine[]): string {
	return lines.map((line) => line.text).join("\n");
}

/** pie: feed.rs:801-806 (`fn assert_full_timestamp_prefix`). `chars().nth(n)` = code point n. */
function assertFullTimestampPrefix(row: string, rendered: string): void {
	const chars = [...row];
	expect(chars[4], rendered).toBe("-");
	expect(chars[7], rendered).toBe("-");
	expect(chars[10], rendered).toBe(" ");
	expect(chars[13], rendered).toBe(":");
}

describe("ported feed.rs #[cfg(test)] tests", () => {
	/** pie: feed.rs:808-818 */
	it("text_deltas_accumulate_into_one_assistant_block", () => {
		const feed = new Feed();
		feed.apply({ kind: "turn_start" });
		feed.apply({ kind: "text_delta", delta: " hello" });
		feed.apply({ kind: "text_delta", delta: " world" });
		feed.apply({ kind: "turn_end" });
		const rendered = plainText(feed.lines(80));
		// Leading whitespace before the first visible char is trimmed.
		expect(rendered, rendered).toContain("ai ▸ hello world");
	});

	/** pie: feed.rs:820-846 */
	it("thinking_then_text_then_tool_keep_separate_blocks", () => {
		const feed = new Feed();
		feed.apply({ kind: "turn_start" });
		feed.apply({ kind: "thinking_delta", delta: "pondering" });
		feed.apply({ kind: "text_delta", delta: "answer" });
		feed.apply({ kind: "tool_start", name: "read", args: '(path="x")' });
		feed.apply({
			kind: "tool_end",
			tool_call_id: "tool-1",
			lines: ["line a", "line b"],
			is_error: false,
		});
		feed.apply({ kind: "text_delta", delta: "after tool" });
		const rendered = plainText(feed.lines(80));
		expect(rendered).toContain("[thinking] pondering");
		expect(rendered).toContain("answer");
		expect(rendered).toContain('⚙ read(path="x")');
		expect(rendered).toContain("    line a");
		expect(rendered).toContain("after tool");
		// text-after-tool starts a fresh assistant block, not glued to "answer".
		const idxAnswer = rendered.indexOf("answer");
		const idxAfter = rendered.indexOf("after tool");
		expect(idxAnswer).toBeGreaterThanOrEqual(0);
		expect(idxAfter).toBeGreaterThan(idxAnswer);
	});

	/** pie: feed.rs:848-853 */
	it("wrap_breaks_on_word_boundaries_and_preserves_indent", () => {
		const rows = wrapStr("    aaaa bbbb cccc", 10);
		expect(rows[0]).toBe("    aaaa");
		expect(rows.length).toBeGreaterThanOrEqual(2);
	});

	/** pie: feed.rs:855-859 */
	it("wrap_hard_breaks_overlong_word", () => {
		expect(wrapStr("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
	});

	/** pie: feed.rs:861-867 */
	it("cjk_text_survives_wrapping", () => {
		const rows = wrapStr("你好世界一二三四", 6);
		// Each CJK glyph is width 2 → 3 per row of width 6.
		expect(rows.every((r) => strWidth(r) <= 6)).toBe(true);
		expect(rows.join("")).toBe("你好世界一二三四");
	});

	/** pie: feed.rs:869-878 */
	it("user_block_gets_prefix_and_blank_separator", () => {
		const feed = new Feed();
		feed.pushPlain("banner", "header");
		feed.pushUser("do the thing");
		const rendered = plainText(feed.lines(80));
		expect(rendered).toContain("you ▸ do the thing");
		// a blank line separates the banner from the user turn
		expect(rendered).toContain("\n\n");
	});

	/** pie: feed.rs:880-891 */
	it("user_and_assistant_blocks_have_breathing_room", () => {
		const feed = new Feed();
		feed.pushUser("tight?");
		feed.pushAssistant("not anymore");
		const rendered = plainText(feed.lines(80));

		expect(
			rendered.includes("you ▸ tight?\n\n") && rendered.includes("ai ▸ not anymore"),
			`assistant reply should not be glued to the user prompt:\n${rendered}`,
		).toBe(true);
	});

	/** pie: feed.rs:893-907 */
	it("user_and_tool_first_reply_have_breathing_room", () => {
		const feed = new Feed();
		feed.pushUser("inspect");
		feed.pushTool("read", '(path="x")');
		feed.pushToolResult("tool-1", ["contents"], false);
		const rendered = plainText(feed.lines(80));

		expect(
			rendered.includes("you ▸ inspect\n\n") &&
				rendered.includes('⚙ read(path="x")') &&
				rendered.includes("    contents"),
			"tool-first assistant activity should not be glued to the user prompt, but tool result " +
				`should stay with the tool call:\n${rendered}`,
		).toBe(true);
	});

	/** pie: feed.rs:909-927 */
	it("rendered_message_blocks_include_short_time_prefix", () => {
		const feed = new Feed();
		feed.pushUser("hello");
		feed.pushAssistant("hi");
		feed.pushTool("read", '(path="x")');
		feed.pushToolResult("tool-1", ["ok"], false);
		const rendered = plainText(feed.lines(120));
		const rows = rendered.split("\n");

		expect(rows[0], rendered).toContain("you ▸ hello");
		assertFullTimestampPrefix(rows[0] as string, rendered);
		expect(rows[2], rendered).toContain("ai ▸ hi");
		assertFullTimestampPrefix(rows[2] as string, rendered);
		expect(rows[3], rendered).toContain('⚙ read(path="x")');
		assertFullTimestampPrefix(rows[3] as string, rendered);
		expect(rows[4], rendered).toContain("    ok");
		assertFullTimestampPrefix(rows[4] as string, rendered);
	});

	/**
	 * pie: feed.rs:929-947. Oracle builds both instants with `Local.with_ymd_and_hms(..)` and hands
	 * `format_timestamp_label` the UTC view; the function converts straight back to local, so the
	 * expected strings are the local wall-clock ones and the assertion is timezone-independent.
	 * `new Date(y, m, d, ..)` is the local-zone constructor, matching `Local.with_ymd_and_hms`.
	 */
	it("timestamp_label_includes_full_date_and_time", () => {
		const today = new Date(2026, 4, 27, 14, 37, 0);
		const sameDay = new Date(today.getTime());
		const previousDay = new Date(2026, 4, 26, 23, 59, 0);

		expect(formatTimestampLabel(sameDay, today)).toBe("2026-05-27 14:37");
		expect(formatTimestampLabel(previousDay, today)).toBe("2026-05-26 23:59");
	});

	/** pie: feed.rs:949-962 */
	it("narrow_width_keeps_timestamped_blocks_renderable", () => {
		const feed = new Feed();
		feed.pushUser("a very long message that wraps");
		const rendered = plainText(feed.lines(16));

		expect(rendered, rendered).toContain("you ▸");
		expect(
			rendered.split("\n").every((line) => strWidth(line) <= 16),
			rendered,
		).toBe(true);
	});

	/** pie: feed.rs:964-968 */
	it("compact_tool_output_keeps_short_output_unchanged", () => {
		const lines = ["ok", "done"];
		expect(compactToolOutputLines([...lines], false)).toEqual(lines);
	});

	/** pie: feed.rs:970-984 */
	it("compact_tool_output_keeps_head_and_tail_with_summary", () => {
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
		const compacted = compactToolOutputLines(lines, false);

		expect(compacted.length).toBeLessThanOrEqual(TOOL_OUTPUT_HEAD_LINES + TOOL_OUTPUT_TAIL_LINES + 1);
		expect(compacted[0]).toBe("line 0");
		expect(compacted.some((line) => line.includes("truncated"))).toBe(true);
		expect(compacted.some((line) => line.includes("full output remains available to the agent"))).toBe(true);
		expect(compacted[compacted.length - 1]).toBe("line 39");
	});

	/** pie: feed.rs:986-996 */
	it("compact_tool_output_allows_more_error_context", () => {
		const lines = Array.from({ length: 36 }, (_, i) => `line ${i}`);

		expect(compactToolOutputLines([...lines], false).some((line) => line.includes("truncated"))).toBe(true);
		expect(compactToolOutputLines(lines, true).length).toBe(36);
	});

	/** pie: feed.rs:998-1005 */
	it("compact_tool_output_truncates_utf8_safely", () => {
		const long = "你好".repeat(TOOL_OUTPUT_MAX_LINE_CHARS + 10);
		const compacted = compactToolOutputLines([long], false);

		expect(compacted[0]?.endsWith("…")).toBe(true);
		expect(compacted.some((line) => line.includes("truncated"))).toBe(true);
	});

	/** pie: feed.rs:1007-1024 */
	it("tool_progress_for_same_call_is_replaced_not_appended", () => {
		const feed = new Feed();
		feed.apply({ kind: "tool_progress", tool_call_id: "tool-1", lines: ["old progress"], is_error: false });
		feed.apply({ kind: "tool_progress", tool_call_id: "tool-1", lines: ["new progress"], is_error: false });

		const rendered = plainText(feed.lines(80));
		expect(rendered).not.toContain("old progress");
		expect(rendered).toContain("new progress");
	});

	/** pie: feed.rs:1026-1043 */
	it("final_tool_output_replaces_progress_for_same_call", () => {
		const feed = new Feed();
		feed.apply({ kind: "tool_progress", tool_call_id: "tool-1", lines: ["progress"], is_error: false });
		feed.apply({ kind: "tool_end", tool_call_id: "tool-1", lines: ["final result"], is_error: false });

		const rendered = plainText(feed.lines(80));
		expect(rendered).not.toContain("progress");
		expect(rendered).toContain("final result");
	});
});

describe("feed surface reached only through ui/mod.rs and ui/web.rs", () => {
	/** pie: feed.rs:487-533 (`web_blocks`) — consumed by `ui/web.rs:554`. */
	it("web_blocks mirrors every block kind with serde wire names", () => {
		const feed = new Feed();
		feed.pushUserAt("hi", 1_780_000_000_000);
		feed.pushAssistantAt("yo", 1_780_000_060_000);
		feed.pushThinkingAt("hmm", 1_780_000_120_000);
		feed.pushToolAt("read", '(path="x")', 1_780_000_180_000);
		feed.pushToolResultAt("tool-1", ["boom"], true, 1_780_000_240_000);
		feed.pushPlainUntimed("qr-art", "qr");

		const blocks = feed.webBlocks();
		expect(blocks.map((b) => b.kind)).toEqual(["user", "assistant", "thinking", "tool", "tool_result", "plain"]);

		const toolResult = blocks[4];
		expect(toolResult).toMatchObject({ kind: "tool_result", lines: ["boom"], is_error: true });
		// `tool_call_id` is deliberately dropped on the web shape (feed.rs:512-521).
		expect(Object.hasOwn(toolResult as object, "tool_call_id")).toBe(false);
		// Untimed plain blocks carry no timestamp at all.
		expect(blocks[5]).toEqual({ kind: "plain", text: "qr-art", level: "qr", timestamp: undefined });
		// Every timestamped block rendered its epoch-ms into the `%Y-%m-%d %H:%M` label.
		for (const block of blocks.slice(0, 5)) {
			expect(block.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
		}
	});

	/** pie: feed.rs:593-595 — a non-positive epoch yields no label at all. */
	it("push_*_at drops the timestamp for a non-positive epoch", () => {
		const feed = new Feed();
		feed.pushUserAt("no clock", 0);
		feed.pushAssistantAt("me neither", -1);
		expect(feed.webBlocks().map((b) => b.timestamp)).toEqual([undefined, undefined]);
		// Without a timestamp the label alone is the prefix (feed.rs:585).
		expect(plainText(feed.lines(80)).split("\n")).toEqual(["you ▸ no clock", "", "ai ▸ me neither"]);
	});

	/** pie: feed.rs:568-579 (`style_for_level`) + feed.rs:467-480. */
	it("style_for_level maps every Level onto its ratatui style", () => {
		const levels: Level[] = ["output", "system", "error", "note", "header", "qr"];
		const feed = new Feed();
		for (const level of levels) {
			feed.pushPlainUntimed(level, level);
		}
		expect(feed.lines(80).map((line) => line.style)).toEqual([
			{},
			{ fg: "darkGray" },
			{ fg: "red" },
			{ fg: "green" },
			{ fg: "magenta", bold: true },
			{},
		]);
	});

	/** pie: feed.rs:443-453 — tool results are red when `is_error`, green otherwise. */
	it("tool result rows carry the error/ok colour", () => {
		const feed = new Feed();
		feed.pushToolResult("ok-1", ["fine"], false);
		feed.pushToolResult("bad-1", ["broken"], true);
		expect(feed.lines(80).map((line) => line.style)).toEqual([{ fg: "green" }, { fg: "red" }]);
	});

	/** pie: feed.rs:176-180 (`clear`). */
	it("clear empties the feed and reopens the trim gate", () => {
		const feed = new Feed();
		feed.apply({ kind: "text_delta", delta: "x" });
		feed.clear();
		expect(feed.lines(80)).toEqual([]);
		feed.apply({ kind: "text_delta", delta: "   spaced" });
		expect(plainText(feed.lines(80))).toContain("ai ▸ spaced");
	});

	/**
	 * pie: feed.rs:371-410 — the two delta guards are written differently (`text_delta` bails on any
	 * empty delta; `thinking_delta` bails only when no thinking block is open) but neither ever
	 * opens a block for an empty delta.
	 */
	it("an empty delta opens no block on either channel", () => {
		const thinkingFeed = new Feed();
		thinkingFeed.apply({ kind: "thinking_delta", delta: "" });
		expect(thinkingFeed.lines(80)).toEqual([]);
		// With a thinking block already open, an empty delta falls past the guard and is a no-op.
		thinkingFeed.apply({ kind: "thinking_delta", delta: "why" });
		thinkingFeed.apply({ kind: "thinking_delta", delta: "" });
		expect(plainText(thinkingFeed.lines(80))).toContain("[thinking] why");
		expect(thinkingFeed.webBlocks()).toHaveLength(1);

		const textFeed = new Feed();
		textFeed.apply({ kind: "text_delta", delta: "" });
		expect(textFeed.lines(80)).toEqual([]);
		// An all-whitespace delta trims to empty while the trim gate is open, so still no block.
		textFeed.apply({ kind: "text_delta", delta: "   " });
		expect(textFeed.lines(80)).toEqual([]);
	});

	/** pie: feed.rs:366-367 — display-only updates append nothing. */
	it("trigger_poll_status and skills_reloaded append no block", () => {
		const feed = new Feed();
		feed.apply({
			kind: "trigger_poll_status",
			checked_at: "2026-05-27 14:37",
			trace_id: "trace-0001",
			source_label: "local:dynamic",
			event_label: "dynamic periodic check",
			summary: "no dynamic trigger rule matched",
		});
		feed.apply({ kind: "skills_reloaded", total: 3 });
		expect(feed.lines(80)).toEqual([]);
	});

	/** pie: feed.rs:736-740 — empty input yields an empty result, never a bare marker. */
	it("compact_tool_output_lines returns nothing for empty input", () => {
		expect(compactToolOutputLines([], false)).toEqual([]);
		expect(compactToolOutputLines([], true)).toEqual([]);
	});

	/** pie: feed.rs:743-754 (`compact_tool_content_blocks`). */
	it("compact_tool_content_blocks splits text blocks with Rust `lines()` and skips images", () => {
		expect(
			compactToolContentBlocks(
				[
					{ type: "text", text: "a\nb\n" },
					{ type: "image", data: "AAA=", mimeType: "image/png" },
					{ type: "text", text: "c" },
				],
				false,
			),
		).toEqual(["a", "b", "c"]);
		// Rust `"".lines()` yields nothing at all — not one empty line.
		expect(compactToolContentBlocks([{ type: "text", text: "" }], false)).toEqual([]);
	});

	/** pie: feed.rs:606-631 (`push_paragraphs`) — only the FIRST paragraph gets the prefix. */
	it("multi-paragraph blocks prefix only the first line", () => {
		const feed = new Feed();
		feed.pushPlainUntimed("first\nsecond", "output");
		expect(feed.lines(80).map((l) => l.text)).toEqual(["first", "second"]);

		const user = new Feed();
		user.pushUserAt("first\nsecond", 0);
		expect(user.lines(80).map((l) => l.text)).toEqual(["you ▸ first", "second"]);
	});

	/** pie: feed.rs:636-639 — `wrap_str` always returns at least one (possibly empty) row. */
	it("wrapStr keeps blank lines and clamps a zero width to 1", () => {
		expect(wrapStr("", 80)).toEqual([""]);
		expect(wrapStr("ab", 0)).toEqual(["a", "b"]);
	});

	/** pie: feed.rs:646 — control characters are width 0 (`UnicodeWidthChar::width` → `None`). */
	it("strWidth scores control characters as zero and wide glyphs as two", () => {
		expect(strWidth("\t")).toBe(0);
		expect(strWidth("\x1b")).toBe(0);
		expect(strWidth("abc")).toBe(3);
		expect(strWidth("你好")).toBe(4);
		expect(strWidth("▸")).toBe(1);
	});
});
