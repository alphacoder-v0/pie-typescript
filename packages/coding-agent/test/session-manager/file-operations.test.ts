import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findMostRecentSession, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

/**
 * Capture the PORT-DIVERGENCE B8 salvage notice. It must go to **stderr**: stdout belongs to the
 * TUI renderer, and to the machine-read `--list-sessions` output.
 */
function captureStderr(): { notices: string[]; restore: () => void } {
	const notices: string[] = [];
	const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
		notices.push(String(chunk));
		return true;
	}) as typeof process.stderr.write);
	return { notices, restore: () => spy.mockRestore() };
}

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for malformed JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	// pie: crates/agent/src/harness/session/jsonl_storage.rs:97-118 -- PORT-DIVERGENCE B8
	// (RULEBOOK §5), fixed in phase 18. Oracle fails the *whole* load for any unparseable line, so
	// one truncated tail line makes `--resume`/`--continue` refuse an arbitrarily long healthy
	// conversation. Now: a bad **tail** line is dropped and the healthy prefix loads (with a notice
	// on stderr); a bad line **anywhere earlier** still fails the whole load. The tests below
	// assert the fix -- they previously asserted the defect.
	it("still throws when the corruption is mid-file, not on the tail", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		// Skipping a mid-file line would silently drop every entry after it.
		expect(() => loadEntriesFromFile(file)).toThrow(/^invalid entry: /);
		expect(() => loadEntriesFromFile(file)).toThrow(/line 2 of /);
		// The failure is actionable: it names real flags (cli/help.ts:122-129), not invented ones.
		expect(() => loadEntriesFromFile(file)).toThrow(/pie --list-sessions/);
		expect(() => loadEntriesFromFile(file)).toThrow(/pie --resume-id <ID>/);
	});

	it("salvages a healthy prefix followed by a truncated tail line (parity S8 shape)", () => {
		const file = join(tempDir, "bad-tail.jsonl");
		const healthyPrefix =
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n';
		writeFileSync(
			file,
			healthyPrefix +
				'{"type":"message","id":"2","parentId":"1","timestamp":"2025-01-01T00:00:02Z","message":{"role":"assistant","content":"partial reply that gets cut off mid',
		);

		const { notices, restore } = captureStderr();
		let entries: ReturnType<typeof loadEntriesFromFile>;
		try {
			entries = loadEntriesFromFile(file);
		} finally {
			restore();
		}

		expect(entries).toHaveLength(2);
		expect(entries[0]!.type).toBe("session");
		expect(entries[1]!.id).toBe("1");

		// Exactly one notice, on stderr, naming the session and what was discarded.
		expect(notices).toHaveLength(1);
		expect(notices[0]).toBe(
			`Warning: session abc: discarded a partial final entry (line 3 of ${file}) left by an interrupted write; kept 1 complete entry and truncated the file to that healthy prefix.\n`,
		);

		// loadEntriesFromFile is a pure read: repair belongs to the owning caller (setSessionFile).
		expect(readFileSync(file, "utf-8")).toContain("partial reply that gets cut off mid");
	});

	it("salvages silently when the caller opts out of the notice", () => {
		const file = join(tempDir, "quiet-tail.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n' +
				'{"type":"message","id":"2","parentId":"1","timestamp":"2025-01-01',
		);
		const { notices, restore } = captureStderr();
		try {
			expect(loadEntriesFromFile(file, { notify: false })).toHaveLength(2);
		} finally {
			restore();
		}
		expect(notices).toEqual([]);
	});

	it("refuses to salvage a truncated tail when the caller asked for strict validation", () => {
		// session-archive's commitImport validates a transcript it has *just written*: there a
		// truncated tail means the write itself was torn, and salvaging would commit a session
		// silently missing its last entry.
		const file = join(tempDir, "strict-tail.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n' +
				'{"type":"message","id":"2","parentId":"1","timestamp":"2025-01-01',
		);
		expect(() => loadEntriesFromFile(file, { salvageTruncatedTail: false })).toThrow(/^invalid entry: /);
	});

	it("salvages a complete-but-invalid final line too (position decides, not the parse error)", () => {
		// A torn write is not reliably distinguishable from a complete-but-invalid final record, the
		// blast radius is one trailing entry either way, and the notice reports both identically
		// rather than hiding either.
		const file = join(tempDir, "invalid-tail.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n' +
				"{not json at all}\n",
		);
		const { notices, restore } = captureStderr();
		try {
			expect(loadEntriesFromFile(file)).toHaveLength(2);
		} finally {
			restore();
		}
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("discarded a partial final entry (line 3");
	});

	it("keeps the pre-existing recovery for an empty file and for a lone partial line", () => {
		// Neither has a parseable header, so there is no healthy prefix and no session identity to
		// salvage around. Both stay on pi's pre-existing `[]` recovery (the caller starts fresh);
		// the header itself is never salvageable.
		const empty = join(tempDir, "empty-edge.jsonl");
		writeFileSync(empty, "");
		expect(loadEntriesFromFile(empty)).toEqual([]);

		const lone = join(tempDir, "lone-partial.jsonl");
		writeFileSync(lone, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:0');
		const { notices, restore } = captureStderr();
		try {
			expect(loadEntriesFromFile(lone)).toEqual([]);
		} finally {
			restore();
		}
		expect(notices).toEqual([]);
	});

	it("still loads a fully healthy file with no thrown error", () => {
		const file = join(tempDir, "healthy.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		expect(loadEntriesFromFile(file)).toHaveLength(2);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("truncates and rewrites empty file with valid header", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = SessionManager.open(emptyFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain a valid header, in oracle's on-disk shape:
		// pie: session.rs:194-219 `JsonlSessionMetadata` = {id, createdAt, cwd, path} with no `type`
		// tag and no `version` (jsonl_storage.rs:46-60 writes exactly that struct).
		const content = readFileSync(emptyFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.id).toBe(sm.getSessionId());
		expect(typeof header.createdAt).toBe("string");
		expect(header.cwd).toBe(sm.getCwd());
		expect(header.path).toBe(emptyFile);
		expect(header.type).toBeUndefined();
		expect(header.version).toBeUndefined();
	});

	it("truncates and rewrites file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		// File with messages but no session header (corrupted state)
		writeFileSync(
			noHeaderFile,
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n',
		);

		const sm = SessionManager.open(noHeaderFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain only a valid header (old content truncated), in oracle's on-disk
		// shape — see the previous test for the citation.
		const content = readFileSync(noHeaderFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.id).toBe(sm.getSessionId());
		expect(typeof header.createdAt).toBe("string");
		expect(header.cwd).toBe(sm.getCwd());
		expect(header.path).toBe(noHeaderFile);
		expect(header.type).toBeUndefined();
		expect(header.version).toBeUndefined();
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = SessionManager.open(explicitPath, tempDir);

		// The session file path should be preserved
		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("subsequent loads of recovered file work correctly", () => {
		const corruptedFile = join(tempDir, "corrupted.jsonl");
		writeFileSync(corruptedFile, "garbage content\n");

		// First open recovers the file
		const sm1 = SessionManager.open(corruptedFile, tempDir);
		const sessionId = sm1.getSessionId();

		// Second open should load the recovered file successfully
		const sm2 = SessionManager.open(corruptedFile, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});

	// pie: crates/coding-agent/src/session/mod.rs `resume()` + jsonl_storage.rs load_entries --
	// PORT-DIVERGENCE B8 at the call chain `--resume`/`--continue` actually runs. Oracle refuses a
	// healthy session outright because its last line is a torn append; here that one line is
	// dropped, the conversation opens, the transcript is repaired, and stderr says so exactly once.
	// (The "no valid header at all" recovery path above is a distinct, unrelated pi behavior --
	// left unchanged.)
	it("SessionManager.open salvages a healthy-prefix + corrupted-tail session and repairs the file", () => {
		const badTailFile = join(tempDir, "bad-tail.jsonl");
		// version 3 header: already current, so nothing but the salvage can trigger the rewrite.
		const healthyPrefix =
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n';
		writeFileSync(
			badTailFile,
			healthyPrefix +
				'{"type":"message","id":"2","parentId":"1","timestamp":"2025-01-01T00:00:02Z","message":{"role":"assistant","content":"cut off mid',
		);

		const { notices, restore } = captureStderr();
		let sm: SessionManager;
		try {
			sm = SessionManager.open(badTailFile, tempDir);
		} finally {
			restore();
		}

		// The healthy conversation survives.
		expect(sm.getSessionId()).toBe("abc");
		expect(sm.getEntries().map((e) => e.id)).toEqual(["1"]);
		expect(sm.getLeafId()).toBe("1");

		// Exactly one notice, despite `open` reading the file twice (header pre-read + the
		// constructor's setSessionFile). Only the owning load narrates.
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("Warning: session abc: discarded a partial final entry (line 3");

		// The torn line is gone from disk. Without that repair the next append would push it into
		// the *middle* of the file, and the session would then fail to load for good.
		const rewritten = readFileSync(badTailFile, "utf-8");
		expect(rewritten).not.toContain("cut off mid");
		const lines = rewritten.trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]!).id).toBe("1");

		// And the repaired file reopens cleanly and silently.
		const second = captureStderr();
		try {
			expect(
				SessionManager.open(badTailFile, tempDir)
					.getEntries()
					.map((e) => e.id),
			).toEqual(["1"]);
		} finally {
			second.restore();
		}
		expect(second.notices).toEqual([]);
	});

	it("SessionManager.open still refuses a session corrupted mid-file, leaving the file untouched", () => {
		const midFile = join(tempDir, "mid-corrupt.jsonl");
		const original =
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n' +
			"{cut off mid\n" +
			'{"type":"message","id":"3","parentId":"1","timestamp":"2025-01-01T00:00:03Z","message":{"role":"user","content":"later","timestamp":3}}\n';
		writeFileSync(midFile, original);

		expect(() => SessionManager.open(midFile, tempDir)).toThrow(/^invalid entry: /);
		expect(() => SessionManager.open(midFile, tempDir)).toThrow(/pie --list-sessions/);
		// No silent truncate-and-recover on a failed load.
		expect(readFileSync(midFile, "utf-8")).toBe(original);
	});
});
