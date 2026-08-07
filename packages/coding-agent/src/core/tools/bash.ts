import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@pie/agent-core";
import { Container, Text, truncateToWidth } from "@pie/tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	// pie: crates/coding-agent/src/tools/bash.rs (DEFINITION.parameters) — description verbatim
	// ("the child", not "the child process tree"), and declared `integer` rather than pi's `number`.
	timeout: Type.Optional(
		Type.Integer({
			description:
				"Timeout in seconds (optional). On timeout the child is killed and any output captured so far is returned.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

/**
 * pie: crates/coding-agent/src/tools/bash.rs:113-117 -- `command`/`exitCode`/`isError` are the
 * oracle's `details` fields verbatim (hand-built via `json!` with these exact camelCase keys).
 * The truncation/full-output fields below have no oracle counterpart -- they are additive pi UX
 * (per-stream truncation + spillover-to-tempfile for recovery) layered after the oracle-shaped
 * text, not part of the wire-critical trio.
 */
export interface BashToolDetails {
	command?: string;
	exitCode?: number;
	isError?: boolean;
	stdoutTruncation?: TruncationResult;
	stderrTruncation?: TruncationResult;
	stdoutFullOutputPath?: string;
	stderrFullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			/**
			 * Called for each chunk of output. `stream` identifies which pipe produced the
			 * chunk. Operations that don't distinguish stdout/stderr may omit it (or always
			 * pass the same value); the bash tool then treats every chunk as stdout, matching
			 * pre-split behavior. The default local implementation always tags chunks.
			 *
			 * pie: crates/coding-agent/src/tools/bash.rs:169-192 -- stdout and stderr are
			 * drained (and later tail-truncated) independently, not merged.
			 */
			onData: (data: Buffer, stream?: "stdout" | "stderr") => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig(options?.shellPath);
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				const child = spawn(shell, [...args, command], {
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				if (child.pid) trackDetachedChildPid(child.pid);
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}
				// Stream stdout and stderr independently so callers can tail-truncate and label
				// each stream on its own (pie: bash.rs:169-192).
				child.stdout?.on("data", (data: Buffer) => onData(data, "stdout"));
				child.stderr?.on("data", (data: Buffer) => onData(data, "stderr"));
				// Handle abort signal by killing the entire process tree.
				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				waitForChildProcess(child)
					.then((code) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						resolve({ exitCode: code });
					})
					.catch((err) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(err);
					});
			});
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

/**
 * pie: crates/coding-agent/src/tools/truncate.rs:17-25 (`Truncation::note`). Oracle only ever
 * computes/shows this note for stdout's truncation state -- bash.rs:89 discards stderr's
 * `Truncation` with `_` -- so callers below only invoke this for the stdout result.
 */
function formatTruncationNote(t: TruncationResult): string {
	return `[truncated: kept ${t.outputLines}/${t.totalLines} lines, ${t.outputBytes} of ${t.totalBytes} bytes]`;
}

/**
 * pie: crates/coding-agent/src/tools/bash.rs:90-108 -- assembles `$ command`, the optional
 * stdout truncation note, the (tail-truncated) stdout body, a `[stderr]`-labeled stderr body,
 * and finally `[exit N]`. `exitCode` is omitted while a command is still running (live preview).
 */
function buildResultText(parts: {
	command: string;
	stdout: string;
	stderr: string;
	stdoutNote?: string;
	exitCode?: number;
}): string {
	let text = `$ ${parts.command}\n`;
	if (parts.stdoutNote) {
		text += `${parts.stdoutNote}\n`;
	}
	if (parts.stdout) {
		text += parts.stdout;
		if (!parts.stdout.endsWith("\n")) text += "\n";
	}
	if (parts.stderr) {
		text += "[stderr]\n";
		text += parts.stderr;
		if (!parts.stderr.endsWith("\n")) text += "\n";
	}
	if (parts.exitCode !== undefined) {
		text += `[exit ${parts.exitCode}]`;
	}
	return text;
}

/**
 * Spill the full (untruncated) stream to a temp file so users can recover output that got
 * tail-truncated. Additive pi UX with no oracle counterpart -- oracle silently drops truncated
 * content (crates/coding-agent/src/tools/truncate.rs has no recovery path).
 */
async function persistFullOutput(prefix: string, text: string): Promise<string> {
	const id = randomBytes(8).toString("hex");
	const path = join(tmpdir(), `${prefix}-${id}.log`);
	await writeFile(path, text, "utf-8");
	return path;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	const rawOutput = getTextOutput(result as any, showImages).trim();
	// The returned content always starts with the "$ <command>" echo line (see
	// buildResultText); renderCall already shows the command above the result, so strip that
	// first line here to avoid displaying it twice. Plain prefix strip, not a heuristic.
	const firstNewline = rawOutput.indexOf("\n");
	const output = firstNewline === -1 ? "" : rawOutput.slice(firstNewline + 1);

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")})`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	const stdoutTruncation = result.details?.stdoutTruncation;
	const stderrTruncation = result.details?.stderrTruncation;
	const stdoutFullOutputPath = result.details?.stdoutFullOutputPath;
	const stderrFullOutputPath = result.details?.stderrFullOutputPath;
	if (stdoutTruncation?.truncated || stderrTruncation?.truncated) {
		const warnings: string[] = [];
		if (stdoutTruncation?.truncated) {
			warnings.push(`stdout: showing ${stdoutTruncation.outputLines} of ${stdoutTruncation.totalLines} lines`);
			if (stdoutFullOutputPath) warnings.push(`full stdout: ${stdoutFullOutputPath}`);
		}
		if (stderrTruncation?.truncated) {
			warnings.push(`stderr: showing ${stderrTruncation.outputLines} of ${stderrTruncation.totalLines} lines`);
			if (stderrFullOutputPath) warnings.push(`full stderr: ${stderrFullOutputPath}`);
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[Truncated. ${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		// pie: crates/coding-agent/src/tools/bash.rs (DEFINITION.description) — verbatim. Oracle
		// advertises `sh -c` and a single combined stdout+stderr section; this implementation still
		// prefers `bash -c` and returns the two streams separately.
		// TODO(port): only the definition is aligned here; the shell choice and the split-section
		// result body are execute-path divergences left for a follow-up unit.
		description: [
			"Run a shell command via `sh -c`. Returns stdout+stderr",
			` (tail-truncated to ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024} KiB) and exit code.`,
			" Optional `timeout` in seconds. Timeouts and cancellations kill the child process;",
			" stdout and stderr are drained concurrently so high-output commands do not deadlock the tool.",
		].join(""),
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);

			// pie: crates/coding-agent/src/tools/bash.rs:169-192 -- stdout and stderr are
			// decoded independently so each can be tail-truncated and labeled on its own,
			// matching the two separate `truncate_tail` calls in `execute()`.
			const stdoutDecoder = new TextDecoder();
			const stderrDecoder = new TextDecoder();
			// PERF(port): unbounded in-memory accumulation, matching oracle's `String` sink
			// (bash.rs reads the whole stream via `read_to_string`). A bounded/streaming
			// variant (like the old single OutputAccumulator) would cap memory for pathological
			// high-output commands; not done here to keep parity with oracle's simple model.
			let stdoutText = "";
			let stderrText = "";

			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const stdoutTail = truncateTail(stdoutText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				const stderrTail = truncateTail(stderrText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				const text = buildResultText({
					command,
					stdoutNote: stdoutTail.truncated ? formatTruncationNote(stdoutTail) : undefined,
					stdout: stdoutTail.content,
					stderr: stderrTail.content,
				});
				onUpdate({
					content: [{ type: "text", text }],
					details: {
						stdoutTruncation: stdoutTail.truncated ? stdoutTail : undefined,
						stderrTruncation: stderrTail.truncated ? stderrTail : undefined,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer, stream?: "stdout" | "stderr") => {
				if (stream === "stderr") {
					stderrText += stderrDecoder.decode(data, { stream: true });
				} else {
					stdoutText += stdoutDecoder.decode(data, { stream: true });
				}
				scheduleOutputUpdate();
			};

			try {
				let exitCode: number | null;
				let stderrSuffix: string | undefined;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					// pie: crates/coding-agent/src/tools/bash.rs:64-120,254-258 -- timeout and
					// cancellation are captured outcomes, not tool errors: `execute()` only
					// returns `Err` when the spawn itself fails. A killed process renders exit
					// -1 (`rendered_exit()`) and the kill reason becomes a marker appended to
					// stderr instead of a thrown error -- so this call still surfaces as
					// `isError: false` at the wire (agent_loop.rs:813-820, mirrored by
					// agent-loop.ts's execute() try/catch around line 863-887). Only a genuine
					// spawn failure (any other rejection) should still throw.
					if (err instanceof Error && err.message === "aborted") {
						exitCode = null;
						stderrSuffix = "[aborted]";
					} else if (err instanceof Error && err.message.startsWith("timeout:")) {
						exitCode = null;
						const timeoutSecs = err.message.slice("timeout:".length);
						stderrSuffix = `[timed out after ${timeoutSecs}s]`;
					} else {
						throw err;
					}
				}

				stdoutText += stdoutDecoder.decode();
				stderrText += stderrDecoder.decode();
				if (stderrSuffix) {
					if (stderrText && !stderrText.endsWith("\n")) stderrText += "\n";
					stderrText += stderrSuffix;
				}

				const stdoutTail = truncateTail(stdoutText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				const stderrTail = truncateTail(stderrText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

				let stdoutFullOutputPath: string | undefined;
				let stderrFullOutputPath: string | undefined;
				if (stdoutTail.truncated) {
					stdoutFullOutputPath = await persistFullOutput("pi-bash-stdout", stdoutText);
				}
				if (stderrTail.truncated) {
					stderrFullOutputPath = await persistFullOutput("pi-bash-stderr", stderrText);
				}

				const renderedExit = exitCode ?? -1;
				let text = buildResultText({
					command,
					stdoutNote: stdoutTail.truncated ? formatTruncationNote(stdoutTail) : undefined,
					stdout: stdoutTail.content,
					stderr: stderrTail.content,
					exitCode: renderedExit,
				});
				if (stdoutFullOutputPath) text += `\n[Full stdout: ${stdoutFullOutputPath}]`;
				if (stderrFullOutputPath) text += `\n[Full stderr: ${stderrFullOutputPath}]`;

				const details: BashToolDetails = {
					command,
					exitCode: renderedExit,
					isError: renderedExit !== 0,
					stdoutTruncation: stdoutTail.truncated ? stdoutTail : undefined,
					stderrTruncation: stderrTail.truncated ? stderrTail : undefined,
					stdoutFullOutputPath,
					stderrFullOutputPath,
				};

				return { content: [{ type: "text", text }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
