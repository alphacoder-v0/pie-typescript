import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomMessage } from "@pie/agent-core";
import { InMemorySessionStorage, Session } from "@pie/agent-core";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@pie/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_BASE_DIR } from "../src/config.ts";
import { defaultExportPath, render, renderContext, save } from "../src/export.ts";

// pie: crates/coding-agent/src/export.rs -- oracle has no `#[cfg(test)]` module of its own.
// This suite builds a realistic in-memory session (via `@pie/agent-core`'s
// `InMemorySessionStorage` + `Session`, the same harness abstraction oracle's `export.rs`
// imports from `pie_agent_core`) and pins the exact Markdown shape `render_context` produces.

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeSession(): Session {
	return new Session(new InMemorySessionStorage());
}

describe("export", () => {
	describe("renderContext", () => {
		it("renders the header, a user message, and an assistant text block", async () => {
			const session = makeSession();
			await session.appendModelChange("anthropic", "claude-x");
			await session.appendThinkingLevelChange("medium");
			const userMessage: UserMessage = { role: "user", content: "Hello there", timestamp: 1_000 };
			await session.appendMessage(userMessage);
			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Hi! How can I help?" }],
				api: "messages",
				provider: "anthropic",
				model: "claude-x",
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: 2_000,
			};
			await session.appendMessage(assistantMessage);

			const ctx = await session.buildContext();
			const md = renderContext(ctx);

			expect(md.startsWith("# Session Transcript\n\n")).toBe(true);
			expect(md).toContain("- Model: `anthropic:claude-x`\n");
			expect(md).toContain("- Thinking level: `medium`\n");
			expect(md).toContain("- Messages: 2\n");
			expect(md).toContain("## 0. User\n\nHello there\n\n");
			expect(md).toContain("## 1. Assistant\n\nHi! How can I help?\n\n");
		});

		it("renders thinking blocks in a collapsed <details> and tool calls as compact JSON", async () => {
			const session = makeSession();
			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "let me consider this" },
					{ type: "toolCall", id: "tc-1", name: "bash", arguments: { cmd: "ls -la", timeout: 30 } },
				],
				api: "messages",
				provider: "anthropic",
				model: "claude-x",
				usage: ZERO_USAGE,
				stopReason: "toolUse",
				timestamp: 3_000,
			};
			await session.appendMessage(assistantMessage);

			const md = await render(session);

			expect(md).toContain(
				"<details><summary>thinking</summary>\n\n```\nlet me consider this\n```\n\n</details>\n\n",
			);
			// Tool call arguments are COMPACT json (oracle: format!("{}", serde_json::Value) uses
			// Display, not pretty-print) -- distinct from the "custom" message arm below.
			expect(md).toContain('**tool call** `bash` `tc-1`:\n```json\n{"cmd":"ls -la","timeout":30}\n```\n\n');
			expect(md).not.toContain('{\n  "cmd"');
		});

		it("renders a tool result message with a heading and its text content", async () => {
			const session = makeSession();
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "tc-42",
				toolName: "bash",
				content: [{ type: "text", text: "file1\nfile2" }],
				isError: false,
				timestamp: 4_000,
			};
			await session.appendMessage(toolResult);

			const md = await render(session);
			expect(md).toContain("### tool result `tc-42`\n\nfile1\nfile2\n\n");
		});

		it("renders image content blocks in user/tool-result messages as a placeholder", async () => {
			const session = makeSession();
			const userMessage: UserMessage = {
				role: "user",
				content: [
					{ type: "text", text: "look at this" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
				timestamp: 5_000,
			};
			await session.appendMessage(userMessage);

			const md = await render(session);
			expect(md).toContain("look at this\n\n`[image]`\n\n");
		});

		it("renders a pi-only custom-role message with the generic 'custom:' pattern and pretty JSON", async () => {
			const session = makeSession();
			const customMessage: CustomMessage = {
				role: "custom",
				customType: "skill_run",
				content: "did a thing",
				display: true,
				details: { skillName: "demo" },
				timestamp: 6_500,
			};
			await session.appendMessage(customMessage);

			const md = await render(session);
			expect(md).toContain("### custom: custom\n\n```json\n");
			// Pretty-printed (2-space indent), unlike the compact tool-call JSON above.
			expect(md).toMatch(/```json\n\{\n {2}"role": "custom",/);
			expect(md).toContain('"customType": "skill_run"');
		});

		it("omits the model line entirely when no model has been set", async () => {
			const session = makeSession();
			await session.appendMessage({ role: "user", content: "no model yet", timestamp: 6_000 });
			const md = await render(session);
			expect(md).not.toContain("- Model:");
			expect(md).toContain("- Thinking level: `off`\n");
		});
	});

	describe("defaultExportPath / save", () => {
		let tempAgentDir: string;
		let originalPieDir: string | undefined;

		beforeEach(() => {
			tempAgentDir = mkdtempSync(join(tmpdir(), "pi-test-export-agentdir-"));
			originalPieDir = process.env[ENV_BASE_DIR];
			process.env[ENV_BASE_DIR] = tempAgentDir;
		});

		afterEach(() => {
			if (originalPieDir === undefined) {
				delete process.env[ENV_BASE_DIR];
			} else {
				process.env[ENV_BASE_DIR] = originalPieDir;
			}
			rmSync(tempAgentDir, { recursive: true, force: true });
		});

		it("defaultExportPath is <agentDir>/exports/<sessionId>.md", () => {
			const path = defaultExportPath("session-abc123");
			expect(path).toBe(join(tempAgentDir, "exports", "session-abc123.md"));
		});

		it("save creates the exports dir and writes the rendered transcript", async () => {
			const session = makeSession();
			await session.appendMessage({ role: "user", content: "persisted?", timestamp: 7_000 });

			const dest = defaultExportPath("session-xyz");
			expect(existsSync(dest)).toBe(false);

			const result = await save(session, dest);
			expect(result).toBe(dest);
			expect(existsSync(dest)).toBe(true);
			const onDisk = readFileSync(dest, "utf-8");
			expect(onDisk).toContain("## 0. User\n\npersisted?\n\n");
		});
	});
});
