/**
 * CLI argument parsing.
 *
 * The flag set is oracle's (`crates/coding-agent/src/main.rs:58-148`, the `#[derive(Parser)]
 * struct Cli`) laid over the skeleton's. Every oracle flag is parsed here; the skeleton-only flags
 * it does not have (`--api-key`, `--mode`, `--print`, `--export`, `--extension`, …) are kept
 * because removing them would delete working pi surface that oracle simply never grew — they are
 * a superset, not a divergence in oracle-reachable behavior.
 *
 * Help rendering lives in ./help.ts, which reproduces clap's page byte-for-byte, and the usage
 * errors below are ./usage-error.ts, which reproduces clap's *failure* page the same way — every
 * complaint this function can make is one clap would make, with clap's exit code 2 (phase 19 F9).
 */

import type { ThinkingLevel } from "@pie/agent-core";
import { clapValueOptionSpec } from "./help.ts";
import { argumentConflict, argumentRepeated, invalidValue, missingValue, unexpectedArgument } from "./usage-error.ts";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	session?: string;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	offline?: boolean;
	verbose?: boolean;

	// --- oracle-only flags (pie: main.rs:68-147) ---------------------------------------------
	/** pie: main.rs:76-77 `--base-url <URL>`. */
	baseUrl?: string;
	/**
	 * pie: main.rs:88-95 — `--resume <ID>` and `--resume-id <ID>` merged by `effective_resume_id`
	 * (`--resume-id` wins). Bare `--resume` sets {@link Args.resume} and opens the picker instead.
	 */
	resumeId?: string;
	/** pie: main.rs:98-99 `--list-sessions`. */
	listSessions?: boolean;
	/** pie: main.rs:101-102 `--list-all-sessions`. */
	listAllSessions?: boolean;
	/** pie: main.rs:104-105 `--delete-session <ID>`. */
	deleteSession?: string;
	/** pie: main.rs:108-109 `--image <PATH>`, repeatable. */
	images?: string[];
	/** pie: main.rs:116-117 `--builtin-skill <NAME>`, repeatable. */
	builtinSkills?: string[];
	/** pie: main.rs:121-122 `--trigger-poll-secs <SECONDS>`, `value_parser` range `1..`. */
	triggerPollSecs?: number;
	/** pie: main.rs:125-126 `--debug`. */
	debug?: boolean;
	/** pie: main.rs:129-130 `--yes`. */
	yes?: boolean;
	/** pie: main.rs:133-134 `--always-allow`. */
	alwaysAllow?: boolean;
	/** pie: main.rs:137-138 `--web`, conflicts with `--tui`. */
	web?: boolean;
	/** pie: main.rs:140-141 `--tui`, conflicts with `--web`. */
	tui?: boolean;
	/** pie: main.rs:143-144 `--web-host <HOST>`; oracle's clap default is `127.0.0.1`. */
	webHost?: string;
	/** pie: main.rs:146-147 `--web-port <PORT>`; oracle's clap default is `0`. */
	webPort?: number;

	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	/**
	 * The first usage error, already rendered in clap's envelope (`cli/usage-error.ts`), or
	 * `undefined` when the argument list parsed cleanly.
	 *
	 * *First*, not a list: clap aborts at the first usage error it hits and never reports a second
	 * (`pie --thinking wobble --web-port 70000` names only `--thinking`). This replaces the former
	 * `diagnostics` array, whose every member turned out to be a usage error printed as
	 * `Error: <msg>` with exit 1 — the wrong prefix and the wrong code (phase 19 F9/F12/F13).
	 */
	usageError?: string;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

/**
 * Skeleton-only options that take a value, with the value name clap would print for them.
 *
 * Oracle's options are not listed: their labels come from `cli/help.ts`'s table (the one that
 * renders `--help`) so the two can never disagree. These have no oracle counterpart at all — they
 * are the pi superset this file's header describes — so their labels are stated here.
 */
const SKELETON_VALUE_OPTIONS: Readonly<Record<string, string>> = {
	"--api-key": "API_KEY",
	"--mode": "MODE",
	"--system-prompt": "SYSTEM_PROMPT",
	"--append-system-prompt": "APPEND_SYSTEM_PROMPT",
	"--session": "SESSION",
	"--fork": "FORK",
	"--session-dir": "SESSION_DIR",
	"--models": "MODELS",
	"--tools": "TOOLS",
	"--export": "EXPORT",
	"--extension": "EXTENSION",
	"--skill": "SKILL",
	"--prompt-template": "PROMPT_TEMPLATE",
	"--theme": "THEME",
};

/**
 * Every flag spelling the switch below recognizes.
 *
 * Used for one decision only, and it is clap's: when a value-taking option is followed by a token
 * that starts with `-`, clap reports the *missing value* if that token is a flag it knows
 * (`pie --model --tui` → "a value is required for '--model <MODEL>'") and reports the token as
 * *unexpected* if it is not (`pie --trigger-poll-secs -5` → "unexpected argument '-5' found").
 * Both measured against the oracle binary.
 */
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
	"--help",
	"-h",
	"--version",
	"-v",
	"-V",
	"--mode",
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--no-session",
	"--session",
	"--fork",
	"--session-dir",
	"--models",
	"--no-tools",
	"-nt",
	"--no-builtin-tools",
	"-nbt",
	"--tools",
	"-t",
	"--thinking",
	"--print",
	"-p",
	"--export",
	"--extension",
	"-e",
	"--no-extensions",
	"-ne",
	"--skill",
	"--prompt-template",
	"--theme",
	"--no-skills",
	"-ns",
	"--no-prompt-templates",
	"-np",
	"--no-themes",
	"--no-context-files",
	"-nc",
	"--list-models",
	"--verbose",
	"--offline",
	"--base-url",
	"--resume-id",
	"--list-sessions",
	"--list-all-sessions",
	"--delete-session",
	"--image",
	"--builtin-skill",
	"--trigger-poll-secs",
	"--debug",
	"--yes",
	"--always-allow",
	"--web",
	"--tui",
	"--web-host",
	"--web-port",
]);

/**
 * Options upstream declares as repeatable. The rule against repeating an option does not
 * apply to them. pie: `main.rs:108-109` (`--image`), `:116-117` (`--builtin-skill`).
 */
const REPEATABLE_ORACLE_OPTIONS: ReadonlySet<string> = new Set(["--image", "--builtin-skill"]);

/** Short spellings of value-taking skeleton options; clap names the long form in its errors. */
const SHORT_VALUE_ALIASES: Readonly<Record<string, string>> = { "-t": "--tools", "-e": "--extension" };

/**
 * The clap label of a value-taking option (`--thinking <THINKING>`), plus its possible values and
 * whether oracle declares it. `undefined` for boolean flags, for bare-legal `--resume`/`--print`,
 * and for names nothing recognizes.
 */
function valueOptionSpec(
	flag: string,
): { label: string; possibleValues?: readonly string[]; oracle: boolean } | undefined {
	const canonical = SHORT_VALUE_ALIASES[flag] ?? flag;
	const oracle = canonical.startsWith("--") ? clapValueOptionSpec(canonical.slice(2)) : undefined;
	if (oracle) {
		return { label: oracle.label, possibleValues: oracle.possibleValues, oracle: true };
	}
	const skeleton = SKELETON_VALUE_OPTIONS[canonical];
	return skeleton === undefined ? undefined : { label: `${canonical} <${skeleton}>`, oracle: false };
}

/**
 * The usage error a value-taking option produces when the token after it cannot be its value, or
 * `undefined` when it can.
 *
 * pie: clap, measured against the oracle binary. `pie --model` (nothing follows) and
 * `pie --model --tui` (a *known* flag follows) both give "a value is required for '--model <MODEL>'
 * but none was supplied"; `pie --trigger-poll-secs -5` gives "unexpected argument '-5' found" with
 * the usage block, because `-5` is not a flag clap knows.
 *
 * That look-at-the-next-token half applies to oracle's options only. The skeleton-only options
 * (`--system-prompt`, `--append-system-prompt`, …) keep taking whatever follows them, because
 * `pie --system-prompt "-be terse"` is a working pi invocation that oracle has no opinion about,
 * and tightening it would delete surface rather than align it. They still fail on a genuinely
 * absent value, which is the typo this catches.
 */
function missingValueError(flag: string, next: string | undefined): string | undefined {
	const spec = valueOptionSpec(flag);
	if (spec === undefined) return undefined;
	if (next === undefined) return missingValue(spec.label, spec.possibleValues);
	if (!spec.oracle || !next.startsWith("-") || next === "-") return undefined;
	return KNOWN_FLAGS.has(next) ? missingValue(spec.label, spec.possibleValues) : unexpectedArgument(next);
}

/**
 * Expands the `--flag=value` form into two tokens, `--flag` and `value`.
 *
 * The dispatch loop below matches on exact flag names, one branch per flag, so
 * `--thinking=high` matched nothing, fell through to the unknown-flag catch-all, and was
 * reported as `unexpected argument '--thinking' found`. Verified on both sides: the
 * space-separated form already behaved identically, the joined form did not.
 *
 * So this was not one option being missed. **The `--long=value` form was not parsed at
 * all**, and it is the standard way to write it. Expanding it first leaves every existing
 * branch untouched, including the value validation and the error text, which now line up
 * on their own.
 *
 * Only options known to take a value are expanded. A boolean flag written as `--yes=1`,
 * and a wholly unknown `--nope=1`, keep the old path so that a value is never swallowed as
 * a positional argument.
 */
function expandLongEqualsValue(args: readonly string[]): string[] {
	const out: string[] = [];
	for (const arg of args) {
		if (arg.startsWith("--") && arg.includes("=")) {
			const eq = arg.indexOf("=");
			const flag = arg.slice(0, eq);
			if (valueOptionSpec(flag) !== undefined) {
				out.push(flag, arg.slice(eq + 1));
				continue;
			}
		}
		out.push(arg);
	}
	return out;
}

export function parseArgs(rawArgs: string[]): Args {
	const args = expandLongEqualsValue(rawArgs);
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
	};
	/** Record the first usage error and ignore the rest, as clap does. */
	const fail = (rendered: string): void => {
		result.usageError ??= rendered;
	};

	/**
	 * Repeating an option that cannot repeat is a hard error upstream, verified against the
	 * binary. This side used to let the last occurrence win and carry on: `--resume-id a
	 * --resume-id b` exited 0 and opened `b`, turning a typing mistake into a real action on
	 * the wrong session.
	 *
	 * Only options upstream declares are affected. `--tools` and `--extension` exist solely in
	 * this implementation and upstream reports them as unexpected arguments, so this side
	 * should not invent a rule upstream never had.
	 */
	const seenOracleOptions = new Set<string>();
	const rejectRepeat = (flag: string): boolean => {
		// The rule covers only options that cannot repeat. Upstream has exactly two that can,
		// both annotated as repeatable where its arguments are defined (`main.rs:108-109` `--image`,
		// `:116-117` `--builtin-skill`). Each was verified against
		// the binary: repeating those exits 0, while repeating any of the other nine value-taking
		// options exits 2. The first version did not exclude them, which turned a legitimate
		// repeated `--image` into an error — caught immediately by an existing test.
		if (REPEATABLE_ORACLE_OPTIONS.has(flag)) return false;
		const spec = valueOptionSpec(flag);
		if (spec === undefined || !spec.oracle) return false;
		if (seenOracleOptions.has(spec.label)) {
			fail(argumentRepeated(spec.label));
			return true;
		}
		seenOracleOptions.add(spec.label);
		return false;
	};

	for (let i = 0; i < args.length; i++) {
		if (args[i].startsWith("-") && rejectRepeat(args[i])) break;
		const arg = args[i];

		// pie: clap validates an option's value the moment it consumes it, so a value-taking flag
		// with nothing usable after it fails here rather than being filed under `unknownFlags` and
		// resurfacing later as "Unknown option: --model" (which is what this side used to say about
		// a flag it very much knows, with exit 1 instead of 2).
		const valueError = missingValueError(arg, args[i + 1]);
		if (valueError !== undefined) {
			fail(valueError);
			break;
		}

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v" || arg === "-V") {
			// pie: main.rs:61 `version` — clap's short is `-V`. `-v` is the skeleton's spelling and
			// is kept so existing pi invocations do not start erroring.
			result.version = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc") {
				result.mode = mode;
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume") {
			// pie: main.rs:88 `#[arg(long, value_name = "ID", num_args = 0..=1)]` — clap consumes the
			// next token as the id when it does not look like a flag, otherwise `--resume` is bare
			// and opens the picker (main.rs:206-214 `effective_resume_id`).
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				result.resumeId = args[++i];
			} else {
				result.resume = true;
			}
		} else if (arg === "-r") {
			// Skeleton-only short spelling; oracle has no `-r`, so nothing constrains it and it stays
			// value-less (keeps `pi -r "prompt"` working).
			result.resume = true;
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session" && i + 1 < args.length) {
			result.session = args[++i];
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			result.tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
		} else if (arg === "--thinking" && i + 1 < args.length) {
			// pie: main.rs:80-83 — `value_parser = commands::THINKING_LEVEL_VALUES`, i.e. clap rejects
			// an unlisted level and never starts. Phase 19 F12: this side warned and then ran on the
			// default, so `pie --thinking hihg` bought a session the user believed was thinking and
			// which was not — the one outcome worse than either refusing or obeying.
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				fail(invalidValue(level, "--thinking <THINKING>", { possibleValues: VALID_THINKING_LEVELS }));
				break;
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg === "--base-url" && i + 1 < args.length) {
			// pie: main.rs:76-77.
			result.baseUrl = args[++i];
		} else if (arg === "--resume-id" && i + 1 < args.length) {
			// pie: main.rs:94-95 — wins over `--resume <id>` (main.rs:209-212).
			result.resumeId = args[++i];
		} else if (arg === "--list-sessions") {
			// pie: main.rs:98-99.
			result.listSessions = true;
		} else if (arg === "--list-all-sessions") {
			// pie: main.rs:101-102.
			result.listAllSessions = true;
		} else if (arg === "--delete-session" && i + 1 < args.length) {
			// pie: main.rs:104-105.
			result.deleteSession = args[++i];
		} else if (arg === "--image" && i + 1 < args.length) {
			// pie: main.rs:108-109 — `Vec<PathBuf>`, repeatable.
			result.images = result.images ?? [];
			result.images.push(args[++i]);
		} else if (arg === "--builtin-skill" && i + 1 < args.length) {
			// pie: main.rs:116-117 — `Vec<String>`, repeatable.
			result.builtinSkills = result.builtinSkills ?? [];
			result.builtinSkills.push(args[++i]);
		} else if (arg === "--trigger-poll-secs" && i + 1 < args.length) {
			// pie: main.rs:121-122 — `clap::value_parser!(u64).range(1..)`. The two failure wordings are
			// that parser's own: a non-number is `invalid digit found in string`, an out-of-range
			// number names the range, and `1..18446744073709551615` is `u64::MAX` spelled out — noisier
			// than "must be an integer >= 1", which is what this said before, but it is what a script
			// grepping oracle's stderr already matches on.
			const raw = args[++i];
			const secs = Number(raw);
			const label = "--trigger-poll-secs <SECONDS>";
			if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(secs)) {
				fail(invalidValue(raw, label, { reason: "invalid digit found in string" }));
				break;
			}
			if (secs < 1) {
				fail(invalidValue(raw, label, { reason: `${raw} is not in 1..18446744073709551615` }));
				break;
			}
			result.triggerPollSecs = secs;
		} else if (arg === "--debug") {
			// pie: main.rs:125-126.
			result.debug = true;
		} else if (arg === "--yes") {
			// pie: main.rs:129-130.
			result.yes = true;
		} else if (arg === "--always-allow") {
			// pie: main.rs:133-134.
			result.alwaysAllow = true;
		} else if (arg === "--web") {
			// pie: main.rs:137-138.
			result.web = true;
		} else if (arg === "--tui") {
			// pie: main.rs:140-141.
			result.tui = true;
		} else if (arg === "--web-host" && i + 1 < args.length) {
			// pie: main.rs:143-144.
			result.webHost = args[++i];
		} else if (arg === "--web-port" && i + 1 < args.length) {
			// pie: main.rs:146-147 — clap parses it as `u16`, so the same two wordings as
			// `--trigger-poll-secs` above, with u16's range.
			const raw = args[++i];
			const port = Number(raw);
			const label = "--web-port <PORT>";
			if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(port)) {
				fail(invalidValue(raw, label, { reason: "invalid digit found in string" }));
				break;
			}
			if (port > 65535) {
				fail(invalidValue(raw, label, { reason: `${raw} is not in 0..=65535` }));
				break;
			}
			result.webPort = port;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			// A short flag nothing recognizes. clap has one answer for both this and an unknown long
			// flag, and it is not `Error: Unknown option: -z` with exit 1 (phase 19 F13).
			fail(unexpectedArgument(arg));
			break;
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	// pie: main.rs:137,140 — `conflicts_with` on both sides of the `--web`/`--tui` pair. clap rejects
	// the combination at parse time and its `Usage:` line names whichever of the two it saw first:
	// `pie --web --tui` reports `Usage: pie --web`, `pie --tui --web` reports `Usage: pie --tui`.
	if (result.usageError === undefined && result.web && result.tui) {
		const webFirst = args.indexOf("--web") < args.indexOf("--tui");
		fail(webFirst ? argumentConflict("--web", "--tui") : argumentConflict("--tui", "--web"));
	}

	return result;
}
