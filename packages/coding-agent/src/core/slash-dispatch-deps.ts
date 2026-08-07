/**
 * Runtime surface for the slash-command **dispatch** half of oracle `crates/coding-agent/src/
 * commands.rs` (pie @0a120dfd): the console sink, the `CommandOutcome` union, the `CommandCtx`
 * record, the `SlashCommand` trait, and the structural stand-in for the `AgentHarness` slice the
 * commands reach into.
 *
 * The DATA half (`PIE_BUILTIN_COMMANDS`, `findPieCommand`, `parseSlashCommand`, `parseLoginArgv`,
 * `parseModelSpec`) already lives in `core/slash-commands.ts` and is imported, never re-declared —
 * `slash-dispatch.ts` builds its registry rows straight off `PIE_BUILTIN_COMMANDS` so a
 * description/usage/alias can never drift between the two halves.
 *
 * ## Why `CommandHarness` is a structural stand-in
 *
 * Oracle's `CommandCtx.harness` is `&Arc<AgentHarness>`. `@pie/agent-core`'s ported `AgentHarness`
 * (`packages/agent/src/harness/agent-harness.ts`) already implements almost all of the slice below
 * — `setThinkingLevel`, `getThinkingLevel`, `reloadSkillsFromDisk`, `notificationStatusSnapshot`,
 * `abortTrigger`, `abortAllTriggers`, `cost`, `resetCost`, `setModel`, `getModel` are its real
 * public method names — but two members have no public counterpart:
 *
 *  1. `session()` — the harness keeps its `Session` in a *private* field. This is the exact gap
 *     `triggers/cron-deps.ts` and `goal-deps.ts` already document and work around; this file
 *     mirrors their `HarnessCell`/`AgentHarnessSession` precedent rather than inventing a third.
 *  2. `skills()` — oracle's agent-core `Skill` struct carries `content` + `source: SkillSource`;
 *     the ported `@pie/agent-core` `Skill` (`packages/agent/src/harness/types.ts:46`) carries
 *     neither `source` nor a required `disableModelInvocation`, and this repo's *live* catalog is
 *     pi's `core/skills.ts` `Skill` (`sourceInfo.scope`, no `content`). See `tools/skill.ts`'s
 *     module doc for why the skill-family units all standardised on the pi catalog +
 *     `resolveSkillSource`. {@link CommandSkill} is the intersection every skill-reading command
 *     in `commands.rs` actually touches — deliberately WITHOUT `content`, because the single
 *     loudest invariant across the oracle's own command tests is that no `/skill*` path ever
 *     echoes a SKILL.md body.
 *
 * TODO(port): once `AgentHarness` grows a public `session()` accessor (tracked by the identical
 * TODO in `triggers/cron-deps.ts` and `goal-deps.ts`) and the ported `Skill` regains `source`,
 * collapse {@link CommandHarness} onto the real class and delete the adapters.
 */

import type {
	CostSnapshot,
	NotificationStatusSnapshot,
	SessionContext,
	SessionMetadata,
	SessionTreeEntry,
	ThinkingLevel,
} from "@pie/agent-core";
import type { Model } from "@pie/ai";
import type { SkillSource } from "../skills-state.ts";

/* -------------------------------------------------------------------------------------------
 * console — pie: commands.rs:20-58 (`mod console` + the `cprintln!` macro).
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:27 (`type Sink = Box<dyn Fn(String) + Send + Sync>`). */
export type CommandSink = (line: string) => void;

/**
 * pie: commands.rs:28 (`static SINK: Mutex<Option<Sink>>`). RULEBOOK §2.2: the critical section
 * never crosses an await (a plain read-then-call), so the `parking_lot::Mutex` collapses to a
 * module-level binding — Node is single-threaded.
 */
let sink: CommandSink | undefined;

/** pie: commands.rs:33 (`console::set_sink`). Installed once by the UI at startup. */
export function setCommandSink(next: CommandSink): void {
	sink = next;
}

/** pie: commands.rs:40 (`console::clear_sink`). Used by tests so capture sinks do not leak. */
export function clearCommandSink(): void {
	sink = undefined;
}

/**
 * pie: commands.rs:45 (`console::emit_line`). Falls back to stdout when no sink is installed —
 * this IS the oracle's behavior (`println!`), and the one sanctioned `console.*` site in this
 * unit per RULEBOOK §1 ("TUI output and CLI stdout are the exception").
 */
export function emitCommandLine(line: string): void {
	if (sink) {
		sink(line);
		return;
	}
	// pie: commands.rs:48 (`None => println!("{line}")`).
	console.log(line);
}

/**
 * pie: commands.rs:1275-1279 (`emit_multiline`). Rust `str::lines()` drops a single trailing
 * newline and never yields a final empty segment; `split("\n")` would, so the trailing empty
 * element is trimmed to match.
 */
export function emitCommandLines(text: string): void {
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	for (const line of lines) emitCommandLine(line);
}

/* -------------------------------------------------------------------------------------------
 * Harness slice.
 * ----------------------------------------------------------------------------------------- */

/**
 * The slice of oracle's `pie_agent_core::Skill` that `commands.rs` reads. `content` is
 * deliberately absent — see this file's header.
 * pie: crates/agent/src/harness/types.rs:275-285 (`Skill`).
 */
export interface CommandSkill {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation: boolean;
	source: SkillSource;
}

/**
 * pie: `Session` (crates/agent/src/harness/session/session.rs) — only the methods `commands.rs`
 * calls. A real `@pie/agent-core` `Session` instance satisfies this structurally: every name below
 * is its real public method name.
 */
export interface CommandSession {
	getEntries(): Promise<SessionTreeEntry[]>;
	appendCustomEntry(customType: string, data?: unknown): Promise<string>;
	getSessionName(): Promise<string | undefined>;
	appendSessionName(name: string): Promise<string>;
	getBranch(fromId?: string): Promise<SessionTreeEntry[]>;
	moveTo(entryId: string | null, summary?: { summary: string; details?: unknown }): Promise<string | undefined>;
	buildContext(): Promise<SessionContext>;
	getStorage(): { getMetadata(): Promise<SessionMetadata> };
}

/** pie: `PromptTemplate` as `/template`'s listing reads it (commands.rs:1477-1487). */
export interface CommandPromptTemplate {
	name: string;
	description?: string;
}

/**
 * pie: the `&Arc<AgentHarness>` slice `commands.rs` reaches into. Every member name matches the
 * real `@pie/agent-core` `AgentHarness` method it stands for, except `session()`/`skills()` (see
 * this file's header).
 */
export interface CommandHarness {
	/** pie: `AgentHarness::skills()`. A snapshot, not a live view. */
	skills(): CommandSkill[];
	/** pie: `AgentHarness::reload_skills_from_disk()` (commands.rs:429). */
	reloadSkillsFromDisk(): Promise<{ skills: CommandSkill[]; diagnostics: readonly unknown[] }>;
	/** pie: `AgentHarness::session()`. */
	session(): CommandSession;
	/** pie: `harness.agent().state().thinking_level` (commands.rs:983). */
	getThinkingLevel(): ThinkingLevel | undefined;
	/** pie: `AgentHarness::set_thinking_level` (commands.rs:994). */
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	/** pie: `harness.agent().state().model` (commands.rs:1429). */
	getModel(): Model<any> | undefined;
	/** pie: `AgentHarness::set_model` (commands.rs:913). */
	setModel(model: Model<any>): Promise<void>;
	/** pie: `AgentHarness::templates()` (commands.rs:1477). */
	templates(): readonly CommandPromptTemplate[];
	/** pie: `AgentHarness::cost()` (commands.rs:1411). */
	cost(): CostSnapshot;
	/** pie: `AgentHarness::reset_cost()` (commands.rs:1407). */
	resetCost(): void;
	/** pie: `AgentHarness::notification_status_snapshot()` (commands.rs:2181). */
	notificationStatusSnapshot(): NotificationStatusSnapshot;
	/** pie: `AgentHarness::abort_trigger` (commands.rs:2269). */
	abortTrigger(traceId: string): void;
	/** pie: `AgentHarness::abort_all_triggers` (commands.rs:2261). */
	abortAllTriggers(): void;
}

/* -------------------------------------------------------------------------------------------
 * CommandOutcome — pie: commands.rs:64-122.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:117-122 (`WebRelayAction`). */
export type WebRelayAction = "connect" | "status" | "disconnect";

/**
 * pie: commands.rs:66-115 (`enum CommandOutcome`). Data-carrying enum -> tagged discriminated
 * union (RULEBOOK §2.1); the tag values are lowercase-snake renderings of the variant names (this
 * union never crosses a wire, so no serde `tag =` to match).
 */
export type CommandOutcome =
	/** pie: `Handled` — continue the REPL loop normally. */
	| { kind: "handled" }
	/** pie: `Quit`. */
	| { kind: "quit" }
	/** pie: `ClearScreen` — the REPL owns the ANSI escape. */
	| { kind: "clear_screen" }
	/** pie: `Error(String)` — the REPL renders it via `tui.error_line`. */
	| { kind: "error"; message: string }
	/** pie: `AttachSkill { name }`. */
	| { kind: "attach_skill"; name: string }
	/**
	 * pie: `RunAgentPrompt { prompt, error_context }` — commands return this instead of awaiting
	 * the harness so Ctrl-C/Esc can abort thinking, streaming, and tool execution consistently.
	 */
	| { kind: "run_agent_prompt"; prompt: string; errorContext: string }
	/** pie: `RunPromptTemplate { name, vars }`. */
	| { kind: "run_prompt_template"; name: string; vars: Record<string, unknown> }
	/** pie: `RunCompaction { custom }`. */
	| { kind: "run_compaction"; custom?: string }
	/** pie: `LoginSecret { provider, storage_key, recovery_command }`. */
	| { kind: "login_secret"; provider: string; storageKey?: string; recoveryCommand?: string }
	/** pie: `OpenModelPicker`. */
	| { kind: "open_model_picker" }
	/** pie: `WebRelay(WebRelayAction)`. */
	| { kind: "web_relay"; action: WebRelayAction }
	/** pie: `SessionImportActivation { session_path, trigger_ids, cron_ids }`. */
	| { kind: "session_import_activation"; sessionPath: string; triggerIds: string[]; cronIds: string[] };

/** Convenience constructors — the union above is verbose at every `return` site. */
export const HANDLED: CommandOutcome = { kind: "handled" };

export function commandError(message: string): CommandOutcome {
	return { kind: "error", message };
}

/* -------------------------------------------------------------------------------------------
 * CommandCtx / SlashCommand — pie: commands.rs:177-201.
 * ----------------------------------------------------------------------------------------- */

/** pie: commands.rs:179-185 (`struct CommandCtx<'a>`). Kept narrow so each command's dependencies
 * are explicit. */
export interface CommandCtx {
	harness: CommandHarness;
	sessionId: string;
	/** pie: `log_path: Option<&'a PathBuf>` — `undefined` = logging disabled. */
	logPath?: string;
	toolCount: number;
	cwd: string;
}

/**
 * pie: commands.rs:187-201 (`trait SlashCommand`). The trait's four metadata methods return
 * `&'static str` data, so the TS shape carries them as fields sourced from
 * `PIE_BUILTIN_COMMANDS`; only `run` stays behavioral.
 */
export interface SlashCommand {
	/** Canonical name without the leading `/`. */
	name: string;
	/** Also without the leading `/`. Empty when the command has none. */
	aliases: readonly string[];
	description: string;
	/** Argument hint shown in `/help`. Empty when the command takes no arguments. */
	usage: string;
	run(argv: readonly string[], ctx: CommandCtx): Promise<CommandOutcome>;
}

/**
 * pie: commands.rs:204-265 (`struct Registry`) — the read side only. Declared here (rather than in
 * `slash-dispatch.ts`, which owns the concrete class) so the per-family handler modules can take a
 * registry without importing the module that imports them.
 */
export interface CommandRegistry {
	/** pie: `Registry::commands()` — registration order, which `/help` renders as-is. */
	commands(): readonly SlashCommand[];
	/** pie: `Registry::find()` — linear scan by name or alias, first match wins. */
	find(name: string): SlashCommand | undefined;
}

/* -------------------------------------------------------------------------------------------
 * Shared text helpers.
 * ----------------------------------------------------------------------------------------- */

/**
 * pie: commands.rs:3053-3059 (`preview_text`). Truncates by **code point** (Rust `chars()`), so
 * the TS side spreads the string rather than slicing UTF-16 units; appends `…` only when
 * something was actually dropped, then flattens newlines.
 */
export function previewText(text: string, maxChars: number): string {
	const chars = [...text];
	let preview = chars.slice(0, maxChars).join("");
	if (chars.length > maxChars) preview += "…";
	return preview.replaceAll("\n", " ");
}

/** pie: commands.rs:1837-1839 (`short_id`) — first 16 code points. */
export function shortId(id: string): string {
	return [...id].slice(0, 16).join("");
}

/** pie: commands.rs:1841-1843 (`yes_no`). */
export function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}
