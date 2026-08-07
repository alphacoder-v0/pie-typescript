import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	automationCounts,
	automationCountsAnyEnabled,
	automationCountsBadge,
	automationElsewhereHint,
	cronSidecarPath,
	deleteSessionById,
	endpointSidecarPath,
	findSessionPathById,
	isAutomationCountsEmpty,
	listSessionEntries,
	newestSessionPath,
	resolveResumeSessionPath,
	triggerSidecarPath,
} from "../../src/core/session-manager.ts";

// pie: crates/coding-agent/src/session/mod.rs -- diff-port coverage for the cwd-scoped
// resume/list/delete helpers and automation-sidecar functions this unit adds, adapted onto pi's
// own SessionManager file format. Ported from session/mod.rs's #[cfg(test)] module where the
// underlying data model allows a direct translation.

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pie-session-helpers-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function writeSession(dir: string, fileName: string, id: string, timestamp: string, extraLines: string[] = []): string {
	const path = join(dir, fileName);
	const header = `{"type":"session","version":3,"id":"${id}","timestamp":"${timestamp}","cwd":"/tmp"}`;
	writeFileSync(path, `${[header, ...extraLines].join("\n")}\n`);
	return path;
}

// pie: session/mod.rs:561-571 (trigger_sidecar_path_lives_next_to_session_file)
describe("sidecar path derivation", () => {
	it("derives trigger/cron/endpoint sidecar paths next to the session file", () => {
		const path = join("/tmp", "session-id.jsonl");
		expect(triggerSidecarPath(path)).toBe(join("/tmp", "session-id.triggers.json"));
		expect(cronSidecarPath(path)).toBe(join("/tmp", "session-id.cron.toml"));
		expect(endpointSidecarPath(path)).toBe(join("/tmp", "session-id.endpoints.json"));
	});

	it("derives sidecar paths for pi's timestamp-prefixed filenames too", () => {
		const path = join("/tmp", "2026-08-03T12-00-00-000Z_0199abcd-ef01-7234-8000-abcdef012345.jsonl");
		expect(triggerSidecarPath(path)).toBe(
			join("/tmp", "2026-08-03T12-00-00-000Z_0199abcd-ef01-7234-8000-abcdef012345.triggers.json"),
		);
	});
});

// pie: session/mod.rs:357-411 (automation_counts_reads_enabled_and_total_from_sidecars)
describe("automationCounts", () => {
	it("degrades missing sidecars to zero", async () => {
		const sessionPath = join(tempDir, "s.jsonl");
		const counts = await automationCounts(sessionPath);
		expect(isAutomationCountsEmpty(counts)).toBe(true);
		expect(automationCountsBadge(counts)).toBeUndefined();
	});

	it("reads enabled/total from both sidecars", async () => {
		const sessionPath = join(tempDir, "s.jsonl");
		writeFileSync(triggerSidecarPath(sessionPath), '{"version":1,"rules":[{"enabled":true},{"enabled":false}]}');
		writeFileSync(
			cronSidecarPath(sessionPath),
			"[[jobs]]\nenabled = true\n\n[[jobs]]\nenabled = false\n\n[[jobs]]\nenabled = true\n",
		);
		const counts = await automationCounts(sessionPath);
		expect(counts.cronTotal).toBe(3);
		expect(counts.cronEnabled).toBe(2);
		expect(counts.triggerTotal).toBe(2);
		expect(counts.triggerEnabled).toBe(1);
		expect(automationCountsAnyEnabled(counts)).toBe(true);
		expect(automationCountsBadge(counts)).toBe("2 cron, 1 trigger");
	});

	it("degrades corrupt sidecars to zero (never a hard error)", async () => {
		const sessionPath = join(tempDir, "s.jsonl");
		writeFileSync(cronSidecarPath(sessionPath), "not toml [");
		writeFileSync(triggerSidecarPath(sessionPath), "{oops");
		const counts = await automationCounts(sessionPath);
		expect(isAutomationCountsEmpty(counts)).toBe(true);
	});

	// pie: session/mod.rs:275-279, 295-308 -- `EnabledOnly { #[serde(default)] enabled: bool }`.
	// A wrongly-typed `enabled` fails the *whole file*'s deserialization, so `if let Ok(file)`
	// never binds and the counts stay zero: no badge at all, not an "automation off" badge.
	it("treats a wrongly-typed `enabled` as a whole-file parse failure (no badge)", async () => {
		const sessionPath = join(tempDir, "s.jsonl");
		writeFileSync(cronSidecarPath(sessionPath), '[[jobs]]\nenabled = "true"\n\n[[jobs]]\nenabled = true\n');
		const counts = await automationCounts(sessionPath);
		expect(counts.cronTotal).toBe(0);
		expect(counts.cronEnabled).toBe(0);
		expect(automationCountsBadge(counts)).toBeUndefined();
	});

	it("treats a wrongly-typed trigger `enabled` as a whole-file parse failure too", async () => {
		const sessionPath = join(tempDir, "s.jsonl");
		writeFileSync(triggerSidecarPath(sessionPath), '{"version":1,"rules":[{"enabled":1}]}');
		const counts = await automationCounts(sessionPath);
		expect(counts.triggerTotal).toBe(0);
		expect(counts.triggerEnabled).toBe(0);
		expect(automationCountsBadge(counts)).toBeUndefined();
	});

	// `#[serde(default)]` on the field itself: an absent `enabled` is a valid, disabled entry --
	// it still counts toward the total (and so still renders the "automation off" badge).
	it("counts an entry whose `enabled` is absent as disabled, not as a parse failure", async () => {
		const sessionPath = join(tempDir, "s.jsonl");
		writeFileSync(cronSidecarPath(sessionPath), '[[jobs]]\nname = "nightly"\nschedule = "0 0 * * *"\n');
		const counts = await automationCounts(sessionPath);
		expect(counts.cronTotal).toBe(1);
		expect(counts.cronEnabled).toBe(0);
		expect(automationCountsBadge(counts)).toBe("automation off");
	});

	// The list field is `#[serde(default)]` too: absent means empty, but present-and-not-a-sequence
	// is a deserialization error.
	it("degrades a non-sequence `jobs` to zero", async () => {
		const sessionPath = join(tempDir, "s.jsonl");
		writeFileSync(cronSidecarPath(sessionPath), "jobs = 3\n");
		expect(isAutomationCountsEmpty(await automationCounts(sessionPath))).toBe(true);
	});
});

// pie: session/mod.rs:391-411 (automation_badge_renders_each_shape)
describe("automationCountsBadge", () => {
	it("renders each shape", () => {
		expect(automationCountsBadge({ cronEnabled: 2, cronTotal: 2, triggerEnabled: 0, triggerTotal: 0 })).toBe(
			"2 cron",
		);
		expect(automationCountsBadge({ cronEnabled: 0, cronTotal: 0, triggerEnabled: 1, triggerTotal: 3 })).toBe(
			"1 trigger",
		);
		expect(automationCountsBadge({ cronEnabled: 0, cronTotal: 2, triggerEnabled: 0, triggerTotal: 1 })).toBe(
			"automation off",
		);
	});
});

describe("findSessionPathById / resolveResumeSessionPath / newestSessionPath", () => {
	it("matches by bare filename stem", () => {
		const id = "0199abcd-ef01-7234-8000-abcdef012345";
		const path = writeSession(tempDir, `${id}.jsonl`, id, "2026-01-01T00:00:00Z");
		expect(findSessionPathById(tempDir, id)).toBe(path);
		expect(findSessionPathById(tempDir, "0199abcd")).toBe(path);
	});

	// pie: session/mod.rs:465-485 (resume_matches_legacy_metadata_id_when_file_stem_differs) --
	// pi's real production filenames are `<timestamp>_<uuid>.jsonl`, so the metadata-id fallback
	// is the *primary* path here, not a rare legacy case.
	it("falls back to the session metadata id when the filename stem differs (pi's real shape)", () => {
		const id = "0199abcd-ef01-7234-8000-abcdef012345";
		const path = writeSession(tempDir, `2026-08-03T12-00-00-000Z_${id}.jsonl`, id, "2026-08-03T12:00:00Z");
		expect(findSessionPathById(tempDir, id)).toBe(path);
		expect(findSessionPathById(tempDir, "0199abcd")).toBe(path);
	});

	it("returns null for an unmatched id", () => {
		writeSession(tempDir, "a.jsonl", "aaa", "2026-01-01T00:00:00Z");
		expect(findSessionPathById(tempDir, "zzz")).toBeNull();
	});

	it("resolveResumeSessionPath throws when the directory has no sessions", () => {
		expect(() => resolveResumeSessionPath(tempDir)).toThrow(`no sessions to resume in ${tempDir}`);
	});

	it("resolveResumeSessionPath throws a descriptive error for an unmatched explicit id", () => {
		writeSession(tempDir, "a.jsonl", "aaa", "2026-01-01T00:00:00Z");
		expect(() => resolveResumeSessionPath(tempDir, "zzz")).toThrow("no session matches id zzz");
	});

	it("resolveResumeSessionPath with no id picks the most recent (lexically last) session", () => {
		writeSession(tempDir, "2026-01-01T00-00-00-000Z_older.jsonl", "older", "2026-01-01T00:00:00Z");
		const newer = writeSession(tempDir, "2026-01-02T00-00-00-000Z_newer.jsonl", "newer", "2026-01-02T00:00:00Z");
		expect(resolveResumeSessionPath(tempDir)).toBe(newer);
		expect(newestSessionPath(tempDir)).toBe(newer);
	});

	it("newestSessionPath returns null for an empty/missing directory", () => {
		expect(newestSessionPath(join(tempDir, "nonexistent"))).toBeNull();
	});
});

describe("deleteSessionById", () => {
	it("removes the session file and its trigger/cron/endpoint sidecars", () => {
		const path = writeSession(tempDir, "a.jsonl", "aaa", "2026-01-01T00:00:00Z");
		writeFileSync(triggerSidecarPath(path), "{}");
		writeFileSync(cronSidecarPath(path), "[[jobs]]\n");
		writeFileSync(endpointSidecarPath(path), "{}");

		const deleted = deleteSessionById(tempDir, "aaa");

		expect(deleted).toBe(path);
		expect(findSessionPathById(tempDir, "aaa")).toBeNull();
	});

	it("does not error when sidecars are absent", () => {
		writeSession(tempDir, "a.jsonl", "aaa", "2026-01-01T00:00:00Z");
		expect(() => deleteSessionById(tempDir, "aaa")).not.toThrow();
	});

	it("throws a descriptive error for an unmatched id", () => {
		expect(() => deleteSessionById(tempDir, "zzz")).toThrow("no session matches id zzz");
	});
});

describe("listSessionEntries", () => {
	it("lists sessions with id/createdAt/preview/automation, oldest to newest", async () => {
		writeSession(tempDir, "2026-01-01T00-00-00-000Z_a.jsonl", "aaa", "2026-01-01T00:00:00Z", [
			'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"hello there","timestamp":1}}',
		]);
		const bPath = writeSession(tempDir, "2026-01-02T00-00-00-000Z_b.jsonl", "bbb", "2026-01-02T00:00:00Z");
		writeFileSync(cronSidecarPath(bPath), "[[jobs]]\nenabled = true\n");

		const entries = await listSessionEntries(tempDir);

		expect(entries).toHaveLength(2);
		expect(entries[0]!.id).toBe("aaa");
		expect(entries[0]!.preview).toBe("hello there");
		expect(entries[1]!.id).toBe("bbb");
		expect(entries[1]!.automation.cronTotal).toBe(1);
		expect(entries[1]!.automation.cronEnabled).toBe(1);
	});

	// pie: session/mod.rs:128-161 (first_user_text) -- 80-char truncation with ellipsis, newlines
	// collapsed to spaces.
	it("truncates a long first-user-message preview to 80 chars with an ellipsis", async () => {
		const longText = "x".repeat(100);
		writeSession(tempDir, "s.jsonl", "aaa", "2026-01-01T00:00:00Z", [
			`{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"${longText}","timestamp":1}}`,
		]);
		const entries = await listSessionEntries(tempDir);
		expect(entries[0]!.preview).toBe(`${"x".repeat(80)}…`);
	});

	it("replaces newlines in the preview with spaces", async () => {
		writeSession(tempDir, "s.jsonl", "aaa", "2026-01-01T00:00:00Z", [
			'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"line one\\nline two","timestamp":1}}',
		]);
		const entries = await listSessionEntries(tempDir);
		expect(entries[0]!.preview).toBe("line one line two");
	});

	// pie: session/mod.rs:130-158 (first_user_text) -- the loop returns `Some(preview)` at the
	// *first* user message unconditionally, so an image-only first turn previews as empty rather
	// than falling through to the next user message.
	it("previews the first user message even when it has no text blocks (image-only turn)", async () => {
		writeSession(tempDir, "s.jsonl", "aaa", "2026-01-01T00:00:00Z", [
			'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":[{"type":"image","data":"AAAA","mimeType":"image/png"}],"timestamp":1}}',
			'{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":"second turn","timestamp":2}}',
		]);
		const entries = await listSessionEntries(tempDir);
		expect(entries[0]!.preview).toBe("");
	});

	// pie: session/mod.rs:101 (`repo.open` parses the header line only -- jsonl_storage.rs:68-84)
	// + :129 (`session.entries().await.ok()?` swallows `load_entries`' `invalid entry: {e}`). A
	// corrupted tail costs the preview, NOT the listing: oracle's `pie --list-sessions` prints the
	// entry (parity S8 asserts exactly this). Still true after PORT-DIVERGENCE B8 -- here the torn
	// line is the session's only message, so salvaging it away leaves nothing to preview.
	it("still lists a session whose only message is a torn tail, dropping only its preview", async () => {
		writeFileSync(
			join(tempDir, "bad.jsonl"),
			'{"type":"session","id":"bad","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"cut off mid',
		);
		const entries = await listSessionEntries(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.id).toBe("bad");
		expect(entries[0]!.createdAt).toBe("2026-01-01T00:00:00Z");
		expect(entries[0]!.preview).toBeUndefined();
	});

	// PORT-DIVERGENCE B8, as it reaches the listing: a torn tail line after a healthy message no
	// longer blanks the preview -- the healthy prefix parses, so the listing names the session the
	// user is about to resume. The scan stays silent: it does not own these files, and one notice
	// per corrupted session would bury the listing itself.
	it("previews the healthy prefix of a session whose tail is torn, without narrating", async () => {
		writeFileSync(
			join(tempDir, "salvageable.jsonl"),
			'{"type":"session","id":"sal","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"first turn","timestamp":1}}\n' +
				'{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":"cut off mid',
		);
		const notices: string[] = [];
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			notices.push(String(chunk));
			return true;
		}) as typeof process.stderr.write);
		let entries: Awaited<ReturnType<typeof listSessionEntries>>;
		try {
			entries = await listSessionEntries(tempDir);
		} finally {
			spy.mockRestore();
		}
		expect(entries).toHaveLength(1);
		expect(entries[0]!.preview).toBe("first turn");
		expect(notices).toEqual([]);
	});

	// Mid-file corruption is a different fault: it is not salvaged, so the preview is still lost --
	// but the listing itself survives, exactly as in oracle.
	it("still lists a session corrupted mid-file, dropping only its preview", async () => {
		writeFileSync(
			join(tempDir, "midbad.jsonl"),
			'{"type":"session","id":"mid","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"{cut off mid\n" +
				'{"type":"message","id":"m2","parentId":null,"timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":"later","timestamp":2}}\n',
		);
		const entries = await listSessionEntries(tempDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.id).toBe("mid");
		expect(entries[0]!.preview).toBeUndefined();
	});
});

// pie: session/mod.rs:413-462 (automation_elsewhere_hint_names_newest_session_with_enabled_automation)
describe("automationElsewhereHint", () => {
	it("returns undefined when no session has enabled automation", async () => {
		writeSession(tempDir, "2026-01-01T00-00-00-000Z_a.jsonl", "aaa", "2026-01-01T00:00:00Z");
		expect(await automationElsewhereHint("/unused-cwd", undefined, tempDir)).toBeUndefined();
	});

	it("names the newest other session with enabled automation, excluding the current one", async () => {
		const older = writeSession(
			tempDir,
			"2026-01-01T00-00-00-000Z_older.jsonl",
			"0199aaaa-1111-7000-8000-000000000000",
			"2026-01-01T00:00:00Z",
		);
		const current = writeSession(tempDir, "2026-01-02T00-00-00-000Z_current.jsonl", "ccc", "2026-01-02T00:00:00Z");
		writeFileSync(cronSidecarPath(older), "[[jobs]]\nenabled = true\n");

		const hint = await automationElsewhereHint("/unused-cwd", current, tempDir);
		expect(hint).toBeDefined();
		expect(hint).toContain("0199aaaa-1111-70"); // first 16 chars of the session id
		expect(hint).toContain("1 cron");
		expect(hint).toContain("--resume-id");

		// The session holding the automation must not hint at itself.
		expect(await automationElsewhereHint("/unused-cwd", older, tempDir)).toBeUndefined();
	});

	it("ignores disabled-only automation", async () => {
		const older = writeSession(tempDir, "a.jsonl", "aaa", "2026-01-01T00:00:00Z");
		const current = writeSession(tempDir, "b.jsonl", "bbb", "2026-01-02T00:00:00Z");
		writeFileSync(cronSidecarPath(older), "[[jobs]]\nenabled = false\n");
		expect(await automationElsewhereHint("/unused-cwd", current, tempDir)).toBeUndefined();
	});

	it("reports extra-holder count when more than one other session has enabled automation", async () => {
		const first = writeSession(tempDir, "2026-01-01T00-00-00-000Z_a.jsonl", "aaa", "2026-01-01T00:00:00Z");
		const second = writeSession(tempDir, "2026-01-02T00-00-00-000Z_b.jsonl", "bbb", "2026-01-02T00:00:00Z");
		const current = writeSession(tempDir, "2026-01-03T00-00-00-000Z_c.jsonl", "ccc", "2026-01-03T00:00:00Z");
		writeFileSync(cronSidecarPath(first), "[[jobs]]\nenabled = true\n");
		writeFileSync(cronSidecarPath(second), "[[jobs]]\nenabled = true\n");

		const hint = await automationElsewhereHint("/unused-cwd", current, tempDir);
		expect(hint).toContain("+1 more session(s)");
	});
});
