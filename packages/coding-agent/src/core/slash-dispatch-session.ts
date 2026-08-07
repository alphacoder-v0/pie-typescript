/**
 * The session / model / goal / transcript command family of oracle
 * `crates/coding-agent/src/commands.rs` (pie @0a120dfd) — everything the skill family
 * (`slash-dispatch-skills.ts`) and the automation family (`slash-dispatch-triggers.ts`) do not own.
 *
 * pie, in registration order: `ClearCommand` (:328), `QuitCommand` (:855), `ModelCommand` (:873),
 * `ThinkingCommand` (:968), `GoalCommand`/`GoalStartCommand` (:1004-1125), `CostCommand` (:1392),
 * `DiagCommand` (:1417), `TemplateCommand` (:1462), `SaveCommand` (:1505), `CompactCommand`
 * (:1541), `UndoCommand` (:1564), `BugReportCommand` (:1609), `NameCommand` (:1656),
 * `SessionCommand` (:1694-1843), `WebConnectCommand`/`WebDisconnectCommand` (:1845-1880),
 * `SessionsCommand` (:1882), `ShareCommand` (:1912), `LoginCommand` (:1968), `LogoutCommand`
 * (:2014), `FindCommand` (:2052), `HistoryCommand` (:2131). The model-catalog renderers
 * (:1264-1390) live here too because `/help`'s general text embeds their summary lines.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { AgentMessage, Session, SessionTreeEntry, ThinkingLevel } from "@pie/agent-core";
import { fullBreakdown, oneLineSummary } from "@pie/agent-core";
import { envVarNames, listModels, type Model } from "@pie/ai";
import * as bugReport from "../bug-report.ts";
import { getAuthPath } from "../config.ts";
import * as exporter from "../export.ts";
import * as goal from "../goal.ts";
import type { GoalHarness } from "../goal-deps.ts";
import { HistoryStore } from "../history.ts";
import { listCustomModels } from "../local-models.ts";
import * as sessionArchive from "../session-archive.ts";
import { AuthStorage } from "./auth-storage.ts";
import {
	getDefaultSessionDir,
	listSessionEntries,
	listSessionTranscriptPaths,
	sessionMessageTexts,
} from "./session-manager.ts";
import { LOGIN_USAGE_ERROR, parseModelSpec, THINKING_LEVEL_VALUES } from "./slash-commands.ts";
import {
	type CommandCtx,
	type CommandOutcome,
	commandError,
	emitCommandLine,
	emitCommandLines,
	HANDLED,
	previewText,
	shortId,
	yesNo,
} from "./slash-dispatch-deps.ts";

/* -------------------------------------------------------------------------------------------
 * Trivial outcomes — pie: commands.rs:328-341, 855-871, 1845-1880.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:338-340 (`ClearCommand::run`) — the REPL owns the ANSI escape. */
export async function runClearCommand(): Promise<CommandOutcome> {
	return { kind: "clear_screen" };
}

/** pie: commands.rs:868-870 (`QuitCommand::run`). Aliases `/exit` and `/q` reach the same run. */
export async function runQuitCommand(): Promise<CommandOutcome> {
	return { kind: "quit" };
}

/** pie: commands.rs:1858-1863 (`WebConnectCommand::run`). */
export async function runWebConnectCommand(argv: readonly string[]): Promise<CommandOutcome> {
	const sub = argv[0];
	if (sub === undefined) return { kind: "web_relay", action: "connect" };
	if (sub === "status") return { kind: "web_relay", action: "status" };
	return commandError(`unknown /web-connect argument: ${sub}`);
}

/** pie: commands.rs:1877-1879 (`WebDisconnectCommand::run`). */
export async function runWebDisconnectCommand(): Promise<CommandOutcome> {
	return { kind: "web_relay", action: "disconnect" };
}

/* -------------------------------------------------------------------------------------------
 * /thinking — pie: commands.rs:968-1002.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:981-1000 (`ThinkingCommand::run`). */
export async function runThinkingCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	if (argv.length === 0) {
		emitCommandLine(`thinking level: ${ctx.harness.getThinkingLevel() ?? "?"}`);
		return HANDLED;
	}
	const raw = (argv[0] as string).toLowerCase();
	if (!(THINKING_LEVEL_VALUES as readonly string[]).includes(raw)) {
		// pie: commands.rs:990-992 wraps `ThinkingLevel: FromStr`'s own Err text in "invalid level: ".
		return commandError(`invalid level: unknown thinking level: ${raw}`);
	}
	try {
		await ctx.harness.setThinkingLevel(raw as ThinkingLevel);
		emitCommandLine(`thinking level: ${raw}`);
		return HANDLED;
	} catch (error) {
		return commandError(`set_thinking_level failed: ${errorText(error)}`);
	}
}

/* -------------------------------------------------------------------------------------------
 * /goal + /goal-start — pie: commands.rs:1004-1125.
 * ----------------------------------------------------------------------------------------- */

/**
 * `goal.ts`'s exported functions take a `GoalHarness` (`goal-deps.ts`). `CommandHarness.session()`
 * already satisfies `GoalHarnessSession` member-for-member; `runEvaluator` is only reachable from
 * `goal.stopHook`, which the slash commands never call, so it is wired to a throw rather than
 * widening `CommandHarness` with a member no command uses.
 */
function goalHarnessFor(ctx: CommandCtx): GoalHarness {
	return {
		session: () => ctx.harness.session(),
		getModel: () => ctx.harness.getModel() as Model<any>,
		runEvaluator: () => {
			// TODO(port): unreachable from the slash path — only `goal.stopHook` calls this, and the
			// REPL registers that hook against the real harness, not against this adapter.
			throw new Error("runEvaluator is not reachable from the slash-command goal path");
		},
	};
}

/** pie: commands.rs:1006-1008 (`goal_start_prompt`). */
function goalStartPrompt(argv: readonly string[]): string {
	return argv.join(" ").trim();
}

/** pie: commands.rs:1010-1025 (`run_goal_start`). */
async function runGoalStart(prompt: string, ctx: CommandCtx): Promise<CommandOutcome> {
	if (prompt === "") return commandError("usage: /goal-start <prompt>");
	const state = await goal.current(goalHarnessFor(ctx));
	if (state === undefined || !goal.isGoalActive(state)) {
		return commandError("no active goal; set one with /goal <condition>");
	}
	return { kind: "run_agent_prompt", prompt, errorContext: "goal start: " };
}

/** pie: commands.rs:1041-1086 (`GoalCommand::run`). */
export async function runGoalCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	const harness = goalHarnessFor(ctx);
	const sub = argv[0];
	if (sub === undefined) {
		await printGoalStatus(ctx);
		return HANDLED;
	}
	try {
		if (sub === "pause" && argv.length === 1) {
			const state = await goal.pause(harness);
			emitCommandLine(`goal paused: ${state.condition}`);
			return HANDLED;
		}
		if (sub === "resume" && argv.length === 1) {
			const state = await goal.resume(harness);
			emitCommandLine(`goal resumed: ${state.condition}`);
			return HANDLED;
		}
		if (sub === "clear" && argv.length === 1) {
			await goal.clear(harness);
			emitCommandLine("goal cleared");
			return HANDLED;
		}
		if (sub === "start") {
			return await runGoalStart(goalStartPrompt(argv.slice(1)), ctx);
		}
		// pie: commands.rs:1069-1085 — anything else is the goal condition itself, including a
		// multi-word phrase starting with `pause`/`resume`/`clear` (the `argv.len() == 1` guards).
		const condition = argv.join(" ").trim();
		if (condition === "") return commandError("usage: /goal <condition>");
		const state = await goal.set(harness, condition);
		emitCommandLine(`goal set: ${state.condition}`);
		emitCommandLine(
			"goal will continue after each successful turn until transcript evidence satisfies the condition",
		);
		emitCommandLine("start by sending a normal prompt, or run /goal-start <prompt>");
		return HANDLED;
	} catch (error) {
		return commandError(errorText(error));
	}
}

/** pie: commands.rs:1106-1108 (`GoalStartCommand::run`). */
export async function runGoalStartCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	return runGoalStart(goalStartPrompt(argv), ctx);
}

/** pie: commands.rs:1111-1125 (`print_goal_status`). */
async function printGoalStatus(ctx: CommandCtx): Promise<void> {
	const state = await goal.current(goalHarnessFor(ctx));
	if (state !== undefined && (goal.isGoalActive(state) || state.status === "achieved")) {
		emitCommandLine(`goal: ${state.condition}`);
		emitCommandLine(`status: ${state.status}`);
		emitCommandLine(`iterations: ${state.iterations}`);
		if (state.last_reason !== undefined) {
			emitCommandLine(`last evaluator reason: ${previewText(state.last_reason, 240)}`);
		}
		return;
	}
	emitCommandLine("no active goal; set one with /goal <condition>");
}

/* -------------------------------------------------------------------------------------------
 * /model + the model catalog renderers — pie: commands.rs:873-966 + 1264-1390.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:886-924 (`ModelCommand::run`). */
export async function runModelCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	if (argv.length === 0) return { kind: "open_model_picker" };
	if (argv[0] === "list" || argv[0] === "ls") {
		const text = modelCatalogText(argv[1]);
		if ("error" in text) return commandError(text.error);
		emitCommandLines(text.text);
		return HANDLED;
	}
	const spec = parseModelSpec(argv.join(" "));
	if (spec === undefined) {
		return commandError(
			"expected provider:model-id (provider/model-id also works), e.g. /model anthropic:claude-haiku-4-5",
		);
	}
	// pie: commands.rs:965 — `pie_ai::get_model(&provider, id)`, which checks the custom registry
	// FIRST and only then the built-in table (`crates/ai/src/models.rs:23-32`).
	const model = mergedModels().find((m) => m.provider === spec.provider && m.id === spec.id);
	if (model === undefined) return commandError(unknownModelError(spec.provider, spec.id));
	try {
		await ctx.harness.setModel(model);
		const hint = modelCredentialHint(spec.provider);
		if (hint !== undefined) {
			emitCommandLine(`selected ${spec.provider}:${spec.id}, but login is required: ${hint}`);
		} else {
			emitCommandLine(`switched to ${spec.provider}:${spec.id}`);
		}
		return HANDLED;
	} catch (error) {
		return commandError(`set_model failed: ${errorText(error)}`);
	}
}

/** pie: commands.rs:941-966 (`model_credential_hint`). */
export function modelCredentialHint(provider: string): string | undefined {
	const vars = envVarNames(provider);
	if (vars.some((name) => (process.env[name] ?? "").trim() !== "")) return undefined;
	try {
		if (AuthStorage.create().get(provider) !== undefined) return undefined;
	} catch {
		// pie: commands.rs:952 (`AuthStore::load().ok()`) — an unreadable store means "no credential".
	}
	const envHint = vars.length === 0 ? "set the provider API key env var" : `set ${vars.join(" or ")}`;
	return `${envHint} or run /login ${provider}`;
}

/**
 * Merged model view: built-in catalog + the process-local custom registry.
 *
 * pie: `crates/ai/src/models.rs:35-39` — oracle's `list_models()` is
 * `BUILTIN_MODELS.iter().cloned().chain(custom_registry().values().cloned())`, so every consumer
 * of `list_models` (including `/model` and `/model list`) sees custom models. `packages/ai` has no
 * mutable registry (see `local-models.ts`'s `TODO(port)` — the registry lives in `coding-agent`
 * until `ai/models` lands its mutable-registry design), so `@pie/ai`'s `listModels()` returns the
 * built-in half only and the merge has to happen at each call site that stands in for oracle's
 * `list_models`.
 *
 * Without this merge `/model list my-provider` answered `unknown provider` and
 * `/model my-provider:my-id` answered `unknown model in catalog` for any model declared in
 * `~/.pie/models.json` — `main.ts:1085`'s `modelRegistry.setLocalModels(...)` publishes the
 * registry into `ModelRegistry` (which startup resolution reads) but the `/model` command path
 * never consults `ModelRegistry`. Startup `--provider`/`--model` worked; runtime switching did not.
 */
function mergedModels(): Model<any>[] {
	// Custom FIRST. `list_models` chains builtin-then-custom, but the only order-sensitive consumer
	// is the `(provider, id)` lookup below, and there oracle goes through `get_model`, which checks
	// the custom registry BEFORE the built-in table (`models.rs:23-32`) — a custom entry shadows a
	// built-in with the same key. Chaining builtin-first plus `.find()` would invert that.
	// `modelGroups` re-sorts, so the chain order is immaterial on the listing path.
	return [...listCustomModels(), ...listModels()];
}

/** pie: commands.rs:1331-1343 (`model_groups`) — `BTreeMap`, so providers sort lexicographically
 * and each group's models sort by id. */
function modelGroups(): Map<string, Model<any>[]> {
	const groups = new Map<string, Model<any>[]>();
	for (const model of mergedModels()) {
		const bucket = groups.get(model.provider);
		if (bucket) bucket.push(model);
		else groups.set(model.provider, [model]);
	}
	for (const models of groups.values()) models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return new Map([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** pie: commands.rs:1345-1351 (`provider_summary`). */
function providerSummary(groups: Map<string, Model<any>[]>): string {
	return [...groups.entries()].map(([provider, models]) => `${provider}(${models.length})`).join(", ");
}

/** pie: commands.rs:1281-1295 (`model_help_summary_lines`). */
export function modelHelpSummaryLines(): string[] {
	const groups = modelGroups();
	const total = [...groups.values()].reduce((sum, models) => sum + models.length, 0);
	return [
		`  Supported providers (${groups.size}), models (${total}): ${providerSummary(groups)}`,
		"  Full list: /help models or /model list [provider]",
		"  Custom models: ~/.pie/models.json and <cwd>/.pie/models.json",
		"  Credentials: set provider env vars or run /login <provider>.",
	];
}

/** pie: commands.rs:1353-1361 (`append_model_lines`). */
function appendModelLines(out: string[], models: readonly Model<any>[]): void {
	for (const model of models) {
		if (model.name.trim() === "" || model.name === model.id) out.push(`    - ${model.id}`);
		else out.push(`    - ${model.id} — ${model.name}`);
	}
}

/** pie: commands.rs:1297-1329 (`model_catalog_text`). */
export function modelCatalogText(providerFilter: string | undefined): { text: string } | { error: string } {
	const groups = modelGroups();
	const total = [...groups.values()].reduce((sum, models) => sum + models.length, 0);
	const out: string[] = [];
	if (providerFilter !== undefined) {
		const models = groups.get(providerFilter);
		if (models === undefined) return { error: unknownProviderError(providerFilter, groups) };
		out.push(`Supported models for provider '${providerFilter}' (${models.length}):`);
		appendModelLines(out, models);
	} else {
		out.push(`Supported providers/models: ${groups.size} providers, ${total} models`);
		out.push("Custom models are loaded from ~/.pie/models.json and <cwd>/.pie/models.json.");
		for (const [provider, models] of groups) {
			out.push(`  ${provider} (${models.length})`);
			appendModelLines(out, models);
		}
	}
	return { text: out.join("\n") };
}

/** pie: commands.rs:1363-1368 (`unknown_provider_error`). */
function unknownProviderError(provider: string, groups: Map<string, Model<any>[]>): string {
	return `unknown provider '${provider}'. Known providers: ${providerSummary(groups)}`;
}

/** pie: commands.rs:1370-1390 (`unknown_model_error`). */
function unknownModelError(provider: string, id: string): string {
	const groups = modelGroups();
	const models = groups.get(provider);
	if (models === undefined) return unknownProviderError(provider, groups);
	const candidates = models
		.slice(0, 12)
		.map((m) => m.id)
		.join(", ");
	const more = models.length > 12 ? `; run /model list ${provider} for all ${models.length} models` : "";
	return `unknown model in catalog: ${provider}:${id}. Candidates: ${candidates}${more}`;
}

/** pie: commands.rs:1264-1273 (`cli_model_help_text`). */
export function cliModelHelpText(): string {
	let out = "Model catalog:\n";
	for (const line of modelHelpSummaryLines()) out += `  ${line.replace(/^\s+/, "")}\n`;
	return out;
}

/* -------------------------------------------------------------------------------------------
 * /cost + /diag + /bug-report — pie: commands.rs:1392-1460 + 1609-1654.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:1405-1413 (`CostCommand::run`). */
export async function runCostCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	if (argv[0] === "reset") {
		ctx.harness.resetCost();
		emitCommandLine("cost counters reset");
		return HANDLED;
	}
	emitCommandLine(fullBreakdown(ctx.harness.cost()));
	return HANDLED;
}

/** pie: commands.rs:1427-1458 (`DiagCommand::run`). Column padding is oracle's, verbatim. */
export async function runDiagCommand(ctx: CommandCtx): Promise<CommandOutcome> {
	const model = ctx.harness.getModel();
	const modelText = model === undefined ? "(none)" : `${model.provider}:${model.id}`;
	const thinking = ctx.harness.getThinkingLevel() ?? "?";
	emitCommandLine("");
	emitCommandLine("Diagnostic snapshot:");
	emitCommandLine(`  session       ${ctx.sessionId}`);
	emitCommandLine(`  model         ${modelText}`);
	emitCommandLine(`  thinking      ${thinking}`);
	emitCommandLine(`  tools         ${ctx.toolCount}`);
	emitCommandLine(`  skills        ${ctx.harness.skills().length}`);
	emitCommandLine(`  cost          ${oneLineSummary(ctx.harness.cost())}`);
	emitCommandLine(`  log file      ${ctx.logPath ?? "(logging disabled)"}`);
	emitCommandLine("");
	return HANDLED;
}

/** pie: commands.rs:1619-1653 (`BugReportCommand::run`). */
export async function runBugReportCommand(ctx: CommandCtx): Promise<CommandOutcome> {
	const model = ctx.harness.getModel();
	const diag: bugReport.DiagInputs = {
		sessionId: ctx.sessionId,
		model: model === undefined ? undefined : `${model.provider}:${model.id}`,
		thinking: ctx.harness.getThinkingLevel() ?? "?",
		toolCount: ctx.toolCount,
		skillCount: ctx.harness.skills().length,
		costSummary: oneLineSummary(ctx.harness.cost()),
		logPath: ctx.logPath,
	};
	try {
		const path = await bugReport.build(diag, nominalSession(ctx), bugReport.defaultDest());
		emitCommandLine(`wrote bug report: ${path}`);
		return HANDLED;
	} catch (error) {
		return commandError(`bug-report failed: ${errorText(error)}`);
	}
}

/* -------------------------------------------------------------------------------------------
 * /template + /compact — pie: commands.rs:1462-1562.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:1475-1502 (`TemplateCommand::run`). Returns rather than running the agent —
 * the REPL owns Ctrl-C. */
export async function runTemplateCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	if (argv.length === 0) {
		const templates = ctx.harness.templates();
		if (templates.length === 0) {
			emitCommandLine("(no templates loaded — drop `.md` files under ~/.pie/templates/ or <cwd>/.pie/templates/)");
		} else {
			emitCommandLine(`Loaded templates (${templates.length}):`);
			for (const t of templates) emitCommandLine(`  /template ${t.name}  ${t.description ?? ""}`);
		}
		return HANDLED;
	}
	const name = argv[0] as string;
	const vars: Record<string, unknown> = {};
	for (const arg of argv.slice(1)) {
		const at = arg.indexOf("=");
		if (at === -1) return commandError(`expected k=v argument; got: ${arg}`);
		vars[arg.slice(0, at)] = arg.slice(at + 1);
	}
	return { kind: "run_prompt_template", name, vars };
}

/** pie: commands.rs:1554-1561 (`CompactCommand::run`). */
export async function runCompactCommand(argv: readonly string[]): Promise<CommandOutcome> {
	return { kind: "run_compaction", custom: argv.length === 0 ? undefined : argv.join(" ") };
}

/* -------------------------------------------------------------------------------------------
 * /undo + /name — pie: commands.rs:1564-1692.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:1574-1605 (`UndoCommand::run`). */
export async function runUndoCommand(ctx: CommandCtx): Promise<CommandOutcome> {
	const session = ctx.harness.session();
	let path: SessionTreeEntry[];
	try {
		path = await session.getBranch();
	} catch (error) {
		return commandError(`read branch: ${errorText(error)}`);
	}
	// pie: commands.rs:1580-1595 — walk backwards for the most recent LLM *user* message; that
	// message starts the turn being dropped, so the new leaf is its parent.
	let targetParent: string | null = null;
	let found = false;
	for (let i = path.length - 1; i >= 0; i -= 1) {
		const entry = path[i] as SessionTreeEntry;
		if (entry.type === "message" && (entry.message as AgentMessage).role === "user") {
			targetParent = entry.parentId;
			found = true;
			break;
		}
	}
	if (!found) return commandError("no user message to undo");
	try {
		await session.moveTo(targetParent);
		emitCommandLine("undid last turn");
		return HANDLED;
	} catch (error) {
		return commandError(`undo failed: ${errorText(error)}`);
	}
}

/** pie: commands.rs:1669-1691 (`NameCommand::run`). */
export async function runNameCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	const session = ctx.harness.session();
	if (argv.length === 0) {
		try {
			const name = await session.getSessionName();
			emitCommandLine(name === undefined ? "(unnamed session)" : `session name: ${name}`);
		} catch (error) {
			return commandError(`read name: ${errorText(error)}`);
		}
		return HANDLED;
	}
	const trimmed = argv.join(" ").trim();
	if (trimmed === "") return commandError("empty name");
	try {
		await session.appendSessionName(trimmed);
		emitCommandLine(`session name set to: ${trimmed}`);
		return HANDLED;
	} catch (error) {
		return commandError(`set name failed: ${errorText(error)}`);
	}
}

/* -------------------------------------------------------------------------------------------
 * /session export|import — pie: commands.rs:1694-1843.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:1707-1719 (`SessionCommand::run`). */
export async function runSessionCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	switch (argv[0]) {
		case "export":
			return sessionExportCommand(argv.slice(1), ctx);
		case "import":
			return sessionImportCommand(argv.slice(1), ctx);
		case undefined:
			return commandError("usage: /session export [path] [--exclude-triggers] | /session import <path>");
		default:
			return commandError(
				`unknown /session subcommand: ${argv[0]}; use /session export [path] or /session import <path>`,
			);
	}
}

/** pie: commands.rs:1722-1778 (`session_export_command`). */
async function sessionExportCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	let excludeTriggers = false;
	let pathArg: string | undefined;
	for (const arg of argv) {
		if (arg === "--exclude-triggers") excludeTriggers = true;
		else if (pathArg === undefined) pathArg = arg;
		else return commandError("usage: /session export [path] [--exclude-triggers]");
	}

	let metadata: { path?: string };
	try {
		metadata = (await ctx.harness.session().getStorage().getMetadata()) as { path?: string };
	} catch (error) {
		return commandError(`read session metadata: ${errorText(error)}`);
	}
	const sessionPath = metadata.path;
	if (typeof sessionPath !== "string") {
		return commandError("session metadata is missing transcript path");
	}
	const requested = pathArg ?? sessionArchive.defaultExportPath(ctx.cwd, ctx.sessionId);
	const outputPath = isAbsolute(requested) ? requested : join(ctx.cwd, requested);

	emitSessionArchiveWarning();
	try {
		const summary = await sessionArchive.exportSession(sessionPath, outputPath, excludeTriggers);
		emitCommandLine(`exported session archive: ${summary.outputPath}`);
		emitCommandLine(
			`session ${shortId(summary.sessionId)} entries=${summary.entryCount} ` +
				`triggers=${yesNo(summary.hasTriggers)} cron=${yesNo(summary.hasCron)}`,
		);
		return HANDLED;
	} catch (error) {
		return commandError(`session export failed: ${errorText(error)}`);
	}
}

/** pie: commands.rs:1780-1829 (`session_import_command`). */
async function sessionImportCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	if (argv.length !== 1) return commandError("usage: /session import <path>");
	const raw = argv[0] as string;
	const archivePath = isAbsolute(raw) ? raw : join(ctx.cwd, raw);

	emitSessionArchiveWarning();
	try {
		const summary = await sessionArchive.importSession(getDefaultSessionDir(ctx.cwd), archivePath, ctx.cwd, "off");
		emitCommandLine(`imported session: ${shortId(summary.sessionId)}`);
		emitCommandLine(`path: ${summary.sessionPath}`);
		emitCommandLine(
			`entries=${summary.entryCount} triggers=${summary.triggersImported} cron=${summary.cronImported} ` +
				`automation=${summary.automationEnabled ? "enabled" : "disabled"}`,
		);
		emitCommandLine(`resume with: pie --resume-id ${summary.sessionId}`);
		if (summary.originallyEnabledTriggers.length > 0 || summary.originallyEnabledCron.length > 0) {
			return {
				kind: "session_import_activation",
				sessionPath: summary.sessionPath,
				triggerIds: summary.originallyEnabledTriggers,
				cronIds: summary.originallyEnabledCron,
			};
		}
		return HANDLED;
	} catch (error) {
		return commandError(`session import failed: ${errorText(error)}`);
	}
}

/** pie: commands.rs:1831-1835 (`emit_session_archive_warning`) — one line, verbatim. */
function emitSessionArchiveWarning(): void {
	emitCommandLine(
		"warning: .piesession archives include transcript and tool history. They do not include separate auth stores, provider credentials, OAuth tokens, or MCP config.",
	);
}

/* -------------------------------------------------------------------------------------------
 * /sessions + /find + /history — pie: commands.rs:1882-1910, 2052-2162.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:1892-1909 (`SessionsCommand::run`). */
export async function runSessionsCommand(ctx: CommandCtx): Promise<CommandOutcome> {
	let entries: Awaited<ReturnType<typeof listSessionEntries>>;
	try {
		entries = await listSessionEntries(getDefaultSessionDir(ctx.cwd));
	} catch (error) {
		return commandError(`list sessions: ${errorText(error)}`);
	}
	if (entries.length === 0) {
		emitCommandLine("(no sessions for this cwd)");
		return HANDLED;
	}
	emitCommandLine("Sessions:");
	for (const e of entries) {
		emitCommandLine(`  ${shortId(e.id)}  ${e.createdAt}  ${e.preview ?? ""}`);
	}
	return HANDLED;
}

/**
 * pie: commands.rs:2065-2127 (`FindCommand::run`).
 *
 * Scans the *whole* transcript of every session in this cwd — every user and every assistant
 * message body — and prints one line per matching message, exactly as oracle does. It previously
 * matched only `SessionListEntry.preview` (the first user message), which made `/find` answer with
 * a strict subset and gave no indication the search had been shallow.
 *
 * `hits` counts matching *messages*, not sessions (commands.rs:2113), so one session can print
 * several lines. The id shown is the transcript's file stem (commands.rs:2119
 * `path.file_stem()`) — deliberately the full stem, not `/sessions`' 16-char `short_id`.
 *
 * Cost: oracle opens and fully parses every session file on every `/find`, and so does this. That
 * is O(total bytes of this cwd's transcript history) per invocation with no index — on a large
 * history (hundreds of sessions, tens of MB) `/find` takes visibly longer than `/sessions`. It is
 * still *less* work than the previous preview-only implementation did: that one routed through
 * `listSessionEntries`, which parsed every transcript anyway (to derive the preview it then
 * searched) and additionally read two automation sidecar files per session that `/find` never
 * looked at. What is added here is an in-memory scan of messages that were already parsed.
 */
export async function runFindCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	if (argv.length === 0) return commandError("usage: /find <query>");
	const query = argv.join(" ").toLowerCase();
	let paths: string[];
	try {
		paths = await listSessionTranscriptPaths(getDefaultSessionDir(ctx.cwd));
	} catch (error) {
		return commandError(`list sessions: ${errorText(error)}`);
	}
	let hits = 0;
	for (const path of paths) {
		// pie: commands.rs:2119 — `path.file_stem()…unwrap_or("?")`.
		const stem = basename(path, ".jsonl") || "?";
		for (const text of sessionMessageTexts(path)) {
			if (!text.toLowerCase().includes(query)) continue;
			hits += 1;
			// pie: commands.rs:2114-2118 — first 120 chars (code points), THEN newlines flattened.
			const snip = [...text].slice(0, 120).join("").replaceAll("\n", " ");
			emitCommandLine(`  ${stem}  ${snip}`);
		}
	}
	emitCommandLine(hits === 0 ? "(no matches)" : `(${hits} match(es))`);
	return HANDLED;
}

/** pie: commands.rs:2144-2160 (`HistoryCommand::run`). */
export async function runHistoryCommand(argv: readonly string[]): Promise<CommandOutcome> {
	const parsed = argv[0] === undefined ? Number.NaN : Number.parseInt(argv[0], 10);
	const limit = Number.isFinite(parsed) && parsed >= 0 ? parsed : 20;
	const entries = HistoryStore.load().entries();
	if (entries.length === 0) {
		emitCommandLine("(no history yet)");
		return HANDLED;
	}
	const start = Math.max(entries.length - limit, 0);
	entries.slice(start).forEach((e, i) => {
		const n = start + i + 1;
		const preview = [...e].slice(0, 200).join("");
		// pie: commands.rs:2157 compares `preview.len() < e.len()` — BYTE lengths, so the ellipsis
		// rule follows UTF-8 size, not code-point count. Reproduced with the UTF-8 byte length.
		const suffix = utf8Length(preview) < utf8Length(e) ? "…" : "";
		emitCommandLine(`  ${n}: ${preview}${suffix}`);
	});
	return HANDLED;
}

/* -------------------------------------------------------------------------------------------
 * /save + /share — pie: commands.rs:1505-1539, 1912-1966.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:1518-1537 (`SaveCommand::run`). */
export async function runSaveCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	const requested = argv[0] ?? exporter.defaultExportPath(ctx.sessionId);
	const dest = isAbsolute(requested) ? requested : join(ctx.cwd, requested);
	try {
		await saveTranscript(ctx, dest);
		emitCommandLine(`saved transcript: ${dest}`);
		return HANDLED;
	} catch (error) {
		return commandError(`save failed: ${errorText(error)}`);
	}
}

/** pie: commands.rs:1925-1964 (`ShareCommand::run`). Private by default; `--secret` is a removed
 * `gh` flag and is never passed. */
export async function runShareCommand(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome> {
	const isPublic = argv.some((a) => a === "--public");

	const dir = join(tmpdir(), `pie-share-${ctx.sessionId}`);
	try {
		await mkdir(dir, { recursive: true });
	} catch (error) {
		return commandError(`share tmp dir: ${errorText(error)}`);
	}
	const file = join(dir, "transcript.md");
	try {
		await saveTranscript(ctx, file);
	} catch (error) {
		return commandError(`save transcript: ${errorText(error)}`);
	}

	const args = ["gist", "create"];
	if (isPublic) args.push("--public");
	args.push("--desc", `pie session ${ctx.sessionId}`, file);

	let output: { code: number; stdout: string; stderr: string };
	try {
		output = await runGh(args);
	} catch (error) {
		return commandError(`gh gist create failed to spawn: ${errorText(error)}. Is gh on PATH?`);
	}
	if (output.code !== 0) {
		return commandError(`gh gist create exited ${output.code}: ${output.stderr.trim()}`);
	}
	emitCommandLine(`shared: ${output.stdout.trim()}`);
	return HANDLED;
}

/** pie: commands.rs:1947-1954 (`cmd.output().await`). RULEBOOK §2.3: `tokio::process::Command`
 * maps to `node:child_process` spawn. */
function runGh(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("gh", [...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		// pie: commands.rs:1958 (`output.status.code().unwrap_or(-1)`) — a signal-killed child has
		// no exit code, which oracle renders as -1.
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

/* -------------------------------------------------------------------------------------------
 * /login + /logout — pie: commands.rs:1968-2050.
 * ----------------------------------------------------------------------------------------- */

/**
 * pie: commands.rs:1981-1993 (`LoginCommand::run`). Never accepts an inline key — the REPL must
 * prompt without echo, so a second argument is a usage error whose text does not repeat it.
 */
export async function runLoginCommand(argv: readonly string[]): Promise<CommandOutcome> {
	if (argv.length !== 1) return commandError(LOGIN_USAGE_ERROR);
	return { kind: "login_secret", provider: argv[0] as string };
}

/** pie: commands.rs:2027-2048 (`LogoutCommand::run`). */
export async function runLogoutCommand(argv: readonly string[]): Promise<CommandOutcome> {
	const provider = argv[0];
	if (provider === undefined) return commandError("usage: /logout <provider>");
	let store: AuthStorage;
	try {
		store = AuthStorage.create();
	} catch (error) {
		return commandError(`load auth store: ${errorText(error)}`);
	}
	if (store.get(provider) === undefined) {
		emitCommandLine(`no credential stored for \`${provider}\``);
		return HANDLED;
	}
	try {
		store.remove(provider);
	} catch (error) {
		return commandError(`save auth store: ${errorText(error)}`);
	}
	emitCommandLine(`removed credential for \`${provider}\``);
	return HANDLED;
}

/**
 * pie: commands.rs:1997-2012 (`save_api_key`). Returns the auth-store path. The TS counterpart of
 * oracle's load-then-merge-then-write is `AuthStorage.set` (see `core/auth-storage.ts:369-372`).
 */
export function saveApiKey(provider: string, token: string): string {
	AuthStorage.create().set(provider, { type: "api_key", key: token });
	return getAuthPath();
}

/* -------------------------------------------------------------------------------------------
 * Local helpers.
 * ----------------------------------------------------------------------------------------- */

/**
 * `bug-report.ts`'s `build` takes the NOMINAL `@pie/agent-core` `Session`;
 * `CommandHarness.session()` is the structural stand-in documented in `slash-dispatch-deps.ts`.
 * Every member `build` actually touches is on `CommandSession`, so this is a type-level bridge.
 * TODO(port): drop once `AgentHarness` exposes a real public `session()` and the stand-in goes away.
 */
function nominalSession(ctx: CommandCtx): Session {
	return ctx.harness.session() as unknown as Session;
}

/** pie: commands.rs:1531 / 1934 (`crate::export::save`). Inlined rather than calling
 * `export.save`, which takes the nominal `Session`; the renderer itself is reused as-is. */
async function saveTranscript(ctx: CommandCtx, dest: string): Promise<string> {
	await mkdir(dirname(dest), { recursive: true });
	await writeFile(dest, exporter.renderContext(await ctx.harness.session().buildContext()), "utf-8");
	return dest;
}

function utf8Length(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
