/**
 * char-tests port of oracle `crates/agent/tests/session_storage.rs` (pie @0a120dfd).
 *
 * End-to-end session storage. Exercises both the memory and jsonl backends through the
 * `SessionStorage` surface.
 *
 * API-shape note (not a behavior divergence): oracle's `JsonlSessionRepo::new(dir)` takes a bare
 * root path and `create(cwd: &str)` takes cwd directly. TS's `JsonlSessionRepo` requires an
 * explicit `{ fs, sessionsRoot }` (a `FileSystem` implementation, `NodeExecutionEnv` here) and
 * `create({ cwd, id })` — see `test/harness/repo.test.ts` for the established pattern. `list()`
 * returns `JsonlSessionMetadata[]` (not raw file paths) and `open()` takes that metadata, not a
 * `PathBuf` — adapted 1:1 below, same observable behavior.
 */
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl-repo.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { buildSessionContext, Session } from "../../src/harness/session/session.ts";
import type { AgentMessage } from "../../src/types.ts";
import { createTempDir } from "../harness/session-test-utils.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

describe("session_storage (char-tests port)", () => {
	it("memory_session_roundtrips_messages", async () => {
		const session = new Session(new InMemorySessionStorage());

		const id1 = await session.appendMessage(userMessage("first"));
		const id2 = await session.appendMessage(userMessage("second"));
		expect(id1).not.toBe(id2);

		const leaf = await session.getLeafId();
		expect(leaf).toBe(id2);

		const entries = await session.getEntries();
		expect(entries).toHaveLength(2);

		const branch = await session.getBranch();
		expect(branch).toHaveLength(2);
		expect(branch[0]?.id).toBe(id1);

		const ctx = buildSessionContext(branch);
		expect(ctx.messages).toHaveLength(2);
	});

	it("jsonl_session_persists_across_open", async () => {
		const root = createTempDir();
		const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });

		const session = await repo.create({ cwd: "/some/cwd" });
		await session.appendMessage(userMessage("hello"));
		const leaf = await session.getLeafId();
		expect(leaf).not.toBeNull();

		// Re-open the file and verify the message is still there.
		const files = await repo.list();
		expect(files).toHaveLength(1);
		const reopened = await repo.open(files[0]!);
		const entries = await reopened.getEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.id).toBe(leaf);
	});

	it("jsonl_metadata_id_matches_session_file_stem", async () => {
		const root = createTempDir();
		const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });

		const session = await repo.create({ cwd: "/some/cwd" });
		const files = await repo.list();
		const stem = basename(files[0]!.path, ".jsonl");
		const meta = await session.getMetadata();

		expect(meta.id).toBe(stem);
	});

	it("jsonl_explicit_leaf_moves_are_overridden_by_new_entries", async () => {
		const root = createTempDir();
		const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });

		const session = await repo.create({ cwd: "/some/cwd" });
		const idA = await session.appendMessage(userMessage("a"));
		await session.appendMessage(userMessage("b"));

		await session.moveTo(idA);
		const idC = await session.appendMessage(userMessage("c"));

		const files = await repo.list();
		const reopened = await repo.open(files[0]!);
		expect(await reopened.getLeafId()).toBe(idC);

		const branch = await reopened.getBranch();
		const ids = branch.map((entry) => entry.id);
		expect(ids).toEqual([idA, idC]);
	});

	it("jsonl_can_move_leaf_to_root", async () => {
		const root = createTempDir();
		const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });

		const session = await repo.create({ cwd: "/some/cwd" });
		await session.appendMessage(userMessage("a"));
		await session.moveTo(null);

		const files = await repo.list();
		const reopened = await repo.open(files[0]!);
		expect(await reopened.getLeafId()).toBeNull();
		expect(await reopened.getBranch()).toEqual([]);
	});

	it("branch_walks_parent_chain_in_root_to_leaf_order", async () => {
		const session = new Session(new InMemorySessionStorage());
		const idA = await session.appendMessage(userMessage("a"));
		const idB = await session.appendMessage(userMessage("b"));
		const idC = await session.appendMessage(userMessage("c"));

		const branch = await session.getBranch();
		const ids = branch.map((entry) => entry.id);
		expect(ids).toEqual([idA, idB, idC]);
	});

	it("compaction_summary_replaces_history_up_to_first_kept", async () => {
		const session = new Session(new InMemorySessionStorage());
		await session.appendMessage(userMessage("dropped"));
		const firstKept = await session.appendMessage(userMessage("kept"));
		await session.appendCompaction("summary text", firstKept, 100, undefined, false);
		await session.appendMessage(userMessage("after"));

		const ctx = await session.buildContext();
		// First message is the compaction summary, then the kept message, then "after".
		expect(ctx.messages).toHaveLength(3);
		const first = ctx.messages[0];
		if (first?.role !== "compactionSummary") throw new Error("expected compactionSummary custom message");
		expect(first.role).toBe("compactionSummary");
	});
});
