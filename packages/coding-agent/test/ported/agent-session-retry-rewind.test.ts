/**
 * Characterization tests for the `coding-agent/agent_session` diff-port.
 * pie: crates/coding-agent/src/agent_session.rs — `backoff_ms` (:213-217, tests :332-336),
 * `rewind_failed_assistant` (:172-210, test :339-381), and `RetrySettings::default()` (:37-47).
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@pie/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@pie/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, RETRY_MAX_DELAY_MS, retryBackoffMs } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager, type SessionMessageEntry } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("backoff_ms (pie agent_session.rs:213-217)", () => {
	it("grows exponentially and caps at max_delay_ms", () => {
		// pie: agent_session.rs:332-336 — the oracle's own assertions, verbatim.
		expect(retryBackoffMs(1, 1000, 60_000)).toBe(1000);
		expect(retryBackoffMs(2, 1000, 60_000)).toBe(2000);
		expect(retryBackoffMs(9, 1000, 60_000)).toBe(60_000);
	});

	it("clamps the exponent at 10 so a long chain cannot overflow", () => {
		// pie: agent_session.rs:214 — `attempt.saturating_sub(1).min(10)`.
		expect(retryBackoffMs(50, 1, Number.MAX_SAFE_INTEGER)).toBe(1024);
		expect(retryBackoffMs(11, 1, Number.MAX_SAFE_INTEGER)).toBe(1024);
	});

	it("uses the oracle default cap", () => {
		// pie: agent_session.rs:42
		expect(RETRY_MAX_DELAY_MS).toBe(60_000);
	});
});

describe("RetrySettings defaults (pie agent_session.rs:37-47)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pie-retry-defaults-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("defaults to 5 attempts with a 1s base delay", () => {
		// Oracle ships `RetrySettings::default()` unconditionally (main.rs:861) — these literals
		// are the shipped behavior, not a configurable suggestion.
		const settings = SettingsManager.create(tempDir, tempDir).getRetrySettings();
		expect(settings.enabled).toBe(true);
		expect(settings.maxRetries).toBe(5);
		expect(settings.baseDelayMs).toBe(1000);
	});
});

describe("rewind_failed_assistant (pie agent_session.rs:172-210)", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pie-retry-rewind-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("keeps the failed assistant in the log but off the active branch", async () => {
		// pie: agent_session.rs:339-381 — `retry_rewinds_failed_assistant_out_of_active_session_branch`.
		let callCount = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						const msg = assistantMessage("temporary failure", {
							stopReason: "error",
							errorMessage: "HTTP 503",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = assistantMessage("ok");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		await session.prompt("hi");
		expect(callCount).toBe(2);

		const isErrorAssistant = (message: AgentMessage): boolean =>
			message.role === "assistant" && (message as AssistantMessage).stopReason === "error";

		// The append-only log still holds the failed turn (agent_session.rs:362-369).
		const logged = sessionManager
			.getEntries()
			.filter((entry): entry is SessionMessageEntry => entry.type === "message")
			.map((entry) => entry.message);
		expect(logged.some(isErrorAssistant)).toBe(true);

		// ...but the active branch context does not (agent_session.rs:371-380).
		const active = sessionManager.buildSessionContext().messages;
		expect(active.some(isErrorAssistant)).toBe(false);
		expect(active.some((m) => m.role === "assistant" && (m as AssistantMessage).stopReason === "stop")).toBe(true);

		// And the retried context handed to the model was already error-free
		// (agent_session.rs:146-148).
		expect(agent.state.messages.some(isErrorAssistant)).toBe(false);
	});
});
