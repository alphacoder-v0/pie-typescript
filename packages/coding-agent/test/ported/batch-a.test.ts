import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionId, createTimestamp } from "@pie/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cronSidecarPath, resolveResumeSessionPath, triggerSidecarPath } from "../../src/core/session-manager.ts";
import { HistoryStore } from "../../src/history.ts";

/**
 * phase 22 batch A wrap-up — the remaining `new-test` verdicts in sessions and history.
 *
 * Of batch A's 52 functions, 43 point at an existing assertion or were judged not portable.
 * These are the rest, the ones that needed writing: listed in `roster.tsv`, with a counterpart
 * `check:surface-coverage` can see, but no assertion anywhere touching their behavior.
 */
describe("phase 22 batch A wrap-up", () => {
	// ── agent/src/harness/session/repo_utils.rs::create_session_id@11 ──────────
	//
	// Upstream generates session ids with uuidv7. Two observable properties: the format is **valid**,
	// and each one **differs**. The second matters most: two sessions sharing an id means the second
	// overwrites the first's JSONL.
	describe("createSessionId (oracle create_session_id)", () => {
		it("produces a uuid v7 shaped id", () => {
			// uuidv7: the third group starts with 7, and the fourth starts with 8, 9, a or b — the variant
			// bits.
			expect(createSessionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		});

		it("never repeats — two sessions must not share an id", () => {
			const ids = new Set(Array.from({ length: 64 }, () => createSessionId()));

			expect(ids.size).toBe(64);
		});
	});

	// ── agent/src/harness/session/repo_utils.rs::create_timestamp@15 ───────────
	//
	// Timestamps on session entries. The format has to be ISO-8601 with a `Z`, so a file written
	// upstream reads back here and the other way round; one format apart and a session written by one
	// implementation will not parse in the other.
	describe("createTimestamp (oracle create_timestamp)", () => {
		it("is ISO-8601 with a Z suffix", () => {
			expect(createTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
		});

		it("round-trips through Date without losing the instant", () => {
			const stamp = createTimestamp();

			expect(new Date(stamp).toISOString().slice(0, 19)).toBe(stamp.slice(0, 19));
		});
	});

	// ── coding-agent/src/history.rs::len@44 ───────────────────────────────────
	//
	// Upstream's `HistoryStore::len`. Here it is a **getter, `length`**, not a method `len()` — one of
	// the naming differences phase 3 recorded under "mechanical snake_case to camelCase fails".
	describe("HistoryStore.length (oracle len)", () => {
		let dir: string;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "pie-history-len-"));
		});

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it("counts the entries that were loaded", () => {
			const path = join(dir, "history");
			writeFileSync(path, "one\ntwo\nthree\n");

			expect(HistoryStore.loadFrom(path).length).toBe(3);
		});

		it("is 0 for an empty history — and agrees with isEmpty", () => {
			const path = join(dir, "history");
			writeFileSync(path, "");
			const store = HistoryStore.loadFrom(path);

			expect([store.length, store.isEmpty()]).toEqual([0, true]);
		});

		it("tracks appends", () => {
			const path = join(dir, "history");
			writeFileSync(path, "one\n");
			const store = HistoryStore.loadFrom(path);
			store.append("two");

			expect(store.length).toBe(2);
		});
	});

	// ── coding-agent/src/session/mod.rs::trigger_sidecar_path@25 / cron_sidecar_path@30 ──
	//
	// Sidecar paths derive from the session file path. **The extension is part of the contract**:
	// upstream writes `.triggers.json` and `.cron.toml`, and writing anything else here means the
	// automation config it stored cannot be read on this side, or the other way round.
	describe("deriving sidecar paths", () => {
		it("derives the triggers sidecar from the session path", () => {
			expect(triggerSidecarPath("/tmp/sessions/abc.jsonl")).toBe("/tmp/sessions/abc.triggers.json");
		});

		it("derives the cron sidecar with oracle's .cron.toml extension", () => {
			// Note toml, not json: upstream's cron sidecar is TOML.
			expect(cronSidecarPath("/tmp/sessions/abc.jsonl")).toBe("/tmp/sessions/abc.cron.toml");
		});

		it("keeps the two sidecars distinct for the same session", () => {
			const session = "/tmp/sessions/abc.jsonl";

			expect(triggerSidecarPath(session)).not.toBe(cronSidecarPath(session));
		});
	});

	// ── coding-agent/src/session/mod.rs::resume@82 ────────────────────────────
	//
	// Upstream's `resume` decides which session to open; here that is
	// `resolveResumeSessionPath(dir, id?)`. Both failure paths need a definite error — no session in
	// the directory, and an id that does not exist. Silently returning some other session is the worst
	// outcome: the user believes they are resuming and has opened someone else's.
	describe("resolveResumeSessionPath (oracle resume)", () => {
		let dir: string;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "pie-resume-"));
		});

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it("throws a directory-scoped message when there is nothing to resume", () => {
			expect(() => resolveResumeSessionPath(dir)).toThrow(`no sessions to resume in ${dir}`);
		});

		it("throws a name-the-id message when the requested id does not exist", () => {
			// The directory has to hold a session first: on an empty directory the "nothing to resume"
			// check runs before id matching, so with no file this would hit the previous message and never
			// reach the id-not-found path.
			writeFileSync(join(dir, "0199abcd-ef01-7234-8000-000000000001.jsonl"), "");

			expect(() => resolveResumeSessionPath(dir, "zzz")).toThrow("no session matches id zzz");
		});
	});
});
