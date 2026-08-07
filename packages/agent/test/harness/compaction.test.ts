import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Message,
	type Model,
	registerFauxProvider,
	type Usage,
} from "@pie/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "../../src/harness/compaction/compaction.ts";
import { buildSessionContext } from "../../src/harness/session/session.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CompactionSettings,
	CustomMessageEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionTreeEntry,
	ThinkingLevelChangeEntry,
} from "../../src/harness/types.ts";
import { getOrThrow } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";

let nextId = 0;
function createId(): string {
	return `entry-${nextId++}`;
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createAssistantMessage(text: string, usage = createMockUsage(100, 50)): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMessageEntry(message: AgentMessage, parentId: string | null = null): MessageEntry {
	return {
		type: "message",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
}

function createCompactionEntry(
	summary: string,
	firstKeptEntryId: string,
	parentId: string | null = null,
): CompactionEntry {
	return {
		type: "compaction",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 1234,
	};
}

function createThinkingLevelEntry(level: string, parentId: string | null = null): ThinkingLevelChangeEntry {
	return {
		type: "thinking_level_change",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		thinkingLevel: level,
	};
}

function createModelChangeEntry(provider: string, modelId: string, parentId: string | null = null): ModelChangeEntry {
	return {
		type: "model_change",
		id: createId(),
		parentId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
}

function createFauxModel(
	reasoning: boolean,
	maxTokens = 8192,
): { faux: FauxProviderRegistration; model: Model<string> } {
	const faux = registerFauxProvider({
		models: [
			{
				id: reasoning ? "reasoning-model" : "non-reasoning-model",
				reasoning,
				contextWindow: 200000,
				maxTokens,
			},
		],
	});
	fauxRegistrations.push(faux);
	return { faux, model: faux.getModel() };
}

const fauxRegistrations: FauxProviderRegistration[] = [];

afterEach(() => {
	while (fauxRegistrations.length > 0) {
		fauxRegistrations.pop()?.unregister();
	}
});

describe("harness compaction", () => {
	beforeEach(() => {
		nextId = 0;
	});

	it("calculates total context tokens from usage", () => {
		expect(calculateContextTokens(createMockUsage(1000, 500, 200, 100))).toBe(1800);
		expect(calculateContextTokens(createMockUsage(0, 0, 0, 0))).toBe(0);
	});

	it("checks compaction threshold", () => {
		// pie: crates/agent/src/harness/compaction/compaction.rs:200-206 — the trigger is 80% of
		// the context window, not window - reserveTokens; reserveTokens no longer factors in.
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};
		// Threshold is 80% of 100_000 = 80_000.
		expect(shouldCompact(80001, 100000, settings)).toBe(true);
		expect(shouldCompact(80000, 100000, settings)).toBe(false);
		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(70000, 100000, settings)).toBe(false);
		expect(shouldCompact(95000, 100000, { ...settings, enabled: false })).toBe(false);
	});

	it("finds a cut point based on token differences", () => {
		const entries: SessionTreeEntry[] = [];
		let parentId: string | null = null;
		for (let i = 0; i < 10; i++) {
			const user = createMessageEntry(createUserMessage(`User ${i}`), parentId);
			entries.push(user);
			const assistant = createMessageEntry(
				createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0)),
				user.id,
			);
			entries.push(assistant);
			parentId = assistant.id;
		}

		const result = findCutPoint(entries, 0, entries.length, 2500);
		expect(entries[result.firstKeptEntryIndex]?.type).toBe("message");
	});

	it("covers cut-point and turn-start edge cases", () => {
		const thinking = createThinkingLevelEntry("high");
		const modelChange = createModelChangeEntry("openai", "gpt-4", thinking.id);
		expect(findCutPoint([thinking, modelChange], 0, 2, 1)).toEqual({
			firstKeptEntryIndex: 0,
			turnStartIndex: -1,
			isSplitTurn: false,
		});

		const branchSummary: BranchSummaryEntry = {
			type: "branch_summary",
			id: createId(),
			parentId: modelChange.id,
			timestamp: new Date().toISOString(),
			fromId: "branch",
			summary: "branch summary",
		};
		const customMessage: CustomMessageEntry = {
			type: "custom_message",
			id: createId(),
			parentId: branchSummary.id,
			timestamp: new Date().toISOString(),
			customType: "note",
			content: "custom content",
			display: true,
		};
		expect(findTurnStartIndex([thinking, branchSummary], 1, 0)).toBe(1);
		expect(findTurnStartIndex([thinking, customMessage], 1, 0)).toBe(1);
		expect(findTurnStartIndex([thinking, modelChange], 1, 0)).toBe(-1);

		const result = findCutPoint([thinking, branchSummary, customMessage], 0, 3, 1);
		expect(result.firstKeptEntryIndex).toBe(0);

		const toolResult = createMessageEntry({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "tool output" }],
			isError: false,
			timestamp: Date.now(),
		});
		expect(findCutPoint([toolResult], 0, 1, 1)).toEqual({
			firstKeptEntryIndex: 0,
			turnStartIndex: -1,
			isSplitTurn: false,
		});

		const user = createMessageEntry(createUserMessage("user"));
		const compaction = createCompactionEntry("summary", user.id, user.id);
		const assistant = createMessageEntry(createAssistantMessage("assistant"), compaction.id);
		expect(findCutPoint([user, compaction, assistant], 0, 3, 1).firstKeptEntryIndex).toBe(2);
	});

	it("falls back to the LAST turn boundary when the whole range fits the keep-recent budget", () => {
		// pie: compaction.rs:245-269 (`find_cut_point`). Oracle initializes `target =
		// entries.len()`, so a transcript that never fills `keep_recent_tokens` cuts at the last
		// turn start: every earlier turn is summarized. The pi skeleton defaulted to
		// `cutPoints[0]` here and therefore summarized NOTHING -- the opposite direction.
		const u1 = createMessageEntry(createUserMessage("turn 1 question"));
		const a1 = createMessageEntry(createAssistantMessage("turn 1 answer"), u1.id);
		const u2 = createMessageEntry(createUserMessage("turn 2 question"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("turn 2 answer"), u2.id);
		const entries: SessionTreeEntry[] = [u1, a1, u2, a2];

		expect(findCutPoint(entries, 0, entries.length, 50_000)).toEqual({
			firstKeptEntryIndex: 2,
			turnStartIndex: -1,
			isSplitTurn: false,
		});

		const preparation = getOrThrow(prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS));
		expect(preparation?.firstKeptEntryId).toBe(u2.id);
		expect(preparation?.messagesToSummarize.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("returns an empty summary without calling the summarizer when nothing precedes the last turn", async () => {
		// pie: compaction.rs:643-651 -- `entries_to_summarize.is_empty()` short-circuits to an
		// empty summary BEFORE any provider call; agent_harness.rs:2098-2099 then drops it. A
		// single-turn transcript is exactly that case once `find_cut_point` lands on its only
		// turn boundary.
		const u1 = createMessageEntry(createUserMessage("only turn"));
		const a1 = createMessageEntry(createAssistantMessage("only answer"), u1.id);
		const preparation = getOrThrow(prepareCompaction([u1, a1], DEFAULT_COMPACTION_SETTINGS));
		expect(preparation?.messagesToSummarize).toEqual([]);
		expect(preparation?.turnPrefixMessages).toEqual([]);

		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("summarizer must not be reached")]);
		const result = getOrThrow(await compact(preparation!, model, "test-key"));

		expect(result.summary).toBe("");
		expect(faux.state.callCount).toBe(0);
	});

	it("estimates tokens and context usage across supported message roles", () => {
		const usage = createMockUsage(10, 5, 3, 2);
		const assistant = createAssistantMessage("assistant", usage);
		const assistantWithThinkingAndTool: AssistantMessage = {
			...assistant,
			content: [
				{ type: "thinking", thinking: "thinking" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } },
			],
		};
		const customString: AgentMessage = {
			role: "custom",
			customType: "note",
			content: "custom text",
			display: true,
			timestamp: Date.now(),
		};
		const toolResultWithImage: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [
				{ type: "text", text: "tool text" },
				{ type: "image", mimeType: "image/png", data: "abc" },
			],
			isError: false,
			timestamp: Date.now(),
		};
		const bashExecution: AgentMessage = {
			role: "bashExecution",
			command: "npm run check",
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		};
		const branchSummaryMessage: AgentMessage = {
			role: "branchSummary",
			summary: "branch",
			fromId: "x",
			timestamp: Date.now(),
		};
		const compactionSummaryMessage: AgentMessage = {
			role: "compactionSummary",
			summary: "compact",
			tokensBefore: 123,
			timestamp: Date.now(),
		};

		expect(estimateTokens({ role: "user", content: "plain user", timestamp: Date.now() })).toBeGreaterThan(0);
		expect(estimateTokens(assistantWithThinkingAndTool)).toBeGreaterThan(0);
		expect(estimateTokens(customString)).toBeGreaterThan(0);
		// pie: crates/agent/src/harness/compaction/compaction.rs:138-141,148 — images are a flat
		// 768-token weight (was 1200 = 4800 chars / 4); "tool text" is 9 ASCII chars -> 3 tokens.
		expect(estimateTokens(toolResultWithImage)).toBe(3 + 768);
		expect(estimateTokens(bashExecution)).toBeGreaterThan(0);
		expect(estimateTokens(branchSummaryMessage)).toBeGreaterThan(0);
		expect(estimateTokens(compactionSummaryMessage)).toBeGreaterThan(0);
		expect(estimateTokens({ role: "unknown", timestamp: Date.now() } as unknown as AgentMessage)).toBe(0);
		expect(
			getLastAssistantUsage([createMessageEntry(createUserMessage("user")), createMessageEntry(assistant)]),
		).toBe(usage);
		expect(
			getLastAssistantUsage([
				createMessageEntry({ ...assistant, stopReason: "aborted" }),
				createMessageEntry({ ...assistant, stopReason: "error" }),
			]),
		).toBeUndefined();
		expect(estimateContextTokens([createUserMessage("no usage")]).lastUsageIndex).toBeNull();
		expect(estimateContextTokens([assistant, createUserMessage("tail")])).toMatchObject({
			usageTokens: 20,
			lastUsageIndex: 0,
		});
	});

	it("skips an all-zero usage checkpoint when locating the last assistant usage", () => {
		// pie: crates/agent/src/harness/compaction/compaction.rs:78-85 (assistant_usage) — an
		// all-zero usage block doesn't count as a usable checkpoint; keep searching further back.
		const realUsage = createMockUsage(500, 200);
		const zeroUsage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const withRealUsage = createAssistantMessage("first", realUsage);
		const withZeroUsage = createAssistantMessage("second", zeroUsage);
		expect(getLastAssistantUsage([createMessageEntry(withRealUsage), createMessageEntry(withZeroUsage)])).toBe(
			realUsage,
		);
		expect(getLastAssistantUsage([createMessageEntry(withZeroUsage)])).toBeUndefined();
	});

	it("builds session context with a compaction entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"), u1.id);
		const u2 = createMessageEntry(createUserMessage("2"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("b"), u2.id);
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id, a2.id);
		const u3 = createMessageEntry(createUserMessage("3"), compaction.id);
		const a3 = createMessageEntry(createAssistantMessage("c"), u3.id);
		const loaded = buildSessionContext([u1, a1, u2, a2, compaction, u3, a3]);
		expect(loaded.messages).toHaveLength(5);
		expect(loaded.messages[0]?.role).toBe("compactionSummary");
	});

	it("tracks model and thinking level changes in built context", () => {
		const user = createMessageEntry(createUserMessage("1"));
		const modelChange = createModelChangeEntry("openai", "gpt-4", user.id);
		const assistant = createMessageEntry(createAssistantMessage("a"), modelChange.id);
		const thinkingChange = createThinkingLevelEntry("high", assistant.id);
		const loaded = buildSessionContext([user, modelChange, assistant, thinkingChange]);
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(loaded.thinkingLevel).toBe("high");
	});

	it("prepares compaction using the latest compaction summary as previousSummary", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"), u1.id);
		const u2 = createMessageEntry(createUserMessage("user msg 2"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2", createMockUsage(5000, 1000)), u2.id);
		const compaction1 = createCompactionEntry("First summary", u2.id, a2.id);
		const u3 = createMessageEntry(createUserMessage("user msg 3"), compaction1.id);
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3", createMockUsage(8000, 2000)), u3.id);
		const pathEntries = [u1, a1, u2, a2, compaction1, u3, a3];
		const preparation = getOrThrow(prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS));
		expect(preparation).toBeDefined();
		expect(preparation?.previousSummary).toBe("First summary");
		expect(preparation?.firstKeptEntryId).toBeTruthy();
		expect(preparation?.tokensBefore).toBe(estimateContextTokens(buildSessionContext(pathEntries).messages).tokens);
	});

	it("prepares split-turn compaction with prior file-operation details", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1"));
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage("assistant msg 1"),
			content: [{ type: "toolCall", id: "tool-1", name: "write", arguments: { path: "written.ts" } }],
		};
		const a1 = createMessageEntry(assistantMessage, u1.id);
		const compaction1: CompactionEntry = {
			...createCompactionEntry("First summary", u1.id, a1.id),
			details: { readFiles: ["old-read.ts"], modifiedFiles: ["old-edit.ts"] },
		};
		const u2 = createMessageEntry(createUserMessage("large turn"), compaction1.id);
		const a2 = createMessageEntry(createAssistantMessage("large assistant message"), u2.id);
		const preparation = getOrThrow(
			prepareCompaction([u1, a1, compaction1, u2, a2], {
				enabled: true,
				reserveTokens: 100,
				keepRecentTokens: 1,
			}),
		);

		expect(preparation).toMatchObject({ previousSummary: "First summary", isSplitTurn: true });
		expect(preparation?.turnPrefixMessages.map((message) => message.role)).toEqual(["user"]);
		expect([...preparation!.fileOps.read]).toContain("old-read.ts");
		expect([...preparation!.fileOps.edited]).toContain("old-edit.ts");
		expect([...preparation!.fileOps.written]).toContain("written.ts");
	});

	it("prepares custom and branch summary entries for summarization", () => {
		const branchSummary: BranchSummaryEntry = {
			type: "branch_summary",
			id: createId(),
			parentId: null,
			timestamp: new Date().toISOString(),
			fromId: "branch",
			summary: "branch summary",
		};
		const customMessage: CustomMessageEntry = {
			type: "custom_message",
			id: createId(),
			parentId: branchSummary.id,
			timestamp: new Date().toISOString(),
			customType: "note",
			content: "custom content",
			display: true,
		};
		const user = createMessageEntry(createUserMessage("keep"), customMessage.id);
		const assistant = createMessageEntry(createAssistantMessage("assistant"), user.id);
		const preparation = getOrThrow(
			prepareCompaction([branchSummary, customMessage, user, assistant], {
				enabled: true,
				reserveTokens: 100,
				keepRecentTokens: 1,
			}),
		);

		expect(preparation?.messagesToSummarize.map((message) => message.role)).toEqual(["branchSummary", "custom"]);
	});

	it("does not prepare compaction when there is nothing valid to compact", () => {
		const compaction = createCompactionEntry("already compacted", "entry-keep");
		expect(getOrThrow(prepareCompaction([compaction], DEFAULT_COMPACTION_SETTINGS))).toBeUndefined();
		expect(getOrThrow(prepareCompaction([], DEFAULT_COMPACTION_SETTINGS))).toBeUndefined();
	});

	// pie: crates/agent/src/harness/compaction/compaction.rs:286-342 (serialize_conversation) —
	// oracle does a raw, untruncated dump with USER:/ASSISTANT:/TOOL_RESULT[name]: prefixes. The
	// base implementation previously used bracketed `[User]:`/`[Assistant]:`/`[Tool result]:`
	// markers, grouped assistant content by block type instead of preserving original order, and
	// truncated tool results at 2000 chars — all base-only divergences, now removed (FF1,
	// migration/reviews/agent/forward-flags.md). These tests assert the oracle-exact format
	// byte-for-byte; the old "truncates long tool results" assertion is replaced by its opposite
	// (test below) since truncation itself was the divergence being removed.
	describe("serializeConversation (oracle format parity)", () => {
		it("does not truncate long tool results — oracle serialize_conversation never truncates", () => {
			const longContent = "x".repeat(5000);
			const messages = convertMessages([
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "read",
					content: [{ type: "text", text: longContent }],
					isError: false,
					timestamp: Date.now(),
				},
			]);
			const result = serializeConversation(messages);
			expect(result).toBe(`TOOL_RESULT[read]:\n${longContent}\n\n`);
			expect(result).not.toContain("truncated");
		});

		it("serializes a plain-string user message with the USER: prefix", () => {
			const messages: Message[] = [{ role: "user", content: "hello there", timestamp: Date.now() }];
			expect(serializeConversation(messages)).toBe("USER:\nhello there\n\n");
		});

		it("serializes a block-content user message, rendering image blocks inline as <image>", () => {
			const messages: Message[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "look at this: " },
						{ type: "image", data: "base64data", mimeType: "image/png" },
						{ type: "text", text: " what is it?" },
					],
					timestamp: Date.now(),
				},
			];
			expect(serializeConversation(messages)).toBe("USER:\nlook at this: <image> what is it?\n\n");
		});

		it("serializes an empty-string user message as a bare USER: section (no content skip)", () => {
			// pie: compaction.rs:290-304 pushes "USER:\n" + content + "\n\n" unconditionally — unlike
			// base's old `if (content) parts.push(...)`, an empty message still produces a section.
			const messages: Message[] = [{ role: "user", content: "", timestamp: Date.now() }];
			expect(serializeConversation(messages)).toBe("USER:\n\n\n");
		});

		it("serializes assistant content blocks in original order, not grouped by type", () => {
			// pie: compaction.rs:305-326 — text/thinking/toolCall interleave in message order; base
			// previously collected each type into its own bucket and re-ordered thinking before text
			// before tool calls regardless of original position.
			const messages: Message[] = [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Let me check. " },
						{ type: "thinking", thinking: "reasoning here" },
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
						{ type: "text", text: " done." },
					],
					api: "messages",
					provider: "anthropic",
					model: "claude",
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
				},
			];
			expect(serializeConversation(messages)).toBe(
				'ASSISTANT:\nLet me check. <thinking>reasoning here</thinking><tool_call name="read">{"path":"a.ts"}</tool_call> done.\n\n',
			);
		});

		it("serializes a tool result, dropping image blocks silently (no <image> marker)", () => {
			// pie: compaction.rs:327-335 — only UserContentBlock::Text arms contribute; unlike the
			// USER branch, ToolResult images are skipped rather than rendered as "<image>".
			const messages: Message[] = [
				{
					role: "toolResult",
					toolCallId: "tc1",
					toolName: "screenshot",
					content: [
						{ type: "text", text: "before " },
						{ type: "image", data: "base64data", mimeType: "image/png" },
						{ type: "text", text: "after" },
					],
					isError: false,
					timestamp: Date.now(),
				},
			];
			expect(serializeConversation(messages)).toBe("TOOL_RESULT[screenshot]:\nbefore after\n\n");
		});

		it("concatenates multiple messages back-to-back with each section's own trailing blank line", () => {
			const messages: Message[] = [
				{ role: "user", content: "hi", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "messages",
					provider: "anthropic",
					model: "claude",
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
				},
			];
			expect(serializeConversation(messages)).toBe("USER:\nhi\n\nASSISTANT:\nhello\n\n");
		});
	});

	// pie: compaction.rs:496 `GenerateSummaryRequest.stream_fn`、:535 `unwrap_or_else(default_stream_fn)`、
	// branch_summarization.rs:26 `summarize_branch(.., stream_fn, ..)`。
	//
	// Upstream's own three tests (compaction.rs:819/908/987) run by injecting a fake stream function:
	// testability is what the seam is for. This side had `completeSimple` hard-coded, so the same
	// purpose could only be served by a **global** registration through `registerFauxProvider`, the
	// way every other case in this file is written, with no way for a caller to override one call.
	//
	// The assertion that matters is not that the injected function was called, but that the global
	// provider was never touched. Asserting only the former would also pass if both ran — which is
	// exactly what a seam that is not connected looks like.
	it("generateSummary accepts an injected streamFn and no longer touches the globally registered provider", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const { faux, model } = createFauxModel(false);
		let fauxCalls = 0;
		faux.setResponses([
			() => {
				fauxCalls++;
				return fauxAssistantMessage("from the global provider — must not appear in the result");
			},
		]);

		let injectedCalls = 0;
		let seenApiKey: unknown;
		const injected = (_model: Model<any>, _context: unknown, options?: Record<string, unknown>) => {
			injectedCalls++;
			seenApiKey = options?.apiKey;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: fauxAssistantMessage("## Goal\ninjected stream function"),
				});
			});
			return stream;
		};

		const summary = getOrThrow(
			await generateSummary(
				messages,
				model,
				2000,
				"test-key",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				injected as never,
			),
		);

		expect(injectedCalls).toBe(1);
		expect(fauxCalls).toBe(0);
		expect(summary).toContain("injected stream function");
		// Every other argument passes through unchanged: the injection replaces, it does not bypass.
		expect(seenApiKey).toBe("test-key");
	});

	it("with no streamFn it falls back to the default implementation, where the global provider still applies", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const { faux, model } = createFauxModel(false);
		let fauxCalls = 0;
		faux.setResponses([
			() => {
				fauxCalls++;
				return fauxAssistantMessage("## Goal\ndefault path");
			},
		]);

		const summary = getOrThrow(await generateSummary(messages, model, 2000, "test-key"));

		expect(fauxCalls).toBe(1);
		expect(summary).toContain("default path");
	});

	it("passes reasoning through generateSummary only for reasoning models with thinking enabled", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux: fauxReasoning, model: reasoningModel } = createFauxModel(true);
		fauxReasoning.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		getOrThrow(
			await generateSummary(
				messages,
				reasoningModel,
				2000,
				"test-key",
				undefined,
				undefined,
				undefined,
				undefined,
				"medium",
			),
		);
		expect(seenOptions[0]).toMatchObject({ reasoning: "medium", apiKey: "test-key" });

		const { faux: fauxOff, model: offModel } = createFauxModel(true);
		fauxOff.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		getOrThrow(
			await generateSummary(messages, offModel, 2000, "test-key", undefined, undefined, undefined, undefined, "off"),
		);
		expect(seenOptions[1]).not.toHaveProperty("reasoning");

		const { faux: fauxNonReasoning, model: nonReasoningModel } = createFauxModel(false);
		fauxNonReasoning.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		getOrThrow(
			await generateSummary(
				messages,
				nonReasoningModel,
				2000,
				"test-key",
				undefined,
				undefined,
				undefined,
				undefined,
				"medium",
			),
		);
		expect(seenOptions[2]).not.toHaveProperty("reasoning");
	});

	it("includes previous summaries and custom instructions in generateSummary prompts", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		let promptText = "";
		const { faux, model } = createFauxModel(false);
		faux.setResponses([
			(context) => {
				const message = context.messages[0];
				const content = message?.role === "user" ? message.content : [];
				promptText = Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "";
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);

		const summary = getOrThrow(
			await generateSummary(
				messages,
				model,
				2000,
				"test-key",
				{ "x-test": "yes" },
				undefined,
				"focus",
				"old summary",
			),
		);

		expect(summary).toContain("Test summary");
		expect(promptText).toContain("<previous-summary>\nold summary\n</previous-summary>");
		expect(promptText).toContain("Additional focus: focus");
	});

	it("returns error results for failed or aborted summary generations", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const { faux: errorFaux, model: errorModel } = createFauxModel(false);
		errorFaux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
		const errorResult = await generateSummary(messages, errorModel, 2000, "test-key");
		expect(errorResult).toMatchObject({
			ok: false,
			error: { code: "summarization_failed", message: "Summarization failed: boom" },
		});

		const { faux: abortedFaux, model: abortedModel } = createFauxModel(false);
		abortedFaux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "stopped" })]);
		const abortedResult = await generateSummary(messages, abortedModel, 2000, "test-key");
		expect(abortedResult).toMatchObject({ ok: false, error: { code: "aborted", message: "stopped" } });
	});

	it("retries the summarizer with a shrunk, disclosed prompt after a context-overflow rejection", async () => {
		// pie: crates/agent/src/harness/compaction/compaction.rs:661-692 (compact's retry loop) —
		// don't fail the whole compaction on one provider context-overflow rejection; retry with
		// less (disclosed) content instead.
		const messages: AgentMessage[] = [
			createUserMessage(`old message one ${"x".repeat(400)}`),
			createUserMessage(`old message two ${"x".repeat(400)}`),
			createUserMessage(`old message three ${"x".repeat(400)}`),
			createUserMessage("recent message"),
		];
		const { faux, model } = createFauxModel(false);
		const promptsSeen: string[] = [];
		faux.setResponses([
			(context) => {
				const message = context.messages[0];
				const content = message?.role === "user" ? message.content : [];
				promptsSeen.push(Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "");
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "prompt is too long: 5500 tokens > 5000 maximum",
				});
			},
			(context) => {
				const message = context.messages[0];
				const content = message?.role === "user" ? message.content : [];
				promptsSeen.push(Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "");
				return fauxAssistantMessage("## Goal\nsummary after retry");
			},
		]);

		const result = getOrThrow(await generateSummary(messages, model, 2000, "test-key"));
		expect(result).toContain("summary after retry");
		expect(promptsSeen).toHaveLength(2);
		expect(promptsSeen[1]).toContain("[compaction note: omitted");
		expect(promptsSeen[1].length).toBeLessThan(promptsSeen[0].length);
	});

	it("gives up after exhausting overflow retries and surfaces the provider error", async () => {
		// pie: crates/agent/src/harness/compaction/compaction.rs:349,683-688 —
		// MAX_SUMMARY_OVERFLOW_RETRIES=3 retries after the initial attempt (4 calls total), then
		// the original context-overflow error propagates instead of retrying forever.
		const messages: AgentMessage[] = [
			createUserMessage("a"),
			createUserMessage("b"),
			createUserMessage("c"),
			createUserMessage("d"),
			createUserMessage("e"),
		];
		const { faux, model } = createFauxModel(false);
		let callCount = 0;
		const overflow = () => {
			callCount++;
			return fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "prompt is too long: 9999 tokens > 100 maximum",
			});
		};
		faux.setResponses([overflow, overflow, overflow, overflow]);

		const result = await generateSummary(messages, model, 2000, "test-key");
		expect(result).toMatchObject({ ok: false, error: { code: "summarization_failed" } });
		expect(callCount).toBe(4);
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux, model } = createFauxModel(false, 128000);
		faux.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		getOrThrow(await compact(preparation, model, "test-key"));

		// pie: crates/agent/src/harness/compaction/compaction.rs:354-369 (summary_output_tokens)
		// — the history-summary call additionally caps output at contextWindow/4 = 50_000
		// (200_000/4), landing below model.maxTokens (128_000). Turn-prefix summarization has no
		// oracle counterpart and keeps its own 0.5*reserveTokens-capped-by-maxTokens formula,
		// which is still clamped to 128_000 here.
		expect(seenOptions.map((options) => options?.maxTokens)).toEqual([50000, 128000]);
	});

	it("returns compaction error results without throwing", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};
		const { faux: historyFaux, model: historyModel } = createFauxModel(false);
		historyFaux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "history failed" })]);
		expect(await compact(preparation, historyModel, "test-key")).toMatchObject({
			ok: false,
			error: { code: "summarization_failed", message: "Summarization failed: history failed" },
		});

		const { model: invalidModel } = createFauxModel(false);
		const invalidResult = await compact(
			{ ...preparation, messagesToSummarize: [], firstKeptEntryId: "" },
			invalidModel,
			"test-key",
		);
		expect(invalidResult).toMatchObject({ ok: false, error: { code: "invalid_session" } });
	});

	it("passes reasoning through turn-prefix summaries when enabled", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { faux, model } = createFauxModel(true);
		faux.setResponses([
			(_context, options) => {
				seenOptions.push(options as Record<string, unknown> | undefined);
				return fauxAssistantMessage("## Original Request\nTest summary");
			},
		]);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		getOrThrow(await compact(preparation, model, "test-key", undefined, undefined, undefined, "high"));

		expect(seenOptions[0]).toMatchObject({ reasoning: "high" });
	});

	it("returns turn-prefix compaction errors without throwing", async () => {
		const messages: AgentMessage[] = [createUserMessage("Summarize this.")];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: [],
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "prefix failed" })]);

		expect(await compact(preparation, model, "test-key")).toMatchObject({
			ok: false,
			error: { code: "summarization_failed", message: "Turn prefix summarization failed: prefix failed" },
		});

		const { faux: abortedFaux, model: abortedModel } = createFauxModel(false);
		abortedFaux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "prefix stopped" })]);
		expect(await compact(preparation, abortedModel, "test-key")).toMatchObject({
			ok: false,
			error: { code: "aborted", message: "prefix stopped" },
		});
	});

	it("returns a compaction result with file details", async () => {
		const u1 = createMessageEntry(createUserMessage("read a file"));
		const assistantMessage: AssistantMessage = {
			...createAssistantMessage("calling tool", createMockUsage(1000, 200)),
			content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "src/index.ts" } }],
		};
		const a1 = createMessageEntry(assistantMessage, u1.id);
		const u2 = createMessageEntry(createUserMessage("continue"), a1.id);
		const a2 = createMessageEntry(createAssistantMessage("done", createMockUsage(4000, 500)), u2.id);
		const preparation = getOrThrow(prepareCompaction([u1, a1, u2, a2], DEFAULT_COMPACTION_SETTINGS));
		expect(preparation).toBeDefined();
		const { faux, model } = createFauxModel(false);
		faux.setResponses([fauxAssistantMessage("## Goal\nTest summary")]);
		const result = getOrThrow(await compact(preparation!, model, "test-key"));
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.firstKeptEntryId).toBeTruthy();
		expect(result.details).toBeDefined();
	});
});

function convertMessages(messages: Message[]): Message[] {
	return messages;
}
