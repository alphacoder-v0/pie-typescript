import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@pie/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

/**
 * The system-prompt assertions below read the tool inventory out of oracle's base prompt
 * (main.rs:1203-1225 `render_base_prompt` — a comma-joined name list, no per-tool blurbs and no
 * "Available tools:" heading) instead of pi's bullet list. Same discriminating power: --no-tools
 * still has to be the thing that decides what the model can see.
 */
function toolInventory(prompt: string): string {
	return prompt.match(/You have access to the following tools: (.+?)\. Prefer running a tool/)?.[1] ?? "";
}

describe("regression #3592: no-builtin-tools keeps extension tools enabled", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-no-builtin-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(options?: { noTools?: "all" | "builtin"; tools?: string[] }) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			noTools: options?.noTools,
			tools: options?.tools,
		});
		await session.bindExtensions({});
		return session;
	}

	it("keeps extension tools active when built-in defaults are disabled", async () => {
		const session = await createSession({ noTools: "builtin" });

		// The base registry is the coding agent's registered toolset (pie: main.rs:620-655 --
		// `default_tools()` plus the task/skill pushes), not pi's read/bash/edit/write + grep/find/ls
		// set, since phase 13 T1 wired `src/tools/index.ts` into `createAgentSession()`. This list is
		// that inventory plus the extension-registered `dynamic_tool`; `.sort()` is lexicographic by
		// code unit, so the capitalised skill tools lead. The regression's own subject -- "noTools:
		// builtin still leaves extension tools active" -- is the three assertions below, unchanged.
		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual([
			"InstallSkill",
			"RemoveSkill",
			"SetSkillState",
			"Skill",
			"SkillBuilder",
			"bash",
			"dynamic_tool",
			"edit",
			"find",
			"git",
			"grep",
			"ls",
			"memory",
			"read",
			"task",
			"web_fetch",
			"web_search",
			"write",
		]);
		expect(session.getActiveToolNames()).toEqual(["dynamic_tool"]);
		expect(toolInventory(session.systemPrompt)).toBe("dynamic_tool");
		session.dispose();
	});

	it("still disables all tools when noTools is all", async () => {
		const session = await createSession({ noTools: "all" });

		expect(session.getAllTools()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(toolInventory(session.systemPrompt)).toBe("no tools registered");
		session.dispose();
	});

	it("propagates noTools through service-based session creation", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			noTools: "builtin",
		});

		expect(session.getActiveToolNames()).toEqual([]);
		expect(toolInventory(session.systemPrompt)).toBe("no tools registered");
		session.dispose();
	});
});
