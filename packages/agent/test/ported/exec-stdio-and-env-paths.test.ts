/**
 * phase 20-4: ports three inline tests from upstream `crates/agent` that had no matching assertion
 * here.
 *
 * - `env/native.rs exec_preserves_stdout_stderr_without_inventing_trailing_newlines`
 * - `env/native.rs exec_high_stderr_volume_does_not_deadlock_stdout_drain`
 * - `skills.rs env_path_helpers`
 *
 * The assertions are **upstream's**.
 */
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { basenameEnvPath, dirnameEnvPath, joinEnvPath, relativeEnvPath } from "../../src/harness/skills.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function envIn(): Promise<NodeExecutionEnv> {
	const dir = await mkdtemp(join(tmpdir(), "pie-exec-port-"));
	dirs.push(dir);
	return new NodeExecutionEnv({ cwd: dir });
}

describe("stdio semantics of exec", () => {
	// pie: crates/agent/src/harness/env/native.rs
	//      `exec_preserves_stdout_stderr_without_inventing_trailing_newlines`
	//
	// Upstream's comment marks this a regression test: an implementation that reads by line
	// (`lines()`) appends a '\n' to each one, so `printf hello`, which emits no trailing newline,
	// becomes `"hello\n"`. Only reading by chunk preserves exactly what the child wrote.
	// That one byte reaches the model: the bash tool's output is what the model is fed.
	it("when printf emits no trailing newline, neither stdout nor stderr may gain one", async () => {
		const env = await envIn();
		const result = await env.exec("printf hello; printf err 1>&2", {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.exitCode).toBe(0);
		expect(result.value.stdout).toBe("hello");
		expect(result.value.stderr).toBe("err");
	}, 30_000);

	// pie: crates/agent/src/harness/env/native.rs `exec_high_stderr_volume_does_not_deadlock_stdout_drain`
	//
	// The child fills the stderr pipe buffer, typically 64 KiB, before writing anything to stdout. If
	// the two pipes are not drained concurrently, the child blocks forever writing stderr and exec
	// hangs. This case fails as a **timeout**, not as a mismatched assertion.
	it("filling the stderr pipe buffer does not starve stdout into a deadlock", async () => {
		const env = await envIn();
		// Roughly 200 KiB of stderr, well past the typical 64 KiB pipe buffer, before any stdout.
		const cmd = "for i in $(seq 1 4000); do printf 'noise-noise-noise-noise-noise\\n' 1>&2; done; printf done\\n";
		const result = await env.exec(cmd, { timeout: 15_000 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.exitCode).toBe(0);
		expect(result.value.stdout).toContain("done");
		expect(result.value.stderr.length).toBeGreaterThan(64 * 1024);
	}, 40_000);
});

describe("the skills path helpers", () => {
	// pie: crates/agent/src/harness/skills.rs `env_path_helpers`
	// Matches upstream's seven assertions one for one. Two are easy to get wrong: in join, a second
	// segment starting with `/` still concatenates rather than replaces, and `dirname("/c")` is `"/"`,
	// not an empty string.
	it("join, dirname, basename and relative match upstream one for one", () => {
		expect(joinEnvPath("/a/b", "c")).toBe("/a/b/c");
		expect(joinEnvPath("/a/b/", "/c")).toBe("/a/b/c");
		expect(dirnameEnvPath("/a/b/c")).toBe("/a/b");
		expect(dirnameEnvPath("/c")).toBe("/");
		expect(basenameEnvPath("/a/b/c")).toBe("c");
		expect(relativeEnvPath("/root", "/root/a/b")).toBe("a/b");
		expect(relativeEnvPath("/root", "/root")).toBe("");
	});
});
