/**
 * Characterization tests for the `coding-agent/commands` diff-port.
 * pie: crates/coding-agent/src/commands.rs — `parse` (:275-301, tests :3224-3241),
 * `Registry::with_builtins`/`find` (:215-264), `LoginCommand::run` (:1981-1993).
 */

import { describe, expect, it } from "vitest";
import {
	findPieCommand,
	LOGIN_USAGE_ERROR,
	PIE_BUILTIN_COMMANDS,
	parseLoginArgv,
	parseSlashCommand,
	THINKING_LEVEL_USAGE,
	THINKING_LEVEL_VALUES,
} from "../../src/core/slash-commands.ts";

describe("parse (pie commands.rs:275-301)", () => {
	it("splits on whitespace", () => {
		// pie: commands.rs:3224-3229
		expect(parseSlashCommand("/model anthropic:claude")).toEqual({
			name: "model",
			argv: ["anthropic:claude"],
		});
	});

	it("keeps quoted args together", () => {
		// pie: commands.rs:3231-3236
		expect(parseSlashCommand('/say "hello world" again')).toEqual({
			name: "say",
			argv: ["hello world", "again"],
		});
	});

	it("returns nothing for non-slash input or a bare slash", () => {
		// pie: commands.rs:3238-3241
		expect(parseSlashCommand("hello world")).toBeUndefined();
		expect(parseSlashCommand("/")).toBeUndefined();
	});

	it("trims leading whitespace before the slash check", () => {
		// pie: commands.rs:276 — `input.trim_start()`.
		expect(parseSlashCommand("   /quit")).toEqual({ name: "quit", argv: [] });
	});

	it("tolerates an unbalanced quote instead of erroring", () => {
		// pie: commands.rs:283 — `'"' => in_quotes = !in_quotes` and nothing else; quoting is
		// documented as "minimal", so a dangling quote just swallows the rest as one arg.
		expect(parseSlashCommand('/say "a b')).toEqual({ name: "say", argv: ["a b"] });
	});

	it("collapses runs of spaces and tabs, never emitting an empty argument", () => {
		// pie: commands.rs:284-289 — empty `current` is never pushed.
		expect(parseSlashCommand("/cron\tadd   x")).toEqual({ name: "cron", argv: ["add", "x"] });
	});
});

describe("Registry (pie commands.rs:215-264)", () => {
	it("registers the oracle built-in set in registration order", () => {
		// pie: commands.rs:217-246 — order is user-visible via `general_help_text`.
		expect(PIE_BUILTIN_COMMANDS.map((c) => c.name)).toEqual([
			"help",
			"clear",
			"skills",
			"skill",
			"quit",
			"model",
			"thinking",
			"cost",
			"diag",
			"template",
			"save",
			"compact",
			"undo",
			"bug-report",
			"name",
			"session",
			"web-connect",
			"web-disconnect",
			"sessions",
			"share",
			"login",
			"logout",
			"find",
			"history",
			"goal",
			"goal-start",
			"triggers",
			"new-trigger",
			"cron",
			"inbox",
		]);
	});

	it("finds commands by name and by alias", () => {
		// pie: commands.rs:258-264 (`Registry::find`) + the two aliased commands
		// (`QuitCommand` aliases ["exit","q"], `CronCommand` aliases ["crontab"]).
		expect(findPieCommand("quit")?.name).toBe("quit");
		expect(findPieCommand("exit")?.name).toBe("quit");
		expect(findPieCommand("q")?.name).toBe("quit");
		expect(findPieCommand("crontab")?.name).toBe("cron");
		expect(findPieCommand("nope")).toBeUndefined();
	});

	it("carries the usage strings /help renders", () => {
		// pie: commands.rs — `usage()` of ModelCommand, GoalStartCommand, ThinkingCommand.
		expect(findPieCommand("model")?.usage).toBe("[provider:model-id|list [provider]]");
		expect(findPieCommand("goal-start")?.usage).toBe("<prompt>");
		expect(findPieCommand("thinking")?.usage).toBe(THINKING_LEVEL_USAGE);
	});

	it("exposes the thinking-level values the CLI accepts", () => {
		// pie: commands.rs:62-63; consumed by main.rs:82's clap PossibleValuesParser.
		expect([...THINKING_LEVEL_VALUES]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
		expect(THINKING_LEVEL_USAGE).toBe("[off|minimal|low|medium|high|xhigh]");
	});
});

describe("/login argument policy (pie commands.rs:1981-1993)", () => {
	it("accepts exactly one provider argument", () => {
		expect(parseLoginArgv(["anthropic"])).toEqual({ provider: "anthropic" });
	});

	it("rejects an inline API key", () => {
		// The whole point: no code path takes a literal key on the command line.
		expect(parseLoginArgv(["anthropic", "sk-not-a-real-key"])).toEqual({ error: LOGIN_USAGE_ERROR });
	});

	it("rejects zero arguments", () => {
		expect(parseLoginArgv([])).toEqual({ error: LOGIN_USAGE_ERROR });
	});

	it("uses oracle's usage string verbatim, including the double space", () => {
		expect(LOGIN_USAGE_ERROR).toBe("usage: /login <provider>  (pie will prompt for the API key without echoing it)");
	});

	it("routes an inline key through parse() to the usage error", () => {
		// End-to-end of what the interactive dispatcher now does for `/login a b`.
		const parsed = parseSlashCommand("/login anthropic sk-not-a-real-key");
		expect(parsed?.name).toBe("login");
		expect(parseLoginArgv(parsed?.argv ?? [])).toEqual({ error: LOGIN_USAGE_ERROR });
	});
});
