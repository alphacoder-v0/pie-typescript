import { access, chmod, realpath, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { FileError, getOrThrow } from "../../src/harness/types.ts";
import { executeShellWithCapture } from "../../src/harness/utils/shell-output.ts";
import { createTempDir } from "./session-test-utils.ts";

const chmodRestorePaths: string[] = [];

afterEach(async () => {
	for (const path of chmodRestorePaths.splice(0)) {
		try {
			await access(path);
			await chmod(path, 0o700);
		} catch {}
	}
});

describe("NodeExecutionEnv", () => {
	it("reads, writes, lists, and removes files and directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		expect(getOrThrow(await env.absolutePath("nested/child"))).toBe(join(root, "nested/child"));
		expect(getOrThrow(await env.joinPath([root, "nested", "child"]))).toBe(join(root, "nested", "child"));
		getOrThrow(await env.createDir("nested/child"));
		getOrThrow(await env.writeFile("nested/child/file.txt", "hel"));
		getOrThrow(await env.appendFile("nested/child/file.txt", "lo"));
		expect(getOrThrow(await env.readTextFile("nested/child/file.txt"))).toBe("hello");
		expect(getOrThrow(await env.readTextLines("nested/child/file.txt", { maxLines: 1 }))).toEqual(["hello"]);
		expect(Buffer.from(getOrThrow(await env.readBinaryFile("nested/child/file.txt"))).toString("utf8")).toBe("hello");

		const entries = getOrThrow(await env.listDir("nested/child"));
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			name: "file.txt",
			path: join(root, "nested/child/file.txt"),
			kind: "file",
			size: 5,
		});
		expect(typeof entries[0]!.mtimeMs).toBe("number");

		expect(getOrThrow(await env.exists("nested/child/file.txt"))).toBe(true);
		getOrThrow(await env.remove("nested/child/file.txt"));
		expect(getOrThrow(await env.exists("nested/child/file.txt"))).toBe(false);
	});

	it("returns fileInfo for files, directories, and symlinks without following symlinks", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.createDir("dir", { recursive: true }));
		getOrThrow(await env.writeFile("dir/file.txt", "hello"));
		await symlink(join(root, "dir/file.txt"), join(root, "file-link"));
		await symlink(join(root, "dir"), join(root, "dir-link"));

		expect(getOrThrow(await env.fileInfo("dir"))).toMatchObject({
			name: "dir",
			path: join(root, "dir"),
			kind: "directory",
		});
		expect(getOrThrow(await env.fileInfo("dir/file.txt"))).toMatchObject({
			name: "file.txt",
			path: join(root, "dir/file.txt"),
			kind: "file",
			size: 5,
		});
		expect(getOrThrow(await env.fileInfo("file-link"))).toMatchObject({
			name: "file-link",
			path: join(root, "file-link"),
			kind: "symlink",
		});
		expect(getOrThrow(await env.fileInfo("dir-link"))).toMatchObject({
			name: "dir-link",
			path: join(root, "dir-link"),
			kind: "symlink",
		});
		expect(getOrThrow(await env.canonicalPath("file-link"))).toBe(await realpath(join(root, "dir/file.txt")));
	});

	it("lists symlinks as symlinks", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile("target.txt", "hello"));
		await symlink(join(root, "target.txt"), join(root, "link.txt"));

		const entries = getOrThrow(await env.listDir("."));
		expect(
			entries.map((entry) => ({ name: entry.name, kind: entry.kind })).sort((a, b) => a.name.localeCompare(b.name)),
		).toEqual([
			{ name: "link.txt", kind: "symlink" },
			{ name: "target.txt", kind: "file" },
		]);
	});

	it("stops reading text lines at the requested limit", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile("file.txt", "one\ntwo\nthree"));
		expect(getOrThrow(await env.readTextLines("file.txt", { maxLines: 1 }))).toEqual(["one"]);
	});

	it("returns FileError for missing paths and keeps exists false for missing paths", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const info = await env.fileInfo("missing.txt");
		expect(info.ok).toBe(false);
		if (!info.ok) {
			expect(info.error).toBeInstanceOf(FileError);
			expect(info.error).toMatchObject({
				name: "FileError",
				code: "not_found",
				path: join(root, "missing.txt"),
			});
		}
		expect(getOrThrow(await env.exists("missing.txt"))).toBe(false);
	});

	it("returns FileError for listing non-directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile("file.txt", "hello"));
		const result = await env.listDir("file.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(FileError);
			expect(result.error).toMatchObject({ code: "not_a_directory" });
		}
	});

	it("appends to new files and creates parent directories", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.appendFile("new/nested/file.txt", "a"));
		getOrThrow(await env.appendFile("new/nested/file.txt", "b"));
		expect(getOrThrow(await env.readTextFile("new/nested/file.txt"))).toBe("ab");
	});

	it("creates temporary directories and files", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const tempDir = getOrThrow(await env.createTempDir("node-env-test-"));
		await expect(access(tempDir)).resolves.toBeUndefined();
		const tempFile = getOrThrow(await env.createTempFile({ prefix: "prefix-", suffix: ".txt" }));
		await expect(access(tempFile)).resolves.toBeUndefined();
		expect(tempFile.endsWith(".txt")).toBe(true);
	});

	// pie: env/native.rs:285-302 (create_temp_file) — writes directly into the OS temp root; it
	// does not wrap the file in a freshly-created subdirectory the way create_temp_dir does.
	it("creates temp files directly under the OS temp root, not inside a fresh subdirectory", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const tempFile = getOrThrow(await env.createTempFile({ prefix: "prefix-", suffix: ".txt" }));
		expect(dirname(tempFile)).toBe(tmpdir());
	});

	// pie: env/native.rs:61-68 (file_info_from_meta) — is_symlink is checked first, then
	// is_dir; anything else (sockets, FIFOs, devices) defaults to File. There is no
	// "unsupported file type" error path.
	it("classifies non-file/dir/symlink filesystem entries as file instead of erroring", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const socketPath = join(root, "sock");
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => resolve());
		});
		try {
			const info = getOrThrow(await env.fileInfo("sock"));
			expect(info.kind).toBe("file");
			expect(getOrThrow(await env.exists("sock"))).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	// pie: env/native.rs:94-100 (join_path) — built via PathBuf::push part by part; an
	// absolute part resets the accumulated path instead of being joined onto it, unlike
	// node:path's join, which always concatenates positionally.
	it("joinPath resets to a later absolute part (PathBuf::push semantics)", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const absolutePart = join(root, "abs");
		expect(getOrThrow(await env.joinPath(["ignored", absolutePart, "child"]))).toBe(join(absolutePart, "child"));
		expect(getOrThrow(await env.joinPath(["a", "b", "c"]))).toBe(join("a", "b", "c"));
	});

	it("honors createDir recursive false and remove recursive/force options", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const createResult = await env.createDir("missing/child", { recursive: false });
		expect(createResult.ok).toBe(false);
		if (!createResult.ok) expect(createResult.error).toMatchObject({ code: "not_found" });

		getOrThrow(await env.writeFile("dir/child/file.txt", "hello"));
		const removeDirectory = await env.remove("dir", { recursive: false });
		expect(removeDirectory.ok).toBe(false);
		getOrThrow(await env.remove("dir", { recursive: true }));
		expect(getOrThrow(await env.exists("dir"))).toBe(false);

		const removeMissing = await env.remove("missing", { force: false });
		expect(removeMissing.ok).toBe(false);
		getOrThrow(await env.remove("missing", { force: true }));
	});

	it("returns aborted results for pre-aborted cancellable file operations", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile("file.txt", "hello"));
		const controller = new AbortController();
		controller.abort();
		const signal = controller.signal;

		const results = await Promise.all([
			env.readTextFile("file.txt", signal),
			env.readTextLines("file.txt", { abortSignal: signal }),
			env.readBinaryFile("file.txt", signal),
			env.writeFile("other.txt", "hello", signal),
			env.listDir(".", signal),
		]);
		for (const result of results) {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatchObject({ code: "aborted" });
		}
	});

	it("cleanup is best-effort", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await expect(env.cleanup()).resolves.toBeUndefined();
	});

	it("executes commands in cwd with env overrides", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = getOrThrow(
			await env.exec('printf \'%s:%s\' "$PWD" "$NODE_ENV_TEST"', {
				env: { NODE_ENV_TEST: "ok" },
			}),
		);
		expect(result).toEqual({ stdout: `${await realpath(root)}:ok`, stderr: "", exitCode: 0 });
	});

	it("streams stdout and stderr chunks", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		let stdout = "";
		let stderr = "";
		const result = getOrThrow(
			await env.exec("printf out; printf err >&2", {
				onStdout: (chunk) => {
					stdout += chunk;
				},
				onStderr: (chunk) => {
					stderr += chunk;
				},
			}),
		);
		expect(result).toEqual({ stdout: "out", stderr: "err", exitCode: 0 });
		expect(stdout).toBe("out");
		expect(stderr).toBe("err");
	});

	it("returns non-zero command exit codes as successful execution results", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = getOrThrow(await env.exec("exit 7"));
		expect(result).toEqual({ stdout: "", stderr: "", exitCode: 7 });
	});

	it("returns timeout errors for commands exceeding the timeout", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = await env.exec("sleep 5", { timeout: 0.01 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "timeout" });
	});

	// pie: env/native.rs:589-618 (exec_timeout_kills_backgrounded_descendant_processes, unix
	// only) — the child is spawned in its own session/process group (native.rs: setsid +
	// killpg(SIGKILL); nodejs.ts: `detached: true` + `process.kill(-pid, "SIGKILL")`), so a
	// timeout kills backgrounded descendants too, not just the direct shell.
	it.skipIf(process.platform === "win32")(
		"kills backgrounded descendant processes on timeout, not just the direct shell",
		async () => {
			const root = createTempDir();
			const env = new NodeExecutionEnv({ cwd: root });
			const marker = join(root, "leak-marker");
			const result = await env.exec(`(sleep 4; touch ${marker}) & wait`, { timeout: 1 });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatchObject({ code: "timeout" });

			// Give the (now-orphaned, but killed) descendant time to touch the marker if it
			// somehow survived. If killpg/process-group teardown failed, the marker appears.
			await new Promise((resolve) => setTimeout(resolve, 5000));
			await expect(access(marker)).rejects.toThrow();
		},
		10000,
	);

	it("returns callback errors from exec stream handlers", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = await env.exec("printf out", {
			onStdout: () => {
				throw new Error("callback failed");
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "callback_error", message: "callback failed" });
	});

	it("returns shell unavailable and spawn errors", async () => {
		const root = createTempDir();
		const missingShellEnv = new NodeExecutionEnv({ cwd: root, shellPath: join(root, "missing-shell") });
		const missingShell = await missingShellEnv.exec("printf ok");
		expect(missingShell.ok).toBe(false);
		if (!missingShell.ok) expect(missingShell.error).toMatchObject({ code: "shell_unavailable" });

		const shellPath = join(root, "not-executable-shell");
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile(shellPath, "not executable"));
		const spawnErrorEnv = new NodeExecutionEnv({ cwd: root, shellPath });
		const spawnError = await spawnErrorEnv.exec("printf ok");
		expect(spawnError.ok).toBe(false);
		if (!spawnError.ok) expect(spawnError.error).toMatchObject({ code: "spawn_failed" });
	});

	it("returns an aborted result for aborted commands", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const controller = new AbortController();
		const promise = env.exec("sleep 5", { abortSignal: controller.signal });
		controller.abort();
		const result = await promise;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "aborted" });
	});

	it("captures large shell output to a full output file through the execution env", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const result = getOrThrow(await executeShellWithCapture(env, "yes line | head -n 15000"));
		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeDefined();
		const fullOutput = getOrThrow(await env.readTextFile(result.fullOutputPath!));
		expect(fullOutput.split("\n").length).toBeGreaterThan(10000);
		expect(result.output.length).toBeLessThan(fullOutput.length);
	});
});
