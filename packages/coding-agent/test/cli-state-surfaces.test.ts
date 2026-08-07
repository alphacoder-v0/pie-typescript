/**
 * Regression tests for phase 19's state-surface audit (`migration/reviews/phase19/state-surfaces.md`),
 * findings F1 through F14.
 *
 * These drive the BUILT binary (the repo-root `./pie` launcher → `packages/coding-agent/dist/cli.js`),
 * because every one of these findings is about what a real process writes to a real fd and what it
 * exits with — none of them is visible from inside the module graph. `npm run build` must therefore
 * be current; {@link requireBuiltCli} says so loudly rather than testing a stale artifact, same
 * contract as `test/ported/cli-help.test.ts`.
 *
 * **stdout and stderr are asserted separately, always.** F1 (`pie --version` writing the version to
 * stderr) survived every previous gate because the one thing that captured it — parity scenario
 * `s1-help.sh` — captures with `2>&1`, and a merged stream cannot show which fd the bytes came out
 * of. Any future test of a CLI surface here must keep the streams apart for the same reason.
 *
 * Isolation: each run gets a fresh `PIE_DIR` (oracle's `${PIE_DIR:-$HOME/.pie}` override,
 * `config.ts:482`) and a fresh cwd, and every provider credential is stripped from the child env
 * unless the case under test needs one — this machine has real keys, and a test that silently
 * picked one up would be both non-hermetic and capable of making a network call.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	resolveSubcommandInvocation,
	SESSION_HELP_PAGE,
	SESSION_IMPORT_HELP_PAGE,
	topLevelStaticHelpPage,
} from "../src/subcommands.ts";
import { describeErrorChain } from "../src/utils/error-chain.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo root: packages/coding-agent/test -> ../../.. */
const REPO_ROOT = resolve(__dirname, "../../..");
const PIE_LAUNCHER = join(REPO_ROOT, "pie");
const BUILT_CLI = join(REPO_ROOT, "packages/coding-agent/dist/cli.js");

const PROVIDER_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"DS4_API_KEY",
	"DS4_BASE_URL",
	"DS4_URL",
];

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function requireBuiltCli(): void {
	if (!existsSync(BUILT_CLI)) {
		throw new Error(`missing ${BUILT_CLI} — run \`npm run build\` before this suite (or use \`npm test\`)`);
	}
}

interface CliRun {
	status: number;
	stdout: string;
	stderr: string;
	pieDir: string;
	cwd: string;
}

interface RunOptions {
	/** Extra env for this run, e.g. a fake credential. Applied after the scrub. */
	readonly env?: Record<string, string>;
	/** Reuse a `PIE_DIR` prepared by the caller (to seed a `models.json`). */
	readonly pieDir?: string;
	/**
	 * Reuse a cwd from a previous run. Session state is keyed on BOTH the agent dir and a hash of
	 * the cwd, so "run once to create a session, then run again and see it" needs the pair held
	 * fixed — which is exactly what the resume/continue cases below assert.
	 */
	readonly cwd?: string;
}

function runPie(args: string[], options: RunOptions = {}): CliRun {
	requireBuiltCli();
	const pieDir = options.pieDir ?? tempDir("pie-p19-dir-");
	const cwd = options.cwd ?? tempDir("pie-p19-cwd-");

	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of PROVIDER_ENV_KEYS) delete env[key];
	Object.assign(env, {
		PIE_DIR: pieDir,
		PI_NO_LOCAL_LLM: "1",
		PI_SKIP_VERSION_CHECK: "1",
		...options.env,
	});

	try {
		const stdout = execFileSync(PIE_LAUNCHER, args, {
			cwd,
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60_000,
		});
		return { status: 0, stdout, stderr: "", pieDir, cwd };
	} catch (error) {
		const err = error as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
		if (err.status === undefined || err.status === null) throw error;
		return {
			status: err.status,
			stdout: String(err.stdout ?? ""),
			stderr: String(err.stderr ?? ""),
			pieDir,
			cwd,
		};
	}
}

/**
 * The session directory `pie` derives for a cwd: `<agent dir>/sessions/<first 6 bytes of
 * sha256(cwd), hex>`. pie: `crates/coding-agent/src/config.rs:21-38`. Recomputed here rather than
 * imported, so a change to the production hash shows up as a failing test instead of silently
 * agreeing with itself — and the same 12 characters were verified against the oracle binary for a
 * shared cwd (`2986030bdb40` on both sides).
 */
function sessionsDirFor(pieDir: string, cwd: string): string {
	const hash = createHash("sha256").update(cwd, "utf8").digest().subarray(0, 6).toString("hex");
	return join(pieDir, "sessions", hash);
}

describe("F1 — oracle's stdout surfaces must reach stdout", () => {
	it("--version writes the version to stdout and nothing to stderr", () => {
		const run = runPie(["--version"]);
		// Before the fix: stdout "" / stderr "pie 0.75.0\n" — `V=$(pie --version)` captured "".
		expect(run.stdout).toBe("pie 0.75.0\n");
		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
	}, 60_000);

	it("-V behaves identically", () => {
		const run = runPie(["-V"]);
		expect(run.stdout).toBe("pie 0.75.0\n");
		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
	}, 60_000);

	it("--list-models prints the table on stdout, not stderr", () => {
		const run = runPie(["--list-models"], { env: { ANTHROPIC_API_KEY: "sk-ant-fake" } });
		// Before the fix: the whole 1.7 KB table was on stderr and stdout was 0 bytes.
		expect(run.stdout).toContain("provider");
		expect(run.stdout).toContain("anthropic");
		expect(run.stdout.length).toBeGreaterThan(200);
		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
	}, 60_000);
});

describe("F2 — advertised subcommands must not become chat prompts", () => {
	it("`pie session` prints the subcommand page on stderr with exit 2 and never reaches the provider", () => {
		const run = runPie(["session"]);
		// Before the fix: exit 1 and "No API key found for anthropic." — i.e. the token had been
		// filed as a prompt and the run was on its way to the provider (with a key present it
		// came back as a raw HTTP 401).
		expect(run.status).toBe(2);
		expect(run.stderr).toBe(SESSION_HELP_PAGE);
		expect(run.stdout).toBe("");
		expect(run.stderr).not.toContain("API key");
	}, 60_000);

	it("`pie session --help` prints the subcommand page on stdout, not the top-level page on stderr", () => {
		const run = runPie(["session", "--help"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toBe(SESSION_HELP_PAGE);
		expect(run.stderr).toBe("");
		// Before the fix: the 3782-byte TOP-LEVEL page, on stderr.
		expect(run.stdout).not.toContain("Model catalog:");
	}, 60_000);

	it("`pie session import --help` prints the import page", () => {
		const run = runPie(["session", "import", "--help"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toBe(SESSION_IMPORT_HELP_PAGE);
		expect(run.stderr).toBe("");
	}, 60_000);

	it("`pie help` prints the static top-level page on stdout with exit 0", () => {
		const run = runPie(["help"]);
		// Before the fix: exit 1 with the no-credential chat error, because `help` was a prompt.
		expect(run.status).toBe(0);
		expect(run.stdout).toBe(topLevelStaticHelpPage());
		expect(run.stderr).toBe("");
		// oracle attaches the `Model catalog:` block on the `--help` path only.
		expect(run.stdout).not.toContain("Model catalog:");
		expect(run.stdout).toContain("Usage: pie [OPTIONS] [COMMAND]");
	}, 60_000);

	it("`pie session export <positional>` is a usage error, not a prompt", () => {
		const run = runPie(["session", "export", "nope.piesession"]);
		expect(run.status).toBe(2);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(
			"error: unexpected argument 'nope.piesession' found\n\n" +
				"Usage: pie session export [OPTIONS]\n\nFor more information, try '--help'.\n",
		);
	}, 60_000);

	it("`pie session export` refuses explicitly instead of prompting (declared divergence: oracle exports)", () => {
		const run = runPie(["session", "export"]);
		expect(run.status).toBe(2);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("`pie session export` is not implemented in this port yet");
		expect(run.stderr).toContain("/session export");
		expect(run.stderr).not.toContain("API key");
	}, 60_000);

	it("an ordinary prompt is still an ordinary prompt", () => {
		// The recognition rule must not swallow real prompts: nothing here is a subcommand.
		expect(resolveSubcommandInvocation(["--tui"])).toBeUndefined();
		expect(resolveSubcommandInvocation(["explain this repo"])).toBeUndefined();
		expect(resolveSubcommandInvocation(["-p", "session"])).toBeUndefined();
	});

	it("an unknown session verb is a clap-shaped usage error", () => {
		const outcome = resolveSubcommandInvocation(["session", "nope"]);
		expect(outcome).toEqual({
			text: "error: unrecognized subcommand 'nope'\n\nUsage: pie session <COMMAND>\n\nFor more information, try '--help'.\n",
			stream: 2,
			exitCode: 2,
		});
	});
});

describe("F3 — --builtin-skill hard-fails on an unknown name", () => {
	it("prints oracle's message on stderr and exits 2", () => {
		const run = runPie(["--builtin-skill", "no-such-skill", "--tui"], {
			env: { ANTHROPIC_API_KEY: "sk-ant-fake" },
		});
		// Before the fix: exit 0, empty stderr, a normal-looking session with the skill silently off
		// — while `--help` claims "Unknown names hard-fail with a list of available built-ins".
		expect(run.status).toBe(2);
		expect(run.stderr).toBe(
			"error: unknown built-in skill(s) requested via --builtin-skill: no-such-skill. Available: karpathy-guidelines.\n",
		);
		expect(run.stdout).toBe("");
	}, 60_000);

	it("a known built-in name still starts normally", () => {
		const run = runPie(["--builtin-skill", "karpathy-guidelines", "--tui"], {
			env: { ANTHROPIC_API_KEY: "sk-ant-fake" },
		});
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("pie-coding-agent");
	}, 60_000);

	it("session-management commands are unaffected (they return before oracle's run_repl)", () => {
		const run = runPie(["--builtin-skill", "no-such-skill", "--list-sessions"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toBe("(no sessions for this cwd)\n");
	}, 60_000);
});

describe("F4 — the default model is the auto-detected one", () => {
	it("picks anthropic/claude-haiku-4-5 when ANTHROPIC_API_KEY is set and no flag says otherwise", () => {
		const run = runPie(["--tui"], { env: { ANTHROPIC_API_KEY: "sk-ant-fake" } });
		// Before the fix: `anthropic/claude-opus-4-7` — auto-detection ran as a throw-probe and its
		// result was dropped, so the skeleton default won. Same env, no flags, an order of
		// magnitude apart in unit price.
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("anthropic/claude-haiku-4-5");
		expect(run.stdout).not.toContain("claude-opus-4-7");
	}, 60_000);

	it("still starts on the credential-less default when no key is present", () => {
		const run = runPie(["--tui"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("anthropic/claude-haiku-4-5");
	}, 60_000);
});

describe("F6 — a malformed models.json is fatal and says why", () => {
	function seedModelsJson(contents: string): string {
		const pieDir = tempDir("pie-p19-dir-");
		mkdirSync(pieDir, { recursive: true });
		writeFileSync(join(pieDir, "models.json"), contents, "utf-8");
		return pieDir;
	}

	it("exits 1 with the anyhow-shaped cause chain on stderr", () => {
		const pieDir = seedModelsJson("{ this is not json");
		const run = runPie(["--tui"], { pieDir, env: { ANTHROPIC_API_KEY: "sk-ant-fake" } });

		// Before the fix: exit 0, stderr empty, and a single feed line
		// `error: warning: parse /…/models.json` with no reason, no line and no column, while the
		// custom model table was silently dropped and the session started anyway.
		expect(run.status).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain(`Error: parse ${join(pieDir, "models.json")}`);
		expect(run.stderr).toContain("Caused by:");
		// The position is the actionable half oracle prints and this port used to drop.
		expect(run.stderr).toMatch(/Caused by:\n {4}.*line 1 column 3/);
	}, 60_000);

	it("a well-formed models.json still starts", () => {
		const pieDir = seedModelsJson('{"models":[]}');
		const run = runPie(["--tui"], { pieDir, env: { ANTHROPIC_API_KEY: "sk-ant-fake" } });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("pie-coding-agent");
	}, 60_000);

	it("a pi-shaped models.json is not collateral damage", () => {
		// The TODO this fix replaced worried that promoting the read to fatal would crash on
		// files the skeleton's own reader accepts. `{"providers":{…}}` is that file, and it
		// passes: the oracle-shaped schema has an optional `models` key and ignores unknown ones.
		const pieDir = seedModelsJson('{"providers":{"anthropic":{"baseUrl":"https://example.invalid"}}}');
		const run = runPie(["--tui"], { pieDir, env: { ANTHROPIC_API_KEY: "sk-ant-fake" } });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("pie-coding-agent");
	}, 60_000);

	it("a malformed models.json still exits 1, not 2 — it is a runtime failure, not a usage error", () => {
		// The F9 companion assertion: aligning usage errors on 2 must not sweep anyhow's failures up
		// with them. Oracle exits 1 here.
		const pieDir = seedModelsJson("{ this is not json");
		expect(runPie(["--tui"], { pieDir, env: { ANTHROPIC_API_KEY: "sk-ant-fake" } }).status).toBe(1);
	}, 60_000);

	it("describeErrorChain reproduces anyhow's layout", () => {
		expect(describeErrorChain(new Error("plain"))).toBe("plain");
		expect(describeErrorChain(new Error("parse /x/models.json", { cause: new Error("key must be a string") }))).toBe(
			"parse /x/models.json\n\nCaused by:\n    key must be a string",
		);
		// Two or more links: anyhow numbers them.
		const nested = new Error("outer", { cause: new Error("middle", { cause: new Error("inner") }) });
		expect(describeErrorChain(nested)).toBe("outer\n\nCaused by:\n    0: middle\n    1: inner");
		// A wrapper that only repeats its cause adds no line.
		expect(describeErrorChain(new Error("same", { cause: new Error("same") }))).toBe("same");
	});
});

/** clap's `error: … \n\n[Usage: …\n\n]For more information, try '--help'.\n`. */
function clapPage(message: string, usage?: string): string {
	const blocks = usage === undefined ? [`error: ${message}`] : [`error: ${message}`, `Usage: ${usage}`];
	return `${[...blocks, "For more information, try '--help'."].join("\n\n")}\n`;
}

describe("F9/F12/F13 — a usage error is clap's page and clap's exit code 2", () => {
	// Every expected string below was captured from the oracle binary under
	// `env -i HOME=<fresh> PATH=/usr/bin:/bin`, and every `status` was 2 there.
	const FAKE_KEY = { ANTHROPIC_API_KEY: "sk-ant-fake" };

	it("--thinking <invalid> refuses to start instead of warning and using the default", () => {
		const run = runPie(["--thinking", "wobble", "--tui"], { env: FAKE_KEY });
		// Before the fix: exit 0, a full TUI on stdout, and one stderr line
		// `Warning: Invalid thinking level "wobble". Valid values: …` — the session ran with thinking
		// off while the user believed it was on (F12).
		expect(run.status).toBe(2);
		expect(run.stderr).toBe(
			clapPage(
				"invalid value 'wobble' for '--thinking <THINKING>'\n  [possible values: off, minimal, low, medium, high, xhigh]",
			),
		);
		expect(run.stdout).toBe("");
	}, 60_000);

	it("an unknown long flag prints the usage block and the next step", () => {
		const run = runPie(["--no-such-flag"], { env: FAKE_KEY });
		// Before the fix: exit 1 and `Error: Unknown option: --no-such-flag`, with no Usage line and
		// no "try '--help'" (F13). The flag has to survive until extensions load — only they can say
		// it is unknown — but the answer's shape is clap's.
		expect(run.status).toBe(2);
		expect(run.stderr).toBe(clapPage("unexpected argument '--no-such-flag' found", "pie [OPTIONS] [COMMAND]"));
		expect(run.stdout).toBe("");
	}, 60_000);

	it("an unknown short flag gets the same page", () => {
		const run = runPie(["-z"], { env: FAKE_KEY });
		expect(run.status).toBe(2);
		expect(run.stderr).toBe(clapPage("unexpected argument '-z' found", "pie [OPTIONS] [COMMAND]"));
	}, 60_000);

	it("--trigger-poll-secs 0 is a usage error, not a runtime failure", () => {
		const run = runPie(["--trigger-poll-secs", "0", "--tui"], { env: FAKE_KEY });
		// Before the fix: exit 1 with `Error: invalid value "0" for --trigger-poll-secs: must be an
		// integer >= 1`. The wording below is clap's u64 range parser, `u64::MAX` spelled out.
		expect(run.status).toBe(2);
		expect(run.stderr).toBe(
			clapPage("invalid value '0' for '--trigger-poll-secs <SECONDS>': 0 is not in 1..18446744073709551615"),
		);
	}, 60_000);

	it("--web-port out of range is a usage error", () => {
		// Beyond the six the audit measured, same class.
		const run = runPie(["--web-port", "70000", "--tui"], { env: FAKE_KEY });
		expect(run.status).toBe(2);
		expect(run.stderr).toBe(clapPage("invalid value '70000' for '--web-port <PORT>': 70000 is not in 0..=65535"));
	}, 60_000);

	it("--web with --tui is a usage error whose Usage line names the flag seen first", () => {
		// Beyond the six the audit measured. Before the fix: exit 1, bare message, no Usage block.
		const first = runPie(["--web", "--tui"], { env: FAKE_KEY });
		expect(first.status).toBe(2);
		expect(first.stderr).toBe(clapPage("the argument '--web' cannot be used with '--tui'", "pie --web"));

		const second = runPie(["--tui", "--web"], { env: FAKE_KEY });
		expect(second.status).toBe(2);
		expect(second.stderr).toBe(clapPage("the argument '--tui' cannot be used with '--web'", "pie --tui"));
	}, 60_000);

	it("a documented flag with no value says so, instead of calling itself unknown", () => {
		// Beyond the six the audit measured. Before the fix: `pie --model` fell through to the
		// extension-flag bucket and came back as `Error: Unknown option: --model` with exit 1 — about
		// a flag `pie --help` documents.
		const run = runPie(["--model"], { env: FAKE_KEY });
		expect(run.status).toBe(2);
		expect(run.stderr).toBe(clapPage("a value is required for '--model <MODEL>' but none was supplied"));
	}, 60_000);

	it("--base-url without --provider stays exit 1 — it is a runtime failure, not a usage error", () => {
		// The guard against over-applying F9: oracle reaches this one through `anyhow::bail!`
		// (main.rs:1180), not through clap, so it keeps `Error: …` and exit 1. Verified on both
		// binaries.
		const run = runPie(["--base-url", "https://example.invalid", "--tui"], { env: FAKE_KEY });
		expect(run.status).toBe(1);
		expect(run.stderr.trim()).toBe(
			"Error: --base-url requires an explicit --provider so credentials cannot be auto-detected for the wrong endpoint",
		);
	}, 60_000);

	// phase 21 batch A — oracle `main.rs:1388-1414` (`base_url_override_requires_explicit_provider`).
	//
	// The case above proves the message is exactly oracle's, which is strictly stronger than
	// oracle's five `!err.contains(…)` assertions — but only for a *benign* URL. Oracle's whole
	// point is the other input: a `--base-url` carrying userinfo, a host and a query token must
	// leak none of the three. `--base-url` is the flag a user is most likely to paste a credential
	// into, and this error prints before anything else has had a chance to redact it.
	it("a --base-url carrying credentials leaks neither them nor any provider env var", () => {
		// pie: main.rs:1392 — `"http://user:secret-token@127.0.0.1:8000/v1?token=secret"`; :1400-1411
		//   assert!(!err.contains("secret-token")); assert!(!err.contains("127.0.0.1"));
		//   assert!(!err.contains("token=secret")); assert!(!err.contains("OPENAI_API_KEY"));
		//   assert!(!err.contains("DS4_API_KEY"));
		const leaky = "http://user:secret-token@127.0.0.1:8000/v1?token=secret";
		const run = runPie(["--base-url", leaky, "--tui"], { env: FAKE_KEY });

		expect(run.status).toBe(1);
		expect(run.stderr).toContain("--base-url requires an explicit --provider");
		for (const secret of ["secret-token", "127.0.0.1", "token=secret", "OPENAI_API_KEY", "DS4_API_KEY"]) {
			expect(run.stderr, `--base-url error must not echo \`${secret}\``).not.toContain(secret);
		}

		// Oracle's second half (`cli.provider = Some("ds4"); validate_base_url_override(&cli).unwrap()`):
		// with an explicit --provider the guard lets the run through. `--list-sessions` exits before
		// any network call, so this stays hermetic.
		const withProvider = runPie(["--base-url", leaky, "--provider", "ds4", "--list-sessions"], { env: FAKE_KEY });
		expect(withProvider.stderr).not.toContain("--base-url requires an explicit --provider");
	}, 60_000);
});

describe("F7 — a non-loopback --web-host is one error line, not a V8 stack", () => {
	it("prints oracle's single line with no path, frame or Node version", () => {
		const run = runPie(["--web", "--web-host", "10.1.2.3"], { env: { ANTHROPIC_API_KEY: "sk-ant-fake" } });
		// Before the fix: an uncaught rejection — four absolute `file:///…/dist/…` URLs, the offending
		// source line, four stack frames and `Node.js v22.22.1`, with oracle's message buried inside.
		expect(run.status).toBe(1);
		expect(run.stderr).toBe("Error: refusing non-loopback web bind 10.1.2.3; Web UI is loopback-only\n");
		expect(run.stderr).not.toContain("file:///");
		expect(run.stderr).not.toContain("    at ");
		expect(run.stderr).not.toContain("Node.js v");
		expect(run.stdout).toBe("");
	}, 60_000);
});

describe("F10 — -c/--continue with nothing to continue is an error, not a fresh session", () => {
	it("names the empty session directory and exits 1", () => {
		const run = runPie(["-c", "--tui"], { env: { ANTHROPIC_API_KEY: "sk-ant-fake" } });
		// Before the fix: exit 0, empty stderr, and a brand-new empty session on stdout — the user
		// asked to carry on a conversation and was given a blank one with no hint.
		expect(run.status).toBe(1);
		expect(run.stderr.trim()).toBe(`Error: no sessions to resume in ${sessionsDirFor(run.pieDir, run.cwd)}`);
		expect(run.stdout).toBe("");
	}, 60_000);

	it("still continues normally once a session exists", () => {
		const seed = runPie(["--tui"], { env: { ANTHROPIC_API_KEY: "sk-ant-fake" } });
		expect(seed.status).toBe(0);
		const run = runPie(["-c", "--tui"], {
			env: { ANTHROPIC_API_KEY: "sk-ant-fake" },
			pieDir: seed.pieDir,
			cwd: seed.cwd,
		});
		expect(run.status).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.stdout).toContain("pie-coding-agent");
	}, 120_000);
});

describe("F11 — --resume-id says which of the two things went wrong", () => {
	const MISSING_ID = "deadbeef-0000-7000-8000-000000000000";

	it("no sessions at all: names the directory, the way oracle does", () => {
		const run = runPie(["--resume-id", MISSING_ID], { env: { ANTHROPIC_API_KEY: "sk-ant-fake" } });
		// Before the fix: `No session found matching 'deadbeef-…'` for BOTH this case and the next —
		// neither oracle's wording, nor this port's own (`--delete-session` has printed oracle's
		// second message byte-for-byte all along), and it dropped the `Error: ` prefix every other
		// failure here carries.
		expect(run.status).toBe(1);
		expect(run.stderr.trim()).toBe(`Error: no sessions to resume in ${sessionsDirFor(run.pieDir, run.cwd)}`);
	}, 60_000);

	it("sessions exist but the id does not match: names the id", () => {
		const seed = runPie(["--tui"], { env: { ANTHROPIC_API_KEY: "sk-ant-fake" } });
		expect(seed.status).toBe(0);
		const run = runPie(["--resume-id", MISSING_ID], {
			env: { ANTHROPIC_API_KEY: "sk-ant-fake" },
			pieDir: seed.pieDir,
			cwd: seed.cwd,
		});
		expect(run.status).toBe(1);
		expect(run.stderr.trim()).toBe(`Error: no session matches id ${MISSING_ID}`);
	}, 120_000);

	it("--delete-session, the message this one now agrees with, is unchanged", () => {
		const run = runPie(["--delete-session", MISSING_ID]);
		expect(run.status).toBe(1);
		expect(run.stderr.trim()).toBe(`Error: no session matches id ${MISSING_ID}`);
	}, 60_000);

	// A failed --resume-id has to say the right thing and also leave no trace.
	// `session-manager.ts:492-500` declares that invariant itself — a read-only path must not leave an
	// empty `sessions/<hash>/` behind for a cwd that never had a session — and nothing guarded it.
	// Running the same command both ways: upstream adds not one entry under PIE_DIR, this side added
	// three. The path is main.ts:421 resolveSessionPath → SessionManager.list → getDefaultSessionDir,
	// which contains a mkdirSync.
	// The second case above is a natural negative control: it seeds with one `--tui` run, and that run
	// **has to** create the same directory, or its own `no session matches id` assertion would not
	// hold.
	it("a lookup that finds no session must not leave an empty sessions/<hash>/ directory behind", () => {
		const run = runPie(["--resume-id", MISSING_ID], { env: { ANTHROPIC_API_KEY: "sk-ant-fake" } });
		expect(run.status).toBe(1);
		expect(existsSync(sessionsDirFor(run.pieDir, run.cwd))).toBe(false);
		expect(readdirSync(run.pieDir)).toEqual([]);
	}, 60_000);
});

describe("F8 — the unknown-model error points somewhere the user can actually reach", () => {
	it("names /model list first and --list-models second", () => {
		const run = runPie(["--model", "no-such-model-xyz", "--tui"], {
			env: { ANTHROPIC_API_KEY: "sk-ant-fake" },
		});
		// Before the fix: "Use --list-models to see available models" — a flag that appears nowhere in
		// `pie --help` and that oracle rejects outright. `/model list` is the route `pie --help`'s
		// `Model catalog:` block documents, byte-identically on both sides.
		//
		// The hard-fail itself is an INTENTIONAL DIVERGENCE awaiting its row in
		// `migration/parity/intentional-divergences.md` (see `core/model-resolver.ts`'s
		// `MODEL_DISCOVERY_HINT`): oracle ignores an unknown --model and silently starts on the
		// auto-detected default, exit 0. Exit 1 here, not 2 — this is a runtime failure, not
		// something clap could have caught.
		expect(run.status).toBe(1);
		expect(run.stderr.trim()).toBe(
			'Error: Model "no-such-model-xyz" not found. ' +
				"Run `/model list` inside pie, or `pie --list-models`, to see available providers and models.",
		);
		expect(run.stderr).not.toContain("Use --list-models");
	}, 60_000);
});

describe("F14 — the /login guidance path is not an oracle divergence", () => {
	it("oracle's own credential-less message is reproduced, and it carries no path", () => {
		// F14 flagged the absolute `…/packages/coding-agent/docs/providers.md` in the `/login`
		// guidance. Checked before changing anything: `grep -rn 'providers\.md|docs_path' $ORACLE/crates`
		// returns nothing, and oracle's no-key run prints only the message asserted below — it has no
		// counterpart for the guidance block at all, which is pi surface (`core/auth-guidance.ts`)
		// reached through pi-only flags. Nothing to align, so nothing was changed. This test pins the
		// half that IS oracle's, so a future edit to the guidance cannot quietly reword it.
		const run = runPie(["--tui"]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("no API key found. Set one of: ANTHROPIC_API_KEY");
		expect(run.stdout).toContain("or run `/login <provider> <key>` from inside pie");
		expect(run.stdout).not.toContain("providers.md");
	}, 60_000);
});
