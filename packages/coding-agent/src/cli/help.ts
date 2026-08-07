/**
 * Oracle-shaped top-level CLI help (`pie --help` / `pie -h`).
 *
 * Port of the clap surface of oracle `crates/coding-agent/src/main.rs`:
 * - main.rs:58-148 — `#[derive(Parser)] struct Cli` (every option, its value name, default and
 *   possible values, and the doc comment that becomes the help text).
 * - main.rs:150-157 — `enum CliCommand` (the `session` subcommand row).
 * - main.rs:391-422 — `print_dynamic_help_and_exit_if_requested` /
 *   `should_print_dynamic_top_level_help`.
 * - commands.rs:1264-1296 — `cli_model_help_text` / `model_help_summary_lines` /
 *   `provider_summary` (the `Model catalog:` after-help block).
 *
 * Why a hand-rolled renderer instead of a parser library: this package's `dependencies` are
 * frozen for the migration, and the contract is clap's *exact* byte layout, which no other
 * argument library reproduces. The layout rules reproduced here are the ones clap 4 uses when the
 * `wrap_help` feature is off (pie does not enable it), i.e. descriptions are never wrapped:
 *
 * - Each option's label is `  -x, --long <VALUE>` when it has a short and `      --long <VALUE>`
 *   when it does not (the 6-space indent keeps long-only options aligned under short ones).
 * - Every label is padded to the longest label in the section, then two spaces, then the help.
 * - `[default: …]` and `[possible values: …]` are appended to the help, in that order.
 * - clap_derive strips the trailing `.` of a doc comment and joins its lines with a single space;
 *   the strings below are therefore stored post-transformation, verbatim from oracle's output.
 *
 * The help text is deliberately uncolored. clap colors section headers and literals only when it
 * is writing to a terminal, and the parity judge (`migration/parity/scenarios/s1-help.sh`)
 * captures a pipe. TODO(port): colorize headers when `process.stdout.isTTY` if a scenario ever
 * captures a pty.
 */

import { getModels, getProviders } from "@pie/ai";

/**
 * pie: main.rs:60 `#[command(name = "pie", …)]`.
 *
 * Deliberately not `APP_NAME` from `../config.ts`: that constant is the *skeleton's* application
 * identity ("pi") and drives env-var names, the debug log filename and `process.title`. Oracle
 * hardcodes the clap command name, so this does too.
 */
export const CLI_BIN_NAME = "pie";

/**
 * pie: main.rs:61 `#[command(version)]` — clap prints `env!("CARGO_PKG_VERSION")`, i.e. the ORACLE
 * crate's version (0.75.0 in both the workspace and `crates/coding-agent/Cargo.toml` at the pie
 * @0a120dfd snapshot), not this npm package's 0.75.4.
 *
 * TODO(port): version literal must track oracle Cargo.toml, not this package.json. Same repo-wide
 * convention (and the same adjudication — `migration/reviews/mcp/findings.md`, "0.75.4 vs 0.75.0",
 * CONFIRMED) as `ai/utils/headers.ts:12`, `mcp/client.ts:62`, `mcp/http.ts:34`,
 * `tools/web-fetch.ts:35`, `tools/web-search.ts:30` and `session-archive.ts`'s
 * `ORACLE_CRATE_VERSION`. `--version` is a judged surface: parity scenario S1 captures it.
 */
export const CLI_VERSION = "0.75.0";

/** pie: main.rs:62 `about = "…"`. */
const CLI_ABOUT = "Simple coding agent on top of pie-agent-core";

/** pie: main.rs:150-157 — the only declared subcommand is `session`; `help` is added by clap. */
interface HelpCommand {
	readonly name: string;
	readonly help: string;
}

const CLI_COMMANDS: readonly HelpCommand[] = [
	// pie: main.rs:152-156.
	{ name: "session", help: "Export or import replayable `.piesession` backups" },
	// clap's auto-generated `help` subcommand.
	{ name: "help", help: "Print this message or the help of the given subcommand(s)" },
];

/**
 * Subcommand names `should_print_dynamic_top_level_help` recognizes.
 *
 * pie: main.rs:404-407 reads `Cli::command().get_subcommands()`. That call happens on an *unbuilt*
 * `Command`, so clap's auto-generated `help` subcommand is NOT in the list — verified against the
 * oracle binary: `pie help --help` prints the dynamic help (with the `Model catalog:` block),
 * while `pie session --help` prints the subcommand page instead.
 */
const DECLARED_SUBCOMMANDS: readonly string[] = ["session"];

interface HelpOption {
	/** Single-character short flag, without the leading dash. */
	readonly short?: string;
	/** Long flag, without the leading dashes. */
	readonly long: string;
	/** clap value name (already uppercased as clap renders it). Omitted for boolean flags. */
	readonly value?: string;
	/** `num_args = 0..=1` — clap renders the value name in square brackets. */
	readonly optionalValue?: boolean;
	/** Doc comment as clap_derive renders it (lines joined, trailing period stripped). */
	readonly help: string;
	/** Rendered as ` [default: …]`. */
	readonly defaultValue?: string;
	/** Rendered as ` [possible values: …]`. */
	readonly possibleValues?: readonly string[];
}

/** pie: main.rs:82 — `commands::THINKING_LEVEL_VALUES`. */
export const THINKING_LEVEL_VALUES: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** pie: main.rs:68-147, in declaration order (clap lists options in declaration order). */
const CLI_OPTIONS: readonly HelpOption[] = [
	{
		long: "provider",
		value: "PROVIDER",
		help: "Provider id (anthropic, openai, openrouter, …). When unset, auto-detected from env",
	},
	{ long: "model", value: "MODEL", help: "Model id within the provider's catalog" },
	{
		long: "base-url",
		value: "URL",
		help: "Override the selected model's base URL for this run. Useful for local OpenAI-compatible servers such as DS4",
	},
	{
		long: "thinking",
		value: "THINKING",
		help: "Thinking level (off | minimal | low | medium | high | xhigh)",
		defaultValue: "off",
		possibleValues: THINKING_LEVEL_VALUES,
	},
	{
		long: "resume",
		value: "ID",
		optionalValue: true,
		help: "Select a session for this cwd to resume. Pass an id to resume a specific one directly (same as --resume-id); bare --resume opens the picker",
	},
	{ short: "c", long: "continue", help: "Continue the most recent session for this cwd" },
	{ long: "resume-id", value: "ID", help: "Resume a specific session by id (full UUIDv7 or a unique prefix)" },
	{ long: "list-sessions", help: "List sessions for this cwd and exit" },
	{
		long: "list-all-sessions",
		help: "List sessions across every cwd we know about (~/.pie/sessions/*) and exit",
	},
	{ long: "delete-session", value: "ID", help: "Delete a session by id and exit" },
	{
		long: "image",
		value: "PATH",
		help: "Attach an image to the first prompt of this session. Repeatable. Supported formats: PNG, JPEG, WebP, GIF. Each image is capped at 10 MiB; max 10 per message",
	},
	{
		long: "builtin-skill",
		value: "NAME",
		help: "Enable a built-in skill bundled with this `pie` binary, by name. Repeatable. Unknown names hard-fail with a list of available built-ins. Built-in skills are the lowest precedence — user (`~/.pie/skills/`) and project (`<cwd>/.pie/skills/`) skills of the same name still override. Persistent enable is via `~/.pie/config.toml` `[builtin_skills] enabled = [...]`; CLI + config are unioned and de-duplicated",
	},
	{
		long: "trigger-poll-secs",
		value: "SECONDS",
		help: "Poll interval for local dynamic trigger checks, in seconds. Defaults to `[triggers] poll_interval_secs` from `~/.pie/config.toml`, or 600 when unset",
	},
	{ long: "debug", help: "Show LLM call debug logs in the conversation feed, including trigger/sub-agent calls" },
	{ long: "yes", help: "Auto-approve control-plane prompts" },
	{ long: "always-allow", help: "Auto-approve every approval prompt, including control-plane writes" },
	{ long: "web", help: "Run the local browser UI instead of the terminal UI. Defaults to loopback-only" },
	{ long: "tui", help: "Run the terminal UI even when local defaults would open the Web UI" },
	{ long: "web-host", value: "HOST", help: "Host for `--web`. Must be a loopback address", defaultValue: "127.0.0.1" },
	{ long: "web-port", value: "PORT", help: "Port for `--web`; use 0 to bind a random free port", defaultValue: "0" },
	// clap builtins, always last and in this order.
	{ short: "h", long: "help", help: "Print help" },
	{ short: "V", long: "version", help: "Print version" },
];

/**
 * The clap label and possible-values of an oracle option that takes a value, or `undefined` for a
 * boolean flag / a name oracle does not have.
 *
 * `cli/usage-error.ts`'s messages quote the option exactly as clap does — `'--thinking <THINKING>'`,
 * not `'--thinking'` — and the value names live here already, in the table that renders `--help`.
 * Reading them from the same table is what keeps a usage error from drifting away from the page
 * that documents the flag. `--resume` is excluded on purpose: `num_args = 0..=1` means bare
 * `--resume` is legal (it opens the picker), so it can never be a missing-value error.
 *
 * Additive only — nothing `renderCliHelp` emits passes through here, so `--help` stays byte-exact
 * (parity S1).
 */
export function clapValueOptionSpec(
	long: string,
): { readonly label: string; readonly possibleValues?: readonly string[] } | undefined {
	const option = CLI_OPTIONS.find((candidate) => candidate.long === long);
	if (option?.value === undefined || option.optionalValue === true) {
		return undefined;
	}
	return { label: optionLabel(option).trimStart(), possibleValues: option.possibleValues };
}

/** clap's two-column layout: pad every label to the section's widest, then two spaces. */
const HELP_COLUMN_GAP = "  ";

function optionLabel(option: HelpOption): string {
	const head = option.short === undefined ? "      " : `  -${option.short}, `;
	let value = "";
	if (option.value !== undefined) {
		value = option.optionalValue === true ? ` [<${option.value}>]` : ` <${option.value}>`;
	}
	return `${head}--${option.long}${value}`;
}

function optionHelp(option: HelpOption): string {
	let text = option.help;
	if (option.defaultValue !== undefined) {
		text += ` [default: ${option.defaultValue}]`;
	}
	if (option.possibleValues !== undefined) {
		text += ` [possible values: ${option.possibleValues.join(", ")}]`;
	}
	return text;
}

function twoColumnSection(rows: ReadonlyArray<{ label: string; help: string }>): string[] {
	const width = rows.reduce((widest, row) => Math.max(widest, row.label.length), 0);
	return rows.map((row) => `${row.label.padEnd(width)}${HELP_COLUMN_GAP}${row.help}`);
}

/**
 * The `Model catalog:` after-help block.
 *
 * pie: commands.rs:1264-1273 (`cli_model_help_text`) over commands.rs:1281-1296
 * (`model_help_summary_lines`) and commands.rs:1331-1351 (`model_groups` / `provider_summary`).
 *
 * Oracle counts `pie_ai::list_models()` — the *built-in* catalog, before `~/.pie/models.json`
 * merging (which the block advertises separately on its third line). The TS equivalent is
 * `@pie/ai`'s `getProviders()` / `getModels()`, read directly rather than through
 * `ModelRegistry`, which applies custom models and provider overrides. Providers are emitted in
 * sorted order to match Rust's `BTreeMap` iteration.
 *
 * The `~/.pie/…` paths are oracle's literal help text (commands.rs:1294), not a derived config
 * path: they must not follow a `PI_CODING_AGENT_DIR` override, because oracle's do not.
 */
export function cliModelHelpText(): string[] {
	const groups = getProviders()
		.map((provider) => ({ provider: String(provider), count: getModels(provider).length }))
		.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
	const total = groups.reduce((sum, group) => sum + group.count, 0);
	const summary = groups.map((group) => `${group.provider}(${group.count})`).join(", ");
	return [
		"Model catalog:",
		`  Supported providers (${groups.length}), models (${total}): ${summary}`,
		"  Full list: /help models or /model list [provider]",
		"  Custom models: ~/.pie/models.json and <cwd>/.pie/models.json",
		"  Credentials: set provider env vars or run /login <provider>.",
	];
}

/**
 * Render the top-level help exactly as oracle's `Cli::command().after_help(…).print_help()` does.
 *
 * The returned string carries the trailing blank line oracle's `println!()` (main.rs:397) adds
 * after clap's own trailing newline, so callers write it as-is.
 */
export function renderCliHelp(): string {
	const lines: string[] = [
		CLI_ABOUT,
		"",
		`Usage: ${CLI_BIN_NAME} [OPTIONS] [COMMAND]`,
		"",
		"Commands:",
		...twoColumnSection(CLI_COMMANDS.map((command) => ({ label: `  ${command.name}`, help: command.help }))),
		"",
		"Options:",
		...twoColumnSection(CLI_OPTIONS.map((option) => ({ label: optionLabel(option), help: optionHelp(option) }))),
		"",
		...cliModelHelpText(),
	];
	return `${lines.join("\n")}\n\n`;
}

/**
 * pie: main.rs:399-422 (`should_print_dynamic_top_level_help`).
 *
 * `--help`/`-h` anywhere in the argument list prints the dynamic top-level help, unless a
 * declared subcommand name also appears — in that case clap owns the help and renders the
 * subcommand's own page instead.
 */
export function shouldPrintDynamicTopLevelHelp(args: readonly string[]): boolean {
	let hasHelp = false;
	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			hasHelp = true;
			continue;
		}
		if (DECLARED_SUBCOMMANDS.includes(arg)) {
			return false;
		}
	}
	return hasHelp;
}
