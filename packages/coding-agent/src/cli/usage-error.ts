/**
 * clap's usage-error surface: the exit code, the envelope, and the message templates oracle's
 * `Cli::parse()` emits.
 *
 * pie: oracle parses with `clap::Parser::parse()` (main.rs:218). On any usage error clap writes
 * its own page to stderr and calls `std::process::exit(2)`. Everything that goes wrong *after*
 * parsing is an `anyhow::Result` → `Error: {msg}` on stderr, exit **1**. That 2-vs-1 split is the
 * whole contract, and it is the only thing a wrapper script has to tell "you typed it wrong" from
 * "it ran and failed".
 *
 * Phase 19 finding F9 measured this side returning 0 or 1 for every usage error it drove
 * (`--thinking wobble` 0, unknown flag 1, `--trigger-poll-secs 0` 1, …). This module is the single
 * place that knows what a usage error looks like, so the answer cannot drift per call site again.
 *
 * Envelope, verbatim from the oracle binary:
 *
 * ```text
 * error: unexpected argument '--no-such-flag' found
 *
 * Usage: pie [OPTIONS] [COMMAND]
 *
 * For more information, try '--help'.
 * ```
 *
 * The `Usage:` block is present only for the error kinds clap attaches it to — measured, not
 * assumed: `unexpected argument` and `cannot be used with` carry it, `invalid value` and
 * `a value is required` do not.
 */

import { CLI_BIN_NAME } from "./help.ts";

/**
 * clap's exit code for a usage error. pie: `clap::Error::exit` → `safe_exit(2)`.
 *
 * Not to be confused with the `2` in `main.ts`'s `--builtin-skill` guard: that one is oracle's own
 * `std::process::exit(2)` (main.rs:698-707), deliberately borrowing clap's convention for a check
 * clap itself cannot do.
 */
export const USAGE_EXIT_CODE = 2;

/** pie: clap's usage string for the top-level command, i.e. the `Usage:` line of `--help`. */
export const TOP_LEVEL_USAGE = `${CLI_BIN_NAME} [OPTIONS] [COMMAND]`;

/**
 * Wrap a clap error message in clap's envelope. `usage` is omitted for the kinds that do not carry
 * a `Usage:` block.
 *
 * The returned string ends in a single newline and is meant to be written to fd 2 verbatim — it is
 * clap's bytes, not a message to be prefixed with `Error: ` the way anyhow failures are.
 */
export function renderUsageError(message: string, usage?: string): string {
	const blocks = usage === undefined ? [`error: ${message}`] : [`error: ${message}`, `Usage: ${usage}`];
	return `${[...blocks, "For more information, try '--help'."].join("\n\n")}\n`;
}

/**
 * `error: unexpected argument '<arg>' found` — clap's answer to a flag it does not know, and to a
 * value-looking token in a position that takes none.
 */
export function unexpectedArgument(arg: string, usage: string = TOP_LEVEL_USAGE): string {
	return renderUsageError(`unexpected argument '${arg}' found`, usage);
}

/**
 * `error: invalid value '<value>' for '<label>'[: <reason>]`, plus clap's indented
 * `[possible values: …]` line when the option declares them.
 *
 * `reason` is the value parser's own words: a range parser says
 * `0 is not in 1..18446744073709551615`, an enum parser says nothing at all and lets the
 * possible-values line do the work.
 */
export function invalidValue(
	value: string,
	label: string,
	options: { reason?: string; possibleValues?: readonly string[] } = {},
): string {
	const head = `invalid value '${value}' for '${label}'${options.reason === undefined ? "" : `: ${options.reason}`}`;
	return renderUsageError(withPossibleValues(head, options.possibleValues));
}

/** `error: a value is required for '<label>' but none was supplied`. */
export function missingValue(label: string, possibleValues?: readonly string[]): string {
	return renderUsageError(
		withPossibleValues(`a value is required for '${label}' but none was supplied`, possibleValues),
	);
}

/**
 * `error: the argument '<a>' cannot be used with '<b>'`, whose `Usage:` line names the *first*
 * flag of the pair as clap saw it — `pie --web --tui` reports `Usage: pie --web`, `pie --tui --web`
 * reports `Usage: pie --tui`.
 */
export function argumentConflict(first: string, second: string): string {
	return renderUsageError(`the argument '${first}' cannot be used with '${second}'`, `${CLI_BIN_NAME} ${first}`);
}

/**
 * Every non-repeatable option produces the same sentence upstream. Verified there:
 *
 * The other value-taking options are word for word identical. Note that the usage line is the
 * top-level one, unlike the conflict message, which echoes the specific option.
 */
export function argumentRepeated(label: string): string {
	return renderUsageError(`the argument '${label}' cannot be used multiple times`, TOP_LEVEL_USAGE);
}

/** clap indents the possible-values line by two spaces and hangs it off the message. */
function withPossibleValues(message: string, possibleValues?: readonly string[]): string {
	return possibleValues === undefined ? message : `${message}\n  [possible values: ${possibleValues.join(", ")}]`;
}
