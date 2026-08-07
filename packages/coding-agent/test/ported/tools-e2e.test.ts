/**
 * 1:1 port of oracle `crates/coding-agent/tests/tools.rs` (pie @0a120dfd).
 *
 * Oracle module doc: "End-to-end tool tests. The tools are simple enough that we can exercise
 * them directly through their `AgentTool::execute` method without going through the agent loop."
 * Same discipline here: every test drives a real tool instance's `execute()`.
 *
 * Test names below deliberately mirror the oracle's Rust `fn` names verbatim so the two files can
 * be reconciled line-for-line. 19 oracle test functions -> 19 tests here.
 *
 * Structural adaptations that apply file-wide (each is a naming/architecture translation, NOT a
 * weakened assertion):
 *
 * - Oracle isolates the two process-global trigger registries with a `Mutex` +
 *   `clear_for_tests()`. The TS registries (`globalRegistry()` / `globalCronRegistry()`,
 *   `src/triggers/dynamic.ts:473` / `src/triggers/cron.ts:697`) expose no `clearForTests`; the
 *   established repo idiom (test/ported/cron-tool-bugs.test.ts:53-57,
 *   test/ported/dynamic-tool.test.ts:199-201) is `loadFromPath(<fresh temp sidecar>)`, which
 *   resets the in-memory rule/job list AND repoints persistence at a throwaway file. Vitest runs
 *   each test file in its own worker and tests within a file sequentially, so the Rust `Mutex`
 *   has no TS counterpart to port.
 * - Oracle builds the trigger/cron tools through the `tools::new_trigger_tool()` family of
 *   builder fns (mod.rs:119-173). `src/tools/index.ts` deliberately does not re-export those (see
 *   its module doc: the 8 trigger tools live in `../triggers/` and are wired by their own unit),
 *   so tests construct the exported classes directly -- same objects, one fewer indirection.
 * - Oracle's `result.content[0]` + `UserContentBlock::Text` match becomes `getText()` below.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBashTool, createLsTool, createReadTool, createWriteTool } from "../../src/index.ts";
import { createMemoryTool, loadMemoryBlock } from "../../src/tools/memory.ts";
import { createSkillTool } from "../../src/tools/skill.ts";
import {
	globalCronRegistry,
	ListCronJobsTool,
	NewCronJobTool,
	RemoveCronJobTool,
	SetCronJobStateTool,
} from "../../src/triggers/cron.ts";
import {
	globalRegistry,
	ListTriggersTool,
	NewTriggerTool,
	RemoveTriggerTool,
	SetTriggerStateTool,
} from "../../src/triggers/dynamic.ts";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	if (block === undefined || block.type !== "text" || block.text === undefined) {
		throw new Error("expected text");
	}
	return block.text;
}

const tempDirs: string[] = [];

/** Oracle: `tempfile::tempdir()`. */
function tempdir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pie-tools-e2e-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Oracle: `DYNAMIC_TRIGGER_LOCK` + `triggers::global_registry().clear_for_tests()` /
 * `CRON_LOCK` + `triggers::global_cron_registry().clear_for_tests()` (tools.rs:37-38 and the
 * `let _guard = ...; ...clear_for_tests();` prologue of every registry test).
 */
function clearDynamicRegistryForTests(): void {
	globalRegistry().loadFromPath(join(tempdir(), "session.triggers.json"));
}

function clearCronRegistryForTests(): void {
	globalCronRegistry().loadFromPath(join(tempdir(), "session.cron.toml"));
}

const cancel = new AbortController().signal;

/* -------------------------------------------------------------------------------------------
 * Filesystem / shell tools.
 * ----------------------------------------------------------------------------------------- */

// pie: tests/tools.rs:40-73
it("read_writes_then_reads", async () => {
	const dir = tempdir();
	const path = join(dir, "hello.txt");

	const write = createWriteTool(dir);
	const read = createReadTool(dir);

	await write.execute("w1", { path, content: "hi\nthere\n" }, cancel);

	const r = await read.execute("r1", { path }, cancel);
	const text = getText(r);
	expect(text).toContain("hi");
	expect(text).toContain("there");
});

// pie: tests/tools.rs:75-97
it("ls_lists_entries", async () => {
	const dir = tempdir();
	writeFileSync(join(dir, "a.txt"), "a");
	mkdirSync(join(dir, "sub"));

	const ls = createLsTool(dir);
	const r = await ls.execute("l1", { path: dir }, cancel);
	const text = getText(r);
	expect(text).toContain("a.txt");
	expect(text).toContain("sub/");
});

// pie: tests/tools.rs:99-117
it("bash_captures_stdout_and_exit", async () => {
	const bash = createBashTool(tempdir());
	const r = await bash.execute("b1", { command: "echo hello && exit 0" }, cancel);
	const text = getText(r);
	expect(text).toContain("hello");
	expect(text).toContain("[exit 0]");
});

// pie: tests/tools.rs:490-507
it("bash_reports_nonzero_exit", async () => {
	const bash = createBashTool(tempdir());
	const r = await bash.execute("b2", { command: "exit 3" }, cancel);
	const text = getText(r);
	expect(text).toContain("[exit 3]");
});

/* -------------------------------------------------------------------------------------------
 * Dynamic trigger tools.
 * ----------------------------------------------------------------------------------------- */

// pie: tests/tools.rs:119-151
it("new_trigger_tool_registers_dynamic_rule", async () => {
	clearDynamicRegistryForTests();

	const tool = new NewTriggerTool();
	const result = await tool.execute(
		"new-trigger-1",
		{ condition: "any future event matches this condition", action: "echo fired" },
		cancel,
	);

	const rules = globalRegistry().list();
	expect(rules).toHaveLength(1);
	expect(rules[0]?.condition).toBe("any future event matches this condition");
	expect(rules[0]?.action).toBe("echo fired");

	const text = getText(result);
	expect(text).toContain("created dynamic trigger");
});

// pie: tests/tools.rs:153-177
it("new_trigger_tool_rejects_fixed_schedule_jobs", async () => {
	clearDynamicRegistryForTests();

	const tool = new NewTriggerTool();
	await expect(
		tool.execute("new-trigger-scheduled-1", { condition: "Every hour", action: "Check Hacker News" }, cancel),
	).rejects.toThrow(/NewCronJob/);
	expect(globalRegistry().list()).toEqual([]);
});

// pie: tests/tools.rs:179-204
it("new_trigger_tool_rejects_fixed_schedule_in_action_or_spec", async () => {
	clearDynamicRegistryForTests();

	const tool = new NewTriggerTool();
	await expect(
		tool.execute(
			"new-trigger-scheduled-bypass-1",
			{
				condition: "Hacker News should be checked",
				action: "Every hour, check Hacker News",
				spec: "Every hour, check Hacker News",
			},
			cancel,
		),
	).rejects.toThrow(/NewCronJob/);
	expect(globalRegistry().list()).toEqual([]);
});

// pie: tests/tools.rs:373-397
it("new_trigger_tool_can_request_chat_promotion", async () => {
	clearDynamicRegistryForTests();

	const tool = new NewTriggerTool();
	const result = await tool.execute(
		"new-trigger-promote-1",
		{ condition: "event says promote", action: "echo promote", promote_to_chat: true },
		cancel,
	);

	const rules = globalRegistry().list();
	expect(rules).toHaveLength(1);
	expect(rules[0]?.promote_to_chat).toBe(true);
	expect((result.details as { promote_to_chat: boolean }).promote_to_chat).toBe(true);
});

// pie: tests/tools.rs:399-427
it("list_triggers_tool_returns_dynamic_rules", async () => {
	clearDynamicRegistryForTests();
	const rule = globalRegistry().addRule("event says list me", "echo listed");

	const tool = new ListTriggersTool();
	const result = await tool.execute("list-triggers-1", {}, cancel);

	const text = getText(result);
	expect(text).toContain("dynamic trigger rules: 1");
	expect(text).toContain(rule.id);
	expect(text).toContain("event says list me");
	const details = result.details as { count: number; rules: Array<{ id: string }> };
	expect(details.count).toBe(1);
	expect(details.rules[0]?.id).toBe(rule.id);
});

// pie: tests/tools.rs:429-454
it("remove_trigger_tool_removes_dynamic_rule", async () => {
	clearDynamicRegistryForTests();
	const rule = globalRegistry().addRule("event says remove me", "echo removed");

	const tool = new RemoveTriggerTool();
	const result = await tool.execute("remove-trigger-1", { id: rule.id }, cancel);

	expect(globalRegistry().list()).toEqual([]);
	const text = getText(result);
	expect(text).toContain("removed dynamic trigger");
});

// pie: tests/tools.rs:456-488
it("set_trigger_state_tool_disables_and_enables_rule", async () => {
	clearDynamicRegistryForTests();
	const rule = globalRegistry().addRule("event says pause me", "echo paused");

	const tool = new SetTriggerStateTool();
	const disabled = await tool.execute("set-trigger-state-1", { id: rule.id, enabled: false }, cancel);
	expect((disabled.details as { enabled: boolean }).enabled).toBe(false);
	expect(globalRegistry().list()[0]?.enabled).toBe(false);

	const enabled = await tool.execute("set-trigger-state-2", { id: rule.id, enabled: true }, cancel);
	expect((enabled.details as { enabled: boolean }).enabled).toBe(true);
	expect(globalRegistry().list()[0]?.enabled).toBe(true);
});

/* -------------------------------------------------------------------------------------------
 * Cron tools.
 * ----------------------------------------------------------------------------------------- */

// pie: tests/tools.rs:206-237
it("new_cron_job_tool_registers_session_cron_job", async () => {
	clearCronRegistryForTests();

	const tool = new NewCronJobTool(undefined);
	const result = await tool.execute(
		"new-cron-1",
		{ schedule: "每小时", action: "Check the Hacker News front page" },
		cancel,
	);

	const jobs = globalCronRegistry().list();
	expect(jobs).toHaveLength(1);
	expect(jobs[0]?.schedule).toBe("0 * * * *");
	expect(jobs[0]?.action).toBe("Check the Hacker News front page");
	// PORT-DIVERGENCE: B6 — oracle (tools.rs:229) asserts `enabled == true` here, because
	// `add_job_full` hardcodes it (cron.rs:138) and the model-callable NewCronJob reaches it
	// unguarded. Phase 18 gates the model path: registration still succeeds, but the job is
	// created disabled and only a human (`/cron enable <id>`) can bring it into effect. Every
	// other assertion in this test is oracle's, unchanged. See triggers/cron.ts's
	// PORT-DIVERGENCE: B6 notes and test/ported/cron-tool-bugs.test.ts.
	expect(jobs[0]?.enabled).toBe(false);
	expect((result.details as { scope: string }).scope).toBe("session");

	const text = getText(result);
	expect(text).toContain("created cron job");
	expect(text).toContain(`use /cron enable ${jobs[0]?.id}`);
});

// pie: tests/tools.rs:239-261
// Oracle asserts on the `tools::{new_cron_job_tool, list_cron_jobs_tool, remove_cron_job_tool,
// set_cron_job_state_tool}` builder fns (each taking a `SkillHarnessCell`). This port has no such
// builders in `src/tools/index.ts` (documented out-of-scope there -- the trigger tools are owned
// by `src/triggers/`), and the TS classes take an optional harness cell in their constructor
// instead. The load-bearing assertion -- the model-facing catalog names and their order -- is
// ported unchanged.
it("cron_management_tool_builders_expose_expected_catalog_names", () => {
	const newTool = new NewCronJobTool(undefined);
	const list = new ListCronJobsTool();
	const remove = new RemoveCronJobTool(undefined);
	const state = new SetCronJobStateTool(undefined);
	const names = [newTool.definition().name, list.definition().name, remove.definition().name, state.definition().name];
	expect(names).toEqual(["NewCronJob", "ListCronJobs", "RemoveCronJob", "SetCronJobState"]);
});

// pie: tests/tools.rs:263-294
it("list_cron_jobs_tool_returns_redacted_session_jobs", async () => {
	clearCronRegistryForTests();
	const secret = "Bearer sk-cron-secret-token";
	const job = globalCronRegistry().addJob("0 * * * *", `fetch Hacker News with ${secret}`);

	const tool = new ListCronJobsTool();
	const result = await tool.execute("list-cron-1", {}, cancel);

	const text = getText(result);
	expect(text).toContain("session cron jobs: 1");
	expect(text).toContain(job.id);
	expect(text).not.toContain(secret);
	const details = result.details as { scope: string; jobs: Array<Record<string, unknown>> };
	expect(details.scope).toBe("session");
	expect(details.jobs[0]?.id).toBe(job.id);
	expect(details.jobs[0]?.action).toBeUndefined();
	expect(JSON.stringify(result.details)).not.toContain(secret);
});

// pie: tests/tools.rs:296-334
it("remove_cron_job_tool_removes_session_job", async () => {
	clearCronRegistryForTests();
	const job = globalCronRegistry().addJob("0 * * * *", "Check the Hacker News front page");

	const tool = new RemoveCronJobTool(undefined);
	const preview = await tool.execute("preview-remove-cron-1", { id: job.id }, cancel);
	expect((preview.details as { confirmation_required: boolean }).confirmation_required).toBe(true);
	expect(globalCronRegistry().list()).toHaveLength(1);

	const result = await tool.execute("remove-cron-1", { id: job.id, confirm: true }, cancel);

	expect(globalCronRegistry().list()).toEqual([]);
	expect((result.details as { removed_count: number }).removed_count).toBe(1);
	const text = getText(result);
	expect(text).toContain("removed cron job");
});

// pie: tests/tools.rs:336-371
it("set_cron_job_state_tool_disables_and_fails_closed_on_enable", async () => {
	clearCronRegistryForTests();
	const job = globalCronRegistry().addJob("0 * * * *", "Check the Hacker News front page");
	const tool = new SetCronJobStateTool(undefined);

	const disabled = await tool.execute("disable-cron-1", { id: job.id, enabled: false }, cancel);
	expect((disabled.details as { enabled: boolean }).enabled).toBe(false);
	expect(globalCronRegistry().list()[0]?.enabled).toBe(false);

	await expect(tool.execute("enable-cron-1", { id: job.id, enabled: true }, cancel)).rejects.toThrow(/\/cron enable/);
	expect(globalCronRegistry().list()[0]?.enabled).toBe(false);
});

/* -------------------------------------------------------------------------------------------
 * Skill tool.
 * ----------------------------------------------------------------------------------------- */

/**
 * pie: tests/tools.rs:509-553.
 *
 * Oracle wires a live `AgentHarness` (carrying an in-memory `Skill { name: "test-skill", .. }`)
 * into a `SkillHarnessCell` and hands that cell to `SkillTool::new`. This port's `SkillTool` has
 * no harness cell -- it re-scans the skills directory + `skills-state.json` overlay per call
 * (documented at src/tools/skill.ts:21-46; the same adaptation test/skill-tool.test.ts:8-16
 * already records). So the equivalent of "a real registered skill" here is a real SKILL.md on
 * disk under the tool's agentDir. Both assertions from oracle are ported verbatim.
 */
it("skill_tool_returns_wrapped_body_on_hit", async () => {
	const agentDir = tempdir();
	const cwd = tempdir();
	const skillDir = join(agentDir, "skills", "test-skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		"---\nname: test-skill\ndescription: description for the test skill\n---\n# test-skill\n\nDo the test thing.\n",
	);

	const tool = createSkillTool(cwd, { agentDir });
	const result = await tool.execute("call-1", { name: "test-skill" }, cancel);

	const text = getText(result);
	expect(text).toContain('<skill name="test-skill"');
	expect(text).toContain("Do the test thing.");
});

/* -------------------------------------------------------------------------------------------
 * Memory tool.
 * ----------------------------------------------------------------------------------------- */

// pie: tests/tools.rs:573-598
it("memory_save_then_load_block", async () => {
	const dirPath = tempdir();
	const mem = createMemoryTool(dirPath);

	await mem.execute(
		"m1",
		{
			action: "save",
			name: "User Likes Tabs",
			description: "indentation preference",
			content: "The user prefers tabs over spaces.",
			type: "user",
		},
		cancel,
	);

	const block = await loadMemoryBlock(dirPath);
	expect(block).toContain("<memory>");
	expect(block).toContain("tabs");
	expect(block).toContain("</memory>");
});

/**
 * pie: tests/tools.rs:600-640. Oracle doc comment, ported verbatim:
 *
 * `load_memory_block` must skip `MEMORY.md` so the index file isn't folded into the
 * system-prompt memory block alongside its actual entries. The MEMORY.md file is loaded
 * separately by the harness; duplicating it into this block surfaces the same content
 * twice. Code-review item #10 (2026-05-22).
 */
it("memory_block_excludes_memory_md_index_file", async () => {
	const dirPath = tempdir();
	// Hand-write a MEMORY.md with a recognizable string we'd see if it leaks into the
	// block, and one real entry so the block actually opens.
	await writeFile(
		join(dirPath, "MEMORY.md"),
		"INDEX_SENTINEL_SHOULD_NOT_LEAK\n- [User Likes Tabs](user_likes_tabs.md)\n",
	);
	await writeFile(
		join(dirPath, "user_likes_tabs.md"),
		"---\nname: user-likes-tabs\ndescription: indentation\nmetadata:\n  type: user\n---\n\nThe user prefers tabs.\n",
	);

	const block = await loadMemoryBlock(dirPath);
	expect(block, `block should be populated by the user entry: ${block}`).toContain("<memory>");
	expect(block, `real entry must appear in block: ${block}`).toContain("prefers tabs");
	expect(block, `MEMORY.md index must not leak into the injected memory block: ${block}`).not.toContain(
		"INDEX_SENTINEL_SHOULD_NOT_LEAK",
	);
	expect(block, `MEMORY.md should not appear as a section header: ${block}`).not.toContain("--- MEMORY.md ---");
});
