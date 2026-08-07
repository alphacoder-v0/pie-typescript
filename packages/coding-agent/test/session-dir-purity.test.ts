/**
 * Read-only session paths must not create directories.
 *
 * This invariant is declared by this repo itself, in the doc comment on `sessionDirForCwd` in
 * `session-manager.ts`:
 *
 *   > Read-only surfaces ... must not leave an empty `~/.pie/sessions/<hash>/` behind for a cwd
 *   > that has never held a session.
 *
 * Declared, and unguarded. Measured with `pie --resume-id <an id that does not exist>`: upstream
 * creates zero directory entries, this side created three (`~/.pie`, `~/.pie/sessions` and
 * `main.ts:421 resolveSessionPath` → `SessionManager.list(cwd)` → `getDefaultSessionDir`，
 * `~/.pie/sessions/<hash>`), because that path goes through a call that does mkdirSync.
 * `--list-sessions` escaped only because `main.ts:329` happens to already use the pure
 * `sessionDirForCwd`. The fix was in the repo all along; it just never reached SessionManager's read
 * interface.
 *
 * The upstream contract: `config.rs:21-24 sessions_dir_for_cwd` is pure path joining, and only
 * `JsonlSessionRepo::create` calls `create_dir_all`.
 *
 * This file works at the **module level**. The process-level assertion for the same defect is F11 in
 * `cli-state-surfaces.test.ts`, and both are needed: the module level pins which function may not
 * create a directory, the process level pins that the command a user actually types leaves no trace.
 *
 * Isolation goes through `PIE_DIR` (`config.ts:482`); HOME is left alone.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { automationElsewhereHint, SessionManager } from "../src/core/session-manager.ts";

let pieDir: string;
let workCwd: string;
const savedPieDir = process.env.PIE_DIR;

beforeEach(() => {
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	pieDir = join(tmpdir(), `pie-dir-purity-${stamp}`);
	workCwd = join(tmpdir(), `pie-cwd-purity-${stamp}`);
	mkdirSync(workCwd, { recursive: true });
	// pieDir is deliberately **not** created up front: on a clean machine `~/.pie` may well not exist,
	// which is exactly the case where a read-only command conjuring it goes unnoticed.
	process.env.PIE_DIR = pieDir;
});

afterEach(() => {
	if (savedPieDir === undefined) delete process.env.PIE_DIR;
	else process.env.PIE_DIR = savedPieDir;
	rmSync(pieDir, { recursive: true, force: true });
	rmSync(workCwd, { recursive: true, force: true });
});

/** Every entry under pieDir, including pieDir itself, for asserting that nothing was created. */
function createdEntries(): string[] {
	if (!existsSync(pieDir)) return [];
	const out: string[] = [pieDir];
	const walk = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			out.push(p);
			if (e.isDirectory()) walk(p);
		}
	};
	walk(pieDir);
	return out;
}

describe("read-only session paths stay read-only", () => {
	it("SessionManager.list creates no directory for a cwd that has no sessions", async () => {
		const sessions = await SessionManager.list(workCwd);
		expect(sessions).toEqual([]);
		expect(createdEntries()).toEqual([]);
	});

	it("automationElsewhereHint creates no directory", async () => {
		const hint = await automationElsewhereHint(workCwd);
		expect(hint).toBeUndefined();
		expect(createdEntries()).toEqual([]);
	});

	it("SessionManager.listAll creates no directory", async () => {
		const sessions = await SessionManager.listAll();
		expect(sessions).toEqual([]);
		expect(createdEntries()).toEqual([]);
	});

	// Negative control. Without it, the three above would also pass under a mistake like
	// `createdEntries` always returning empty — a check that cannot fail is not a check. This proves
	// the write path really is visible to these assertions.
	it("negative control: SessionManager.create is a write path and must create the directory, or the assertions above are blind", () => {
		SessionManager.create(workCwd);
		const created = createdEntries();
		expect(created.length).toBeGreaterThan(0);
		expect(created.some((p) => p.includes("sessions"))).toBe(true);
	});
});
