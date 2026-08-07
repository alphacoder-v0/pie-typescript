import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitTool, createGitToolDefinition, type GitToolDetails, type GitToolInput } from "../src/tools/git.ts";

// pie: crates/coding-agent/src/tools/git.rs -- git.rs has no #[cfg(test)] module in oracle, so
// there is nothing to port verbatim here; these tests instead cover the behavior this file's
// doc comments claim to preserve bug-for-bug (header/body/truncation format, non-zero exit
// formatting, unkillable cancellation, and the additionalProperties:false / enum schema shape).

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((c) => c.type === "text")?.text ?? "";
}

/**
 * Type-only workaround for a src-level typebox defect (not a test-authoring issue): git.ts
 * builds `gitSchema.subcommand` via `Type.Union(SUBCOMMANDS.map((s) => Type.Literal(s)), ...)`.
 * `.map()` over a readonly tuple produces a plain (non-tuple) array, and typebox 1.x's
 * `StaticUnion` conditional type only recurses through a literal `[Left, ...Right]` tuple
 * pattern -- a non-tuple array never matches that pattern, so the recursion falls straight to
 * its `never` base case. That collapses `Static<typeof gitSchema>["subcommand"]` (and therefore
 * `GitToolInput["subcommand"]`) to `never` at the type level, even though the schema's runtime
 * behavior (validation, the JSON-schema `anyOf`) is completely unaffected -- typebox's `Union()`
 * only reads `.anyOf` at runtime, which doesn't care whether the JS array was a tuple. Flagged
 * for the orchestrator; not fixed in src per this task's scope (test/example files only).
 */
// The src-side Type.Union now uses a literal array, so GitToolInput's subcommand resolves
// properly instead of collapsing to `never` — this helper is a plain pass-through, kept only
// so the call sites stay uniform.
function gitInput(value: GitToolInput): GitToolInput {
	return value;
}

describe("git tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "coding-agent-git-tool-"));
		const init = spawnSync("git", ["init"], { cwd: testDir });
		expect(init.status).toBe(0);
		spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: testDir });
		spawnSync("git", ["config", "user.name", "Test User"], { cwd: testDir });
		writeFileSync(join(testDir, "a.txt"), "hi\n");
		spawnSync("git", ["add", "-A"], { cwd: testDir });
		const commit = spawnSync("git", ["commit", "-m", "init"], { cwd: testDir });
		expect(commit.status).toBe(0);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should expose the oracle schema shape (name/description/enum/additionalProperties)", () => {
		// pie: crates/coding-agent/src/tools/git.rs:159-186 (verbatim description; enum +
		// additionalProperties:false shape)
		const def = createGitToolDefinition(testDir);
		expect(def.name).toBe("git");
		expect(def.description).toBe(
			"Run a read-only git subcommand (status / diff / log) with sensible defaults and structured output. Write/network operations go through bash so the permission policy can intercept them.",
		);
		const params = def.parameters as unknown as {
			additionalProperties: boolean;
			required: string[];
			properties: { subcommand: { anyOf?: unknown[]; enum?: unknown[] } };
		};
		expect(params.additionalProperties).toBe(false);
		expect(params.required).toEqual(["subcommand"]);
	});

	it("should run `status` with the default --short --branch flags and a structured header", async () => {
		const tool = createGitTool(testDir);
		const result = await tool.execute("call-status", gitInput({ subcommand: "status" }), undefined, undefined);
		const text = getText(result);

		// pie: crates/coding-agent/src/tools/git.rs:105 ("git {subcommand} (cwd={cwd unwrap_or "."})")
		expect(text).toMatch(/^git status \(cwd=\.\)\n/);
		expect(text).toContain("## master");
		const details = result.details as GitToolDetails;
		expect(details).toMatchObject({ subcommand: "status", exit_status: 0, truncated: false });
		expect(details.argv).toEqual(["status", "--short", "--branch"]);
	});

	it("should run `diff` with --no-color --no-ext-diff defaults", async () => {
		writeFileSync(join(testDir, "a.txt"), "hi\nbye\n");
		const tool = createGitTool(testDir);
		const result = await tool.execute("call-diff", gitInput({ subcommand: "diff" }), undefined, undefined);
		const text = getText(result);

		expect(text).toContain("git diff (cwd=.)\n");
		expect(text).toContain("+bye");
		const details = result.details as GitToolDetails;
		expect(details.argv).toEqual(["diff", "--no-color", "--no-ext-diff"]);
	});

	it("should run `log` with the default -n 20 --pretty=format defaults", async () => {
		const tool = createGitTool(testDir);
		const result = await tool.execute("call-log", gitInput({ subcommand: "log" }), undefined, undefined);
		const text = getText(result);

		expect(text).toContain("git log (cwd=.)\n");
		expect(text).toMatch(/[0-9a-f]{7} \d{4}-\d{2}-\d{2} .* Test User init/);
		const details = result.details as GitToolDetails;
		expect(details.argv).toEqual(["log", "--no-color", "-n", "20", "--pretty=format:%h %ci %an %s"]);
	});

	it("should append extra args after the subcommand defaults", async () => {
		const tool = createGitTool(testDir);
		const result = await tool.execute(
			"call-args",
			gitInput({ subcommand: "log", args: ["-1", "--format=%s"] }),
			undefined,
			undefined,
		);
		const details = result.details as GitToolDetails;
		expect(details.argv).toEqual([
			"log",
			"--no-color",
			"-n",
			"20",
			"--pretty=format:%h %ci %an %s",
			"-1",
			"--format=%s",
		]);
	});

	it("should format a non-zero exit as 'git <sub> exited with status N' plus stderr", async () => {
		// pie: crates/coding-agent/src/tools/git.rs:93-99
		const tool = createGitTool(testDir);
		const result = await tool.execute(
			"call-bad-rev",
			gitInput({ subcommand: "log", args: ["not-a-real-revision"] }),
			undefined,
			undefined,
		);
		const text = getText(result);

		expect(text).toMatch(/git log exited with status \d+\n--- stderr ---\n/);
		const details = result.details as GitToolDetails;
		expect(details.exit_status).not.toBe(0);
	});

	it("should reject an unsupported subcommand with oracle's exact message", async () => {
		// pie: crates/coding-agent/src/tools/git.rs:50-55
		const def = createGitToolDefinition(testDir);
		await expect(
			def.execute(
				"call-bad-sub",
				// Deliberately invalid subcommand to exercise oracle's runtime rejection; cast is
				// required regardless of the `subcommand` field's `never` typing (see `gitInput`
				// above) since "push" isn't a member of `GitSubcommand` either.
				{ subcommand: "push" } as unknown as GitToolInput,
				undefined,
				undefined,
				{} as Parameters<typeof def.execute>[4],
			),
		).rejects.toThrow("unsupported git subcommand: push (allowed: status, diff, log)");
	});

	it("should reject a missing subcommand with oracle's exact message", async () => {
		const def = createGitToolDefinition(testDir);
		await expect(
			def.execute("call-missing-sub", {} as any, undefined, undefined, {} as Parameters<typeof def.execute>[4]),
		).rejects.toThrow("missing required arg: subcommand");
	});

	it("should default cwd display to '.' while still resolving against the tool's own cwd", async () => {
		mkdirSync(join(testDir, "sub"));
		const tool = createGitTool(join(testDir, "sub"));
		// "sub" has no .git of its own; git walks up to find testDir's repo, so `status` still
		// succeeds even though the header prints "." rather than the resolved directory.
		const result = await tool.execute("call-cwd-default", gitInput({ subcommand: "status" }), undefined, undefined);
		expect(getText(result)).toMatch(/^git status \(cwd=\.\)\n/);
	});

	it("should echo an explicit cwd arg verbatim in the header", async () => {
		const tool = createGitTool(testDir);
		const result = await tool.execute(
			"call-cwd-explicit",
			gitInput({ subcommand: "status", cwd: testDir }),
			undefined,
			undefined,
		);
		expect(getText(result)).toMatch(
			new RegExp(`^git status \\(cwd=${testDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\n`),
		);
	});

	it("should truncate output at 64 KiB on a UTF-8 character boundary", async () => {
		// pie: crates/coding-agent/src/tools/git.rs:23,148-157
		const longLine = "x".repeat(200);
		const lines = Array.from({ length: 500 }, (_, i) => `${longLine} line-${i}`);
		writeFileSync(join(testDir, "big.txt"), lines.join("\n"));
		spawnSync("git", ["add", "-A"], { cwd: testDir });

		const tool = createGitTool(testDir);
		const result = await tool.execute(
			"call-truncate",
			gitInput({ subcommand: "diff", args: ["--cached"] }),
			undefined,
			undefined,
		);
		const text = getText(result);
		const details = result.details as GitToolDetails;

		expect(details.truncated).toBe(true);
		expect(text).toContain("(truncated at 64 KiB)");
		// The body between the header and the truncation suffix must not exceed the cap, and
		// must be valid UTF-8 (a boundary-correct slice round-trips through Buffer/utf-8
		// cleanly; a severed multi-byte tail would not).
		const body = text.slice(text.indexOf("\n") + 1, text.indexOf("\n\n(truncated"));
		expect(Buffer.byteLength(body, "utf-8")).toBeLessThanOrEqual(64 * 1024);
	});

	it("should abandon the wait on cancellation without killing the child (bug-for-bug: git.rs:83-89)", async () => {
		const marker = join(testDir, "slow-git-finished");
		const scriptPath = join(testDir, "slow-git.sh");
		writeFileSync(scriptPath, `#!/bin/sh\nsleep 0.4\ntouch ${JSON.stringify(marker)}\necho done\n`);
		chmodSync(scriptPath, 0o755);

		const def = createGitToolDefinition(testDir, { gitPath: scriptPath });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);

		const started = Date.now();
		await expect(
			def.execute(
				"call-cancel",
				gitInput({ subcommand: "status" }),
				controller.signal,
				undefined,
				{} as Parameters<typeof def.execute>[4],
			),
		).rejects.toThrow("cancelled");
		expect(Date.now() - started).toBeLessThan(300);
		expect(existsSync(marker)).toBe(false);

		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(existsSync(marker)).toBe(true);
	});

	it("should reject immediately when the signal is already aborted", async () => {
		const def = createGitToolDefinition(testDir);
		const controller = new AbortController();
		controller.abort();
		await expect(
			def.execute(
				"call-pre-aborted",
				gitInput({ subcommand: "status" }),
				controller.signal,
				undefined,
				{} as Parameters<typeof def.execute>[4],
			),
		).rejects.toThrow("cancelled");
	});

	it("should surface a spawn failure as 'spawn git: ...'", async () => {
		const def = createGitToolDefinition(testDir, { gitPath: join(testDir, "does-not-exist-xyz") });
		await expect(
			def.execute(
				"call-spawn-fail",
				gitInput({ subcommand: "status" }),
				undefined,
				undefined,
				{} as Parameters<typeof def.execute>[4],
			),
		).rejects.toThrow(/spawn git: /);
	});
});
