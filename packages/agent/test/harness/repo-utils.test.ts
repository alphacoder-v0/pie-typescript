import { describe, expect, it } from "vitest";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { getEntriesToFork } from "../../src/harness/session/repo-utils.ts";
import type { MessageEntry } from "../../src/harness/types.ts";
import { createAssistantMessage, createUserMessage } from "./session-test-utils.ts";

// pie: crates/agent/src/harness/session/repo_utils.rs:38-68 (get_entries_to_fork). Oracle's own
// call site is dead code (ForkOptions/get_entries_to_fork are exported from crates/agent/src/
// lib.rs but never wired into JsonlSessionRepo/MemorySessionRepo or any CLI path -- confirmed by
// the prior "session" unit's ledger row), but base's JsonlSessionRepo.fork()/InMemorySessionRepo.
// fork() DO actively call getEntriesToFork (repo.test.ts covers those integration paths), so this
// function's algorithm is still live spec for base even though it is unreachable in the oracle.
describe("getEntriesToFork", () => {
	function buildStorage(): InMemorySessionStorage {
		const root: MessageEntry = {
			type: "message",
			id: "root",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("root"),
		};
		const child: MessageEntry = {
			type: "message",
			id: "child",
			parentId: "root",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: createAssistantMessage("child"),
		};
		const user2: MessageEntry = {
			type: "message",
			id: "user2",
			parentId: "child",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: createUserMessage("user2"),
		};
		return new InMemorySessionStorage({ entries: [root, child, user2] });
	}

	it("returns all entries when no entryId is given", async () => {
		const storage = buildStorage();
		const entries = await getEntriesToFork(storage, {});
		expect(entries.map((entry) => entry.id)).toEqual(["root", "child", "user2"]);
	});

	// pie: repo_utils.rs:45-49 -- NotFound code (not TS-only "invalid_fork_target").
	it("throws not_found when the target entry does not exist", async () => {
		const storage = buildStorage();
		await expect(getEntriesToFork(storage, { entryId: "missing" })).rejects.toMatchObject({
			code: "not_found",
			message: "Entry missing not found",
		});
	});

	// pie: repo_utils.rs:59-64 -- same NotFound code for the wrong-type case.
	it("throws not_found when the target is not a user message (default 'before' position)", async () => {
		const storage = buildStorage();
		await expect(getEntriesToFork(storage, { entryId: "child" })).rejects.toMatchObject({
			code: "not_found",
			message: "Entry child is not a user message",
		});
	});

	it("splits before a user message by default", async () => {
		const storage = buildStorage();
		const entries = await getEntriesToFork(storage, { entryId: "user2" });
		expect(entries.map((entry) => entry.id)).toEqual(["root", "child"]);
	});

	it("splits before a user message when position is explicitly 'before'", async () => {
		const storage = buildStorage();
		const entries = await getEntriesToFork(storage, { entryId: "user2", position: "before" });
		expect(entries.map((entry) => entry.id)).toEqual(["root", "child"]);
	});

	it("splits at a specific entry (inclusive) when position is 'at'", async () => {
		const storage = buildStorage();
		const entries = await getEntriesToFork(storage, { entryId: "user2", position: "at" });
		expect(entries.map((entry) => entry.id)).toEqual(["root", "child", "user2"]);
	});

	it("'at' position works for non-user-message entries too", async () => {
		const storage = buildStorage();
		const entries = await getEntriesToFork(storage, { entryId: "child", position: "at" });
		expect(entries.map((entry) => entry.id)).toEqual(["root", "child"]);
	});
});
