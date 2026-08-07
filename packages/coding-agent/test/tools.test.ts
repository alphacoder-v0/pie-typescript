import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashOperations, createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createGrepToolDefinition,
	createLsTool,
	createReadTool,
	createWriteTool,
	type EditToolInput,
	type GrepExecuteInput,
} from "../src/index.ts";
import * as shellModule from "../src/utils/shell.ts";

const readTool = createReadTool(process.cwd());
const writeTool = createWriteTool(process.cwd());
const editTool = createEditTool(process.cwd());
const bashTool = createBashTool(process.cwd());
const grepTool = createGrepTool(process.cwd());
const findTool = createFindTool(process.cwd());
const lsTool = createLsTool(process.cwd());

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	// pie: crates/coding-agent/src/tools/read.rs:36-85. Every assertion below was flipped from pi's
	// shape to oracle's when the port stopped emitting pi's trailing "[Showing lines a-b of N. Use
	// offset=... to continue.]" notice: oracle prints a `[{path}] lines {a}-{b}` header BEFORE the
	// slice, an optional `[truncated: kept K/N lines, X of Y bytes]` note between the two, and
	// `details = {path, totalLines, keptLines, offset}`. That text is the model's input contract
	// (it is how the model knows which absolute line numbers it is holding), so it is a judged
	// surface, not cosmetics.
	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			// pie: read.rs:71 — header first, then the bytes, unchanged.
			expect(getTextOutput(result)).toBe(`[${testFile}] lines 1-3\n${content}`);
			// Nothing was dropped, so there is no truncation note (read.rs:73-76).
			expect(getTextOutput(result)).not.toContain("[truncated:");
			// pie: read.rs:78-84 — details is always present on the text path, with these four keys.
			expect(result.details).toEqual({ path: testFile, totalLines: 3, keptLines: 3, offset: 1 });
		});

		// pie: read.rs:51-53 — `read {path}: {e}` where `{e}` is `std::io::Error`'s Display, which
		// for an OS failure is "{strerror} (os error {errno})". Was Node's raw
		// "ENOENT: no such file or directory, access '<path>'" — and that string reaches the model.
		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(
				`read ${testFile}: No such file or directory (os error 2)`,
			);
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).not.toContain("Line 2001");
			// pie: read.rs:57-71 — the scan itself stops at `limit`, so the slice handed to
			// `truncate_head` is already 2000 lines and its note never fires; the header is the only
			// signal, and it reports the kept range rather than the file's length.
			expect(output.startsWith(`[${testFile}] lines 1-2000\n`)).toBe(true);
			expect(output).not.toContain("[truncated:");
		});

		it("should truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			// Create file that exceeds the 256KiB byte limit (pie: crates/coding-agent/src/tools/
			// truncate.rs:5) but has fewer than 2000 lines, so it's byte-limited, not line-limited.
			const lines = Array.from({ length: 1500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(300)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1:");
			// pie: read.rs:71-77 + truncate.rs:16-26 — header, then oracle's note verbatim, then the
			// slice. The byte cap is the only limit `truncate_head` can hit here, and the kept count
			// in the header and in the note must agree (the \1 backreference).
			const escapedPath = testFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			expect(output).toMatch(
				new RegExp(
					`^\\[${escapedPath}\\] lines 1-(\\d+)\\n\\[truncated: kept \\1/1500 lines, \\d+ of \\d+ bytes\\]\\n`,
				),
			);
		});

		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			// pie: read.rs:71 — `skip + 1` to `skip + kept_lines`, i.e. absolute file line numbers.
			expect(output.startsWith(`[${testFile}] lines 51-100\n`)).toBe(true);
			expect(output).not.toContain("[truncated:");
			expect(result.details).toEqual({ path: testFile, totalLines: 100, keptLines: 50, offset: 51 });
		});

		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).not.toContain("Line 11");
			expect(output.startsWith(`[${testFile}] lines 1-10\n`)).toBe(true);
			// pie: read.rs:57-68 — BUG(port) replicated: `total_lines` is bumped before the break, so
			// `details.totalLines` is 11 (skip + limit + 1), NOT the file's 100 lines. Oracle offers
			// the model no "N more lines in file" hint at all; pi's used to be asserted here.
			expect(result.details).toEqual({ path: testFile, totalLines: 11, keptLines: 10, offset: 1 });
			expect(output).not.toContain("more lines in file");
		});

		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output.startsWith(`[${testFile}] lines 41-60\n`)).toBe(true);
			// Same BUG(port) as above: 40 skipped + 20 taken + the one that tripped the break.
			expect(result.details).toEqual({ path: testFile, totalLines: 61, keptLines: 20, offset: 41 });
		});

		// pie: read.rs:56-71 — an out-of-range offset is NOT an error in oracle. The scan skips every
		// line, `kept_lines` is 0, and the header degenerates to the inverted range `lines 100-99`.
		// This used to reject with pi's "Offset 100 is beyond end of file (3 lines total)".
		it("should return an empty inverted range when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			const result = await readTool.execute("test-call-8", { path: testFile, offset: 100 });

			expect(getTextOutput(result)).toBe(`[${testFile}] lines 100-99\n`);
			expect(result.details).toEqual({ path: testFile, totalLines: 3, keptLines: 0, offset: 100 });
		});

		it("should report oracle's counters in details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			// pie: read.rs:78-84. No `truncation` sub-object: oracle's details has exactly these four
			// keys, and `details` is persisted into the session transcript, so an extra key is a
			// divergence on the judged surface rather than a private UI detail.
			expect(result.details).toEqual({ path: testFile, totalLines: 2001, keptLines: 2000, offset: 1 });
		});

		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
		});

		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});

		it("should error on non-image binary content instead of silently mangling it as text", async () => {
			// pie: crates/coding-agent/src/tools/read.rs:51-53 -- oracle's `read_to_string`
			// errors on invalid UTF-8 with "stream did not contain valid UTF-8". Node's
			// Buffer#toString("utf-8") never throws (it substitutes U+FFFD), so read.ts now
			// validates explicitly instead of returning mangled text.
			const testFile = join(testDir, "not-an-image.bin");
			// Lone continuation byte (0x80) is invalid as a UTF-8 sequence start; not a
			// recognized image magic number either.
			writeFileSync(testFile, Buffer.from([0xff, 0xfe, 0x80, 0x01, 0x02]));

			await expect(readTool.execute("test-call-binary-1", { path: testFile })).rejects.toThrow(
				/stream did not contain valid UTF-8/,
			);
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			// pie: crates/coding-agent/src/tools/write.rs:48-53 (`Wrote {bytes} bytes ({lines} lines) to {path}`)
			expect(getTextOutput(result)).toContain(`Wrote 12 bytes (1 lines) to ${testFile}`);
			// pie: write.rs:54 — oracle emits `details: {path, bytes, lines}`; the port used to emit
			// `undefined`, which is a missing key in the persisted transcript, not an equivalent one.
			expect(result.details).toEqual({ path: testFile, bytes: 12, lines: 1 });
		});

		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain(`Wrote 14 bytes (1 lines) to ${testFile}`);
		});

		// pie: crates/coding-agent/src/tools/write.rs:48 — byte count is UTF-8 byte length, not JS
		// string `.length` (UTF-16 code units); multi-byte characters must diverge from `.length`.
		it("should report UTF-8 byte length, not JS string length, for multi-byte content", async () => {
			const testFile = join(testDir, "write-utf8.txt");
			const content = "héllo\n"; // 'é' is 2 bytes in UTF-8 but 1 UTF-16 code unit

			const result = await writeTool.execute("test-call-3b", { path: testFile, content });

			expect(content.length).toBe(6);
			expect(getTextOutput(result)).toContain("Wrote 7 bytes (1 lines) to");
		});

		// pie: crates/coding-agent/src/tools/write.rs:49 — line count matches Rust's `str::lines()`:
		// a single trailing newline does not add an extra counted line.
		it("should count lines the way Rust's str::lines() does", async () => {
			const testFile = join(testDir, "write-lines.txt");

			const withTrailingNewline = await writeTool.execute("test-call-3c", {
				path: testFile,
				content: "line1\nline2\nline3\n",
			});
			expect(getTextOutput(withTrailingNewline)).toContain("(3 lines)");

			const withoutTrailingNewline = await writeTool.execute("test-call-3d", {
				path: testFile,
				content: "line1\nline2\nline3",
			});
			expect(getTextOutput(withoutTrailingNewline)).toContain("(3 lines)");
		});

		// pie: crates/coding-agent/src/tools/write.rs:39-42 — parent-directory creation failures are
		// swallowed; the write still proceeds and surfaces its own error only if the directory
		// truly doesn't exist.
		it("should swallow mkdir failures and still attempt the write", async () => {
			const testFile = join(testDir, "swallow-test.txt");
			const tool = createWriteTool(testDir, {
				operations: {
					mkdir: async () => {
						throw new Error("simulated mkdir failure");
					},
					writeFile: async (p, c) => {
						writeFileSync(p, c, "utf-8");
					},
				},
			});

			const result = await tool.execute("test-call-3e", { path: "swallow-test.txt", content: "ok" });

			expect(getTextOutput(result)).toContain("Wrote 2 bytes (1 lines) to");
			expect(readFileSync(testFile, "utf-8")).toBe("ok");
		});
	});

	// pie: crates/coding-agent/src/tools/edit.rs:23-89 -- the model-visible contract is now
	// oracle's single `old_string`/`new_string`/`replace_all`. The `edits[]` batch form below is
	// the pi-only in-process path (see EditExecuteInput / the TODO(port) at the top of edit.ts).
	// `AgentTool.execute`'s signature is derived from `editSchema`, which deliberately does not
	// describe that form, so each surviving batch call site widens through `unknown`.
	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				old_string: "world",
				new_string: "testing",
			});

			// pie: edit.rs:78-81 ("Edited {path} ({n} replacement{s}).\n{preview}")
			expect(getTextOutput(result)).toContain(`Edited ${testFile} (1 replacement).`);
			expect(getTextOutput(result)).toContain("--- before\n- world\n+++ after\n+ testing\n");
			expect(result.details).toBeDefined();
			// pie: edit.rs:82-86 (details json! object)
			expect(result.details.path).toBe(testFile);
			expect(result.details.replacements).toBe(1);
			expect(result.details.replaceAll).toBe(false);
			// Flipped: the port used to add renderer-only `diff` / `firstChangedLine` keys here.
			// Oracle's `details` has exactly the three keys above, and `details` is serialized into
			// the session transcript, so the extras were visible on the judged surface.
			expect(result.details).toEqual({ path: testFile, replacements: 1, replaceAll: false });
			expect(readFileSync(testFile, "utf-8")).toBe("Hello, testing!");
		});

		// pie: edit.rs:44-49
		it("should fail when old_string equals new_string", async () => {
			const testFile = join(testDir, "edit-same.txt");
			writeFileSync(testFile, "Hello, world!");

			await expect(
				editTool.execute("test-call-5b", { path: testFile, old_string: "world", new_string: "world" }),
			).rejects.toThrow("old_string must differ from new_string");
		});

		// pie: edit.rs:55-59
		it("should fail if text not found", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					old_string: "nonexistent",
					new_string: "testing",
				}),
			).rejects.toThrow(`old_string not found in ${testFile}`);
		});

		// pie: edit.rs:51-53 (`read {path}: {e}`). Flipped from the `Error code: ENOENT` placeholder
		// to `std::io::Error`'s actual Display, which is what oracle interpolates.
		it("should include ENOENT when the edit target does not exist", async () => {
			const missingFile = join(testDir, "missing.txt");

			await expect(
				editTool.execute("test-call-6b", {
					path: missingFile,
					old_string: "hello",
					new_string: "world",
				}),
			).rejects.toThrow(`read ${missingFile}: No such file or directory (os error 2)`);
		});

		// pie: edit.rs:60-67
		it("should fail if text appears multiple times", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					old_string: "foo",
					new_string: "bar",
				}),
			).rejects.toThrow(
				`old_string matched 3 times in ${testFile}; pass replace_all=true to replace every occurrence, or include more surrounding context to make it unique`,
			);
		});

		it("should replace multiple disjoint regions in one call", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\n");

			const result = await editTool.execute("test-call-8", {
				path: testFile,
				edits: [
					{ oldText: "alpha\n", newText: "ALPHA\n" },
					{ oldText: "gamma\n", newText: "GAMMA\n" },
				],
			} as unknown as EditToolInput);

			expect(getTextOutput(result)).toContain("Successfully replaced 2 block(s)");
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
		});

		it("should collapse large unchanged gaps in multi-edit diffs", async () => {
			const testFile = join(testDir, "edit-multi-large-gap.txt");
			const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
			writeFileSync(testFile, `${lines.join("\n")}\n`);

			const result = await editTool.execute("test-call-8b", {
				path: testFile,
				edits: [
					{ oldText: "line 100\n", newText: "LINE 100\n" },
					{ oldText: "line 300\n", newText: "LINE 300\n" },
					{ oldText: "line 500\n", newText: "LINE 500\n" },
				],
			} as unknown as EditToolInput);

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("LINE 100");
			expect(diff).toContain("LINE 300");
			expect(diff).toContain("LINE 500");
			expect(diff).toContain("...");
			expect(diff).not.toContain("line 250");
			expect(diff.split("\n").length).toBeLessThan(50);
		});

		it("should match edits against the original file, not incrementally", async () => {
			const testFile = join(testDir, "edit-multi-original.txt");
			writeFileSync(testFile, "foo\nbar\nbaz\n");

			await editTool.execute("test-call-9", {
				path: testFile,
				edits: [
					{ oldText: "foo\n", newText: "foo bar\n" },
					{ oldText: "bar\n", newText: "BAR\n" },
				],
			} as unknown as EditToolInput);

			expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
		});

		it("should fail when edits is empty", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await expect(
				editTool.execute("test-call-11", {
					path: testFile,
					edits: [],
				} as unknown as EditToolInput),
			).rejects.toThrow(/edits must contain at least one replacement/);
		});

		it("should fail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			writeFileSync(testFile, "one\ntwo\nthree\n");

			await expect(
				editTool.execute("test-call-12", {
					path: testFile,
					edits: [
						{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
						{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
					],
				} as unknown as EditToolInput),
			).rejects.toThrow(/overlap/);
		});

		it("should not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-13", {
					path: testFile,
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "missing\n", newText: "MISSING\n" },
					],
				} as unknown as EditToolInput),
			).rejects.toThrow(/Could not find/);

			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});

		// pie: edit.rs:73-76 -- oracle has no access precheck; a read-only file reads fine and the
		// failure surfaces from the write as `write {path}: {e}`.
		it("should include EACCES for read-only files", async () => {
			const testFile = join(testDir, "edit-readonly.txt");
			writeFileSync(testFile, "hello\n");
			chmodSync(testFile, 0o444);

			await expect(
				editTool.execute("test-call-14", {
					path: testFile,
					old_string: "hello",
					new_string: "world",
				}),
				// Flipped from `Error code: EACCES` to `std::io::Error`'s Display, oracle's wording.
			).rejects.toThrow(`write ${testFile}: Permission denied (os error 13)`);
		});

		// pie: edit.rs:51-53 -- a non-errno read failure is stringified into `read {path}: {e}`.
		it("should include the original error message for unknown edit read errors", async () => {
			const genericFailureTool = createEditTool(testDir, {
				operations: {
					access: async () => {},
					readFile: async () => {
						throw new Error("disk offline");
					},
					writeFile: async () => {},
				},
			});

			await expect(
				genericFailureTool.execute("test-call-16", {
					path: "broken.txt",
					old_string: "hello",
					new_string: "world",
				}),
				// Flipped: was `String(error)` ("Error: disk offline"). A Rust `io::Error` that is not
				// an OS error Displays as its bare inner message, with no "Error: " prefix.
			).rejects.toThrow("read broken.txt: disk offline");
		});

		it("should include ENOENT in diff preview for missing files", async () => {
			const missingFile = join(testDir, "missing-preview.txt");
			const result = await computeEditsDiff(missingFile, [{ oldText: "hello", newText: "world" }], testDir);

			expect(result).toEqual({ error: `Could not edit file: ${missingFile}. Error code: ENOENT.` });
		});

		it("should include EACCES in diff preview for unreadable files", async () => {
			const unreadableFile = join(testDir, "unreadable-preview.txt");
			writeFileSync(unreadableFile, "hello\n");
			chmodSync(unreadableFile, 0o222);

			const result = await computeEditsDiff(unreadableFile, [{ oldText: "hello", newText: "world" }], testDir);

			expect(result).toEqual({ error: `Could not edit file: ${unreadableFile}. Error code: EACCES.` });
		});

		// pie: crates/coding-agent/src/tools/edit.rs:42-45,62-71 -- `replace_all: true` bypasses the
		// uniqueness requirement and rewrites every occurrence. This closes the TODO(port) that
		// previously documented the missing knob.
		it("replaces every occurrence when replace_all is true", async () => {
			const testFile = join(testDir, "edit-replace-all.txt");
			writeFileSync(testFile, "foo foo foo");

			const result = await editTool.execute("test-call-17", {
				path: testFile,
				old_string: "foo",
				new_string: "bar",
				replace_all: true,
			});

			expect(readFileSync(testFile, "utf-8")).toBe("bar bar bar");
			expect(getTextOutput(result)).toContain(`Edited ${testFile} (3 replacements).`);
			expect(result.details.replacements).toBe(3);
			expect(result.details.replaceAll).toBe(true);
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			// pie: crates/coding-agent/src/tools/bash.rs:90-108,113-117 -- oracle always echoes
			// `$ command`, appends `[exit N]`, and always populates details.{command,exitCode,
			// isError}, even on the plain success path (base pi previously left details
			// undefined here).
			expect(getTextOutput(result)).toMatch(/^\$ echo 'test output'\n/);
			expect(getTextOutput(result)).toContain("[exit 0]");
			expect(result.details).toMatchObject({ command: "echo 'test output'", exitCode: 0, isError: false });
		});

		it("should not throw on a non-zero exit code (isError:false at the wire)", async () => {
			// pie: crates/coding-agent/src/tools/bash.rs:64-120 + crates/agent/src/agent_loop.rs:
			// 813-820 -- bash's execute() only returns Err when the spawn itself fails; a
			// non-zero exit is a normal Ok() result, so the agent loop reports is_error:false at
			// the wire. The exit code is embedded as text ("[exit N]") and details.isError,
			// not surfaced as a thrown/protocol-level error.
			const result = await bashTool.execute("test-call-9", { command: "exit 1" });

			expect(getTextOutput(result)).toContain("[exit 1]");
			expect(result.details).toMatchObject({ command: "exit 1", exitCode: 1, isError: true });
		});

		it("should not throw on timeout; renders exit -1 with a timeout marker in stderr", async () => {
			// pie: crates/coding-agent/src/tools/bash.rs:254-258,268-272 (KillReason::TimedOut
			// -> stderr_suffix) -- timeout kills the process tree but is not a tool error.
			const result = await bashTool.execute("test-call-10", { command: "sleep 5", timeout: 1 });

			const text = getTextOutput(result);
			expect(text).toContain("[stderr]");
			expect(text).toContain("[timed out after 1s]");
			expect(text).toContain("[exit -1]");
			expect(result.details).toMatchObject({ command: "sleep 5", exitCode: -1, isError: true });
		});

		it("should not throw on abort; renders exit -1 with an aborted marker in stderr", async () => {
			// pie: crates/coding-agent/src/tools/bash.rs:254-258,268-272 (KillReason::Cancelled
			// -> stderr_suffix "[aborted]").
			const controller = new AbortController();
			const promise = bashTool.execute("test-call-abort", { command: "sleep 5" }, controller.signal);
			await new Promise((resolve) => setTimeout(resolve, 200));
			controller.abort();

			const result = await promise;
			const text = getTextOutput(result);
			expect(text).toContain("[stderr]");
			expect(text).toContain("[aborted]");
			expect(text).toContain("[exit -1]");
			expect(result.details).toMatchObject({ exitCode: -1, isError: true });
		});

		it("should separate stdout and stderr into labeled sections in call order", async () => {
			// pie: crates/coding-agent/src/tools/bash.rs:90-108 -- stdout is written first
			// (unlabeled), then a literal "[stderr]" line, then stderr -- regardless of the
			// real-time interleaving the two pipes arrived in.
			const result = await bashTool.execute("test-call-streams", {
				command: "echo out-line; echo err-line 1>&2",
			});
			const text = getTextOutput(result);

			expect(text).toBe("$ echo out-line; echo err-line 1>&2\nout-line\n[stderr]\nerr-line\n[exit 0]");
		});

		it("should include full output path for truncated timeout and abort outcomes", async () => {
			for (const testCase of [
				{ error: "timeout:5", expected: "[timed out after 5s]" },
				{ error: "aborted", expected: "[aborted]" },
			]) {
				const operations: BashOperations = {
					exec: async (_command, _cwd, { onData }) => {
						for (let i = 1; i <= 3000; i++) {
							onData(Buffer.from(`${i}\n`, "utf-8"), "stdout");
						}
						throw new Error(testCase.error);
					},
				};
				const bash = createBashTool(testDir, { operations });

				const result = await bash.execute(`test-call-${testCase.error}`, { command: "chatty-fail" });
				const text = getTextOutput(result);

				expect(text).toContain(testCase.expected);
				expect(text).toContain("[exit -1]");
				// totalLines is 3001, not 3000: the accumulated text ends with "\n", and
				// truncate.ts counts lines via String.split("\n"), which yields one trailing
				// empty element for a trailing newline.
				expect(text).toMatch(/\[truncated: kept \d+\/3001 lines, \d+ of \d+ bytes\]/);
				expect(text).toMatch(/\[Full stdout: /);
				expect(text).not.toContain("Full stdout: undefined");
				const fullOutputPath = text.match(/\[Full stdout: ([^\]\n]+)\]/)?.[1];
				expect(fullOutputPath).toBeDefined();
				expect(existsSync(fullOutputPath!)).toBe(true);
				const fullOutput = readFileSync(fullOutputPath!, "utf-8");
				expect(fullOutput).toContain("1\n2\n3");
				expect(fullOutput).toContain("2998\n2999\n3000");
			}
		});

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should handle process spawn errors", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(bashWithBadShell.execute("test-call-12", { command: "echo test" })).rejects.toThrow(/ENOENT/);
		});

		it("should pass shellPath through to shell resolution", async () => {
			const getShellConfigSpy = vi.spyOn(shellModule, "getShellConfig");
			const bashWithCustomShell = createBashTool(testDir, {
				shellPath: "/custom/bash",
				operations: {
					exec: async () => ({ exitCode: 0 }),
				},
			});

			await bashWithCustomShell.execute("test-call-12b", { command: "echo test" });

			expect(getShellConfigSpy).not.toHaveBeenCalled();

			const ops = createLocalBashOperations({ shellPath: "/custom/bash" });
			await expect(
				ops.exec("echo test", testDir, {
					onData: () => {},
				}),
			).rejects.toThrow("Custom shell path not found: /custom/bash");
			expect(getShellConfigSpy).toHaveBeenCalledWith("/custom/bash");
		});

		it("should prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", { command: "echo $TEST_VAR" });
			expect(getTextOutput(result)).toContain("hello");
		});

		it("should include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", { command: "echo command-output" });
			expect(getTextOutput(result)).toContain("prefix-output\ncommand-output");
		});

		it("should work without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", { command: "echo no-prefix" });
			expect(getTextOutput(result)).toContain("no-prefix");
		});

		it("should coalesce streaming updates for chatty output", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 0; i < 5000; i++) {
						onData(Buffer.from(`line ${i}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-chatty-updates", { command: "chatty" }, undefined, (update) =>
				updates.push(update),
			);

			expect(updates.length).toBeLessThan(25);
			expect(getTextOutput(result)).toContain("line 4999");
		});

		it("should decode UTF-8 characters split across output chunks", async () => {
			const euro = Buffer.from("€\n", "utf-8");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(euro.subarray(0, 1));
					onData(euro.subarray(1));
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-split-utf8", { command: "split-utf8" });

			expect(getTextOutput(result)).toContain("€");
		});

		it("should expose local bash operations for extension reuse", async () => {
			const ops = createLocalBashOperations();
			const chunks: Buffer[] = [];

			const result = await ops.exec("echo $TEST_LOCAL_BASH_OPS", testDir, {
				onData: (data) => chunks.push(data),
				env: { ...process.env, TEST_LOCAL_BASH_OPS: "from-local-ops" },
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
		});

		it("should preserve executeBash sanitization when using local bash operations", async () => {
			const result = await executeBashWithOperations(
				"printf '\\033[31mred\\033[0m\\r\\n'",
				process.cwd(),
				createLocalBashOperations(),
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("red\n");
		});

		it("should persist full output when truncation happens by line count only", async () => {
			// pie: crates/coding-agent/src/tools/bash.rs:79-89 -- oracle tail-truncates stdout
			// independently at DEFAULT_MAX_LINES/DEFAULT_MAX_BYTES; the temp-file spillover
			// below is additive pi UX (no oracle counterpart) layered after the oracle-shaped
			// text.
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-line-truncation", { command: "seq 3000" });
			const output = getTextOutput(result);
			const fullOutputPath = result.details?.stdoutFullOutputPath;

			expect(result.details?.stdoutTruncation?.truncated).toBe(true);
			expect(result.details?.stdoutTruncation?.truncatedBy).toBe("lines");
			expect(fullOutputPath).toBeDefined();
			// totalLines is 3001 (`seq 3000` output ends with "\n", which truncate.ts's
			// String.split("\n")-based counting counts as a trailing empty line).
			expect(output).toMatch(/\[truncated: kept \d+\/3001 lines, \d+ of \d+ bytes\]/);
			expect(output).toMatch(/\[Full stdout: /);
			expect(output).not.toContain("Full stdout: undefined");

			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});

		describe("oracle parity (crates/coding-agent/src/tools/bash.rs test suite, ported)", () => {
			// Each test below mirrors the corresponding #[tokio::test] in bash.rs. Sleep
			// durations are unique per test (matching oracle's convention) so pgrep checks
			// don't collide when tests run concurrently.

			it("kills the child process on timeout (timeout_kills_child_process)", async () => {
				const sleepSecs = "47383";
				const started = Date.now();
				const result = await bashTool.execute("t-timeout-kill", { command: `sleep ${sleepSecs}`, timeout: 1 });
				const elapsed = Date.now() - started;

				expect(elapsed).toBeLessThan(5000);
				const text = getTextOutput(result);
				expect(text).toContain("[timed out after 1s]");
				expect(text).toContain("[exit -1]");

				if (process.platform !== "win32") {
					await new Promise((resolve) => setTimeout(resolve, 200));
					const pgrep = spawnSync("pgrep", ["-f", `sleep ${sleepSecs}`], { encoding: "utf-8" });
					expect((pgrep.stdout ?? "").trim()).toBe("");
				}
			});

			it.skipIf(process.platform === "win32")(
				"kills descendant/background processes on timeout (timeout_kills_descendant_processes)",
				async () => {
					const marker = "bash-tool-desc-kill-marker-7f3a9c";
					const started = Date.now();
					await bashTool.execute("t-timeout-desc", {
						command: `(sleep 60 && echo ${marker}) & wait`,
						timeout: 1,
					});
					const elapsed = Date.now() - started;

					expect(elapsed).toBeLessThan(5000);
					await new Promise((resolve) => setTimeout(resolve, 200));
					const pgrep = spawnSync("pgrep", ["-f", marker], { encoding: "utf-8" });
					expect((pgrep.stdout ?? "").trim()).toBe("");
				},
			);

			it("kills the child process on cancellation (cancellation_kills_child_process)", async () => {
				const sleepSecs = "47384";
				const controller = new AbortController();
				setTimeout(() => controller.abort(), 200);

				const started = Date.now();
				const result = await bashTool.execute("t-cancel", { command: `sleep ${sleepSecs}` }, controller.signal);
				const elapsed = Date.now() - started;

				expect(elapsed).toBeLessThan(5000);
				const text = getTextOutput(result);
				expect(text).toContain("[aborted]");
				expect(text).toContain("[exit -1]");
			});

			it("does not deadlock on high-volume stderr (high_volume_stderr_does_not_deadlock_stdout)", async () => {
				const command = "yes hello | head -c 262144 ; yes world | head -c 262144 1>&2";
				const started = Date.now();
				const result = await bashTool.execute("t-high-volume", { command, timeout: 10 });
				const elapsed = Date.now() - started;

				expect(elapsed).toBeLessThan(8000);
				const text = getTextOutput(result);
				expect(text).toContain("[exit 0]");
				expect(text).toContain("[stderr]");
			});

			it("does not serialize concurrent invocations (concurrent_invocations_do_not_serialize)", async () => {
				const started = Date.now();
				await Promise.all(
					Array.from({ length: 4 }, (_, i) =>
						bashTool.execute(`t-concurrent-${i}`, { command: "sleep 0.3 && echo done" }),
					),
				);
				const elapsed = Date.now() - started;

				expect(elapsed).toBeLessThan(1500);
			});
		});

		it("executeBash should persist full output when truncation happens by line count only", async () => {
			const result = await executeBashWithOperations("seq 3000", process.cwd(), createLocalBashOperations());
			const fullOutputPath = result.fullOutputPath;

			expect(result.truncated).toBe(true);
			expect(fullOutputPath).toBeDefined();

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});
	});

	describe("grep tool", () => {
		it("should include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			// pie: crates/coding-agent/src/tools/grep.rs:127 (`format!("grep: {} hits\n", ...)`)
			expect(output).toMatch(/^grep: 1 hits\n/);
			expect(output).toContain("example.txt:2: match line");
		});

		it("should respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			writeFileSync(testFile, content);

			// pie: grep.rs:203-215 -- `context` is a pi-only knob with no oracle counterpart, so it
			// is no longer in the model-visible schema (see GrepExecuteInput). The execute path
			// still honours it for in-process callers, which is what this test exercises.
			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			} as GrepExecuteInput);

			const output = getTextOutput(result);
			expect(output).toMatch(/^grep: 1 hits\n/);
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});

		it("should treat flag-like patterns as search text", async () => {
			const marker = join(testDir, "grep-injection-marker");
			const payload = join(testDir, "payload.sh");
			const testFile = join(testDir, "target.txt");
			writeFileSync(payload, `#!/bin/sh\necho executed > ${marker}\ncat "$1"\n`);
			chmodSync(payload, 0o755);
			writeFileSync(testFile, "target\n");

			const result = await grepTool.execute("test-call-grep-injection", {
				pattern: `--pre=${payload}`,
				path: testDir,
			});

			// pie: crates/coding-agent/src/tools/grep.rs:127 -- oracle has no zero-match special
			// case; a zero-count run reads "grep: 0 hits".
			expect(getTextOutput(result)).toContain("grep: 0 hits");
			expect(existsSync(marker)).toBe(false);
		});

		it("should default the match limit to 200 (pie: grep.rs:16 DEFAULT_MAX_MATCHES)", () => {
			const definition = createGrepToolDefinition(testDir);
			expect(definition.description).toContain("limited to 200 matches");
		});
	});

	// pie: crates/coding-agent/src/tools/find.rs:44-48 -- the wire argument is `glob`, not pi's
	// `pattern`; oracle errors with "missing `glob`" when it is absent.
	describe("find tool", () => {
		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
				glob: "**/*.txt",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		it("should respect .gitignore", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");

			const result = await findTool.execute("test-call-14", {
				glob: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should surface fd glob parse errors", async () => {
			await expect(
				findTool.execute("test-call-15", {
					glob: "[",
					path: testDir,
				}),
			).rejects.toThrow(/error parsing glob|fd exited with code 1|fd error/i);
		});

		it("should treat flag-like patterns as search text", async () => {
			const result = await findTool.execute("test-call-find-flag-pattern", {
				glob: "--help",
				path: testDir,
			});

			// pie: crates/coding-agent/src/tools/find.rs:98-104 -- oracle has no zero-match
			// special case; a zero-count run reads "find <glob>: 0 hits".
			expect(getTextOutput(result)).toContain("find --help: 0 hits");
		});

		it("should include the oracle-style hits header and limit-reached trailer", async () => {
			// pie: crates/coding-agent/src/tools/find.rs:98-112
			for (let i = 0; i < 3; i++) {
				writeFileSync(join(testDir, `f${i}.rs`), "");
			}

			const normal = await findTool.execute("test-find-hits-header", { glob: "*.rs", path: testDir });
			expect(getTextOutput(normal)).toMatch(/^find \*\.rs: 3 hits\n/);

			const limited = await findTool.execute("test-find-hits-limited", {
				glob: "*.rs",
				path: testDir,
				limit: 2,
			});
			const limitedText = getTextOutput(limited);
			expect(limitedText).toMatch(/^find \*\.rs: showing first 2 hits \(limit reached\)\n/);
			expect(limitedText).toContain(
				"... results truncated; rerun with a narrower glob/path or a higher limit if needed",
			);
		});
	});

	describe("ls tool", () => {
		it("should list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});

		// pie: crates/coding-agent/src/tools/ls.rs:62 (`entries.sort_by(|a, b| a.0.cmp(&b.0))`) —
		// case-sensitive ordinal sort, not case-insensitive locale sort. Uppercase letters sort
		// before all lowercase letters (ASCII/UTF-16 code unit order).
		it("should sort case-sensitively, matching Rust's String::cmp ordinal order", async () => {
			writeFileSync(join(testDir, "Banana"), "");
			writeFileSync(join(testDir, "apple"), "");
			writeFileSync(join(testDir, "Cherry"), "");

			const result = await lsTool.execute("test-call-15b", { path: testDir });
			const output = getTextOutput(result);

			const bananaIdx = output.indexOf("Banana");
			const cherryIdx = output.indexOf("Cherry");
			const appleIdx = output.indexOf("apple");
			expect(bananaIdx).toBeGreaterThanOrEqual(0);
			expect(cherryIdx).toBeGreaterThanOrEqual(0);
			expect(appleIdx).toBeGreaterThanOrEqual(0);
			expect(bananaIdx).toBeLessThan(cherryIdx);
			expect(cherryIdx).toBeLessThan(appleIdx);
		});

		// pie: crates/coding-agent/src/tools/ls.rs:28-30 (`ToolExecutionMode::Parallel`)
		it("should be marked parallel-eligible", () => {
			expect(lsTool.executionMode).toBe("parallel");
		});
	});
});

// pie: crates/coding-agent/src/tools/edit.rs -- fuzzy matching has no oracle counterpart; it lives
// only on the pi-only `edits[]` in-process path (see EditExecuteInput / the TODO(port) at the top
// of edit.ts), which is why every call below is cast to BatchEditToolInput.
describe("edit tool fuzzy matching", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-fuzzy-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should match text with trailing whitespace stripped", async () => {
		const testFile = join(testDir, "trailing-ws.txt");
		// File has trailing spaces on lines
		writeFileSync(testFile, "line one   \nline two  \nline three\n");

		// oldText without trailing whitespace should still match
		const result = await editTool.execute("test-fuzzy-1", {
			path: testFile,
			edits: [{ oldText: "line one\nline two\n", newText: "replaced\n" }],
		} as unknown as EditToolInput);

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("replaced\nline three\n");
	});

	it("should match fullwidth punctuation in Chinese text", async () => {
		const testFile = join(testDir, "chinese-punctuation.txt");
		writeFileSync(testFile, "你好，世界\n你好（世界）\n");

		const result = await editTool.execute("test-fuzzy-chinese", {
			path: testFile,
			edits: [{ oldText: "你好,世界\n你好(世界)\n", newText: "你好，pi\n你好(pi)\n" }],
		} as unknown as EditToolInput);

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("你好，pi\n你好(pi)\n");
	});

	it("should match compatibility-equivalent Unicode forms", async () => {
		const testFile = join(testDir, "unicode-compatibility.txt");
		writeFileSync(testFile, "ＡＢＣ１２３\ncafe\u0301\n");

		const result = await editTool.execute("test-fuzzy-unicode", {
			path: testFile,
			edits: [{ oldText: "ABC123\ncafé\n", newText: "XYZ789\ncoffee\n" }],
		} as unknown as EditToolInput);

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("XYZ789\ncoffee\n");
	});

	it("should match smart single quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-quotes.txt");
		// File has smart/curly single quotes (U+2018, U+2019)
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\n");

		// oldText with ASCII quotes should match
		const result = await editTool.execute("test-fuzzy-2", {
			path: testFile,
			edits: [{ oldText: "console.log('hello');", newText: "console.log('world');" }],
		} as unknown as EditToolInput);

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("world");
	});

	it("should match smart double quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-double-quotes.txt");
		// File has smart/curly double quotes (U+201C, U+201D)
		writeFileSync(testFile, "const msg = \u201CHello World\u201D;\n");

		// oldText with ASCII quotes should match
		const result = await editTool.execute("test-fuzzy-3", {
			path: testFile,
			edits: [{ oldText: 'const msg = "Hello World";', newText: 'const msg = "Goodbye";' }],
		} as unknown as EditToolInput);

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("Goodbye");
	});

	it("should match Unicode dashes to ASCII hyphen", async () => {
		const testFile = join(testDir, "unicode-dashes.txt");
		// File has en-dash (U+2013) and em-dash (U+2014)
		writeFileSync(testFile, "range: 1\u20135\nbreak\u2014here\n");

		// oldText with ASCII hyphens should match
		const result = await editTool.execute("test-fuzzy-4", {
			path: testFile,
			edits: [{ oldText: "range: 1-5\nbreak-here", newText: "range: 10-50\nbreak--here" }],
		} as unknown as EditToolInput);

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("10-50");
	});

	it("should match non-breaking space to regular space", async () => {
		const testFile = join(testDir, "nbsp.txt");
		// File has non-breaking space (U+00A0)
		writeFileSync(testFile, "hello\u00A0world\n");

		// oldText with regular space should match
		const result = await editTool.execute("test-fuzzy-5", {
			path: testFile,
			edits: [{ oldText: "hello world", newText: "hello universe" }],
		} as unknown as EditToolInput);

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("universe");
	});

	it("should prefer exact match over fuzzy match", async () => {
		const testFile = join(testDir, "exact-preferred.txt");
		// File has both exact and fuzzy-matchable content
		writeFileSync(testFile, "const x = 'exact';\nconst y = 'other';\n");

		const result = await editTool.execute("test-fuzzy-6", {
			path: testFile,
			edits: [{ oldText: "const x = 'exact';", newText: "const x = 'changed';" }],
		} as unknown as EditToolInput);

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("const x = 'changed';\nconst y = 'other';\n");
	});

	it("should still fail when text is not found even with fuzzy matching", async () => {
		const testFile = join(testDir, "no-match.txt");
		writeFileSync(testFile, "completely different content\n");

		await expect(
			editTool.execute("test-fuzzy-7", {
				path: testFile,
				edits: [{ oldText: "this does not exist", newText: "replacement" }],
			} as unknown as EditToolInput),
		).rejects.toThrow(/Could not find the exact text/);
	});

	it("should detect duplicates after fuzzy normalization", async () => {
		const testFile = join(testDir, "fuzzy-dups.txt");
		// Two lines that are identical after trailing whitespace is stripped
		writeFileSync(testFile, "hello world   \nhello world\n");

		await expect(
			editTool.execute("test-fuzzy-8", {
				path: testFile,
				edits: [{ oldText: "hello world", newText: "replaced" }],
			} as unknown as EditToolInput),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("should support fuzzy matching in multi-edit mode", async () => {
		const testFile = join(testDir, "fuzzy-multi.txt");
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\nhello\u00A0world\n");

		await editTool.execute("test-fuzzy-9", {
			path: testFile,
			edits: [
				{ oldText: "console.log('hello');\n", newText: "console.log('world');\n" },
				{ oldText: "hello world\n", newText: "hello universe\n" },
			],
		} as unknown as EditToolInput);

		expect(readFileSync(testFile, "utf-8")).toBe("console.log('world');\nhello universe\n");
	});
});

describe("edit tool CRLF handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-crlf-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should match LF oldText against CRLF file content", async () => {
		const testFile = join(testDir, "crlf-test.txt");

		writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		const result = await editTool.execute("test-crlf-1", {
			path: testFile,
			edits: [{ oldText: "line two\n", newText: "replaced line\n" }],
		} as unknown as EditToolInput);

		expect(getTextOutput(result)).toContain("Successfully replaced");
	});

	it("should preserve CRLF line endings after edit", async () => {
		const testFile = join(testDir, "crlf-preserve.txt");
		writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-crlf-2", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		} as unknown as EditToolInput);

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve LF line endings for LF files", async () => {
		const testFile = join(testDir, "lf-preserve.txt");
		writeFileSync(testFile, "first\nsecond\nthird\n");

		await editTool.execute("test-lf-1", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		} as unknown as EditToolInput);

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\nREPLACED\nthird\n");
	});

	it("should detect duplicates across CRLF/LF variants", async () => {
		const testFile = join(testDir, "mixed-endings.txt");

		writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

		await expect(
			editTool.execute("test-crlf-dup", {
				path: testFile,
				edits: [{ oldText: "hello\nworld\n", newText: "replaced\n" }],
			} as unknown as EditToolInput),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("should preserve UTF-8 BOM after edit", async () => {
		const testFile = join(testDir, "bom-test.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-bom", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		} as unknown as EditToolInput);

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve CRLF line endings and BOM in multi-edit mode", async () => {
		const testFile = join(testDir, "bom-crlf-multi.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n");

		await editTool.execute("test-crlf-multi", {
			path: testFile,
			edits: [
				{ oldText: "second\n", newText: "SECOND\n" },
				{ oldText: "fourth\n", newText: "FOURTH\n" },
			],
		} as unknown as EditToolInput);

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nSECOND\r\nthird\r\nFOURTH\r\n");
	});
});
