/**
 * phase 20-7: four gaps in the CLI parser, pinned down one at a time.
 *
 * Every expected value here was **measured against the upstream binary**, not inferred from what
 * this repo happens to do. The tests drive the build output (`./pie` at the repo root, which points
 * at `packages/coding-agent/dist/cli.js`), because all four are about what a real process writes to
 * fd 2 and what code it exits with — none of which is visible from the module graph.
 *
 * stdout and stderr are asserted separately (the lesson of phase 19 F1: a merged stream cannot show
 * which fd a byte came from).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const PIE = join(REPO_ROOT, "pie");
const BUILT_CLI = join(REPO_ROOT, "packages/coding-agent/dist/cli.js");

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
}

interface Run {
	status: number;
	stdout: string;
	stderr: string;
}

function run(args: string[]): Run {
	if (!existsSync(BUILT_CLI)) {
		throw new Error(`missing ${BUILT_CLI} — run \`npm run build\` first (or use \`npm test\`)`);
	}
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "DS4_API_KEY"]) {
		delete env[k];
	}
	Object.assign(env, { PIE_DIR: temp("pie-p7-dir-"), PI_NO_LOCAL_LLM: "1", PI_SKIP_VERSION_CHECK: "1" });
	try {
		const stdout = execFileSync(PIE, args, {
			cwd: temp("pie-p7-cwd-"),
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		});
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		const e = error as { status?: number | null; stdout?: string; stderr?: string };
		if (e.status === undefined || e.status === null) throw error;
		return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

describe("the `--long=value` form has to parse", () => {
	// Before the fix: the dispatch loop matched exact flag names through a chain of else-ifs, so
	// `--thinking=high` hit none of them, fell through to the unknownFlags catch-all, and was reported
	// as `unexpected argument '--thinking' found`. That is not one option being missed: the whole form
	// went unparsed, and it is the standard GNU and clap spelling.
	it("`--thinking=bogus` reports an invalid value, not an unknown argument", () => {
		const r = run(["--thinking=bogus"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("invalid value 'bogus' for '--thinking <THINKING>'");
		expect(r.stderr).toContain("[possible values: off, minimal, low, medium, high, xhigh]");
		expect(r.stderr).not.toContain("unexpected argument");
	}, 60_000);

	it("`--web-port=99999` reports an out-of-range value", () => {
		const r = run(["--web-port=99999"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("invalid value '99999' for '--web-port <PORT>': 99999 is not in 0..=65535");
	}, 60_000);

	// The negative-control direction: a valid `=` form has to actually pass, not merely avoid an error.
	it("`--thinking=high` passes when combined with a session command", () => {
		const r = run(["--thinking=high", "--list-sessions"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	}, 60_000);
});

describe("a repeated option fails the way clap fails it", () => {
	// Before the fix it was last-one-wins and carried on: `--resume-id a --resume-id b` measured exit 1
	// and went looking for session b — swallowing the user's typo into a real operation.
	it.each([
		["--resume-id", "--resume-id <ID>"],
		["--model", "--model <MODEL>"],
		["--web-port", "--web-port <PORT>"],
	])(
		"%s repeated → exit 2, naming the option",
		(flag, label) => {
			const r = run([flag, "1", flag, "2"]);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(`the argument '${label}' cannot be used multiple times`);
			expect(r.stderr).toContain("Usage: pie [OPTIONS] [COMMAND]");
		},
		60_000,
	);

	// This applies only to options upstream declares. `--tools` belongs to the skeleton alone (upstream
	// measurably reports it as an unexpected argument), and this repo should neither invent a rule
	// upstream does not have nor reject a working skeleton invocation because of one.
	it("repeating --tools, which only the skeleton has, is not covered by that rule", () => {
		const r = run(["--tools", "a", "--tools", "b", "--list-sessions"]);
		expect(r.status).toBe(0);
	}, 60_000);

	// The clap rule covers non-multi-value options only. Upstream has exactly two that repeat
	// (`main.rs:108-109` `--image` and `:116-117` `--builtin-skill`); `--image a --image b` measures
	// exit 0.
	//
	// This is a regression test: the first version of this phase did not exclude them and turned
	// `--image a.png --image b.png` into an error, which `args.test.ts`'s "--image and --builtin-skill
	// are repeatable" caught immediately. That test asserts the shape parseArgs returns; this one pins
	// the same thing from the binary's side.
	it("repeating --image, which upstream declares repeatable, is not covered by that rule", () => {
		const r = run(["--image", "a.png", "--image", "b.png", "--list-sessions"]);
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("cannot be used multiple times");
	}, 60_000);
});

describe("an unknown flag after a session command must not be swallowed silently", () => {
	// Before the fix this measured exit 0 and carried on silently. The reason: an unknown long flag
	// takes the "hold it and let an extension claim it" path, which the extension mechanism needs, but
	// a session command exits before extensions load, so that check never gets its turn. Swallowing a
	// mistyped flag leaves the user believing it took effect.
	it.each([
		[["--list-sessions", "--no-such-flag"], "--no-such-flag", "Usage: pie --list-sessions"],
		[["--list-all-sessions", "--nope"], "--nope", "Usage: pie --list-all-sessions"],
		[["--delete-session", "x", "--nope"], "--nope", "Usage: pie --delete-session <ID>"],
	])(
		"%s → exit 2, with a context-specific Usage line",
		(args, flag, usage) => {
			const r = run(args as string[]);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(`unexpected argument '${flag}' found`);
			// The clap Usage line echoes the current command, not the top-level usage.
			expect(r.stderr).toContain(usage);
		},
		60_000,
	);

	// Negative control: without an unknown flag it has to work as usual, or the three above might be
	// passing only because the session command is broken outright.
	it("negative control: a clean --list-sessions still exits 0", () => {
		const r = run(["--list-sessions"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	}, 60_000);
});
