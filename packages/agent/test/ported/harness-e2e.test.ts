/**
 * char-tests port of oracle `crates/agent/tests/harness_e2e.rs` (pie @0a120dfd).
 *
 * This is the largest of the batch-H char-tests files (oracle: 5701 lines, ~80 test functions).
 * Ported by two workers into this one file: this half (groups: basic prompt/session, budget/cost/
 * abort/event-bus, compaction pure-function helpers, handle_trigger core, notification hooks,
 * before_trigger hooks, and the group-8 control_plane_prompt/on_turn_end_hook/run_evaluator gap
 * stubs) plus a merged-in second half (sub-agent spawn/abort, promote actions, promotion
 * conditions, control-plane-write category, skill reload).
 *
 * Shared helper contract (mirrors packages/agent/test/harness/agent-harness.test.ts, the
 * pre-existing non-1:1 unit-test suite for the same class): `makeTrigger`, `waitForHarnessEvent`,
 * `seedCost`, `textFromUserMessages`.
 */

import type { AssistantMessage } from "@pie/ai";
import { type FauxResponseFactory, fauxAssistantMessage, registerFauxProvider, type Usage } from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentHarness,
	evaluatePromotionCondition,
	type HarnessEvent,
	type PromotionCondition,
	type TriggerAction,
} from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { PermissionPolicy } from "../../src/harness/permission.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl-repo.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { buildSessionContext, Session } from "../../src/harness/session/session.ts";
import { TRIGGER_RECORD_CUSTOM_TYPE, type Trigger, type TriggerRecord } from "../../src/harness/trigger.ts";
import type { SessionStorage, SessionTreeEntry } from "../../src/harness/types.ts";
import { SessionError } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";
import { createTempDir } from "../harness/session-test-utils.ts";

let triggerCounter = 0;

/** oracle trigger.rs:299-323 (`sample_trigger`) / harness_e2e.rs:1233-1257, adapted with a unique
 * idempotency/trace id per call — mirrors agent-harness.test.ts's `makeTrigger`. */
function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
	triggerCounter += 1;
	return {
		source: { kind: "mcp", server_name: "github", method: "notifications/pr.merged" },
		source_kind: "mcp",
		source_label: "MCP github",
		event_label: "pr merged",
		payload_visibility: "local",
		payload_summary: "PR #42 merged",
		payload: undefined,
		idempotency_key: `test:${triggerCounter}`,
		replacement_policy: "drop",
		trace_id: `trace-${triggerCounter}`,
		authority: {
			principal_id: "mcp:github",
			principal_label: "github",
			credential_scope: "Project",
			allowed_source_actions: ["read"],
			expires_at: undefined,
		},
		received_at: new Date().toISOString(),
		...overrides,
	};
}

/**
 * B3/B3a are fixed as of phase 18, but these tests drive the **faux** provider, which still
 * returns cost 0 by design — see agent-harness.test.ts's identical helper for the full
 * explanation. Reaching into the private `costTracker` field remains the only way to characterize
 * cost-accumulation/budget-cap behavior against a non-zero cost signal here.
 */
function seedUsage(harness: AgentHarness, usage: Usage): void {
	(harness as unknown as { costTracker: { record(usage: Usage): void } }).costTracker.record(usage);
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/** Polls `pred(events)` every 20ms until it returns a value or `timeoutMs` elapses. Mirrors
 * oracle's `wait_for_event` helper (harness_e2e.rs:2376-2394). Used by the part-2 sub-agent/
 * promotion tests below, which need to poll for a detached (`spawnTriggerAction`) task's terminal
 * event rather than awaiting `handleTrigger()` itself (which returns before the detached work
 * finishes). */
async function waitForEvent<T>(
	events: HarnessEvent[],
	timeoutMs: number,
	pred: (events: HarnessEvent[]) => T | undefined,
): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = pred(events);
		if (value !== undefined) return value;
		if (Date.now() > deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function findCustomEntryData(entries: Awaited<ReturnType<Session["getEntries"]>>, customType: string): unknown {
	const entry = entries.find((e) => e.type === "custom" && e.customType === customType);
	return entry && entry.type === "custom" ? entry.data : undefined;
}

function userMessageTextById(entries: Awaited<ReturnType<Session["getEntries"]>>, id: string): string | undefined {
	const entry = entries.find((e) => e.id === id);
	if (!entry || entry.type !== "message" || entry.message.role !== "user") return undefined;
	const content = entry.message.content;
	if (typeof content === "string") return content;
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

function anyUserMessageText(entries: Awaited<ReturnType<Session["getEntries"]>>): string[] {
	return entries.flatMap((e) => {
		if (e.type !== "message" || e.message.role !== "user") return [];
		const content = e.message.content;
		if (typeof content === "string") return [content];
		return [
			content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(""),
		];
	});
}

function hasAnyMessageEntry(entries: Awaited<ReturnType<Session["getEntries"]>>): boolean {
	return entries.some((e) => e.type === "message");
}

function newHarness(overrides: Partial<ConstructorParameters<typeof AgentHarness>[0]> = {}) {
	const registration = registerFauxProvider();
	const session = new Session(new InMemorySessionStorage());
	const harness = new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session,
		model: registration.getModel(),
		...overrides,
	});
	return { registration, session, harness };
}

const registrations: Array<{ unregister(): void }> = [];
afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Group 1 — basic prompt/session, budget/cost/abort, event bus
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("harness_e2e: prompt/session basics", () => {
	it("prompt_persists_user_and_assistant_to_session", async () => {
		const { registration, session, harness } = newHarness();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("hello world")]);

		await harness.prompt("hi");

		const entries = await session.getEntries();
		expect(entries.length, `expected at least 2 entries, got ${entries.length}`).toBeGreaterThanOrEqual(2);
		const hasAssistant = entries.some((e) => e.type === "message" && e.message.role === "assistant");
		expect(hasAssistant).toBe(true);
	});

	// oracle harness_e2e.rs:108-163. `harness.prompt("hi").await.unwrap_err()` — the failing
	// storage causes the normal message_end append AND the emitRunFailure retry's append to both
	// fail (agent-harness.ts:1030-1041 handleAgentEvent "message_end" -> session.appendMessage;
	// :1121-1136 executeTurn's double-catch wraps both failures into an AggregateError-backed
	// AgentHarnessError) — prompt() does reject, but the final `.message` text is the generic
	// "Agent run failed and failure reporting failed" (agent-harness.ts:1130), NOT oracle's
	// exact "session append message ... disk full" wording — the original SessionError text is
	// reachable only via `.cause.errors[]`, not the thrown error's own `.message`. Asserted via
	// the `.cause` chain instead of the top-level message to preserve the SAME information oracle
	// checks (both underlying failures visible) without asserting a message format the base
	// architecture does not produce.
	it("prompt_reports_session_persistence_failures", async () => {
		class FailingAppendStorage implements SessionStorage {
			async getMetadata() {
				return { id: "fail", createdAt: new Date().toISOString() };
			}
			async getLeafId() {
				return null;
			}
			async setLeafId() {}
			async createEntryId() {
				return "entry";
			}
			async appendEntry(): Promise<void> {
				throw new Error("disk full");
			}
			async getEntry() {
				return undefined;
			}
			async findEntries() {
				return [] as never;
			}
			async getLabel() {
				return undefined;
			}
			async getPathToRoot() {
				return [];
			}
			async getEntries() {
				return [];
			}
		}

		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new FailingAppendStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});

		let caught: unknown;
		try {
			await harness.prompt("hi");
		} catch (error) {
			caught = error;
		}
		expect(caught, "prompt() must reject when the session cannot persist the turn").toBeInstanceOf(Error);
		const cause = (caught as Error & { cause?: unknown }).cause;
		const causeText = JSON.stringify(cause, Object.getOwnPropertyNames(cause ?? {}));
		expect(causeText, `expected the original storage failure reachable via .cause, got: ${causeText}`).toContain(
			"disk full",
		);
	});

	// pie: harness_e2e.rs:165-183 (`move_to_rehydrates_thinking_level_from_session_context`).
	// oracle moves straight to `msg_id` (the current leaf) and checks the no-op move still
	// rehydrates. TS's `navigateTree` has two pre-existing, unrelated base behaviors oracle's
	// `move_to` has no equivalent of: (a) an early-return no-op when `targetId` already equals the
	// current leaf, and (b) special "edit this message" handling for `message`/`user` targets
	// (rewinds the leaf to the message's PARENT instead of moving straight to it). Targeting the
	// `thinking_level_change` entry itself — not the current leaf, and not a message — sidesteps
	// both of those unrelated branches and exercises the plain "move + rehydrate" path this test
	// is actually about (gap #4: `navigateTree` previously never rehydrated `thinkingLevel`/
	// `model` from session context after a branch switch, agent-harness.ts's `navigateTree`).
	it("move_to_rehydrates_thinking_level_from_session_context", async () => {
		const { registration, session, harness } = newHarness({ thinkingLevel: "off" });
		registrations.push(registration);
		const thinkingChangeId = await session.appendThinkingLevelChange("high");
		await session.appendMessage(userMessage("hi"));
		expect(await session.getLeafId(), "target must differ from the current leaf").not.toBe(thinkingChangeId);

		await harness.navigateTree(thinkingChangeId);

		expect(harness.getThinkingLevel()).toBe("high");
	});

	// pie: harness_e2e.rs:185-209 (`skills_block_appears_in_system_prompt`).
	it("skills_block_appears_in_system_prompt", async () => {
		const { registration, harness } = newHarness({
			systemPrompt: "Base.",
			thinkingLevel: "medium",
			resources: {
				skills: [
					{
						name: "my-skill",
						description: "does things",
						filePath: "/skills/my-skill/SKILL.md",
						content: "the body",
						disableModelInvocation: false,
					},
				],
			},
		});
		registrations.push(registration);

		const prompt = harness.getSystemPrompt();
		expect(prompt.startsWith("Base.")).toBe(true);
		expect(prompt).toContain("<skills>");
		expect(prompt).toContain("- name: my-skill");
	});

	it("set_model_persists_to_session", async () => {
		const { registration, session, harness } = newHarness();
		registrations.push(registration);
		const modelB = registration.getModel();
		if (!modelB) throw new Error("missing faux model");
		const modelBv2 = { ...modelB, id: "faux-v2" };

		await harness.setModel(modelBv2);
		await harness.setThinkingLevel("medium");

		const entries = await session.getEntries();
		expect(entries.some((e) => e.type === "model_change" && e.modelId === "faux-v2")).toBe(true);
		expect(entries.some((e) => e.type === "thinking_level_change" && e.thinkingLevel === "medium")).toBe(true);
	});

	// pie: harness_e2e.rs:238-272 (`prompt_from_template_interpolates_and_runs`).
	// `AgentHarness.promptFromTemplate` now interpolates named `{{var}}` placeholders via
	// `PromptTemplateRegistry.interpolate` (prompt-templates.ts), matching oracle's
	// `prompt_from_template(name, vars)`. The base's own pre-existing positional `$1`/`$@`
	// mechanism (`formatPromptTemplateInvocation`/`substituteArgs`) remains untouched and
	// separately unit-tested (test/harness/prompt-templates.test.ts) — additive, not removed.
	it("prompt_from_template_interpolates_and_runs", async () => {
		const { registration, session, harness } = newHarness({
			resources: {
				promptTemplates: [{ name: "greet", content: "Say hi to {{name}}", filePath: "/tpl/greet.md" }],
			},
		});
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("template-resp")]);

		await harness.promptFromTemplate("greet", { name: "world" });

		const entries = await session.getEntries();
		const hasInterpolated = anyUserMessageText(entries).includes("Say hi to world");
		expect(hasInterpolated, `expected interpolated user message; entries=${JSON.stringify(entries)}`).toBe(true);
	});

	// pie: harness_e2e.rs:274-312 (`rehydrate_from_session_restores_messages_model_thinking`).
	// TS's per-turn state already rebuilds `messages` fresh from `session.buildContext()` on every
	// `prompt()`/`skill()`/`promptFromTemplate()` call (no persistent `state.messages` field to
	// separately assert against, unlike oracle's `agent.state()`), so this asserts the two fields
	// `rehydrateFromSession()` DOES persist onto the harness instance (`model`/`thinkingLevel`)
	// plus the returned `SessionContext` itself (which does carry `messages`, matching oracle's
	// `ctx.messages`/`ctx.model`/`ctx.thinking_level` assertions).
	it("rehydrate_from_session_restores_messages_model_thinking", async () => {
		const { registration, session, harness } = newHarness({ thinkingLevel: "off" });
		registrations.push(registration);
		const coldModel = registration.getModel();
		if (!coldModel) throw new Error("missing faux model");

		await session.appendThinkingLevelChange("high");
		await session.appendModelChange(coldModel.provider, coldModel.id);
		await session.appendMessage(userMessage("earlier user prompt"));

		const ctx = await harness.rehydrateFromSession();

		expect(ctx.thinkingLevel).toBe("high");
		expect(ctx.model?.modelId).toBe(coldModel.id);
		expect(ctx.messages).toHaveLength(1);

		expect(harness.getThinkingLevel()).toBe("high");
		// "faux" isn't in the built-in @pie/ai model catalog, so rehydrate can't resolve a
		// replacement -- it must leave the cold-start model in place rather than blow it away.
		expect(harness.getModel()).toBe(coldModel);
	});

	// GAP: oracle's `subscribe_harness`/`HarnessEvent` carries `SessionStart`/`Compaction`/
	// `Branch`/`SkillsReloaded` variants alongside the trigger-lifecycle ones. TS's
	// `subscribeHarness`/`HarnessEvent` (agent-harness.ts:56-69, 154-164, its own header comment)
	// DELIBERATELY carries ONLY the trigger-lifecycle variants — "oracle's SessionStart/
	// Compaction/Branch/SkillsReloaded variants are NOT ported here... only the trigger-lifecycle
	// variants that have no existing base counterpart are added." A plain `prompt()`/
	// `navigateTree()` call (as this oracle test drives) therefore emits ZERO events on
	// `subscribeHarness` in TS — there is nothing to assert "SessionStart is exactly-once" or
	// "Branch appears" against on that channel. (The isolation/unsub *mechanism* itself is
	// covered below via `handleTrigger`, which DOES populate this channel — see
	// `harness_event_bus_isolates_panicking_listener`/`subscribe_harness_unsub_stops_delivery`.)
	it.skip("harness_event_bus_delivers_session_and_branch (GAP: subscribeHarness carries no SessionStart/Branch event on this base architecture — deliberate, documented divergence, agent-harness.ts:59-68)", () => {
		expect.unreachable();
	});
});

describe("harness_e2e: budget cap / cost / abort", () => {
	it("budget_cap_blocks_new_prompts_after_cap_reached", async () => {
		const { registration, harness } = newHarness({ budgetCapUsd: 0.05 });
		registrations.push(registration);
		registration.setResponses([
			() => {
				seedUsage(harness, {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0.04, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.06 },
				});
				return fauxAssistantMessage("ok");
			},
			() => fauxAssistantMessage("three"),
		]);

		// First prompt succeeds; cost crosses the cap in this turn.
		await harness.prompt("one");
		expect(harness.cost().tokens.cost.total, "cost should be >= cap").toBeGreaterThanOrEqual(0.05);

		// Second prompt is rejected at the gate, with a useful message.
		await expect(harness.prompt("two")).rejects.toThrow(/budget cap reached/);

		// Resetting the cost tracker unblocks the next prompt.
		harness.resetCost();
		await expect(harness.prompt("three")).resolves.toMatchObject({ role: "assistant" });
	});

	// GAP (behavior divergence, characterized via `it.fails`): oracle's abort races
	// `stream.next()` against the cancel token and the awaited `harness.prompt()` future
	// RESOLVES TO AN ERR when the underlying stream never completes. TS's `AgentHarness.
	// executeTurn` (agent-harness.ts:1079-1154) instead catches the abort, synthesizes an
	// assistant-role "failure message" with `stopReason: "aborted"` (`createFailureMessage`,
	// agent-harness.ts:568-587), and RESOLVES `prompt()` with that message — it does not reject.
	// The *timing* guarantee oracle's regression test cares about (abort unblocks a stalled
	// stream promptly, not after some multi-second stall) does hold in the base architecture;
	// only the resolve-vs-reject outcome shape differs. Ported with oracle's exact assertions
	// (which currently fail on the `rejects` expectation) so a future fix flips this green.
	it.fails("abort_promptly_unblocks_a_stalled_stream", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			(_context, options) =>
				new Promise<AssistantMessage>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new Error("stream aborted")), { once: true });
				}),
		]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session: new Session(new InMemorySessionStorage()),
			model: registration.getModel(),
		});

		const promptPromise = harness.prompt("hi");
		await new Promise((resolve) => setTimeout(resolve, 50));

		const abortAt = Date.now();
		void harness.abort();

		let outcomeError: unknown;
		try {
			await promptPromise;
		} catch (error) {
			outcomeError = error;
		}
		const elapsed = Date.now() - abortAt;
		expect(elapsed, `abort took ${elapsed}ms — should be near-instant`).toBeLessThan(500);
		expect(outcomeError, "prompt task must reject on abort").toBeInstanceOf(Error);
		expect((outcomeError as Error).message.toLowerCase()).toContain("abort");
	});

	// GAP (behavior divergence, characterized via `it.fails`): reproducing oracle's "deterministic
	// non-zero Usage on every turn" fixture through the public `prompt()` API requires the same
	// `seedUsage`/`seedCost` private-field workaround the budget-cap test above uses (the faux provider
	// every REAL provider-delivered `Usage.cost` is 0 — cost.ts's own doc comment calls the
	// faux/self-filled-`Usage.cost` route "the one still-working path"). But `CostTracker.record()`
	// (cost.ts, a pure sum-only fold, ledger-confirmed bug-free) increments `turnCount` on EVERY
	// call — so seeding the real usage manually AND letting the harness's own
	// `handleAgentEvent`'s "message_end" listener naturally record the same (zero-usage) faux
	// assistant message means `turnCount` ends up double-counted (4, not 2) even though the
	// token/cost SUMS still land correctly (adding a zero-usage record on top doesn't change a
	// sum). There is no way to seed non-zero cost AND keep turnCount accurate at the same time
	// through the public API — a direct testability consequence of the faux provider's zero cost.
	// Ported with oracle's exact assertions (turnCount currently fails; the token/cost sum
	// assertions below it do pass).
	it.fails("cost_tracker_accumulates_across_turns", async () => {
		const { registration, harness } = newHarness();
		registrations.push(registration);
		const usagePerTurn: Usage = {
			input: 25,
			output: 7,
			cacheRead: 3,
			cacheWrite: 0,
			totalTokens: 35,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		};
		registration.setResponses([
			() => {
				seedUsage(harness, usagePerTurn);
				return fauxAssistantMessage("ok");
			},
			() => {
				seedUsage(harness, usagePerTurn);
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.prompt("one");
		await harness.prompt("two");

		const s = harness.cost();
		expect(s.turnCount).toBe(2);
		expect(s.tokens.input).toBe(50);
		expect(s.tokens.output).toBe(14);
		expect(s.tokens.cacheRead).toBe(6);
		expect(s.tokens.totalTokens).toBe(70);
		expect(Math.abs(s.tokens.cost.total - 0.062)).toBeLessThan(1e-9);

		harness.resetCost();
		expect(harness.cost().turnCount).toBe(0);
		expect(harness.cost().tokens.input).toBe(0);
	});

	// GAP (behavior divergence, characterized via `it.fails`): same root cause as
	// `abort_promptly_unblocks_a_stalled_stream` above — `prompt()` resolves with a synthesized
	// `stopReason: "aborted"` assistant message rather than rejecting, AND that failure message
	// DOES get persisted to the session (agent-harness.ts:1030-1041 "message_end" ->
	// `session.appendMessage`, unconditional on the message's `stopReason`/`errorMessage`),
	// unlike oracle where the aborted turn produces zero assistant-role session entries.
	it.fails("abort_cancels_in_flight_prompt", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			(_context, options) =>
				new Promise<AssistantMessage>((resolve, reject) => {
					let settled = false;
					options?.signal?.addEventListener(
						"abort",
						() => {
							if (!settled) {
								settled = true;
								reject(new Error("stream aborted"));
							}
						},
						{ once: true },
					);
					setTimeout(() => {
						if (!settled) {
							settled = true;
							resolve(fauxAssistantMessage("should-not-arrive"));
						}
					}, 400);
				}),
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});

		const promptPromise = harness.prompt("hi");
		await new Promise((resolve) => setTimeout(resolve, 80));
		void harness.abort();

		let outcomeError: unknown;
		try {
			await promptPromise;
		} catch (error) {
			outcomeError = error;
		}
		expect(outcomeError, "aborted prompt should reject").toBeInstanceOf(Error);
		expect((outcomeError as Error).message.toLowerCase()).toContain("abort");

		const entries = await session.getEntries();
		const userCount = entries.filter((e) => e.type === "message" && e.message.role === "user").length;
		expect(userCount, "user message should be persisted").toBe(1);
		const assistantCount = entries.filter((e) => e.type === "message" && e.message.role === "assistant").length;
		expect(assistantCount, "no assistant turn should land on the aborted branch").toBe(0);
	});
});

describe("harness_e2e: harness event bus (isolation/unsub, adapted to handleTrigger)", () => {
	// ADAPTED: oracle drives this via `prompt()`+`move_to()` producing `SessionStart`/`Branch`
	// events on the SAME bus `subscribe_harness` reads. TS's `subscribeHarness` channel carries
	// only trigger-lifecycle events (see the skipped `harness_event_bus_delivers_session_and_branch`
	// test above for the full citation) — `prompt()` alone emits nothing on it. The test's actual
	// intent per its own doc comment ("A panicking listener does not poison the bus") is about the
	// BUS MECHANISM, which agent-harness.ts's `emitHarnessEvent` (agent-harness.ts:1606-1617)
	// explicitly documents as isolating listener exceptions the same way regardless of which event
	// populates the bus — `handleTrigger` is a real, implemented event source on this exact
	// channel, so it is used here instead of `prompt()`/`move_to()`.
	it("harness_event_bus_isolates_panicking_listener (adapted: driven via handleTrigger, not prompt+move_to — see comment)", async () => {
		const { registration, harness } = newHarness();
		registrations.push(registration);
		registration.setResponses([]);

		let received = 0;
		const unsubGood = harness.subscribeHarness(() => {
			received += 1;
		});
		const unsubBad = harness.subscribeHarness(() => {
			throw new Error("isolated");
		});

		await harness.handleTrigger(makeTrigger());
		await harness.handleTrigger(makeTrigger());

		expect(received, "good listener should still receive events past a throwing sibling").toBeGreaterThanOrEqual(2);
		unsubGood();
		unsubBad();
	});

	it("subscribe_harness_unsub_stops_delivery (adapted: driven via handleTrigger, not prompt+move_to — see comment)", async () => {
		const { registration, harness } = newHarness();
		registrations.push(registration);
		registration.setResponses([]);

		let count = 0;
		const unsub = harness.subscribeHarness(() => {
			count += 1;
		});

		await harness.handleTrigger(makeTrigger());
		const before = count;
		expect(before, "listener should have received at least one trigger-lifecycle event").toBeGreaterThan(0);

		unsub();
		await harness.handleTrigger(makeTrigger());
		expect(count, "no events should reach the listener after unsubscribe").toBe(before);
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Group 2 — compaction: pure-function helpers (portable); force_compact/auto-compaction (GAP)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("harness_e2e: compaction — session-context / cut-point pure functions", () => {
	it("build_session_context_skips_trigger_custom_entries", async () => {
		const session = new Session(new InMemorySessionStorage());

		const idUser = await session.appendMessage(userMessage("hello"));
		await session.appendCustomEntry("trigger", { trace_id: "trace-1", source_kind: "Mcp" });
		const idAfter = await session.appendMessage(userMessage("after trigger"));

		// The raw branch must include the trigger Custom entry (audit trail intact).
		const branch = await session.getBranch();
		const triggerPresent = branch.some((e) => e.type === "custom" && e.customType === "trigger");
		expect(triggerPresent, "session.getBranch must still enumerate trigger Custom entries (audit trail)").toBe(true);
		expect(branch).toHaveLength(3);

		// buildSessionContext must NOT translate the trigger Custom into an LLM message.
		const ctx = buildSessionContext(branch);
		expect(ctx.messages, "expected only the two user Message entries in the LLM stream").toHaveLength(2);
		const ids = branch.filter((e) => e.type === "message").map((e) => e.id);
		expect(ids).toEqual([idUser, idAfter]);
	});

	// GAP (already-adjudicated architecture divergence, not a fresh finding): oracle's
	// `find_cut_point` (harness_e2e.rs:899-995) only ever treats USER-role messages as valid cut
	// points ("walk back to nearest preceding user message only", per the migration's own
	// divergence-ledger row for `agent/harness/compaction/compaction`, verdict "applied"). TS's
	// `findValidCutPoints` (compaction.ts:305-342) intentionally includes assistant/bashExecution/
	// custom/branchSummary/compactionSummary role messages too — a prior reviewer explicitly
	// decided NOT to realign this to oracle's simpler algorithm ("left as-is... treated as base's
	// own additive architecture per the session/memory_repo units' precedent for interface-
	// mandated additive capabilities, not a divergence to remove"). Because of this, `findCutPoint`
	// can legitimately land the first-kept index on an ASSISTANT-role message in this exact
	// fixture (verified empirically: it does), unlike oracle which never does. Since this is a
	// prior, already-reviewed decision to keep the divergence rather than an unadjudicated gap,
	// this test is skipped (not `it.fails`) with a citation to that decision rather than treated
	// as new work.
	it.skip('cut_point_anchors_on_user_message_even_around_trigger_custom (GAP: findValidCutPoints intentionally includes assistant-role messages as valid cut points, unlike oracle\'s user-only algorithm — already-adjudicated divergence, divergence-ledger row "agent/harness/compaction/compaction")', () => {
		expect.unreachable();
	});
});

describe("harness_e2e: compaction — force_compact / auto-compaction", () => {
	it("force_compact_writes_reachable_first_kept_entry_id_and_resume_preserves_tail", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ cwd: "/tmp/test-cwd" });
		const sessionMetadata = await session.getMetadata();

		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses(Array(12).fill(fauxAssistantMessage("summary or assistant reply")));

		const harness = new AgentHarness({
			env,
			session,
			model: registration.getModel(),
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
			// pie: harness_e2e.rs:750-754 — a low `keepRecentTokens` forces the cut close to the
			// end of a tiny transcript. GAP fix: this settings override previously had no
			// constructor knob at all (agent-harness.ts's `AgentHarnessTriggerOptions.compaction`).
			compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 4 },
		});

		// Drive three short prompts so we have >=3 user+assistant pairs in the session.
		await harness.prompt("first");
		await harness.prompt("second");
		await harness.prompt("third");

		const entriesBefore = await session.getEntries();
		const preCompactMsgCount = entriesBefore.filter((e) => e.type === "message").length;
		expect(
			preCompactMsgCount,
			`expected at least 3 user+assistant pairs, got ${preCompactMsgCount}`,
		).toBeGreaterThanOrEqual(6);

		// Force compaction. GAP fix: `compact()` used to throw "Nothing to compact" for this
		// fixture under the old hardcoded `keepRecentTokens: 20000` default; with the per-harness
		// override above it now actually runs and resolves `{ ran: true, result }` (a graceful
		// discriminated-union outcome, not a bare result object — see the
		// `force_compact_fallback_when_session_branch_read_fails` test below for the `ran: false`
		// side of the same contract).
		const outcome = await harness.compact();
		expect(outcome.ran, "compact should have produced a summary").toBe(true);
		if (!outcome.ran) throw new Error("unreachable");

		// Verify the persisted Compaction entry's firstKeptEntryId is reachable.
		const entriesAfter = await session.getEntries();
		const compactionEntry = [...entriesAfter].reverse().find((e) => e.type === "compaction");
		expect(compactionEntry, "session should have a Compaction entry").toBeDefined();
		if (!compactionEntry || compactionEntry.type !== "compaction") throw new Error("expected a compaction entry");
		expect(compactionEntry.firstKeptEntryId, "firstKeptEntryId must be set when compaction ran").toBeTruthy();

		const kept = entriesAfter.find((e) => e.id === compactionEntry.firstKeptEntryId);
		expect(kept, "firstKeptEntryId MUST be reachable in the session entries (issue #19 regression)").toBeDefined();
		// Adapted: oracle additionally asserts the kept entry lands specifically on a
		// user-turn-boundary Message. TS's `findValidCutPoints` deliberately treats assistant-role
		// messages as valid cut points too (already-adjudicated divergence — see the
		// `cut_point_anchors_on_user_message_even_around_trigger_custom` skip above,
		// divergence-ledger row "agent/harness/compaction/compaction"), so this fixture's cut can
		// legitimately land on an assistant message. Only "reachable Message entry" — the actual
		// issue #19 regression this test guards — is asserted here, not the role.
		expect(kept?.type, "firstKeptEntryId should point to a Message entry").toBe("message");

		// Snapshot the live session's rebuilt context right after compaction.
		const liveContext = await session.buildContext();

		// Reopen the session from disk (a fresh JsonlSessionStorage instance sharing no
		// in-process state with `session`) and rebuild the context the same way. Adapted: unlike
		// oracle, TS has no separate "live in-memory agent state" distinct from the session — the
		// harness always derives its turn context by rebuilding from real, persisted session
		// entries (createTurnState -> session.buildContext()), so oracle's original bug class (a
		// synthetic first_kept_entry_id that was never actually written to the session jsonl) is
		// structurally already prevented by this architecture. The meaningful adapted regression
		// check is that a COLD reopen of the same jsonl file reconstructs an equally-complete
		// context, not a truncated one.
		const reopened = await repo.open(sessionMetadata);
		const rebuiltBranch = await reopened.getBranch();
		const rebuilt = buildSessionContext(rebuiltBranch);

		expect(
			rebuilt.messages.length,
			`rebuilt context lost messages (live=${liveContext.messages.length}, rebuilt=${rebuilt.messages.length}) — pre-fix regression`,
		).toBeGreaterThanOrEqual(liveContext.messages.length);
		expect(liveContext.messages[0]?.role, "live context must start with the compaction summary").toBe(
			"compactionSummary",
		);
		expect(
			rebuilt.messages[0]?.role,
			"rebuilt (cold-reopen) context must also start with the compaction summary",
		).toBe("compactionSummary");
	});

	// Adapted: asserts the graceful `{ ran: false }` + no-mutation contract oracle's
	// `force_compact` has on a branch-read failure. TS's `HarnessEvent` union (this file's own
	// header comment, agent-harness.ts:59-68) deliberately excludes a `Compaction` diagnostic
	// variant on this architecture — see the `harness_event_bus_delivers_session_and_branch` skip
	// above, an already-adjudicated exclusion — and `./types.ts`'s own event union is off-limits
	// to this task (agent-harness.ts's own header comment), so there is no diagnostic-event
	// channel to assert against; the graceful-false + no-mutation invariant (the actual issue #19
	// acceptance item) is what's ported.
	it("force_compact_fallback_when_session_branch_read_fails", async () => {
		class FailingBranchStorage extends InMemorySessionStorage {
			failBranch = false;
			async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
				if (this.failBranch) throw new SessionError("storage", "simulated branch read failure");
				return super.getPathToRoot(leafId);
			}
		}
		const storage = new FailingBranchStorage();
		const session = new Session(storage);
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses(Array(6).fill(fauxAssistantMessage("would-be summary")));
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
			compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 4 },
		});

		// Drive one normal prompt so we have a non-empty session before failure.
		await harness.prompt("first");
		const preEntries = await storage.getEntries();
		const preContextLen = (await session.buildContext()).messages.length;

		// Arm the failure and force compaction. Must not throw, must resolve `{ ran: false }`.
		storage.failBranch = true;
		const outcome = await harness.compact();
		expect(outcome.ran, "compact() must resolve { ran: false } when session branch read fails, not throw").toBe(
			false,
		);

		// Session must NOT have gained a new Compaction entry.
		const postEntries = await storage.getEntries();
		expect(
			postEntries.length,
			"session must not gain entries when compaction is aborted by branch read failure",
		).toBe(preEntries.length);
		const addedCompaction = postEntries.slice(preEntries.length).some((e) => e.type === "compaction");
		expect(addedCompaction, "no Compaction entry must be appended on branch read failure").toBe(false);

		// Session context must be unchanged (same message count) once reads succeed again.
		storage.failBranch = false;
		const postContextLen = (await session.buildContext()).messages.length;
		expect(postContextLen, "session context must be unchanged when compaction is aborted").toBe(preContextLen);
	});

	it("auto_compaction_bounds_oversized_summary_prompt_before_provider_call", async () => {
		// Simulated provider's context budget: the harness pushes 80 messages of ~1600 chars each
		// (~129KB serialized). `shrinkMessagesForOverflowRetry` halves the message count per retry
		// (80 -> 40 -> 20 -> 10) up to `MAX_SUMMARY_OVERFLOW_RETRIES` (3) retries, so the 10-message
		// attempt (~17.2KB serialized) must be the one that finally fits — chosen with margin below
		// the 20-message attempt (~33.4KB) so every earlier attempt still genuinely overflows and
		// exercises the shrink loop.
		const SUMMARIZER_BUDGET_BYTES = 20_000;
		const session = new Session(new InMemorySessionStorage());
		const registration = registerFauxProvider({ models: [{ id: "faux-1", contextWindow: 5_000 }] });
		registrations.push(registration);

		let sawCompactionDispatch = false;
		let capturedPromptText: string | undefined;
		const responseFactory: FauxResponseFactory = (context) => {
			const isCompaction = context.systemPrompt?.includes("context summarization assistant") ?? false;
			if (!isCompaction) return fauxAssistantMessage("normal assistant reply");
			sawCompactionDispatch = true;
			const first = context.messages[0];
			const content = first && first.role === "user" ? first.content : undefined;
			const text =
				typeof content === "string"
					? content
					: (content ?? [])
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map((block) => block.text)
							.join("");
			// Simulate a real provider's context-overflow rejection until the (reactively
			// shrunk) prompt is small enough. Adapted: oracle's `generate_summary` ALSO
			// proactively trims the summarizer prompt before the FIRST provider call
			// (compaction.rs's `trim_messages_for_summary_budget`/
			// `serialize_conversation_for_summary_budget`); TS's `generateSummary`
			// (compaction.ts) only has the REACTIVE shrink-after-rejection loop
			// (`shrinkMessagesForOverflowRetry`) — a separate, adjacent gap in compaction.ts
			// that is out of scope for gap #6 (the task's constraints forbid touching
			// compaction/ in this unit) and is not "auto-compaction wiring" per se. This test
			// exercises the mechanism TS actually has: it still proves auto-compaction
			// triggers from `prompt()` alone with no explicit `compact()` call (this unit's
			// actual deliverable) and that the existing reactive bounding+disclosure loop
			// keeps the eventually-dispatched prompt within budget — the SAME final
			// assertions oracle makes (bounded size + omission marker), reached via a
			// different, already-existing mechanism.
			if (Buffer.byteLength(text, "utf8") > SUMMARIZER_BUDGET_BYTES) {
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "prompt is too long: 999999 tokens > 5000 maximum",
				});
			}
			capturedPromptText = text;
			return fauxAssistantMessage("bounded compaction summary");
		};
		registration.setResponses(Array.from({ length: 10 }, () => responseFactory));

		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
		});

		for (let i = 0; i < 80; i++) {
			await session.appendMessage(userMessage(`old-msg-${i} ${"x".repeat(1600)}`));
		}

		// No explicit compact() call — auto-compaction must trigger purely from prompt().
		await harness.prompt("next turn");

		expect(sawCompactionDispatch, "oversized context should trigger auto-compaction").toBe(true);
		expect(capturedPromptText, "compaction must eventually succeed within the retry budget").toBeDefined();
		expect(
			Buffer.byteLength(capturedPromptText ?? "", "utf8"),
			"the eventual dispatched summarizer prompt must respect the simulated provider's context budget",
		).toBeLessThanOrEqual(SUMMARIZER_BUDGET_BYTES);
		expect(capturedPromptText, "bounded summary prompt must disclose omitted content").toContain(
			"[compaction note: omitted",
		);
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Group 3 — handle_trigger core (accept/dedup/cycle/persistence-failure), notification hooks,
// before_trigger hooks
// ═════════════════════════════════════════════════════════════════════════════════════════════

async function customEntriesOfType(session: Session, customType: string): Promise<Array<Record<string, unknown>>> {
	const entries = await session.getEntries();
	return entries
		.filter(
			(e): e is Extract<SessionTreeEntry, { type: "custom" }> => e.type === "custom" && e.customType === customType,
		)
		.map((e) => e.data as Record<string, unknown>);
}

describe("harness_e2e: handle_trigger core", () => {
	it("handle_trigger_accept_persists_audit_custom_entry_with_accepted_state", async () => {
		const { registration, session, harness } = newHarness();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("sub agent done")]);

		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		const outcome = await harness.handleTrigger(
			makeTrigger({ idempotency_key: "k-accept", trace_id: "trace-accept" }),
		);
		expect(outcome).toEqual({ type: "accept" });

		const triggerEntries = await customEntriesOfType(session, "trigger");
		expect(triggerEntries, "must persist exactly one trigger audit entry").toHaveLength(1);
		const record = triggerEntries[0]!;
		expect(record.state).toBe("accepted");
		expect(record.idempotency_key).toBe("k-accept");
		expect(record.trace_id).toBe("trace-accept");
		expect((record.evaluator_decision as Record<string, unknown> | undefined)?.outcome).toBe("accept");

		expect(events.some((e) => e.type === "trigger_handling_start" && e.idempotencyKey === "k-accept")).toBe(true);
		const handled = events.find(
			(e): e is Extract<HarnessEvent, { type: "trigger_handled" }> =>
				e.type === "trigger_handled" && e.idempotencyKey === "k-accept",
		);
		expect(handled, "must emit trigger_handled for k-accept").toBeDefined();
		expect(handled?.state).toBe("accepted");
		expect(handled?.auditEntryId, "auditEntryId must be defined on successful write").toBeDefined();
	});

	it("handle_trigger_dedup_emits_deduped_state_and_persists_record", async () => {
		const { registration, session, harness } = newHarness();
		registrations.push(registration);
		registration.setResponses([]);

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-dup", trace_id: "trace-first" }));
		const second = await harness.handleTrigger(makeTrigger({ idempotency_key: "k-dup", trace_id: "trace-second" }));

		expect(second).toMatchObject({ type: "deduped", previousTraceId: "trace-first" });

		const triggerEntries = await customEntriesOfType(session, "trigger");
		const states = triggerEntries.map((r) => r.state);
		expect(states, "must persist both audit entries in order").toEqual(["accepted", "deduped"]);
	});

	it("handle_trigger_cycle_suppression_persists_cycle_suppressed_state", async () => {
		const { registration, session, harness } = newHarness({
			triggerRuntime: { dedupWindowMs: 300_000, cycleHopLimit: 1 },
		});
		registrations.push(registration);
		registration.setResponses([]);

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k1", trace_id: "trace-loop" }));
		// Same trace at limit -> suppressed.
		const suppressed = await harness.handleTrigger(makeTrigger({ idempotency_key: "k2", trace_id: "trace-loop" }));
		expect(suppressed.type).toBe("cycleSuppressed");

		const triggerEntries = await customEntriesOfType(session, "trigger");
		const lastState = triggerEntries[triggerEntries.length - 1]?.state;
		expect(lastState).toBe("cycle_suppressed");
	});

	it("notification_status_snapshot_reflects_trigger_runtime_counters", async () => {
		const { registration, harness } = newHarness();
		registrations.push(registration);
		registration.setResponses([]);

		// Fresh harness: no hooks, zero counters.
		const snap0 = harness.notificationStatusSnapshot();
		expect(snap0.hooks).toEqual([]);
		expect(snap0.runtime.acceptedTotal).toBe(0);
		expect(snap0.runtime.dedupedTotal).toBe(0);
		expect(snap0.runtime.cycleSuppressedTotal).toBe(0);

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k1", trace_id: "trace-1" }));
		await harness.handleTrigger(makeTrigger({ idempotency_key: "k2", trace_id: "trace-2" }));
		await harness.handleTrigger(makeTrigger({ idempotency_key: "k1", trace_id: "trace-3" }));

		const snap1 = harness.notificationStatusSnapshot();
		expect(snap1.runtime.acceptedTotal).toBe(2);
		expect(snap1.runtime.dedupedTotal).toBe(1);
		expect(snap1.runtime.cycleSuppressedTotal).toBe(0);
		expect(snap1.runtime.dedupEntries).toBeGreaterThanOrEqual(2);
	});

	it("handle_trigger_persistence_failure_still_returns_outcome_and_emits_error", async () => {
		class FailingAppendStorage extends InMemorySessionStorage {
			async appendEntry(): Promise<void> {
				throw new Error("synthetic write failure");
			}
		}
		const session = new Session(new FailingAppendStorage());
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([]);
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});

		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		const outcome = await harness.handleTrigger(
			makeTrigger({ idempotency_key: "k-persist-fail", trace_id: "trace-x" }),
		);
		expect(outcome, "evaluator outcome must be authoritative even when audit persistence fails").toEqual({
			type: "accept",
		});

		const sawPersistErr = events.some((e) => e.type === "persistence_error" && e.context === "trigger_audit");
		expect(sawPersistErr, "must emit persistence_error on audit write failure").toBe(true);
		const handled = events.find(
			(e): e is Extract<HarnessEvent, { type: "trigger_handled" }> => e.type === "trigger_handled",
		);
		expect(handled?.auditEntryId, "auditEntryId must be undefined when persistence failed").toBeUndefined();
	});
});

describe("harness_e2e: register_notification_hook", () => {
	it("register_notification_hook_drives_pump_into_handle_trigger", async () => {
		const { registration, session, harness } = newHarness();
		registrations.push(registration);
		registration.setResponses([]);

		const pending: Trigger[] = [
			makeTrigger({ idempotency_key: "hook-k1", trace_id: "hook-trace-1" }),
			makeTrigger({ idempotency_key: "hook-k2", trace_id: "hook-trace-2" }),
			makeTrigger({ idempotency_key: "hook-k1", trace_id: "hook-trace-3" }), // dup of k1
		];

		harness.registerNotificationHook({
			label: () => "mock",
			run: async (sink) => {
				for (const t of pending) sink.push(t);
			},
			status: () => ({
				state: { kind: "connected" },
				last_event_at: null,
				last_ack_at: null,
				last_error: null,
				queued_count: 0,
				dropped_count: 0,
				deduped_count: 0,
				subscription_labels: ["mock"],
				requires_attention: null,
			}),
		});

		const deadline = Date.now() + 5000;
		let snap = harness.notificationStatusSnapshot();
		while (
			snap.runtime.acceptedTotal + snap.runtime.dedupedTotal + snap.runtime.cycleSuppressedTotal < 3 &&
			Date.now() < deadline
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			snap = harness.notificationStatusSnapshot();
		}

		expect(snap.runtime.acceptedTotal).toBe(2);
		expect(snap.runtime.dedupedTotal).toBe(1);
		expect(snap.runtime.cycleSuppressedTotal).toBe(0);
		expect(snap.hooks, "hook must be tracked in snapshot").toHaveLength(1);
		expect(snap.hooks[0]?.subscription_labels).toEqual(["mock"]);

		const triggerAuditCount = (await customEntriesOfType(session, "trigger")).length;
		expect(triggerAuditCount, "3 audit entries: accepted(k1), accepted(k2), deduped(k1 again)").toBe(3);
	});

	it("register_notification_hook_snapshot_reflects_hook_status_state", async () => {
		const { registration, harness } = newHarness();
		registrations.push(registration);
		registration.setResponses([]);

		harness.registerNotificationHook({
			label: () => "degraded",
			run: async () => {},
			status: () => ({
				state: { kind: "disconnected", reason: "transport closed at startup" },
				last_event_at: null,
				last_ack_at: null,
				last_error: "transport closed at startup",
				queued_count: 0,
				dropped_count: 0,
				deduped_count: 0,
				subscription_labels: ["degraded"],
				requires_attention: "degraded: transport closed at startup",
			}),
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		const snap = harness.notificationStatusSnapshot();
		expect(snap.hooks).toHaveLength(1);
		expect(snap.hooks[0]?.state).toMatchObject({ kind: "disconnected" });
		expect(snap.hooks[0]?.requires_attention).toBe("degraded: transport closed at startup");
		expect(snap.runtime.acceptedTotal).toBe(0);
	});
});

describe("harness_e2e: before_trigger hook", () => {
	it("before_trigger_default_allow_keeps_state_accepted", async () => {
		const { registration, session, harness } = newHarness();
		registrations.push(registration);
		registration.setResponses([]);

		await harness.handleTrigger(makeTrigger({ idempotency_key: "perm-default", trace_id: "trace-default" }));

		const entries = await customEntriesOfType(session, "trigger");
		expect(entries[0]?.state, "no hook -> default Allow -> accepted").toBe("accepted");
	});

	it("before_trigger_deny_records_permission_denied_state_and_reason", async () => {
		const { registration, session, harness } = newHarness({
			beforeTrigger: async () => ({ kind: "deny", reason: "principal not on allow-list" }),
		});
		registrations.push(registration);
		registration.setResponses([]);

		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		const outcome = await harness.handleTrigger(
			makeTrigger({ idempotency_key: "perm-deny", trace_id: "trace-deny" }),
		);
		expect(
			outcome,
			"EvaluationOutcome is still accept (evaluator decided to admit); the harness state reflects the deny",
		).toEqual({ type: "accept" });

		const entries = await customEntriesOfType(session, "trigger");
		const record = entries[0]!;
		expect(record.state).toBe("permission_denied");
		const decision = record.evaluator_decision as Record<string, unknown>;
		expect(decision.permission).toBe("deny");
		expect(decision.reason).toBe("principal not on allow-list");

		const handled = events.find(
			(e): e is Extract<HarnessEvent, { type: "trigger_handled" }> =>
				e.type === "trigger_handled" && e.state === "permission_denied",
		);
		expect(handled, "trigger_handled event with permission_denied state must exist").toBeDefined();
		const eventDecision = handled?.evaluatorDecision as Record<string, unknown>;
		expect(eventDecision.permission).toBe("deny");
		expect(eventDecision.reason).toBe("principal not on allow-list");
	});

	it("before_trigger_prompt_records_needs_approval_state_and_reason", async () => {
		const { registration, session, harness } = newHarness({
			beforeTrigger: async () => ({ kind: "prompt", reason: "external trigger from new principal" }),
		});
		registrations.push(registration);
		registration.setResponses([]);

		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "perm-prompt", trace_id: "trace-prompt" }));

		const entries = await session.getEntries();
		const record = (await customEntriesOfType(session, "trigger"))[0]!;
		expect(record.state).toBe("needs_approval");
		expect((record.evaluator_decision as Record<string, unknown>).permission).toBe("prompt");

		const handled = events.find(
			(e): e is Extract<HarnessEvent, { type: "trigger_handled" }> => e.type === "trigger_handled",
		);
		expect(handled?.state, "trigger_handled event must carry the policy-terminal state").toBe("needs_approval");
		const decision = handled?.evaluatorDecision as Record<string, unknown>;
		expect(decision.permission).toBe("prompt");
		expect(decision.reason).toBe("external trigger from new principal");

		const promptEvent = events.find(
			(e): e is Extract<HarnessEvent, { type: "trigger_prompt_request" }> => e.type === "trigger_prompt_request",
		);
		expect(promptEvent, "Prompt decision must emit a trigger prompt request").toBeDefined();
		expect(promptEvent?.request.traceId).toBe("trace-prompt");
		expect(promptEvent?.request.senderAgentId).toBe("mcp:github");
		expect(promptEvent?.request.actionClass).toBe("pr merged");
		expect(
			(promptEvent?.request.payload as Record<string, unknown> | undefined)?.payload,
			"prompt preview must not include raw trigger payload",
		).toBeUndefined();

		const promptAudit = entries.find(
			(e): e is Extract<SessionTreeEntry, { type: "custom" }> =>
				e.type === "custom" && e.customType === "trigger_prompt",
		)?.data as Record<string, unknown> | undefined;
		expect(promptAudit, "trigger_prompt audit entry must be written").toBeDefined();
		expect(promptAudit?.decision).toBe("deny");
		expect(promptAudit?.reason).toBe(
			"trigger prompt required but no onTriggerPrompt hook configured (fail-closed deny — see issue #110 design v0.2)",
		);
		expect(promptAudit?.trigger_prompt_id).toBe(promptEvent?.request.triggerPromptId);
	});

	it("before_trigger_prompt_allow_admits_trigger_and_binds_source_identity", async () => {
		let seenRequest: unknown;
		const { registration, session, harness } = newHarness({
			beforeTrigger: async () => ({ kind: "prompt", reason: "new source sender requires approval" }),
			onTriggerPrompt: async (request: unknown) => {
				seenRequest = request;
				return { kind: "allow" };
			},
		});
		registrations.push(registration);
		registration.setResponses([]);

		const trigger = makeTrigger({
			idempotency_key: "prompt-allow",
			trace_id: "trace-prompt-allow",
			source_kind: "mcp",
			source_label: "external notifier",
			event_label: "notification",
			payload_visibility: "shared",
			payload_summary: "alice sent a notification",
			payload: {
				_meta: {
					receiver_agent_id: "11111111-1111-4111-8111-111111111111",
					sender_agent_id: "22222222-2222-4222-8222-222222222222",
					action_class: "notification",
				},
				secret_body: "this raw payload must stay out of prompt preview",
			},
			authority: {
				principal_id: "22222222-2222-4222-8222-222222222222",
				principal_label: "github",
				credential_scope: "Project",
				allowed_source_actions: ["read"],
				expires_at: undefined,
			},
		});

		const outcome = await harness.handleTrigger(trigger);
		expect(outcome).toEqual({ type: "accept" });

		const request = seenRequest as {
			receiverAgentId?: string;
			senderAgentId: string;
			actionClass: string;
			reason: string;
			payload: unknown;
			triggerPromptId: string;
		};
		expect(request, "onTriggerPrompt hook must receive request").toBeDefined();
		expect(request.receiverAgentId).toBe("11111111-1111-4111-8111-111111111111");
		expect(request.senderAgentId).toBe("22222222-2222-4222-8222-222222222222");
		expect(request.actionClass).toBe("notification");
		expect(request.reason).toBe("new source sender requires approval");
		expect(JSON.stringify(request.payload), "prompt preview must never carry raw trigger payload").not.toContain(
			"secret_body",
		);

		const triggerRecord = (await customEntriesOfType(session, "trigger"))[0]!;
		expect(triggerRecord.state).toBe("accepted");
		const decision = triggerRecord.evaluator_decision as Record<string, unknown>;
		expect(decision.permission).toBe("prompt");
		expect(decision.prompt_decision).toBe("allow");
		expect(decision.trigger_prompt_id).toBe(request.triggerPromptId);

		const entries = await session.getEntries();
		const promptAudit = entries.find(
			(e): e is Extract<SessionTreeEntry, { type: "custom" }> =>
				e.type === "custom" && e.customType === "trigger_prompt",
		)?.data as Record<string, unknown> | undefined;
		expect(promptAudit?.decision).toBe("allow");
		expect(promptAudit?.trigger_prompt_id).toBe(request.triggerPromptId);
		expect(promptAudit?.receiver_agent_id).toBe("11111111-1111-4111-8111-111111111111");
	});

	it("before_trigger_prompt_prefers_meta_binding_over_legacy_top_level_fields", async () => {
		let seenRequest: unknown;
		const { registration, harness } = newHarness({
			beforeTrigger: async () => ({ kind: "prompt", reason: "new source sender requires approval" }),
			onTriggerPrompt: async (request: unknown) => {
				seenRequest = request;
				return { kind: "allow" };
			},
		});
		registrations.push(registration);
		registration.setResponses([]);

		const trigger = makeTrigger({
			idempotency_key: "prompt-meta-precedence",
			trace_id: "trace-meta-precedence",
			payload: {
				receiver_agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				sender_agent_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				action_class: "legacy.notification",
				_meta: {
					receiver_agent_id: "11111111-1111-4111-8111-111111111111",
					sender_agent_id: "22222222-2222-4222-8222-222222222222",
					action_class: "notification",
				},
			},
		});

		await harness.handleTrigger(trigger);

		const request = seenRequest as { receiverAgentId?: string; senderAgentId: string; actionClass: string };
		expect(request, "onTriggerPrompt hook must receive request").toBeDefined();
		expect(request.receiverAgentId).toBe("11111111-1111-4111-8111-111111111111");
		expect(request.senderAgentId).toBe("22222222-2222-4222-8222-222222222222");
		expect(request.actionClass).toBe("notification");
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Part 2 (merged from a parallel worker) — before_trigger prompt edge cases, sub-agent
// spawn/abort/audit, promotion (inject-summary/inject-and-run/promote-summary-now/template
// engine/PromotionCondition), control-plane-write category default, skill hot-reload (GAP).
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("harness_e2e: before_trigger prompt edge cases", () => {
	it("before_trigger_prompt_rejects_untrusted_payload_identity_fields_and_caps_reasons", async () => {
		const session = new Session(new InMemorySessionStorage());
		const registration = registerFauxProvider();
		registrations.push(registration);

		const oversizedPromptReason = `prompt-reason-${"x".repeat(700)}`;
		const oversizedDenyReason = `deny-reason-${"y".repeat(700)}`;
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTrigger: async () => ({ kind: "prompt", reason: oversizedPromptReason }),
			onTriggerPrompt: async () => ({ kind: "deny", reason: oversizedDenyReason }),
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		const trigger = makeTrigger({
			source: { kind: "mcp", server_name: "github", method: "notifications/pr.merged" },
			source_kind: "mcp",
			event_label: "notification",
			payload: {
				_meta: {
					receiver_agent_id: "sk-receiver-secret-token",
					sender_agent_id: "Bearer sender-secret-token",
					action_class: "sk-action-secret-token",
				},
			},
			authority: {
				principal_id: "33333333-3333-4333-8333-333333333333",
				principal_label: "github",
				credential_scope: "Project",
				allowed_source_actions: ["read"],
				expires_at: undefined,
			},
		});
		await harness.handleTrigger(trigger);

		const requestEvent = events.find((e) => e.type === "trigger_prompt_request");
		if (!requestEvent || requestEvent.type !== "trigger_prompt_request")
			throw new Error("expected trigger_prompt_request");
		const request = requestEvent.request;
		expect(request.receiverAgentId).toBeUndefined();
		expect(request.senderAgentId).toBe("33333333-3333-4333-8333-333333333333");
		expect(request.actionClass).toBe("notification");
		expect(Array.from(request.reason).length).toBeLessThanOrEqual(512);
		expect(request.reason.endsWith("…")).toBe(true);
		const requestString = JSON.stringify(request.payload);
		expect(requestString).not.toContain("sk-receiver-secret-token");
		expect(requestString).not.toContain("Bearer sender-secret-token");
		expect(requestString).not.toContain("sk-action-secret-token");

		const entries = await session.getEntries();
		const promptAudit = findCustomEntryData(entries, "trigger_prompt") as Record<string, unknown>;
		expect(promptAudit).toBeDefined();
		expect(promptAudit.receiver_agent_id).toBeNull();
		expect(promptAudit.sender_agent_id).toBe("33333333-3333-4333-8333-333333333333");
		expect(promptAudit.action_class).toBe("notification");
		const auditReason = promptAudit.reason as string;
		expect(Array.from(auditReason).length).toBeLessThanOrEqual(512);
		expect(auditReason.endsWith("…")).toBe(true);
		const auditString = JSON.stringify(promptAudit);
		expect(auditString).not.toContain("sk-receiver-secret-token");
		expect(auditString).not.toContain("Bearer sender-secret-token");
		expect(auditString).not.toContain("sk-action-secret-token");

		const triggerRecordData = findCustomEntryData(entries, TRIGGER_RECORD_CUSTOM_TYPE) as TriggerRecord;
		const decision = triggerRecordData.evaluator_decision as Record<string, unknown>;
		expect(Array.from(decision.reason as string).length).toBeLessThanOrEqual(512);
		expect(Array.from(decision.decision_reason as string).length).toBeLessThanOrEqual(512);
	});

	// GAP fix: oracle's `abort()` is a single global cancellation token that also cancels an
	// in-flight `on_trigger_prompt` hook's `CancellationToken`, letting the hook observe the
	// cancellation and resolve with `TriggerPromptDecision::Timeout`. TS's `AgentHarness.abort()`
	// previously only aborted `this.runAbortController` (set exclusively inside `executeTurn()`'s
	// `prompt()`/`skill()`/`promptFromTemplate()` path) while `resolveTriggerPrompt` invoked
	// `onTriggerPrompt` with a brand-new, disconnected `AbortController` — confirmed empirically to
	// hang past the 30s vitest timeout. Fixed by publishing the hook's `AbortController` to a
	// dedicated `activeHookAbortController` field (mirrors oracle's `active_hook_cancel`) that
	// `abort()` now also cancels — see agent-harness.ts's `resolveTriggerPrompt`/`abort()`.
	it("before_trigger_prompt_abort_cancels_in_flight_prompt_hook", async () => {
		const session = new Session(new InMemorySessionStorage());
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([]);

		let hookStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			hookStarted = resolve;
		});
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTrigger: async () => ({ kind: "prompt", reason: "needs approval" }),
			onTriggerPrompt: async (_request, signal) => {
				hookStarted();
				await new Promise<void>((resolve) => {
					if (signal.aborted) {
						resolve();
						return;
					}
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return { kind: "timeout" };
			},
		});

		const handlePromise = harness.handleTrigger(
			makeTrigger({ idempotency_key: "prompt-abort", trace_id: "trace-prompt-abort" }),
		);
		await started;

		const abortAt = Date.now();
		await harness.abort();
		const outcome = await handlePromise;
		const elapsed = Date.now() - abortAt;
		expect(
			elapsed,
			`abort() should unblock the in-flight onTriggerPrompt hook promptly, took ${elapsed}ms`,
		).toBeLessThan(1000);
		expect(outcome).toEqual({ type: "accept" });

		const entries = await session.getEntries();
		const triggerRecord = findCustomEntryData(entries, TRIGGER_RECORD_CUSTOM_TYPE) as TriggerRecord;
		expect(triggerRecord.state).toBe("needs_approval");
		const decision = triggerRecord.evaluator_decision as Record<string, unknown>;
		expect(decision.prompt_decision).toBe("timeout");

		const promptAudit = findCustomEntryData(entries, "trigger_prompt") as Record<string, unknown>;
		expect(promptAudit.decision).toBe("timeout");
	});

	it("before_trigger_hook_does_not_run_on_deduped_path", async () => {
		const session = new Session(new InMemorySessionStorage());
		const registration = registerFauxProvider();
		registrations.push(registration);
		let callCount = 0;
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTrigger: async () => {
				callCount += 1;
				return { kind: "allow" };
			},
		});

		await harness.handleTrigger(makeTrigger({ idempotency_key: "dup-key" }));
		await harness.handleTrigger(makeTrigger({ idempotency_key: "dup-key" }));

		expect(callCount, "hook must only run after evaluator Accept, never on Deduped/CycleSuppressed paths").toBe(1);
	});
});

describe("harness_e2e: sub-agent execution", () => {
	it("accepted_trigger_spawns_sub_agent_and_writes_trigger_result_audit", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("sub-agent done")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-spawn", trace_id: "trace-spawn" }));

		const completed = await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_completed" && e.traceId === "trace-spawn"),
		);
		expect(completed, "must emit trigger_completed").toBeDefined();

		const entries = await session.getEntries();
		const data = findCustomEntryData(entries, "trigger_result") as Record<string, unknown>;
		expect(data.trace_id).toBe("trace-spawn");
		expect(data.success).toBe(true);
		expect(data.summary).toBe("sub-agent done");
		expect(data.branch_id).toBeNull();
	});

	it("event_ordering_handled_then_started_then_completed", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-order", trace_id: "trace-order" }));
		await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_completed" && e.traceId === "trace-order"),
		);

		const handledIdx = events.findIndex(
			(e) => e.type === "trigger_handled" && e.traceId === "trace-order" && e.state === "accepted",
		);
		const startedIdx = events.findIndex((e) => e.type === "trigger_execution_started" && e.traceId === "trace-order");
		const completedIdx = events.findIndex((e) => e.type === "trigger_completed" && e.traceId === "trace-order");
		expect(handledIdx).toBeGreaterThanOrEqual(0);
		expect(startedIdx).toBeGreaterThanOrEqual(0);
		expect(completedIdx).toBeGreaterThanOrEqual(0);
		expect(handledIdx < startedIdx && startedIdx < completedIdx).toBe(true);
	});

	it("pump_non_blocking_second_trigger_audited_while_first_runs", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let call = 0;
		registration.setResponses([
			async () => {
				const n = call;
				call += 1;
				if (n === 0) await new Promise((resolve) => setTimeout(resolve, 500));
				return fauxAssistantMessage("done");
			},
			async () => {
				const n = call;
				call += 1;
				if (n === 0) await new Promise((resolve) => setTimeout(resolve, 500));
				return fauxAssistantMessage("done");
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

		const t0 = Date.now();
		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-slow", trace_id: "trace-slow" }));
		expect(Date.now() - t0, "handleTrigger must return promptly").toBeLessThan(200);

		const t1 = Date.now();
		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-fast", trace_id: "trace-fast" }));
		expect(Date.now() - t1, "second handleTrigger must not block on first sub-agent").toBeLessThan(200);

		const handled = await waitForEvent(events, 2000, (evs) =>
			evs.find((e) => e.type === "trigger_handled" && e.traceId === "trace-fast"),
		);
		expect(handled, "second trigger must reach trigger_handled within 2s").toBeDefined();
	});

	it("running_snapshot_lists_in_flight_trigger_with_preview", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 500));
				return fauxAssistantMessage("done");
			},
		]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-running", trace_id: "trace-running" }));

		const deadline = Date.now() + 2000;
		let found: ReturnType<AgentHarness["notificationStatusSnapshot"]>["running"][number] | undefined;
		while (Date.now() < deadline) {
			const snap = harness.notificationStatusSnapshot();
			found = snap.running.find((r) => r.traceId === "trace-running");
			if (found) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(found, "running snapshot must include in-flight trigger").toBeDefined();
		expect(found?.sourceLabel).toBe("MCP github");
		expect(found?.eventLabel).toBe("pr merged");
		expect(found?.promptPreview.includes("MCP github") && found?.promptPreview.includes("pr merged")).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 800));
		const snapAfter = harness.notificationStatusSnapshot();
		expect(
			snapAfter.running.every((r) => r.traceId !== "trace-running"),
			"running snapshot must drop completed triggers",
		).toBe(true);
	});

	it("abort_trigger_cancels_in_flight_sub_agent_and_emits_failed", async () => {
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
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-abort", trace_id: "trace-abort" }));
		await waitForEvent(events, 2000, (evs) =>
			evs.find((e) => e.type === "trigger_execution_started" && e.traceId === "trace-abort"),
		);

		harness.abortTrigger("trace-abort");

		const failed = await waitForEvent(events, 3000, (evs) =>
			evs.find((e) => e.type === "trigger_failed" && e.traceId === "trace-abort"),
		);
		if (!failed || failed.type !== "trigger_failed") throw new Error("expected trigger_failed");
		expect(failed.reason).toBe("aborted");

		const entries = await session.getEntries();
		const data = findCustomEntryData(entries, "trigger_result") as Record<string, unknown>;
		expect(data.success).toBe(false);
		expect(data.trace_id).toBe("trace-abort");
	});

	it("non_accepted_states_do_not_spawn_sub_agent", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("done")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-dedup-test", trace_id: "trace-1" }));
		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-dedup-test", trace_id: "trace-2" }));

		await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_completed" && e.traceId === "trace-1"),
		);

		const spawnedForTrace2 = events.some((e) => e.type === "trigger_execution_started" && e.traceId === "trace-2");
		expect(spawnedForTrace2, "Deduped trigger must NOT spawn a sub-agent").toBe(false);
	});

	it("trigger_result_audit_records_failure_reason_for_resume_archaeology", async () => {
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
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-reason", trace_id: "trace-reason" }));
		await waitForEvent(events, 2000, (evs) =>
			evs.find((e) => e.type === "trigger_execution_started" && e.traceId === "trace-reason"),
		);
		harness.abortTrigger("trace-reason");
		await waitForEvent(events, 3000, (evs) =>
			evs.find((e) => e.type === "trigger_failed" && e.traceId === "trace-reason"),
		);

		const entries = await session.getEntries();
		const data = findCustomEntryData(entries, "trigger_result") as Record<string, unknown>;
		expect(data.success).toBe(false);
		expect(data.reason, "trigger_result must persist failure reason so jsonl-only readers see WHY").toBe("aborted");
		expect(data.cost_usd, "5a does not measure cost — null is honest").toBeNull();
	});

	// oracle harness_e2e.rs:2927-3004. 你 is 3 UTF-8 bytes; 1366 copies = 4098 bytes, landing the
	// 4096-byte cap mid-codepoint — pins that `truncateOnCharBoundary`'s summary-truncation call
	// (agent-harness.ts:303-311) is genuinely byte-boundary-safe, not just char-index-safe.
	it("trigger_result_summary_truncation_handles_multibyte_codepoint_via_production_path", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const hugeText = "你".repeat(1366);
		registration.setResponses([() => fauxAssistantMessage(hugeText)]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-utf8-trunc", trace_id: "trace-utf8-trunc" }));
		const completed = await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_completed" && e.traceId === "trace-utf8-trunc"),
		);
		expect(completed, "production path must complete (not panic/throw)").toBeDefined();

		const entries = await session.getEntries();
		const data = findCustomEntryData(entries, "trigger_result") as Record<string, unknown>;
		const summary = data.summary as string;
		expect(typeof summary).toBe("string");
		expect(summary.endsWith("…[truncated]")).toBe(true);
		expect(
			Buffer.byteLength(summary, "utf8"),
			"final summary (incl. marker) must respect 4 KiB cap",
		).toBeLessThanOrEqual(4096);
		const bodyOnly = summary.slice(0, summary.length - "…[truncated]".length);
		expect(
			Array.from(bodyOnly).every((c) => c === "你"),
			"truncation MUST land on a codepoint boundary",
		).toBe(true);
	});
});

describe("harness_e2e: promotion", () => {
	it("no_promote_action_leaves_parent_transcript_stable", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-no-promote", trace_id: "trace-no-promote" }));
		await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_completed" && e.traceId === "trace-no-promote"),
		);

		const entries = await session.getEntries();
		expect(hasAnyMessageEntry(entries), "no promote -> parent transcript MUST be empty of Message entries").toBe(
			false,
		);
		expect(entries.some((e) => e.type === "custom" && e.customType === "trigger_promotion")).toBe(false);
		expect(events.some((e) => e.type === "trigger_promoted")).toBe(false);
		expect(events.some((e) => e.type === "promotion_pending")).toBe(false);
	});

	it("inject_summary_skips_subagent_and_injects_payload_summary", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("SUBAGENT RAN — must not appear")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "",
			promote: { kind: "promote_summary_now", templateBody: "{{trigger.payload_summary}}" },
			promoteRequiresApproval: false,
			delivery: "inject_summary",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-inject", trace_id: "trace-inject" }));

		const promoted = await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_promoted" && e.traceId === "trace-inject"),
		);
		if (!promoted || promoted.type !== "trigger_promoted") throw new Error("inject must promote");

		const entries = await session.getEntries();
		const body = userMessageTextById(entries, promoted.insertedEntryId);
		expect(body, "inject must insert a parent user message").toBeDefined();
		expect(body?.startsWith("[Trigger ")).toBe(true);
		expect(body).toContain("PR #42 merged");
		expect(body).not.toContain("SUBAGENT RAN");

		const resultData = findCustomEntryData(entries, "trigger_result") as Record<string, unknown>;
		expect(resultData.message_count).toBe(0);
		expect(resultData.delivery).toBe("inject_summary");
		expect(resultData.cost_usd).toBe(0);
	});

	it("inject_summary_without_payload_summary_promotes_nothing", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("unused")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "",
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
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(
			makeTrigger({ idempotency_key: "k-inject-none", trace_id: "trace-inject-none", payload_summary: undefined }),
		);
		await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_completed" && e.traceId === "trace-inject-none"),
		);

		const entries = await session.getEntries();
		expect(hasAnyMessageEntry(entries), "no summary -> nothing injected").toBe(false);
		expect(entries.some((e) => e.type === "custom" && e.customType === "trigger_promotion")).toBe(false);
		expect(events.some((e) => e.type === "trigger_promoted")).toBe(false);
	});

	it("inject_and_run_idle_appends_prompt_and_requests_main_run", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("MODEL RAN — must not appear")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "check if I need an umbrella",
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

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-iar", trace_id: "trace-iar" }));
		await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_requests_main_run" && e.traceId === "trace-iar"),
		);

		const entries = await session.getEntries();
		const texts = anyUserMessageText(entries);
		const body = texts.find((t) => t.includes("check if I need an umbrella"));
		expect(body, "must insert prompt into parent conversation").toBeDefined();
		expect(body?.startsWith("[Trigger ")).toBe(true);
	});

	it("inject_and_run_while_streaming_enqueues_follow_up_no_main_run_event", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let releaseParent: (() => void) | undefined;
		const parentReleased = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});
		let n = 0;
		registration.setResponses([
			async () => {
				const isFirst = n === 0;
				n += 1;
				if (isFirst) await parentReleased;
				return fauxAssistantMessage("resp");
			},
			async () => fauxAssistantMessage("resp"),
			async () => fauxAssistantMessage("resp"),
		]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "react to the event",
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

		// pie: matches the established busy-detection idiom in test/harness/agent-harness.test.ts
		// ("handleTrigger: inject_and_run delivery on a BUSY harness enqueues a follow-up..."):
		// `phase` flips to "turn" synchronously at the very start of `prompt()`, before the first
		// await point, so a single microtask tick is enough to observe "busy" — no need to wait for
		// the (possibly-blocked) model round trip to actually emit a message_start event.
		const parentPromise = harness.prompt("kick off parent");
		await new Promise((resolve) => setTimeout(resolve, 0));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-iar-s", trace_id: "trace-iar-s" }));
		await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_completed" && e.traceId === "trace-iar-s"),
		);

		expect(
			events.some((e) => e.type === "trigger_requests_main_run" && e.traceId === "trace-iar-s"),
			"streaming parent already has a loop — must not emit trigger_requests_main_run",
		).toBe(false);

		const entries = await session.getEntries();
		const audit = findCustomEntryData(entries, "trigger_result") as Record<string, unknown>;
		expect(audit.delivery).toBe("inject_and_run");
		expect(audit.run_dispatch).toBe("follow_up");

		releaseParent?.();
		await parentPromise;
	});

	it("promote_summary_now_inserts_audited_parent_entry", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("sub agent reports OK")]);
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
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-promote-ok", trace_id: "trace-promote-ok" }));
		const promoted = await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_promoted" && e.traceId === "trace-promote-ok"),
		);
		if (!promoted || promoted.type !== "trigger_promoted") throw new Error("trigger_promoted must fire");
		expect(promoted.redactionStatus).toBe("clean");
		expect(promoted.templateName).toBe("default");

		const entries = await session.getEntries();
		const body = userMessageTextById(entries, promoted.insertedEntryId);
		expect(body).toContain("[Trigger trace-promote-ok]");
		expect(body).toContain("sub agent reports OK");

		const audit = findCustomEntryData(entries, "trigger_promotion") as Record<string, unknown>;
		expect(audit.state).toBe("success");
		expect(audit.trace_id).toBe("trace-promote-ok");
		expect(audit.inserted_entry_id).toBe(promoted.insertedEntryId);
		expect(audit.redaction_status).toBe("clean");
	});

	it("promote_template_unknown_var_fails_closed", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("sub ok")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "investigate",
			promote: { kind: "promote_summary_now", templateBody: "Hello {{nonexistent_field}}" },
			promoteRequiresApproval: false,
			delivery: "sub_agent",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-unknown", trace_id: "trace-unknown" }));
		const err = await waitForEvent(events, 5000, (evs) =>
			evs.find(
				(e) =>
					e.type === "persistence_error" &&
					e.context === "trigger_promotion" &&
					e.message.includes("nonexistent_field"),
			),
		);
		expect(err, "PersistenceError with unknown_field reason").toBeDefined();

		const entries = await session.getEntries();
		expect(hasAnyMessageEntry(entries), "render error -> parent transcript unchanged").toBe(false);
		const audit = findCustomEntryData(entries, "trigger_promotion") as Record<string, unknown>;
		expect(audit.state).toBe("failed");
		expect(audit.redaction_status).toBe("render_error");
		expect(audit.inserted_entry_id).toBeNull();
	});

	it("promote_template_forbidden_field_fails_closed", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "investigate",
			promote: { kind: "promote_summary_now", templateBody: "Leaking {{trigger.payload}}" },
			promoteRequiresApproval: false,
			delivery: "sub_agent",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-forbid", trace_id: "trace-forbid" }));
		const err = await waitForEvent(events, 5000, (evs) =>
			evs.find(
				(e) =>
					e.type === "persistence_error" &&
					e.context === "trigger_promotion" &&
					e.message.includes("trigger.payload"),
			),
		);
		expect(err, "PersistenceError with forbidden_field reason").toBeDefined();

		const entries = await session.getEntries();
		expect(hasAnyMessageEntry(entries)).toBe(false);
		const audit = findCustomEntryData(entries, "trigger_promotion") as Record<string, unknown>;
		expect(audit.state).toBe("failed");
		expect(audit.redaction_status).toBe("forbidden_field");
	});

	it("promote_requires_approval_fails_closed_to_pending", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "investigate",
			promote: { kind: "promote_summary_now" },
			promoteRequiresApproval: true,
			delivery: "sub_agent",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-pending", trace_id: "trace-pending" }));
		const pending = await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "promotion_pending" && e.traceId === "trace-pending"),
		);
		if (!pending || pending.type !== "promotion_pending") throw new Error("promotion_pending must fire");
		expect(pending.preview).toContain("[Trigger trace-pending]");

		const entries = await session.getEntries();
		expect(
			hasAnyMessageEntry(entries),
			"promoteRequiresApproval=true must NOT insert into parent transcript without explicit approval",
		).toBe(false);
		const audit = findCustomEntryData(entries, "trigger_promotion") as Record<string, unknown>;
		expect(audit.state).toBe("pending");
		expect(audit.inserted_entry_id).toBeNull();
		expect(events.some((e) => e.type === "trigger_promoted" && e.traceId === "trace-pending")).toBe(false);
	});

	it("promote_summary_truncation_records_redaction_status", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const hugeText = "X".repeat(6 * 1024);
		registration.setResponses([() => fauxAssistantMessage(hugeText)]);
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
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-trunc", trace_id: "trace-trunc" }));
		const promoted = await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_promoted" && e.traceId === "trace-trunc"),
		);
		if (!promoted || promoted.type !== "trigger_promoted") throw new Error("trigger_promoted must fire");
		expect(promoted.redactionStatus).toBe("truncated");

		const entries = await session.getEntries();
		const body = userMessageTextById(entries, promoted.insertedEntryId);
		expect(body?.endsWith("…[truncated]")).toBe(true);
		const audit = findCustomEntryData(entries, "trigger_promotion") as Record<string, unknown>;
		expect(audit.redaction_status).toBe("truncated");
	});

	it("promote_inline_template_body_is_not_persisted_as_template_name", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("subagent text")]);
		const session = new Session(new InMemorySessionStorage());
		const inlineBody = "Custom RFC4-style prompt: {{trigger.source_label}} → {{result.summary}}";
		const action: TriggerAction = {
			prompt: "investigate",
			promote: { kind: "promote_summary_now", templateBody: inlineBody },
			promoteRequiresApproval: false,
			delivery: "sub_agent",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-inline-name", trace_id: "trace-inline-name" }));
		const promoted = await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_promoted" && e.traceId === "trace-inline-name"),
		);
		if (!promoted || promoted.type !== "trigger_promoted") throw new Error("trigger_promoted must fire");
		const name = promoted.templateName;
		if (!name) throw new Error("templateName must be defined");
		expect(name.startsWith("inline:")).toBe(true);
		expect(name.length).toBe("inline:".length + 8);
		expect(name).not.toContain(inlineBody);

		const entries = await session.getEntries();
		const audit = findCustomEntryData(entries, "trigger_promotion") as Record<string, unknown>;
		expect(audit.template_name).toBe(name);
		const templateHash = audit.template_hash as string;
		expect(templateHash.length).toBe(64);
		expect(JSON.stringify(audit)).not.toContain(inlineBody);
	});

	it("promote_summary_now_custom_template_without_prefix_still_gets_injected", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("subagent text")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "investigate",
			promote: {
				kind: "promote_summary_now",
				templateBody: "Bare update from {{trigger.source_label}}: {{result.summary}}",
			},
			promoteRequiresApproval: false,
			delivery: "sub_agent",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-prefix-inj", trace_id: "trace-prefix-inj" }));
		const promoted = await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_promoted" && e.traceId === "trace-prefix-inj"),
		);
		if (!promoted || promoted.type !== "trigger_promoted") throw new Error("trigger_promoted must fire");

		const entries = await session.getEntries();
		const body = userMessageTextById(entries, promoted.insertedEntryId);
		expect(body?.startsWith("[Trigger trace-prefix-inj] ")).toBe(true);
		expect(body).toContain("Bare update from MCP github");
		expect(body?.startsWith("[Trigger trace-prefix-inj] [Trigger")).toBe(false);

		const audit = findCustomEntryData(entries, "trigger_promotion") as Record<string, unknown>;
		expect(audit.prefix_injected).toBe(true);
	});

	it("promote_default_template_does_not_get_double_prefixed", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
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
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-default-pfx", trace_id: "trace-default-pfx" }));
		await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_promoted" && e.traceId === "trace-default-pfx"),
		);

		const entries = await session.getEntries();
		const audit = findCustomEntryData(entries, "trigger_promotion") as Record<string, unknown>;
		expect(audit.prefix_injected).toBe(false);
		const body = anyUserMessageText(entries).find((t) => t.includes("[Trigger trace-default-pfx]"));
		if (!body) throw new Error("expected inserted user message");
		const occurrences = body.split("[Trigger trace-default-pfx]").length - 1;
		expect(occurrences).toBe(1);
	});

	it("promote_template_with_stale_trigger_prefix_still_gets_real_trace_id_prepended", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("ok")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "investigate",
			promote: {
				kind: "promote_summary_now",
				templateBody: "[Trigger evil-trace-id] spoofed body for {{result.summary}}",
			},
			promoteRequiresApproval: false,
			delivery: "sub_agent",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-stale-prefix", trace_id: "trace-real" }));
		const promoted = await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_promoted" && e.traceId === "trace-real"),
		);
		if (!promoted || promoted.type !== "trigger_promoted") throw new Error("trigger_promoted must fire");

		const entries = await session.getEntries();
		const body = userMessageTextById(entries, promoted.insertedEntryId);
		expect(body?.startsWith("[Trigger trace-real] ")).toBe(true);
		expect(body).toContain("[Trigger evil-trace-id]");
		const audit = findCustomEntryData(entries, "trigger_promotion") as Record<string, unknown>;
		expect(audit.prefix_injected).toBe(true);
	});

	it("promote_summary_truncation_final_length_includes_marker_under_cap", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const hugeText = "X".repeat(10 * 1024);
		registration.setResponses([() => fauxAssistantMessage(hugeText)]);
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
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-cap-final", trace_id: "trace-cap-final" }));
		const promoted = await waitForEvent(events, 5000, (evs) =>
			evs.find(
				(e) =>
					e.type === "trigger_promoted" && e.traceId === "trace-cap-final" && e.redactionStatus === "truncated",
			),
		);
		if (!promoted || promoted.type !== "trigger_promoted") throw new Error("trigger_promoted (truncated) must fire");

		const entries = await session.getEntries();
		const body = userMessageTextById(entries, promoted.insertedEntryId);
		expect(body?.endsWith("…[truncated]")).toBe(true);
		expect(Buffer.byteLength(body ?? "", "utf8")).toBeLessThanOrEqual(4096);

		const resultData = findCustomEntryData(entries, "trigger_result") as Record<string, unknown>;
		const summary = resultData.summary as string;
		expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(4096);
	});

	// GAP fix: `promotion_condition_any_of_returns_intersection_on_match` (oracle
	// harness_e2e.rs:4238-4258) unit-tests `PromotionCondition::evaluate` directly as a pure
	// function on a MATCHING `details` payload — never through `handleTrigger`/`applyPromotion`
	// (both of whose call sites still always pass `details: undefined`, per the `// pie:` comment
	// at agent-harness.ts's `runInjectSummaryDelivery`/`runSubAgentDelivery` — a separate,
	// unrelated fact from this test's reachability). `evaluatePromotionCondition` was
	// module-private, so there was no way to import and call it directly the way oracle's test
	// does. Fixed by exporting it (agent-harness.ts) — this test now calls it exactly like
	// oracle's `PromotionCondition::evaluate(&details)`, independent of `applyPromotion`.
	it("promotion_condition_any_of_returns_intersection_on_match", () => {
		const details = {
			dynamic_trigger: {
				matched_rule_ids: ["dyn-keep-a", "dyn-keep-b", "dyn-other"],
			},
		};
		const condition: PromotionCondition = {
			jsonPointer: "/dynamic_trigger/matched_rule_ids",
			anyOf: ["dyn-keep-a", "dyn-not-present"],
		};

		const result = evaluatePromotionCondition(condition, details);
		expect(result, "should match").toEqual({ ok: true, matched: ["dyn-keep-a"] });
	});

	it("promotion_condition_any_of_fails_closed_when_pointer_missing", async () => {
		// Adapted: oracle unit-tests PromotionCondition::evaluate directly; TS's equivalent is
		// private (see skip comment above), so this drives the same "pointer missing" outcome
		// through the public handleTrigger -> applyPromotion path, where `details` is always
		// undefined -> naturally exercises the PointerMissing branch.
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("dyn-a mentioned but irrelevant")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "investigate",
			promote: {
				kind: "promote_summary_when_result_details_match",
				condition: { jsonPointer: "/dynamic_trigger/matched_rule_ids", anyOf: ["dyn-a"] },
			},
			promoteRequiresApproval: false,
			delivery: "sub_agent",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-ptr-missing", trace_id: "trace-ptr-missing" }));
		await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_completed" && e.traceId === "trace-ptr-missing"),
		);

		const entries = await session.getEntries();
		const audit = findCustomEntryData(entries, "trigger_promotion") as Record<string, unknown>;
		expect(audit.state).toBe("skipped");
		expect(audit.reason, 'PromotionConditionSkipReason::PointerMissing -> "result_details_missing"').toBe(
			"result_details_missing",
		);
	});

	// GAP fix: same root cause as `promotion_condition_any_of_returns_intersection_on_match` above
	// — now reachable via the exported `evaluatePromotionCondition`.
	it("promotion_condition_any_of_fails_closed_when_value_not_array", () => {
		const details = { dynamic_trigger: { matched_rule_ids: "dyn-a" } };
		const condition: PromotionCondition = {
			jsonPointer: "/dynamic_trigger/matched_rule_ids",
			anyOf: ["dyn-a"],
		};
		// Even if the scalar value would substring-match, it MUST NOT promote — contract is
		// "value is an array of IDs that intersect any_of," not free-form text matching.
		const result = evaluatePromotionCondition(condition, details);
		expect(result).toEqual({ ok: false, reason: "result_details_not_array" });
	});

	// GAP fix: same root cause — now reachable via the exported `evaluatePromotionCondition`.
	it("promotion_condition_any_of_fails_closed_when_empty_intersection", () => {
		const details = {
			dynamic_trigger: {
				matched_rule_ids: ["dyn-other-a", "dyn-other-b"],
			},
		};
		const condition: PromotionCondition = {
			jsonPointer: "/dynamic_trigger/matched_rule_ids",
			anyOf: ["dyn-keep"],
		};
		const result = evaluatePromotionCondition(condition, details);
		expect(result).toEqual({ ok: false, reason: "no_matching_rule_id" });
	});

	it("promote_when_result_details_match_does_not_consult_summary", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([() => fauxAssistantMessage("matched dyn-promote-me explicitly")]);
		const session = new Session(new InMemorySessionStorage());
		const action: TriggerAction = {
			prompt: "investigate",
			promote: {
				kind: "promote_summary_when_result_details_match",
				condition: { jsonPointer: "/dynamic_trigger/matched_rule_ids", anyOf: ["dyn-promote-me"] },
			},
			promoteRequiresApproval: false,
			delivery: "sub_agent",
		};
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd: process.cwd() }),
			session,
			model: registration.getModel(),
			beforeTriggerAction: async () => action,
		});
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-struct", trace_id: "trace-struct" }));
		await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_completed" && e.traceId === "trace-struct"),
		);

		const entries = await session.getEntries();
		expect(hasAnyMessageEntry(entries), "summary substring is not an authorization channel").toBe(false);

		const skipped = findCustomEntryData(entries, "trigger_promotion") as Record<string, unknown>;
		expect(skipped.state).toBe("skipped");
		expect(skipped.reason).toBe("result_details_missing");
		expect(skipped.promote_kind).toBe("promote_summary_when_result_details_match");

		const completed = events.find((e) => e.type === "trigger_completed" && e.traceId === "trace-struct");
		if (!completed || completed.type !== "trigger_completed") throw new Error("expected trigger_completed");
		expect(completed.details, "details defaults to null until a marker tool writes through the builder").toBeNull();
	});

	it("promote_while_parent_is_streaming_routes_through_follow_up_single_write", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		let releaseParent: (() => void) | undefined;
		const parentReleased = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});
		let n = 0;
		registration.setResponses([
			async () => {
				const isFirst = n === 0;
				n += 1;
				if (isFirst) await parentReleased;
				return fauxAssistantMessage(isFirst ? "parent response" : "auxiliary response");
			},
			async () => fauxAssistantMessage("auxiliary response"),
			async () => fauxAssistantMessage("auxiliary response"),
		]);
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
		const events: HarnessEvent[] = [];
		harness.subscribeHarness((event) => events.push(event));

		// pie: same busy-detection idiom as inject_and_run_while_streaming above.
		const parentPromise = harness.prompt("kick off parent");
		await new Promise((resolve) => setTimeout(resolve, 0));

		await harness.handleTrigger(makeTrigger({ idempotency_key: "k-streaming", trace_id: "trace-streaming" }));
		await waitForEvent(events, 5000, (evs) =>
			evs.find((e) => e.type === "trigger_promoted" && e.traceId === "trace-streaming"),
		);

		const midEntries = await session.getEntries();
		const midAudit = findCustomEntryData(midEntries, "trigger_promotion") as Record<string, unknown>;
		expect(midAudit.state, "streaming-branch promotion audit must report state=queued").toBe("queued");
		expect(midAudit.inserted_entry_id).toBeNull();
		expect(anyUserMessageText(midEntries)).toHaveLength(1);

		releaseParent?.();
		await parentPromise;
		await new Promise((resolve) => setTimeout(resolve, 50));

		const finalEntries = await session.getEntries();
		const userTexts = anyUserMessageText(finalEntries);
		expect(userTexts, "single persistence path: exactly 2 user messages (initial + promoted)").toHaveLength(2);

		const positions: Array<[number, "assistant" | "promoted"]> = [];
		finalEntries.forEach((e, idx) => {
			if (e.type !== "message") return;
			if (e.message.role === "assistant") positions.push([idx, "assistant"]);
			if (e.message.role === "user") {
				const content = e.message.content;
				const text =
					typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : "")).join("");
				if (text.startsWith("[Trigger ")) positions.push([idx, "promoted"]);
			}
		});
		const assistantIdx = positions.find(([, k]) => k === "assistant")?.[0];
		const promotedIdx = positions.find(([, k]) => k === "promoted")?.[0];
		expect(assistantIdx).toBeDefined();
		expect(promotedIdx).toBeDefined();
		expect(
			(promotedIdx as number) > (assistantIdx as number),
			"promoted user message MUST come AFTER the in-flight assistant response",
		).toBe(true);
	});
});

describe("harness_e2e: control-plane write category", () => {
	it("control_plane_write_category_defaults_to_allow_at_runtime_layer", () => {
		const policy = PermissionPolicy.defaultForCodingAgent();
		const args = { command: "rm -rf /tmp/foo" };
		// Even with bash-tool name + a normally-dangerous arg, controlPlaneWrite falls through
		// to Allow because the runtime policy has no category-specific classifier wired.
		expect(policy.evaluateWithCategory("controlPlaneWrite", "bash", args)).toEqual({ type: "allow" });
		// Sanity check the legacy `evaluate` still uses the Tool category (bash classifier).
		expect(policy.evaluate("bash", args).type).toBe("deny");
	});
});

// pie: harness_e2e.rs:4692-4941 (skill catalog hot-reload block; issue #87 sub-PR A).
// `AgentHarness.reloadSkillsFromDisk()` wires the embedder-supplied `reloadSkillsFn` closure
// (`AgentHarnessTriggerOptions.reloadSkillsFn`), replaces `resources.skills`, rebuilds the
// `<skills>` block behind `getSystemPrompt()`, and emits `HarnessEvent.SkillsReloaded` on the
// `subscribeHarness` channel.
describe("harness_e2e: skill catalog hot-reload", () => {
	it("reload_skills_from_disk_invokes_loader_and_replaces_catalog", async () => {
		let callCount = 0;
		const { registration, harness } = newHarness({
			systemPrompt: "",
			resources: {
				skills: [
					{
						name: "original",
						content: "original body",
						description: "the skill we ship with",
						filePath: "/tmp/original",
					},
				],
			},
			reloadSkillsFn: async () => {
				callCount += 1;
				return {
					skills: [
						{
							name: "fresh-one",
							content: "after install",
							description: "newly installed",
							filePath: "/tmp/fresh-one",
						},
						{
							name: "fresh-two",
							content: "second new",
							description: "also newly installed",
							filePath: "/tmp/fresh-two",
						},
					],
					diagnostics: [],
				};
			},
		});
		registrations.push(registration);

		const before = harness.getResources().skills ?? [];
		expect(before).toHaveLength(1);
		expect(before[0]?.name).toBe("original");

		const result = await harness.reloadSkillsFromDisk();
		expect(result.skills).toHaveLength(2);
		expect(callCount, "loader called once").toBe(1);

		const after = harness.getResources().skills ?? [];
		expect(after).toHaveLength(2);
		expect(after.some((s) => s.name === "fresh-one")).toBe(true);
		expect(after.some((s) => s.name === "fresh-two")).toBe(true);
		expect(
			after.every((s) => s.name !== "original"),
			"old skill must be gone — single source of truth is the loader",
		).toBe(true);

		const prompt = harness.getSystemPrompt();
		expect(
			prompt.includes("fresh-one") && prompt.includes("fresh-two"),
			`system prompt must rebuild with new <skills> block; got: ${prompt}`,
		).toBe(true);
		expect(
			prompt.includes("the skill we ship with"),
			`original skill description must not leak into rebuilt prompt: ${prompt}`,
		).toBe(false);
	});

	it("reload_skills_from_disk_emits_skills_reloaded_event", async () => {
		const { registration, harness } = newHarness({
			reloadSkillsFn: async () => ({
				skills: [
					{
						name: "fresh-one",
						content: "after install",
						description: "newly installed",
						filePath: "/tmp/fresh-one",
					},
				],
				diagnostics: [],
			}),
		});
		registrations.push(registration);

		const received: HarnessEvent[] = [];
		const unsubscribe = harness.subscribeHarness((event) => received.push(event));

		await harness.reloadSkillsFromDisk();
		unsubscribe();

		expect(
			received.some((e) => e.type === "skills_reloaded" && e.total === 1),
			`reload must emit skills_reloaded with the new catalog size; got ${received.length} event(s)`,
		).toBe(true);
	});

	it("reload_skills_from_disk_propagates_loader_diagnostics", async () => {
		const { registration, harness } = newHarness({
			reloadSkillsFn: async () => ({
				skills: [{ name: "good", content: "ok", description: "valid skill", filePath: "/tmp/good" }],
				diagnostics: [
					{ type: "warning", code: "parse_failed", message: "frontmatter malformed", path: "/tmp/bad/SKILL.md" },
				],
			}),
		});
		registrations.push(registration);

		const result = await harness.reloadSkillsFromDisk();

		expect(result.skills).toHaveLength(1);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.message).toContain("frontmatter malformed");
		expect(harness.getResources().skills).toHaveLength(1);
	});

	it("reload_skills_from_disk_without_loader_errors_with_not_configured", async () => {
		const { registration, harness } = newHarness();
		registrations.push(registration);

		await expect(harness.reloadSkillsFromDisk()).rejects.toThrow(/not configured/i);
	});

	// TS has no persistent `state.messages`/`is_streaming` fields to assert against directly (per-
	// turn state is rebuilt fresh from `session.buildContext()` on every `prompt()` call, see
	// `createTurnState()`) — adapted to the closest TS-observable equivalents: persisted session
	// entries must be untouched by reload, and the harness must still be idle/usable for a normal
	// turn right after (would throw "AgentHarness is busy" if reload left internal loop state,
	// i.e. `this.phase`, in a non-idle state).
	it("reload_skills_from_disk_preserves_message_state_and_streaming_flag", async () => {
		const { registration, session, harness } = newHarness({
			reloadSkillsFn: async () => ({
				skills: [{ name: "reloaded", content: "fresh", description: "post-reload", filePath: "/tmp/reloaded" }],
				diagnostics: [],
			}),
		});
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("ok")]);

		await harness.prompt("hello");
		const preEntries = await session.getEntries();
		expect(preEntries.length).toBeGreaterThan(0);

		const result = await harness.reloadSkillsFromDisk();
		expect(result.skills).toHaveLength(1);

		const postEntries = await session.getEntries();
		expect(postEntries, "reload must not touch persisted session entries").toHaveLength(preEntries.length);

		registration.setResponses([fauxAssistantMessage("ok again")]);
		await expect(harness.prompt("again")).resolves.toBeDefined();
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Group 8 — control_plane_prompt / on_turn_end_hook / run_evaluator (ALL confirmed GAP)
// ═════════════════════════════════════════════════════════════════════════════════════════════

// GAP: Issue #110 "ControlPlaneWrite user-Prompt gate" (design v0.2) — same root gap as the 8
// skipped tests in test/ported/agent-loop.test.ts (see that file's header comment for the full
// grep-confirmed citation: no `PermissionClassification`, `OnControlPlanePromptHook`,
// `ControlPlanePromptDecision`, `ControlPlanePromptRequest`, `BeforeToolCallResult.prompt`, or
// `AgentEvent.ControlPlanePromptResolved` anywhere in packages/agent/src).
//
// PARTIALLY CLOSED (phase 13 wiring): `AgentHarness` DOES now take an `onControlPlanePrompt`
// constructor option and forwards it into `createLoopConfig` (agent-harness.ts, pie:
// agent_harness.rs:818-826), so prompt-classified tools are no longer unconditionally
// fail-closed inside a harness turn. What these four tests assert is the OTHER half — the
// harness-side "control_plane_prompt" AUDIT entry (oracle writes one per resolution, with the
// capped label and the decision string) — and that half is still unported: grep-confirmed zero
// `appendCustomEntry("control_plane_prompt", ...)` in agent-harness.ts.
// TODO(port): un-skip together with the audit-write path.
describe("harness_e2e: control_plane_prompt (GAP: issue #110, see agent-loop.test.ts header)", () => {
	it.skip("control_plane_prompt_allow_writes_audit_entry", () => {
		expect.unreachable();
	});
	it.skip("control_plane_prompt_deny_writes_audit_with_reason", () => {
		expect.unreachable();
	});
	it.skip("control_plane_prompt_no_hook_writes_audit_with_failclosed_deny", () => {
		expect.unreachable();
	});
	it.skip("control_plane_prompt_audit_caps_oversized_label", () => {
		expect.unreachable();
	});
});

// GAP: oracle's `OnTurnEndHook`/`continue_()`/turn-continuation loop has no TS counterpart.
// agent-harness.ts's own doc comment on `checkBudgetCap` (agent_harness ledger row 22 and the
// method's own comment, agent-harness.ts:1169-1173) explicitly flags this: "Base's architecture
// has no `continue_()` / `OnTurnEndHook` continuation loop to port onto — out of scope for this
// unit... a future unit adding continuation support must call `checkBudgetCap()` at its own cycle
// boundary." Grep-confirmed zero occurrences of "onTurnEnd"/"OnTurnEnd"/"turnEndHook" anywhere in
// agent-harness.ts or types.ts.
describe("harness_e2e: on_turn_end_hook (GAP: no continuation-loop concept in TS AgentHarness)", () => {
	it.skip("on_turn_end_hook_unset_keeps_legacy_single_cycle_behavior", () => {
		expect.unreachable();
	});
	it.skip("on_turn_end_hook_noop_writes_no_audit_no_event", () => {
		expect.unreachable();
	});
	it.skip("on_turn_end_hook_stop_emits_event_and_audits_payload", () => {
		expect.unreachable();
	});
	it.skip("on_turn_end_continue_runs_second_turn_then_stops", () => {
		expect.unreachable();
	});
	it.skip("on_turn_end_continuation_cap_emits_budget_limited_without_invoking_hook", () => {
		expect.unreachable();
	});
});

// GAP: oracle's `run_evaluator` (isolated sub-agent that returns just the last assistant text, or
// "cancelled" when a token trips pre-dispatch) has no TS counterpart. Grep-confirmed zero
// occurrences of "runEvaluator"/"RunEvaluator" anywhere in agent-harness.ts or types.ts — the only
// isolated-sub-agent mechanism that exists is the trigger `sub_agent` delivery path
// (`runSubAgentDelivery`), which is trigger-shaped (requires a `Trigger` envelope, writes
// `trigger_result` audit entries, etc.), not a standalone "run an isolated evaluator, get text
// back" API oracle's `run_evaluator` exposes.
describe("harness_e2e: run_evaluator (GAP: no standalone isolated-sub-agent evaluator API in TS)", () => {
	it.skip("run_evaluator_returns_last_assistant_text_from_isolated_sub_agent", () => {
		expect.unreachable();
	});
	it.skip("run_evaluator_returns_cancelled_when_token_tripped_pre_dispatch", () => {
		expect.unreachable();
	});
});
