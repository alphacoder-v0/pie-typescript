/**
 * Tests for `@file` mention expansion.
 *
 * Ported from the Rust unit tests in oracle crates/coding-agent/src/mentions.rs:115-167, plus
 * characterization tests for the byte-level truncation cap and the tokenizer edge cases that
 * the Rust suite exercises only indirectly.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { expand, extractMentions, MAX_BYTES } from "../src/mentions.ts";

const dirs: string[] = [];

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pie-mentions-"));
	dirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of dirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
});

// ============================================================================
// extractMentions (mentions.rs:65-101)
// ============================================================================

describe("extractMentions", () => {
	// mentions.rs:120-126
	test("extracts a simple mention", () => {
		expect(extractMentions("look at @src/foo.rs please")).toEqual(["src/foo.rs"]);
	});

	// mentions.rs:128-135
	test("extracts multiple mentions with punctuation around them", () => {
		expect(extractMentions("review @a.rs, @b/c.rs and (@d.rs)")).toEqual(["a.rs", "b/c.rs", "d.rs"]);
	});

	// mentions.rs:137-140
	test("ignores an @ inside an email address", () => {
		expect(extractMentions("ping user@host.com")).toEqual([]);
	});

	// mentions.rs:75-81 -- the boundary rule is alphanumeric / `_` / `.` before the `@`.
	test("rejects @ preceded by alphanumeric, underscore or dot", () => {
		expect(extractMentions("a@x")).toEqual([]);
		expect(extractMentions("_@x")).toEqual([]);
		expect(extractMentions(".@x")).toEqual([]);
		expect(extractMentions("9@x")).toEqual([]);
	});

	test("accepts @ preceded by other punctuation or whitespace", () => {
		expect(extractMentions("-@x")).toEqual(["x"]);
		expect(extractMentions("/@x")).toEqual(["x"]);
		expect(extractMentions("\t@x")).toEqual(["x"]);
	});

	// mentions.rs:85 -- terminator set.
	test("stops the path at whitespace, semicolon, comma, parens, quotes and backtick", () => {
		expect(extractMentions("@a;b @c,d @e(f @g)h @i\"j @k'l @m`n")).toEqual(["a", "c", "e", "g", "i", "k", "m"]);
	});

	// mentions.rs:93 -- `trim_end_matches` strips EVERY trailing occurrence.
	test("strips all trailing sentence punctuation", () => {
		expect(extractMentions("see @a.rs.")).toEqual(["a.rs"]);
		expect(extractMentions("really? @a.rs?!:.")).toEqual(["a.rs"]);
	});

	// mentions.rs:94-96 -- a mention that trims away to nothing is dropped.
	test("drops a mention that is only punctuation", () => {
		expect(extractMentions("wat @... ok")).toEqual([]);
		expect(extractMentions("bare @ token")).toEqual([]);
	});

	// mentions.rs:65-101 -- no dedup pass anywhere in the scanner.
	test("does not collapse duplicates", () => {
		expect(extractMentions("@a.rs and @a.rs")).toEqual(["a.rs", "a.rs"]);
	});

	// `char::is_whitespace` is Unicode White_Space, not ASCII space.
	test("treats unicode whitespace as a terminator", () => {
		expect(extractMentions("@a b")).toEqual(["a"]);
		expect(extractMentions("@a　b")).toEqual(["a"]);
	});

	// `chars()` iteration -- a non-ASCII letter before `@` is still alphanumeric.
	test("applies the word-boundary rule to non-ASCII letters", () => {
		expect(extractMentions("é@x")).toEqual([]);
		expect(extractMentions("中@x")).toEqual([]);
	});
});

// ============================================================================
// expand (mentions.rs:26-61)
// ============================================================================

describe("expand", () => {
	// mentions.rs:160-166
	test("returns the input unchanged when there are no mentions", async () => {
		const dir = makeDir();
		const result = await expand("just a regular prompt", dir);
		expect(result.prompt).toBe("just a regular prompt");
		expect(result.resolvedPaths).toEqual([]);
	});

	// mentions.rs:142-158
	test("reads files and falls back to an error block on a missing one", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "hello.txt"), "hi there");

		const result = await expand("look at @hello.txt and @missing.txt", dir);

		expect(result.prompt.startsWith("Files in context:")).toBe(true);
		expect(result.prompt).toContain('<file path="hello.txt">');
		expect(result.prompt).toContain("hi there");
		expect(result.prompt).toContain('<file path="missing.txt"');
		// The user's original text (raw `@` tokens included) is preserved after the header.
		expect(result.prompt).toContain("look at @hello.txt");
		// Only files that were read land in `resolved`.
		expect(result.resolvedPaths).toEqual([join(dir, "hello.txt")]);
	});

	// mentions.rs:39-46,59-60 -- exact block/header shape.
	test("emits the exact header and block layout", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "a.txt"), "AAA");
		writeFileSync(join(dir, "b.txt"), "BBB");

		const result = await expand("@a.txt @b.txt", dir);

		expect(result.prompt).toBe(
			'Files in context:\n<file path="a.txt">\nAAA\n</file>\n<file path="b.txt">\nBBB\n</file>\n\n@a.txt @b.txt',
		);
	});

	// mentions.rs:50-56 -- the error block is self-closing and carries a `path` then an `error`.
	test("error block is self-closing and keeps attribute order", async () => {
		const dir = makeDir();
		const result = await expand("@nope.txt", dir);
		expect(result.prompt).toMatch(/^Files in context:\n<file path="nope\.txt" error="[^"]*" \/>\n\n@nope\.txt$/);
		expect(result.resolvedPaths).toEqual([]);
	});

	// mentions.rs:33-58 -- one block per mention occurrence, duplicates included.
	test("emits one block per mention occurrence", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "a.txt"), "AAA");
		const result = await expand("@a.txt @a.txt", dir);
		expect(result.prompt.match(/<file path="a\.txt">/g)).toHaveLength(2);
		expect(result.resolvedPaths).toEqual([join(dir, "a.txt"), join(dir, "a.txt")]);
	});

	// mentions.rs:34 -- `Path::join` with an absolute mention replaces cwd entirely.
	test("absolute mention paths replace the cwd", async () => {
		const dir = makeDir();
		const other = makeDir();
		const abs = join(other, "abs.txt");
		writeFileSync(abs, "ABS");

		const result = await expand(`@${abs}`, dir);
		expect(result.prompt).toContain("ABS");
		expect(result.resolvedPaths).toEqual([abs]);
	});
});

// ============================================================================
// truncate (mentions.rs:103-113), exercised through expand
// ============================================================================

describe("expand truncation", () => {
	test("does not truncate a file exactly at the cap", async () => {
		const dir = makeDir();
		const body = "a".repeat(MAX_BYTES);
		writeFileSync(join(dir, "cap.txt"), body);

		const result = await expand("@cap.txt", dir);
		expect(result.prompt).toContain(body);
		expect(result.prompt).not.toContain("(truncated at");
	});

	test("truncates past the cap with the KiB marker", async () => {
		const dir = makeDir();
		writeFileSync(join(dir, "big.txt"), "a".repeat(MAX_BYTES + 10));

		const result = await expand("@big.txt", dir);
		expect(result.prompt).toBe(
			`Files in context:\n<file path="big.txt">\n${"a".repeat(MAX_BYTES)}\n\n(truncated at 64 KiB)\n</file>\n\n@big.txt`,
		);
	});

	test("backs off to a UTF-8 character boundary", async () => {
		const dir = makeDir();
		// 65535 ASCII bytes + two 3-byte characters: the cap lands mid-character.
		writeFileSync(join(dir, "utf8.txt"), `${"a".repeat(MAX_BYTES - 1)}€€`);

		const result = await expand("@utf8.txt", dir);
		const opening = '<file path="utf8.txt">\n';
		const body = result.prompt.slice(
			result.prompt.indexOf(opening) + opening.length,
			result.prompt.indexOf("\n\n(truncated at"),
		);
		// Trailing partial character dropped, never replaced with U+FFFD.
		expect(body).toBe("a".repeat(MAX_BYTES - 1));
		expect(body).not.toContain("�");
	});

	test("counts the cap in UTF-8 bytes, not UTF-16 code units", async () => {
		const dir = makeDir();
		// 30000 three-byte characters = 90000 bytes > cap, but only 30000 JS string units.
		writeFileSync(join(dir, "cjk.txt"), "中".repeat(30000));

		const result = await expand("@cjk.txt", dir);
		expect(result.prompt).toContain("(truncated at 64 KiB)");
	});
});
