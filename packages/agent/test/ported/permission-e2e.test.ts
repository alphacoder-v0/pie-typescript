/**
 * char-tests port of oracle `crates/agent/tests/permission_e2e.rs` (pie @0a120dfd).
 *
 * End-to-end test for the dangerous-bash detector wired through `before_tool_call` /
 * `AgentHarness`. Drives a faux stream that asks the agent to call a `bash` tool with an
 * unmistakably dangerous command; `PermissionPolicy` must block the call before the tool runs,
 * and the synthesized tool-result message must surface the deny reason to the LLM.
 *
 * Wiring difference from oracle (not a behavior divergence — see `agent-harness.ts`'s
 * `createLoopConfig` `beforeToolCall`): the pi harness always routes `before_tool_call` through
 * its own internal `tool_call` hook system (`harness.on("tool_call", ...)`), it does not accept
 * a raw `AgentHarnessOptions.beforeToolCall`/`PermissionPolicy.asBeforeToolCall()` value directly
 * the way oracle's `AgentHarnessOptions::before_tool_call` field does. `PermissionPolicy.evaluate`
 * itself (the behavior under test) is used unmodified via that hook.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { PermissionPolicy } from "../../src/harness/permission.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentTool, AgentToolResult } from "../../src/types.ts";

const registrations: Array<{ unregister(): void }> = [];
afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

/** oracle permission_e2e.rs:40-89 (`RecordingBashTool`). Records every invocation. */
function createRecordingBashTool(calls: string[]): AgentTool {
	return {
		label: "bash",
		name: "bash",
		description: "run a shell command",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		} as never,
		execute: async (_toolCallId, args): Promise<AgentToolResult<undefined>> => {
			const cmd = String((args as { command?: string }).command ?? "");
			calls.push(cmd);
			return { content: [{ type: "text", text: `ran: ${cmd}` }], details: undefined };
		},
	};
}

/** oracle permission_e2e.rs:93-150 (`two_turn_stream`): tool call, then a plain stop. */
function twoTurnResponses(initialCmd: string) {
	return [
		() =>
			fauxAssistantMessage(fauxToolCall("bash", { command: initialCmd }, { id: "call-1" }), {
				stopReason: "toolUse",
			}),
		() => fauxAssistantMessage("noted, won't try that."),
	];
}

function wireDefaultPermissionPolicy(harness: AgentHarness): void {
	const policy = PermissionPolicy.defaultForCodingAgent();
	harness.on("tool_call", (event) => {
		const decision = policy.evaluate(event.toolName, event.input);
		return decision.type === "deny" ? { block: true, reason: decision.reason } : undefined;
	});
}

describe("permission_e2e (char-tests port)", () => {
	it("dangerous_bash_is_blocked_before_tool_runs", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses(twoTurnResponses("rm -rf /"));
		const calls: string[] = [];
		const tool = createRecordingBashTool(calls);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			tools: [tool],
		});
		wireDefaultPermissionPolicy(harness);

		await harness.prompt("please clean up");

		expect(calls, `dangerous bash call should not have reached the tool; saw ${JSON.stringify(calls)}`).toEqual([]);

		const entries = await session.getEntries();
		const foundDeny = entries.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.content.some(
					(block) => block.type === "text" && block.text.includes("denied by permission policy"),
				),
		);
		expect(foundDeny, `expected a deny tool result in session entries: ${JSON.stringify(entries)}`).toBe(true);
	});

	it("safe_bash_passes_through_with_policy_enabled", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses(twoTurnResponses("ls -la"));
		const calls: string[] = [];
		const tool = createRecordingBashTool(calls);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			tools: [tool],
		});
		wireDefaultPermissionPolicy(harness);

		await harness.prompt("look around");

		expect(calls, "safe bash should have been invoked exactly once").toEqual(["ls -la"]);
	});
});
