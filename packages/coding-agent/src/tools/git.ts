/**
 * Structured `git` tool. Wraps the system `git` binary for a small, common set of read-only
 * sub-operations (status, diff, log). Write/network operations (`push`, `pull`, `commit`) are
 * intentionally NOT exposed here -- they go through `bash` so the permission policy can
 * intercept them.
 *
 * The shape is "JSON in, structured-string out": each subcommand emits a known header line
 * followed by the rendered output, so the LLM can rely on a consistent format without parsing
 * git porcelain.
 *
 * Port of oracle `crates/coding-agent/src/tools/git.rs` (pie @0a120dfd). This tool has no pi
 * base counterpart (pie-only capability) -- manifest fixes the out_path at
 * `packages/coding-agent/src/tools/git.ts` (sibling to, not inside, `core/tools/`), so it is not
 * wired into `core/tools/index.ts`'s default toolset registry; that integration is left to
 * whichever unit assembles the full pie-only coding-agent toolset (memory, task, the skill
 * family, mcp_adapter, the web_ family -- all likewise absent from that registry today).
 */

import type { AgentTool } from "@pie/agent-core";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { wrapToolDefinition } from "../core/tools/tool-definition-wrapper.ts";

// pie: crates/coding-agent/src/tools/git.rs:22
const SUBCOMMANDS = ["status", "diff", "log"] as const;
export type GitSubcommand = (typeof SUBCOMMANDS)[number];

// pie: crates/coding-agent/src/tools/git.rs:23
const MAX_OUTPUT_BYTES = 64 * 1024;

const gitSchema = Type.Object(
	{
		// pie: crates/coding-agent/src/tools/git.rs:166-171 — oracle hand-writes
		// `{"type": "string", "enum": SUBCOMMANDS, "description": ...}`. `Type.Union([Type.Literal
		// ...])` renders as `anyOf: [{const, type}]` instead, which is a different wire schema for
		// the model; `Type.Unsafe` emits oracle's shape verbatim while keeping the static type.
		subcommand: Type.Unsafe<GitSubcommand>({
			type: "string",
			enum: [...SUBCOMMANDS],
			description: "Which git subcommand to run.",
		}),
		args: Type.Optional(
			Type.Array(Type.String(), {
				description: "Extra arguments appended after the defaults (e.g. a file path or revision).",
			}),
		),
		cwd: Type.Optional(
			Type.String({ description: "Optional cwd for the git invocation. Defaults to the agent's cwd." }),
		),
	},
	{ additionalProperties: false },
);

export type GitToolInput = Static<typeof gitSchema>;

/**
 * pie: crates/coding-agent/src/tools/git.rs:113-118 -- oracle hand-builds this `details` object
 * with the literal key `exit_status` (not camelCased, unlike bash.ts's details), so it's kept
 * verbatim here rather than normalized to pi's usual camelCase convention: this is a full port
 * (no base file whose style to follow) and `details` is logs/UI-only, never sent to the model.
 */
export interface GitToolDetails {
	subcommand: GitSubcommand;
	exit_status: number;
	argv: string[];
	truncated: boolean;
}

export interface GitToolOptions {
	/** Path to the git executable. Default: "git" resolved via PATH. */
	gitPath?: string;
}

/**
 * pie: crates/coding-agent/src/tools/git.rs:124-146 -- per-subcommand default flags so output
 * stays structured and bounded; `extra` (the tool call's `args`) is appended after the defaults.
 */
function buildArgv(subcommand: GitSubcommand, extra: readonly string[]): string[] {
	const argv: string[] = [subcommand];
	switch (subcommand) {
		case "status":
			argv.push("--short", "--branch");
			break;
		case "diff":
			argv.push("--no-color", "--no-ext-diff");
			break;
		case "log":
			argv.push("--no-color", "-n", "20", "--pretty=format:%h %ci %an %s");
			break;
	}
	argv.push(...extra);
	return argv;
}

/**
 * Byte-cap truncation that backs off to the nearest UTF-8 character boundary, matching oracle's
 * local `truncate()` helper (git.rs:148-157) exactly. Deliberately NOT the shared
 * `core/tools/truncate.ts` module: oracle's git.rs doesn't use the shared Rust `truncate.rs`
 * either (it's self-contained), and its raw byte-offset truncation (mid-line cuts allowed) has
 * different semantics from `truncate.ts`'s line-oriented `truncateHead`/`truncateTail`.
 */
function truncateGitOutput(text: string): { text: string; truncated: boolean } {
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= MAX_OUTPUT_BYTES) {
		return { text, truncated: false };
	}
	let end = MAX_OUTPUT_BYTES;
	// Back off while `end` sits inside a multi-byte sequence (continuation bytes match 10xxxxxx).
	while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
		end--;
	}
	return { text: buf.subarray(0, end).toString("utf-8"), truncated: true };
}

interface GitRunResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number;
}

/** Spawn git and collect stdout/stderr to completion. Rejects only on a genuine spawn failure. */
function runGit(gitPath: string, argv: string[], cwd: string): Promise<GitRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(gitPath, argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		child.on("error", (err) => {
			// pie: crates/coding-agent/src/tools/git.rs:79-81 ("spawn git: {e}")
			reject(new Error(`spawn git: ${err.message}`));
		});
		child.on("close", (code) => {
			resolve({
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks),
				exitCode: code ?? -1,
			});
		});
	});
}

export function createGitToolDefinition(
	cwd: string,
	options?: GitToolOptions,
): ToolDefinition<typeof gitSchema, GitToolDetails> {
	const gitPath = options?.gitPath ?? "git";
	return {
		name: "git",
		label: "git",
		// pie: crates/coding-agent/src/tools/git.rs:162-163 (verbatim)
		description:
			"Run a read-only git subcommand (status / diff / log) with sensible defaults and structured output. Write/network operations go through bash so the permission policy can intercept them.",
		promptSnippet: "Inspect git status/diff/log with structured output (read-only)",
		parameters: gitSchema,
		// pie: crates/coding-agent/src/tools/git.rs:35-37
		executionMode: "parallel",
		async execute(_toolCallId, { subcommand, args, cwd: cwdArg }, signal, _onUpdate, _ctx) {
			// pie: crates/coding-agent/src/tools/git.rs:46-55 -- defensive re-validation even
			// though the schema already constrains `subcommand` to the enum; kept because
			// oracle re-checks it explicitly (e.g. `prepareArguments` compat shims could bypass
			// schema validation upstream).
			if (!subcommand) {
				throw new Error("missing required arg: subcommand");
			}
			if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
				throw new Error(`unsupported git subcommand: ${subcommand} (allowed: ${SUBCOMMANDS.join(", ")})`);
			}

			const extra = args ?? [];
			const argv = buildArgv(subcommand, extra);
			const resolvedCwd = cwdArg ?? cwd;

			const outputPromise = runGit(gitPath, argv, resolvedCwd);

			let result: GitRunResult;
			if (signal) {
				if (signal.aborted) {
					// pie: crates/coding-agent/src/tools/git.rs:86-88 ("cancelled")
					throw new Error("cancelled");
				}
				let onAbort: (() => void) | undefined;
				// pie: crates/coding-agent/src/tools/git.rs:83-89 -- cancellation abandons the
				// wait via `tokio::select!` without killing the child (no kill_on_drop/killpg
				// here, unlike bash.rs) -- the git process keeps running in the background.
				// Preserved bug-for-bug: this Promise.race never touches `child`.
				const cancelPromise = new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(new Error("cancelled"));
					signal.addEventListener("abort", onAbort, { once: true });
				});
				try {
					result = await Promise.race([outputPromise, cancelPromise]);
				} finally {
					if (onAbort) signal.removeEventListener("abort", onAbort);
				}
			} else {
				result = await outputPromise;
			}

			const stdout = result.stdout.toString("utf-8");
			const stderr = result.stderr.toString("utf-8");
			// pie: crates/coding-agent/src/tools/git.rs:93-102
			const body =
				result.exitCode !== 0
					? `git ${subcommand} exited with status ${result.exitCode}\n--- stderr ---\n${stderr.trim()}`
					: stdout;
			const { text: truncatedBody, truncated } = truncateGitOutput(body);

			// pie: crates/coding-agent/src/tools/git.rs:105 -- the header echoes the raw `cwd`
			// arg as given (defaulting the *display* to "."), not the resolved directory that
			// actually ran -- oracle only calls `current_dir()` when the caller passed `cwd`,
			// so an omitted `cwd` runs in the process's own inherited cwd while still printing
			// ".". Preserved bug-for-bug.
			const header = `git ${subcommand} (cwd=${cwdArg ?? "."})\n`;
			const suffix = truncated ? `\n\n(truncated at ${MAX_OUTPUT_BYTES / 1024} KiB)` : "";

			const details: GitToolDetails = {
				subcommand,
				exit_status: result.exitCode,
				argv,
				truncated,
			};

			return {
				content: [{ type: "text", text: `${header}${truncatedBody}${suffix}` }],
				details,
			};
		},
	};
}

export function createGitTool(cwd: string, options?: GitToolOptions): AgentTool<typeof gitSchema> {
	return wrapToolDefinition(createGitToolDefinition(cwd, options));
}
