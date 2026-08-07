import { fauxAssistantMessage, fauxToolCall, getModel, registerFauxProvider, type Usage } from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentHarness,
	EvaluatorError,
	type HarnessEvent,
	type OnTurnEndContext,
	type OnTurnEndHook,
	type TriggerAction,
} from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { Trigger } from "../../src/harness/trigger.ts";
import { AgentHarnessError, type PromptTemplate, type Skill } from "../../src/harness/types.ts";
import type { AgentMessage, AgentTool } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";
import { getCurrentTimeTool } from "../utils/get-current-time.ts";

let triggerCounter = 0;

/** oracle trigger.rs:299-323 (`sample_trigger`), adapted with a unique idempotency/trace id per call. */
function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
	triggerCounter += 1;
	return {
		source: { kind: "local", subkind: "test" },
		source_kind: "local",
		source_label: "test source",
		event_label: "fired",
		payload_visibility: "local",
		payload_summary: "a thing happened",
		payload: undefined,
		idempotency_key: `test:${triggerCounter}`,
		replacement_policy: "drop",
		trace_id: `trace-${triggerCounter}`,
		authority: {
			principal_id: "test:principal",
			principal_label: "test principal",
			credential_scope: "None",
			allowed_source_actions: [],
			expires_at: undefined,
		},
		received_at: new Date().toISOString(),
		...overrides,
	};
}

interface AppSkill extends Skill {
	source: "project" | "user";
}

interface AppPromptTemplate extends PromptTemplate {
	source: "project" | "user";
}

interface AppTool extends AgentTool {
	source: "builtin" | "extension";
}

const registrations: Array<{ unregister(): void }> = [];

// `content` is optional here (not required, as it is on Message) because AgentMessage also
// includes custom message variants (e.g. BashExecutionMessage, BranchSummaryMessage,
// CompactionSummaryMessage) that carry no `content` field at all — they're filtered out by the
// `role !== "user"` check below before `content` is ever read.
function textFromUserMessages(messages: Array<{ role: string; content?: unknown }>): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		if (!Array.isArray(message.content)) return [];
		return message.content.flatMap((part) => {
			if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return [];
			return "text" in part && typeof part.text === "string" ? [part.text] : [];
		});
	});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function getReasoning(options: unknown): unknown {
	if (!options || typeof options !== "object" || !("reasoning" in options)) return undefined;
	return options.reasoning;
}

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("AgentHarness", () => {
	it("distinguishes manual compact() from threshold auto-compaction on session_compact.fromHook", async () => {
		// pie: agent_harness.rs:1946-1951 (`force_compact` -> `do_compact(true, ..)`), :2020-2039
		// (`run_auto_compaction` -> `do_compact(false, ..)`) and :2109-2113 (the flag is forwarded
		// onto the compaction event VERBATIM). `coding-agent/src/hooks.ts` maps it to the hook
		// payload's `compaction_trigger` ("manual" vs "auto", oracle hooks.rs:743-747), so
		// deriving it from "did a hook supply the result" made `/compact` report itself as "auto".
		const registration = registerFauxProvider({
			provider: "faux",
			models: [{ id: "faux", name: "Faux", contextWindow: 1, maxTokens: 0 }],
		});
		registrations.push(registration);
		// `contextWindow: 1` keeps `shouldCompact` permanently true, so every prompt runs the
		// auto-compaction pass.
		registration.setResponses(Array(12).fill(fauxAssistantMessage("summary or assistant reply")));
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		const fromHookFlags: boolean[] = [];
		harness.subscribe((event) => {
			if (event.type === "session_compact") fromHookFlags.push(event.fromHook);
		});

		await harness.prompt("first");
		// The pass before "second" has only one turn to work with, so it summarizes nothing and
		// emits nothing (compaction.rs:643-651 + agent_harness.rs:2098-2099).
		await harness.prompt("second");
		await harness.prompt("third");
		expect(fromHookFlags).toEqual([false]);

		const outcome = await harness.compact();
		expect(outcome.ran).toBe(true);
		expect(fromHookFlags).toEqual([false, true]);
	});

	it("constructs directly and exposes queue modes", () => {
		const session = new Session(new InMemorySessionStorage());
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const initialModel = getModel("anthropic", "claude-sonnet-4-5");
		const harness = new AgentHarness({
			env,
			session,
			model: initialModel,
			thinkingLevel: "high",
			systemPrompt: "You are helpful.",
			steeringMode: "all",
			followUpMode: "all",
		});
		expect(harness.env).toBe(env);
		expect(harness.getModel()).toBe(initialModel);
		expect(harness.getThinkingLevel()).toBe("high");
		expect(harness.getSteeringMode()).toBe("all");
		expect(harness.getFollowUpMode()).toBe("all");
		harness.setSteeringMode("one-at-a-time");
		harness.setFollowUpMode("one-at-a-time");
		expect(harness.getSteeringMode()).toBe("one-at-a-time");
		expect(harness.getFollowUpMode()).toBe("one-at-a-time");
	});

	it("drains one queued steering message at a time and emits queue updates", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const userCounts: number[] = [];
		registration.setResponses([
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("first");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("second");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("third");
			},
		]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			steeringMode: "one-at-a-time",
		});
		const steerQueueLengths: number[] = [];
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				steerQueueLengths.push(event.steer.length);
			}
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				harness.steer("one");
				harness.steer("two");
			}
		});

		await harness.prompt("hello");

		expect(userCounts).toEqual([1, 2, 3]);
		expect(steerQueueLengths).toEqual([1, 2, 1, 0]);
	});

	it("appends before_agent_start messages and persists them", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let requestText: string[] = [];
		registration.setResponses([
			(context) => {
				requestText = textFromUserMessages(context.messages);
				return fauxAssistantMessage("ok");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		harness.on("before_agent_start", () => ({
			messages: [{ role: "user", content: [{ type: "text", text: "hook" }], timestamp: Date.now() }],
		}));

		await harness.prompt("hello");

		const persistedText = (await session.getEntries()).flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return [];
			const content = entry.message.content;
			if (typeof content === "string") return [content];
			return content.flatMap((part) => (part.type === "text" ? [part.text] : []));
		});
		expect(requestText).toEqual(["hello", "hook"]);
		expect(persistedText).toEqual(["hello", "hook"]);
	});

	it("abort clears steer and follow-up queues but preserves next-turn messages", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let releaseFirstResponse: (() => void) | undefined;
		let abortedSignal: AbortSignal | undefined;
		const firstResponseReleased = new Promise<void>((resolve) => {
			releaseFirstResponse = resolve;
		});
		const secondRequestText: string[] = [];
		registration.setResponses([
			async (_context, options) => {
				abortedSignal = options?.signal;
				await firstResponseReleased;
				return fauxAssistantMessage("aborted-ish");
			},
			(context) => {
				secondRequestText.push(...textFromUserMessages(context.messages));
				return fauxAssistantMessage("second");
			},
		]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		const queueUpdates: Array<{ steer: number; followUp: number; nextTurn: number }> = [];
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				queueUpdates.push({
					steer: event.steer.length,
					followUp: event.followUp.length,
					nextTurn: event.nextTurn.length,
				});
			}
		});

		const firstPrompt = harness.prompt("first");
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.steer("steer");
		harness.followUp("follow");
		harness.nextTurn("next");
		const abortResultPromise = harness.abort();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(abortedSignal?.aborted).toBe(true);
		releaseFirstResponse?.();
		const abortResult = await abortResultPromise;
		await firstPrompt;
		await harness.prompt("second");

		expect(abortResult.clearedSteer).toHaveLength(1);
		expect(abortResult.clearedFollowUp).toHaveLength(1);
		expect(queueUpdates).toContainEqual({ steer: 0, followUp: 0, nextTurn: 1 });
		expect(secondRequestText).toEqual(["first", "next", "second"]);
	});

	it("drains follow-up messages one at a time after the agent would otherwise stop", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const userCounts: number[] = [];
		registration.setResponses([
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("first");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("second");
			},
			(context) => {
				userCounts.push(context.messages.filter((message) => message.role === "user").length);
				return fauxAssistantMessage("third");
			},
		]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			followUpMode: "one-at-a-time",
		});
		const followUpQueueLengths: number[] = [];
		let queued = false;
		harness.subscribe((event) => {
			if (event.type === "queue_update") {
				followUpQueueLengths.push(event.followUp.length);
			}
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				harness.followUp("one");
				harness.followUp("two");
			}
		});

		await harness.prompt("hello");

		expect(userCounts).toEqual([1, 2, 3]);
		expect(followUpQueueLengths).toEqual([1, 2, 1, 0]);
	});

	it("settles thrown hook failures with persisted assistant error messages", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("should not be used")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const events: string[] = [];
		harness.subscribe((event) => {
			events.push(event.type);
		});
		harness.on("context", () => {
			throw new Error("context exploded");
		});

		const response = await harness.prompt("hello");
		await expect(harness.prompt("after failure")).resolves.toMatchObject({ role: "assistant" });

		const entries = await session.getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toBe("context exploded");
		expect(messages[0]?.role).toBe("user");
		expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "context exploded" });
		expect(events).toContain("agent_end");
		expect(events).toContain("settled");
	});

	it("refreshes model, thinking level, resources, system prompt, and active tools at save points", async () => {
		const registration = registerFauxProvider({
			models: [
				{ id: "first", reasoning: true },
				{ id: "second", reasoning: true },
			],
		});
		registrations.push(registration);
		const secondModel = registration.getModel("second");
		if (!secondModel) throw new Error("missing second faux model");
		const captured: Array<{ modelId: string; reasoning: unknown; systemPrompt: string; tools: string[] }> = [];
		registration.setResponses([
			(context, options, _state, model) => {
				captured.push({
					modelId: model.id,
					reasoning: getReasoning(options),
					systemPrompt: context.systemPrompt ?? "",
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context, options, _state, model) => {
				captured.push({
					modelId: model.id,
					reasoning: getReasoning(options),
					systemPrompt: context.systemPrompt ?? "",
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return fauxAssistantMessage("done");
			},
		]);
		const harness = new AgentHarness<Skill, PromptTemplate, AgentTool>({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			thinkingLevel: "off",
			resources: {
				skills: [{ name: "prompt", description: "prompt", content: "first prompt", filePath: "/skills/prompt" }],
			},
			systemPrompt: ({ resources }) => resources.skills?.[0]?.content ?? "missing prompt",
			tools: [calculateTool],
		});
		harness.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				void harness.setModel(secondModel);
				void harness.setThinkingLevel("high");
				void harness.setResources({
					skills: [
						{ name: "prompt", description: "prompt", content: "second prompt", filePath: "/skills/prompt" },
					],
				});
				void harness.setTools([calculateTool, getCurrentTimeTool], [getCurrentTimeTool.name]);
			}
		});

		await harness.prompt("hello");

		expect(captured).toEqual([
			{ modelId: "first", reasoning: undefined, systemPrompt: "first prompt", tools: ["calculate"] },
			{ modelId: "second", reasoning: "high", systemPrompt: "second prompt", tools: ["get_current_time"] },
		]);
	});

	it("orders pending listener session writes after agent-emitted messages", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		let wrotePendingMessage = false;
		harness.subscribe(async (event) => {
			if (event.type === "message_end" && event.message.role === "assistant" && !wrotePendingMessage) {
				wrotePendingMessage = true;
				await harness.appendMessage({
					role: "custom",
					customType: "listener",
					content: "listener write",
					display: true,
					timestamp: Date.now(),
				} as AgentMessage);
			}
		});

		await harness.prompt("hello");

		const entries = await session.getEntries();
		const roles = entries.flatMap((entry) => (entry.type === "message" ? [entry.message.role] : []));
		expect(roles).toEqual(["user", "assistant", "custom"]);
	});

	it("waitForIdle waits for external run settlement and awaited listeners", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const barrier = deferred();
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		let listenerFinished = false;
		harness.subscribe(async (event) => {
			if (event.type === "agent_end") {
				await barrier.promise;
				listenerFinished = true;
			}
		});

		const promptPromise = harness.prompt("hello");
		let idleResolved = false;
		const idlePromise = harness.waitForIdle().then(() => {
			idleResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idleResolved).toBe(false);
		expect(listenerFinished).toBe(false);
		barrier.resolve();
		await Promise.all([promptPromise, idlePromise]);
		expect(idleResolved).toBe(true);
		expect(listenerFinished).toBe(true);
	});

	it("runs tool_call and tool_result hooks through the direct loop", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() =>
				fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
					stopReason: "toolUse",
				}),
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			tools: [calculateTool],
		});
		const seenToolCalls: Array<{ id: string; name: string; expression: unknown }> = [];
		harness.on("tool_call", (event) => {
			seenToolCalls.push({ id: event.toolCallId, name: event.toolName, expression: event.input.expression });
			return undefined;
		});
		harness.on("tool_result", (event) => {
			expect(event.toolCallId).toBe("call-1");
			expect(event.toolName).toBe("calculate");
			return {
				content: [{ type: "text", text: "patched result" }],
				details: { patched: true },
				terminate: true,
			};
		});

		await harness.prompt("hello");

		const toolResult = (await session.getEntries()).find(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(seenToolCalls).toEqual([{ id: "call-1", name: "calculate", expression: "2 + 2" }]);
		expect(toolResult).toMatchObject({
			type: "message",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: "patched result" }],
				details: { patched: true },
			},
		});
	});

	it("preserves app resource types for getters and update events", async () => {
		const session = new Session(new InMemorySessionStorage());
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const harness = new AgentHarness<AppSkill, AppPromptTemplate, AppTool>({ env, session, model });
		const skill: AppSkill = {
			name: "inspect",
			description: "Inspect things",
			content: "Use inspection tools.",
			filePath: "/skills/inspect/SKILL.md",
			source: "project",
		};
		const promptTemplate: AppPromptTemplate = {
			name: "review",
			content: "Review $1",
			filePath: "/prompts/review.md",
			source: "user",
		};
		const resources = { skills: [skill], promptTemplates: [promptTemplate] };
		const updates: Array<{ resourcesSource?: string; previousSource?: string }> = [];
		harness.subscribe((event) => {
			if (event.type === "resources_update") {
				updates.push({
					resourcesSource: event.resources.skills?.[0]?.source,
					previousSource: event.previousResources.skills?.[0]?.source,
				});
			}
		});

		await harness.setResources(resources);
		await harness.setResources(resources);
		const resolved = harness.getResources();

		expect(updates).toEqual([
			{ resourcesSource: "project", previousSource: undefined },
			{ resourcesSource: "project", previousSource: "project" },
		]);
		expect(resolved.skills?.[0]?.source).toBe("project");
		expect(resolved.promptTemplates?.[0]?.source).toBe("user");
		expect(resolved.skills).not.toBe(resources.skills);
		expect(resolved.promptTemplates).not.toBe(resources.promptTemplates);
	});
});

function waitForHarnessEvent(
	harness: AgentHarness,
	predicate: (event: HarnessEvent) => boolean,
): Promise<HarnessEvent> {
	return new Promise((resolve) => {
		const unsubscribe = harness.subscribeHarness((event) => {
			if (predicate(event)) {
				unsubscribe();
				resolve(event);
			}
		});
	});
}

/**
 * Why this reaches into a private field.
 *
 * B3/B3a are FIXED as of phase 18 — every real provider now prices its own usage from the model
 * catalog, so production cost is no longer 0. But these tests drive `@pie/ai`'s **faux** provider,
 * which deliberately still returns cost 0 (`packages/ai/src/providers/faux.ts`: it fabricates
 * messages from a caller-supplied literal and has no `Model` in scope to price against). That is
 * the "faux/self-filled-cost" path cost.ts's doc comment always called out as the one that kept
 * working, and pricing it would corrupt the fixtures these very tests depend on.
 *
 * So there is still no public seam for getting a non-zero cost signal into this harness's
 * `CostTracker` here. Both gates only ever read `costTracker.snapshot().tokens.cost.total`, and
 * with B3/B3a fixed the identical totals now arrive from real providers via `handleAgentEvent`'s
 * `message_end` branch instead of via this helper — the gates behave identically either way.
 */
// `any` tool generics: this test helper only reaches into the private costTracker field via an
// `as unknown as` cast below, so it must accept any AgentHarness<Skill, PromptTemplate, TTool>
// instantiation regardless of the caller's tool schema (e.g. AgentHarness<..., typeof calculateTool>).
function seedCost(harness: AgentHarness<any, any, any>, totalUsd: number): void {
	(harness as unknown as { costTracker: { record(usage: Usage): void } }).costTracker.record({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: totalUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: totalUsd },
	});
}

/** The one message text both B4 gates produce for a $10 spend against a $1 cap. */
const BUDGET_CAP_MESSAGE_10_OVER_1 =
	"budget cap reached: $10.0000 >= $1.0000. Reset with resetCost() or raise budgetCapUsd.";

describe("AgentHarness budget cap (PORT-DIVERGENCE B4)", () => {
	it(
		"PORT-DIVERGENCE: B4 (RULEBOOK §5, oracle agent_harness.rs:1716-1729,1882-1893) — a cap " +
			"blown mid-loop now HARD-STOPS the in-flight run before the next LLM request, instead of " +
			"letting a single prompt() keep issuing round trips until it happens to finish",
		async () => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			const session = new Session(new InMemorySessionStorage());
			const harness = new AgentHarness({
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session,
				model: registration.getModel(),
				tools: [calculateTool],
				budgetCapUsd: 1,
			});
			let callCount = 0;
			registration.setResponses([
				() => {
					callCount += 1;
					// Simulate cost accounting recording $10 as this turn's message_end is folded in —
					// The faux provider still returns cost 0 (B3/B3a are fixed for real providers only), so
					// only care about what `costTracker.snapshot()` reports, not how the number got there.
					seedCost(harness, 10);
					return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
						stopReason: "toolUse",
					});
				},
				() => {
					callCount += 1;
					return fauxAssistantMessage("done");
				},
				() => {
					callCount += 1;
					return fauxAssistantMessage("done again");
				},
			]);

			// Cost is $10 (>= the $1 cap) once turn 1's usage is recorded. Oracle would still issue
			// the tool-result follow-up request; here the loop stops before it.
			const error = await harness.prompt("hello").catch((thrown: unknown) => thrown);

			expect(error).toBeInstanceOf(AgentHarnessError);
			expect((error as AgentHarnessError).code).toBe("invalid_state");
			expect((error as AgentHarnessError).message).toBe(BUDGET_CAP_MESSAGE_10_OVER_1);
			expect(callCount, "the second (tool-result follow-up) LLM request must never be issued").toBe(1);
			expect(harness.cost().tokens.cost.total).toBe(10);

			// The run terminated cleanly: the tool call that was already in flight ran to completion
			// and its result was persisted, and NO synthesized aborted/error assistant message was
			// injected (which is what routing this through `abort()` would have produced).
			const messages = (await session.getEntries()).flatMap((entry) =>
				entry.type === "message" ? [entry.message] : [],
			);
			expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
			expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "toolUse" });
			expect(messages[2]).toMatchObject({ role: "toolResult", toolName: "calculate", isError: false });

			// The between-cycles gate is unchanged and reports the SAME error shape and text, so a
			// caller matching on it does not have to learn a second shape.
			const secondError = await harness.prompt("second").catch((thrown: unknown) => thrown);
			expect(secondError).toBeInstanceOf(AgentHarnessError);
			expect((secondError as AgentHarnessError).code).toBe("invalid_state");
			expect((secondError as AgentHarnessError).message).toBe(BUDGET_CAP_MESSAGE_10_OVER_1);
			expect(callCount).toBe(1);

			// The harness is idle, not wedged in "busy": resetCost() lifts both gates again.
			harness.resetCost();
			expect(harness.cost().tokens.cost.total).toBe(0);
			await expect(harness.prompt("third")).resolves.toMatchObject({ role: "assistant" });
			expect(callCount).toBe(2);
		},
	);

	it("PORT-DIVERGENCE: B4 — an UNSET cap never gates, however large the accumulated cost", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [calculateTool],
			// budgetCapUsd deliberately omitted.
		});
		let callCount = 0;
		registration.setResponses([
			() => {
				callCount += 1;
				seedCost(harness, 10_000);
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			() => {
				callCount += 1;
				return fauxAssistantMessage("done");
			},
		]);

		const response = await harness.prompt("hello");

		expect(callCount).toBe(2);
		expect(response.content).toEqual([{ type: "text", text: "done" }]);
		expect(harness.cost().tokens.cost.total).toBe(10_000);
	});

	it("PORT-DIVERGENCE: B4 — a cap that is NOT reached lets the tool-call loop finish normally", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
			tools: [calculateTool],
			budgetCapUsd: 100,
		});
		let callCount = 0;
		registration.setResponses([
			() => {
				callCount += 1;
				seedCost(harness, 10);
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			() => {
				callCount += 1;
				// Crossing the cap on the FINAL message is not something a cap could have prevented:
				// no further request follows, so the gate stays quiet and prompt() resolves.
				seedCost(harness, 200);
				return fauxAssistantMessage("done");
			},
		]);

		const response = await harness.prompt("hello");

		expect(callCount).toBe(2);
		expect(response.content).toEqual([{ type: "text", text: "done" }]);
		expect(harness.cost().tokens.cost.total).toBe(210);
	});

	it(
		"PORT-DIVERGENCE: B4 — a queued steering message cannot smuggle in another LLM request " +
			"past a tripped cap either",
		async () => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			const harness = new AgentHarness({
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session: new Session(new InMemorySessionStorage()),
				model: registration.getModel(),
				budgetCapUsd: 1,
			});
			let callCount = 0;
			const steered: Promise<void>[] = [];
			registration.setResponses([
				() => {
					callCount += 1;
					seedCost(harness, 10);
					// stopReason "stop": the loop would only continue because of this queued message.
					steered.push(harness.steer("keep going"));
					return fauxAssistantMessage("step 1");
				},
				() => {
					callCount += 1;
					return fauxAssistantMessage("step 2");
				},
			]);

			await expect(harness.prompt("hello")).rejects.toThrow(BUDGET_CAP_MESSAGE_10_OVER_1);
			await Promise.all(steered);
			expect(callCount).toBe(1);

			// Nothing was silently dropped: the steering message is still queued for a later run.
			const { clearedSteer } = await harness.abort();
			expect(textFromUserMessages(clearedSteer)).toEqual(["keep going"]);
		},
	);

	it(
		"B4 continuation boundary (oracle check, UNCHANGED — RULEBOOK §5, gap-continuation.md " +
			"hand-off, oracle agent_harness.rs:1864-1869) — an onTurnEnd `continue` decision re-checks " +
			"checkBudgetCap() before running the next cycle, so a cap tripped mid-goal cannot be " +
			"bypassed by auto-continuation",
		async () => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			let harnessRef: AgentHarness | undefined;
			let onTurnEndCalls = 0;
			const harness = new AgentHarness({
				env: new NodeExecutionEnv({ cwd: process.cwd() }),
				session: new Session(new InMemorySessionStorage()),
				model: registration.getModel(),
				budgetCapUsd: 1,
				onTurnEnd: async () => {
					onTurnEndCalls += 1;
					// Same faux-provider seeding trick as the top-level B4 test above: simulate cost
					// crossing the cap in between turn 1 finishing and the continuation hook deciding.
					seedCost(harnessRef!, 10);
					return { action: { kind: "continue", prompt: "keep going" } };
				},
			});
			harnessRef = harness;
			registration.setResponses([() => fauxAssistantMessage("step1")]);

			await expect(harness.prompt("hello")).rejects.toThrow(/budget cap reached/);

			// The hook fired exactly once (it's what tripped the cap) and the "continue" decision
			// was already persisted before the cap check ran (oracle records the audit BEFORE
			// re-checking, agent_harness.rs:1856-1868) — but the second turn never ran.
			expect(onTurnEndCalls).toBe(1);
			expect(registration.state.callCount).toBe(1);
			expect(harness.cost().tokens.cost.total).toBe(10);
		},
	);
});

describe("AgentHarness trigger execution chain", () => {
	it("handleTrigger: Accept -> default sub_agent delivery runs a detached sub-agent and audits trigger_result", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const capturedPrompts: string[] = [];
		registration.setResponses([
			(context) => {
				capturedPrompts.push(...textFromUserMessages(context.messages));
				return fauxAssistantMessage("sub agent done");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));
		const completed = waitForHarnessEvent(harness, (event) => event.type === "trigger_completed");

		const trigger = makeTrigger();
		const outcome = await harness.handleTrigger(trigger);
		await completed;

		expect(outcome).toEqual({ type: "accept" });
		expect(capturedPrompts).toEqual(["test source fired: fired"]);
		expect(events.map((event) => event.type)).toEqual([
			"trigger_handling_start",
			"trigger_handled",
			"trigger_execution_started",
			"trigger_completed",
		]);
		const handled = events[1] as Extract<HarnessEvent, { type: "trigger_handled" }>;
		expect(handled.state).toBe("accepted");

		const entries = await session.getEntries();
		const triggerEntry = entries.find((entry) => entry.type === "custom" && entry.customType === "trigger");
		expect(triggerEntry).toMatchObject({ type: "custom", customType: "trigger", data: { state: "accepted" } });
		const resultEntry = entries.find((entry) => entry.type === "custom" && entry.customType === "trigger_result");
		// message_count includes BOTH the injected user prompt and the assistant reply — the
		// sub-agent's `observedMessages` transcript mirrors oracle's `sub_agent.state().messages`,
		// which likewise counts the prompt message it pushed before running the loop
		// (pie: agent_harness.rs:3347-3359 `compute_sub_agent_outcome` reads `state.messages.len()`).
		expect(resultEntry).toMatchObject({
			type: "custom",
			customType: "trigger_result",
			data: { success: true, summary: "sub agent done", message_count: 2, cost_usd: null },
		});
		// promote: none (defaultTriggerAction) -> nothing promoted into the parent session.
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(messages.filter((message) => message.role === "user")).toHaveLength(0);
	});

	it("handleTrigger: a second call with the same idempotency_key inside the dedup window is deduped", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("should only run once")]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});
		const trigger = makeTrigger({ idempotency_key: "dup-key", trace_id: "trace-dup-1" });
		const completed = waitForHarnessEvent(harness, (event) => event.type === "trigger_completed");
		const first = await harness.handleTrigger(trigger);
		await completed;
		const second = await harness.handleTrigger({ ...trigger, trace_id: "trace-dup-2" });

		expect(first).toEqual({ type: "accept" });
		expect(second).toMatchObject({ type: "deduped", replacementPolicy: "drop", previousTraceId: "trace-dup-1" });
		expect(registration.state.callCount).toBe(1);
	});

	it("handleTrigger: a beforeTrigger Deny decision stops at permission_denied without spawning any action", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTrigger: async () => ({ kind: "deny", reason: "blocked in test" }),
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		const outcome = await harness.handleTrigger(makeTrigger());

		expect(outcome).toEqual({ type: "accept" });
		expect(events.map((event) => event.type)).toEqual(["trigger_handling_start", "trigger_handled"]);
		const handled = events[1] as Extract<HarnessEvent, { type: "trigger_handled" }>;
		expect(handled.state).toBe("permission_denied");
		expect(handled.evaluatorDecision).toMatchObject({
			outcome: "accept",
			permission: "deny",
			reason: "blocked in test",
		});
		expect(registration.state.callCount).toBe(0);
	});

	it("handleTrigger: inject_and_run delivery on an IDLE harness appends the message directly and requests a main run", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "please look into this",
			promote: { kind: "none" },
			promoteRequiresApproval: false,
			delivery: "inject_and_run",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));
		const trigger = makeTrigger();
		const requestedMainRun = waitForHarnessEvent(harness, (event) => event.type === "trigger_requests_main_run");

		await harness.handleTrigger(trigger);
		await requestedMainRun;

		expect(events.some((event) => event.type === "trigger_completed")).toBe(true);
		expect(events.some((event) => event.type === "trigger_requests_main_run")).toBe(true);
		expect(registration.state.callCount).toBe(0);

		const entries = await session.getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const userTexts = textFromUserMessages(messages);
		expect(userTexts).toEqual([`[Trigger ${trigger.trace_id}] please look into this`]);
	});

	it("handleTrigger: inject_and_run delivery on a BUSY harness enqueues a follow-up instead of appending directly", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let releaseFirst: (() => void) | undefined;
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const callTexts: string[][] = [];
		registration.setResponses([
			async (context) => {
				callTexts.push(textFromUserMessages(context.messages));
				await firstReleased;
				return fauxAssistantMessage("main turn done");
			},
			(context) => {
				callTexts.push(textFromUserMessages(context.messages));
				return fauxAssistantMessage("follow-up handled");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "please look into this",
			promote: { kind: "none" },
			promoteRequiresApproval: false,
			delivery: "inject_and_run",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));
		const queueUpdates: number[] = [];
		harness.subscribe((event) => {
			if (event.type === "queue_update") queueUpdates.push(event.followUp.length);
		});

		const promptPromise = harness.prompt("main prompt");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const trigger = makeTrigger();
		const completed = waitForHarnessEvent(harness, (event) => event.type === "trigger_completed");
		await harness.handleTrigger(trigger);
		await completed;

		// Busy path never asks the embedder to schedule a main run -- the queued follow-up
		// message rides the ALREADY in-flight loop instead (RULEBOOK "inject-and-run: serialized on the
		// parent session").
		expect(events.some((event) => event.type === "trigger_requests_main_run")).toBe(false);
		expect(queueUpdates.some((length) => length > 0)).toBe(true);

		releaseFirst?.();
		await promptPromise;

		expect(callTexts[0]).toEqual(["main prompt"]);
		expect(callTexts[1]).toEqual(["main prompt", `[Trigger ${trigger.trace_id}] please look into this`]);
	});

	it("handleTrigger: inject_summary delivery skips the sub-agent entirely and treats payload_summary as the result", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "unused",
			promote: { kind: "none" },
			promoteRequiresApproval: false,
			delivery: "inject_summary",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const trigger = makeTrigger({ payload_summary: "digest: 3 new items" });
		const completed = waitForHarnessEvent(harness, (event) => event.type === "trigger_completed");

		await harness.handleTrigger(trigger);
		const completedEvent = await completed;

		expect(completedEvent).toMatchObject({ type: "trigger_completed", summary: "digest: 3 new items", costUsd: 0 });
		expect(registration.state.callCount).toBe(0);
		const entries = await session.getEntries();
		const resultEntry = entries.find((entry) => entry.type === "custom" && entry.customType === "trigger_result");
		expect(resultEntry).toMatchObject({
			data: { delivery: "inject_summary", success: true, message_count: 0, summary: "digest: 3 new items" },
		});
	});

	it("applyPromotion: promote_summary_now inserts a [Trigger <id>]-prefixed message into an idle parent session", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("investigated and fixed")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "investigate",
			promote: { kind: "promote_summary_now" },
			promoteRequiresApproval: false,
			delivery: "sub_agent",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const trigger = makeTrigger({ event_label: "check completed" });
		const promoted = waitForHarnessEvent(harness, (event) => event.type === "trigger_promoted");

		await harness.handleTrigger(trigger);
		const promotedEvent = await promoted;

		expect(promotedEvent).toMatchObject({
			type: "trigger_promoted",
			promoteKind: "promote_summary_now",
			templateName: "default",
			redactionStatus: "clean",
		});
		const insertedEntryId = (promotedEvent as Extract<HarnessEvent, { type: "trigger_promoted" }>).insertedEntryId;
		expect(insertedEntryId.length).toBeGreaterThan(0);

		const entries = await session.getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const userTexts = textFromUserMessages(messages);
		// Default template already opens with the `[Trigger <id>] ` form, so the engine-level
		// prefix enforcement is a no-op here (prefix_injected: false) -- see the next assertion.
		expect(userTexts).toEqual([
			`[Trigger ${trigger.trace_id}] ${trigger.source_label} fired ${trigger.event_label}.\nResult: investigated and fixed`,
		]);
		const promotionEntry = entries.find(
			(entry) => entry.type === "custom" && entry.customType === "trigger_promotion",
		);
		expect(promotionEntry).toMatchObject({ data: { state: "success", prefix_injected: false } });
	});

	// pie: agent_harness.rs:3044-3057 (`#[allow(deprecated)] PromoteAction::PromoteSummaryWhenSummaryContains`).
	// Added phase 10 for coding-agent/triggers/dynamic (see the `PromoteAction` type doc) — the
	// only caller of this deprecated variant at oracle @0a120dfd.
	it("applyPromotion: promote_summary_when_summary_contains promotes when the sub-agent summary contains a required substring", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("matched dyn-abc123")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "evaluate rules",
			promote: { kind: "promote_summary_when_summary_contains", requiredSubstrings: ["dyn-abc123", "dyn-other"] },
			promoteRequiresApproval: false,
			delivery: "sub_agent",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const trigger = makeTrigger({ event_label: "dynamic check" });
		const promoted = waitForHarnessEvent(harness, (event) => event.type === "trigger_promoted");

		await harness.handleTrigger(trigger);
		const promotedEvent = await promoted;

		// Reuses the "promote_summary_now" label on match -- oracle's audit/event trail cannot
		// distinguish the deprecated substring-match variant from the direct one once it fires.
		expect(promotedEvent).toMatchObject({ type: "trigger_promoted", promoteKind: "promote_summary_now" });
		const entries = await session.getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const userTexts = textFromUserMessages(messages);
		expect(userTexts).toEqual([
			`[Trigger ${trigger.trace_id}] ${trigger.source_label} fired ${trigger.event_label}.\nResult: matched dyn-abc123`,
		]);
	});

	it("applyPromotion: promote_summary_when_summary_contains is a silent no-op (no audit) when no required substring matches", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("no dynamic trigger rule matched")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "evaluate rules",
			promote: { kind: "promote_summary_when_summary_contains", requiredSubstrings: ["dyn-abc123"] },
			promoteRequiresApproval: false,
			delivery: "sub_agent",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const trigger = makeTrigger();
		const completed = waitForHarnessEvent(harness, (event) => event.type === "trigger_completed");

		await harness.handleTrigger(trigger);
		await completed;
		// Give the (synchronous-after-completed) applyPromotion tail a microtask to run so a wrongly
		// fired promotion would already be visible if this assertion raced it.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const entries = await session.getEntries();
		expect(entries.some((entry) => entry.type === "custom" && entry.customType === "trigger_promotion")).toBe(false);
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(textFromUserMessages(messages)).toHaveLength(0);
	});

	it("abortTrigger cancels an in-flight sub_agent trigger via the selectBiased cancel race and audits the aborted result", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			(_context, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new Error("stream aborted")), { once: true });
				}),
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const trigger = makeTrigger();
		const failed = waitForHarnessEvent(harness, (event) => event.type === "trigger_failed");

		await harness.handleTrigger(trigger);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.notificationStatusSnapshot().running).toHaveLength(1);

		harness.abortTrigger(trigger.trace_id);
		const failedEvent = await failed;

		expect(failedEvent).toMatchObject({ type: "trigger_failed", traceId: trigger.trace_id, reason: "aborted" });
		// pie: agent_harness.rs:2814-2815 — the registry entry is removed LAST, after promotion
		// (which runs after the terminal event); give that trailing async work a tick to settle.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.notificationStatusSnapshot().running).toHaveLength(0);
		const entries = await session.getEntries();
		const resultEntry = entries.find((entry) => entry.type === "custom" && entry.customType === "trigger_result");
		expect(resultEntry).toMatchObject({ data: { success: false, reason: "aborted" } });
	});
});

/**
 * pie: agent_harness.rs:640-980,1716-2018 — turn-continuation family
 * (`OnTurnEndContext`/`TurnEndAction`/`TurnEndDecision`/`OnTurnEndHook`/`continue_`/
 * `run_turn_with_continuation`/`run_evaluator`). Ported per
 * migration/reviews/agent/gap-continuation.md as a phase 11 prerequisite for
 * `packages/coding-agent/src/goal.ts` (the `/goal` stop hook).
 */
describe("AgentHarness turn continuation (onTurnEnd / continue / runEvaluator)", () => {
	function turnEndEntries(entries: Awaited<ReturnType<Session["getEntries"]>>) {
		return entries.filter((entry) => entry.type === "custom" && entry.customType === "turn_end_decision");
	}

	it("prompt() with no onTurnEnd configured behaves like the legacy single-cycle path — no audit entry, no event", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const turnEndedEvents: HarnessEvent[] = [];
		registrations.push({
			unregister: harness.subscribeHarness((event) => {
				if (event.type === "turn_ended") turnEndedEvents.push(event);
			}),
		});
		registration.setResponses([() => fauxAssistantMessage("done")]);

		const response = await harness.prompt("hello");

		expect(response.content).toEqual([{ type: "text", text: "done" }]);
		expect(turnEndEntries(await session.getEntries())).toHaveLength(0);
		expect(turnEndedEvents).toHaveLength(0);
	});

	it("onTurnEnd Continue decisions auto-continue the SAME prompt cycle until Stop, persisting turn_end_decision audits", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const capturedContexts: OnTurnEndContext[] = [];
		const onTurnEnd: OnTurnEndHook = async (ctx) => {
			capturedContexts.push(ctx);
			if (ctx.continuationCount === 0) {
				return { action: { kind: "continue", prompt: "keep going" }, payload: { note: "not done yet" } };
			}
			return { action: { kind: "stop" } };
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			onTurnEnd,
		});
		registration.setResponses([() => fauxAssistantMessage("step1"), () => fauxAssistantMessage("step2")]);

		const response = await harness.prompt("hello");

		expect(response.content).toEqual([{ type: "text", text: "step2" }]);
		expect(registration.state.callCount).toBe(2);
		expect(capturedContexts.map((ctx) => ctx.continuationCount)).toEqual([0, 1]);
		expect(capturedContexts[1]?.lastUserPrompt).toBe("keep going");

		const userTexts = textFromUserMessages(
			(await session.getEntries())
				.filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
				.map((entry) => entry.message),
		);
		expect(userTexts).toEqual(["hello", "keep going"]);

		const decisions = turnEndEntries(await session.getEntries());
		expect(decisions).toHaveLength(2);
		expect(decisions[0]).toMatchObject({ data: { decision: "continue", continuation_count: 1 } });
		expect(decisions[1]).toMatchObject({ data: { decision: "stop", continuation_count: 1 } });
	});

	it("onTurnEnd continuation cap stops auto-continuation without invoking the hook again, recording budget_limited", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		let hookCalls = 0;
		const onTurnEnd: OnTurnEndHook = async (ctx) => {
			hookCalls += 1;
			return { action: { kind: "continue", prompt: `turn ${ctx.continuationCount + 2}` } };
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			onTurnEnd,
			turnContinuationCap: 2,
		});
		registration.setResponses([
			() => fauxAssistantMessage("turn 1"),
			() => fauxAssistantMessage("turn 2"),
			() => fauxAssistantMessage("turn 3"),
		]);

		const response = await harness.prompt("start");

		// Cap of 2 allows exactly 2 `continue` decisions (3 turns total); the hook is never asked
		// a 3rd time — the runtime records `budget_limited` itself once continuationCount reaches
		// the cap, matching oracle's "no need for the hook to enforce the cap itself" contract.
		expect(hookCalls).toBe(2);
		expect(registration.state.callCount).toBe(3);
		expect(response.content).toEqual([{ type: "text", text: "turn 3" }]);

		const decisions = turnEndEntries(await session.getEntries());
		expect(decisions.map((entry) => (entry as { data: { decision: string } }).data.decision)).toEqual([
			"continue",
			"continue",
			"budget_limited",
		]);
	});

	it("onTurnEnd Pause returns control after one turn and persists the reason", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const onTurnEnd: OnTurnEndHook = async () => ({
			action: { kind: "pause", reason: "waiting on an external approval" },
		});
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			onTurnEnd,
		});
		registration.setResponses([() => fauxAssistantMessage("step1")]);

		const response = await harness.prompt("hello");

		expect(response.content).toEqual([{ type: "text", text: "step1" }]);
		expect(registration.state.callCount).toBe(1);
		const decisions = turnEndEntries(await session.getEntries());
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			data: { decision: "pause", reason: "waiting on an external approval", continuation_count: 0 },
		});
	});

	it("onTurnEnd Noop is silent — no audit entry, no turn_ended event, matching 'no hook configured'", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const onTurnEnd: OnTurnEndHook = async () => ({ action: { kind: "noop" } });
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			onTurnEnd,
		});
		const turnEndedEvents: HarnessEvent[] = [];
		registrations.push({
			unregister: harness.subscribeHarness((event) => {
				if (event.type === "turn_ended") turnEndedEvents.push(event);
			}),
		});
		registration.setResponses([() => fauxAssistantMessage("step1")]);

		await harness.prompt("hello");

		expect(turnEndEntries(await session.getEntries())).toHaveLength(0);
		expect(turnEndedEvents).toHaveLength(0);
	});

	it("continue() runs the existing session context WITHOUT appending a new user message", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		let capturedLastUserPrompt: string | undefined;
		const onTurnEnd: OnTurnEndHook = async (ctx) => {
			capturedLastUserPrompt = ctx.lastUserPrompt;
			return { action: { kind: "stop" } };
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			onTurnEnd,
		});
		registration.setResponses([() => fauxAssistantMessage("first")]);
		await harness.prompt("original question");
		expect(capturedLastUserPrompt).toBe("original question");

		registration.setResponses([() => fauxAssistantMessage("continued")]);
		const response = await harness.continue();

		expect(response.content).toEqual([{ type: "text", text: "continued" }]);
		// `continue()` fed the hook the most recent USER text already in the session — it did not
		// need a new one appended to know "what the user originally asked for" (agent_harness.rs
		// :1896-1905 `last_user_text_from_state`).
		expect(capturedLastUserPrompt).toBe("original question");

		const userTexts = textFromUserMessages(
			(await session.getEntries())
				.filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
				.map((entry) => entry.message),
		);
		expect(userTexts).toEqual(["original question"]);
	});

	it("runEvaluator runs with tools:[] and does not persist to the session or attribute cost to the parent tracker", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		let capturedToolCount: number | undefined;
		registration.setResponses([
			(context) => {
				capturedToolCount = context.tools?.length ?? -1;
				return fauxAssistantMessage('{"ok":true,"reason":"transcript shows the file was created"}');
			},
		]);
		const entriesBefore = await session.getEntries();

		const output = await harness.runEvaluator(
			"You are evaluating a stop condition.",
			"Goal condition:\ncreate foo.txt\n\nConversation transcript:\n(empty)",
			registration.getModel(),
			"off",
			new AbortController().signal,
		);

		expect(capturedToolCount).toBe(0);
		expect(output.lastAssistantText).toBe('{"ok":true,"reason":"transcript shows the file was created"}');
		expect(harness.cost().tokens.cost.total).toBe(0);
		expect(await session.getEntries()).toHaveLength(entriesBefore.length);
	});

	it("runEvaluator throws EvaluatorError('cancelled') when the signal is already aborted", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		registration.setResponses([() => fauxAssistantMessage("should not be reached")]);
		const controller = new AbortController();
		controller.abort();

		const error = await harness
			.runEvaluator("sys", "user", registration.getModel(), "off", controller.signal)
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(EvaluatorError);
		expect((error as EvaluatorError).kind).toBe("cancelled");
	});

	it("runEvaluator throws EvaluatorError('run') when the underlying agent run fails", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		// A `before_provider_request` hook throwing is a genuine `runAgentLoop` rejection (unlike a
		// provider-level "error" response, which resolves normally with an error-content assistant
		// message) — the same channel runEvaluator's doc comment documents as a benign superset of
		// oracle's bare-Agent construction.
		harness.on("before_provider_request", () => {
			throw new Error("boom");
		});
		registration.setResponses([() => fauxAssistantMessage("should not be reached")]);

		const error = await harness
			.runEvaluator("sys", "user", registration.getModel(), "off", new AbortController().signal)
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(EvaluatorError);
		expect((error as EvaluatorError).kind).toBe("run");
		expect((error as EvaluatorError).message).toMatch(/boom/);
	});
});
