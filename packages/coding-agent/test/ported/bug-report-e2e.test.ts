/**
 * 1:1 port of oracle `crates/coding-agent/tests/bug_report_e2e.rs` (pie @0a120dfd).
 *
 * Oracle module doc: "End-to-end test for /bug-report. Builds a real bug-report file in a tempdir
 * and asserts that secrets seeded into the log are redacted in the output."
 *
 * 1 oracle `#[tokio::test]` function -> 1 test here, name mirrored verbatim.
 *
 * Structural adaptation (documented, NOT a weakened assertion):
 *
 * Oracle seeds the transcript by constructing a real `AgentHarness` around `faux_model()` +
 * `faux_stream("ok")` and calling `harness.prompt("describe the system")`
 * (bug_report_e2e.rs:25-80). That step exists purely to leave one user turn and one assistant
 * reply in the `Session` that `bug_report::build` will render -- oracle asserts nothing about the
 * harness itself, only about the file `build` writes.
 *
 * This port drives the same `Session` (`@pie/agent-core`'s `Session` + `InMemorySessionStorage`,
 * the same abstraction `src/bug-report.ts:21` and `src/export.ts:27` import) but appends those two
 * messages directly, the way test/export.test.ts:25-45 does. Reason: `AgentHarnessOptions.env` is
 * a required `ExecutionEnv` (packages/agent/src/harness/types.ts:788) whose only concrete
 * implementation, `NodeExecutionEnv` (packages/agent/src/harness/env/nodejs.ts:214), is NOT
 * re-exported from the `@pie/agent-core` barrel that this package imports -- and `coding-agent`
 * has no `AgentHarness` dependency anywhere in `src/` to model the wiring on. Building a harness
 * here would require a cross-package deep import this repo has no precedent for. The transcript
 * content reaching `build` is identical either way, and every one of oracle's 10 assertions is
 * ported verbatim below against the real (unmocked) `render`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStorage, Session } from "@pie/agent-core";
import type { AssistantMessage, Usage, UserMessage } from "@pie/ai";
import { afterEach, expect, it } from "vitest";
import { build, type DiagInputs } from "../../src/bug-report.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pie-bug-report-e2e-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

// pie: bug_report_e2e.rs:73-123
it("bug_report_redacts_secrets_from_seeded_log", async () => {
	const session = new Session(new InMemorySessionStorage());
	// Stand-in for oracle's `harness.prompt("describe the system")` against `faux_stream("ok")`
	// (bug_report_e2e.rs:78-80) -- see this file's header for why the harness itself is not built.
	const userMessage: UserMessage = { role: "user", content: "describe the system", timestamp: 1_000 };
	await session.appendMessage(userMessage);
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "messages",
		provider: "faux",
		model: "faux",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 2_000,
	};
	await session.appendMessage(assistantMessage);

	// Seed a fake log file containing several secret patterns.
	const dir = tempDir();
	const log = join(dir, "session.log");
	writeFileSync(
		log,
		"2026-01-01 INFO outbound request key=sk-abcdefghij1234567890abcd\n" +
			"2026-01-01 INFO aws creds AKIAEXAMPLEEXAMPLE1A used\n" +
			"2026-01-01 INFO header: Authorization: Bearer eyJabc.defghijklmnopqr\n",
	);

	const diag: DiagInputs = {
		sessionId: "test",
		model: "faux:faux",
		thinking: "off",
		toolCount: 0,
		skillCount: 0,
		costSummary: "n/a",
		logPath: log,
	};
	const dest = join(dir, "report.txt");
	const written = await build(diag, session, dest);
	expect(written).toBe(dest);

	const body = readFileSync(dest, "utf-8");
	// Header and structure.
	expect(body).toContain("pie bug report");
	expect(body).toContain("---- diagnostic ----");
	expect(body).toContain("---- log tail");
	expect(body).toContain("---- transcript ----");

	// Secrets gone, redaction markers present.
	expect(body, `openai key leaked: ${body}`).not.toContain("sk-abcdefghij");
	expect(body, `aws key leaked: ${body}`).not.toContain("AKIAEXAMPLE");
	expect(body, `bearer leaked: ${body}`).not.toContain("eyJabc.defghijklmnopqr");
	expect(body).toContain("[REDACTED:openai_anthropic_key]");
	expect(body).toContain("[REDACTED:aws_access_key]");
	expect(body).toContain("[REDACTED:bearer_token]");
});
