/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { existsSync, readFileSync, writeSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { AsyncQueue } from "@pie/agent-core";
import { type ImageContent, modelsAreEqual } from "@pie/ai";
import { ProcessTerminal, setKeybindings, TUI } from "@pie/tui";
import chalk from "chalk";
import {
	parseBuiltinSkillsConfig,
	resolveBuiltins,
	setEnabledBuiltinSkills,
	UnknownBuiltinSkillError,
} from "./builtin-skills.ts";
import { type Args, type Mode, parseArgs } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { CLI_BIN_NAME, CLI_VERSION, renderCliHelp, shouldPrintDynamicTopLevelHelp } from "./cli/help.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { selectSession } from "./cli/session-picker.ts";
import { USAGE_EXIT_CODE, unexpectedArgument } from "./cli/usage-error.ts";
import { ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, getSessionsDir } from "./config.ts";
import { allowHook, interactiveHook, type UiControlPlanePrompt } from "./control-plane-prompt.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { KeybindingsManager } from "./core/keybindings.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { flushRawStdout, restoreStdout, takeOverStdout, writeRawStdout } from "./core/output-guard.ts";
import { FLAG_TRUST_PROJECT, getTrustStorePath, trustProject } from "./core/project-trust.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import {
	type AutomationCounts,
	automationCountsBadge,
	deleteSessionById,
	listSessionEntries,
	newestSessionPath,
	resolveResumeSessionPath,
	type SessionListEntry,
	SessionManager,
	sessionDirForCwd,
} from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { registryWithBuiltins } from "./core/slash-dispatch.ts";
import { setCommandSink } from "./core/slash-dispatch-deps.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { wrapStreamFn as wrapDebugStreamFn } from "./debug.ts";
import { GoalController } from "./goal-runtime.ts";
import { HistoryStore } from "./history.ts";
import { load as loadHooks } from "./hooks.ts";
import { listCustomModels, loadAll as loadLocalModels } from "./local-models.ts";
import * as logging from "./logging.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { autoDetectModel, credentialLessDefault, NO_API_KEY_ERROR_PREFIX } from "./model.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { resolveSubcommandInvocation } from "./subcommands.ts";
import { loadTriggerSubsystem, TriggerSupervisor } from "./triggers/runtime.ts";
import { triggerToolDefinitions } from "./triggers/tool-definitions.ts";
import { createAppHarness } from "./ui/app-harness.ts";
import type { FeedUpdate } from "./ui/feed.ts";
import { App } from "./ui/index.ts";
import { agentListener, harnessListener } from "./ui/listener.ts";
import { createTerminalDriver } from "./ui/terminal-driver.ts";
import { currentUiMode, type UiMode } from "./ui/ui-mode.ts";
import { type PanelStatus, runWeb } from "./ui/web.ts";
import { describeErrorChain } from "./utils/error-chain.ts";
import { isLocalPath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

type AppMode = "interactive" | "print" | "json" | "rpc";

function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

/**
 * pie: main.rs:1108-1126 (`active_hook_registrations`). Oracle doc: "Real `*Hook` trait
 * registrations active in this binary. Only names that map to an actual `AgentHarness` extension
 * point — so users reading the panel learn what hooks they could plug into."
 *
 * TODO(port): `cli_hooks` is always `false` here — `hooks.ts` (the `HookRunner`) has no importer in
 * this repo, so the CLI never loads user hook files. That is a wiring gap of its own, not a
 * decision this unit makes; the flag is threaded so closing it is a one-line change.
 */
function activeHookRegistrations(lspLangCount: number, cliHooksLoaded: boolean): string[] {
	// pie: main.rs:1112-1116 — the three always-registered points, in oracle's order.
	const points = ["before_tool_call", "on_control_plane_prompt", "before_trigger_action"];
	if (lspLangCount > 0) points.push("after_tool_call");
	if (cliHooksLoaded) points.push("cli_hooks");
	return points;
}

/** pie: main.rs:1128-1138 (`active_trigger_features`) — pipeline behaviours, not pluggable hooks. */
function activeTriggerFeatures(): string[] {
	return ["dedup", "cycle suppress", "fire-once rules", "inject-and-run"];
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, use as-is
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: sessionArg };
	}

	// Try to match as session ID in current project first
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg));

	if (localMatches.length >= 1) {
		return { type: "local", path: localMatches[0].path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll();
	const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg));

	if (globalMatches.length >= 1) {
		const match = globalMatches[0];
		return { type: "global", path: match.path, cwd: match.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/**
 * Oracle's session-listing commands print with `println!`, i.e. real stdout. By the time these
 * run, `takeOverStdout()` has already re-pointed `process.stdout.write` at stderr for every
 * non-interactive mode (and `pie --list-sessions </dev/null` is one), so `console.log` here would
 * land on the wrong stream. `writeRawStdout` is the existing escape hatch back to the real fd.
 */
function printLine(text: string): void {
	writeRawStdout(`${text}\n`);
}

/** pie: main.rs:434-438 — `format!("  [{b}]")` when a badge exists, empty string otherwise. */
function automationBadgeSuffix(counts: AutomationCounts): string {
	const badge = automationCountsBadge(counts);
	return badge ? `  [${badge}]` : "";
}

/**
 * pie: main.rs:425-448 (`list_sessions_cmd`). Oldest → newest, id truncated to 16 chars.
 * `String::chars().take(16)` vs `&e.id[..16]`: both are ASCII-safe for a uuidv7.
 */
async function listSessionsCmd(dir: string): Promise<void> {
	const entries = await listSessionEntries(dir);
	if (entries.length === 0) {
		printLine("(no sessions for this cwd)");
		return;
	}
	printLine(`sessions in ${dir}:`);
	for (const entry of entries) {
		printLine(
			`  ${entry.id.slice(0, 16)}  ${entry.createdAt}${automationBadgeSuffix(entry.automation)}  ${entry.preview ?? ""}`,
		);
	}
}

/**
 * pie: main.rs:453-501 (`list_all_sessions_cmd`) — every cwd-hash bucket under `<base>/sessions/`.
 * A bucket whose listing fails is skipped (`unwrap_or_default`), and the flat result is sorted by
 * session id (uuidv7 ⇒ time-ordered) so the newest is printed last.
 */
async function listAllSessionsCmd(): Promise<void> {
	const root = getSessionsDir();
	if (!existsSync(root)) {
		printLine(`(no sessions root: ${root})`);
		return;
	}
	const buckets = (await readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name))
		.sort();

	const all: Array<{ bucket: string; entry: SessionListEntry }> = [];
	for (const bucket of buckets) {
		let entries: SessionListEntry[];
		try {
			entries = await listSessionEntries(bucket);
		} catch {
			// pie: main.rs:473-474 — "list_entries may return Err if the bucket is empty/malformed;
			// skip those gracefully."
			entries = [];
		}
		for (const entry of entries) all.push({ bucket, entry });
	}
	if (all.length === 0) {
		printLine(`(no sessions found under ${root})`);
		return;
	}
	all.sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
	printLine(`All sessions (${all.length}):`);
	for (const { bucket, entry } of all) {
		const bucketName = basename(bucket) || "?";
		printLine(
			`  ${bucketName}/${entry.id.slice(0, 16)}  ${entry.createdAt}${automationBadgeSuffix(entry.automation)}  ${entry.preview ?? ""}`,
		);
	}
}

/** pie: main.rs:503-507 (`delete_session_cmd`) — delete by id/prefix, then echo the path. */
function deleteSessionCmd(dir: string, id: string): void {
	printLine(`deleted ${deleteSessionById(dir, id)}`);
}

/**
 * pie: main.rs:227-235 — `--list-sessions`, `--list-all-sessions` and `--delete-session <ID>` are
 * checked in that order, immediately after `Cli::parse()`, and each one runs and exits without
 * ever building the REPL. Returns true when one of them handled the run.
 *
 * Each returns `Result`, so a failure (e.g. `--delete-session` with an id nothing matches) leaves
 * `main` as `Err` and anyhow prints `Error: {msg}` on stderr with a non-zero exit.
 */
async function runSessionCliCommands(parsed: Args, cwd: string, sessionDir: string | undefined): Promise<boolean> {
	if (!parsed.listSessions && !parsed.listAllSessions && parsed.deleteSession === undefined) {
		return false;
	}
	try {
		const dir = sessionDir ?? sessionDirForCwd(cwd);
		if (parsed.listSessions) {
			await listSessionsCmd(dir);
		} else if (parsed.listAllSessions) {
			await listAllSessionsCmd();
		} else if (parsed.deleteSession !== undefined) {
			deleteSessionCmd(dir, parsed.deleteSession);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		await flushRawStdout();
		restoreStdout();
		process.exit(1);
	}
	return true;
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		// `--resume <id>` / `--resume-id <id>` select a session just like `--session`, so they
		// conflict with `--fork` for the same reason (see `createSessionManager`).
		parsed.resumeId ? "--resume-id" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	if (parsed.noSession) {
		return SessionManager.inMemory();
	}

	if (parsed.fork) {
		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	// pie: main.rs:206-214 (`effective_resume_id`) — `--resume-id <id>` wins, then `--resume <id>`;
	// bare `--resume` yields nothing and falls through to the picker below. Both spellings land on
	// the skeleton's `--session <path|id>` resolver, which already accepts a full id or a unique
	// prefix — exactly what main.rs:93 documents ("full UUIDv7 or a unique prefix").
	const sessionSelector = parsed.session ?? parsed.resumeId;
	if (sessionSelector) {
		const resolved = await resolveSessionPath(sessionSelector, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return SessionManager.open(resolved.path, sessionDir);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			case "not_found":
				// pie: main.rs:581 → session/mod.rs:81-96 (`resume`). Oracle asks two questions in
				// order and the answers point different ways: "this cwd has no transcripts at all"
				// (`no sessions to resume in <dir>` — open a new one, or you are in the wrong
				// directory) versus "it has some, but not that id" (`no session matches id <id>` —
				// run `--list-sessions` and read the real id off it). Phase 19 F11: this side
				// collapsed both into `No session found matching '<id>'`, which is neither oracle's
				// wording nor this port's own — `--delete-session` has reproduced oracle's second
				// message byte-for-byte all along (`session-manager.ts:2055`), and `Error: ` is the
				// prefix every other failure here carries.
				//
				// `resolveResumeSessionPath` is that ported logic; it throws, and the caller's catch
				// turns the throw into `Error: <msg>` + exit 1 exactly as anyhow does. Only for the
				// two oracle spellings: `--session <path|id>` is skeleton-only (it accepts a path and
				// reaches into other projects), so it keeps its own wording.
				if (parsed.session === undefined) {
					return SessionManager.open(
						resolveResumeSessionPath(sessionDir ?? sessionDirForCwd(cwd), sessionSelector),
						sessionDir,
					);
				}
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selectedPath = await selectSession(
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				SessionManager.listAll,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		// pie: main.rs:586 `session::resume(&repo, None)` → session/mod.rs:83-85, which bails
		// `no sessions to resume in {root}` when the cwd's transcript directory is empty. Phase 19
		// F10: this side answered `pie -c` on a fresh directory with a brand-new empty session, exit
		// 0, nothing on stderr — the user asked to carry on yesterday's conversation and got a blank
		// one with no hint that there had been nothing to carry on.
		//
		// `sessionDirForCwd`, not `getDefaultSessionDir`: naming a directory in an error must not
		// create it (same rule as `--list-sessions`, see that function's comment).
		const continueDir = sessionDir ?? sessionDirForCwd(cwd);
		if (newestSessionPath(continueDir) === null) {
			throw new Error(`no sessions to resume in ${continueDir}`);
		}
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	return SessionManager.create(cwd, sessionDir);
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	} else if (options.thinkingLevel === undefined) {
		// pie: `--thinking` is `[default: off]` in oracle's clap definition (verbatim in the shared
		// `--help` both sides now emit), and `main.rs:718` seeds the harness from
		// `parse_thinking(&cli.thinking)` — i.e. the CLI value, never a settings default.
		//
		// Without this line the CLI fell through to `sdk.ts`'s pi-skeleton chain, which ends at
		// `DEFAULT_THINKING_LEVEL = "medium"` (core/defaults.ts). Parity S3 caught it: every run
		// with no `--thinking` sent `reasoning:{effort:"medium",summary:"auto"}` plus
		// `include:["reasoning.encrypted_content"]` that oracle never sends — extra reasoning
		// tokens billed on every default invocation.
		//
		// Set here rather than by changing DEFAULT_THINKING_LEVEL: that constant is pi's own
		// default for SDK callers (`core/model-resolver.ts:505,519,527`) and has no oracle
		// counterpart to be wrong about. Only the CLI path owes oracle its clap default.
		options.thinkingLevel = "off";
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolve(cwd, value) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
		ui.setClearOnShrink(settingsManager.getClearOnShrink());

		let settled = false;
		const finish = (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			formatMissingSessionCwdPrompt(issue),
			["Continue", "Cancel"],
			(option) => finish(option === "Continue" ? issue.fallbackCwd : undefined),
			() => finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
}

/**
 * pie: main.rs:391-398 (`print_dynamic_help_and_exit_if_requested`) — help on stdout, exit 0.
 *
 * `writeSync` rather than `console.log`: the page is ~3.7 KB and `process.exit` does not flush an
 * async pipe write, which would truncate it under the parity harness (which captures a pipe).
 */
function printCliHelpAndExit(): never {
	writeSync(1, renderCliHelp());
	process.exit(0);
}

/**
 * Answer a terminal command whose output IS oracle's stdout, then exit 0.
 *
 * `takeOverStdout()` (installed below for every non-interactive mode, and `pie --version` piped
 * into anything is one) re-points `process.stdout.write` at stderr so stray console chatter cannot
 * corrupt the machine-readable stdout of `--print`/`--mode json`. Oracle's own stdout surfaces
 * have to opt back out of it, and phase 19's F1 is what happens when one of them forgets:
 * `--version` was still a plain `console.log`, so `V=$(pie --version)` captured the empty string
 * on every non-TTY invocation — CI, install scripts, Dockerfiles, version probes. `--list-models`
 * had the same shape (its whole table went to stderr).
 *
 * So the opt-out lives in exactly one place instead of at each call site: hand fd 1 back, let the
 * command print however it likes (`cli/list-models.ts` uses `console.log` and is not ours to
 * change), flush, exit. `restoreStdout` is safe precisely because every caller exits immediately —
 * nothing later in startup can write to the un-guarded stream.
 *
 * The session-listing commands (`printLine` → `writeRawStdout`) are the other correct pattern for
 * the same problem and stay as they are; they run mid-startup rather than exiting.
 */
async function exitAfterOracleStdout(print: () => void | Promise<void>): Promise<never> {
	restoreStdout();
	await print();
	await flushRawStdout();
	process.exit(0);
}

/**
 * Skeleton-only flags that hand stdout to a machine consumer: `--print`/`-p` and
 * `--mode json|rpc`. Oracle has none of them, so nothing in the oracle contract says where
 * `--help` goes when they are present, and the skeleton's rule (`core/output-guard.ts`'s
 * `takeOverStdout`: everything console-ish moves to stderr so stdout stays parseable) keeps
 * applying — see `test/stdout-cleanliness.test.ts`.
 *
 * Deliberately NOT `resolveAppMode`: that returns "print" whenever stdin is not a TTY, which is
 * true of every piped `pie --help` — including the parity harness's. Only an *explicit* mode flag
 * suppresses oracle's stdout behavior.
 */
function hasSkeletonMachineOutputFlag(args: readonly string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--print" || arg === "-p") {
			return true;
		}
		if (arg === "--mode" && (args[i + 1] === "json" || args[i + 1] === "rpc")) {
			return true;
		}
	}
	return false;
}

export async function main(rawArgs: string[], options?: MainOptions) {
	resetTimings();

	// PORT-DIVERGENCE: B5/B13 (RULEBOOK §5) — `--trust-project` has no oracle counterpart. Oracle
	// reads `<cwd>/.pie/mcp.toml` and `<cwd>/.pie/lsp.toml` with no trust concept at all, so there
	// was nothing to spell; phase 18's default-deny gate needs a way to say yes.
	//
	// It is consumed HERE, ahead of `parseArgs`, and stripped from the argv the rest of `main`
	// sees, for two reasons: (a) `cli/args.ts` and `cli/help.ts` reproduce oracle's clap surface
	// byte-for-byte and feed parity scenario S1 — adding a flag there would change `--help`;
	// (b) `parseArgs`'s unknown-flag fallback treats a following non-flag token as the flag's
	// value, so `pie --trust-project "fix the bug"` would swallow the prompt. Stripping it up
	// front sidesteps both. The flag is therefore absent from `--help` by design.
	//
	// Scope: it trusts `process.cwd()` — the directory you are standing in when you type it. A
	// session whose effective cwd differs (a `--resume` of a session recorded elsewhere) stays
	// gated on ITS own directory. Conservative on purpose: a flag typed in directory A must not
	// silently authorize directory B.
	const trustProjectRequested = rawArgs.includes(FLAG_TRUST_PROJECT);
	const args = trustProjectRequested ? rawArgs.filter((arg) => arg !== FLAG_TRUST_PROJECT) : rawArgs;
	if (trustProjectRequested) {
		const granted = trustProject(process.cwd());
		if (granted.refused !== undefined) {
			// Refused, not failed: `<cwd>/.pie` is the user config dir, so nothing here is gated and
			// the grant would only put `$HOME` in the trust store. Say why — a bare failure would
			// leave the user hunting for a permission problem that does not exist — and carry on
			// with the rest of the run, since nothing about it depended on the grant.
			process.stderr.write(`pie: ${granted.refused}\n`);
		} else if (granted.persisted) {
			// stderr, never stdout: stdout is the machine-readable surface (`--print`, `--mode json`).
			process.stderr.write(`pie: trusted project ${granted.path} (recorded in ${getTrustStorePath()})\n`);
		} else {
			// Persisting failed (read-only HOME, full disk, …). Trust still holds for this run.
			process.stderr.write(
				`pie: trusted project ${granted.path} for this run only; could not write ${getTrustStorePath()}: ${granted.error}\n`,
			);
		}
	}

	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}

	if (await handlePackageCommand(args)) {
		return;
	}

	// Skeleton-only dispatch (`pie config …`), kept from the pi base. Oracle declares no `config`
	// subcommand, so this never appears in `--help` on either side and cannot affect parity S1 —
	// which is exactly why aligning the help surface must not take it out. It was dropped while
	// `--help` was being made oracle-exact; restored here because removing a working skeleton
	// feature is a separate decision from reproducing oracle's help text, and nothing asked for it.
	if (await handleConfigCommand(args)) {
		return;
	}

	// pie: main.rs:217 `print_dynamic_help_and_exit_if_requested()?` — the first statement of
	// oracle's `main`. Help must never build a session, so it is answered before anything reads
	// settings, credentials or the model registry.
	//
	// Ordering note: oracle runs this ahead of *everything*, but the two `handle*Command` guards
	// above own pi-only subcommands (`install`/`remove`/`update`/`list`/`config`) that oracle has
	// no counterpart for at all. Letting them keep their own `--help` pages costs no oracle
	// fidelity — there is no oracle behavior for `pie install --help` to diverge from — while
	// hoisting the guard above them would silently delete those pages.
	if (shouldPrintDynamicTopLevelHelp(args) && !hasSkeletonMachineOutputFlag(args)) {
		printCliHelpAndExit();
	}

	// pie: main.rs:221-223 — `if let Some(command) = &cli.command { return run_cli_command(…) }`,
	// answered before anything else `main` does. Placed here for the same reason: until phase 19
	// nothing recognized `session`/`help`, so `parseArgs` (next statement) filed them under
	// `messages` and the tokens went out to the provider as a chat prompt (finding F2).
	// Dispatching ahead of `parseArgs` is what makes that structurally impossible.
	//
	// Also ahead of `takeOverStdout()`, so the pages reach the real fd 1 without needing the
	// escape hatch F1 is about; `writeSync` rather than `console.log` because `process.exit` does
	// not flush an async pipe write (same reason as `printCliHelpAndExit`).
	const subcommand = resolveSubcommandInvocation(args);
	if (subcommand) {
		writeSync(subcommand.stream, subcommand.text);
		process.exit(subcommand.exitCode);
	}

	const parsed = parseArgs(args);
	// pie: `Cli::parse()` (main.rs:218) — clap prints its own page to stderr and exits 2, and it does
	// so before `main` has done anything. Written with `writeSync` and no `Error: ` prefix because
	// these are clap's bytes, not an anyhow failure: phase 19 F9 found this side answering usage
	// errors with 0 or 1 and F13 found it dropping the `Usage:`/`try '--help'` half entirely, which
	// together made "you typed it wrong" indistinguishable from "it ran and failed".
	if (parsed.usageError !== undefined) {
		writeSync(2, parsed.usageError);
		process.exit(USAGE_EXIT_CODE);
	}
	time("parseArgs");

	// pie: main.rs:550 + :1164-1185 (`validate_base_url_override`). A security guard, and oracle
	// states the reason in the message itself: without an explicit `--provider`, model
	// auto-detection would pick a provider from whatever credentials happen to be in the
	// environment and then aim them at the overridden endpoint. Bail before anything reads a key.
	const baseUrlArg = parsed.baseUrl?.trim();
	if (baseUrlArg && !parsed.provider?.trim()) {
		console.error(
			chalk.red(
				"Error: --base-url requires an explicit --provider so credentials cannot be auto-detected for the wrong endpoint",
			),
		);
		process.exit(1);
	}

	// Oracle flags that `parseArgs` now accepts but whose consumers live in units that have not
	// landed yet. They are parsed (so they stop being swallowed as extension flags and so the
	// consuming unit only has to read `Args`) but are otherwise inert. Each is owned elsewhere:
	//
	// - `parsed.builtinSkills`    pie: main.rs:690-706 — `builtin_skills::resolve_builtins` +
	//   `merge_with_user_project`. HALF landed: the unknown-name hard-fail is wired below (phase 19
	//   F3, search `resolveBuiltins`), because `--help` documents it and it was silently ignored.
	//   Still missing: merging the resolved catalog into the live skill loader, and reading
	//   `~/.pie/config.toml`'s `[builtin_skills] enabled` for the persistent-enable half.
	// - `parsed.images`           pie: main.rs:108 — images attached to the first prompt.
	//
	// TODO(port): fold each into its unit as it lands; this comment is the checklist.
	// (`--list-sessions` / `--list-all-sessions` / `--delete-session` have landed — see
	// `runSessionCliCommands`, dispatched below once `sessionDir` is known.)

	let appMode = resolveAppMode(parsed, process.stdin.isTTY);
	// pie: main.rs:1079-1085 (`should_run_web`) — `--web`/`--tui` are explicit UI selections and
	// oracle honors them whether or not stdin is a terminal (driving `--tui` through a pipe is how
	// the parity harness exercises the REPL at all; `App.run` then falls to `run_headless` on its
	// own, exactly as oracle does). The skeleton's `resolveAppMode` maps *any* non-TTY stdin to
	// `print`, which would swallow both flags, so an explicit selection re-claims the branch. An
	// explicit `--print`/`--mode` still wins — those are skeleton flags oracle does not have, and
	// `hasSkeletonMachineOutputFlag`'s note above explains why they keep priority.
	if ((parsed.web === true || parsed.tui === true) && appMode === "print" && parsed.print !== true) {
		appMode = "interactive";
	}
	// pie: main.rs:1087-1098 (`resolve_ui_mode`), ported in `ui/ui-mode.ts`. Computed here because
	// the control-plane prompt hook below (main.rs:753-768) branches on it, and that hook has to be
	// chosen before the session is built.
	const uiMode: UiMode = currentUiMode({ web: parsed.web === true, tui: parsed.tui === true });
	// pie: main.rs:753-768, condition for condition. `interactive_tui` is oracle's
	// `!run_web && stdin.is_terminal() && stdout.is_terminal()`, and the hook is installed when
	// `interactive_tui || run_web` — i.e. whenever the web UI runs, or whenever both streams are a
	// real terminal. `--tui` over a pipe is therefore NOT interactive (it lands in `run_headless`,
	// which has no confirm surface) and keeps the fail-closed deny `core/sdk.ts` supplies by
	// default. `--always-allow`/`--yes` short-circuit to the blanket allow, as oracle's first arm
	// does. Only the interactive app has a prompt consumer, so `--print`/`--mode` keep the default.
	const interactiveTtyStreams = process.stdin.isTTY === true && process.stdout.isTTY === true;
	const controlPlanePrompts =
		appMode === "interactive" && !parsed.alwaysAllow && !parsed.yes && (uiMode === "web" || interactiveTtyStreams)
			? interactiveHook()
			: undefined;
	const shouldTakeOverStdout = appMode !== "interactive";
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.version) {
		// pie: main.rs:59-63 `#[command(name = "pie", version, …)]` — clap prints `<name> <version>`,
		// where the version is the oracle crate's (see `CLI_VERSION`), not this package's, on STDOUT.
		// The `console.log` this used to be landed on stderr whenever stdin was not a TTY (F1).
		await exitAfterOracleStdout(() => {
			process.stdout.write(`${CLI_BIN_NAME} ${CLI_VERSION}\n`);
		});
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(process.cwd());
	time("runMigrations");

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		parsed.sessionDir ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();

	// pie: main.rs:227-235 — the three session-management commands run and exit before the REPL is
	// built. Placed here (rather than beside `--version`) because they are the first thing that
	// needs `sessionDir`, and still before any session is created, any provider is contacted, or
	// any credential is read.
	// An unknown long flag normally takes the "hold it, let an extension claim it, and report
	// only if nobody does" path. That path exists for the extension mechanism; upstream has no
	// extensions and so reports immediately.
	//
	// But the session management commands exit before extensions are ever loaded, so that
	// check never runs: passing an unknown flag alongside --list-sessions used to exit 0 here
	// and proceed silently, while upstream exits 2. Swallowing a mistyped flag leaves the user
	// believing it took effect.
	//
	// Since no extension can possibly claim it on this path, an unknown flag here is definitely
	// unclaimed, and is reported the same way upstream reports it.
	const unknownForSessionCmd = [...parsed.unknownFlags.keys()];
	if (
		unknownForSessionCmd.length > 0 &&
		(parsed.listSessions || parsed.listAllSessions || parsed.deleteSession !== undefined)
	) {
		// The usage line is context-sensitive: it echoes the command being run rather than the
		// top-level usage. Verified against upstream for each of the three session commands.
		const contextUsage = parsed.listSessions
			? "pie --list-sessions"
			: parsed.listAllSessions
				? "pie --list-all-sessions"
				: "pie --delete-session <ID>";
		writeSync(2, unexpectedArgument(`--${unknownForSessionCmd[0]}`, contextUsage));
		process.exit(USAGE_EXIT_CODE);
	}

	if (await runSessionCliCommands(parsed, cwd, sessionDir)) {
		await flushRawStdout();
		restoreStdout();
		process.exit(0);
	}

	// pie: main.rs:236 `run_repl(cli, cwd, repo).await` returns `Result`, so a failure to open the
	// selected session (e.g. `invalid entry: …` on a transcript corrupted mid-file) leaves
	// `main` as `Err` and anyhow prints `Error: {msg}` on stderr. An unhandled rejection here would
	// instead dump a V8 stack trace, which is neither oracle's wording nor its shape.
	let sessionManager: SessionManager;
	try {
		sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	time("createSessionManager");

	// pie: main.rs:601 — `let logging = logging::init(&session_id);`. Installed as soon as the
	// session id exists and held for the rest of the process (oracle keeps the `WorkerGuard` alive
	// in `main`'s frame; `loggingHandle` is this frame's equivalent). Failure is non-fatal: `init`
	// reports to stderr and returns `undefined`, and every `logging.emit` call becomes a no-op.
	const loggingHandle = logging.init(sessionManager.getSessionId());

	// pie: main.rs:603-612 — the feed channel is created BEFORE the stream backend so the debug
	// wrapper can buffer UI-visible diagnostics even if an LLM call fires during startup.
	// `mpsc::unbounded_channel` -> `AsyncQueue` per RULEBOOK §2.2.
	const feed = new AsyncQueue<FeedUpdate>();
	// pie: main.rs:607-612 — `--debug` swaps the raw backend for the narrating one.
	const wrapStreamFn = parsed.debug
		? (base: Parameters<typeof wrapDebugStreamFn>[0]) => wrapDebugStreamFn(base, feed)
		: undefined;

	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const authStorage = AuthStorage.create();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories: options?.extensionFactories,
			},
		});
		const { settingsManager, modelRegistry, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager, "runtime creation"),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		// pie: main.rs:551 — `let local_models = local_models::load_all(&cwd, cli_base_url.as_deref())
		// .await?;`, run immediately AFTER `validate_base_url_override` (already done at :564 above)
		// and immediately BEFORE model resolution. It reads `~/.pie/models.json` and
		// `<cwd>/.pie/models.json` in oracle's `{"models":[…]}` shape and, when a DS4 base URL is
		// configured (`--base-url`, `DS4_BASE_URL`, or `DS4_URL`), registers the built-in
		// `ds4/deepseek-v4-flash` descriptor. Oracle's registrations land in the `pie_ai` process
		// global that `get_model`/`list_models` read; on this side the equivalent merged view is
		// `ModelRegistry`, so the whole custom registry is published into it here — without this the
		// models exist only in `local-models.ts`'s own map and `--provider ds4` resolves to
		// `Unknown provider "ds4"`.
		//
		// A malformed models.json is FATAL, as oracle's `?` makes it (`run_repl` returns Err, anyhow
		// prints the context chain, exit 1). Phase 19's F6 replaces the warning that used to be here:
		//
		// - The reason was being thrown away. `local-models.ts:153-177` attaches serde's equivalent
		//   detail as `Error.cause`, and only `error.message` was read, so the user got
		//   `parse /home/u/.pie/models.json` with no line, no column and no "what was wrong" —
		//   against oracle's `Caused by: key must be a string at line 1 column 3`. Unfixable as
		//   printed. {@link describeErrorChain} restores the chain in anyhow's shape.
		// - Continuing was the worse half. The custom model table was dropped *silently* and the
		//   session started on a catalog model instead, i.e. a `models.json` whose whole purpose is
		//   to aim a provider at a specific `baseUrl` fails open onto a different endpoint, with
		//   every prompt and file excerpt in the session going there. That is the failure class the
		//   phase-16 `--base-url` note below already calls out as must-fix, and exit 0 means no
		//   script ever notices.
		//
		// The prior TODO(port) argued for warning-only because `ModelRegistry` reads the SAME path
		// in pi's `{"providers":{…}}` shape more permissively. Re-checked: that shape does NOT fail
		// here (`ModelsFileSchema` has an optional `models` key and, like serde, ignores unknown
		// ones), so the overlap is narrower than the TODO assumed — it is comments only, which
		// oracle's serde_json rejects too. Being stricter than oracle is not on the table; being
		// laxer than oracle about which endpoint gets the prompts is worse than a clear startup
		// error that names the file, the reason and the position.
		//
		// The DS4 default is registered before the files are read (local_models.rs:38-64), so a
		// `--base-url` run still has its descriptor even on this path.
		try {
			await loadLocalModels(cwd, parsed.baseUrl);
		} catch (error) {
			diagnostics.push({ type: "error", message: describeErrorChain(error) });
		}
		modelRegistry.setLocalModels(listCustomModels());

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRegistry,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		// pie: main.rs:553-567. Oracle resolves the startup model with `model::auto_detect_model`,
		// and when that fails with the `"no API key found"` error *and* neither --provider nor
		// --model was given, it starts anyway on `model::credential_less_default()` (the catalog's
		// anthropic/claude-haiku-4-5) rather than aborting — so notification-only sessions (e.g.
		// summary-mode webhook endpoints) still work and `/login` can fix things live. The first
		// model turn is what surfaces the auth error.
		//
		// Ordering note: oracle runs auto-detection *before* everything else. Base pi resolves via
		// --model patterns, scoped models, then settings defaults (`findInitialModel`), which is a
		// strictly richer path; this hooks in only where pi comes up empty, so pi's resolution is
		// unchanged and oracle's empty-env outcome is reproduced.
		// TODO(port): env-var priority (CANDIDATES order) does not override a settings default the
		// way oracle's unconditional auto-detect does. Reachable only when settings name a model
		// whose provider has no credential while another candidate's env var IS set.
		//
		// The assignment below is the whole point of the call and phase 19's F4 is what its absence
		// cost: `autoDetectModel` used to be invoked as a throw-probe with its return value dropped,
		// so only the *failure* branch chose a model. With a credential present the call succeeded,
		// nothing was assigned, and the session fell through to the skeleton's own default —
		// `anthropic/claude-opus-4-7` where oracle (`model.rs:9-18`, first candidate
		// `ANTHROPIC_API_KEY` → `claude-haiku-4-5`) starts you on Haiku. Same env, no flags, no
		// warning, an order of magnitude apart in unit price.
		if (!sessionOptions.model && !parsed.provider && !parsed.model) {
			try {
				sessionOptions.model = autoDetectModel(undefined, undefined, {
					modelRegistry,
					authStorage,
					env: process.env,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.startsWith(NO_API_KEY_ERROR_PREFIX)) {
					sessionOptions.model = credentialLessDefault(modelRegistry);
					// pie: main.rs:917-922 — one warning line, verbatim.
					diagnostics.push({
						type: "warning",
						message:
							`${message} Started without a model — chat turns will fail until a key is ` +
							`provided; notification-only features (e.g. webhook endpoints) still work.`,
					});
				} else {
					// pie: main.rs:566 — any other detection failure is fatal.
					diagnostics.push({ type: "error", message });
				}
			}
		}

		// pie: main.rs:568-573 — the per-run `--base-url` override, applied AFTER model resolution
		// (including the credential-less fallback above) so it lands on whatever model was chosen.
		// Trim-then-drop-empty matches oracle's `.map(str::trim).filter(|url| !url.is_empty())`.
		//
		// Found by the phase-16 smoke, not by reading code: the flag was parsed but never consumed,
		// so `--base-url http://127.0.0.1:<fixture>/v1` silently sent the prompt to the REAL OpenAI
		// endpoint (the fixture logged zero requests; the 401 came back from platform.openai.com).
		// A user who believes they are pointed at a local server was not.
		const baseUrlOverride = parsed.baseUrl?.trim();
		if (baseUrlOverride) {
			if (sessionOptions.model) {
				sessionOptions.model = { ...sessionOptions.model, baseUrl: baseUrlOverride };
			}
			if (sessionOptions.scopedModels?.length) {
				sessionOptions.scopedModels = sessionOptions.scopedModels.map((sm) => ({
					...sm,
					model: { ...sm.model, baseUrl: baseUrlOverride },
				}));
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			noTools: sessionOptions.noTools,
			// pie: main.rs:648-655 — the four cron tools then the four dynamic-trigger tools,
			// registered right after the skill family (`tools/index.ts`) and right before the MCP
			// tools (appended inside `createAgentSessionFromServices`).
			customTools: [...(sessionOptions.customTools ?? []), ...triggerToolDefinitions()],
			wrapStreamFn,
			// pie: main.rs:756-768 — oracle's three-way selection, now complete on this side:
			// `--always-allow`/`--yes` → blanket allow; web UI or a real TTY → the interactive queue
			// the REPL drains (`controlPlanePrompts`, decided above); otherwise `undefined`, which
			// falls through to `sdk.ts`'s fail-closed `defaultControlPlanePromptHook()`.
			onControlPlanePrompt:
				parsed.alwaysAllow || parsed.yes ? allowHook() : (controlPlanePrompts?.hook ?? undefined),
		});
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	const { services, session, modelFallbackMessage } = runtime;
	// `resourceLoader` was destructured here for the pi-skeleton help panel, which oracle's
	// clap-shaped `--help` (src/cli/help.ts) replaced. The other destructuring at :649 still uses it.
	const { settingsManager, modelRegistry } = services;
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	// pie: main.rs:598 + :613-619 (load both session sidecars), :691-693 (resolve and apply the
	// dynamic poll interval — `--trigger-poll-secs` beats `[triggers] poll_interval_secs` beats the
	// 600s default), :773-780 (compose the three-layer action hook), :817-825 (MCP push adapters,
	// cron, dynamic checker) and :1032-1037 (the fire-once and cron harness listeners).
	//
	// Loaded unconditionally, as oracle does: the eight cron/trigger tools registered above read
	// `globalCronRegistry()` / `globalRegistry()` lazily at execute time, so a session whose jobs
	// were never loaded would silently report an empty crontab. A missing sidecar is not an error
	// (both readers map ENOENT to "no entries").
	const triggerSubsystem = await loadTriggerSubsystem({
		sessionFile: session.sessionFile,
		agentDir,
		cliPollIntervalSecs: parsed.triggerPollSecs,
		mcp: services.mcp,
	});
	time("loadTriggerSubsystem");

	// The one case the early (oracle) help path above still declines: a skeleton machine-output
	// flag is in play, so the page must follow the skeleton's stdout takeover onto stderr — hence
	// `process.stdout.write`, which `takeOverStdout` reroutes, rather than the early path's
	// `writeSync(1, …)`. See `test/stdout-cleanliness.test.ts`, which pins that behavior.
	//
	// The other case this used to cover — `--help` alongside a declared subcommand token — moved
	// to `subcommands.ts`: `pie session --help` and `pie session import --help` now render
	// oracle's *subcommand* pages on stdout instead of the top-level page on stderr (phase 19 F1/F2).
	if (parsed.help) {
		process.stdout.write(renderCliHelp());
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		// A machine-readable table (`pie --list-models | grep …`), so it belongs on stdout — F1's
		// sibling: the whole 1.7 KB of it was going to stderr because `cli/list-models.ts` prints
		// with `console.log` while the takeover was installed.
		await exitAfterOracleStdout(() => listModels(modelRegistry, searchPattern));
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC.
	//
	// Also skipped when `--web`/`--tui` explicitly selected the UI: on that path stdin belongs to the
	// REPL, which reads it line by line (pie: mod.rs:2029-2032 `run_headless` — the mode
	// `( printf 'hello\n'; sleep 4 ) | pie --tui` exercises). Draining it here would both consume the
	// prompts and flip the mode back to `print`, deleting the very branch the flag asked for.
	let stdinContent: string | undefined;
	const uiSelectedExplicitly = parsed.web === true || parsed.tui === true;
	if (appMode !== "rpc" && !(appMode === "interactive" && uiSelectedExplicitly)) {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	time("resolveModelScope");
	// pie: main.rs:917-922 — the credential-less-start warning is an `app.error_line`, i.e. it belongs
	// in the REPL feed, not on stderr: the full-screen UI is the only terminal writer once it starts,
	// and the headless fallback prints the feed. So on the interactive path the non-fatal diagnostics
	// are held and replayed into the app below; a fatal one still goes to stderr and exits, since
	// there is no app to hold it.
	const startupDiagnostics = runtime.diagnostics;
	// An unknown `--flag` is the one startup diagnostic that is really a *parse* failure: oracle's
	// clap rejects it before `main` runs at all, and only this side has to wait for the extension
	// catalog before it can say the flag is unknown. So it is answered in clap's shape and clap's
	// exit code (2), ahead of the runtime failures below, which are anyhow's `Error: …` + exit 1.
	const usageError = startupDiagnostics.find((diagnostic) => diagnostic.usageError !== undefined)?.usageError;
	if (usageError !== undefined) {
		writeSync(2, usageError);
		process.exit(USAGE_EXIT_CODE);
	}
	const hasFatalDiagnostic = startupDiagnostics.some((diagnostic) => diagnostic.type === "error");
	if (appMode !== "interactive" || hasFatalDiagnostic) {
		reportDiagnostics(startupDiagnostics);
	}
	if (hasFatalDiagnostic) {
		process.exit(1);
	}
	time("createAgentSession");

	// pie: main.rs:698-707 — `builtin_skills::resolve_builtins(&cli.builtin_skill, &config_enabled)`
	// and, on Err, `eprintln!("error: {e}")` + `std::process::exit(2)`. Phase 19's F3: `--help`
	// promises in so many words that "Unknown names hard-fail with a list of available built-ins",
	// and this side accepted anything, said nothing and exited 0 — a typo'd skill name bought you a
	// session that looked fine with the skill switched off, and no way to discover the real names.
	//
	// Placement follows oracle's: inside the REPL path, so `pie --builtin-skill x --list-sessions`
	// still lists sessions (those commands return before `run_repl` on both sides), and after the
	// fatal-diagnostic gate above, so a malformed models.json still wins with its own exit 1.
	// Reached before any provider call, so a typo never costs a network round trip.
	//
	// Both sources, and the result is PUBLISHED rather than discarded — phase 21 closed the other
	// half of this unit. oracle: `resolve_builtins(&cli.builtin_skill, &config_enabled)`
	// (main.rs:698-707): CLI names hard-fail on unknown, config names degrade to a soft startup
	// diagnostic, and the union feeds the skill catalog via `merge_with_user_project`.
	//
	// `parseBuiltinSkillsConfig` already swallows a missing section / malformed TOML into an empty
	// list (builtin_skills.rs:208-218's fail-soft posture), so the read is guarded only against I/O.
	let configEnabledBuiltins: string[] = [];
	try {
		configEnabledBuiltins = parseBuiltinSkillsConfig(readFileSync(join(agentDir, "config.toml"), "utf8"));
	} catch {
		// No config.toml (or unreadable) is the common case, not an error — oracle's
		// `let Ok(text) = read_to_string(&path) else { return default }`.
	}
	try {
		const resolvedBuiltins = resolveBuiltins(parsed.builtinSkills ?? [], configEnabledBuiltins);
		setEnabledBuiltinSkills(resolvedBuiltins.skills);
		// oracle merges at harness-construction time — `merge_with_user_project(resolved.skills,
		// &loaded_skills.skills)` (main.rs:703-706) — i.e. AFTER the on-disk catalog is loaded and
		// AFTER resolution. This side builds the session (and therefore loads the catalog) earlier,
		// so the resolution point has to re-merge explicitly. Without this the registry is
		// populated but nobody re-reads it, and the flag is accepted yet inert — exactly the
		// failure the end-to-end probe caught. Cheap: paths are already resolved, so this is the
		// same skill scan the session just did, not a full `reload()`.
		session.resourceLoader.refreshSkills();
		// This point is past the scope of the diagnostics batch, which was flushed earlier, so
		// unknown configuration keys go to stderr. That matches the upstream behaviour of warning
		// without blocking startup; only the destination differs.
		for (const message of resolvedBuiltins.diagnostics) process.stderr.write(`${message}\n`);
	} catch (error) {
		if (error instanceof UnknownBuiltinSkillError) {
			process.stderr.write(`error: ${error.message}\n`);
			process.exit(2);
		}
		throw error;
	}

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		// pie: main.rs:750-751, 808-811 — the goal stop hook plus its harness cell. Oracle installs
		// both on `AgentHarness`; `GoalController` is the same wiring against `AgentSession`'s
		// `agent_end` turn boundary. Interactive-only, matching oracle's TUI-only CLI.
		// The controller has to exist before the UI (the UI takes it as an option), and its notices
		// have to reach the UI — hence the deferred sink, rebound the moment `interactiveMode` is
		// constructed a few lines down.
		let showSystemLine: (message: string) => void = () => {};
		const goalController = new GoalController({
			session,
			onNotice: (message) => showSystemLine(message),
		});
		// pie: main.rs:1001-1006 — `templates loader: N diagnostic(s), first: <message>`, printed as
		// a system line when `templates::load_all` reported anything. The diagnostics reach here via
		// `ResourceLoader.updatePromptsFromPaths`, which now keeps the loader's findings
		// (resource-loader.ts) instead of discarding them with the plain wrapper.
		const promptLoaderDiagnostics = session.resourceLoader.getPrompts().diagnostics;
		const templateLoaderNotices =
			promptLoaderDiagnostics.length > 0
				? [
						{
							type: "info" as const,
							message: `templates loader: ${promptLoaderDiagnostics.length} diagnostic(s), first: ${promptLoaderDiagnostics[0]?.message ?? ""}`,
						},
					]
				: [];
		const startupNotices = [
			...triggerSubsystem.diagnostics,
			// pie: main.rs:987-989, verbatim.
			...(parsed.debug ? [{ type: "info" as const, message: "debug: LLM call logging is enabled" }] : []),
			...templateLoaderNotices,
		];

		// ── PI_STARTUP_BENCHMARK — the one interactive path that is NOT oracle's ─────────────────
		//
		// A skeleton-only diagnostic (`--help` never mentions it; oracle has no counterpart) that
		// measures how long the pi component-tree UI takes to mount, so it keeps using that UI. It is
		// the only remaining product caller of `InteractiveMode`; every real interactive run below
		// goes to `ui/index.ts`'s `App`, which is oracle's REPL.
		if (startupBenchmark) {
			const interactiveMode = new InteractiveMode(runtime, {
				migratedProviders,
				modelFallbackMessage,
				initialMessage,
				initialImages,
				initialMessages: parsed.messages,
				verbose: parsed.verbose,
				goalController,
				logPath: loggingHandle?.logPath,
				startupNotices,
			});
			showSystemLine = (message) => interactiveMode.showSystemLine(message);
			await interactiveMode.init();
			time("interactiveMode.init");
			printTimings();
			interactiveMode.stop();
			stopThemeWatcher();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		// ── the REPL — pie: main.rs:846-1070 ─────────────────────────────────────────────────────

		// pie: main.rs:849-856 — the slash-command console sink writes `Level::Output` lines into the
		// same feed channel the listeners use, so the full-screen UI stays the only terminal writer.
		setCommandSink((line) => {
			feed.push({ kind: "plain", text: line, level: "output" });
		});
		// pie: main.rs:1027-1029 — agent events become feed updates. Oracle subscribes on
		// `harness.agent()`; the product path's agent is `session.agent`.
		const unsubscribeAgentFeed = session.agent.subscribe(agentListener(feed));

		// pie: main.rs:842（`hooks::load`）+ :1039（`harness.agent().subscribe(hooks.runner.listener())`）。
		//
		// This module previously had no importer at all. It was complete and tests drove it,
		// but nothing on the product path loaded it, so a user's hook configuration never fired.
		// The documentation called it "not wired up", which described the state rather than
		// deciding anything. The decision taken here is to wire it: every piece already fit, and
		// leaving it disconnected would keep a finished capability permanently dead.
		const loadedHooks = await loadHooks(cwd, session.sessionId, session.model, session.thinkingLevel);
		const unsubscribeHooks =
			loadedHooks.runner.length > 0 ? session.agent.subscribe(loadedHooks.runner.listener()) : undefined;
		// pie: main.rs:857 — the inject-and-run channel.
		// TODO(port): nothing pushes to it on this side. Oracle's `TriggerRequestsMainRun` is emitted
		// by `AgentHarness`, which the CLI does not run; `TriggerSupervisor`'s `inject_and_run`
		// delivery goes straight through `session.sendUserMessage`, which already serializes against
		// user input. The channel is wired so `App`'s branch stays live if that changes.
		const mainRunRx = new AsyncQueue<string>();

		// pie: main.rs:869-882 (`ui::PanelStatus { … }`).
		const toolNames = session.getActiveToolNames();
		const panelStatus: PanelStatus = {
			mcp_servers: services.mcp.clientCount,
			mcp_tools: services.mcp.tools.length,
			mcp_server_names: [...services.mcp.serverNames],
			mcp_tool_names: services.mcp.tools.map((tool) => tool.name),
			tool_names: [...toolNames],
			mcp_notification_hooks: services.mcp.notificationHooks.length,
			hook_points: activeHookRegistrations(services.lspSupervisor.languageCount(), false),
			trigger_features: activeTriggerFeatures(),
		};

		// `triggerSupervisor` is built before `app` so the harness view can expose its status/abort
		// surface (`/trigger status`, `/trigger abort`); `app` is built before the supervisor runs, so
		// the error sink below is a late binding rather than a cycle.
		let app: App | undefined;
		// pie: main.rs:817-825 + :1032-1037. Started only once the UI exists so hook diagnostics have
		// somewhere to go, and stopped on exit — every hook's `run()` is an unbounded timer loop that
		// would otherwise keep Node alive past the REPL. `harnessListener` is oracle's
		// `ui::listener::harness_listener`, the second feed producer (main.rs:1030-1031).
		const triggerSupervisor = new TriggerSupervisor({
			hooks: triggerSubsystem.hooks,
			beforeTriggerAction: triggerSubsystem.beforeTriggerAction,
			listeners: [...triggerSubsystem.listeners, harnessListener(feed, parsed.debug === true)],
			parent: session,
			onError: (message) => app?.errorLine(message),
		});
		const appHarness = createAppHarness(session, { agentDir, triggers: triggerSupervisor });

		// pie: main.rs:826-830 — `resumed` decides both the banner tag and the transcript replay.
		const replayMessages = session.messages;
		const resumed = replayMessages.length > 0;
		app = new App({
			harness: appHarness.harness,
			commandHarness: appHarness.harness,
			// pie: main.rs:860 — `RetrySettings::default()`.
			//
			// DEVIATION (deliberate): the wrapper is left disabled on the product path. Oracle has ONE
			// retry loop, `agent_session.rs`'s, which `ui/retry-prompt.ts` ports and `ReplKernel`
			// installs. This repo's runtime is `core/agent-session.ts`, which already implements that
			// loop internally — same classifier (`isRetryableErrorMessage` lives there and
			// `retry-prompt.ts` imports it), same backoff (`retryBackoffMs`). Enabling both would
			// multiply the two budgets (5 × 5 attempts) and re-drive `harness.continue()`, which the
			// product session has no entry point for. `settingsManager.getRetrySettings()` still
			// governs the retries that actually happen — inside `AgentSession`.
			retry: { enabled: false },
			registry: registryWithBuiltins(),
			cwd: session.sessionManager.getCwd(),
			sessionId: session.sessionId,
			logPath: loggingHandle?.logPath,
			toolCount: toolNames.length,
			// pie: main.rs:867 — `history::HistoryStore::load()`.
			history: HistoryStore.load(),
			// pie: main.rs:868 — `std::mem::take(&mut cli.image)`.
			pendingImages: parsed.images ?? [],
			feedRx: feed,
			mainRunRx,
			controlPlanePromptRx: controlPlanePrompts?.prompts as AsyncQueue<UiControlPlanePrompt> | undefined,
			panelStatus,
		});
		showSystemLine = (message) => app?.systemLine(message);

		// pie: main.rs:883 (`app.banner(…)`). Oracle's `display_model` always exists because its
		// resolver falls back to `credential_less_default`; this side can legitimately have none
		// (the `--print`-less credential-less start), so the placeholder stands in for that row only.
		const displayModel = session.model ?? { name: "(no model)", provider: "-", id: "-" };
		app.banner(displayModel, session.sessionId, resumed, toolNames);
		// pie: main.rs:884-1023 — the startup lines, in oracle's order where this side has the same
		// facts. Notices this repo produces but oracle does not (migrated auth providers, the model
		// fallback line) are appended rather than interleaved, so oracle's own sequence is unbroken.
		// pie: main.rs:917-922 — `app.error_line(format!("warning: {warning} …"))`. The `warning: `
		// prefix is oracle's, on top of `error_line`'s own `error: `, so the rendered row reads
		// `error: warning: no API key found. …` exactly as oracle's does.
		// pie: main.rs:904-912, 962-968, 1000-1014 — upstream reports what it loaded, line by line,
		// after the banner. Nothing here did:
		// a user got no confirmation that skills or templates had loaded, and never saw the
		// loader diagnostics — which is exactly the signal you look for when a skill silently
		// has no effect. Without it you can only work backwards from "why is this not working".
		//
		// Order and conditions follow upstream: print only when non-empty, and let the
		// diagnostic line report the count plus the first entry.
		{
			const loadedSkills = services.resourceLoader.getSkills();
			const loadedPrompts = services.resourceLoader.getPrompts();
			if (loadedSkills.skills.length > 0) {
				app.systemLine(
					`loaded ${loadedSkills.skills.length} skill(s): ${loadedSkills.skills.map((s) => s.name).join(", ")}`,
				);
			}
			if (loadedPrompts.prompts.length > 0) {
				app.systemLine(
					`loaded ${loadedPrompts.prompts.length} template(s): ${loadedPrompts.prompts.map((t) => t.name).join(", ")}`,
				);
			}
			if (loadedPrompts.diagnostics.length > 0) {
				app.systemLine(
					`templates loader: ${loadedPrompts.diagnostics.length} diagnostic(s), first: ${loadedPrompts.diagnostics[0].message}`,
				);
			}
			if (loadedSkills.diagnostics.length > 0) {
				app.systemLine(
					`skills loader: ${loadedSkills.diagnostics.length} diagnostic(s), first: ${loadedSkills.diagnostics[0].message}`,
				);
			}
			// pie: main.rs:1015-1020 — the hook load confirmation and diagnostics, printed only when
			// non-empty.
			// This line could not exist until hooks were actually wired up.
			if (loadedHooks.runner.length > 0) {
				app.systemLine(`hooks: loaded ${loadedHooks.runner.length} hook(s)`);
			}
			for (const diagnostic of loadedHooks.diagnostics) {
				app.systemLine(`hooks: ${diagnostic}`);
			}
		}

		for (const diagnostic of startupDiagnostics) {
			if (diagnostic.type === "warning") app.errorLine(`warning: ${diagnostic.message}`);
			else app.systemLine(diagnostic.message);
		}
		for (const diagnostic of startupNotices) {
			if (diagnostic.type === "error") app.errorLine(diagnostic.message);
			else app.systemLine(diagnostic.message);
		}
		if (services.mcp.clientCount > 0) {
			// pie: main.rs:974-979, verbatim.
			app.systemLine(
				`mcp: connected to ${services.mcp.clientCount} server(s), ${services.mcp.tools.length} extra tool(s)`,
			);
		}
		// main.rs:980-985 (`trigger sources: watching …`) and :990-992 (`triggers: local dynamic
		// checker polls …`) are NOT repeated here: `loadTriggerSubsystem` already emits both into
		// `triggerSubsystem.diagnostics`, which the loop above drained.
		//
		// TODO(port): oracle interleaves its startup lines differently (dynamic/cron → templates →
		// mcp → debug → poll interval → lsp → loader diagnostics). This side emits the whole trigger
		// bundle first because that is how `loadTriggerSubsystem` returns it. Every line is present
		// and verbatim; only the order between bundles differs.
		if (services.lspSupervisor.languageCount() > 0) {
			// pie: main.rs:993-997, verbatim.
			app.systemLine(
				`lsp: ${services.lspSupervisor.languageCount()} language(s) configured; diagnostics attach to edit/write results`,
			);
		}
		if (migratedProviders.length > 0) {
			app.systemLine(`migrated ${migratedProviders.length} auth provider(s): ${migratedProviders.join(", ")}`);
		}
		if (modelFallbackMessage) app.systemLine(modelFallbackMessage);
		// pie: main.rs:1021-1023 — the `--resume` transcript, replayed as finished blocks.
		if (resumed) app.replay(replayMessages);
		// The skeleton's initial prompt (positional message / `@file` / piped stdin) has no oracle
		// counterpart — oracle's REPL always starts empty (`Usage: pie [OPTIONS] [COMMAND]`, no
		// positional). Rather than drop a working feature or invent an auto-submit oracle never does,
		// the text is seeded into the input box: visible, editable, one Enter away.
		// TODO(port): revisit if oracle ever grows a positional message.
		if (initialMessage !== undefined && initialMessage.length > 0) {
			app.input.insertStr(initialMessage);
		}
		if (initialImages !== undefined && initialImages.length > 0) {
			app.pendingPastedImages = [...app.pendingPastedImages, ...initialImages];
		}

		printTimings();
		goalController.start();
		triggerSupervisor.start();
		try {
			// pie: main.rs:1058-1069 — `if run_web { app.run_web(…) } else { app.run() }`.
			// `App.run` performs oracle's own `is_terminal()` check and drops to `run_headless`
			// (mod.rs:355-357), which is why the `tui` and `headless` arms differ only in whether the
			// driver is offered at all.
			if (uiMode === "web") {
				await runWeb(app, {
					// pie: main.rs:143-147 — clap's defaults for `--web-host` / `--web-port`.
					host: parsed.webHost ?? "127.0.0.1",
					port: parsed.webPort ?? 0,
				});
			} else if (uiMode === "tui") {
				await app.run(createTerminalDriver());
			} else {
				await app.runHeadless();
			}
		} finally {
			goalController.stop();
			await triggerSupervisor.stop();
			unsubscribeAgentFeed();
			unsubscribeHooks?.();
			appHarness.dispose();
			stopThemeWatcher();
			feed.close();
			mainRunRx.close();
			// The REPL owns the session for its whole life, so tearing it down is this frame's job —
			// the same `runtimeHost.dispose()` `modes/print-mode.ts:44` calls. Without it the session's
			// watchers and extension runtime keep Node's event loop alive after the REPL returns, and
			// `echo … | pie --tui` never exits (oracle exits 0 at EOF).
			await runtime.dispose();
			await loggingHandle?.close();
		}
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		feed.close();
		await loggingHandle?.close();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
