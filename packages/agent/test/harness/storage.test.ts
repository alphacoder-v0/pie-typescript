import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "../../src/harness/session/jsonl-storage.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { type MessageEntry, ok, type SessionMetadata } from "../../src/harness/types.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("InMemorySessionStorage", () => {
	it("returns configured session metadata", async () => {
		const metadata: SessionMetadata = { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" };
		const storage = new InMemorySessionStorage({ metadata });
		expect(await storage.getMetadata()).toEqual(metadata);
	});

	// pie: crates/agent/src/harness/session/memory_storage.rs:64-67 (set_leaf_id) — the oracle's
	// in-memory backend is a bare field assignment, unlike JsonlSessionStorage's append-only
	// `leaf` marker entry (jsonl-storage.ts setLeafId): no `leaf` entry is ever recorded.
	it("copies initial entries and updates the leaf pointer without recording a leaf entry", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const initialEntries = [entry];
		const storage = new InMemorySessionStorage({ entries: initialEntries });
		initialEntries.push({ ...entry, id: "entry-2" });
		expect((await storage.getEntries()).map((storedEntry) => storedEntry.id)).toEqual(["entry-1"]);
		expect(await storage.getLeafId()).toBe("entry-1");
		await storage.setLeafId(null);
		expect(await storage.getLeafId()).toBeNull();
		// No `leaf` entry appended — the entry table is unchanged from before the setLeafId call.
		expect((await storage.getEntries()).map((storedEntry) => storedEntry.id)).toEqual(["entry-1"]);
	});

	// pie: crates/agent/src/harness/session/memory_storage.rs:60-67 (get_leaf_id / set_leaf_id) —
	// neither method validates that the id corresponds to a known entry, unlike
	// JsonlSessionStorage (jsonl-storage.ts) which still throws `not_found`/`invalid_session`.
	// Bug-for-bug: a caller can point the in-memory leaf at an id that does not exist.
	it("allows setting a leaf id that has no matching entry (oracle does not validate)", async () => {
		const storage = new InMemorySessionStorage();
		await storage.setLeafId("missing");
		await expect(storage.getLeafId()).resolves.toBe("missing");
	});

	// pie: crates/agent/src/harness/session/memory_storage.rs:73-78 (append_entry) — the leaf
	// pointer always becomes the appended entry's own id, even for a `leaf`-typed entry (unlike
	// JsonlSessionStorage's leaf-type-aware replay via leafIdAfterEntry).
	it("moves the leaf pointer to a directly appended leaf entry's own id, not its targetId", async () => {
		const storage = new InMemorySessionStorage();
		await storage.appendEntry({
			type: "leaf",
			id: "leaf-entry-id",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			targetId: "some-other-id",
		});
		await expect(storage.getLeafId()).resolves.toBe("leaf-entry-id");
	});

	// pie: crates/agent/src/harness/session/memory_storage.rs:88-117 (get_path_to_root) — cycle
	// detection guards against an infinite loop on a corrupted parent chain (mirrors the same
	// fix already applied to jsonl-storage.ts's getPathToRoot).
	it("throws instead of looping forever on a cyclic parent chain", async () => {
		const a: MessageEntry = {
			type: "message",
			id: "a",
			parentId: "b",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("a"),
		};
		const b: MessageEntry = {
			type: "message",
			id: "b",
			parentId: "a",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: createAssistantMessage("b"),
		};
		const storage = new InMemorySessionStorage({ entries: [b, a] });
		await expect(storage.getPathToRoot("a")).rejects.toThrow("cycle in parent chain at a");
	});

	it("finds entries by type", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const storage = new InMemorySessionStorage({ entries: [entry] });
		expect((await storage.findEntries("message")).map((found) => found.id)).toEqual(["entry-1"]);
		expect(await storage.findEntries("session_info")).toEqual([]);
	});

	it("maintains label lookup", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const storage = new InMemorySessionStorage({ entries: [entry] });
		expect(await storage.getLabel("entry-1")).toBeUndefined();
		await storage.appendEntry({
			type: "label",
			id: "label-1",
			parentId: "entry-1",
			timestamp: "2026-01-01T00:00:01.000Z",
			targetId: "entry-1",
			label: "checkpoint",
		});
		expect(await storage.getLabel("entry-1")).toBe("checkpoint");
		await storage.appendEntry({
			type: "label",
			id: "label-2",
			parentId: "label-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			targetId: "entry-1",
			label: undefined,
		});
		expect(await storage.getLabel("entry-1")).toBeUndefined();
	});

	it("walks paths to root", async () => {
		const root: MessageEntry = {
			type: "message",
			id: "root",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("root"),
		};
		const child: MessageEntry = {
			...root,
			id: "child",
			parentId: "root",
			message: createAssistantMessage("child"),
		};
		const storage = new InMemorySessionStorage({ entries: [root, child] });
		expect((await storage.getPathToRoot("child")).map((entry) => entry.id)).toEqual(["root", "child"]);
		expect(await storage.getPathToRoot(null)).toEqual([]);
	});
});

describe("JsonlSessionStorage", () => {
	it("throws for missing files when opening", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({ code: "not_found" });
	});

	it("writes the header on create", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		expect(existsSync(filePath)).toBe(true);
		expect(readFileSync(filePath, "utf8").trim().split("\n")).toHaveLength(1);
		expect(await storage.getLeafId()).toBeNull();
		expect(await storage.getEntries()).toEqual([]);
		await storage.appendEntry({
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		const lines = readFileSync(filePath, "utf8").trim().split("\n");
		expect(JSON.parse(lines[0]!).type).toBe("session");
		expect(JSON.parse(lines[1]!).id).toBe("user-1");
		expect(lines).toHaveLength(2);
	});

	it("throws for malformed session headers", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		writeFileSync(filePath, "not json\n");
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toThrow("first line is not a valid session header");
	});

	it("throws for malformed entry lines", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		};
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		writeFileSync(filePath, `${JSON.stringify(header)}\nnot json\n${JSON.stringify(entry)}\n`);
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({ code: "invalid_entry" });
	});

	// PORT-DIVERGENCE B8 — pie: crates/agent/src/harness/session/jsonl_storage.rs:97-118
	// (load_entries). Oracle fails the *whole* load for a healthy prefix + one truncated tail line,
	// throwing away an arbitrarily long healthy conversation over the last partial write. Fixed in
	// phase 18: the trailing partial line is dropped, the healthy prefix loads, the file is
	// repaired, and stderr says so. These tests assert the fix, not the defect.
	describe("PORT-DIVERGENCE B8 — a truncated tail line no longer sinks the whole session", () => {
		const makeHeader = (dir: string) => ({
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		});
		const entryOne: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		// A process crash mid-write: the last line is a byte-truncated JSON fragment, not a
		// well-formed (even if semantically wrong) entry.
		const truncatedTail = JSON.stringify({
			type: "message",
			id: "entry-2",
			parentId: "entry-1",
			timestamp: "2026-01-01T00:00:01.000Z",
		}).slice(0, -10);

		function captureStderr(): { notices: string[]; restore: () => void } {
			const notices: string[] = [];
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
				notices.push(String(chunk));
				return true;
			}) as typeof process.stderr.write);
			return { notices, restore: () => spy.mockRestore() };
		}

		it("salvages the healthy prefix, repairs the file, and notifies on stderr exactly once", async () => {
			const dir = createTempDir();
			const env = new NodeExecutionEnv({ cwd: dir });
			const filePath = join(dir, "session.jsonl");
			const healthyPrefix = `${JSON.stringify(makeHeader(dir))}\n${JSON.stringify(entryOne)}\n`;
			writeFileSync(filePath, `${healthyPrefix}${truncatedTail}`);

			const { notices, restore } = captureStderr();
			let storage: JsonlSessionStorage;
			try {
				storage = await JsonlSessionStorage.open(env, filePath);
			} finally {
				restore();
			}

			// The healthy prefix survives, and the leaf still points at the last complete entry.
			expect(await storage.getEntries()).toEqual([entryOne]);
			expect(await storage.getLeafId()).toBe("entry-1");
			expect(await storage.getMetadata()).toMatchObject({ id: "session-1" });

			// Exactly one notice, on stderr, naming the session and saying what was discarded.
			expect(notices).toHaveLength(1);
			expect(notices[0]).toBe(
				`Warning: session session-1: discarded a partial final entry (line 3 of ${filePath}) left by an interrupted write; kept 1 complete entry and truncated the file to that healthy prefix.\n`,
			);

			// The torn line is gone from disk: without that repair the next append would push it
			// into the middle of the file and the session would become permanently unloadable.
			expect(readFileSync(filePath, "utf8")).toBe(healthyPrefix);
			await storage.appendEntry({
				type: "message",
				id: "entry-3",
				parentId: "entry-1",
				timestamp: "2026-01-01T00:00:02.000Z",
				message: createUserMessage("after salvage"),
			});
			const reopened = await JsonlSessionStorage.open(env, filePath);
			expect((await reopened.getEntries()).map((entry) => entry.id)).toEqual(["entry-1", "entry-3"]);

			// --list-sessions (header-only metadata read) stays healthy throughout.
			await expect(loadJsonlSessionMetadata(env, filePath)).resolves.toMatchObject({ id: "session-1" });
		});

		it("still fails the whole load when the corruption is mid-file, not on the tail", async () => {
			const dir = createTempDir();
			const env = new NodeExecutionEnv({ cwd: dir });
			const filePath = join(dir, "session.jsonl");
			const tailEntry: MessageEntry = { ...entryOne, id: "entry-9", parentId: "entry-1" };
			const original = `${JSON.stringify(makeHeader(dir))}\n${JSON.stringify(entryOne)}\n${truncatedTail}\n${JSON.stringify(tailEntry)}\n`;
			writeFileSync(filePath, original);

			// Skipping a mid-file line would silently drop every entry after it -- a different fault
			// from a torn append, and still a hard failure.
			await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({ code: "invalid_entry" });
			// ... and the failure now tells the user what to do instead.
			await expect(JsonlSessionStorage.open(env, filePath)).rejects.toThrow(/pie --list-sessions/);
			await expect(JsonlSessionStorage.open(env, filePath)).rejects.toThrow(/pie --resume-id <ID>/);
			// No repair on a failed load: the file is left exactly as found.
			expect(readFileSync(filePath, "utf8")).toBe(original);
		});

		it("fails an empty file and a lone partial line: neither has a header to salvage around", async () => {
			const dir = createTempDir();
			const env = new NodeExecutionEnv({ cwd: dir });

			const emptyPath = join(dir, "empty.jsonl");
			writeFileSync(emptyPath, "");
			await expect(JsonlSessionStorage.open(env, emptyPath)).rejects.toMatchObject({ code: "invalid_session" });
			await expect(JsonlSessionStorage.open(env, emptyPath)).rejects.toThrow(/missing session header/);

			// A file that is a single partial line: that line IS the header, and the header is never
			// salvageable -- dropping it would leave a session with no id and no cwd.
			const lonePath = join(dir, "lone.jsonl");
			const partialHeader = JSON.stringify(makeHeader(dir)).slice(0, -12);
			writeFileSync(lonePath, partialHeader);
			await expect(JsonlSessionStorage.open(env, lonePath)).rejects.toThrow(
				/first line is not a valid session header/,
			);
			await expect(JsonlSessionStorage.open(env, lonePath)).rejects.toThrow(/pie --list-sessions/);
			expect(readFileSync(lonePath, "utf8")).toBe(partialHeader);
		});

		it("salvages a complete-but-invalid final line too (position decides, not the parse error)", async () => {
			const dir = createTempDir();
			const env = new NodeExecutionEnv({ cwd: dir });
			const filePath = join(dir, "session.jsonl");
			const healthyPrefix = `${JSON.stringify(makeHeader(dir))}\n${JSON.stringify(entryOne)}\n`;
			// Syntactically valid JSON, but not a valid entry (no id, no timestamp). A torn write is
			// not reliably distinguishable from this, the blast radius is one trailing entry either
			// way, and the notice reports it identically rather than hiding it.
			writeFileSync(filePath, `${healthyPrefix}{"type":"message"}\n`);

			const { notices, restore } = captureStderr();
			try {
				const storage = await JsonlSessionStorage.open(env, filePath);
				expect(await storage.getEntries()).toEqual([entryOne]);
			} finally {
				restore();
			}
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("discarded a partial final entry (line 3");
			expect(readFileSync(filePath, "utf8")).toBe(healthyPrefix);
		});

		it("loads a fully healthy file untouched and silently", async () => {
			const dir = createTempDir();
			const env = new NodeExecutionEnv({ cwd: dir });
			const filePath = join(dir, "session.jsonl");
			const original = `${JSON.stringify(makeHeader(dir))}\n${JSON.stringify(entryOne)}\n`;
			writeFileSync(filePath, original);

			const { notices, restore } = captureStderr();
			try {
				const storage = await JsonlSessionStorage.open(env, filePath);
				expect(await storage.getEntries()).toEqual([entryOne]);
			} finally {
				restore();
			}
			expect(notices).toEqual([]);
			expect(readFileSync(filePath, "utf8")).toBe(original);
		});
	});

	it("creates and reads session metadata from the header", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, {
			cwd: dir,
			sessionId: "session-1",
			parentSessionPath: "/tmp/parent.jsonl",
		});
		const metadata = await storage.getMetadata();
		expect(metadata).toMatchObject({
			id: "session-1",
			cwd: dir,
			path: filePath,
			parentSessionPath: "/tmp/parent.jsonl",
		});
		await storage.appendEntry({
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		expect(await loadJsonlSessionMetadata(env, filePath)).toEqual(metadata);
	});

	it("loads existing entries and reconstructs leaf", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		const root: MessageEntry = {
			type: "message",
			id: "root",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("root"),
		};
		const child: MessageEntry = {
			...root,
			id: "child",
			parentId: "root",
			message: createAssistantMessage("child"),
		};
		await storage.appendEntry(root);
		await storage.appendEntry(child);
		const loaded = await JsonlSessionStorage.open(env, filePath);
		expect(await loaded.getLeafId()).toBe("child");
		expect((await loaded.getEntries()).map((entry) => entry.id)).toEqual(["root", "child"]);
		await loaded.setLeafId("root");
		const reloaded = await JsonlSessionStorage.open(env, filePath);
		expect(await reloaded.getLeafId()).toBe("root");
		expect((await reloaded.getEntries()).at(-1)).toMatchObject({ type: "leaf", targetId: "root" });
		expect((await loaded.getPathToRoot("child")).map((entry) => entry.id)).toEqual(["root", "child"]);
	});

	it("finds entries by type", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		await storage.appendEntry({
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		expect((await storage.findEntries("message")).map((found) => found.id)).toEqual(["entry-1"]);
		expect(await storage.findEntries("session_info")).toEqual([]);
	});

	it("maintains label lookup", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		await storage.appendEntry({
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		expect(await storage.getLabel("entry-1")).toBeUndefined();
		await storage.appendEntry({
			type: "label",
			id: "label-1",
			parentId: "entry-1",
			timestamp: "2026-01-01T00:00:01.000Z",
			targetId: "entry-1",
			label: "checkpoint",
		});
		expect(await storage.getLabel("entry-1")).toBe("checkpoint");
		await storage.appendEntry({
			type: "label",
			id: "label-2",
			parentId: "label-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			targetId: "entry-1",
			label: undefined,
		});
		expect(await storage.getLabel("entry-1")).toBeUndefined();
		const loaded = await JsonlSessionStorage.open(env, filePath);
		expect(await loaded.getLabel("entry-1")).toBeUndefined();
	});

	it("reads session metadata through the line-reading filesystem operation", async () => {
		const dir = createTempDir();
		const filePath = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		};
		const metadata = await loadJsonlSessionMetadata(
			{
				readTextLines: async () => ok([JSON.stringify(header)]),
				readTextFile: async () => {
					throw new Error("readTextFile should not be called for metadata");
				},
				writeFile: async () => ok(undefined),
				appendFile: async () => ok(undefined),
			},
			filePath,
		);
		expect(metadata).toEqual({
			id: "session-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			cwd: dir,
			path: filePath,
			parentSessionPath: undefined,
		});
	});
});
