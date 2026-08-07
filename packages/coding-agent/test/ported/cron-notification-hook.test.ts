/**
 * Extra characterization tests for CronNotificationHook.run() — the 30s tick loop that
 * `crates/coding-agent/src/triggers/cron.rs`'s `mod tests` does not unit-test directly (the
 * oracle exercises `due_jobs` on fixed instants instead; the tick loop itself is presumably
 * covered by an integration/e2e path elsewhere in the oracle repo). This unit still ports the
 * loop (constructor + `run`/`status`), so it gets test coverage here.
 *
 * RULEBOOK §2.2: "an interval tick becomes an injectable setTimeout loop" and "anything time-related
 * uses an injected clock rather than really sleeping 30s" —
 * uses vitest fake timers (`vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`), which
 * transparently replace the global `setTimeout` the production `sleep()` helper is built on, so
 * no real 30-second wait ever happens and no bespoke Clock injection API is needed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trigger } from "@pie/agent-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CronNotificationHook, CronRegistry } from "../../src/triggers/cron.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cron-hook-test-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	vi.useFakeTimers();
	// Pin the fake clock to an exact minute boundary: cron granularity is 1 minute (not the
	// scheduler's 30s tick period), so an arbitrary start time can leave "* * * * *" due
	// anywhere from 0-60s out. Starting exactly on :00 makes "next due" deterministically 60s
	// later (2 ticks), matching every test below.
	vi.setSystemTime(new Date(2026, 4, 26, 22, 0, 0, 0));
});

afterEach(() => {
	vi.useRealTimers();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

it("fires no triggers before the first 30s tick elapses", async () => {
	const registry = new CronRegistry();
	registry.loadFromPath(join(tempDir(), "cron.toml"));
	registry.addJob("* * * * *", "do work");

	const hook = new CronNotificationHook(registry);
	const sent: Trigger[] = [];
	const runPromise = hook.run({
		push: (trigger) => {
			sent.push(trigger);
			return true;
		},
	});

	await vi.advanceTimersByTimeAsync(29_000);
	expect(sent.length).toBe(0);

	hook.stop();
	// One more tick to unblock the `await sleep(...)` the loop is currently parked on.
	await vi.advanceTimersByTimeAsync(30_000);
	await runPromise;
});

it("fires a due job's trigger once its minute boundary is crossed and reflects it in status()", async () => {
	const registry = new CronRegistry();
	registry.loadFromPath(join(tempDir(), "cron.toml"));
	const job = registry.addJob("* * * * *", "do work");

	const hook = new CronNotificationHook(registry);
	const sent: Trigger[] = [];
	const runPromise = hook.run({
		push: (trigger) => {
			sent.push(trigger);
			return true;
		},
	});

	// First tick (t=30s): due at t=60s exactly (see beforeEach's minute-aligned system time), so
	// nothing fires yet.
	await vi.advanceTimersByTimeAsync(30_000);
	expect(sent.length).toBe(0);

	// Second tick (t=60s): crosses the minute boundary, job fires.
	await vi.advanceTimersByTimeAsync(30_000);
	expect(sent.length).toBe(1);
	expect(sent[0].event_label).toBe(job.id);
	expect(sent[0].source).toEqual({ kind: "local", subkind: "cron" });

	const status = hook.status();
	expect(status.state).toEqual({ kind: "connected" });
	expect(status.queued_count).toBe(1); // job.running_trace_id is now set
	expect(status.subscription_labels[0]).toContain("1 job(s)");

	hook.stop();
	await vi.advanceTimersByTimeAsync(30_000);
	await runPromise;
});

it("stops firing once the sink reports closed (SinkClosed)", async () => {
	const registry = new CronRegistry();
	registry.loadFromPath(join(tempDir(), "cron.toml"));
	registry.addJob("* * * * *", "do work");

	const hook = new CronNotificationHook(registry);
	// Attach the rejection handler synchronously (same tick as creation) so there is no window
	// where Node considers `runPromise` unhandled once the sink-closed rejection fires inside
	// the fake-timer-driven tick below.
	const settled = hook.run({ push: () => false }).then(
		() => ({ ok: true as const }),
		(err: unknown) => ({ ok: false as const, err }),
	);

	await vi.advanceTimersByTimeAsync(60_000);
	const result = await settled;
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.err).toBeInstanceOf(Error);
		expect((result.err as Error).message).toBe("sink closed");
	}

	expect(hook.status().state).toEqual({ kind: "disconnected", reason: "sink closed" });
});

it("status() reports zero jobs before any are added", () => {
	const registry = new CronRegistry();
	registry.loadFromPath(join(tempDir(), "cron.toml"));
	const hook = new CronNotificationHook(registry);
	expect(hook.status().subscription_labels).toEqual(["local crontab: 0 jobs"]);
});
