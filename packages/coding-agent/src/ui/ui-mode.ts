/**
 * Which front-end a `pie` invocation gets: the web UI, the full-screen terminal UI, or the
 * line-based headless fallback.
 *
 * ## Why this lives under `ui/` and not in `main.ts`
 *
 * Oracle keeps `UiMode` / `resolve_ui_mode` / `is_remote_tty_env` / `should_run_web` in
 * `crates/coding-agent/src/main.rs:1071-1105` (the `#[cfg(test)]` block at :1502-1534 is the
 * acceptance evidence for the default). The TS `coding-agent/main` unit is a **diff-port onto pi's
 * `main.ts`**, whose mode selection (`resolveAppMode`) answers a different question entirely
 * (interactive / print / json / rpc). Grafting oracle's UI-mode rule into that function would fuse
 * two unrelated decisions, so the rule is ported here as a pure, dependency-free function that the
 * `main.ts` wiring step calls. Everything below is verbatim oracle behavior; only the file changed.
 *
 * RULEBOOK §5 "also, behavior is the specification": **a local TTY running the TUI outside SSH opens the web UI by default** — this module is where that
 * sentence is enforced and tested.
 */

/** pie: main.rs:1071-1077 (`enum UiMode`) — a unit-only enum, so a string literal union (§2.1). */
export type UiMode = "web" | "tui" | "headless";

/**
 * pie: main.rs:1087-1098 (`resolve_ui_mode`). Precedence, in order:
 *  1. `--web` wins outright.
 *  2. `--tui` forces the terminal UI even on a local TTY.
 *  3. No interactive TTY at all → headless, regardless of the remote-tty probe.
 *  4. Otherwise: a **remote** TTY (ssh/mosh) keeps the terminal UI; a **local** TTY opens the web
 *     UI. This inverted-looking default is deliberate — see the module doc.
 */
export function resolveUiMode(web: boolean, tui: boolean, interactiveTty: boolean, remoteTty: boolean): UiMode {
	// pie: main.rs:1088-1090.
	if (web) {
		return "web";
	}
	// pie: main.rs:1091-1093.
	if (tui) {
		return "tui";
	}
	// pie: main.rs:1094-1096.
	if (!interactiveTty) {
		return "headless";
	}
	// pie: main.rs:1097.
	return remoteTty ? "tui" : "web";
}

/**
 * pie: main.rs:1100-1105 (`is_remote_tty_env`). Oracle passes `|name| std::env::var_os(name)
 * .is_some()` — **presence**, not non-emptiness, so `SSH_TTY=` (set but empty) still counts as
 * remote. `process.env` reproduces `var_os` presence exactly: an unset variable reads back
 * `undefined`, an empty one reads back `""`.
 *
 * Note this is a *different* predicate from `utils/clipboard.ts`'s SSH probe, which omits `SSH_TTY`
 * and truthiness-checks the values. Both are faithful to their own oracle sites; they are not
 * interchangeable.
 */
export function isRemoteTtyEnv(hasEnv: (name: string) => boolean): boolean {
	// pie: main.rs:1102 — order is oracle's; `.some()` short-circuits like Rust's `.any()`.
	return ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "MOSH_CONNECTION"].some((name) => hasEnv(name));
}

/** `is_remote_tty_env` bound to the real environment, as `should_run_web` binds it. */
export function isRemoteTty(env: NodeJS.ProcessEnv = process.env): boolean {
	return isRemoteTtyEnv((name) => env[name] !== undefined);
}

/** The TTY / env probes `should_run_web` reads, injectable so tests need no real terminal. */
export interface UiModeProbes {
	/** pie: main.rs:1082 (`std::io::stdin().is_terminal()`). */
	stdinIsTty: boolean;
	/** pie: main.rs:1082 (`std::io::stdout().is_terminal()`). */
	stdoutIsTty: boolean;
	/** pie: main.rs:1083 (`is_remote_tty_env(…)`). */
	env: NodeJS.ProcessEnv;
}

/** The real process probes. `process.stdin.isTTY` is `undefined` (not `false`) when not a TTY. */
export function processUiModeProbes(): UiModeProbes {
	return {
		stdinIsTty: process.stdin.isTTY === true,
		stdoutIsTty: process.stdout.isTTY === true,
		env: process.env,
	};
}

/**
 * pie: main.rs:1079-1085 (`should_run_web`). `web` / `tui` are the parsed `--web` / `--tui` flags.
 */
export function shouldRunWeb(
	flags: { web: boolean; tui: boolean },
	probes: UiModeProbes = processUiModeProbes(),
): boolean {
	return (
		resolveUiMode(flags.web, flags.tui, probes.stdinIsTty && probes.stdoutIsTty, isRemoteTty(probes.env)) === "web"
	);
}

/** The whole resolver bound to the real process, for callers that need the mode, not a boolean. */
export function currentUiMode(
	flags: { web: boolean; tui: boolean },
	probes: UiModeProbes = processUiModeProbes(),
): UiMode {
	return resolveUiMode(flags.web, flags.tui, probes.stdinIsTty && probes.stdoutIsTty, isRemoteTty(probes.env));
}
