/**
 * 1:1 port of oracle `crates/coding-agent/tests/commands.rs` (pie @0a120dfd) — 43
 * `#[tokio::test]` functions. Ported: 43. Skipped: 0.
 *
 * Oracle module doc: "Integration test for the slash-command registry. Drives `dispatch` against
 * a real `AgentHarness` (faux stream) and verifies user-visible effects: `/thinking high` flips
 * the harness's thinking level *and* writes a thinking_level_change row to the session, so
 * `--resume` later restores it."
 *
 * File name: the manifest's `out_path` for this unit (`coding-agent/tests/commands`) collides
 * with `test/ported/commands.test.ts`, which is already the port of the SRC unit
 * `coding-agent/commands` (`src/commands.rs` -> `src/core/slash-commands.ts`). This file takes the
 * disambiguated `-e2e` name, matching the rest of the `*_e2e.rs` ports in this directory.
 *
 * ## Phase 14: the dispatch half landed, all 41 skips are now live
 *
 * The header this file carried through phase 13 recorded ONE gap behind all 41 skips: none of
 * `dispatch`, `Registry::with_builtins`, `CommandCtx`, `CommandOutcome`, `console::set_sink`,
 * `skill_shortcuts`, `attach_skill_prompt`, `render_triggers_status` or `render_cron_jobs` was
 * ported. Phase 14 ported all of them into `src/core/slash-dispatch{,-deps,-skills,-triggers,
 * -session}.ts`, so every assertion below is oracle's, verbatim and un-weakened.
 *
 * ### Construct mapping notes that apply file-wide
 *
 * - `&Arc<AgentHarness>` -> `CommandHarness`, the structural stand-in documented in
 *   `src/core/slash-dispatch-deps.ts` (the real `AgentHarness` keeps its `Session` private and the
 *   ported `Skill` has no `source`). {@link TestCommandHarness} wraps a REAL `AgentHarness` and a
 *   REAL `Session`, so `setThinkingLevel`'s session write, `notificationStatusSnapshot`,
 *   `abortTrigger`/`abortAllTriggers`, `getBranch`/`moveTo`/`buildContext` and every
 *   `appendCustomEntry` audit below are the production implementations, not fakes. Only the skill
 *   catalog is test data — as it is in oracle, where it is `opts.skills`.
 * - `opts.skills = vec![skill("db9", "SECRET SKILL BODY", false)]` -> {@link commandSkill}.
 *   `CommandSkill` deliberately has NO `content` field (see `slash-dispatch-deps.ts`'s header: the
 *   command surface must never be able to echo a SKILL.md body), so the `!contains("SECRET SKILL
 *   BODY")` assertions are kept verbatim and now hold structurally rather than by inspection. They
 *   retain full force in the `/skills install|remove` cases, where the body IS on disk and could
 *   reach the output through the tool result.
 * - `triggers::global_registry().clear_for_tests()` has no TS counterpart; the established repo
 *   idiom (`test/ported/cron-tool-bugs.test.ts:53-57`, `test/ported/dynamic-tool.test.ts:199`) is
 *   `clearRules()` / per-job removal, which {@link clearTriggerRegistries} does. Oracle's four
 *   process-global `Mutex` guards have no counterpart either — vitest runs each file in its own
 *   worker, tests sequentially.
 * - `commands::save_api_key` -> `AuthStorage.set` over `getAuthPath()`, the same
 *   load-then-merge-then-write sequence, cross-referenced from `core/auth-storage.ts:369-372`.
 * - `EnvGuard`/`PathGuard` -> {@link setEnv}. `HOME` is never touched — only `PIE_DIR` and `PATH`.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentMessage, AgentTool, SessionMetadata, SessionTreeEntry, ThinkingLevel } from "@pie/agent-core";
import { AgentHarness, EvaluatorError, InMemorySessionStorage, Session } from "@pie/agent-core";
import type { Context, Model } from "@pie/ai";
import { type FauxProviderRegistration, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../agent/src/harness/env/nodejs.ts";
import { getAuthPath } from "../../src/config.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { dispatch, registryWithBuiltins } from "../../src/core/slash-dispatch.ts";
import {
	type CommandCtx,
	type CommandHarness,
	type CommandPromptTemplate,
	type CommandSession,
	type CommandSkill,
	clearCommandSink,
	setCommandSink,
} from "../../src/core/slash-dispatch-deps.ts";
import { attachSkillPrompt, skillShortcuts } from "../../src/core/slash-dispatch-skills.ts";
import { renderCronJobs, renderTriggersStatus } from "../../src/core/slash-dispatch-triggers.ts";
import { CUSTOM_TYPE, current, set, stopHook } from "../../src/goal.ts";
import type { GoalHarness, GoalHarnessCell, GoalHarnessSession, GoalSessionEntry } from "../../src/goal-deps.ts";
import { loadSkillsState, lookupSkillState } from "../../src/skills-state.ts";
import { loadEffectiveSkills, resolveSkillSource } from "../../src/tools/skill.ts";
import { globalCronRegistry } from "../../src/triggers/cron.ts";
import { globalRegistry } from "../../src/triggers/dynamic.ts";
import { triggerToolDefinitions } from "../../src/triggers/tool-definitions.ts";

let tempDirs: string[] = [];
let envRestores: Array<() => void> = [];
let registrations: FauxProviderRegistration[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** pie: commands.rs:2014-2033 (`EnvGuard`) and :1990-2012 (`PathGuard`). `HOME` is never touched. */
function setEnv(key: string, value: string): void {
	const previous = process.env[key];
	envRestores.push(() => {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	});
	process.env[key] = value;
}

afterEach(() => {
	clearCommandSink();
	for (const registration of registrations.splice(0)) registration.unregister();
	registrations = [];
	for (const restore of envRestores.splice(0).reverse()) restore();
	envRestores = [];
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

/* -------------------------------------------------------------------------------------------
 * Harness / context construction.
 * ----------------------------------------------------------------------------------------- */

function fauxProvider(): FauxProviderRegistration {
	const registration = registerFauxProvider({ provider: "faux", models: [{ id: "faux", name: "Faux" }] });
	registrations.push(registration);
	return registration;
}

/** pie: commands.rs:84-100 (`faux_model`). */
function fauxModel(): Model<any> {
	return fauxProvider().getModel() as Model<any>;
}

/**
 * pie: the `AgentHarnessOptions::new(faux_model(), session)` every test builds.
 * `systemPrompt: ""` mirrors oracle's `AgentHarnessOptions::new` default (agent_harness.rs:875);
 * TS's own omit-default is `"You are a helpful assistant."`, which has no oracle counterpart.
 */
function newAgentHarness(session: Session, options: { model?: Model<any>; tools?: AgentTool[] } = {}): AgentHarness {
	return new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		systemPrompt: "",
		session,
		model: options.model ?? fauxModel(),
		tools: options.tools,
		// pie: commands.rs:79-82 (`allow_all_control_plane_hook`).
		onControlPlanePrompt: async () => ({ type: "allow" }),
	});
}

interface TestHarnessOptions {
	skills?: CommandSkill[];
	/** pie: `opts.reload_skills_fn` (commands.rs:213-225 / 236-258). */
	reload?: () => Promise<{ skills: CommandSkill[]; diagnostics: readonly unknown[] }>;
	templates?: CommandPromptTemplate[];
	/** Overrides only `session().getStorage().getMetadata()` — used by `/session export`. */
	metadata?: SessionMetadata & { path?: string };
}

/**
 * `CommandHarness` over a real `AgentHarness` + real `Session`. Everything except the skill
 * catalog (oracle's `opts.skills`, also test data there) is the production implementation.
 */
class TestCommandHarness implements CommandHarness {
	readonly agent: AgentHarness;
	readonly rawSession: Session;
	private skillList: CommandSkill[];
	private readonly templateList: CommandPromptTemplate[];
	private readonly reloadFn?: TestHarnessOptions["reload"];
	private readonly commandSession: CommandSession;

	constructor(agent: AgentHarness, rawSession: Session, options: TestHarnessOptions = {}) {
		this.agent = agent;
		this.rawSession = rawSession;
		this.skillList = options.skills ?? [];
		this.templateList = options.templates ?? [];
		this.reloadFn = options.reload;
		const metadata = options.metadata;
		const real = rawSession as unknown as CommandSession;
		this.commandSession =
			metadata === undefined
				? real
				: {
						getEntries: () => real.getEntries(),
						appendCustomEntry: (customType, data) => real.appendCustomEntry(customType, data),
						getSessionName: () => real.getSessionName(),
						appendSessionName: (name) => real.appendSessionName(name),
						getBranch: (fromId) => real.getBranch(fromId),
						moveTo: (entryId, summary) => real.moveTo(entryId, summary),
						buildContext: () => real.buildContext(),
						getStorage: () => ({ getMetadata: async () => metadata }),
					};
	}

	skills(): CommandSkill[] {
		return this.skillList.slice();
	}

	/** pie: `AgentHarness::replace_skills` (commands.rs test :1775). */
	replaceSkills(next: CommandSkill[]): void {
		this.skillList = next;
	}

	async reloadSkillsFromDisk(): Promise<{ skills: CommandSkill[]; diagnostics: readonly unknown[] }> {
		if (this.reloadFn === undefined) throw new Error("reloadSkillsFn was not configured");
		const out = await this.reloadFn();
		this.skillList = out.skills.slice();
		return out;
	}

	session(): CommandSession {
		return this.commandSession;
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.agent.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.agent.setThinkingLevel(level);
	}

	getModel(): Model<any> | undefined {
		return this.agent.getModel();
	}

	setModel(model: Model<any>): Promise<void> {
		return this.agent.setModel(model);
	}

	templates(): readonly CommandPromptTemplate[] {
		return this.templateList;
	}

	cost() {
		return this.agent.cost();
	}

	resetCost(): void {
		this.agent.resetCost();
	}

	notificationStatusSnapshot() {
		return this.agent.notificationStatusSnapshot();
	}

	abortTrigger(traceId: string): void {
		this.agent.abortTrigger(traceId);
	}

	abortAllTriggers(): void {
		this.agent.abortAllTriggers();
	}
}

function newTestHarness(options: TestHarnessOptions & { tools?: AgentTool[] } = {}): TestCommandHarness {
	const session = new Session(new InMemorySessionStorage());
	const agent = newAgentHarness(session, { tools: options.tools });
	return new TestCommandHarness(agent, session, options);
}

/** pie: commands.rs:302-308 — the `CommandCtx` every test builds, with `cwd = current_dir()`. */
function newCtx(harness: CommandHarness, overrides: Partial<CommandCtx> = {}): CommandCtx {
	return { harness, sessionId: "test", toolCount: 0, cwd: process.cwd(), ...overrides };
}

/** pie: commands.rs:267-290 (`OutputCapture`). */
function captureOutput(): { text(): string } {
	const lines: string[] = [];
	setCommandSink((line) => {
		lines.push(line);
	});
	return { text: () => lines.join("\n") };
}

/** pie: commands.rs:180-205 (`skill` / `user_skill_at`), minus `content` — see the file header. */
function commandSkill(
	name: string,
	disabled: boolean,
	options: { source?: CommandSkill["source"]; filePath?: string } = {},
): CommandSkill {
	return {
		name,
		description: `description for ${name}`,
		filePath: options.filePath ?? `/tmp/project/.pie/skills/${name}/SKILL.md`,
		disableModelInvocation: disabled,
		source: options.source ?? "user",
	};
}

/** pie: `triggers::global_registry().clear_for_tests()` + `global_cron_registry().clear_for_tests()`. */
function clearTriggerRegistries(): void {
	globalRegistry().clearRules();
	for (const job of globalCronRegistry().list()) globalCronRegistry().removeJob(job.id);
}

/** pie: commands.rs:1978-1988 (`write_fake_gh`) + :2003-2012 (`prepend_path`). */
function installFakeGh(dir: string, body: string): void {
	const path = join(dir, "gh");
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	setEnv("PATH", `${dir}${delimiter}${process.env.PATH ?? ""}`);
}

function customEntries(entries: readonly SessionTreeEntry[], customType: string): Array<Record<string, unknown>> {
	return entries
		.filter((entry): entry is Extract<SessionTreeEntry, { type: "custom" }> => entry.type === "custom")
		.filter((entry) => entry.customType === customType)
		.map((entry) => (entry.data ?? {}) as Record<string, unknown>);
}

/**
 * pie: commands.rs:232-263 (`harness_with_disk_skill_reload`) — re-scan `<baseDir>/skills` and
 * project the result onto `CommandSkill`, applying the `skills-state.json` overlay, exactly as the
 * production catalog does (`tools/skill.ts`'s `loadEffectiveSkills`).
 */
async function loadDiskSkills(baseDir: string): Promise<{ skills: CommandSkill[]; diagnostics: readonly unknown[] }> {
	const loaded = await loadEffectiveSkills({ cwd: baseDir, agentDir: baseDir, baseDir });
	return {
		skills: loaded.skills.map((s) => ({
			name: s.name,
			description: s.description,
			filePath: s.filePath,
			disableModelInvocation: s.disableModelInvocation,
			source: resolveSkillSource(s),
		})),
		diagnostics: loaded.diagnostics,
	};
}

/* -------------------------------------------------------------------------------------------
 * Goal stop-hook fake — the same stand-in `test/ported/goal.test.ts` uses; see `src/goal-deps.ts`'s
 * header for why the real `AgentHarness` cannot be passed here (no public `session()` accessor).
 * ----------------------------------------------------------------------------------------- */

class FakeGoalHarness implements GoalHarness {
	readonly entries: GoalSessionEntry[] = [];
	responses: Array<{ text?: string; error?: unknown }> = [];

	session(): GoalHarnessSession {
		return {
			getEntries: async () => this.entries,
			appendCustomEntry: async (customType, data) => {
				this.entries.push({ type: "custom", customType, data });
				return `entry-${this.entries.length}`;
			},
		};
	}

	getModel(): any {
		return { id: "faux", provider: "faux", api: "faux" };
	}

	async runEvaluator(
		_systemPrompt: string,
		_userPrompt: string,
		_model: any,
		_thinkingLevel: any,
		signal: AbortSignal,
	): Promise<{ lastAssistantText: string | undefined }> {
		if (signal.aborted) throw new EvaluatorError("cancelled", "evaluator cancelled");
		const response = this.responses.shift();
		if (!response) throw new Error("FakeGoalHarness: no evaluator response queued");
		if (response.error) throw response.error;
		return { lastAssistantText: response.text };
	}
}

function cellFor(harness: GoalHarness): GoalHarnessCell {
	return { get: () => harness };
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

/** The dispatcher's `CommandHarness` already satisfies `GoalHarness`'s `session()`/`getModel()`;
 * only `runEvaluator` (unreachable from the slash path) is absent, so tests that call `goal.set`
 * directly narrow through this helper rather than repeating the cast. */
function asGoalHarness(harness: CommandHarness): GoalHarness {
	return harness as unknown as GoalHarness;
}

/* -------------------------------------------------------------------------------------------
 * The two oracle functions that never touch `dispatch`.
 * ----------------------------------------------------------------------------------------- */

describe("commands.rs (char-tests port) — non-dispatch helpers", () => {
	// pie: commands.rs:584-644. An evaluator verdict of `ok:false` must produce a continuation
	// carrying BOTH the goal condition and the evaluator's reason, must surface the raw decision
	// as the hook's payload, must bump `iterations`/`last_reason` on the goal state, and must
	// persist the updated state as a `goal_state` custom entry.
	it("goal_evaluator_false_returns_continuation_and_audits_reason", async () => {
		const harness = new FakeGoalHarness();
		harness.responses.push({ text: '{"ok":false,"reason":"missing cargo test output"}' });
		const hook = stopHook(cellFor(harness));
		await set(harness, "finish only after cargo test passes");

		const decision = await hook(
			{
				transcript: [userMessage("ran cargo build only")],
				continuationCount: 0,
				lastUserPrompt: "ran cargo build only",
			},
			new AbortController().signal,
		);

		expect(decision.action.kind, `expected continuation, got ${JSON.stringify(decision.action)}`).toBe("continue");
		if (decision.action.kind !== "continue") throw new Error("unreachable");
		expect(decision.action.prompt).toContain("finish only after cargo test passes");
		expect(decision.action.prompt).toContain("missing cargo test output");
		expect((decision.payload as Record<string, unknown>).ok).toBe(false);
		expect((decision.payload as Record<string, unknown>).reason).toBe("missing cargo test output");

		const state = await current(harness);
		expect(state, "goal state").toBeDefined();
		expect(state?.iterations).toBe(1);
		expect(state?.last_reason).toBe("missing cargo test output");

		const persisted = harness.entries.some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === CUSTOM_TYPE &&
				(entry.data as Record<string, unknown> | undefined)?.status === "pursuing" &&
				(entry.data as Record<string, unknown> | undefined)?.last_reason === "missing cargo test output",
		);
		expect(persisted, `goal hook must persist updated goal state: ${JSON.stringify(harness.entries)}`).toBe(true);
	});

	// pie: commands.rs:1414-1430 (`save_api_key`). Oracle's helper is a free function on the
	// `commands` module; its TS counterpart is `AuthStorage.set` over `getAuthPath()` — the same
	// load-then-merge-then-write sequence, cross-referenced from `core/auth-storage.ts:369-372`
	// and already covered for the load-failure path by `test/auth-storage.test.ts:398`.
	// `AuthStore::load_from(&path)` -> a second `AuthStorage.create(path)`, i.e. a genuine re-read
	// from disk rather than the in-memory copy the writer kept.
	it("save_api_key_persists_without_printing_secret_material", () => {
		const temp = tempDir("pie-ported-commands-auth-");
		setEnv("PIE_DIR", temp);
		const secret = "sk-sentinel-login-secret-should-not-leak";

		const path = getAuthPath();
		expect(path).toBe(join(temp, "auth.json"));
		AuthStorage.create(path).set("ds4", { type: "api_key", key: secret });

		const stored = AuthStorage.create(path).get("ds4");
		expect(stored, "stored ds4 credential").toEqual({ type: "api_key", key: secret });
	});
});

/* -------------------------------------------------------------------------------------------
 * dispatch.
 * ----------------------------------------------------------------------------------------- */

describe("commands.rs (char-tests port) — dispatch", () => {
	// oracle :292-328. `/thinking high` -> Handled; harness thinking level becomes High AND a
	// `thinking_level_change` entry with "high" is persisted (so `--resume` restores it).
	it("dispatch_thinking_command_updates_state_and_session", async () => {
		const session = new Session(new InMemorySessionStorage());
		const agent = newAgentHarness(session);
		await agent.setThinkingLevel("off");
		const harness = new TestCommandHarness(agent, session);

		const outcome = await dispatch("/thinking high", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind).toBe("handled");

		expect(agent.getThinkingLevel()).toBe("high");
		const entries = await session.getEntries();
		const sawChange = entries.some(
			(entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === "high",
		);
		expect(sawChange, `thinking_level_change entry must be persisted: ${JSON.stringify(entries)}`).toBe(true);
	});

	// oracle :330-370. `/session export backup.piesession` -> Handled; `<cwd>/backup.piesession`
	// exists; console prints the ".piesession archives include transcript and tool history"
	// caveat and "exported session archive", and echoes NO transcript payload
	// ("do-not-render"/"secret_transcript_marker" must not appear). Archive writing itself is
	// covered by test/session-archive.test.ts; the bounded console output is not.
	it("dispatch_session_export_writes_archive_with_bounded_output", async () => {
		const temp = tempDir("pie-ported-commands-export-");
		const cwd = join(temp, "repo");
		mkdirSync(cwd, { recursive: true });
		const sessionsDir = join(temp, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		// pie: :336-347 — a real on-disk transcript carrying a sentinel payload the export must
		// never echo. Written directly in pi's SessionManager jsonl shape, the same fixture idiom
		// `test/session-archive.test.ts:22-27` uses.
		const sessionId = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
		const sessionPath = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(
			sessionPath,
			`${[
				`{"type":"session","version":3,"id":"${sessionId}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}`,
				'{"type":"custom","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","customType":"test_payload","data":{"secret_transcript_marker":"do-not-render"}}',
			].join("\n")}\n`,
		);

		const harness = newTestHarness({
			metadata: { id: sessionId, createdAt: "2026-01-01T00:00:00.000Z", path: sessionPath },
		});
		const capture = captureOutput();

		const outcome = await dispatch(
			"/session export backup.piesession",
			registryWithBuiltins(),
			newCtx(harness, { sessionId, cwd }),
		);
		expect(outcome.kind, JSON.stringify(outcome)).toBe("handled");
		expect(existsSync(join(cwd, "backup.piesession"))).toBe(true);
		const output = capture.text();
		expect(output).toContain(".piesession archives include transcript and tool history");
		expect(output).toContain("exported session archive");
		expect(output, output).not.toContain("do-not-render");
		expect(output, output).not.toContain("secret_transcript_marker");
	});

	// oracle :372-393. `/notarealcommand` -> `CommandOutcome::Error` containing "unknown command".
	it("dispatch_unknown_command_returns_error_outcome", async () => {
		const harness = newTestHarness();
		const outcome = await dispatch("/notarealcommand", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected Error outcome, got ${JSON.stringify(outcome)}`).toBe("error");
		if (outcome.kind !== "error") throw new Error("unreachable");
		expect(outcome.message).toContain("unknown command");
	});

	// oracle :395-444. `/goal <condition>` then bare `/goal` -> Handled twice; `goal::current` is
	// Pursuing with that condition; console prints "goal set: …", "start by sending a normal
	// prompt, or run /goal-start <prompt>", "status: pursuing", "iterations: 0"; a `goal_state`
	// custom entry carries the condition. The state machine itself: test/ported/goal.test.ts.
	it("dispatch_goal_sets_and_reports_session_goal", async () => {
		const capture = captureOutput();
		const harness = newTestHarness();
		const registry = registryWithBuiltins();
		const ctx = newCtx(harness);

		expect((await dispatch("/goal finish only after cargo test passes", registry, ctx)).kind).toBe("handled");

		const state = await current(asGoalHarness(harness));
		expect(state, "goal state").toBeDefined();
		expect(state?.status).toBe("pursuing");
		expect(state?.condition).toBe("finish only after cargo test passes");

		expect((await dispatch("/goal", registry, ctx)).kind).toBe("handled");

		const output = capture.text();
		expect(output).toContain("goal set: finish only after cargo test passes");
		expect(output, output).toContain("start by sending a normal prompt, or run /goal-start <prompt>");
		expect(output, output).toContain("status: pursuing");
		expect(output, output).toContain("iterations: 0");

		const entries = await harness.rawSession.getEntries();
		const persisted = customEntries(entries, CUSTOM_TYPE).some(
			(data) => data.condition === "finish only after cargo test passes",
		);
		expect(persisted, `goal command must persist session metadata: ${JSON.stringify(entries)}`).toBe(true);
	});

	// oracle :446-480. `/goal start run cargo test` with an active goal ->
	// `RunAgentPrompt { prompt: "run cargo test", error_context: "goal start: " }`.
	it("dispatch_goal_start_runs_prompt_when_goal_active", async () => {
		captureOutput();
		const harness = newTestHarness();
		await set(asGoalHarness(harness), "finish only after cargo test passes");

		const outcome = await dispatch("/goal start run cargo test", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected RunAgentPrompt, got ${JSON.stringify(outcome)}`).toBe("run_agent_prompt");
		if (outcome.kind !== "run_agent_prompt") throw new Error("unreachable");
		expect(outcome.prompt).toBe("run cargo test");
		expect(outcome.errorContext).toBe("goal start: ");
	});

	// oracle :482-516. `/goal-start run cargo test` -> the identical `RunAgentPrompt`.
	it("dispatch_goal_start_shortcut_runs_prompt_when_goal_active", async () => {
		captureOutput();
		const harness = newTestHarness();
		await set(asGoalHarness(harness), "finish only after cargo test passes");

		const outcome = await dispatch("/goal-start run cargo test", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected RunAgentPrompt, got ${JSON.stringify(outcome)}`).toBe("run_agent_prompt");
		if (outcome.kind !== "run_agent_prompt") throw new Error("unreachable");
		expect(outcome.prompt).toBe("run cargo test");
		expect(outcome.errorContext).toBe("goal start: ");
	});

	// oracle :518-554. Both `/goal start …` and `/goal-start …` without an active goal -> Error
	// containing "no active goal" and "/goal <condition>".
	it("dispatch_goal_start_requires_active_goal", async () => {
		captureOutput();
		const harness = newTestHarness();
		const registry = registryWithBuiltins();
		const ctx = newCtx(harness);

		for (const input of ["/goal start run cargo test", "/goal-start run cargo test"]) {
			const outcome = await dispatch(input, registry, ctx);
			expect(outcome.kind, `expected Error, got ${JSON.stringify(outcome)}`).toBe("error");
			if (outcome.kind !== "error") throw new Error("unreachable");
			expect(outcome.message, outcome.message).toContain("no active goal");
			expect(outcome.message, outcome.message).toContain("/goal <condition>");
		}
	});

	// oracle :556-582. `/goal clear` -> Handled; `goal::current` becomes None; console prints
	// "goal cleared".
	it("dispatch_goal_clear_hides_current_goal", async () => {
		const capture = captureOutput();
		const harness = newTestHarness();
		await set(asGoalHarness(harness), "ship a release");

		const outcome = await dispatch("/goal clear", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind).toBe("handled");

		expect(await current(asGoalHarness(harness))).toBeUndefined();
		expect(capture.text(), capture.text()).toContain("goal cleared");
	});

	// oracle :646-674. `/db9` (a loaded skill's dynamic slash command) -> `AttachSkill { name:
	// "db9" }`; console prints "using skill: db9 (user)" and never the SKILL.md body.
	it("dynamic_skill_slash_command_attaches_skill_without_body_echo", async () => {
		const capture = captureOutput();
		const harness = newTestHarness({ skills: [commandSkill("db9", false)] });

		const outcome = await dispatch("/db9", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected AttachSkill outcome, got ${JSON.stringify(outcome)}`).toBe("attach_skill");
		if (outcome.kind !== "attach_skill") throw new Error("unreachable");
		expect(outcome.name).toBe("db9");

		const output = capture.text();
		expect(output, output).toContain("using skill: db9 (user)");
		expect(output, output).not.toContain("SECRET SKILL BODY");
	});

	// oracle :676-706. `/db9 create a table` -> `RunAgentPrompt` whose prompt names the `Skill
	// tool` + "db9" + the user's text, and never inlines the skill body.
	it("dynamic_skill_slash_command_with_prompt_runs_skill_wrapped_turn", async () => {
		captureOutput();
		const harness = newTestHarness({ skills: [commandSkill("db9", false)] });

		const outcome = await dispatch("/db9 create a table", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected RunAgentPrompt outcome, got ${JSON.stringify(outcome)}`).toBe("run_agent_prompt");
		if (outcome.kind !== "run_agent_prompt") throw new Error("unreachable");
		expect(outcome.prompt).toContain("Skill tool");
		expect(outcome.prompt).toContain("db9");
		expect(outcome.prompt).toContain("create a table");
		expect(outcome.prompt).not.toContain("SECRET SKILL BODY");
	});

	// oracle :708-743. `commands::skill_shortcuts` omits `disable_model_invocation` skills AND
	// skills whose name collides with a builtin (`/help`); dispatching the hidden
	// `/disabled-skill` -> Error pointing at "/skills enable".
	it("dynamic_skill_slash_command_hides_disabled_and_builtin_conflicts", async () => {
		const harness = newTestHarness({
			skills: [commandSkill("disabled-skill", true), commandSkill("help", false)],
		});
		const registry = registryWithBuiltins();

		const shortcuts = skillShortcuts(harness.skills(), registry);
		expect(shortcuts.every((shortcut) => shortcut.command !== "/disabled-skill")).toBe(true);
		expect(shortcuts.every((shortcut) => shortcut.command !== "/help")).toBe(true);

		const outcome = await dispatch("/disabled-skill", registry, newCtx(harness));
		expect(outcome.kind, `expected Error outcome, got ${JSON.stringify(outcome)}`).toBe("error");
		if (outcome.kind !== "error") throw new Error("unreachable");
		expect(outcome.message, outcome.message).toContain("/skills enable");
	});

	// oracle :745-775. `/help` prints a "Skill commands:" section listing "/db9 [prompt]",
	// omitting disabled skills, and never any skill body ("SECRET").
	it("help_lists_dynamic_skill_commands_without_body", async () => {
		const capture = captureOutput();
		const harness = newTestHarness({
			skills: [commandSkill("db9", false), commandSkill("hidden-skill", true)],
		});

		const outcome = await dispatch("/help", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind).toBe("handled");

		const text = capture.text();
		expect(text, text).toContain("Skill commands:");
		expect(text, text).toContain("/db9 [prompt]");
		expect(text, text).not.toContain("/hidden-skill");
		expect(text, text).not.toContain("SECRET");
	});

	// oracle :777-807. `/triggers` (bare status) -> Handled and writes NOTHING to the session.
	it("dispatch_triggers_status_is_read_only_and_available", async () => {
		clearTriggerRegistries();
		captureOutput();
		const harness = newTestHarness();

		const outcome = await dispatch("/triggers", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind).toBe("handled");
		expect(await harness.rawSession.getEntries(), "/triggers status must not mutate the session").toEqual([]);
	});

	// oracle :809-837. `/template release version=1.2.3` -> `RunPromptTemplate { name: "release",
	// vars: {version: "1.2.3"} }` and does NOT run the agent itself (the REPL owns Ctrl-C).
	it("dispatch_template_returns_repl_owned_agent_work", async () => {
		const harness = newTestHarness();
		const outcome = await dispatch("/template release version=1.2.3", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected RunPromptTemplate outcome, got ${JSON.stringify(outcome)}`).toBe(
			"run_prompt_template",
		);
		if (outcome.kind !== "run_prompt_template") throw new Error("unreachable");
		expect(outcome.name).toBe("release");
		expect(outcome.vars.version).toBe("1.2.3");
		expect(
			await harness.rawSession.getEntries(),
			"/template dispatch should not run the agent directly; the TUI owns Ctrl-C abort handling",
		).toEqual([]);
	});

	// oracle :839-866. `/compact keep decisions` -> `RunCompaction { custom: "keep decisions" }`
	// and does NOT compact inline (the REPL owns Ctrl-C).
	it("dispatch_compact_returns_repl_owned_agent_work", async () => {
		const harness = newTestHarness();
		const outcome = await dispatch("/compact keep decisions", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected RunCompaction outcome, got ${JSON.stringify(outcome)}`).toBe("run_compaction");
		if (outcome.kind !== "run_compaction") throw new Error("unreachable");
		expect(outcome.custom).toBe("keep decisions");
		expect(
			await harness.rawSession.getEntries(),
			"/compact dispatch should not run compaction directly; the TUI owns Ctrl-C abort handling",
		).toEqual([]);
	});

	// oracle :868-937. `/new-trigger <nl request>` -> `RunAgentPrompt { error_context: "create
	// trigger: " }` echoing condition+action, with the rule registry still EMPTY at dispatch time
	// (the model extracts the rule during the subsequent turn); after running that prompt the rule
	// exists and `render_triggers_status` reports "dynamic rules: 1" plus the rule id and action.
	it("dispatch_new_trigger_registers_dynamic_rule", async () => {
		clearTriggerRegistries();
		const condition = "现在是 11pm";
		const action = "写一个 tmp 文件";
		const registration = fauxProvider();
		// pie: commands.rs:102-122 (`new_trigger_extraction_stream`) — the model calls NewTrigger on
		// the first turn and answers "created" once it sees the tool result.
		registration.setResponses(
			Array.from({ length: 8 }, () => (context: Context) => {
				const hasToolResult = context.messages.some((m) => m.role === "toolResult");
				return hasToolResult
					? fauxAssistantMessage("created")
					: fauxAssistantMessage([fauxToolCall("NewTrigger", { condition, action }, { id: "call-new-trigger" })]);
			}),
		);
		const session = new Session(new InMemorySessionStorage());
		const agent = newAgentHarness(session, {
			model: registration.getModel() as Model<any>,
			// pie: commands.rs:876 (`opts.tools = vec![Arc::new(triggers::NewTriggerTool)]`).
			tools: triggerToolDefinitions().filter((t) => t.name === "NewTrigger") as unknown as AgentTool[],
		});
		const harness = new TestCommandHarness(agent, session);

		const outcome = await dispatch(
			`/new-trigger 随便说一句: ${condition}; ${action}`,
			registryWithBuiltins(),
			newCtx(harness),
		);
		expect(outcome.kind, `expected RunAgentPrompt outcome, got ${JSON.stringify(outcome)}`).toBe("run_agent_prompt");
		if (outcome.kind !== "run_agent_prompt") throw new Error("unreachable");
		expect(outcome.errorContext).toBe("create trigger: ");
		expect(outcome.prompt).toContain(condition);
		expect(outcome.prompt).toContain(action);
		expect(
			globalRegistry().list(),
			"/new-trigger dispatch should not run the agent directly; the TUI owns Ctrl-C abort handling",
		).toEqual([]);

		await agent.prompt(outcome.prompt);

		const rules = globalRegistry().list();
		expect(rules.length).toBe(1);
		expect(rules[0]?.condition).toBe(condition);
		expect(rules[0]?.action).toBe(action);
		const statusLines = renderTriggersStatus(agent.notificationStatusSnapshot());
		expect(statusLines.some((line) => line.includes("dynamic rules: 1"))).toBe(true);
		expect(statusLines.some((line) => line.includes(rules[0]?.id ?? "<none>"))).toBe(true);
		expect(statusLines.some((line) => line.includes("tmp"))).toBe(true);
		expect(
			(await session.getEntries()).length,
			"/new-trigger routes through the agent so the model can extract condition/action",
		).toBeGreaterThan(0);
	});

	// oracle :939-970. `/triggers remove <id>` -> Handled; rule gone; session untouched.
	it("dispatch_triggers_remove_deletes_dynamic_rule", async () => {
		clearTriggerRegistries();
		const rule = globalRegistry().addRule("event says delete this", "echo deleted");
		captureOutput();
		const harness = newTestHarness();

		const outcome = await dispatch(`/triggers remove ${rule.id}`, registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind).toBe("handled");
		expect(globalRegistry().list()).toEqual([]);
		expect(await harness.rawSession.getEntries(), "/triggers remove only mutates the dynamic rule registry").toEqual(
			[],
		);
	});

	// oracle :972-1008. `/triggers disable <id>` then `enable <id>` -> Handled; `enabled` flips
	// both ways; session untouched.
	it("dispatch_triggers_disable_and_enable_updates_rule_state", async () => {
		clearTriggerRegistries();
		const rule = globalRegistry().addRule("event says toggle this", "echo toggled");
		captureOutput();
		const harness = newTestHarness();
		const registry = registryWithBuiltins();
		const ctx = newCtx(harness);

		expect((await dispatch(`/triggers disable ${rule.id}`, registry, ctx)).kind).toBe("handled");
		expect(globalRegistry().list()[0]?.enabled).toBe(false);

		expect((await dispatch(`/triggers enable ${rule.id}`, registry, ctx)).kind).toBe("handled");
		expect(globalRegistry().list()[0]?.enabled).toBe(true);
		expect(
			await harness.rawSession.getEntries(),
			"/triggers enable/disable only mutates the dynamic rule registry",
		).toEqual([]);
	});

	// oracle :1010-1113. `/cron add "*/10 * * * *" …` -> Handled and a job with that exact
	// schedule/action/enabled; `/cron list` renders "Cron jobs (session, 1):"; disable/enable/
	// remove each Handled; and the session accumulates exactly 4 `cron_control_plane` audits with
	// op add/disable/enable/remove, actor "slash", before/after_enabled flags, `next_run` on the
	// enabled add, and `removed: true` on the remove. Registry semantics: test/ported/cron.test.ts.
	it("dispatch_cron_add_lists_toggles_and_removes_job", async () => {
		clearTriggerRegistries();
		captureOutput();
		const harness = newTestHarness();
		const registry = registryWithBuiltins();
		const ctx = newCtx(harness);

		expect((await dispatch('/cron add "*/10 * * * *" summarize the repo state', registry, ctx)).kind).toBe("handled");
		const jobs = globalCronRegistry().list();
		expect(jobs.length).toBe(1);
		expect(jobs[0]?.schedule).toBe("*/10 * * * *");
		expect(jobs[0]?.action).toBe("summarize the repo state");
		expect(jobs[0]?.enabled).toBe(true);

		expect((await dispatch("/cron list", registry, ctx)).kind).toBe("handled");
		const rendered = renderCronJobs([globalCronRegistry().list()[0]!]).join("\n");
		expect(rendered, `cron list should label session scope: ${rendered}`).toContain("Cron jobs (session, 1):");
		expect(rendered).toContain("summarize the repo state");

		const id = jobs[0]!.id;
		expect((await dispatch(`/cron disable ${id}`, registry, ctx)).kind).toBe("handled");
		expect(globalCronRegistry().list()[0]?.enabled).toBe(false);
		expect((await dispatch(`/cron enable ${id}`, registry, ctx)).kind).toBe("handled");
		expect(globalCronRegistry().list()[0]?.enabled).toBe(true);
		expect((await dispatch(`/cron remove ${id}`, registry, ctx)).kind).toBe("handled");
		expect(globalCronRegistry().list()).toEqual([]);

		const entries = await harness.rawSession.getEntries();
		const audits = customEntries(entries, "cron_control_plane");
		expect(audits.length, `cron writes should be audited: ${JSON.stringify(entries)}`).toBe(4);
		expect(audits[0]?.op).toBe("add");
		expect(audits[0]?.actor).toBe("slash");
		expect(audits[0]?.after_enabled).toBe(true);
		expect(
			typeof audits[0]?.next_run,
			`enabled cron audit should include next_run: ${JSON.stringify(audits[0])}`,
		).toBe("string");
		expect(audits[1]?.op).toBe("disable");
		expect(audits[1]?.before_enabled).toBe(true);
		expect(audits[1]?.after_enabled).toBe(false);
		expect(audits[2]?.op).toBe("enable");
		expect(audits[3]?.op).toBe("remove");
		expect(audits[3]?.removed).toBe(true);
	});

	// oracle :1115-1127. `commands::render_cron_jobs` redacts secret-like action text
	// ("[REDACTED:" present, the `sk-…` literal absent). The redaction primitive itself:
	// test/ported/cron.test.ts's `trigger_summary_redacts_secret_like_action_text`.
	it("dispatch_cron_list_redacts_secret_like_action_preview", () => {
		clearTriggerRegistries();
		const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
		globalCronRegistry().addJob("* * * * *", `use ${secret}`);

		const rendered = renderCronJobs(globalCronRegistry().list()).join("\n");
		expect(rendered, rendered).not.toContain(secret);
		expect(rendered, rendered).toContain("[REDACTED:");
	});

	// oracle :1129-1175. `/cron add` writes a `cron_control_plane` audit whose serialized JSON
	// contains neither the `sk-…` secret nor "Bearer abcdefghijklmnop", but does contain
	// "[REDACTED:".
	it("dispatch_cron_add_audit_redacts_secret_like_action_preview", async () => {
		clearTriggerRegistries();
		captureOutput();
		const harness = newTestHarness();
		const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";

		const outcome = await dispatch(
			`/cron add "0 * * * *" call API with Bearer abcdefghijklmnop and ${secret}`,
			registryWithBuiltins(),
			newCtx(harness),
		);
		expect(outcome.kind, JSON.stringify(outcome)).toBe("handled");

		const audits = customEntries(await harness.rawSession.getEntries(), "cron_control_plane");
		expect(audits.length, "cron add should write audit").toBeGreaterThan(0);
		const serialized = JSON.stringify(audits[0]);
		expect(serialized, serialized).not.toContain(secret);
		expect(serialized, serialized).not.toContain("Bearer abcdefghijklmnop");
		expect(serialized, serialized).toContain("[REDACTED:");
	});

	// oracle :1177-1206. `/triggers abort missing-trace` -> Error naming "no running trigger" and
	// the trace id; session untouched.
	it("dispatch_triggers_abort_missing_trace_returns_error", async () => {
		const harness = newTestHarness();
		const outcome = await dispatch("/triggers abort missing-trace", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected Error outcome, got ${JSON.stringify(outcome)}`).toBe("error");
		if (outcome.kind !== "error") throw new Error("unreachable");
		expect(outcome.message).toContain("no running trigger");
		expect(outcome.message).toContain("missing-trace");
		expect(await harness.rawSession.getEntries(), "failed abort lookup must not mutate the session").toEqual([]);
	});

	// oracle :1208-1231. `/triggers abort --all` on a harness with nothing running -> Handled;
	// session untouched.
	it("dispatch_triggers_abort_all_empty_harness_is_handled_and_read_only", async () => {
		captureOutput();
		const harness = newTestHarness();
		const outcome = await dispatch("/triggers abort --all", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind).toBe("handled");
		expect(
			await harness.rawSession.getEntries(),
			"abort --all on an empty harness must not mutate the session",
		).toEqual([]);
	});

	// oracle :1233-1299. After one prompt (2 messages on the active branch), `/undo` -> Handled
	// and the active branch drops BOTH the user and the assistant message (back to 0).
	it("dispatch_undo_removes_last_turn_from_active_branch", async () => {
		const registration = fauxProvider();
		registration.setResponses([() => fauxAssistantMessage("ack-1")]);
		const session = new Session(new InMemorySessionStorage());
		const agent = newAgentHarness(session, { model: registration.getModel() as Model<any> });
		await agent.prompt("hi");

		// Sanity: there are now 2 messages on the active branch (1 user, 1 assistant).
		expect((await session.buildContext()).messages.length).toBe(2);

		captureOutput();
		const harness = new TestCommandHarness(agent, session);
		const outcome = await dispatch("/undo", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, JSON.stringify(outcome)).toBe("handled");

		expect(
			(await session.buildContext()).messages.length,
			"after /undo, both user + assistant should be off the active branch",
		).toBe(0);
	});

	// oracle :1301-1323. `/name my-thing` -> Handled; `session.session_name()` becomes "my-thing".
	it("dispatch_name_sets_session_name", async () => {
		captureOutput();
		const harness = newTestHarness();
		const outcome = await dispatch("/name my-thing", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind).toBe("handled");
		expect(await harness.rawSession.getSessionName()).toBe("my-thing");
	});

	// oracle :1325-1349. `/quit`, `/exit` and `/q` all map to `CommandOutcome::Quit`. The alias
	// table half is already ported and asserted in test/ported/commands.test.ts
	// (`findPieCommand`); only the Quit outcome is missing.
	it("dispatch_quit_returns_quit_outcome", async () => {
		const harness = newTestHarness();
		const registry = registryWithBuiltins();
		const ctx = newCtx(harness);
		for (const input of ["/quit", "/exit", "/q"]) {
			const outcome = await dispatch(input, registry, ctx);
			expect(outcome.kind, `${input} should map to Quit`).toBe("quit");
		}
	});

	// oracle :1351-1381. `/login ds4` -> `LoginSecret { provider: "ds4", storage_key: None,
	// recovery_command: None }` — i.e. the REPL prompts for the secret without echo instead of
	// taking it inline.
	it("dispatch_login_prompts_for_secret_instead_of_accepting_inline_key", async () => {
		const harness = newTestHarness();
		const outcome = await dispatch("/login ds4", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected LoginSecret outcome, got ${JSON.stringify(outcome)}`).toBe("login_secret");
		if (outcome.kind !== "login_secret") throw new Error("unreachable");
		expect(outcome.provider).toBe("ds4");
		expect(outcome.storageKey).toBeUndefined();
		expect(outcome.recoveryCommand).toBeUndefined();
	});

	// oracle :1383-1412. `/login ds4 sk-…` -> Error carrying "usage: /login <provider>" and NOT
	// repeating the inline secret. The argument policy itself is ported (`parseLoginArgv`) and
	// asserted in test/ported/commands.test.ts; only the dispatch-level Error outcome is missing.
	it("dispatch_login_rejects_inline_secret_material", async () => {
		const secret = "sk-inline-secret-should-not-be-accepted";
		const harness = newTestHarness();
		const outcome = await dispatch(`/login ds4 ${secret}`, registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected Error outcome, got ${JSON.stringify(outcome)}`).toBe("error");
		if (outcome.kind !== "error") throw new Error("unreachable");
		expect(outcome.message, outcome.message).toContain("usage: /login <provider>");
		expect(outcome.message, `error must not repeat inline secret: ${outcome.message}`).not.toContain(secret);
	});

	// oracle :1432-1476. `/share` shells out to a fake `gh` on PATH: argv contains "gist create",
	// and contains neither "--secret" (a removed gh flag) nor "--public" (private by default).
	it("dispatch_share_default_uses_gh_private_default_without_secret_flag", async () => {
		const temp = tempDir("pie-ported-commands-share-");
		const argvLog = join(temp, "argv.txt");
		installFakeGh(
			temp,
			`#!/bin/sh\nprintf '%s\\n' "$*" > '${argvLog}'\nprintf '%s\\n' 'https://gist.github.com/example/private'\n`,
		);
		captureOutput();
		const harness = newTestHarness();

		const outcome = await dispatch(
			"/share",
			registryWithBuiltins(),
			newCtx(harness, { sessionId: "test-share-default" }),
		);
		expect(outcome.kind, JSON.stringify(outcome)).toBe("handled");
		const argv = readFileSync(argvLog, "utf8");
		expect(argv, `argv: ${argv}`).toContain("gist create");
		expect(argv, `argv must not include removed gh flag: ${argv}`).not.toContain("--secret");
		expect(argv, `default share should remain private: ${argv}`).not.toContain("--public");
	});

	// oracle :1478-1518. `/share --public` -> argv contains "--public" and still no "--secret".
	it("dispatch_share_public_passes_public_flag", async () => {
		const temp = tempDir("pie-ported-commands-share-public-");
		const argvLog = join(temp, "argv.txt");
		installFakeGh(
			temp,
			`#!/bin/sh\nprintf '%s\\n' "$*" > '${argvLog}'\nprintf '%s\\n' 'https://gist.github.com/example/public'\n`,
		);
		captureOutput();
		const harness = newTestHarness();

		const outcome = await dispatch(
			"/share --public",
			registryWithBuiltins(),
			newCtx(harness, { sessionId: "test-share-public" }),
		);
		expect(outcome.kind, JSON.stringify(outcome)).toBe("handled");
		const argv = readFileSync(argvLog, "utf8");
		expect(argv, `argv: ${argv}`).toContain("--public");
		expect(argv, `argv must not include removed gh flag: ${argv}`).not.toContain("--secret");
	});

	// oracle :1520-1556. When the fake `gh` exits 1 with stderr, `/share` -> Error carrying both
	// "gh gist create exited 1" and the child's stderr verbatim.
	it("dispatch_share_preserves_gh_stderr_on_failure", async () => {
		const temp = tempDir("pie-ported-commands-share-fail-");
		installFakeGh(temp, "#!/bin/sh\nprintf '%s\\n' 'unknown flag: --secret' >&2\nexit 1\n");
		captureOutput();
		const harness = newTestHarness();

		const outcome = await dispatch(
			"/share",
			registryWithBuiltins(),
			newCtx(harness, { sessionId: "test-share-failure" }),
		);
		expect(outcome.kind, `expected Error outcome, got ${JSON.stringify(outcome)}`).toBe("error");
		if (outcome.kind !== "error") throw new Error("unreachable");
		expect(outcome.message, outcome.message).toContain("gh gist create exited 1");
		expect(outcome.message, outcome.message).toContain("unknown flag: --secret");
	});

	// oracle :1558-1590. `/skill review-pr` -> `AttachSkill { name: "review-pr" }`, and
	// `commands::attach_skill_prompt` composes a prompt naming the `Skill tool` + skill + user
	// text while never inlining the skill body.
	it("dispatch_skill_attaches_loaded_skill_without_exposing_body", async () => {
		captureOutput();
		const harness = newTestHarness({ skills: [commandSkill("review-pr", false)] });

		const outcome = await dispatch("/skill review-pr", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected AttachSkill outcome, got ${JSON.stringify(outcome)}`).toBe("attach_skill");
		if (outcome.kind !== "attach_skill") throw new Error("unreachable");
		expect(outcome.name).toBe("review-pr");

		const prompt = attachSkillPrompt("summarize the diff", "review-pr");
		expect(prompt).toContain("Skill tool");
		expect(prompt).toContain("review-pr");
		expect(prompt).toContain("summarize the diff");
		expect(prompt, "slash command must not inline skill body into the user-visible prompt").not.toContain(
			"SECRET SKILL BODY",
		);
	});

	// oracle :1592-1619. `/skill disabled-skill` -> Error naming the skill and
	// "disable_model_invocation=true", without echoing the body.
	it("dispatch_skill_refuses_disabled_skill", async () => {
		const harness = newTestHarness({ skills: [commandSkill("disabled-skill", true)] });
		const outcome = await dispatch("/skill disabled-skill", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected Error outcome, got ${JSON.stringify(outcome)}`).toBe("error");
		if (outcome.kind !== "error") throw new Error("unreachable");
		expect(outcome.message).toContain("disabled-skill");
		expect(outcome.message).toContain("disable_model_invocation=true");
		expect(outcome.message).not.toContain("SECRET SKILL BODY");
	});

	// oracle :1621-1673. `/skills disable review-pr` -> Handled; the harness reload applies the
	// overlay (`disable_model_invocation` true); the on-disk skills state records enabled=false
	// for (review-pr, User); and a `skill_control_plane` audit with actor "slash" and
	// after_enabled=false is written. Overlay file format: test/set-skill-state-tool.test.ts.
	it("dispatch_skills_disable_persists_overlay_and_reloads", async () => {
		const temp = tempDir("pie-ported-commands-skills-disable-");
		setEnv("PIE_DIR", temp);
		// pie: commands.rs:207-230 (`harness_with_reloadable_skills`) — a fixed seed re-read through
		// the on-disk overlay on every reload.
		const seed = [commandSkill("review-pr", false)];
		const harness = newTestHarness({
			skills: seed.map((s) => ({ ...s })),
			reload: async () => {
				const state = await loadSkillsState(temp);
				return {
					skills: seed.map((s) => {
						const override = lookupSkillState(state, s.name, s.source);
						return {
							...s,
							disableModelInvocation: override === undefined ? s.disableModelInvocation : !override.enabled,
						};
					}),
					diagnostics: [],
				};
			},
		});
		captureOutput();

		const outcome = await dispatch("/skills disable review-pr", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, JSON.stringify(outcome)).toBe("handled");

		const skill = harness.skills().find((s) => s.name === "review-pr");
		expect(skill?.disableModelInvocation, "reload should apply overlay").toBe(true);

		const state = await loadSkillsState(temp);
		expect(lookupSkillState(state, "review-pr", "user")?.enabled).toBe(false);

		const entries = await harness.rawSession.getEntries();
		const audit = customEntries(entries, "skill_control_plane").some(
			(data) => data.actor === "slash" && data.after_enabled === false,
		);
		expect(audit, `slash skill disable should write audit: ${JSON.stringify(entries)}`).toBe(true);
	});

	// oracle :1675-1724. `/skills enable formatter user` -> Handled; a frontmatter-disabled skill
	// may be explicitly re-enabled by the user; overlay records enabled=true; audit with actor
	// "slash" and after_enabled=true.
	it("dispatch_skills_enable_is_user_mediated_and_reuses_overlay", async () => {
		const temp = tempDir("pie-ported-commands-skills-enable-");
		setEnv("PIE_DIR", temp);
		const seed = [commandSkill("formatter", true)];
		const harness = newTestHarness({
			skills: seed.map((s) => ({ ...s })),
			reload: async () => {
				const state = await loadSkillsState(temp);
				return {
					skills: seed.map((s) => {
						const override = lookupSkillState(state, s.name, s.source);
						return {
							...s,
							disableModelInvocation: override === undefined ? s.disableModelInvocation : !override.enabled,
						};
					}),
					diagnostics: [],
				};
			},
		});
		captureOutput();

		const outcome = await dispatch("/skills enable formatter user", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, JSON.stringify(outcome)).toBe("handled");

		const skill = harness.skills().find((s) => s.name === "formatter");
		expect(
			skill?.disableModelInvocation,
			"user slash command may explicitly enable a frontmatter-disabled skill",
		).toBe(false);

		const state = await loadSkillsState(temp);
		expect(lookupSkillState(state, "formatter", "user")?.enabled).toBe(true);

		const entries = await harness.rawSession.getEntries();
		const audit = customEntries(entries, "skill_control_plane").some(
			(data) => data.actor === "slash" && data.after_enabled === true,
		);
		expect(audit, `slash skill enable should write audit: ${JSON.stringify(entries)}`).toBe(true);
	});

	// oracle :1726-1762. `/skills show review-pr project` -> Handled; console prints
	// "Skill: review-pr (project)", "Status: enabled", "Path:", and "Body: not shown" — never the
	// SKILL.md body.
	it("dispatch_skills_show_prints_metadata_without_body", async () => {
		const capture = captureOutput();
		const harness = newTestHarness({ skills: [commandSkill("review-pr", false, { source: "project" })] });

		const outcome = await dispatch("/skills show review-pr project", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind).toBe("handled");
		const text = capture.text();
		expect(text, text).toContain("Skill: review-pr (project)");
		expect(text, text).toContain("Status: enabled");
		expect(text, text).toContain("Path:");
		expect(text, `show should explain body omission:\n${text}`).toContain("Body: not shown");
		expect(text, `show must not print SKILL.md body:\n${text}`).not.toContain("SECRET SKILL BODY");
	});

	// oracle :1764-1795. `/skills reload` -> Handled; the harness's reload closure runs (a
	// deliberately staled catalog is refilled to 2) and console prints
	// "reloaded skills: 2 loaded, 0 diagnostics".
	it("dispatch_skills_reload_uses_harness_reload_and_prints_summary", async () => {
		const seed = [commandSkill("one", false), commandSkill("two", false)];
		const harness = newTestHarness({
			skills: seed.map((s) => ({ ...s })),
			reload: async () => ({ skills: seed.map((s) => ({ ...s })), diagnostics: [] }),
		});
		// Make the live catalog stale so the assertion proves `/skills reload` called the harness
		// reload closure rather than just recounting the current catalog.
		harness.replaceSkills([]);
		const capture = captureOutput();

		const outcome = await dispatch("/skills reload", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind).toBe("handled");
		expect(harness.skills().length, "reload should refresh catalog").toBe(2);
		expect(capture.text(), capture.text()).toContain("reloaded skills: 2 loaded, 0 diagnostics");
	});

	// oracle :1797-1855. `/skills install <path>` previews only (catalog unchanged; console shows
	// "skill install preview: db9" and "/skills install --confirm", no body); with `--confirm` the
	// skill lands in the catalog and console prints "installed skill 'db9'", still no body.
	// Installer mechanics: test/install-skill.test.ts.
	it("dispatch_skills_install_previews_then_confirms_without_body_echo", async () => {
		const temp = tempDir("pie-ported-commands-skills-install-");
		setEnv("PIE_DIR", temp);
		const sourceDir = join(temp, "incoming");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = join(sourceDir, "SKILL.md");
		writeFileSync(sourcePath, "---\nname: db9\ndescription: DB9 helper\n---\nSECRET SKILL BODY\n");

		// pie: commands.rs:232-263 (`harness_with_disk_skill_reload`) — the catalog is whatever is
		// on disk under `<PIE_DIR>/skills` at reload time.
		const harness = newTestHarness({ skills: [], reload: () => loadDiskSkills(temp) });
		const registry = registryWithBuiltins();
		const ctx = newCtx(harness, { cwd: temp });
		const capture = captureOutput();

		expect((await dispatch(`/skills install ${sourcePath}`, registry, ctx)).kind).toBe("handled");
		expect(harness.skills(), "preview should not mutate catalog").toEqual([]);
		let text = capture.text();
		expect(text, text).toContain("skill install preview: db9");
		expect(text, text).toContain("/skills install --confirm");
		expect(text, text).not.toContain("SECRET SKILL BODY");

		expect((await dispatch(`/skills install --confirm ${sourcePath}`, registry, ctx)).kind).toBe("handled");
		const skills = harness.skills();
		expect(skills.length).toBe(1);
		expect(skills[0]?.name).toBe("db9");
		text = capture.text();
		expect(text, text).toContain("installed skill 'db9'");
		expect(text, text).not.toContain("SECRET SKILL BODY");
	});

	// oracle :1857-1902. `/skills remove db9` previews only (files intact; "skill remove preview:
	// db9 (user)"); `--confirm` deletes the user skill dir, the reload drops it, and console
	// prints "removed skill 'db9'" — never the body.
	it("dispatch_skills_remove_previews_then_confirms_user_skill", async () => {
		const temp = tempDir("pie-ported-commands-skills-remove-");
		setEnv("PIE_DIR", temp);
		const skillDir = join(temp, "skills", "db9");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: db9\ndescription: DB9 helper\n---\nSECRET SKILL BODY\n");

		const harness = newTestHarness({
			skills: (await loadDiskSkills(temp)).skills,
			reload: () => loadDiskSkills(temp),
		});
		const registry = registryWithBuiltins();
		const ctx = newCtx(harness, { cwd: temp });
		const capture = captureOutput();

		expect((await dispatch("/skills remove db9", registry, ctx)).kind).toBe("handled");
		expect(existsSync(skillDir), "preview should not remove files").toBe(true);
		let text = capture.text();
		expect(text, text).toContain("skill remove preview: db9 (user)");
		expect(text, text).not.toContain("SECRET SKILL BODY");

		expect((await dispatch("/skills remove --confirm db9", registry, ctx)).kind).toBe("handled");
		expect(existsSync(skillDir), "confirm should remove user skill dir").toBe(false);
		expect(
			harness.skills().every((s) => s.name !== "db9"),
			"reload should drop removed skill",
		).toBe(true);
		text = capture.text();
		expect(text, text).toContain("removed skill 'db9'");
		expect(text, text).not.toContain("SECRET SKILL BODY");
	});

	// oracle :1904-1942. `/skills remove project-skill` -> Error saying it "cannot be removed" and
	// pointing at "/skills disable project-skill", without echoing the body.
	it("dispatch_skills_remove_project_skill_points_to_disable", async () => {
		const temp = tempDir("pie-ported-commands-skills-remove-project-");
		setEnv("PIE_DIR", join(temp, "agent"));
		const cwd = join(temp, "repo");
		const skillDir = join(cwd, ".pie", "skills", "project-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: project-skill\ndescription: project helper\n---\nSECRET SKILL BODY\n",
		);
		const harness = newTestHarness({ skills: [commandSkill("project-skill", false, { source: "project" })] });
		captureOutput();

		const outcome = await dispatch("/skills remove project-skill", registryWithBuiltins(), newCtx(harness, { cwd }));
		expect(outcome.kind, `expected Error outcome, got ${JSON.stringify(outcome)}`).toBe("error");
		if (outcome.kind !== "error") throw new Error("unreachable");
		expect(outcome.message, outcome.message).toContain("cannot be removed");
		expect(outcome.message, outcome.message).toContain("/skills disable project-skill");
		expect(outcome.message, outcome.message).not.toContain("SECRET SKILL BODY");
	});

	// oracle :1944-1971. `/skill rev` -> Error carrying "no skill named 'rev'" and
	// "Did you mean: review-pr", without echoing the body.
	it("dispatch_skill_unknown_name_suggests_prefix_matches", async () => {
		const harness = newTestHarness({ skills: [commandSkill("review-pr", false)] });
		const outcome = await dispatch("/skill rev", registryWithBuiltins(), newCtx(harness));
		expect(outcome.kind, `expected Error outcome, got ${JSON.stringify(outcome)}`).toBe("error");
		if (outcome.kind !== "error") throw new Error("unreachable");
		expect(outcome.message).toContain("no skill named 'rev'");
		expect(outcome.message).toContain("Did you mean: review-pr");
		expect(outcome.message).not.toContain("SECRET SKILL BODY");
	});
});
