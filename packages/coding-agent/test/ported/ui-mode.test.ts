/**
 * Port of oracle `crates/coding-agent/src/main.rs`'s UI-mode tests (pie @0a120dfd, :1502-1534) —
 * the five `#[test]` fns that pin **a local TTY outside SSH opening the web UI by default**, plus
 * coverage of the
 * `should_run_web` binding those tests do not reach.
 *
 * RULEBOOK §5's "also, behavior is the specification" list ends with exactly this rule, and it is
 * the phase-14
 * acceptance criterion carried into phase 15. Both TTY probes and the env probe are injected, so
 * nothing here needs a real terminal or a real ssh session.
 */

import { describe, expect, it } from "vitest";
import {
	currentUiMode,
	isRemoteTty,
	isRemoteTtyEnv,
	resolveUiMode,
	shouldRunWeb,
	type UiModeProbes,
} from "../../src/ui/ui-mode.ts";

/** `(web, tui, interactive_tty, remote_tty)` in oracle's argument order. */
describe("resolve_ui_mode — main.rs:1087-1098", () => {
	it("defaults to web for a LOCAL tty (main.rs:1508-1510)", () => {
		expect(resolveUiMode(false, false, true, false)).toBe("web");
	});

	it("defaults to tui for a REMOTE tty (main.rs:1513-1515)", () => {
		expect(resolveUiMode(false, false, true, true)).toBe("tui");
	});

	it("keeps headless for a non-tty (main.rs:1518-1523)", () => {
		expect(resolveUiMode(false, false, false, false)).toBe("headless");
	});

	it("lets explicit flags override the default (main.rs:1526-1529)", () => {
		// `--web` beats even a remote tty.
		expect(resolveUiMode(true, false, true, true)).toBe("web");
		// `--tui` beats the local-tty web default.
		expect(resolveUiMode(false, true, true, false)).toBe("tui");
	});

	it("gives --web precedence over --tui when both are set (main.rs:1088-1093)", () => {
		expect(resolveUiMode(true, true, true, false)).toBe("web");
	});

	it("checks the flags BEFORE the tty guard (main.rs:1088-1096)", () => {
		// The `!interactive_tty` guard sits below both flag checks, so an explicit flag still wins.
		expect(resolveUiMode(true, false, false, false)).toBe("web");
		expect(resolveUiMode(false, true, false, false)).toBe("tui");
		// …but with no flag at all, no tty means headless regardless of the remote probe.
		expect(resolveUiMode(false, false, false, true)).toBe("headless");
	});
});

describe("is_remote_tty_env — main.rs:1100-1105", () => {
	it("detects ssh and mosh (main.rs:1532-1534)", () => {
		expect(isRemoteTtyEnv((name) => name === "SSH_CONNECTION")).toBe(true);
		expect(isRemoteTtyEnv((name) => name === "MOSH_CONNECTION")).toBe(true);
		expect(isRemoteTtyEnv(() => false)).toBe(false);
	});

	it("covers all four names oracle lists", () => {
		for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "MOSH_CONNECTION"]) {
			expect(
				isRemoteTtyEnv((candidate) => candidate === name),
				name,
			).toBe(true);
		}
	});

	it("treats a SET-BUT-EMPTY variable as remote (main.rs:1083 uses var_os().is_some())", () => {
		// Oracle probes *presence*, not truthiness — `SSH_TTY=` still means "remote".
		expect(isRemoteTty({ SSH_TTY: "" })).toBe(true);
		expect(isRemoteTty({})).toBe(false);
	});
});

/** `should_run_web` binds the resolver to the process probes (main.rs:1079-1085). */
describe("should_run_web — main.rs:1079-1085", () => {
	const probes = (stdin: boolean, stdout: boolean, env: NodeJS.ProcessEnv): UiModeProbes => ({
		stdinIsTty: stdin,
		stdoutIsTty: stdout,
		env,
	});

	it("opens the web UI on a local tty with no flags", () => {
		expect(shouldRunWeb({ web: false, tui: false }, probes(true, true, {}))).toBe(true);
		expect(currentUiMode({ web: false, tui: false }, probes(true, true, {}))).toBe("web");
	});

	it("--tui forces the terminal UI on that same local tty", () => {
		expect(shouldRunWeb({ web: false, tui: true }, probes(true, true, {}))).toBe(false);
		expect(currentUiMode({ web: false, tui: true }, probes(true, true, {}))).toBe("tui");
	});

	it("an ssh session keeps the terminal UI without any flag", () => {
		const env = { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 51000" };
		expect(shouldRunWeb({ web: false, tui: false }, probes(true, true, env))).toBe(false);
		expect(currentUiMode({ web: false, tui: false }, probes(true, true, env))).toBe("tui");
	});

	it("requires BOTH streams to be a tty (main.rs:1082 is an &&)", () => {
		expect(currentUiMode({ web: false, tui: false }, probes(true, false, {}))).toBe("headless");
		expect(currentUiMode({ web: false, tui: false }, probes(false, true, {}))).toBe("headless");
		expect(shouldRunWeb({ web: false, tui: false }, probes(false, false, {}))).toBe(false);
	});

	it("--web opens the web UI even piped, and even over ssh", () => {
		expect(shouldRunWeb({ web: true, tui: false }, probes(false, false, { SSH_TTY: "/dev/pts/0" }))).toBe(true);
	});
});
