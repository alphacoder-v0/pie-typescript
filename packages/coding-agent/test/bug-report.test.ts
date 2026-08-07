/**
 * Characterization tests for the `/bug-report` builder and the authoritative redactor.
 * Port of oracle crates/coding-agent/src/bug_report.rs tests (lines 158-195), plus coverage of
 * `build`/`default_dest`, which oracle exercises through `tests/bug_report_e2e.rs`.
 *
 * Hermetic: the transcript renderer is mocked, everything else is written into a temp dir.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@pie/agent-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const renderMock = vi.hoisted(() => vi.fn<(session: unknown) => Promise<string>>());
vi.mock("../src/export.ts", () => ({ render: renderMock }));

const { build, defaultDest, redact } = await import("../src/bug-report.ts");

const FAKE_SESSION = {} as Session;
const NOW = new Date("2026-08-04T02:59:06.123Z");

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pie-bug-report-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
	renderMock.mockReset();
});

function diag(overrides: Partial<Parameters<typeof build>[0]> = {}) {
	return {
		sessionId: "sess-1",
		thinking: "off",
		toolCount: 7,
		skillCount: 2,
		costSummary: "$0.00",
		...overrides,
	};
}

describe("redact", () => {
	// oracle bug_report.rs:162-188
	it("redacts every known pattern", () => {
		const s =
			"key=sk-abcdefghij1234567890abcd , aws=AKIAEXAMPLEEXAMPLE1A, gh=gho_abcdefghijklmnopqrstuvwxyz0123456789, " +
			"slack=xoxb-1234567890-abcdef, header=Authorization: Bearer eyJabc.defghijklmnopqr, " +
			"login=https://pie.0xfefe.me/login?req=018fe23a-1111-4a22-8b33-123456789abc&state=state_secret, " +
			"callback=http://127.0.0.1:49152/callback?code=hub_code_secret&state=state_secret, " +
			"hub=hub_agent_abcdefghijklmnopqrstuvwxyz, session=hub_hs_abcdefghijklmnopqrstuvwxyz, " +
			"id=018fe23a-1111-4a22-8b33-123456789abc";
		const r = redact(s);

		expect(r).not.toContain("sk-abcdefghij");
		expect(r).not.toContain("AKIAEXAMPLE");
		expect(r).not.toContain("gho_");
		expect(r).not.toContain("xoxb-");
		expect(r).not.toContain("eyJabc.defghijklmnopqr");
		expect(r).not.toContain("pie.0xfefe.me/login");
		expect(r).not.toContain("127.0.0.1:49152/callback");
		expect(r).not.toContain("hub_agent_");
		expect(r).not.toContain("hub_hs_");
		expect(r).not.toContain("018fe23a-1111");

		expect(r).toContain("[REDACTED:openai_anthropic_key]");
		expect(r).toContain("[REDACTED:aws_access_key]");
		expect(r).toContain("[REDACTED:pie_hub_login_url]");
		expect(r).toContain("[REDACTED:pie_hub_callback_url]");
		expect(r).toContain("[REDACTED:pie_hub_token]");
		expect(redact("id=018fe23a-1111-4a22-8b33-123456789abc")).toContain("[REDACTED:uuid]");
	});

	// oracle bug_report.rs:190-194
	it("leaves normal text alone", () => {
		const s = "hello world, no secrets here";
		expect(redact(s)).toBe(s);
	});

	it("replaces every occurrence, not just the first (Rust replace_all)", () => {
		const r = redact("a=AKIAEXAMPLEEXAMPLE1A b=ASIAEXAMPLEEXAMPLE1B");
		expect(r).toBe("a=[REDACTED:aws_access_key] b=[REDACTED:aws_access_key]");
	});

	it("catches the google api key and github/slack patterns the cron stub used to miss", () => {
		// oracle bug_report.rs:136 requires exactly 35 chars after `AIza`, bounded on both sides.
		expect(redact("k=AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe")).toContain("[REDACTED:google_api_key]");
		expect(redact("t=ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toContain("[REDACTED:github_token]");
		expect(redact("t=xoxp-1234567890-abcdef")).toContain("[REDACTED:slack_token]");
	});
});

describe("defaultDest", () => {
	// oracle bug_report.rs:24-27
	it("uses the compact UTC stamp under <base>/bug-reports", () => {
		const previous = process.env.PIE_DIR;
		process.env.PIE_DIR = dir;
		try {
			expect(defaultDest(NOW)).toBe(join(dir, "bug-reports", "20260804T025906Z.txt"));
		} finally {
			if (previous === undefined) delete process.env.PIE_DIR;
			else process.env.PIE_DIR = previous;
		}
	});
});

describe("build", () => {
	// oracle bug_report.rs:41-110
	it("writes the full report body and returns the destination", async () => {
		renderMock.mockResolvedValue("# Session Transcript\n\n- Messages: 0\n");
		const dest = join(dir, "nested", "report.txt");

		const returned = await build(diag({ model: "anthropic:claude-haiku-4-5" }), FAKE_SESSION, dest, NOW);
		expect(returned).toBe(dest);

		expect(readFileSync(dest, "utf-8")).toBe(
			"pie bug report\n" +
				"generated_at: 2026-08-04T02:59:06.123+00:00\n" +
				"pie_version: 0.75.0\n" +
				"\n" +
				"---- diagnostic ----\n" +
				"session_id    sess-1\n" +
				"model         anthropic:claude-haiku-4-5\n" +
				"thinking      off\n" +
				"tools         7\n" +
				"skills        2\n" +
				"cost          $0.00\n" +
				"log_path      (disabled)\n" +
				"\n" +
				"---- transcript ----\n" +
				"# Session Transcript\n\n- Messages: 0\n",
		);
	});

	// oracle bug_report.rs:58,68-70 — the two placeholders.
	it("prints (none) for a missing model and (disabled) for a missing log path", async () => {
		renderMock.mockResolvedValue("");
		const dest = join(dir, "placeholders.txt");

		await build(diag(), FAKE_SESSION, dest, NOW);
		const body = readFileSync(dest, "utf-8");
		expect(body).toContain("model         (none)\n");
		expect(body).toContain("log_path      (disabled)\n");
		expect(body).not.toContain("---- log tail");
	});

	// oracle bug_report.rs:73-97 — the tail is the LAST 200 lines.
	it("includes only the last 200 log lines", async () => {
		renderMock.mockResolvedValue("");
		const logPath = join(dir, "session.log");
		writeFileSync(logPath, `${Array.from({ length: 250 }, (_, i) => `line-${i}`).join("\n")}\n`);
		const dest = join(dir, "tail.txt");

		await build(diag({ logPath }), FAKE_SESSION, dest, NOW);
		const body = readFileSync(dest, "utf-8");

		expect(body).toContain(`---- log tail (200 lines from ${logPath}) ----\n`);
		expect(body).not.toContain("line-49\n");
		expect(body).toContain("line-50\n");
		expect(body).toContain("line-249\n");
		expect(body).toContain(`log_path      ${logPath}\n`);
	});

	it("keeps a short log whole and emits exactly one blank line after it", async () => {
		renderMock.mockResolvedValue("");
		const logPath = join(dir, "short.log");
		writeFileSync(logPath, "one\ntwo\n");
		const dest = join(dir, "short.txt");

		await build(diag({ logPath }), FAKE_SESSION, dest, NOW);
		expect(readFileSync(dest, "utf-8")).toContain("----\none\ntwo\n\n---- transcript ----");
	});

	// oracle bug_report.rs:92-94
	it("reports an unreadable log inline instead of failing", async () => {
		renderMock.mockResolvedValue("");
		const logPath = join(dir, "missing.log");
		const dest = join(dir, "unreadable.txt");

		await build(diag({ logPath }), FAKE_SESSION, dest, NOW);
		expect(readFileSync(dest, "utf-8")).toContain("(cannot read log: ");
	});

	// oracle bug_report.rs:100-103
	it("reports a failed transcript render inline instead of failing", async () => {
		renderMock.mockRejectedValue(new Error("boom"));
		const dest = join(dir, "render-fail.txt");

		await build(diag(), FAKE_SESSION, dest, NOW);
		expect(readFileSync(dest, "utf-8")).toContain("(cannot render transcript: boom)\n");
	});

	// oracle bug_report.rs:105 — the whole body is redacted before the write.
	it("redacts secrets that came in through the diagnostic block and the transcript", async () => {
		renderMock.mockResolvedValue("token: sk-abcdefghij1234567890abcd\n");
		const dest = join(dir, "redacted.txt");

		await build(diag({ costSummary: "AKIAEXAMPLEEXAMPLE1A" }), FAKE_SESSION, dest, NOW);
		const body = readFileSync(dest, "utf-8");

		expect(body).not.toContain("sk-abcdefghij");
		expect(body).not.toContain("AKIAEXAMPLE");
		expect(body).toContain("[REDACTED:openai_anthropic_key]");
		expect(body).toContain("[REDACTED:aws_access_key]");
	});
});
