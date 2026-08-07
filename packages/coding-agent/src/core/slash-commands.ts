import { APP_NAME } from "../config.ts";
import { LOGIN_USAGE_ERROR } from "../oauth.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

// ============================================================================
// pie slash-command registry
// pie: crates/coding-agent/src/commands.rs
// ============================================================================

/**
 * pie: commands.rs:62 (`THINKING_LEVEL_VALUES`). `main.rs:82` feeds this straight into clap's
 * `PossibleValuesParser` for `--thinking`, so the order and spelling are the CLI's accepted set.
 */
export const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** pie: commands.rs:63 (`THINKING_LEVEL_USAGE`). */
export const THINKING_LEVEL_USAGE = "[off|minimal|low|medium|high|xhigh]";

/**
 * One entry of oracle's `Registry`. The Rust side is a `dyn SlashCommand` trait object whose
 * `name`/`aliases`/`description`/`usage` are `&'static str` — a data record here, since the
 * `run` half lives in the dispatcher (the `coding-agent/tui` manifest unit).
 * pie: commands.rs:185-200 (`trait SlashCommand`).
 */
export interface PieSlashCommand {
	/** Canonical name without the leading `/`. */
	name: string;
	/** Also without the leading `/`. Empty when the command has none. */
	aliases: readonly string[];
	description: string;
	/** Argument hint shown in `/help`. Empty when the command takes no arguments. */
	usage: string;
}

/**
 * Oracle's built-in command set, in registration order.
 *
 * pie: commands.rs:215-248 (`Registry::with_builtins`) — order is user-visible, because
 * `general_help_text` (commands.rs:1156-1173) walks the registry as-is. Each row's
 * `description`/`usage` is copied verbatim from that command's trait impl.
 *
 * Phase 14 landed the dispatch half (`SlashCommand::run` + `CommandOutcome`, commands.rs:66-200)
 * and the `/help` renderers (`general_help_text`/`command_help_text`/`cli_model_help_text`,
 * commands.rs:1137-1274) in `core/slash-dispatch.ts` and its three handler modules;
 * `registryWithBuiltins()` builds every row straight off this list, so registration order and help
 * text cannot drift between the two halves.
 *
 * TODO(port): what remains is the REPL *wiring* — replacing
 * `modes/interactive/interactive-mode.ts:2517-2674`'s pi-shaped `if`-chain with
 * `slash-dispatch.ts`'s `dispatch`, and switching the editor's autocomplete off base pi's
 * {@link BUILTIN_SLASH_COMMANDS} onto this registry. That work was originally booked under the
 * `coding-agent/tui` manifest row, but 2026-08-04 reclassified that row onto oracle's line-flow
 * renderer (`src/tui.ts`), so no manifest row owns the wiring today — see the phase-14 note on
 * `migration/manifest.tsv`'s `coding-agent/commands` row. Until it lands this list is still the
 * spec rather than the live command surface; only `/login`'s argument policy (see
 * {@link parseLoginArgv}) is enforced by the running REPL today.
 */
export const PIE_BUILTIN_COMMANDS: readonly PieSlashCommand[] = [
	{
		name: "help",
		aliases: [],
		description: "show available commands and model catalog help",
		usage: "[models|<command>]",
	},
	{ name: "clear", aliases: [], description: "clear screen (keeps conversation history)", usage: "" },
	{
		name: "skills",
		aliases: [],
		description: "list, install, inspect, reload, enable, disable, or remove skills",
		usage: "[install [--confirm] [--overwrite] <url|path>|show <name>|reload|enable <name> [source]|disable <name> [source]|remove [--confirm] <name> [source]]",
	},
	{ name: "skill", aliases: [], description: "attach a loaded skill to the next prompt", usage: "<name>" },
	{ name: "quit", aliases: ["exit", "q"], description: "exit the REPL", usage: "" },
	{
		name: "model",
		aliases: [],
		description: "show or switch the active model",
		usage: "[provider:model-id|list [provider]]",
	},
	{ name: "thinking", aliases: [], description: "show or set the thinking level", usage: THINKING_LEVEL_USAGE },
	{ name: "cost", aliases: [], description: "show running token / USD totals for this session", usage: "[reset]" },
	{ name: "diag", aliases: [], description: "show diagnostic info (model, thinking, cost, log path)", usage: "" },
	{
		name: "template",
		aliases: [],
		description: "list templates, or run one with /template <name> [k=v ...]",
		usage: "[name] [k=v ...]",
	},
	{ name: "save", aliases: [], description: "export session transcript to Markdown", usage: "[path]" },
	{
		name: "compact",
		aliases: [],
		description: "force a context compaction now (no-op when nothing to summarize)",
		usage: '["custom instructions"]',
	},
	{
		name: "undo",
		aliases: [],
		description: "remove the most recent user+assistant turn from the active branch",
		usage: "",
	},
	{ name: "bug-report", aliases: [], description: "write a redacted diagnostic dump for issue attachment", usage: "" },
	{ name: "name", aliases: [], description: "show or set the current session's name", usage: "[slug]" },
	{
		name: "session",
		aliases: [],
		description: "export/import replayable .piesession backups",
		usage: "export [path] [--exclude-triggers] | import <path>",
	},
	{
		name: "web-connect",
		aliases: [],
		description: "mount this session at the public relay (watch + prompt via secret URL)",
		usage: "[status]",
	},
	{
		name: "web-disconnect",
		aliases: [],
		description: "disconnect the public relay and invalidate the session URL",
		usage: "",
	},
	{ name: "sessions", aliases: [], description: "list sessions for this cwd", usage: "" },
	{
		name: "share",
		aliases: [],
		description: "upload transcript as a private Gist via gh (requires `gh` on PATH)",
		usage: "[--public]",
	},
	{
		name: "login",
		aliases: [],
		description: "store an API key for a provider in ~/.pie/auth.json",
		usage: "<provider>",
	},
	{
		name: "logout",
		aliases: [],
		description: "remove a stored credential from ~/.pie/auth.json",
		usage: "<provider>",
	},
	{
		name: "find",
		aliases: [],
		description: "search every session in this cwd for prompts/replies containing <query>",
		usage: "<query>",
	},
	{ name: "history", aliases: [], description: "show recent submitted prompts from ~/.pie/history", usage: "[N]" },
	{
		name: "goal",
		aliases: [],
		description: "set, view, pause, resume, or clear the session goal stop hook",
		usage: "[<condition>|start <prompt>|pause|resume|clear]",
	},
	{
		name: "goal-start",
		aliases: [],
		description: "start working on the active session goal with a prompt",
		usage: "<prompt>",
	},
	{
		name: "triggers",
		aliases: [],
		description: "show trigger sources, rules, running actions, and recent audit",
		usage: "[status|rules|sources|enable <id>|disable <id>|remove <id>|remove --all|running|audit [N]|abort <trace_id>|abort --all]",
	},
	{
		name: "new-trigger",
		aliases: [],
		description: "create a dynamic natural-language trigger rule",
		usage: "<natural-language trigger request>",
	},
	{
		name: "cron",
		aliases: ["crontab"],
		description: "manage local scheduled agent jobs",
		usage: '[list|add "<5-field-cron>" <prompt>|enable <id>|disable <id>|remove <id>]',
	},
	{
		name: "inbox",
		aliases: [],
		description: "triage findings from loops (stateful cron jobs)",
		usage: "[all|claim <id|n>|dismiss <id|n>|clear]",
	},
];

/**
 * Lookup by name or alias. `name` is the bare command without `/`.
 * pie: commands.rs:258-264 (`Registry::find`) — a linear scan, first match wins.
 */
export function findPieCommand(name: string): PieSlashCommand | undefined {
	return PIE_BUILTIN_COMMANDS.find((c) => c.name === name || c.aliases.includes(name));
}

/**
 * Split `/cmd arg1 "arg with spaces"` into `{ name, argv }`. Returns `undefined` if `input`
 * doesn't start with `/`, or if nothing follows the slash (bare `/`).
 *
 * pie: commands.rs:275-301 (`parse`). Quoting is minimal and deliberately lenient: a `"` merely
 * toggles quote mode and is dropped, so unbalanced quotes do not error — `/say "a b` yields
 * `["a b"]`. Only ASCII space and tab split (commands.rs:284); other whitespace does not.
 * Leading whitespace is trimmed before the `/` check (`trim_start`, commands.rs:276).
 */
export function parseSlashCommand(input: string): { name: string; argv: string[] } | undefined {
	const trimmed = input.replace(/^\s+/, "");
	if (!trimmed.startsWith("/")) {
		return undefined;
	}
	const body = trimmed.slice(1);
	const argv: string[] = [];
	let current = "";
	let inQuotes = false;
	for (const c of body) {
		if (c === '"') {
			inQuotes = !inQuotes;
		} else if ((c === " " || c === "\t") && !inQuotes) {
			if (current !== "") {
				argv.push(current);
				current = "";
			}
		} else {
			current += c;
		}
	}
	if (current !== "") {
		argv.push(current);
	}
	if (argv.length === 0) {
		// Bare `/` — no command name.
		return undefined;
	}
	const name = argv.shift() as string;
	return { name, argv };
}

/**
 * `/login` argument policy: exactly one argument (the provider id). Zero args, or a provider
 * *plus* an inline API key (`/login anthropic sk-...`), is refused with oracle's usage string —
 * no code path anywhere accepts a literal key on the command line, because the key must be read
 * without echoing it (main.rs:1138-1149).
 *
 * pie: commands.rs:1981-1993 (`LoginCommand::run`). The message text is
 * {@link LOGIN_USAGE_ERROR}, already byte-checked against oracle in `oauth.ts:523`.
 */
export function parseLoginArgv(argv: readonly string[]): { provider: string } | { error: string } {
	if (argv.length !== 1) {
		return { error: LOGIN_USAGE_ERROR };
	}
	return { provider: argv[0] };
}

/**
 * `provider:model-id`, with oracle's two fallbacks: `provider/model-id`, then a whitespace split.
 * Both halves are trimmed and must be non-empty.
 *
 * pie: commands.rs:927-939 (`parse_model_spec`). `split_once` splits on the FIRST occurrence, so
 * a model id containing `:` or `/` keeps everything after the first separator, and `:` is tried
 * before `/` before whitespace.
 *
 * TODO(port): Rust's `char::is_whitespace` is the Unicode `White_Space` property; JS's `\s`
 * additionally matches U+FEFF. The two disagree only on that one code point, in a spec whose
 * separators are ASCII in practice.
 */
export function parseModelSpec(spec: string): { provider: string; id: string } | undefined {
	const trimmed = spec.trim();
	const at = [trimmed.indexOf(":"), trimmed.indexOf("/")].find((index) => index !== -1);
	const cut = at ?? trimmed.search(/\s/);
	if (cut === undefined || cut === -1) {
		return undefined;
	}
	const provider = trimmed.slice(0, cut).trim();
	const id = trimmed.slice(cut + 1).trim();
	if (provider === "" || id === "") {
		return undefined;
	}
	return { provider, id };
}

export { LOGIN_USAGE_ERROR };
