/**
 * phase 20-6: ports the two cases about **previewing long match lines** from upstream
 * `crates/coding-agent/src/tools/grep.rs`.
 *
 * - `truncates_very_long_matching_lines`
 * - `long_line_preview_keeps_late_match_visible`
 *
 * These exposed a real implementation gap, not merely a missing test: `truncateLine` here used to
 * cut from the head (`slice(0, 500)`). When the match sits past the 500th character — common in
 * minified JS, long log lines and single-line JSON — the 500 characters the model received
 * **contained no match at all**. grep said there was a match, then showed text where none is
 * visible. That is not less information, it is misleading.
 *
 * A window around the match is now implemented per `grep.rs:158-192` (`preview_match_line`). The
 * assertions are **upstream's**.
 */
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createGrepTool } from "../../src/core/tools/grep.ts";
import { GREP_MAX_LINE_LENGTH, truncateLine } from "../../src/core/tools/truncate.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function seed(content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pie-grep-longline-"));
	dirs.push(dir);
	await writeFile(join(dir, "a.txt"), content, "utf-8");
	return dir;
}

async function grepText(dir: string, pattern: string): Promise<string> {
	const tool = createGrepTool(dir);
	const result = await tool.execute("g", { pattern, path: dir } as never, new AbortController().signal);
	const block = result.content.find((c) => c.type === "text");
	return block && "text" in block ? block.text : "";
}

describe("grep: previewing an over-long match line", () => {
	// pie: grep.rs `truncates_very_long_matching_lines`
	// With the match at the start of the line, the right side of the window is cut and the marker lands
	// at the **end**.
	it("a match at the start of the line: cut at the end, and marked", async () => {
		const dir = await seed(`needle ${"x".repeat(GREP_MAX_LINE_LENGTH + 100)}`);
		const text = await grepText(dir, "needle");

		expect(text).toContain("needle");
		expect(text).toContain("...[line truncated]");
	}, 30_000);

	// pie: grep.rs `long_line_preview_keeps_late_match_visible`
	// This is the crux: with the match in the middle, both sides are cut, so **markers appear in both
	// directions**, and the match itself has to survive. Before the fix this returned the first 500
	// characters of the line, with `NEEDLE` nowhere in them.
	it("a match in the middle: cut on both sides, with the match still visible", async () => {
		const dir = await seed(`${"prefix".repeat(120)} NEEDLE ${"suffix".repeat(120)}`);
		const text = await grepText(dir, "NEEDLE");

		expect(text).toContain("NEEDLE");
		expect(text).toContain("[line truncated]...");
		expect(text).toContain("...[line truncated]");
	}, 30_000);
});

describe("truncateLine unit semantics", () => {
	// A line within the limit comes back unchanged: the window logic must not apply to short lines.
	it("a line within the limit comes back unchanged", () => {
		const r = truncateLine("short line", GREP_MAX_LINE_LENGTH, { start: 0, end: 5 });
		expect(r.wasTruncated).toBe(false);
		expect(r.text).toBe("short line");
	});

	// pie: grep.rs:163-166 — with no match position it falls back to cutting from the head, upstream's
	// `match_range: None` branch.
	it("with no match position it falls back to cutting from the head", () => {
		const line = "y".repeat(GREP_MAX_LINE_LENGTH + 50);
		const r = truncateLine(line, GREP_MAX_LINE_LENGTH);
		expect(r.wasTruncated).toBe(true);
		expect(r.text.startsWith("y".repeat(10))).toBe(true);
		expect(r.text.endsWith("...[line truncated]")).toBe(true);
	});

	// How the budget is split: the match takes its share first, and what remains is divided evenly
	// before and after. The match landing inside the window is a hard requirement.
	it("when the match sits late, the window moves right to take it in", () => {
		const prefix = "a".repeat(2000);
		const line = `${prefix}ZZZ${"b".repeat(2000)}`;
		const r = truncateLine(line, 100, { start: 2000, end: 2003 });

		expect(r.wasTruncated).toBe(true);
		expect(r.text).toContain("ZZZ");
		expect(r.text.startsWith("[line truncated]...")).toBe(true);
		expect(r.text.endsWith("...[line truncated]")).toBe(true);
		// The window's content, with the markers on either side removed, stays within budget.
		const body = r.text.slice("[line truncated]...".length, -"...[line truncated]".length);
		expect([...body].length).toBeLessThanOrEqual(100);
	});
});
