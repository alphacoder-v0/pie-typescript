/**
 * The two subcommands oracle's `--help` advertises: `session` and clap's generated `help`.
 *
 * pie: main.rs:150-187 (`enum CliCommand` / `enum SessionCliCommand`) and main.rs:221-223
 * (`if let Some(command) = &cli.command { return run_cli_command(command, …) }` — the first thing
 * `main` does after `Cli::parse()`, before any session, credential or model is touched).
 *
 * Why this module exists at all (phase 19 finding F2): `cli/help.ts` renders a `Commands:` block
 * that is byte-identical to oracle's, so `pie --help` promises both subcommands — but nothing on
 * this side ever recognized the tokens. `parseArgs` therefore filed them under `messages`, i.e.
 * **the user's command line became a chat prompt and was sent to the provider**, and what came
 * back was a raw HTTP 401. A subcommand that is advertised but unimplemented must fail as a CLI,
 * not as a chat turn.
 *
 * Scope of the fix: every *help / usage* surface of both subcommands is reproduced here
 * byte-for-byte from the oracle binary (the pages are static clap output — see the four page
 * constants below, captured with `env -i HOME=<fresh> pie session … --help`). The two surfaces
 * that actually move data — `pie session export` and `pie session import` — are NOT wired: they
 * are oracle's `run_session_cli_command` (main.rs:249-372), a separate migration unit that owns
 * session-id resolution, the `--activate-triggers ask` TTY round-trip and the archive summary
 * lines. They hard-fail with a pointer to the in-REPL `/session export|import` commands, which
 * are ported and working (`core/slash-dispatch-session.ts`).
 *
 * PORT-DIVERGENCE (declared, phase 19): oracle *performs* `pie session export|import`; this side
 * refuses them with exit 2 until that unit lands. Refusing is the conservative half of the
 * divergence — the alternative on offer was not "oracle's behavior", it was "silently prompt an
 * LLM with the words `session export`".
 *
 * Everything here is pure: `resolveSubcommandInvocation` decides *what* to print, on *which*
 * stream, with *which* exit code, and `main.ts` does the writing. That keeps the whole surface
 * unit-testable without spawning a process, and — because it runs before `takeOverStdout()` —
 * keeps it clear of the stdout-takeover trap that phase 19's F1 documents.
 */

import { cliModelHelpText, renderCliHelp } from "./cli/help.ts";
import { renderUsageError, TOP_LEVEL_USAGE } from "./cli/usage-error.ts";

/** A decided subcommand answer: exactly one write, then exit. */
export interface SubcommandOutcome {
	/** Verbatim bytes to write, trailing newline included. */
	readonly text: string;
	/** File descriptor to write to. clap sends help to stdout and errors to stderr, and sends a
	 * *missing required subcommand* page to stderr even though it is a help page (verified against
	 * the oracle binary: `pie session` → 347 B on fd 2, exit 2). */
	readonly stream: 1 | 2;
	readonly exitCode: 0 | 2;
}

/** oracle: `pie session --help` / `pie session help` / `pie help session` (347 B, stdout, 0). */
export const SESSION_HELP_PAGE = `Export or import replayable \`.piesession\` backups

Usage: pie session <COMMAND>

Commands:
  export  Export a session transcript and automation sidecars to a \`.piesession\` archive
  import  Import a \`.piesession\` archive as a new local session
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
`;

/** oracle: `pie session export --help` (525 B, stdout, 0). */
export const SESSION_EXPORT_HELP_PAGE = `Export a session transcript and automation sidecars to a \`.piesession\` archive

Usage: pie session export [OPTIONS]

Options:
      --session <SESSION>  Session id to export (full UUIDv7 or unique prefix). Defaults to newest for this cwd
      --current            Export the newest session for this cwd
      --output <FILE>      Destination \`.piesession\` file. Defaults to \`pie-session-<id>.piesession\` in cwd
      --exclude-triggers   Do not include dynamic trigger or cron sidecars
  -h, --help               Print help
`;

/** oracle: `pie session import --help` (494 B, stdout, 0). clap switches this page to its
 * long-description layout because the `--activate-triggers` label plus its help text exceeds the
 * two-column budget. */
export const SESSION_IMPORT_HELP_PAGE = `Import a \`.piesession\` archive as a new local session

Usage: pie session import [OPTIONS] <FILE>

Arguments:
  <FILE>  \`.piesession\` archive to import

Options:
      --cwd <PATH>
          Cwd to write into the imported session metadata. Defaults to the current directory
      --activate-triggers <ACTIVATE_TRIGGERS>
          Activation mode for imported triggers/crons. Defaults to disabled; ask is reserved [default: off] [possible values: off, ask, on]
  -h, --help
          Print help
`;

/**
 * `pie help` — clap's generated `help` subcommand prints the command's own page, which does NOT
 * carry the `Model catalog:` after-help block: oracle attaches that block only on the `--help`
 * path (`main.rs:391-398` builds `Cli::command().after_help(cli_model_help_text())` there and
 * nowhere else). Verified against the oracle binary: `pie help` = 3002 B, `pie --help` = 3782 B,
 * and the difference is exactly the blank line plus the five catalog lines.
 *
 * Cut from the shared renderer rather than re-listed, so the page cannot drift from `--help`.
 */
export function topLevelStaticHelpPage(): string {
	const page = renderCliHelp();
	const afterHelp = `\n${cliModelHelpText().join("\n")}\n\n`;
	// `afterHelp` opens with the blank line that separates the block, so cutting AT `start` keeps
	// the single trailing newline clap ends its page with and drops the separator with the block.
	const start = page.lastIndexOf(afterHelp);
	return start === -1 ? page : page.slice(0, start);
}

function stdout(text: string): SubcommandOutcome {
	return { text, stream: 1, exitCode: 0 };
}

function usageError(text: string): SubcommandOutcome {
	return { text, stream: 2, exitCode: 2 };
}

/**
 * clap's `error: … \n\n Usage: … \n\n For more information, try '--help'.` envelope.
 *
 * The envelope itself lives in `cli/usage-error.ts`, which the flag parser uses for the same
 * purpose — one copy of clap's bytes, not two that can drift apart.
 */
function clapError(message: string, usage: string): SubcommandOutcome {
	return usageError(renderUsageError(message, usage));
}

const SESSION_USAGE = "pie session <COMMAND>";

function isHelpFlag(arg: string | undefined): boolean {
	return arg === "--help" || arg === "-h";
}

/**
 * Options of `session export` / `session import` that consume the following token, so a value like
 * `--output foo.piesession` is not mistaken for a positional. Long `--opt=value` needs no entry.
 */
const VALUE_OPTIONS: Readonly<Record<"export" | "import", readonly string[]>> = {
	export: ["--session", "--output"],
	import: ["--cwd", "--activate-triggers"],
};

/** Positional (non-option) tokens of a `session <verb>` argument list, in order. */
function positionalArgs(verb: "export" | "import", args: readonly string[]): string[] {
	const takesValue = VALUE_OPTIONS[verb];
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("-") && arg !== "-") {
			if (takesValue.includes(arg)) i++;
			continue;
		}
		positionals.push(arg);
	}
	return positionals;
}

/**
 * The declared-but-unwired half of the `session` subcommand. See the PORT-DIVERGENCE note in this
 * module's header for why this is a refusal rather than oracle's real export/import.
 */
function notImplemented(verb: "export" | "import"): SubcommandOutcome {
	const inRepl = verb === "export" ? "/session export [path]" : "/session import <path>";
	return clapError(
		`\`pie session ${verb}\` is not implemented in this port yet; run \`${inRepl}\` from inside pie instead`,
		SESSION_USAGE,
	);
}

/** `pie session help [export|import]`, `pie help session [export|import]`. */
function sessionHelpPage(rest: readonly string[]): SubcommandOutcome {
	const verb = rest[0];
	if (verb === undefined || verb === "help" || isHelpFlag(verb)) return stdout(SESSION_HELP_PAGE);
	if (verb === "export") return stdout(SESSION_EXPORT_HELP_PAGE);
	if (verb === "import") return stdout(SESSION_IMPORT_HELP_PAGE);
	return clapError(`unrecognized subcommand '${verb}'`, SESSION_USAGE);
}

/** pie: main.rs:249-372 (`run_session_cli_command`), help/usage surfaces only. */
function sessionSubcommand(rest: readonly string[]): SubcommandOutcome {
	const verb = rest[0];

	// `pie session` with no verb: clap prints the page and exits 2 — and puts it on stderr,
	// because for clap this is the `MissingSubcommand` *error*, not a help request.
	if (verb === undefined) return { text: SESSION_HELP_PAGE, stream: 2, exitCode: 2 };
	if (isHelpFlag(verb) || verb === "help") return sessionHelpPage(rest.slice(1));

	if (verb === "export" || verb === "import") {
		if (rest.slice(1).some(isHelpFlag)) {
			return stdout(verb === "export" ? SESSION_EXPORT_HELP_PAGE : SESSION_IMPORT_HELP_PAGE);
		}
		const positionals = positionalArgs(verb, rest.slice(1));
		if (verb === "export" && positionals.length > 0) {
			// oracle: `pie session export nope.piesession` → `error: unexpected argument … found`.
			return clapError(`unexpected argument '${positionals[0]}' found`, "pie session export [OPTIONS]");
		}
		if (verb === "import" && positionals.length === 0) {
			// oracle: clap's missing-required-argument error, which names the argument on its own line.
			return usageError(
				"error: the following required arguments were not provided:\n  <FILE>\n\n" +
					"Usage: pie session import <FILE>\n\nFor more information, try '--help'.\n",
			);
		}
		return notImplemented(verb);
	}

	return clapError(`unrecognized subcommand '${verb}'`, SESSION_USAGE);
}

/**
 * Decide whether `args` is one of oracle's subcommand invocations, and what it should print.
 * Returns `undefined` when it is not, leaving `main` to carry on with flag parsing.
 *
 * Recognition is deliberately narrow: only `args[0]`. clap accepts a subcommand after global
 * options too (`pie --debug session`), but this side has a positional-prompt superset oracle does
 * not have (`pie "explain this"`, `pie -p "…"`), and scanning the whole argument list would turn
 * `pie -p session` — a legitimate one-word prompt — into a help page. Leading position is the
 * form users and scripts actually type, and it cannot collide with a flag's value.
 */
export function resolveSubcommandInvocation(args: readonly string[]): SubcommandOutcome | undefined {
	const first = args[0];
	if (first === "session") return sessionSubcommand(args.slice(1));
	if (first === "help") {
		const target = args[1];
		// `pie help --help` never reaches here — `shouldPrintDynamicTopLevelHelp` answers it with the
		// dynamic page first (cli/help.ts:71-79 documents that `help` is not a *declared* subcommand,
		// which is what makes that path win). Defensive, and it keeps this function total.
		if (target === undefined || target.startsWith("-")) return stdout(topLevelStaticHelpPage());
		if (target === "session") return sessionHelpPage(args.slice(2));
		return clapError(`unrecognized subcommand '${target}'`, TOP_LEVEL_USAGE);
	}
	return undefined;
}
