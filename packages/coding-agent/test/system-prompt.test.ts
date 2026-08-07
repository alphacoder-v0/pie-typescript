import { describe, expect, test } from "vitest";
import { buildSystemPrompt, composeSystemPrompt, renderBasePrompt } from "../src/core/system-prompt.ts";

/**
 * Characterization tests for the ported system prompt.
 *
 * pie: crates/coding-agent/src/main.rs:1187-1225 (`compose_system_prompt` / `render_base_prompt`).
 * These replace the pi-skeleton assertions (bullet "Available tools:" list, "Guidelines:",
 * "Pi documentation", "Current date") — oracle emits none of those, so asserting them would lock
 * in skeleton copy the model must never see.
 */

/** The tool inventory oracle splices into the base prompt's second sentence. */
function toolInventory(prompt: string): string {
	return prompt.match(/You have access to the following tools: (.+?)\. Prefer running a tool/)?.[1] ?? "";
}

describe("renderBasePrompt", () => {
	test("opens with oracle's identity sentence", () => {
		expect(renderBasePrompt(["read"])).toMatch(
			/^You are pie-coding-agent, a minimal coding assistant running in a terminal\. /,
		);
	});

	test("renders the tool inventory as a comma-joined list in registration order", () => {
		expect(toolInventory(renderBasePrompt(["read", "write", "edit", "bash"]))).toBe("read, write, edit, bash");
	});

	// pie: main.rs:1205-1207 — the empty-registry sentinel is a literal phrase, not "(none)".
	test("renders 'no tools registered' for an empty registry", () => {
		expect(toolInventory(renderBasePrompt([]))).toBe("no tools registered");
	});

	// pie: main.rs:1211-1224 — the cron/trigger/skill routing clauses are part of the base literal.
	test("carries oracle's cron/trigger/skill routing clauses verbatim", () => {
		const prompt = renderBasePrompt([]);
		expect(prompt).toContain(
			"When the user asks for a fixed time, recurring, scheduled, hourly, daily, weekly, crontab, 定时任务, 每小时, or similar time-based job, call NewCronJob instead of NewTrigger.",
		);
		expect(prompt).toContain(
			"When the user asks to view, list, show, inspect, or find scheduled jobs or cron job ids, call ListCronJobs.",
		);
		expect(prompt).toContain(
			"When the user asks to pause, disable, enable, or resume a dynamic trigger, call SetTriggerState.",
		);
		expect(prompt).toContain(
			"Use InstallSkill only for installing an existing SKILL.md from a URL, file, or pasted content.",
		);
	});

	// The pi skeleton's prompt sections have no oracle counterpart.
	test("emits none of the pi skeleton sections", () => {
		const prompt = renderBasePrompt(["read", "bash"]);
		expect(prompt).not.toContain("Available tools:");
		expect(prompt).not.toContain("Guidelines:");
		expect(prompt).not.toContain("Pi documentation");
		expect(prompt).not.toContain("expert coding assistant");
	});
});

describe("composeSystemPrompt", () => {
	// pie: main.rs:1188-1192 — base, blank line, then the cwd line with a trailing newline.
	test("appends the cwd line after a blank line and terminates it with a newline", () => {
		const prompt = composeSystemPrompt("/work/repo", "", ["read"]);
		expect(prompt).toBe(`${renderBasePrompt(["read"])}\n\nCurrent working directory: /work/repo\n`);
	});

	// pie: main.rs:1193-1197 — a non-empty memory block is wrapped in its own blank line + newline.
	test("wraps a non-empty memory block after the cwd line", () => {
		const prompt = composeSystemPrompt("/work/repo", "<memory>\nnote\n</memory>", ["read"]);
		expect(prompt.endsWith("Current working directory: /work/repo\n\n<memory>\nnote\n</memory>\n")).toBe(true);
	});

	test("omits the memory section entirely when the block is empty", () => {
		expect(composeSystemPrompt("/work/repo", "", ["read"]).endsWith("/work/repo\n")).toBe(true);
	});
});

describe("buildSystemPrompt", () => {
	test("matches composeSystemPrompt for the default (no skills, no memory) case", () => {
		const built = buildSystemPrompt({ selectedTools: ["read", "bash"], cwd: "/work/repo" });
		expect(built).toBe(composeSystemPrompt("/work/repo", "", ["read", "bash"]));
	});

	test("lists every selected tool, with or without a prompt snippet", () => {
		// pie: main.rs:669-676 — the inventory is built from the registry, and oracle has no
		// per-tool snippet concept, so a snippet-less tool is still listed.
		const prompt = buildSystemPrompt({
			selectedTools: ["read", "dynamic_tool"],
			toolSnippets: { read: "Read file contents" },
			cwd: "/work/repo",
		});
		expect(toolInventory(prompt)).toBe("read, dynamic_tool");
		expect(prompt).not.toContain("Read file contents");
	});

	test("ignores promptGuidelines (oracle's base prompt has no guideline list)", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["read"],
			promptGuidelines: ["Use dynamic_tool for project summaries."],
			cwd: "/work/repo",
		});
		expect(prompt).not.toContain("Use dynamic_tool for project summaries.");
	});

	// pie: RULEBOOK §4, "what this port does not do" — AGENTS.md/CLAUDE.md never enter the system
	// prompt.
	test("ignores contextFiles", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["read"],
			contextFiles: [{ path: "/work/repo/AGENTS.md", content: "project rules" }],
			cwd: "/work/repo",
		});
		expect(prompt).not.toContain("project rules");
		expect(prompt).not.toContain("<project_context>");
	});

	// pie: agent_harness.rs:2161-2169 (`build_system_prompt`).
	test("appends the <skills> catalog after a blank line", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["read"],
			cwd: "/work/repo",
			skills: [
				{
					name: "alpha",
					description: "does alpha things",
					filePath: "/skills/alpha/SKILL.md",
					baseDir: "/skills/alpha",
					sourceInfo: {
						path: "/skills/alpha/SKILL.md",
						source: "user",
						scope: "user",
						origin: "top-level",
					},
					disableModelInvocation: false,
				},
			],
		});
		expect(prompt).toContain("\n\n<skills>\n");
		expect(prompt).toContain("- name: alpha\n  description: does alpha things\n");
		expect(prompt.endsWith("</skills>")).toBe(true);
	});

	test("folds the memory block in between the cwd line and the skills catalog", () => {
		const prompt = buildSystemPrompt({
			selectedTools: ["read"],
			cwd: "/work/repo",
			memory: "<memory>\nnote\n</memory>",
		});
		expect(prompt.endsWith("Current working directory: /work/repo\n\n<memory>\nnote\n</memory>\n")).toBe(true);
	});

	test("customPrompt substitutes for the base prompt only", () => {
		const prompt = buildSystemPrompt({ customPrompt: "CUSTOM", cwd: "/work/repo" });
		expect(prompt).toBe("CUSTOM\n\nCurrent working directory: /work/repo\n");
	});
});
