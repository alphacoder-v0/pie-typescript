/**
 * 1:1 port of oracle `crates/coding-agent/tests/cli_help.rs` (pie @0a120dfd) — 6 `#[test]`
 * functions, 6 tests here.
 *
 * Oracle spawns the built binary via `Command::new(env!("CARGO_BIN_EXE_pie"))`. The TS
 * counterpart spawns the repo-root `./pie` launcher, which execs
 * `packages/coding-agent/dist/cli.js` — the exact artifact `migration/parity/run-parity.sh`
 * drives, so these tests characterize the same bytes the parity judge compares against oracle.
 * `dist/` must therefore be current: run `npm run build` before this file (the repo's `npm test`
 * entry point does; a bare `npx vitest run` does not — {@link requireBuiltCli} fails loudly with
 * that instruction rather than silently testing a stale binary).
 *
 * Test-name / oracle-line mapping:
 *  1. help_lists_thinking_possible_values          -> oracle :3
 *  2. help_lists_model_catalog_entry_points        -> oracle :17
 *  3. help_lists_control_plane_yes_flag            -> oracle :39
 *  4. help_lists_web_and_tui_mode_flags            -> oracle :59
 *  5. session_import_help_shows_subcommand_options -> oracle :75  (passing since phase 19)
 *  6. invalid_thinking_value_reports_candidates    -> oracle :93  (passing since phase 19)
 *
 * **No test in this file is `it.fails` any more, and none should be re-marked.** Tests 5 and 6 both
 * were, each carrying an assertion that was oracle's verbatim and failed against the TS binary for
 * a reason belonging to another migration unit. Both forcing functions have now fired:
 *
 * - Test 5: phase 19's F2 wired the `session` subcommand's help surfaces (`src/subcommands.ts`), so
 *   `pie session import --help` renders oracle's *subcommand* page on stdout instead of the
 *   top-level page on stderr.
 * - Test 6: phase 19's F12/F9 made `--thinking turbo` clap's usage error — exit **2** with
 *   `error: invalid value 'turbo' for '--thinking <THINKING>'`, the possible-values line and
 *   "For more information, try '--help'." — where this side used to print `Warning: Invalid
 *   thinking level "turbo"` and then run on the default with exit 0 (`src/cli/args.ts`,
 *   `src/cli/usage-error.ts`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo root: packages/coding-agent/test/ported -> ../../../.. */
const REPO_ROOT = resolve(__dirname, "../../../..");
const PIE_LAUNCHER = join(REPO_ROOT, "pie");
const BUILT_CLI = join(REPO_ROOT, "packages/coding-agent/dist/cli.js");

/** Isolated `~/.pie` for every child process. `HOME` is deliberately left alone — the repo's
 * `find` tool resolves its fd/rg binaries from `$HOME/.pie/bin`, and an empty HOME makes
 * unrelated suites hang. */
let pieDir: string;

beforeAll(() => {
	pieDir = mkdtempSync(join(tmpdir(), "pie-cli-help-"));
});

afterAll(() => {
	rmSync(pieDir, { recursive: true, force: true });
});

function requireBuiltCli(): void {
	if (!existsSync(BUILT_CLI)) {
		throw new Error(`missing ${BUILT_CLI} — run \`npm run build\` before this suite (or use \`npm test\`)`);
	}
}

interface CliRun {
	status: number;
	stdout: string;
	stderr: string;
}

/** oracle: `Command::new(env!("CARGO_BIN_EXE_pie")).args(..).output()`. */
function runPie(args: string[]): CliRun {
	requireBuiltCli();
	try {
		const stdout = execFileSync(PIE_LAUNCHER, args, {
			encoding: "utf8",
			env: { ...process.env, PIE_DIR: pieDir, PI_NO_LOCAL_LLM: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60_000,
		});
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const err = error as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
		if (err.status === undefined || err.status === null) throw error;
		return {
			status: err.status,
			stdout: String(err.stdout ?? ""),
			stderr: String(err.stderr ?? ""),
		};
	}
}

describe("cli_help.rs (char-tests port)", () => {
	// oracle cli_help.rs:3-15
	it("help_lists_thinking_possible_values", () => {
		const output = runPie(["--help"]);
		expect(output.status).toBe(0);
		expect(output.stdout, `help should list accepted --thinking values:\n${output.stdout}`).toContain(
			"[possible values: off, minimal, low, medium, high, xhigh]",
		);
	}, 60_000);

	// oracle cli_help.rs:17-37
	it("help_lists_model_catalog_entry_points", () => {
		const output = runPie(["--help"]);
		expect(output.status).toBe(0);
		const stdout = output.stdout;
		expect(stdout).toContain("Model catalog:");
		expect(stdout).toContain("Supported providers");
		expect(stdout).toContain("anthropic(");
		expect(stdout).toContain("openai(");
		expect(stdout).toContain("~/.pie/models.json");
		expect(stdout).toContain("<cwd>/.pie/models.json");
		expect(stdout.includes("/model list") || stdout.includes("model list")).toBe(true);
		expect(stdout).not.toContain("auth.json");
		expect(stdout).not.toContain("API_KEY");
	}, 60_000);

	// oracle cli_help.rs:39-57
	it("help_lists_control_plane_yes_flag", () => {
		const output = runPie(["--help"]);
		expect(output.status).toBe(0);
		const stdout = output.stdout;
		expect(stdout).toContain("--yes");
		expect(stdout).toContain("Auto-approve control-plane prompts");
		expect(stdout).toContain("--always-allow");
		expect(stdout).toContain("Auto-approve every approval prompt");
	}, 60_000);

	// oracle cli_help.rs:59-73
	it("help_lists_web_and_tui_mode_flags", () => {
		const output = runPie(["--help"]);
		expect(output.status).toBe(0);
		const stdout = output.stdout;
		expect(stdout).toContain("--web");
		expect(stdout).toContain("--tui");
		expect(stdout).toContain("Run the terminal UI even when local defaults would open the Web UI");
	}, 60_000);

	// oracle cli_help.rs:75-91. Passing since phase 19's F2 fix: `src/subcommands.ts` renders
	// oracle's `session import` page (byte-for-byte, on stdout) instead of the top-level page.
	it("session_import_help_shows_subcommand_options", () => {
		const output = runPie(["session", "import", "--help"]);
		expect(output.status).toBe(0);
		const stdout = output.stdout;
		expect(stdout).toContain("Import a `.piesession` archive");
		expect(stdout).toContain("--cwd");
		expect(stdout).toContain("--activate-triggers");
		expect(stdout).toContain("ask is reserved");
		expect(stdout).not.toContain("Model catalog:");
	}, 60_000);

	// oracle cli_help.rs:93-106. Passing since phase 19's F12/F9 fix: an unlisted `--thinking` value
	// is now clap's usage error (exit 2, `error: invalid value 'turbo' for '--thinking <THINKING>'`
	// plus the possible-values line) instead of a warning followed by a run on the default. The
	// assertions below are oracle's verbatim and are unchanged; only `.fails` came off.
	it("invalid_thinking_value_reports_candidates", () => {
		const output = runPie(["--thinking", "turbo", "--list-sessions"]);
		expect(output.status, "oracle exits non-zero on an invalid --thinking value").not.toBe(0);
		expect(output.stderr).toContain("invalid value 'turbo'");
		expect(output.stderr).toContain("[possible values: off, minimal, low, medium, high, xhigh]");
		// Beyond oracle's own assertion: clap's code is specifically 2, and this side used to
		// answer 0 here.
		expect(output.status).toBe(2);
	}, 60_000);
});
