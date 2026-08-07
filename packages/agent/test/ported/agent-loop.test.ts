/**
 * char-tests port of oracle `crates/agent/tests/agent_loop.rs` (pie @0a120dfd).
 *
 * End-to-end Agent loop test. Uses a synthetic `streamFn` to drive the loop deterministically —
 * no LLM calls. oracle's `Agent::new(AgentOptions{...}).prompt(msg)` / `agent.subscribe(...)` /
 * `agent.state()` map onto `src/agent.ts`'s `Agent` class 1:1 (same shape: `new Agent(options)`,
 * `.subscribe()`, `.prompt()`, `.state`).
 *
 * GAP (issue #110 "ControlPlaneWrite user-Prompt gate", oracle agent_loop.rs:725-1464, 8 of the
 * 15 real test functions below): oracle's `AgentTool::permission_classification()` method,
 * `PermissionClassification` enum (Allow/Block/Prompt), `OnControlPlanePromptHook`,
 * `ControlPlanePromptDecision`, `ControlPlanePromptRequest`, `BeforeToolCallResult.prompt` field,
 * and `AgentEvent::ControlPlanePromptResolved` variant have NO TS counterpart anywhere in
 * `packages/agent/src` (grep-confirmed: zero hits for `PermissionClassification`,
 * `ControlPlanePromptResolved`, `permissionClassification`, `onControlPlanePrompt` in
 * `src/types.ts`/`src/agent-loop.ts`/`src/agent.ts`; `BeforeToolCallResult` — `src/types.ts:55-58`
 * — has only `block?`/`reason?`, matching `permission.ts`'s own doc comment "no `prompt` field on
 * either side"). This is a confirmed, large, not-yet-ported feature (types.ts is explicitly owned
 * by another migration unit, out of scope for a tests-only unit) — the 8 affected tests are
 * `it.skip`-ped below with the reasoning inline rather than deleted or weakened.
 */
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/agent.ts";
import type { AgentEvent, AgentMessage, AgentToolResult } from "../../src/types.ts";

const registrations: Array<{ unregister(): void }> = [];
afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

describe("agent_loop (char-tests port)", () => {
	it("single_turn_no_tools_emits_lifecycle_events", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("hello there")]);

		const agent = new Agent({
			initialState: { model: registration.getModel(), systemPrompt: "be friendly" },
		});
		const events: string[] = [];
		agent.subscribe((event) => {
			events.push(event.type);
		});

		await agent.prompt(userMessage("hi"));

		expect(events[0]).toBe("agent_start");
		expect(events[events.length - 1]).toBe("agent_end");
		expect(events).toContain("turn_start");
		expect(events).toContain("turn_end");
		expect(agent.state.messages).toHaveLength(2);
	});

	it("tool_call_loops_until_non_tool_use_stop", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() => fauxAssistantMessage(fauxToolCall("echo", { x: 1 }, { id: "call_1" }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("ok"),
		]);

		const echoTool = {
			label: "echo",
			name: "echo",
			description: "echo",
			parameters: { type: "object" } as never,
			// `params` is typed `unknown` (not `{ x?: number }`) and narrowed inside the body: AgentTool.execute's
			// signature takes `params: Static<TParameters>`, which resolves to `unknown` for this schema-less test
			// fixture, and a narrower parameter type here is contravariantly incompatible with that signature.
			execute: async (_id: string, params: unknown): Promise<AgentToolResult<undefined>> => {
				const { x } = params as { x?: number };
				return {
					content: [{ type: "text", text: `got x=${x ?? 0}` }],
					details: undefined,
				};
			},
		};

		const agent = new Agent({
			initialState: { model: registration.getModel(), tools: [echoTool] },
		});

		await agent.prompt(userMessage("compute"));

		// user -> assistant#1 (tool_use) -> toolResult -> assistant#2 (stop)
		expect(agent.state.messages).toHaveLength(4);
		const toolResultPresent = agent.state.messages.some((m) => m.role === "toolResult" && m.toolCallId === "call_1");
		expect(toolResultPresent).toBe(true);
	});

	it("before_tool_call_can_veto_execution", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() => fauxAssistantMessage(fauxToolCall("echo", { x: 1 }, { id: "call_1" }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("done"),
		]);

		let called = false;
		const echoTool = {
			label: "echo",
			name: "echo",
			description: "echo",
			parameters: { type: "object" } as never,
			execute: async (): Promise<AgentToolResult<undefined>> => {
				called = true;
				return { content: [], details: undefined };
			},
		};

		const agent = new Agent({
			initialState: { model: registration.getModel(), tools: [echoTool] },
			beforeToolCall: async () => ({ block: true, reason: "policy: no echo" }),
		});

		await agent.prompt(userMessage("go"));

		expect(called, "tool must not run when hook blocks").toBe(false);
		const synth = agent.state.messages.find((m) => m.role === "toolResult");
		if (!synth || synth.role !== "toolResult") throw new Error("expected synth tool result");
		expect(synth.isError).toBe(true);
		const first = synth.content[0];
		if (first?.type !== "text") throw new Error("expected text");
		expect(first.text).toContain("policy: no echo");
	});

	it("parallel_tools_execute_concurrently", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() =>
				fauxAssistantMessage(
					[fauxToolCall("slow", { id: 1 }, { id: "a" }), fauxToolCall("slow", { id: 2 }, { id: "b" })],
					{ stopReason: "toolUse" },
				),
			() => fauxAssistantMessage("done"),
		]);

		// Sleep 200ms per call — under parallel, total ~=200ms; sequential would be ~=400ms.
		const slowTool = {
			label: "slow",
			name: "slow",
			description: "sleep",
			parameters: { type: "object" } as never,
			execute: async (): Promise<AgentToolResult<undefined>> => {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return { content: [], details: undefined };
			},
		};

		// toolExecution defaults to "parallel".
		const agent = new Agent({ initialState: { model: registration.getModel(), tools: [slowTool] } });

		const start = Date.now();
		await agent.prompt(userMessage("go"));
		const elapsed = Date.now() - start;
		// Parallel should finish in well under 400ms; allow 350ms for scheduler slack.
		expect(elapsed, `expected parallel tool exec, took ${elapsed}ms`).toBeLessThan(350);
	});

	it("prepare_arguments_normalizes_args_for_hook_and_execute", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("uppercaser", { payload: "hello" }, { id: "call_1" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("done"),
		]);

		// Tool whose prepareArguments upper-cases `payload`. If the agent loop forgot to invoke
		// prepareArguments, both the hook and execute paths would see "hello".
		let executeArgs: { payload?: string } | undefined;
		const uppercaserTool = {
			label: "uppercaser",
			name: "uppercaser",
			description: "uppercase payload",
			parameters: { type: "object" } as never,
			prepareArguments: (args: unknown) => {
				const map = { ...(args as Record<string, unknown>) };
				if (typeof map.payload === "string") map.payload = map.payload.toUpperCase();
				return map;
			},
			// `params` is typed `unknown` (not `{ payload?: string }`) and narrowed inside the body: see the
			// matching comment on echoTool above for why a narrower parameter type is contravariantly
			// incompatible with AgentTool.execute's signature here.
			execute: async (_id: string, params: unknown): Promise<AgentToolResult<undefined>> => {
				executeArgs = params as { payload?: string };
				return { content: [], details: undefined };
			},
		};

		let hookArgs: { payload?: string } | undefined;
		const agent = new Agent({
			initialState: { model: registration.getModel(), tools: [uppercaserTool] },
			beforeToolCall: async (ctx) => {
				hookArgs = ctx.args as { payload?: string };
				return undefined;
			},
		});

		await agent.prompt(userMessage("go"));

		expect(hookArgs?.payload, "before_tool_call hook must see prepared args").toBe("HELLO");
		expect(executeArgs?.payload, "execute() must see prepared args").toBe("HELLO");
	});

	it("tool_execution_update_callback_emits_listener_events_in_order", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() => fauxAssistantMessage(fauxToolCall("progress", {}, { id: "call_1" }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("done"),
		]);

		// Tool that fires three partial updates via onUpdate before returning. Verifies the
		// callback plumbing reaches subscribers as tool_execution_update events.
		const progressTool = {
			label: "progress",
			name: "progress",
			description: "emits partial updates",
			parameters: { type: "object" } as never,
			execute: async (
				_id: string,
				_params: unknown,
				_signal: AbortSignal | undefined,
				onUpdate?: (partial: AgentToolResult<undefined>) => void,
			): Promise<AgentToolResult<undefined>> => {
				if (!onUpdate) throw new Error("agent loop must supply a real onUpdate callback — previously always None");
				for (const label of ["step-1", "step-2", "step-3"]) {
					onUpdate({ content: [{ type: "text", text: label }], details: undefined });
				}
				return { content: [], details: undefined };
			},
		};

		const agent = new Agent({ initialState: { model: registration.getModel(), tools: [progressTool] } });
		const updates: Array<[string, string]> = [];
		agent.subscribe((event: AgentEvent) => {
			if (event.type === "tool_execution_update") {
				const first = event.partialResult?.content?.[0];
				if (first?.type === "text") updates.push([event.toolCallId, first.text]);
			}
		});

		await agent.prompt(userMessage("go"));

		expect(
			updates,
			"tool_execution_update events must be delivered in send order with the correct toolCallId",
		).toEqual([
			["call_1", "step-1"],
			["call_1", "step-2"],
			["call_1", "step-3"],
		]);
	});

	// Regression for the pump-handle hang concern (oracle PR #49): a tool that hands `on_update`
	// to a detached background task keeps the callback alive past `execute()`'s return. In
	// oracle, the agent loop must time out an internal mpsc-channel "pump" join so `run_one`
	// cannot hang on a misbehaving tool. TS's `executePreparedToolCall` (agent-loop.ts) has no
	// such channel/pump to join at all — `onUpdate` is a synchronous in-process callback that
	// pushes directly into an in-flight `updateEvents` array captured before `execute()` resolves;
	// a call made from a detached background task AFTER `execute()` already returned is simply a
	// dangling, harmless call with nothing awaiting it. So this scenario is structurally
	// impossible to hang in the TS architecture — ported with the same fixture and the same
	// "prompt() completes promptly" assertion to pin that guarantee, not to exercise a pump-join
	// timeout that doesn't exist here.
	it("run_one_does_not_hang_when_tool_retains_on_update_past_return", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() => fauxAssistantMessage(fauxToolCall("leaker", {}, { id: "call_1" }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("done"),
		]);

		const leakerTool = {
			label: "leaker",
			name: "leaker",
			description: "retains on_update",
			parameters: { type: "object" } as never,
			execute: async (
				_id: string,
				_params: unknown,
				_signal: AbortSignal | undefined,
				onUpdate?: (partial: AgentToolResult<undefined>) => void,
			): Promise<AgentToolResult<undefined>> => {
				if (!onUpdate) throw new Error("agent loop must supply callback");
				onUpdate({ content: [{ type: "text", text: "first-and-only" }], details: undefined });
				// Hold the callback alive far longer than any reasonable join — a background task
				// that calls it again 30s from now, long after this test has finished.
				setTimeout(() => onUpdate({ content: [], details: undefined }), 30_000).unref?.();
				return { content: [], details: undefined };
			},
		};

		const agent = new Agent({ initialState: { model: registration.getModel(), tools: [leakerTool] } });

		const start = Date.now();
		await agent.prompt(userMessage("go"));
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(5000);
	});

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// GAP: Issue #110 — ControlPlaneWrite user-Prompt gate (design v0.2). See file header.
	// ─────────────────────────────────────────────────────────────────────────────────────────

	it.skip("permission_classification_default_allow_keeps_legacy_behavior (GAP: no AgentTool.permissionClassification in TS)", () => {
		expect.unreachable();
	});

	it.skip("permission_classification_block_short_circuits_before_hook_and_execute (GAP: no PermissionClassification.Block in TS)", () => {
		expect.unreachable();
	});

	it.skip("permission_classification_prompt_with_no_hook_fails_closed (GAP: no PermissionClassification.Prompt / fail-closed gate in TS)", () => {
		expect.unreachable();
	});

	it.skip("permission_classification_prompt_with_hook_allow_executes_and_emits_audit_event (GAP: no OnControlPlanePromptHook / ControlPlanePromptResolved event in TS)", () => {
		expect.unreachable();
	});

	it.skip("permission_classification_prompt_with_hook_deny_blocks_and_emits_audit_event (GAP: no OnControlPlanePromptHook / ControlPlanePromptResolved event in TS)", () => {
		expect.unreachable();
	});

	it.skip("classifier_prompt_preserved_through_default_before_tool_call_hook (GAP: no PermissionClassification.Prompt gate to preserve in TS)", () => {
		expect.unreachable();
	});

	it.skip("runtime_overrides_hook_supplied_binding_fields_in_prompt (GAP: no ControlPlanePromptRequest / BeforeToolCallResult.prompt in TS)", () => {
		expect.unreachable();
	});

	it.skip("default_prompt_payload_does_not_include_raw_args_values (GAP: no default control-plane prompt payload synthesis in TS)", () => {
		expect.unreachable();
	});
});
