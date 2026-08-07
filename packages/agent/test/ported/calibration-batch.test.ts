import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import { createAssistantMessage, createUserMessage } from "../harness/session-test-utils.ts";

/**
 * phase 22 calibration batch (phase 3) — the `new-test` verdicts on the agent side.
 *
 * The same origin as its coding-agent counterpart: these functions are listed in
 * `migration/reviews/phase22/roster.tsv`, where `check:surface-coverage` finds a counterpart of the
 * same name but no assertion has ever touched the behavior.
 */
describe("phase 22 calibration batch — agent", () => {
	// ── agent/src/harness/session/session.rs::leaf_id@386 ──────────────────────
	//
	// Upstream's `leaf_id` returns the id of the current branch's leaf entry; both `get_branch` and
	// `build_context` start from it. Three observable behaviors: null on an empty session, pointing at
	// the newest entry after an append, and **following along** as more are appended.
	//
	// Getting it wrong fails silently: `buildContext` walks back from the wrong leaf, and the history
	// the model receives is short a few entries, or crosses into another branch. Nothing raises; the
	// model merely "forgets", or misremembers.
	describe("Session.getLeafId (oracle leaf_id)", () => {
		it("is null on an empty session", async () => {
			const session = new Session(new InMemorySessionStorage());

			expect(await session.getLeafId()).toBeNull();
		});

		it("points at the most recently appended entry", async () => {
			// `appendMessage` returns the new entry's id (session.ts:136, `Promise<string>`).
			const session = new Session(new InMemorySessionStorage());
			const firstId = await session.appendMessage(createUserMessage("one"));

			expect(await session.getLeafId()).toBe(firstId);
		});

		it("follows subsequent appends — the leaf moves, it is not pinned to the first entry", async () => {
			const session = new Session(new InMemorySessionStorage());
			const firstId = await session.appendMessage(createUserMessage("one"));
			const secondId = await session.appendMessage(createAssistantMessage("two"));

			const leaf = await session.getLeafId();
			expect(leaf).toBe(secondId);
			expect(leaf).not.toBe(firstId);
		});
	});

	// ── agent/src/harness/env/native.rs::new@27 ────────────────────────────────
	//
	// Upstream's `NativeEnv::new(cwd)` remembers the cwd, and every later path operation is relative
	// to it. Here that is `new NodeExecutionEnv({ cwd })`.
	//
	// The constructor is thin, but it fixes the **anchor for relative path resolution**. Anchor it
	// wrong and the tools read and write files outside the project. That is why it was pulled in by
	// rule B despite sitting in the `low` tier with a fan-in below 2: upstream wrote it an inline test
	// of its own.
	describe("NodeExecutionEnv constructor (oracle NativeEnv::new)", () => {
		it("keeps the cwd it was constructed with", () => {
			const dir = mkdtempSync(join(tmpdir(), "pie-nodeenv-"));
			try {
				const env = new NodeExecutionEnv({ cwd: dir });

				expect(env.cwd).toBe(dir);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("resolves relative paths against that cwd, not against process.cwd()", async () => {
			// This is the constructor's real observable consequence: a wrong anchor has the tools reading
			// and writing outside the project.
			const dir = mkdtempSync(join(tmpdir(), "pie-nodeenv-"));
			try {
				writeFileSync(join(dir, "marker.txt"), "x");
				const env = new NodeExecutionEnv({ cwd: dir });

				const resolved = await env.absolutePath("marker.txt");
				expect(resolved.ok && resolved.value).toBe(join(dir, "marker.txt"));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
