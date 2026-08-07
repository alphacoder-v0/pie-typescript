import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HistoryStore } from "../src/history.ts";

// pie: crates/coding-agent/src/history.rs -- full port of the #[cfg(test)] module.

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pie-history-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// pie: history.rs:86-100 (append_persists_and_dedupes_adjacent)
describe("HistoryStore.append", () => {
	test("persists and dedupes adjacent entries", () => {
		const path = join(tempDir, "history");
		const h = HistoryStore.loadFrom(path);
		h.append("first");
		h.append("first"); // duplicate of immediate predecessor -- should not store
		h.append("second");
		h.append("third");
		expect(h.entries()).toEqual(["first", "second", "third"]);

		// Reload and verify on-disk state matches.
		const reloaded = HistoryStore.loadFrom(path);
		expect(reloaded.entries()).toEqual(["first", "second", "third"]);
	});

	test("does not dedupe non-adjacent repeats", () => {
		const path = join(tempDir, "history");
		const h = HistoryStore.loadFrom(path);
		h.append("first");
		h.append("second");
		h.append("first");
		expect(h.entries()).toEqual(["first", "second", "first"]);
	});

	// pie: history.rs:102-115 (cap_at_max_entries)
	test("caps at MAX_ENTRIES, dropping the oldest", () => {
		const path = join(tempDir, "history");
		const h = HistoryStore.loadFrom(path);
		const MAX_ENTRIES = 1000;
		for (let i = 0; i < MAX_ENTRIES + 50; i++) {
			h.append(`entry-${i}`);
		}
		expect(h.length).toBe(MAX_ENTRIES);
		expect(h.entries()[0]).toBe("entry-50");
		expect(h.entries()[h.entries().length - 1]).toBe(`entry-${MAX_ENTRIES + 49}`);
	});

	// pie: history.rs:117-126 (empty_and_whitespace_prompts_are_skipped)
	test("skips empty and whitespace-only prompts", () => {
		const path = join(tempDir, "history");
		const h = HistoryStore.loadFrom(path);
		h.append("");
		h.append("   ");
		h.append("\t\n");
		expect(h.isEmpty()).toBe(true);
	});

	test("trims surrounding whitespace before storing", () => {
		const path = join(tempDir, "history");
		const h = HistoryStore.loadFrom(path);
		h.append("  hello world  \n");
		expect(h.entries()).toEqual(["hello world"]);
	});
});

// pie: history.rs:128-133 (missing_file_loads_empty)
describe("HistoryStore.loadFrom", () => {
	test("missing file loads empty", () => {
		const h = HistoryStore.loadFrom(join(tempDir, "nope"));
		expect(h.isEmpty()).toBe(true);
		expect(h.length).toBe(0);
		expect(h.entries()).toEqual([]);
	});
});

// pie: history.rs:29-33 uses `str::lines()`, which splits on `\n` AND `\r\n`, stripping the `\r`.
describe("HistoryStore.loadFrom CRLF handling", () => {
	test("strips CR from a CRLF-written history file", () => {
		const path = join(tempDir, "history");
		writeFileSync(path, "hello\r\nworld\r\n");
		const h = HistoryStore.loadFrom(path);
		expect(h.entries()).toEqual(["hello", "world"]);
	});

	test("CRLF-loaded entries dedupe against a freshly appended repeat", () => {
		// With a stale `\r` the last entry would be "world\r", never equal to "world", so the
		// adjacent-dedupe in append() would silently break.
		const path = join(tempDir, "history");
		writeFileSync(path, "hello\r\nworld\r\n");
		const h = HistoryStore.loadFrom(path);
		h.append("world");
		expect(h.entries()).toEqual(["hello", "world"]);
	});

	test("CRLF input is rewritten LF-only by save()", () => {
		const path = join(tempDir, "history");
		writeFileSync(path, "hello\r\nworld\r\n");
		const h = HistoryStore.loadFrom(path);
		h.append("third");
		expect(readFileSync(path, "utf8")).toBe("hello\nworld\nthird\n");
	});

	test("mixed LF and CRLF terminators both split", () => {
		const path = join(tempDir, "history");
		writeFileSync(path, "a\nb\r\nc\n");
		expect(HistoryStore.loadFrom(path).entries()).toEqual(["a", "b", "c"]);
	});

	test("a lone CR is not a line terminator (matches Rust str::lines)", () => {
		const path = join(tempDir, "history");
		writeFileSync(path, "a\rb\n");
		expect(HistoryStore.loadFrom(path).entries()).toEqual(["a\rb"]);
	});
});

describe("HistoryStore.defaultPath / load", () => {
	test("defaultPath is <agentDir>/history", () => {
		expect(HistoryStore.defaultPath().endsWith("history")).toBe(true);
	});

	test("load() reads from defaultPath()", () => {
		// Smoke-test: load() must not throw even if ~/.pie/history doesn't exist in this
		// environment (missing file -> empty, per loadFrom's contract above).
		expect(() => HistoryStore.load()).not.toThrow();
	});
});

describe("HistoryStore.save", () => {
	test("creates parent directories on demand", () => {
		const path = join(tempDir, "nested", "dir", "history");
		const h = HistoryStore.loadFrom(path);
		h.append("hello");
		const reloaded = HistoryStore.loadFrom(path);
		expect(reloaded.entries()).toEqual(["hello"]);
	});

	test("entries() returns a defensive copy", () => {
		const path = join(tempDir, "history");
		const h = HistoryStore.loadFrom(path);
		h.append("one");
		const snapshot = h.entries() as string[];
		snapshot.push("mutated");
		expect(h.entries()).toEqual(["one"]);
	});
});
