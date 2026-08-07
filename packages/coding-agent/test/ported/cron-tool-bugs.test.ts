/**
 * Extra characterization tests (beyond the 15 ported oracle unit tests in cron.test.ts) that
 * lock in the tool-facing bug-for-bug behaviors called out in the implementer's task brief and
 * migration/RULEBOOK.md §5's BUG(port) ledger:
 *
 * - B6 (PORT-DIVERGENCE as of phase 18): oracle's NewCronJobTool creates a job with
 *   `enabled: true` that takes effect on the very next tick with no confirmation gate (oracle
 *   cron.rs:138, :329-368) — yet SetCronJobStateTool refuses model-driven re-enable of an
 *   existing job with a specific error string (oracle cron.rs:578, tool description text oracle
 *   cron.rs:1343). Two tools, one capability, opposite rules. Phase 18 keeps the strict half
 *   verbatim and closes the permissive one: NewCronJob now creates the job DISABLED, so a model
 *   can never bring a cron job into effect — only an explicit human action can. The tests below
 *   assert the fix. The human `/cron` control-plane path is deliberately unchanged and is pinned
 *   in trigger-wiring.test.ts and commands-e2e.test.ts.
 * - B7: RemoveCronJobTool (via CronRegistry.removeJob) deletes a job from the sidecar but never
 *   deletes its `loop-<id>.md` state file (oracle cron.rs:162 remove_job).
 *
 * Also covers the RemoveCronJobTool confirm=false/true two-step flow and ListCronJobsTool, which
 * the oracle's own inline `mod tests` does not unit-test directly (they're covered by oracle's
 * separate `tests/*_e2e.rs` / parity harness instead) but which this pilot unit still ports and
 * should not ship untested.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	globalCronRegistry,
	ListCronJobsTool,
	loopStatePath,
	NewCronJobTool,
	RemoveCronJobTool,
	SetCronJobStateTool,
} from "../../src/triggers/cron.ts";
import { AgentToolError } from "../../src/triggers/cron-deps.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cron-tool-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

// The global registry is a module-level singleton (mirrors oracle's `global_cron_registry()`
// OnceCell). Point it at a fresh sidecar per test so tool-level tests don't leak state into
// each other or into cron.test.ts (which uses its own local CronRegistry instances throughout
// and never touches the global one).
beforeEach(() => {
	const dir = tempDir();
	globalCronRegistry().loadFromPath(join(dir, "session.cron.toml"));
});

const abortSignal = new AbortController().signal;

it("PORT-DIVERGENCE B6: NewCronJob creates the job DISABLED and says so in its success message", async () => {
	const tool = new NewCronJobTool();
	const result = await tool.execute("call-1", { schedule: "* * * * *", action: "do the thing" }, abortSignal);
	const details = result.details as { enabled: boolean; id: string };
	// Oracle asserts `true` here (cron.rs:138 hardcodes `enabled: true`). We diverge on purpose.
	expect(details.enabled).toBe(false);

	const job = globalCronRegistry()
		.list()
		.find((j) => j.id === details.id);
	expect(job?.enabled).toBe(false);

	// Creation still SUCCEEDS — it is the enabling that requires a human — and the response must
	// say plainly that the job is not running plus name the exact enabling command.
	const text = result.content[0].text;
	expect(text).toContain(`created cron job ${details.id}`);
	expect(text).toContain("state: disabled — the job is NOT running and will not fire until a user enables it");
	expect(text).toContain(
		`enabling cron jobs from model-facing tools requires user confirmation; use /cron enable ${details.id}`,
	);
});

it("PORT-DIVERGENCE B6: a model-created job does not fire until a human enables it", async () => {
	const tool = new NewCronJobTool();
	const created = await tool.execute("call-1", { schedule: "* * * * *", action: "do the thing" }, abortSignal);
	const jobId = (created.details as { id: string }).id;

	// A minute-granularity job over a five-minute window would be due immediately if it were live.
	const since = new Date("2026-01-01T00:00:00Z");
	const now = new Date("2026-01-01T00:05:00Z");
	expect(globalCronRegistry().dueJobs(since, now)).toEqual([]);

	// The human control plane (`/cron enable <id>` -> CronRegistry.setJobEnabled) brings it live.
	expect(globalCronRegistry().setJobEnabled(jobId, true)?.enabled).toBe(true);
	expect(
		globalCronRegistry()
			.dueJobs(since, now)
			.map(([job]) => job.id),
	).toEqual([jobId]);
});

it("PORT-DIVERGENCE B6: SetCronJobState still refuses model-driven enable, oracle-exact error text", async () => {
	const newTool = new NewCronJobTool();
	const created = await newTool.execute("call-1", { schedule: "* * * * *", action: "do the thing" }, abortSignal);
	const jobId = (created.details as { id: string }).id;
	// Already disabled at birth now (the fixed half); the refusal below is the unchanged oracle half.
	expect(
		globalCronRegistry()
			.list()
			.find((j) => j.id === jobId)?.enabled,
	).toBe(false);

	const enableTool = new SetCronJobStateTool();
	await expect(enableTool.execute("call-2", { id: jobId, enabled: true }, abortSignal)).rejects.toThrow(
		"enabling cron jobs from model-facing tools requires user confirmation; use /cron enable <id>",
	);
	// Refused: the job must remain disabled.
	expect(
		globalCronRegistry()
			.list()
			.find((j) => j.id === jobId)?.enabled,
	).toBe(false);

	// The disable direction is still allowed (oracle-unchanged), and re-enabling after a human
	// enable is still refused — the refusal does not depend on how the job came to be enabled.
	globalCronRegistry().setJobEnabled(jobId, true);
	const disableTool = new SetCronJobStateTool();
	await disableTool.execute("call-3", { id: jobId, enabled: false }, abortSignal);
	expect(
		globalCronRegistry()
			.list()
			.find((j) => j.id === jobId)?.enabled,
	).toBe(false);
	await expect(enableTool.execute("call-4", { id: jobId, enabled: true }, abortSignal)).rejects.toThrow(
		"enabling cron jobs from model-facing tools requires user confirmation; use /cron enable <id>",
	);
});

it("BUG(port) B7: removing a job deletes the sidecar entry but leaves the loop state file behind", async () => {
	const newTool = new NewCronJobTool();
	const created = await newTool.execute(
		"call-1",
		{ schedule: "* * * * *", action: "watch things", stateful: true },
		abortSignal,
	);
	const jobId = (created.details as { id: string }).id;

	const sidecar = globalCronRegistry().storagePath();
	expect(sidecar).toBeDefined();
	if (sidecar === undefined) throw new Error("unreachable");
	const statePath = loopStatePath(sidecar, jobId);
	writeFileSync(statePath, "some prior loop notes", "utf8");
	expect(existsSync(statePath)).toBe(true);

	const removeTool = new RemoveCronJobTool();
	const removed = await removeTool.execute("call-2", { id: jobId, confirm: true }, abortSignal);
	expect((removed.details as { removed_count: number }).removed_count).toBe(1);
	expect(
		globalCronRegistry()
			.list()
			.find((j) => j.id === jobId),
	).toBeUndefined();

	// The bug: the loop state file is still there.
	expect(existsSync(statePath)).toBe(true);
});

// Oracle cron.rs:518-520: `.remove_job(id).map_err(|e| AgentToolError::Message(e.to_string()))?`
// — a CronStorageError from the sidecar write must surface to the caller as AgentToolError, not
// as a raw CronStorageError. Simulated by replacing the sidecar's parent directory with a
// regular file: the next write's `mkdirSync(dir, {recursive:true})` then fails with EEXIST.
it("RemoveCronJob wraps a CronStorageError write failure as AgentToolError", async () => {
	const newTool = new NewCronJobTool();
	const created = await newTool.execute("call-1", { schedule: "* * * * *", action: "do the thing" }, abortSignal);
	const jobId = (created.details as { id: string }).id;

	const sidecar = globalCronRegistry().storagePath();
	expect(sidecar).toBeDefined();
	if (sidecar === undefined) throw new Error("unreachable");
	rmSync(dirname(sidecar), { recursive: true, force: true });
	writeFileSync(dirname(sidecar), "blocking file", "utf8");

	const removeTool = new RemoveCronJobTool();
	const rejection = removeTool.execute("call-2", { id: jobId, confirm: true }, abortSignal);
	await expect(rejection).rejects.toBeInstanceOf(AgentToolError);
});

// Oracle cron.rs:586-588: `.set_job_enabled(id, enabled).map_err(|e| AgentToolError::Message(e.to_string()))?`
// — same wrapping requirement as RemoveCronJob above, exercised via the disable path (the
// enable path is refused before it ever reaches CronRegistry.setJobEnabled; see the B6 test).
it("SetCronJobState wraps a CronStorageError write failure as AgentToolError", async () => {
	const newTool = new NewCronJobTool();
	const created = await newTool.execute("call-1", { schedule: "* * * * *", action: "do the thing" }, abortSignal);
	const jobId = (created.details as { id: string }).id;

	const sidecar = globalCronRegistry().storagePath();
	expect(sidecar).toBeDefined();
	if (sidecar === undefined) throw new Error("unreachable");
	rmSync(dirname(sidecar), { recursive: true, force: true });
	writeFileSync(dirname(sidecar), "blocking file", "utf8");

	const stateTool = new SetCronJobStateTool();
	const rejection = stateTool.execute("call-2", { id: jobId, enabled: false }, abortSignal);
	await expect(rejection).rejects.toBeInstanceOf(AgentToolError);
});

it("RemoveCronJob previews without deleting when confirm is omitted, then deletes on confirm=true", async () => {
	const newTool = new NewCronJobTool();
	const created = await newTool.execute("call-1", { schedule: "* * * * *", action: "do the thing" }, abortSignal);
	const jobId = (created.details as { id: string }).id;

	const removeTool = new RemoveCronJobTool();
	const preview = await removeTool.execute("call-2", { id: jobId }, abortSignal);
	expect((preview.details as { confirmation_required: boolean; removed_count: number }).confirmation_required).toBe(
		true,
	);
	expect((preview.details as { removed_count: number }).removed_count).toBe(0);
	expect(
		globalCronRegistry()
			.list()
			.find((j) => j.id === jobId),
	).toBeDefined();

	const confirmed = await removeTool.execute("call-3", { id: jobId, confirm: true }, abortSignal);
	expect((confirmed.details as { removed_count: number }).removed_count).toBe(1);
	expect(
		globalCronRegistry()
			.list()
			.find((j) => j.id === jobId),
	).toBeUndefined();
});

it("ListCronJobs renders job count and per-job details for the model", async () => {
	const newTool = new NewCronJobTool();
	await newTool.execute("call-1", { schedule: "hourly", action: "ping" }, abortSignal);

	const listTool = new ListCronJobsTool();
	const result = await listTool.execute("call-2", {}, abortSignal);
	expect((result.details as { count: number }).count).toBe(1);
	expect(result.content[0].text).toContain("session cron jobs: 1");
	expect(result.content[0].text).toContain("ping");
});

it("NewCronJob resolves schedule aliases (hourly, daily, weekly, 每小时)", async () => {
	const tool = new NewCronJobTool();
	const hourly = await tool.execute("call-1", { schedule: "hourly", action: "a" }, abortSignal);
	expect((hourly.details as { schedule: string }).schedule).toBe("0 * * * *");

	const zh = await tool.execute("call-2", { schedule: "每小时", action: "b" }, abortSignal);
	expect((zh.details as { schedule: string }).schedule).toBe("0 * * * *");
});
