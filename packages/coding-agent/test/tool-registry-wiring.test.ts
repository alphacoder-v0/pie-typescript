/**
 * Phase 13 wiring (T1 + T4): the CLI's registered toolset and its permission gate.
 *
 * Before this wiring `core/agent-session.ts` resolved `./tools/index.ts` to the *sibling*
 * `core/tools/index.ts` (pi's read/bash/edit/write/grep/find/ls), so the entire pie tool port --
 * task, memory, the skill family, git, web_fetch, web_search -- had zero callers, and the product
 * path had no permission gate at all. These tests pin both ends against oracle:
 *
 * - pie: `crates/coding-agent/src/main.rs:620-655` -- registration set and order.
 * - pie: `crates/coding-agent/src/main.rs:752-753` -- `PermissionPolicy::default_for_coding_agent()`
 *   installed as `before_tool_call`.
 * - pie: `crates/coding-agent/src/main.rs:754-767` -- `on_control_plane_prompt` selection.
 *
 * Complements, rather than duplicates, `tools-index.test.ts` (registry face in isolation) and
 * `control-plane-prompt.test.ts` (hook factories in isolation): neither builds a session, so
 * neither can observe whether the CLI actually uses them.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext, AgentToolCall, ControlPlanePromptRequest } from "@pie/agent-core";
import { type AssistantMessage, getModel } from "@pie/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowHook } from "../src/control-plane-prompt.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * pie: main.rs:621-647 -- `default_tools(memory_dir)` (read, write, edit, bash, ls, grep, find,
 * web_fetch, web_search, git, memory) then the pushes for task and the five skill tools. The 8
 * cron/dynamic-trigger tools (main.rs:648-655) belong to the separate triggers wiring unit; MCP
 * tools (main.rs:672) are appended per connected server and are absent with no `.pie/mcp.toml`.
 */
const ORACLE_TOOL_ORDER = [
	"read",
	"write",
	"edit",
	"bash",
	"ls",
	"grep",
	"find",
	"web_fetch",
	"web_search",
	"git",
	"memory",
	"task",
	"Skill",
	"InstallSkill",
	"SkillBuilder",
	"SetSkillState",
	"RemoveSkill",
];

describe("phase 13 T1/T4: CLI tool registry + permission gate wiring", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(overrides?: Partial<CreateAgentSessionOptions>) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			...overrides,
		});
		return session;
	}

	function beforeToolCallContext(toolName: string, args: Record<string, unknown>) {
		const toolCall: AgentToolCall = { type: "toolCall", id: "call-1", name: toolName, arguments: args };
		const assistantMessage = { role: "assistant", content: [toolCall] } as unknown as AssistantMessage;
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		return { assistantMessage, toolCall, args, context };
	}

	function promptRequest(toolName: string): ControlPlanePromptRequest {
		return {
			toolCallId: "call-1",
			toolName,
			argsHash: "hash",
			label: `Control-plane write: ${toolName}`,
			payload: {},
			reason: "test",
		};
	}

	// -- T1 ---------------------------------------------------------------------------------

	it("registers oracle's toolset in oracle's order", async () => {
		const session = await createSession();
		expect(session.getActiveToolNames()).toEqual(ORACLE_TOOL_ORDER);
		session.dispose();
	});

	it("puts the task and memory tools on the live agent tool list (B10/B11 reachability)", async () => {
		const session = await createSession();
		const live = session.agent.state.tools.map((tool) => tool.name);
		expect(live).toContain("task");
		expect(live).toContain("memory");
		session.dispose();
	});

	it("registers oracle's set exactly, not a union with pi's", async () => {
		const session = await createSession();
		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual([...ORACLE_TOOL_ORDER].sort());
		session.dispose();
	});

	// -- T4 ---------------------------------------------------------------------------------

	it("carries permissionClassification through to the executable tool", async () => {
		// The registry is definition-first, so a classifier attached only to the AgentTool would be
		// dropped on the way in -- this is the "tool is alive but the classifier still does nothing"
		// failure mode.
		const session = await createSession();
		const removeSkill = session.agent.state.tools.find((tool) => tool.name === "RemoveSkill");
		expect(removeSkill?.permissionClassification).toBeTypeOf("function");
		expect(removeSkill?.permissionClassification?.({ name: "demo" })).toEqual({
			type: "prompt",
			reason: "remove user skill `demo`",
		});
		session.dispose();
	});

	it("blocks dangerous bash through the wired permission policy", async () => {
		const session = await createSession();
		const result = await session.agent.beforeToolCall?.(beforeToolCallContext("bash", { command: "sudo rm -rf /" }));
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("denied by permission policy");
		session.dispose();
	});

	it("leaves ordinary bash alone", async () => {
		const session = await createSession();
		const result = await session.agent.beforeToolCall?.(beforeToolCallContext("bash", { command: "ls -la" }));
		expect(result?.block ?? false).toBe(false);
		session.dispose();
	});

	it("fails closed on control-plane prompts by default", async () => {
		// pie: main.rs:764-766 -- headless sessions get `deny_hook`. This port denies in the TTY
		// branch too until a prompt UI exists (see `defaultControlPlanePromptHook`).
		const session = await createSession();
		expect(session.agent.onControlPlanePrompt).toBeTypeOf("function");
		const decision = await session.agent.onControlPlanePrompt?.(promptRequest("RemoveSkill"));
		expect(decision?.type).toBe("deny");
		session.dispose();
	});

	it("honours a caller-supplied control-plane prompt hook", async () => {
		// pie: main.rs:757-759 -- `--yes` / `--always-allow` installs `allow_hook()`.
		const session = await createSession({ onControlPlanePrompt: allowHook() });
		const decision = await session.agent.onControlPlanePrompt?.(promptRequest("RemoveSkill"));
		expect(decision).toEqual({ type: "allow" });
		session.dispose();
	});
});
