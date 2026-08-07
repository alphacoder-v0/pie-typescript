/**
 * 1:1 port of oracle `crates/coding-agent/tests/git_tool_e2e.rs` (pie @0a120dfd).
 *
 * Oracle module doc: "End-to-end test for the structured git tool. Init a tempdir repo, make
 * changes, then run the tool against it. We rely on the system `git` binary being available; this
 * is a reasonable test-time dependency for a coding agent."
 *
 * 3 oracle test functions -> 3 tests here, names mirrored verbatim.
 *
 * File-wide structural adaptations (naming/architecture translations, not weakened assertions):
 * - Oracle `git::GitTool` (a unit struct) becomes `createGitTool(cwd)` from `src/tools/git.ts`.
 *   Oracle's `GitTool` has no ambient cwd at all -- it only ever uses the `cwd` tool argument --
 *   whereas the TS factory takes a fallback cwd; every test still passes `cwd` explicitly in the
 *   tool arguments exactly like oracle does, so the fallback is never the thing under test.
 * - Oracle's `result.content[0]` + `UserContentBlock::Text` match becomes `getText()`.
 * - The repo under test is always a fresh `mkdtemp` + `git init` (never this repo's own git).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createGitTool } from "../../src/tools/git.ts";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	if (block === undefined || block.type !== "text" || block.text === undefined) {
		throw new Error("expected text");
	}
	return block.text;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pie-git-tool-e2e-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

/** pie: git_tool_e2e.rs:14-37 -- initialise a fresh repo at `dir` with one committed file and one staged change. */
function initRepo(dir: string): void {
	const run = (args: string[]): void => {
		const st = spawnSync("git", args, {
			cwd: dir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "tester",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "tester",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
		});
		expect(st.status, `${JSON.stringify(args)} failed: ${st.stderr?.toString() ?? ""}`).toBe(0);
	};
	run(["init", "-q", "-b", "main"]);
	writeFileSync(join(dir, "a.txt"), "hello\n");
	run(["add", "a.txt"]);
	run(["commit", "-q", "-m", "initial"]);
	writeFileSync(join(dir, "b.txt"), "draft\n");
}

/** pie: git_tool_e2e.rs:39-45 */
function ensureGitAvailable(): boolean {
	const out = spawnSync("git", ["--version"]);
	return out.status === 0;
}

const cancel = new AbortController().signal;

// pie: git_tool_e2e.rs:47-76
it("git_status_reports_untracked_file", async () => {
	if (!ensureGitAvailable()) {
		console.error("(skipped: git binary not on PATH)");
		return;
	}
	const dir = tempDir();
	initRepo(dir);

	const tool = createGitTool(dir);
	const res = await tool.execute("call-1", { subcommand: "status", cwd: dir }, cancel);
	const body = getText(res);
	expect(body, `header: ${body}`).toContain("git status");
	expect(body, `untracked file: ${body}`).toContain("?? b.txt");
	expect(body, `branch line: ${body}`).toContain("## main");
});

// pie: git_tool_e2e.rs:78-109
it("git_log_caps_at_twenty_entries_and_uses_pretty_format", async () => {
	if (!ensureGitAvailable()) {
		console.error("(skipped: git binary not on PATH)");
		return;
	}
	const dir = tempDir();
	initRepo(dir);
	const tool = createGitTool(dir);
	const res = await tool.execute("call-2", { subcommand: "log", cwd: dir }, cancel);
	const body = getText(res);
	expect(body, `should show initial commit: ${body}`).toContain("initial");
	// Hash + author should appear in the pretty format.
	expect(body, `author in pretty fmt: ${body}`).toContain("tester");
});

// pie: git_tool_e2e.rs:111-125
it("git_unsupported_subcommand_errors", async () => {
	// Oracle constructs the unit struct with no cwd at all; the TS factory needs one, and the
	// unsupported-subcommand guard (src/tools/git.ts:164-166) fires before cwd is ever resolved,
	// so the value is immaterial here.
	const tool = createGitTool(tempDir());
	await expect(tool.execute("call-3", { subcommand: "push" } as never, cancel)).rejects.toThrow(/unsupported/);
});
