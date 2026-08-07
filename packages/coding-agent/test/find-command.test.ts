/**
 * `/find` — pie: crates/coding-agent/src/commands.rs:2052-2127 (`FindCommand`).
 *
 * Oracle opens every session transcript for this cwd and scans EVERY user and assistant message
 * body, printing one `  <file-stem>  <120-char snippet>` line per matching message and a trailing
 * `(N match(es))` / `(no matches)`. This port used to match only the first-user-message preview,
 * so anything said past the opening turn was invisible with no hint the search had been shallow.
 * These cases pin oracle's behavior; the "three turns in" and "assistant reply" ones fail against
 * the preview-only implementation.
 *
 * `HOME` is never touched — `PIE_DIR` is redirected to a temp dir, so the real `~/.pie/` is
 * neither read nor written.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionDirForCwd } from "../src/core/session-manager.ts";
import type { CommandCtx } from "../src/core/slash-dispatch-deps.ts";
import { clearCommandSink, setCommandSink } from "../src/core/slash-dispatch-deps.ts";
import { runFindCommand } from "../src/core/slash-dispatch-session.ts";

const ENV_BASE_DIR = "PIE_DIR";

let temp: string;
let cwd: string;
let sessionsDir: string;
let originalPieDir: string | undefined;
let lines: string[];

/** `runFindCommand` reads only `ctx.cwd`; the rest of `CommandCtx` is inert for this command. */
function ctx(): CommandCtx {
	return { sessionId: "test", toolCount: 0, cwd } as unknown as CommandCtx;
}

interface Message {
	role: "user" | "assistant";
	/** Bare string = oracle's `UserContent::Text`; array = its text-block form. */
	content: string | Array<{ type: string; text?: string }>;
}

function writeSession(sessionId: string, messages: readonly Message[], extra: readonly string[] = []): void {
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
	});
	const body = messages.map((message, index) =>
		JSON.stringify({
			type: "message",
			id: `e${index}`,
			parentId: index === 0 ? null : `e${index - 1}`,
			timestamp: "2026-01-01T00:00:01.000Z",
			message,
		}),
	);
	writeFileSync(join(sessionsDir, `${sessionId}.jsonl`), `${[header, ...body, ...extra].join("\n")}\n`);
}

beforeEach(() => {
	temp = mkdtempSync(join(tmpdir(), "pie-find-command-"));
	cwd = join(temp, "repo");
	mkdirSync(cwd, { recursive: true });
	originalPieDir = process.env[ENV_BASE_DIR];
	process.env[ENV_BASE_DIR] = temp;
	sessionsDir = sessionDirForCwd(cwd, temp);
	mkdirSync(sessionsDir, { recursive: true });
	lines = [];
	setCommandSink((line) => {
		lines.push(line);
	});
});

afterEach(() => {
	clearCommandSink();
	if (originalPieDir === undefined) {
		delete process.env[ENV_BASE_DIR];
	} else {
		process.env[ENV_BASE_DIR] = originalPieDir;
	}
	if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
});

describe("/find (pie: commands.rs:2065-2127 FindCommand::run)", () => {
	// pie: commands.rs:2069-2071 — empty argv is an Error outcome with this exact usage line.
	it("rejects an empty query", async () => {
		const outcome = await runFindCommand([], ctx());
		expect(outcome.kind).toBe("error");
		if (outcome.kind !== "error") throw new Error("unreachable");
		expect(outcome.message).toBe("usage: /find <query>");
	});

	// The gap this file exists for: oracle scans every user message, not just the first.
	it("matches a user message three turns in, not just the first-message preview", async () => {
		writeSession("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001", [
			{ role: "user", content: "opening question about nothing in particular" },
			{ role: "assistant", content: [{ type: "text", text: "sure" }] },
			{ role: "user", content: "now about the quokka migration" },
		]);

		const outcome = await runFindCommand(["quokka"], ctx());

		expect(outcome.kind).toBe("handled");
		expect(lines).toEqual([
			"  0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001  now about the quokka migration",
			"(1 match(es))",
		]);
	});

	// pie: commands.rs:2093-2103 — assistant bodies are scanned too, their text blocks joined by " ".
	it("matches an assistant reply and joins its text blocks with a single space", async () => {
		writeSession("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002", [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "first block" },
					{ type: "thinking", text: "hidden" },
					{ type: "text", text: "second block" },
				],
			},
		]);

		const outcome = await runFindCommand(["first block second"], ctx());

		expect(outcome.kind).toBe("handled");
		expect(lines).toEqual(["  0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002  first block second block", "(1 match(es))"]);
	});

	// pie: commands.rs:2113 — `hits` counts matching MESSAGES, so one session can print many lines.
	it("counts every matching message, not every matching session", async () => {
		writeSession("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0003", [
			{ role: "user", content: "needle one" },
			{ role: "assistant", content: [{ type: "text", text: "needle two" }] },
			{ role: "user", content: "unrelated" },
		]);

		const outcome = await runFindCommand(["needle"], ctx());

		expect(outcome.kind).toBe("handled");
		expect(lines).toEqual([
			"  0199aaaa-bbbb-7ccc-8ddd-eeeeffff0003  needle one",
			"  0199aaaa-bbbb-7ccc-8ddd-eeeeffff0003  needle two",
			"(2 match(es))",
		]);
	});

	// pie: commands.rs:2073 (`argv.join(" ").to_lowercase()`) + :2112 (`text.to_lowercase()`).
	it("is case-insensitive and joins multi-word argv with spaces", async () => {
		writeSession("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0004", [
			{ role: "user", content: "Please Review The Retry Wiring" },
		]);

		await runFindCommand(["review", "the", "RETRY"], ctx());

		expect(lines).toEqual([
			"  0199aaaa-bbbb-7ccc-8ddd-eeeeffff0004  Please Review The Retry Wiring",
			"(1 match(es))",
		]);
	});

	// pie: commands.rs:2114-2118 — snippet = first 120 chars, THEN newlines flattened to spaces.
	it("truncates the snippet to 120 characters and flattens newlines", async () => {
		const long = `${"a".repeat(60)}\nneedle\n${"b".repeat(200)}`;
		writeSession("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0005", [{ role: "user", content: long }]);

		await runFindCommand(["needle"], ctx());

		const expected = [...long].slice(0, 120).join("").replaceAll("\n", " ");
		expect(expected).toHaveLength(120);
		expect(lines).toEqual([`  0199aaaa-bbbb-7ccc-8ddd-eeeeffff0005  ${expected}`, "(1 match(es))"]);
	});

	// pie: commands.rs:2105-2108 — tool results and custom entries are `continue`d past, never
	// searched, so a match inside one must not register.
	it("ignores non user/assistant entries", async () => {
		writeSession(
			"0199aaaa-bbbb-7ccc-8ddd-eeeeffff0006",
			[{ role: "user", content: "hello" }],
			[
				'{"type":"custom","id":"c1","parentId":"e0","timestamp":"2026-01-01T00:00:02.000Z","customType":"test_payload","data":{"note":"needle-in-custom"}}',
			],
		);

		await runFindCommand(["needle-in-custom"], ctx());

		expect(lines).toEqual(["(no matches)"]);
	});

	// pie: commands.rs:2122-2126 — the zero-hit literal.
	it("prints (no matches) when nothing matches", async () => {
		writeSession("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0007", [{ role: "user", content: "hello" }]);

		const outcome = await runFindCommand(["absent"], ctx());

		expect(outcome.kind).toBe("handled");
		expect(lines).toEqual(["(no matches)"]);
	});

	// pie: commands.rs:2078-2080 — `repo.open` failure `continue`s and `session.entries()` degrades
	// via `unwrap_or_default()`, so one unreadable transcript never aborts the search.
	it("skips a corrupt transcript and still searches the others", async () => {
		writeFileSync(join(sessionsDir, "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0008.jsonl"), "not json at all\n");
		writeSession("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0009", [{ role: "user", content: "survivor needle" }]);

		const outcome = await runFindCommand(["needle"], ctx());

		expect(outcome.kind).toBe("handled");
		expect(lines).toEqual(["  0199aaaa-bbbb-7ccc-8ddd-eeeeffff0009  survivor needle", "(1 match(es))"]);
	});

	// pie: commands.rs:2119 — the printed id is `path.file_stem()`, the FULL stem, not `/sessions`'
	// 16-character `short_id` (commands.rs:1837-1839).
	it("prints the full file stem, not the 16-char short id", async () => {
		writeSession("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0010", [{ role: "user", content: "needle" }]);

		await runFindCommand(["needle"], ctx());

		expect(lines[0]).toContain("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0010");
		expect(lines[0]).not.toBe("  0199aaaa-bbbb-7c  needle");
	});
});
