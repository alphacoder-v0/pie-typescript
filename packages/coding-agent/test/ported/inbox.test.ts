/**
 * Vitest port of the 2 `#[test]` functions in oracle `crates/coding-agent/src/inbox.rs`
 * (pie @0a120dfd, `mod tests` at line ~176).
 *
 * Test-name / oracle-line mapping:
 *  1. append_list_claim_dismiss_round_trip                       -> oracle :183
 *  2. oversized_text_is_capped_and_corrupt_lines_skipped          -> oracle :224
 */

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { append, dismissAllNew, list, listNew, MAX_ENTRY_TEXT_CHARS, newCount, setStatus } from "../../src/inbox.ts";

const tempDirs: string[] = [];

function tempInboxPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "inbox-test-"));
	tempDirs.push(dir);
	return join(dir, "inbox.jsonl");
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

// oracle :183 append_list_claim_dismiss_round_trip
it("append/list/claim/dismiss round trip", () => {
	const path = tempInboxPath();
	expect(newCount(path)).toBe(0); // missing file counts as zero

	const a = append(path, "cron:job-1", "found a flaky test", "trace-a", "sess-1");
	const b = append(path, "cron:job-2", "  PR #9 needs rebase  ", "trace-b", "sess-1");
	expect(a.id).not.toBe(b.id);
	expect(b.text).toBe("PR #9 needs rebase"); // text must be trimmed

	const entries = listNew(path);
	expect(entries.length).toBe(2);
	expect(entries[0].id).toBe(a.id); // oldest first
	expect(newCount(path)).toBe(2);

	const claimed = setStatus(path, a.id, "claimed");
	expect(claimed).toBeDefined();
	expect(claimed?.status).toBe("claimed");
	expect(newCount(path)).toBe(1);
	expect(setStatus(path, "inb-missing", "claimed")).toBeUndefined();

	expect(dismissAllNew(path)).toBe(1);
	expect(newCount(path)).toBe(0);
	// History preserved: claimed + dismissed entries still listed.
	expect(list(path).length).toBe(2);
});

// oracle :224 oversized_text_is_capped_and_corrupt_lines_skipped
it("oversized text is capped and corrupt lines are skipped", () => {
	const path = tempInboxPath();
	const long = "x".repeat(2000);
	const entry = append(path, "cron:j", long, "t", "s");
	expect([...entry.text].length).toBeLessThanOrEqual(MAX_ENTRY_TEXT_CHARS + 1); // capped (plus ellipsis)

	// A corrupt line in the middle must not break reads or later appends.
	appendFileSync(path, "{not json\n");
	append(path, "cron:j", "after corruption", "t2", "s");
	const entries = list(path);
	expect(entries.length).toBe(2); // corrupt line skipped, both real entries read
	expect(entries[1].text).toBe("after corruption");
});
