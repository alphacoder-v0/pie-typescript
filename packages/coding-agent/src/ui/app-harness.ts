/**
 * Adapts the CLI's real runtime — `core/agent-session.ts`'s {@link AgentSession} — to the
 * `AppHarness` surface `./index.ts`'s `App` consumes.
 *
 * ## Why `AgentSession` and not `@pie/agent-core`'s `AgentHarness`
 *
 * Oracle threads one `Arc<AgentHarness>` from `main.rs` into `ui::App`. This repo has **two**
 * objects that could stand in for it, and only one of them is on the product path:
 *
 * - `packages/agent/src/harness/agent-harness.ts` — the faithful port of oracle's class. It has
 *   zero callers in the CLI: `migration/reviews/phase13/reachability-audit.md` §1 lists it among
 *   the 21 dead harness modules, and §3 shows the duplicate-implementation pattern (compaction,
 *   sessions, skills, prompts all exist twice; the CLI always picks `coding-agent/src/core/`).
 * - `packages/coding-agent/src/core/agent-session.ts` — what `main.ts` actually builds and runs.
 *
 * Adapting the *dead* class would have produced a REPL driving an object no other part of the CLI
 * touches: `/cost` would report a tracker nothing feeds, `/skills` a catalog the tools never read,
 * and a prompt would run on a second agent with its own session file. So the adapter goes the other
 * way — `AppHarness` is a structural interface (`core/slash-dispatch-deps.ts` documents that
 * explicitly), so satisfying it from `AgentSession` needs no change to `App` at all.
 *
 * This mirrors the precedent `goal-runtime.ts` set for `/goal` (`createGoalHarness`) and
 * `triggers/cron-deps.ts` set for cron: the ported unit keeps its oracle-shaped interface; a thin
 * local adapter binds it to the product runtime.
 *
 * ## The members with no `AgentSession` counterpart
 *
 * | member | mapping |
 * |---|---|
 * | `cost()` / `resetCost()` | a real `CostTracker` (the class `AgentHarness` itself uses) subscribed to `session.agent` |
 * | `notificationStatusSnapshot()` / `abortTrigger*` | delegated to the live {@link AppHarnessTriggers} (`TriggerSupervisor`); absent → an empty snapshot |
 * | `promptFromTemplate()` | `PromptTemplateRegistry.interpolate` (oracle's own `{{var}}` renderer) then `session.prompt(rendered)` |
 * | `continue()` | **throws** — see {@link continueUnsupported} |
 */

import {
	type CostSnapshot,
	CostTracker,
	type NotificationStatusSnapshot,
	PromptTemplateRegistry,
	type SessionContext,
	type SessionMetadata,
	type SessionTreeEntry,
	type ThinkingLevel,
} from "@pie/agent-core";
import type { AssistantMessage, ImageContent, Model } from "@pie/ai";
import type { AgentSession } from "../core/agent-session.ts";
import type { Skill } from "../core/skills.ts";
import type { CommandPromptTemplate, CommandSkill } from "../core/slash-dispatch-deps.ts";
import { loadEffectiveSkills, resolveSkillSource } from "../tools/skill.ts";
import type { AppHarness, AppSession } from "./index.ts";

/** The `AgentHarness` trigger slice `commands.rs` reaches for — supplied by `triggers/runtime.ts`. */
export interface AppHarnessTriggers {
	notificationStatusSnapshot(): NotificationStatusSnapshot;
	abortTrigger(traceId: string): void;
	abortAllTriggers(): void;
}

export interface AppHarnessOptions {
	/** `~/.pie` (or `PIE_DIR`) — where `skills-state.json` lives, for the reload path. */
	agentDir: string;
	/** Live trigger runtime. Omitted in tests; then the status surface reports "nothing running". */
	triggers?: AppHarnessTriggers;
}

/** pie: `AgentHarness::skills()` rows, as `commands.rs` reads them. */
function toCommandSkill(skill: Skill): CommandSkill {
	return {
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		disableModelInvocation: skill.disableModelInvocation,
		// The pi catalog carries `sourceInfo.scope`, not oracle's `SkillSource`; `tools/skill.ts`
		// owns the one mapping between them and every skill-family unit goes through it.
		source: resolveSkillSource(skill),
	};
}

/** pie: `PromptTemplate` as `/template`'s listing reads it (commands.rs:1477-1487). */
function toCommandTemplate(template: { name: string; description?: string }): CommandPromptTemplate {
	return { name: template.name, description: template.description };
}

const EMPTY_NOTIFICATION_STATUS: NotificationStatusSnapshot = {
	hooks: [],
	runtime: { dedupEntries: 0, activeTraces: 0, acceptedTotal: 0, dedupedTotal: 0, cycleSuppressedTotal: 0 },
	running: [],
};

/**
 * pie: `AgentHarness::continue_` (agent_harness.rs:1732-1743) — run another turn on the existing
 * context with no new user message. `AgentSession` has no such entry point: every one of its turn
 * starters appends a message first.
 *
 * Rather than fake it with an empty prompt (which would append an empty user message and change the
 * transcript), this throws. RULEBOOK §3: crash the operation, never degrade silently. Both call
 * sites are inert on the product path — `startTriggeredTurn` fires only on `mainRunRx`, which
 * nothing on this side pushes to (see `main.ts`), and `promptWithRetry`'s retry arm is not reached
 * because `AgentSession` already owns oracle's retry loop (see `main.ts`'s `retry` note).
 *
 * TODO(port): give `AgentSession` a `continue()` (its `Agent` has `runAgentLoopContinue`
 * underneath) and delete this.
 */
function continueUnsupported(): never {
	throw new Error(
		"continue is not available on this session: AgentSession has no turn entry point that appends no message (TODO(port))",
	);
}

/**
 * `Session` (crates/agent/src/harness/session/session.rs) over the CLI's own `SessionManager`.
 *
 * Every method below is `SessionManager`'s synchronous equivalent wrapped in a promise, so the
 * awaiting call sites in `commands.rs`/`goal.rs`/`agent_session.rs` keep their shape. The one
 * non-obvious row is `moveTo`, whose three oracle behaviours (`None` → root, `Some(id)` → move,
 * `Some(id) + summary` → move and record) map onto three different `SessionManager` methods.
 */
function createAppSession(session: AgentSession): AppSession {
	const manager = session.sessionManager;
	return {
		getEntries: async (): Promise<SessionTreeEntry[]> => manager.getEntries() as unknown as SessionTreeEntry[],
		appendCustomEntry: async (customType: string, data?: unknown): Promise<string> =>
			manager.appendCustomEntry(customType, data),
		getSessionName: async (): Promise<string | undefined> => manager.getSessionName(),
		appendSessionName: async (name: string): Promise<string> => manager.appendSessionInfo(name),
		getBranch: async (fromId?: string): Promise<SessionTreeEntry[]> =>
			manager.getBranch(fromId) as unknown as SessionTreeEntry[],
		getLeafId: async (): Promise<string | null> => manager.getLeafId(),
		getEntry: async (id: string): Promise<SessionTreeEntry | undefined> =>
			manager.getEntry(id) as unknown as SessionTreeEntry | undefined,
		moveTo: async (
			entryId: string | null,
			summary?: { summary: string; details?: unknown },
		): Promise<string | undefined> => {
			if (summary !== undefined) {
				return manager.branchWithSummary(entryId, summary.summary, summary.details);
			}
			if (entryId === null) {
				manager.resetLeaf();
				return undefined;
			}
			manager.branch(entryId);
			return undefined;
		},
		buildContext: async (): Promise<SessionContext> => manager.buildSessionContext() as unknown as SessionContext,
		getStorage: () => ({
			// pie: `Session::storage().get_metadata()` — the two commands that read it (`/export`,
			// `/session import`) only ever look at `path`.
			getMetadata: async (): Promise<SessionMetadata> =>
				({ path: manager.getSessionFile() }) as unknown as SessionMetadata,
		}),
	};
}

/** The most recent assistant message in the session transcript, if any. */
function lastAssistantMessage(session: AgentSession): AssistantMessage | undefined {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

/** The adapter plus the teardown its `session.agent` subscription needs. */
export interface AppHarnessHandle {
	harness: AppHarness;
	/** Detaches the cost listener. Safe to call twice. */
	dispose(): void;
}

/** Build the `AppHarness` view of a live {@link AgentSession}. */
export function createAppHarness(session: AgentSession, options: AppHarnessOptions): AppHarnessHandle {
	// pie: `AgentHarness`'s own `costTracker` field — the same class, fed the same way
	// (`CostTracker::as_listener` on assistant `message_end`), so `/cost` reports real numbers.
	// PORT-DIVERGENCE: B3/B3a (RULEBOOK §5) are fixed as of phase 18 — every real provider now
	// prices its own usage from the model catalog, so these totals are real money rather than the
	// $0 oracle always reported. The faux provider still returns 0 by design (it has no `Model` to
	// price against), so fixture-driven runs still show $0.00.
	const costTracker = new CostTracker();
	const unsubscribeCost = session.agent.subscribe(costTracker.asListener());

	let skillCatalog: CommandSkill[] = session.resourceLoader.getSkills().skills.map(toCommandSkill);
	const appSession = createAppSession(session);

	const harness: AppHarness = {
		skills: (): CommandSkill[] => skillCatalog.slice(),
		reloadSkillsFromDisk: async (): Promise<{ skills: CommandSkill[]; diagnostics: readonly unknown[] }> => {
			// pie: `AgentHarness::reload_skills_from_disk` delegates to the embedder-supplied
			// `ReloadSkillsFn`. `loadEffectiveSkills` IS this repo's — it rescans the same directories
			// and re-applies the `skills-state.json` enable/disable overlay.
			const loaded = await loadEffectiveSkills({ cwd: session.sessionManager.getCwd(), agentDir: options.agentDir });
			skillCatalog = loaded.skills.map(toCommandSkill);
			return { skills: skillCatalog.slice(), diagnostics: loaded.diagnostics };
		},
		session: (): AppSession => appSession,
		getThinkingLevel: (): ThinkingLevel | undefined => session.thinkingLevel,
		setThinkingLevel: async (level: ThinkingLevel): Promise<void> => {
			session.setThinkingLevel(level);
		},
		// `AppHarness` narrows oracle's `Option<Model>` to a bare `Model` (see `./index.ts`'s note —
		// it is what lets the same object double as `goal.ts`'s `GoalHarness`). `AgentSession`'s
		// resolver can legitimately come up empty (`main.rs:917-922`'s credential-less start), so the
		// cast is where that widening is admitted. Every reader in `ui/` guards on `=== undefined`
		// already (`modelSpec`, `openModelPicker`, `currentModelAcceptsImages`), so this stays honest.
		getModel: (): Model<any> => session.model as Model<any>,
		setModel: (model: Model<any>): Promise<void> => session.setModel(model),
		templates: (): readonly CommandPromptTemplate[] => session.promptTemplates.map(toCommandTemplate),
		cost: (): CostSnapshot => costTracker.snapshot(),
		resetCost: (): void => costTracker.reset(),
		notificationStatusSnapshot: (): NotificationStatusSnapshot =>
			options.triggers?.notificationStatusSnapshot() ?? EMPTY_NOTIFICATION_STATUS,
		abortTrigger: (traceId: string): void => options.triggers?.abortTrigger(traceId),
		abortAllTriggers: (): void => options.triggers?.abortAllTriggers(),

		// ── turn starters ───────────────────────────────────────────────────────────────────────
		prompt: async (text: string, promptOptions?: { images?: ImageContent[] }): Promise<AssistantMessage> => {
			// `preflightAuth: false` — pie: main.rs:1225-1258. Oracle never gates a turn on a stored
			// credential; a missing key is the *provider's* error (anthropic.rs:189), which is what
			// `ui/index.ts`'s headless arm prints and what `retry-prompt.ts` classifies.
			await session.prompt(text, { images: promptOptions?.images, preflightAuth: false });
			// pie: `AgentHarness::prompt` answers with the turn's final assistant message;
			// `AgentSession::prompt` answers with nothing, so it is read back off the transcript. The
			// one consumer that looks at it is `retry-prompt.ts`'s `assistantErrorMessage`, which only
			// needs `stopReason`/`errorMessage`.
			return lastAssistantMessage(session) as AssistantMessage;
		},
		continue: continueUnsupported,
		promptFromTemplate: async (name: string, vars: Record<string, unknown> = {}): Promise<AssistantMessage> => {
			// pie: agent_harness.rs:1791-1816 — look the template up, interpolate `{{var}}`, then run
			// the rendered text through the ordinary prompt path.
			const template = session.promptTemplates.find((candidate) => candidate.name === name);
			if (template === undefined) throw new Error(`Unknown prompt template: ${name}`);
			const rendered = PromptTemplateRegistry.interpolate(template, vars);
			// `expandPromptTemplates: false`: the text has already been rendered, and the skeleton's
			// own `$1`/`$ARGUMENTS` expander would otherwise take a second pass over it.
			await session.prompt(rendered, { expandPromptTemplates: false, preflightAuth: false });
			return lastAssistantMessage(session) as AssistantMessage;
		},
		compact: async (customInstructions?: string): Promise<{ ran: true; result: unknown } | { ran: false }> => {
			try {
				return { ran: true, result: await session.compact(customInstructions) };
			} catch (error) {
				// pie: `AgentHarness::compact` answers `{ ran: false }` where oracle's `force_compact`
				// answers `false`. `AgentSession` signals the same two "there was nothing to do" cases
				// by throwing, so they are translated back; anything else is a real failure.
				const message = error instanceof Error ? error.message : String(error);
				if (message.startsWith("Nothing to compact") || message === "Already compacted") {
					return { ran: false };
				}
				throw error;
			}
		},
		abort: async (): Promise<void> => session.abort(),
		// pie: the evaluator sub-agent `goal.rs` runs. `goal-runtime.ts` already owns that mapping and
		// `main.ts` builds the controller that uses it, so this member exists only to satisfy the
		// interface — `App` itself only calls `goal.current`, which is a read.
		runEvaluator: async (): Promise<never> => {
			throw new Error("runEvaluator is driven by GoalController, not by the REPL harness view");
		},
	};

	let disposed = false;
	return {
		harness,
		dispose: (): void => {
			if (disposed) return;
			disposed = true;
			unsubscribeCost();
		},
	};
}
