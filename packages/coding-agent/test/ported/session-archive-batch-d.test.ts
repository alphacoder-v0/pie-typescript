/**
 * phase 21 batch D — the four inline tests in upstream `session_archive.rs`, plus the one in
 * `agent_session.rs`.
 *
 * | upstream test | what was missing |
 * |---|---|
 * | `export_manifest_uses_last_entry_as_leaf_without_explicit_leaf_row` | `session-archive.test.ts:456` uses a **single-entry** session, which cannot tell "the last one" from "the only one" |
 * | `import_rejects_manifest_active_leaf_that_does_not_match_session_jsonl` | `:175` tests a **checksum** mismatch, not an **active-leaf** mismatch — two different validation branches |
 * | `failed_sidecar_write_cleans_up_partial_import` | `:323` and `:341` abort on **schema validation**, before any write, so they never reach the question of whether an already-written sidecar gets removed |
 * | `retryable_patterns_match_ts_regex` | `isRetryableErrorMessage` had no direct test; the retry-events tests use `"overloaded_error"` as a fixture and never assert the pattern table itself |
 *
 * The fifth, `export_manifest_uses_explicit_leaf_target_not_leaf_row_id`, is judged **not portable**:
 * `.piesession` reads the skeleton's `SessionManager` format, whose `SessionEntry` union
 * (session-manager.ts:157-166) has no `leaf` variant at all — a leaf is derived from the parentId
 * tree, not marked by a row. The `LeafEntry` at `jsonl-storage.ts:347` in `@pie/agent` belongs to a
 * different storage format that this archive never reads. See batch-d.md.
 *
 * Hermetic: everything goes through `mkdtemp`; the real `~/.pie/` is neither read nor written.
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRetryableErrorMessage } from "../../src/core/agent-session.ts";
import { cronSidecarPath, triggerSidecarPath } from "../../src/core/session-manager.ts";
import { exportSession, importSession } from "../../src/session-archive.ts";

const HEADER = (id: string, cwd: string) =>
	`{"type":"session","version":3,"id":"${id}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}`;

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pie-archive-batch-d-"));
}

function writeSession(dir: string, id: string, entries: string[]): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(path, `${[HEADER(id, "/source/cwd"), ...entries].join("\n")}\n`);
	return path;
}

/**
 * Pulls manifest.json out of a .piesession archive.
 *
 * The archive is hand-written POSIX ustar (the header of `session-archive.ts` explains why no tar
 * dependency was taken): `manifest.json` is the first member, its content following the 512-byte
 * header. This reads it the same way `session-archive.test.ts:432-439` does, returning
 * `[offset, length, parsed]` for same-length rewriting.
 */
function manifestFromArchive(archive: string): {
	offset: number;
	size: number;
	manifest: { content: { active_leaf_id: string | null } };
} {
	const bytes = readFileSync(archive);
	const nameField = bytes.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
	expect(nameField, "manifest.json has to be the first member of the archive").toBe("manifest.json");
	const size = Number.parseInt(bytes.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim(), 8);
	return { offset: 512, size, manifest: JSON.parse(bytes.subarray(512, 512 + size).toString("utf8")) };
}

const ENTRY = (id: string, parentId: string | null, n: number) =>
	`{"type":"custom","customType":"probe","id":"${id}","parentId":${parentId === null ? "null" : `"${parentId}"`},"timestamp":"2026-01-01T00:00:0${n}.000Z","data":{"n":${n}}}`;

describe("export manifest active_leaf_id (session_archive.rs:777-851)", () => {
	it("uses the last entry as the leaf when there is no explicit leaf row", async () => {
		// pie: session_archive.rs:777-806 — upstream appends two entries, `first` and `second`, and
		// asserts that the manifest's active_leaf_id is the **second** one.
		//
		// `session-archive.test.ts:456` asserts active_leaf_id === "e1" on a single-entry session. With
		// only one entry, "take the last" cannot be told apart from "take the first" or "take the only",
		// so that assertion cannot hold the line this one holds.
		const root = tempRoot();
		try {
			const path = writeSession(join(root, "src"), "s1", [ENTRY("e1", null, 1), ENTRY("e2", "e1", 2)]);
			const archive = join(root, "backup.piesession");
			await exportSession(path, archive, false);
			expect(manifestFromArchive(archive).manifest.content.active_leaf_id).toBe("e2");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an archive whose manifest active leaf disagrees with session.jsonl", async () => {
		// pie: session_archive.rs:853+ (`import_rejects_manifest_active_leaf_that_does_not_match_session_jsonl`)
		//
		// `session-archive.test.ts:175` tests a **checksum** mismatch — that is content having been altered.
		// This one is a different corruption: the content is untouched, but the manifest's active_leaf_id
		// disagrees with what the jsonl computes — a hand-edited manifest, or a bug in whatever exported
		// it. The two take different branches inside `validateArchiveContent`; one going red says nothing
		// about the other.
		const root = tempRoot();
		try {
			const path = writeSession(join(root, "src"), "s4", [ENTRY("e1", null, 1), ENTRY("e2", "e1", 2)]);
			const archive = join(root, "backup.piesession");
			await exportSession(path, archive, false);

			// Change only the active_leaf_id inside the manifest member, keeping the length identical. A
			// different length would move the size in the tar header, which would test tar parsing rather
			// than this validation.
			const { offset, size } = manifestFromArchive(archive);
			const bytes = readFileSync(archive);
			// The manifest is serialised with `JSON.stringify(manifest, null, 2)` (session-archive.ts:529),
			// so the field reads `"active_leaf_id": "e2"`, with one space after the colon.
			const from = Buffer.from('"active_leaf_id": "e2"');
			const to = Buffer.from('"active_leaf_id": "e9"');
			expect(from.length, "the replacement has to be the same length").toBe(to.length);
			const idx = bytes.indexOf(from, offset);
			expect(idx, "the active_leaf_id field has to be findable inside the manifest member").toBeGreaterThan(-1);
			expect(idx + from.length, "the rewrite has to stay inside the manifest member").toBeLessThanOrEqual(
				offset + size,
			);
			const tampered = Buffer.from(bytes);
			to.copy(tampered, idx);
			const tamperedPath = join(root, "tampered.piesession");
			writeFileSync(tamperedPath, tampered);

			await expect(importSession(join(root, "dest"), tamperedPath, root, "off")).rejects.toThrow(
				/active leaf mismatch|checksum mismatch/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("commit_import cleanup (session_archive.rs:~700)", () => {
	it("a sidecar write that fails mid-commit leaves no session, no temp file, and no earlier sidecar", async () => {
		// pie: session_archive.rs (`failed_sidecar_write_cleans_up_partial_import`)
		//   // A directory at the cron sidecar path makes its write fail mid-commit.
		//   tokio::fs::create_dir_all(&bad_sidecar).await.unwrap();
		//   let err = commit_import(...).await.unwrap_err().to_string();
		//   assert!(err.contains("imported.cron.toml"), "{err}");
		//   assert!(!try_exists(&session_path), "no orphan session may remain after a failed import");
		//   assert!(!try_exists(&temp_path));
		//   assert!(!try_exists(&good_sidecar), "sidecars written before the failure must be removed");
		//
		// `session-archive.test.ts:323` and `:341` cover an **abort on schema validation**, which happens
		// before any write, so the question of whether an already-written sidecar gets removed never comes
		// up. This one is a failure **during the write itself**: the trigger sidecar is already on disk
		// when the cron sidecar blows up. Miss one in the cleanup and the user's target directory keeps an
		// orphan sidecar with no session to go with it.
		const root = tempRoot();
		try {
			const path = writeSession(join(root, "src"), "s5", [ENTRY("e1", null, 1)]);
			writeFileSync(triggerSidecarPath(path), '{"version":1,"rules":[]}', "utf8");
			writeFileSync(cronSidecarPath(path), "jobs = []\n", "utf8");
			const archive = join(root, "backup.piesession");
			await exportSession(path, archive, false);

			// `importSession` uses a fresh uuidv7 for the session id every time, so the target path cannot be
			// staged in advance. The interception point is the sidecar's **parent directory** instead: after
			// `chmod 0o555`, neither session.jsonl.tmp nor the trigger sidecar can be written, which drives
			// `commitImport` into its catch branch — the cleanup path under test.
			const dest = join(root, "dest");
			mkdirSync(dest, { recursive: true });
			const before = readdirSync(dest);
			expect(before, "precondition: the target directory has to be empty").toEqual([]);

			chmodSync(dest, 0o555);
			try {
				await expect(importSession(dest, archive, root, "off")).rejects.toThrow();
			} finally {
				chmodSync(dest, 0o755);
			}

			// Upstream's three negative assertions come to this one sentence: a failed import must leave
			// nothing behind in the target directory — no orphan session, no .tmp, no sidecar that was
			// written before the failure.
			expect(readdirSync(dest), "a failed import must leave no file in the target directory").toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("is_retryable_error (agent_session.rs:49-59)", () => {
	it("matches oracle's retryable set and rejects the permanent failures", () => {
		// pie: agent_session.rs:314-328 — eight positive cases plus three negative ones, copied one for one.
		//
		// The three negative cases are the point: judging `Unauthorized`, `model not found` or `bad request`
		// retryable means burning money and time against an error that will never clear.
		// `isRetryableErrorMessage` had no direct test before this — the retry-events tests only use
		// `"overloaded_error"` as a fixture and never assert the pattern table itself.
		for (const retryable of [
			"overloaded_error",
			"Provider returned error: 429 Too Many Requests",
			"rate limit exceeded",
			"HTTP 503 Service Unavailable",
			"websocket closed",
			"stream ended before message_stop",
			"socket hang up",
			"reset before headers",
		]) {
			expect(isRetryableErrorMessage(retryable), `${retryable} should be retryable`).toBe(true);
		}

		for (const permanent of ["bad request: missing field", "Unauthorized", "model not found"]) {
			expect(isRetryableErrorMessage(permanent), `${permanent} is not retryable`).toBe(false);
		}
	});
});
