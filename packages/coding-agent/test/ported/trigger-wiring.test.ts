/**
 * Reachability tests for the phase-13 T2 trigger wiring.
 *
 * `migration/reviews/phase13/reachability-audit.md` §2 found B6 and B7 replicated only on code the
 * CLI never enters: `cron-tool-bugs.test.ts` proves the *classes* behave bug-for-bug, but the
 * classes had no registration site, so the product binary had no cron subsystem at all and those
 * tests were green against dead code. These tests close that loop by driving the SAME defects
 * through the objects the CLI actually registers — `triggerToolDefinitions()`, which `main.ts`
 * passes to `createAgentSessionFromServices` as `customTools` — and by locking the startup wiring
 * (`loadTriggerSubsystem`) that `main.ts` calls.
 *
 * Deliberately NOT a duplicate of `cron-tool-bugs.test.ts`: that file asserts the behavior exists;
 * this one asserts it is *reachable* through the registered objects. Both must stay.
 *
 * Phase 18 flipped the B6 pair here in lockstep with `cron-tool-bugs.test.ts`: the REGISTERED
 * `NewCronJob` now creates a DISABLED job (PORT-DIVERGENCE: B6 in `triggers/cron.ts`), so the
 * reachability question became "is the *gate* reachable" rather than "is the *defect* reachable".
 * B7 is untouched and still asserts the defect.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import {
	type CommandCtx,
	type CommandHarness,
	clearCommandSink,
	setCommandSink,
} from "../../src/core/slash-dispatch-deps.ts";
import { runCronCommand } from "../../src/core/slash-dispatch-triggers.ts";
import { globalCronRegistry, loopStatePath } from "../../src/triggers/cron.ts";
import {
	DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS,
	dynamicTriggerPollIntervalSecs,
	globalRegistry,
} from "../../src/triggers/dynamic.ts";
import { loadTriggerSubsystem, readTriggerPollIntervalSecs } from "../../src/triggers/runtime.ts";
import { triggerToolDefinitions } from "../../src/triggers/tool-definitions.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "trigger-wiring-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

let sessionFile: string;

beforeEach(() => {
	// Both registries are module-level singletons (oracle: `global_cron_registry()` /
	// `global_registry()` OnceCells). Point them at a fresh session per test.
	const dir = tempDir();
	sessionFile = join(dir, "session.jsonl");
	globalCronRegistry().loadFromPath(join(dir, "session.cron.toml"));
	globalRegistry().loadFromPath(join(dir, "session.triggers.json"));
});

const signal = new AbortController().signal;

/** `ToolDefinition.execute` takes an `ExtensionContext` the trigger tools never read. */
async function run(
	definition: ToolDefinition<any, any>,
	params: unknown,
): Promise<{ details: unknown; content: Array<{ type: string; text?: string }> }> {
	return definition.execute("call-1", params, signal, undefined, undefined as never);
}

/**
 * The `/cron add|enable|disable` paths touch `ctx` only for the best-effort `cron_control_plane`
 * audit (`slash-dispatch-triggers.ts` `writeCronControlPlaneAudit`, which swallows failures), so a
 * session stub is enough to drive the real human command handler here. The audit content itself is
 * covered by commands-e2e.test.ts against a real `AgentHarness`.
 */
function humanCtx(): CommandCtx {
	const harness = {
		session: () => ({ appendCustomEntry: async () => "audit-entry-id" }),
	} as unknown as CommandHarness;
	return { harness, sessionId: "trigger-wiring-session", toolCount: 0, cwd: process.cwd() };
}

function byName(name: string): ToolDefinition<any, any> {
	const definition = triggerToolDefinitions().find((d) => d.name === name);
	if (!definition) throw new Error(`tool ${name} is not registered`);
	return definition;
}

it("registers oracle's eight cron/trigger tools in main.rs:648-655 order", () => {
	expect(triggerToolDefinitions().map((d) => d.name)).toEqual([
		"NewCronJob",
		"ListCronJobs",
		"RemoveCronJob",
		"SetCronJobState",
		"NewTrigger",
		"ListTriggers",
		"RemoveTrigger",
		"SetTriggerState",
	]);
});

it("carries the dynamic tools' permission classifiers through the definition, and leaves cron's unset", () => {
	// dynamic.rs's NewTrigger/RemoveTrigger/SetTriggerState declare classifiers (issue #110
	// sub-PR 3); cron.rs's four do not. A definition that dropped them would silently remove the
	// control-plane gate, since AgentSession's registry is definition-first.
	expect(byName("NewTrigger").permissionClassification?.({ condition: "x", action: "y" })).toEqual({
		type: "prompt",
		reason: "create dynamic trigger from `condition` + `action` fields",
	});
	expect(byName("SetTriggerState").permissionClassification?.({ id: "dyn-1", enabled: false })).toEqual({
		type: "allow",
	});
	expect(byName("NewCronJob").permissionClassification).toBeUndefined();
});

it("PORT-DIVERGENCE B6 is live on the REGISTERED NewCronJob: the job is created disabled", async () => {
	const result = await run(byName("NewCronJob"), { schedule: "* * * * *", action: "do the thing" });
	const details = result.details as { enabled: boolean; id: string };
	expect(details.enabled).toBe(false);
	expect(
		globalCronRegistry()
			.list()
			.find((job) => job.id === details.id)?.enabled,
	).toBe(false);
	expect(result.content[0]?.text).toContain(
		`enabling cron jobs from model-facing tools requires user confirmation; use /cron enable ${details.id}`,
	);

	// And it stays inert: nothing the REGISTERED tool creates can reach a tick.
	const since = new Date("2026-01-01T00:00:00Z");
	const now = new Date("2026-01-01T00:05:00Z");
	expect(globalCronRegistry().dueJobs(since, now)).toEqual([]);
});

it("PORT-DIVERGENCE B6 is live on the REGISTERED SetCronJobState: model-driven enable still refused", async () => {
	const created = await run(byName("NewCronJob"), { schedule: "* * * * *", action: "do the thing" });
	const id = (created.details as { id: string }).id;

	await run(byName("SetCronJobState"), { id, enabled: false });
	await expect(run(byName("SetCronJobState"), { id, enabled: true })).rejects.toThrow(
		"enabling cron jobs from model-facing tools requires user confirmation; use /cron enable <id>",
	);
	expect(
		globalCronRegistry()
			.list()
			.find((job) => job.id === id)?.enabled,
	).toBe(false);
});

/**
 * The other side of the PORT-DIVERGENCE B6 boundary: only the MODEL-callable tool is gated. The
 * human control plane — the `/cron` slash command the CLI dispatches, which calls
 * `CronRegistry.addJobFull` with no `enabled` override — must still create-and-enable in one step,
 * exactly as the oracle does. Gating the registry instead of the tool would break precisely this.
 */
it("the human /cron path still creates an already-enabled job that fires on the next tick", async () => {
	const lines: string[] = [];
	setCommandSink((line) => lines.push(line));
	try {
		const outcome = await runCronCommand(["add", "* * * * *", "do", "the", "thing"], humanCtx());
		expect(outcome.kind, JSON.stringify(outcome)).toBe("handled");

		const jobs = globalCronRegistry().list();
		expect(jobs).toHaveLength(1);
		const job = jobs[0];
		if (job === undefined) throw new Error("unreachable");
		expect(job.action).toBe("do the thing");
		expect(job.enabled).toBe(true);
		expect(lines.join("\n")).toContain(`added cron job ${job.id}`);

		const since = new Date("2026-01-01T00:00:00Z");
		const now = new Date("2026-01-01T00:05:00Z");
		expect(
			globalCronRegistry()
				.dueJobs(since, now)
				.map(([due]) => due.id),
		).toEqual([job.id]);

		// …and `/cron disable` + `/cron enable` still round-trip through the same human path.
		expect((await runCronCommand(["disable", job.id], humanCtx())).kind).toBe("handled");
		expect(globalCronRegistry().list()[0]?.enabled).toBe(false);
		expect((await runCronCommand(["enable", job.id], humanCtx())).kind).toBe("handled");
		expect(globalCronRegistry().list()[0]?.enabled).toBe(true);
	} finally {
		clearCommandSink();
	}
});

it("BUG(port) B7 is reachable: the REGISTERED RemoveCronJob leaves loop-<id>.md on disk", async () => {
	const created = await run(byName("NewCronJob"), {
		schedule: "* * * * *",
		action: "watch things",
		stateful: true,
	});
	const id = (created.details as { id: string }).id;

	const sidecar = globalCronRegistry().storagePath();
	if (sidecar === undefined) throw new Error("registry has no storage path");
	const statePath = loopStatePath(sidecar, id);
	writeFileSync(statePath, "some prior loop notes", "utf8");

	await run(byName("RemoveCronJob"), { id, confirm: true });
	expect(
		globalCronRegistry()
			.list()
			.find((job) => job.id === id),
	).toBeUndefined();
	// The defect: the state file survives the removal.
	expect(existsSync(statePath)).toBe(true);
});

it("loadTriggerSubsystem composes oracle's hook and listener wiring (main.rs:773-780, 817-825, 1032-1037)", async () => {
	const agentDir = tempDir();
	const subsystem = await loadTriggerSubsystem({
		sessionFile,
		agentDir,
		mcp: { notificationHooks: [], injectSummaryServers: new Set(), injectAndRunServers: new Set() },
	});
	expect(subsystem.hooks.map((hook) => hook.label())).toEqual(["cron", "local:dynamic"]);
	expect(subsystem.listeners).toHaveLength(2);
	expect(subsystem.pollIntervalSecs).toBe(DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS);
	expect(subsystem.diagnostics.map((d) => d.message)).toContain(
		`triggers: local dynamic checker polls every ${DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS}s while enabled rules exist`,
	);
});

it("--trigger-poll-secs is consumed: CLI beats config beats default (main.rs:691-693, 1282-1308)", async () => {
	const agentDir = tempDir();
	// No config.toml at all -> built-in default.
	expect(await readTriggerPollIntervalSecs(agentDir, undefined)).toEqual({
		secs: DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS,
	});

	writeFileSync(join(agentDir, "config.toml"), "[triggers]\npoll_interval_secs = 60\n", "utf8");
	expect(await readTriggerPollIntervalSecs(agentDir, undefined)).toEqual({ secs: 60 });

	// CLI override wins over config.
	expect(await readTriggerPollIntervalSecs(agentDir, 15)).toEqual({ secs: 15 });

	// And the resolved value is actually applied to the module-level interval the
	// DynamicTriggerCheckHook reads in its constructor.
	await loadTriggerSubsystem({
		sessionFile,
		agentDir,
		cliPollIntervalSecs: 15,
		mcp: { notificationHooks: [], injectSummaryServers: new Set(), injectAndRunServers: new Set() },
	});
	expect(dynamicTriggerPollIntervalSecs()).toBe(15);
	// Restore the module-global so later tests in this process see the default.
	await loadTriggerSubsystem({
		sessionFile,
		agentDir: tempDir(),
		mcp: { notificationHooks: [], injectSummaryServers: new Set(), injectAndRunServers: new Set() },
	});
});

it("a malformed [triggers] poll interval is a diagnostic, not a startup failure (main.rs:1301-1304)", async () => {
	const agentDir = tempDir();
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "config.toml"), "[triggers]\npoll_interval_secs = 0\n", "utf8");
	const result = await readTriggerPollIntervalSecs(agentDir, undefined);
	expect(result.secs).toBe(DEFAULT_DYNAMIC_TRIGGER_POLL_INTERVAL_SECS);
	expect(result.diagnostic).toContain("triggers: ignoring invalid poll interval in");
});
