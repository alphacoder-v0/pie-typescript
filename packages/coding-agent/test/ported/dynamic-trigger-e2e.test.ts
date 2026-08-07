/**
 * 1:1 port of oracle `crates/coding-agent/tests/dynamic_trigger_e2e.rs` (pie @0a120dfd) — 8
 * `#[tokio::test]` functions. Ported: 7. Skipped: 1 (test 7, `HOME`-override fixture — below).
 *
 * Oracle module doc: "End-to-end coverage for dynamic trigger creation from ordinary
 * conversation. The model is simulated with a deterministic stream: the first user prompt creates
 * a dynamic rule via the model-facing `NewTrigger` tool, and a later runtime `Trigger` causes the
 * trigger sub-agent to call `bash` for the matching rule action."
 *
 * Test-name / oracle-line mapping:
 *  1. natural_language_prompt_creates_dynamic_trigger_and_runtime_event_executes_action -> :502
 *  2. natural_language_scheduled_job_creates_cron_not_dynamic_trigger_chinese           -> :580
 *  3. natural_language_scheduled_job_creates_cron_not_dynamic_trigger_english           -> :612
 *  4. promoted_dynamic_trigger_result_enters_parent_chat_context                        -> :643
 *  5. audit_only_match_is_not_promoted_when_other_rule_requests_chat_promotion          -> :718
 *  6. trigger_sub_agent_sees_parent_skill_catalog                                       -> :782
 *  7. home_helloworld_trigger_prints_file_contents                                      -> :843 (skip)
 *  8. periodic_dynamic_hook_checks_rules_and_executes_matching_action                   -> :935
 *
 * RESOLVED (phase 13 wiring): oracle sets `opts.on_control_plane_prompt =
 * Some(allow_all_control_plane_hook())` in all 8 tests so the model-facing `NewTriggerTool` (whose
 * `permissionClassification` is unconditionally `prompt`, `src/triggers/dynamic.ts:1107-1121`)
 * survives the agent loop's fail-closed control-plane gate. `AgentHarness` now carries the same
 * `onControlPlanePrompt` constructor option (`packages/agent/src/harness/agent-harness.ts`,
 * pie: agent_harness.rs:818-826) and forwards it into `createLoopConfig`, so {@link newHarness}
 * mirrors oracle's per-test assignment. Tests 1/4 (which need the model to CREATE a rule through
 * `NewTriggerTool`) are un-skipped verbatim against oracle. Test 7 stays skipped on its SECOND,
 * unrelated blocker (oracle swaps the process `HOME` — see its own note).
 *
 * Construct mapping notes that apply file-wide:
 * - `opts.stream_fn` -> `registerFauxProvider()` + a `FauxResponseFactory`, the repo's canonical
 *   deterministic-model idiom (`packages/agent/test/ported/harness-e2e.test.ts`). Oracle's
 *   `dynamic_trigger_response(context)` dispatch table is ported branch-for-branch, in order (the
 *   branches are not mutually exclusive, so their order is load-bearing).
 * - `triggers::global_registry().clear_for_tests()` has no TS counterpart; the established repo
 *   idiom (`test/ported/cron-tool-bugs.test.ts:53-57`, `test/ported/dynamic-tool.test.ts:199`) is
 *   a per-test fresh registry / `clearRules()`. Oracle's `Mutex` process-global serialization has
 *   no TS counterpart either — vitest runs each file in its own worker, tests sequentially.
 * - `harness.agent().state().messages` (parent chat context) -> the promoted parent entry in the
 *   session (`session.getEntries()`), which is where `applyPromotion` inserts it; same fact, read
 *   from the durable side rather than a private in-memory mirror TS does not keep. Same idiom as
 *   `packages/agent/test/ported/harness-e2e.test.ts`'s promote group.
 * - `RecordingBashTool` -> a plain `AgentTool` object literal (no `permissionClassification`, so
 *   it classifies as `allow`, matching oracle's tool which implements no classifier).
 * - `opts.tools = vec![Arc::new(triggers::NewTriggerTool), ..]` -> {@link triggerTools}: the eight
 *   trigger tools implement the *Rust-trait* shape (`definition()`/`label()`/`execute(..)`), which
 *   is not `@pie/agent-core`'s object-literal `AgentTool`; `src/triggers/tool-definitions.ts`
 *   owns the mechanical projection (see its header) and `triggerTools` just narrows its output to
 *   the exact subset oracle registers, so no adapter logic is duplicated here.
 * - `AgentHarnessOptions::new`'s default `system_prompt: String::new()` (oracle
 *   agent_harness.rs:875) -> explicit `systemPrompt: ""`. TS's base default when the option is
 *   omitted is `"You are a helpful assistant."` composed WITHOUT the skills block
 *   (agent-harness.ts:1078-1084) — a skeleton default with no oracle counterpart, so mirroring
 *   oracle's empty base is the faithful setup, not a workaround.
 */

import type { AgentTool, HarnessEvent, Skill, Trigger } from "@pie/agent-core";
import { AgentHarness, InMemorySessionStorage, Session } from "@pie/agent-core";
import type { Context, Message } from "@pie/ai";
import { type FauxProviderRegistration, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../agent/src/harness/env/nodejs.ts";
import { globalCronRegistry } from "../../src/triggers/cron.ts";
import {
	beforeTriggerActionHook,
	DynamicTriggerCheckHook,
	DynamicTriggerRegistry,
	fireOnceHarnessListener,
	globalRegistry,
} from "../../src/triggers/dynamic.ts";
import { triggerToolDefinitions } from "../../src/triggers/tool-definitions.ts";

let registrations: FauxProviderRegistration[] = [];
let hooks: DynamicTriggerCheckHook[] = [];

afterEach(() => {
	for (const hook of hooks) hook.stop();
	hooks = [];
	for (const registration of registrations) registration.unregister();
	registrations = [];
	globalRegistry().clearRules();
	for (const job of globalCronRegistry().list()) globalCronRegistry().removeJob(job.id);
});

/** pie: dynamic_trigger_e2e.rs:56-72 (`faux_model`). */
function fauxProvider(): FauxProviderRegistration {
	const registration = registerFauxProvider({ provider: "faux", models: [{ id: "faux", name: "Faux" }] });
	registrations.push(registration);
	return registration;
}

/** pie: dynamic_trigger_e2e.rs:74-77,164-213 (`RecordingBashTool`). */
function recordingBashTool(calls: string[]): AgentTool {
	return {
		label: "bash",
		name: "bash",
		description: "run a shell command",
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
			additionalProperties: false,
		} as never,
		execute: async (_id: string, args: unknown) => {
			const command = String((args as { command?: string }).command ?? "");
			calls.push(command);
			return { content: [{ type: "text", text: `ran: ${command}` }], details: { command } };
		},
	} as unknown as AgentTool;
}

/** The registry-shaped projection of the named trigger tools — see the header note. */
function triggerTools(names: readonly string[]): AgentTool[] {
	return triggerToolDefinitions().filter((tool) => names.includes(tool.name)) as unknown as AgentTool[];
}

/** pie: dynamic_trigger_e2e.rs:402-425 (`message_text`). Oracle renders non-text blocks with
 * Rust's `{:?}`; JSON is the TS equivalent — the branch predicates below only ever probe for
 * plain substrings, so the two renderings are interchangeable for this dispatch table. */
function messageText(message: Message): string {
	if (message.role === "user") {
		const content = message.content;
		if (typeof content === "string") return content;
		return content.map((block) => (block.type === "text" ? block.text : JSON.stringify(block))).join("\n");
	}
	if (message.role === "assistant") {
		return message.content.map((block) => (block.type === "text" ? block.text : JSON.stringify(block))).join("\n");
	}
	return message.content.map((block) => JSON.stringify(block)).join("\n");
}

/** pie: dynamic_trigger_e2e.rs:394-400 (`last_message_text`). */
function lastMessageText(context: Context): string {
	const last = context.messages.at(-1);
	return last ? messageText(last) : "";
}

/** pie: dynamic_trigger_e2e.rs:318-336 (`first_dynamic_rule_id`) — `dyn-` followed by exactly 32
 * ASCII hex digits (`simpleUuid()`'s output shape). */
function firstDynamicRuleId(text: string): string | undefined {
	const match = /dyn-[0-9a-fA-F]{32}/.exec(text);
	return match?.[0];
}

/** pie: dynamic_trigger_e2e.rs:230-316 (`dynamic_trigger_response`). */
function dynamicTriggerResponse(context: Context) {
	const lastText = lastMessageText(context);
	const transcriptText = context.messages.map(messageText).join("\n");
	const hasToolResult = context.messages.some((m) => m.role === "toolResult");
	if (hasToolResult && transcriptText.includes("hello from home e2e")) {
		const id = firstDynamicRuleId(transcriptText) ?? "dyn-missing";
		return fauxAssistantMessage(`matched ${id}: hello from home e2e`);
	}
	if (hasToolResult) {
		const id = firstDynamicRuleId(transcriptText) ?? "dyn-missing";
		return fauxAssistantMessage(`matched ${id}: done`);
	}
	if (!lastText.includes("Dynamic trigger rules") && lastText.includes("helloworld")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"NewTrigger",
				{
					condition: "$HOME contains a file named helloworld",
					action: "print the contents of $HOME/helloworld",
					spec: lastText,
				},
				{ id: "call-new-trigger-home" },
			),
		);
	}
	if (lastText.includes("visible to future turns")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"NewTrigger",
				{
					condition: "the event says build finished",
					action: "echo dynamic-fired",
					promote_to_chat: true,
				},
				{ id: "call-new-trigger-promote" },
			),
		);
	}
	if (lastText.includes("每小时") || lastText.toLowerCase().includes("hourly scheduled")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"NewCronJob",
				{ schedule: "hourly", action: "Check the Hacker News front page for notable stories" },
				{ id: "call-new-cron-job" },
			),
		);
	}
	if (lastText.includes("Create a trigger")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"NewTrigger",
				{ condition: "the event says build finished", action: "echo dynamic-fired" },
				{ id: "call-new-trigger" },
			),
		);
	}
	if (lastText.includes("Dynamic trigger rules") && lastText.includes("helloworld")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"bash",
				{ command: 'test -f "$HOME/helloworld" && cat "$HOME/helloworld"' },
				{ id: "call-home-helloworld-bash" },
			),
		);
	}
	if (
		lastText.includes("Dynamic trigger rules") &&
		lastText.includes("dynamic periodic check") &&
		lastText.includes("echo periodic-fired")
	) {
		return fauxAssistantMessage(
			fauxToolCall("bash", { command: "echo periodic-fired" }, { id: "call-periodic-bash" }),
		);
	}
	if (
		lastText.includes("Dynamic trigger rules") &&
		lastText.includes("build finished") &&
		lastText.includes("echo dynamic-fired")
	) {
		return fauxAssistantMessage(fauxToolCall("bash", { command: "echo dynamic-fired" }, { id: "call-bash" }));
	}
	return fauxAssistantMessage("no dynamic trigger rule matched");
}

/** pie: dynamic_trigger_e2e.rs:215-217 (`dynamic_trigger_stream`). The faux provider consumes one
 * queued step per call, so an ample supply of the same context-dispatching factory reproduces
 * oracle's stateless `StreamFn` closure. */
function dynamicTriggerResponses(registration: FauxProviderRegistration): void {
	registration.setResponses(Array.from({ length: 64 }, () => (context: Context) => dynamicTriggerResponse(context)));
}

/** pie: dynamic_trigger_e2e.rs:219-228 (`recording_dynamic_trigger_stream`). */
function recordingDynamicTriggerResponses(registration: FauxProviderRegistration, seenSystemPrompts: string[]): void {
	registration.setResponses(
		Array.from({ length: 64 }, () => (context: Context) => {
			if (context.systemPrompt !== undefined) seenSystemPrompts.push(context.systemPrompt);
			return dynamicTriggerResponse(context);
		}),
	);
}

/** pie: dynamic_trigger_e2e.rs:427-450 (`sample_event_trigger`). */
function sampleEventTrigger(): Trigger {
	return {
		source: { kind: "local", subkind: "e2e" },
		source_kind: "local",
		source_label: "local:e2e",
		event_label: "build finished",
		payload_visibility: "local",
		payload_summary: "build finished successfully",
		payload: undefined,
		idempotency_key: "dynamic-e2e-build-finished",
		replacement_policy: "drop",
		trace_id: "trace-dynamic-e2e",
		authority: {
			principal_id: "e2e",
			principal_label: "e2e",
			credential_scope: "User",
			allowed_source_actions: [],
			expires_at: undefined,
		},
		received_at: new Date().toISOString(),
	};
}

/** pie: dynamic_trigger_e2e.rs:452-471 (`wait_for_completed`). */
/**
 * Deadline deliberately 15s where oracle uses 5s (`dynamic_trigger_e2e.rs:455`).
 *
 * This is a *test-harness* constant, not a behavioral contract: its only job is "wait long enough
 * for the detached sub-agent turn to finish", and waiting longer weakens no assertion — the event
 * must still arrive for `toBe(true)` to hold. Node under vitest worker contention is simply slower
 * than tokio here, and at 5s this test failed intermittently in whole-workspace runs while passing
 * alone and in per-package runs. Leaving a known-flaky test in the acceptance suite is worse than
 * deviating on a timeout literal: it trains everyone to re-run instead of read the failure.
 */
async function waitForCompleted(events: HarnessEvent[], traceId: string): Promise<boolean> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		if (events.some((event) => event.type === "trigger_completed" && event.traceId === traceId)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/**
 * Wait for the promoted trigger text to actually be persisted in the parent session.
 *
 * Why this exists rather than a bigger timeout on `waitForCompleted`: `trigger_completed` fires
 * when the sub-agent finishes, but the promotion entry is appended to the session *after* that
 * event. Reading `session.getEntries()` straight after `waitForCompleted` therefore asserts a
 * side effect nobody waited for — it passes alone and fails in whole-workspace runs, where the
 * gap widens under load. The failure looked like a timing flake and was twice treated as one;
 * it is a wait on the wrong signal. Poll for the condition being asserted instead.
 */
async function waitForPromotedText(session: Session, traceId: string, needle: string): Promise<string[]> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const texts = parentUserMessageTexts(await session.getEntries());
		if (texts.some((text) => text.includes(`[Trigger ${traceId}]`) && text.includes(needle))) return texts;
		if (Date.now() >= deadline) return texts;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** pie: dynamic_trigger_e2e.rs:473-484 (`wait_for_bash_call`). */
async function waitForBashCall(calls: string[], command: string): Promise<boolean> {
	const deadline = Date.now() + 5000;
	for (;;) {
		if (calls.includes(command)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Text of every user message on the parent session — oracle reads the same promoted entries off
 * `harness.agent().state().messages` (see the header note). */
function parentUserMessageTexts(entries: Awaited<ReturnType<Session["getEntries"]>>): string[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const content = entry.message.content;
		if (typeof content === "string") return [content];
		return [
			content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join(""),
		];
	});
}

type HarnessOptions = ConstructorParameters<typeof AgentHarness>[0];

/**
 * pie: dynamic_trigger_e2e.rs:46-52 (`allow_all_control_plane_hook`). Oracle doc: "Auto-approve
 * `on_control_plane_prompt` for tests that exercise tools whose `permission_classification`
 * returns `Prompt` (issue #110 sub-PR 3 — `NewTriggerTool`, `RemoveTriggerTool`,
 * `SetTriggerStateTool` enable). Without this, the harness defaults to fail-closed deny and the
 * tool never runs."
 */
function allowAllControlPlaneHook(): NonNullable<HarnessOptions["onControlPlanePrompt"]> {
	return async () => ({ type: "allow" });
}

function newHarness(options: Omit<HarnessOptions, "env" | "getApiKeyAndHeaders">): AgentHarness {
	return new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		// pie: agent_harness.rs:875 -- `AgentHarnessOptions::new`'s default base system prompt.
		systemPrompt: "",
		// pie: every one of dynamic_trigger_e2e.rs's 8 tests sets this (:513,589,621,653,745,800,
		// 858,947), so the shared constructor carries it rather than repeating it per test.
		onControlPlanePrompt: allowAllControlPlaneHook(),
		...options,
	});
}

describe("dynamic_trigger_e2e.rs (char-tests port)", () => {
	// pie: dynamic_trigger_e2e.rs:502-578
	it("natural_language_prompt_creates_dynamic_trigger_and_runtime_event_executes_action", async () => {
		const bashCalls: string[] = [];
		const registration = fauxProvider();
		dynamicTriggerResponses(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = newHarness({
			session,
			model: registration.getModel(),
			tools: [...triggerTools(["NewTrigger"]), recordingBashTool(bashCalls)],
			beforeTriggerAction: beforeTriggerActionHook(globalRegistry()),
		});

		await harness.prompt("Create a trigger: when the event says build finished, run echo dynamic-fired");

		{
			const rules = globalRegistry().list();
			expect(rules.length).toBe(1);
			expect(rules[0]?.condition).toBe("the event says build finished");
			expect(rules[0]?.action).toBe("echo dynamic-fired");
		}
		expect(globalCronRegistry().list(), "event/condition trigger request must not create a cron job").toEqual([]);

		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => {
			events.push(event);
		});
		harness.subscribeHarness(fireOnceHarnessListener(globalRegistry()));

		await harness.handleTrigger(sampleEventTrigger());
		expect(await waitForCompleted(events, "trace-dynamic-e2e"), "dynamic trigger sub-agent should complete").toBe(
			true,
		);
		expect(bashCalls).toEqual(["echo dynamic-fired"]);

		{
			const rules = globalRegistry().list();
			expect(rules.length).toBe(1);
			expect(rules[0]?.enabled, "fire_once rule should be disabled").toBe(false);
			expect(rules[0]?.fired_at, "fire_once rule should record fired_at").toBeTruthy();
		}

		const entries = await session.getEntries();
		expect(
			entries.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "trigger_result" &&
					(entry.data as Record<string, unknown> | undefined)?.trace_id === "trace-dynamic-e2e",
			),
			`trigger_result audit should be written: ${JSON.stringify(entries)}`,
		).toBe(true);
	});

	// pie: dynamic_trigger_e2e.rs:580-610
	it("natural_language_scheduled_job_creates_cron_not_dynamic_trigger_chinese", async () => {
		const registration = fauxProvider();
		dynamicTriggerResponses(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = newHarness({
			session,
			model: registration.getModel(),
			tools: triggerTools(["NewCronJob", "NewTrigger"]),
		});

		await harness.prompt("创建一个每小时的定时任务，查看下 hackernews 首页新闻");

		const jobs = globalCronRegistry().list();
		expect(jobs.length).toBe(1);
		expect(jobs[0]?.schedule).toBe("0 * * * *");
		expect(jobs[0]?.action).toContain("Hacker News");
		expect(globalRegistry().list(), "scheduled job must not create a dynamic trigger").toEqual([]);
	});

	// pie: dynamic_trigger_e2e.rs:612-641
	it("natural_language_scheduled_job_creates_cron_not_dynamic_trigger_english", async () => {
		const registration = fauxProvider();
		dynamicTriggerResponses(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = newHarness({
			session,
			model: registration.getModel(),
			tools: triggerTools(["NewCronJob", "NewTrigger"]),
		});

		await harness.prompt("Create an hourly scheduled job to check Hacker News");

		const jobs = globalCronRegistry().list();
		expect(jobs.length).toBe(1);
		expect(jobs[0]?.schedule).toBe("0 * * * *");
		expect(globalRegistry().list(), "scheduled job must not create a dynamic trigger").toEqual([]);
	});

	// pie: dynamic_trigger_e2e.rs:643-716
	it("promoted_dynamic_trigger_result_enters_parent_chat_context", async () => {
		const bashCalls: string[] = [];
		const registration = fauxProvider();
		dynamicTriggerResponses(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = newHarness({
			session,
			model: registration.getModel(),
			tools: [...triggerTools(["NewTrigger"]), recordingBashTool(bashCalls)],
			beforeTriggerAction: beforeTriggerActionHook(globalRegistry()),
		});

		await harness.prompt(
			"Create a trigger: when the event says build finished, run echo dynamic-fired, and make the result visible to future turns",
		);

		const rules = globalRegistry().list();
		expect(rules.length).toBe(1);
		expect(rules[0]?.promote_to_chat).toBe(true);

		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => {
			events.push(event);
		});

		await harness.handleTrigger(sampleEventTrigger());
		expect(await waitForCompleted(events, "trace-dynamic-e2e"), "dynamic trigger sub-agent should complete").toBe(
			true,
		);

		const promotedTexts = await waitForPromotedText(session, "trace-dynamic-e2e", "matched dyn-");
		const entries = await session.getEntries();
		expect(
			promotedTexts.some((text) => text.includes("[Trigger trace-dynamic-e2e]") && text.includes("matched dyn-")),
			`promoted trigger result should be present in parent agent context: ${JSON.stringify(promotedTexts)}`,
		).toBe(true);

		expect(
			entries.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "trigger_promotion" &&
					(entry.data as Record<string, unknown> | undefined)?.state === "success",
			),
			`promotion audit should be written: ${JSON.stringify(entries)}`,
		).toBe(true);
	});

	// pie: dynamic_trigger_e2e.rs:718-780
	it("audit_only_match_is_not_promoted_when_other_rule_requests_chat_promotion", async () => {
		const registry = globalRegistry();
		const auditRule = registry.addRuleWithFlags("the event says build finished", "echo dynamic-fired", true, false);
		const promoteRule = registry.addRuleWithFlags("the event says deploy finished", "echo deploy-fired", true, true);

		const bashCalls: string[] = [];
		const registration = fauxProvider();
		dynamicTriggerResponses(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = newHarness({
			session,
			model: registration.getModel(),
			tools: [recordingBashTool(bashCalls)],
			beforeTriggerAction: beforeTriggerActionHook(registry),
		});

		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => {
			events.push(event);
		});

		await harness.handleTrigger(sampleEventTrigger());
		expect(await waitForCompleted(events, "trace-dynamic-e2e"), "dynamic trigger sub-agent should complete").toBe(
			true,
		);
		expect(bashCalls).toEqual(["echo dynamic-fired"]);

		const promotedTexts = parentUserMessageTexts(await session.getEntries());
		expect(
			promotedTexts.some((text) => text.includes("[Trigger trace-dynamic-e2e]")),
			`audit-only matched rule ${auditRule.id} must not be promoted just because ${promoteRule.id} requested promotion: ${JSON.stringify(promotedTexts)}`,
		).toBe(false);
	});

	// pie: dynamic_trigger_e2e.rs:782-841
	it("trigger_sub_agent_sees_parent_skill_catalog", async () => {
		const registry = globalRegistry();
		registry.addRule("the event says build finished", "echo dynamic-fired after considering available skills");

		const seenSystemPrompts: string[] = [];
		const bashCalls: string[] = [];
		const registration = fauxProvider();
		recordingDynamicTriggerResponses(registration, seenSystemPrompts);
		const session = new Session(new InMemorySessionStorage());
		const skill: Skill = {
			name: "alpha",
			description: "handles alpha workflows",
			filePath: "/tmp/skills/alpha/SKILL.md",
			content: "Alpha skill body.",
			disableModelInvocation: false,
		};
		const harness = newHarness({
			session,
			model: registration.getModel(),
			resources: { skills: [skill] },
			tools: [recordingBashTool(bashCalls)],
			beforeTriggerAction: beforeTriggerActionHook(registry),
		});

		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => {
			events.push(event);
		});

		await harness.handleTrigger(sampleEventTrigger());
		expect(await waitForCompleted(events, "trace-dynamic-e2e"), "dynamic trigger sub-agent should complete").toBe(
			true,
		);
		expect(bashCalls).toEqual(["echo dynamic-fired"]);

		expect(
			seenSystemPrompts.some(
				(prompt) =>
					prompt.includes("<skills>") &&
					prompt.includes("- name: alpha") &&
					prompt.includes("description: handles alpha workflows"),
			),
			`trigger sub-agent should inherit the parent skill catalog in its system prompt: ${JSON.stringify(seenSystemPrompts)}`,
		).toBe(true);
	});

	/**
	 * pie: dynamic_trigger_e2e.rs:843-933. STILL SKIPPED — the control-plane gap that blocked it is
	 * fixed (`newHarness` now sets `onControlPlanePrompt`, so `NewTriggerTool` runs), but this test
	 * has a SECOND, independent blocker: oracle swaps the process `HOME` env var for a tempdir
	 * fixture (:849-851), which this repo's test discipline forbids — `$HOME/.pie/bin` resolves the
	 * `find` tool's fd/rg binaries and an overridden HOME hangs unrelated suites. A re-port needs
	 * the fixture keyed off `PIE_DIR` or an injected `ExecutionEnv` instead of the process env.
	 * TODO(port): re-port once a HOME-free fixture exists for the `$HOME/helloworld` assertion.
	 */
	it.skip("home_helloworld_trigger_prints_file_contents", () => {});

	// pie: dynamic_trigger_e2e.rs:935-961
	it("periodic_dynamic_hook_checks_rules_and_executes_matching_action", async () => {
		const registry = new DynamicTriggerRegistry();
		registry.addRule("a dynamic periodic check arrives", "echo periodic-fired");

		const bashCalls: string[] = [];
		const registration = fauxProvider();
		dynamicTriggerResponses(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = newHarness({
			session,
			model: registration.getModel(),
			tools: [recordingBashTool(bashCalls)],
			beforeTriggerAction: beforeTriggerActionHook(registry),
		});
		const hook = new DynamicTriggerCheckHook(registry, 10);
		hooks.push(hook);
		harness.registerNotificationHook(hook);

		expect(
			await waitForBashCall(bashCalls, "echo periodic-fired"),
			"periodic dynamic hook should emit a check trigger that executes the matching rule",
		).toBe(true);
	});
});
