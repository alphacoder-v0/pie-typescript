import type { AssistantMessage, ImageContent, Model, TextContent, Usage } from "@pie/ai";
import { isContextOverflow, streamSimple } from "@pie/ai";
import type { AgentMessage, StreamFn, ThinkingLevel } from "../../types.ts";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import { buildSessionContext } from "../session/session.ts";
import { type CompactionEntry, CompactionError, err, ok, type Result, type SessionTreeEntry } from "../types.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails {
	/** Files read in the compacted history. */
	readFiles: string[];
	/** Files modified in the compacted history. */
	modifiedFiles: string[];
}
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionTreeEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}
function getMessageFromEntry(entry: SessionTreeEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message as AgentMessage;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content as string | (TextContent | ImageContent)[],
			entry.display,
			entry.details,
			entry.timestamp,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionTreeEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactionResult<T = unknown> {
	/** Summary text that replaces compacted history in future context. */
	summary: string;
	/** Entry id where retained history starts. */
	firstKeptEntryId: string;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Optional implementation-specific details stored with the compaction entry. */
	details?: T;
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
	/** Enable automatic compaction decisions. */
	enabled: boolean;
	/** Tokens reserved for summary prompt and output. */
	reserveTokens: number;
	/** Approximate recent-context tokens to keep after compaction. */
	keepRecentTokens: number;
}

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			const usage = assistantMsg.usage;
			// pie: crates/agent/src/harness/compaction/compaction.rs:78-85 — an all-zero usage
			// block doesn't count as a usable checkpoint; treat it like "no usage" so callers keep
			// searching further back for a real one.
			if (
				usage.totalTokens === 0 &&
				usage.input === 0 &&
				usage.output === 0 &&
				usage.cacheRead === 0 &&
				usage.cacheWrite === 0
			) {
				return undefined;
			}
			return usage;
		}
	}
	return undefined;
}

/** Return usage from the last successful assistant message in session entries. */
export function getLastAssistantUsage(entries: SessionTreeEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message as AgentMessage);
			if (usage) return usage;
		}
	}
	return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent assistant usage block. */
	trailingTokens: number;
	/** Index of the message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	// pie: crates/agent/src/harness/compaction/compaction.rs:200-206 — trigger auto-compaction at
	// 80% of the context window (not window - reserveTokens) so there's still headroom for the
	// summarizer call and the next turn; waiting until window - reserveTokens risked the next
	// response overflowing the window before compaction had a chance to run.
	const threshold = Math.floor((contextWindow * 4) / 5);
	return contextTokens > threshold;
}

/**
 * Conservative char-class-aware text estimate: ~4 chars per token for ASCII, ~1 token per char
 * for non-ASCII (CJK and similar scripts tokenize close to one token per character). Rounds up.
 * pie: crates/agent/src/harness/compaction/compaction.rs:100-113 (estimate_text_tokens)
 */
export function estimateTextTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (const ch of text) {
		if (ch.codePointAt(0)! < 128) {
			ascii++;
		} else {
			nonAscii++;
		}
	}
	return Math.ceil(ascii / 4) + nonAscii;
}

/**
 * Flat per-image token weight, matching Anthropic's pricing approximation.
 * pie: crates/agent/src/harness/compaction/compaction.rs:138-141,148 (user_block_tokens /
 * content_block_tokens Image arms) — was inconsistently 0 (user/assistant images ignored) or
 * 1200 (toolResult/custom images, 4800 chars / 4) before this overlay.
 */
const IMAGE_TOKENS = 768;

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				return estimateTextTokens(content);
			}
			if (Array.isArray(content)) {
				let tokens = 0;
				for (const block of content) {
					if (block.type === "text" && block.text) {
						tokens += estimateTextTokens(block.text);
					} else if (block.type === "image") {
						tokens += IMAGE_TOKENS;
					}
				}
				return tokens;
			}
			return 0;
		}
		case "assistant": {
			// pie: crates/agent/src/harness/compaction/compaction.rs:144-154 (content_block_tokens)
			// weights an assistant-content Image block at IMAGE_TOKENS too, but @pie/ai's
			// AssistantMessage.content type (text | thinking | toolCall) structurally can't carry
			// an image block — nothing to overlay here.
			const assistant = message as AssistantMessage;
			let tokens = 0;
			for (const block of assistant.content) {
				if (block.type === "text") {
					tokens += estimateTextTokens(block.text);
				} else if (block.type === "thinking") {
					tokens += estimateTextTokens(block.thinking);
				} else if (block.type === "toolCall") {
					tokens += estimateTextTokens(block.name) + estimateTextTokens(safeJsonStringify(block.arguments));
				}
			}
			return tokens;
		}
		case "custom":
		case "toolResult": {
			if (typeof message.content === "string") {
				return estimateTextTokens(message.content);
			}
			let tokens = 0;
			for (const block of message.content) {
				if (block.type === "text" && block.text) {
					tokens += estimateTextTokens(block.text);
				}
				if (block.type === "image") {
					tokens += IMAGE_TOKENS;
				}
			}
			return tokens;
		}
		case "bashExecution": {
			return estimateTextTokens(message.command) + estimateTextTokens(message.output);
		}
		case "branchSummary":
		case "compactionSummary": {
			return estimateTextTokens(message.summary);
		}
	}

	return 0;
}
function findValidCutPoints(entries: SessionTreeEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
			case "leaf":
				break;
		}
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(entries: SessionTreeEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

/** Cut point selected for compaction. */
export interface CutPointResult {
	/** Index of the first entry retained after compaction. */
	firstKeptEntryIndex: number;
	/** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
	turnStartIndex: number;
	/** Whether the selected cut point splits an in-progress turn. */
	isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
	entries: SessionTreeEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	// pie: compaction.rs:245-269 (`find_cut_point`). When the keep-recent budget is NEVER
	// reached (the whole range fits inside `keepRecentTokens`), oracle leaves
	// `target = entries.len()`, so `find_turn_start_index(entries, target, 0)` clamps to the
	// last entry and walks back to the LAST turn boundary: everything before the final turn is
	// summarized. The pi skeleton defaulted to `cutPoints[0]` here -- keep everything,
	// summarize nothing -- which is the opposite direction. `cutPoints[0]` survives only as the
	// degenerate fallback for a range holding no turn boundary at all (oracle:
	// `find_turn_start_index` returns `start_index` in that case).
	const lastTurnStart = findTurnStartIndex(entries, endIndex - 1, startIndex);
	let cutIndex = lastTurnStart >= 0 ? lastTurnStart : cutPoints[0];

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokens(entry.message as AgentMessage);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Overflow-retry ceiling for the summarizer provider call: after this many context-overflow
 * rejections, compaction gives up instead of shrinking the prompt further.
 * pie: crates/agent/src/harness/compaction/compaction.rs:349 (MAX_SUMMARY_OVERFLOW_RETRIES)
 */
const MAX_SUMMARY_OVERFLOW_RETRIES = 3;

/**
 * Output cap sent as `maxTokens` on the summarizer call. Providers fall back to `model.maxTokens`
 * when unset, and `input + maxTokens > contextWindow` is a hard 400 on Anthropic — so the
 * summarizer must always send an explicit, bounded value.
 * pie: crates/agent/src/harness/compaction/compaction.rs:354-369 (summary_output_tokens)
 */
function summaryOutputTokens(model: Model<any>, reserveTokens: number): number {
	const reserve = reserveTokens > 0 ? reserveTokens : DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	let output = model.maxTokens > 0 ? Math.min(model.maxTokens, reserve) : reserve;
	if (model.contextWindow > 0) {
		output = Math.max(Math.min(output, Math.floor(model.contextWindow / 4)), 1);
	}
	return output;
}

/**
 * Halve a message list (dropping the oldest half) toward a smaller summarizer prompt after a
 * provider context-overflow rejection. Adapted from oracle's byte-budget-based trim
 * (trim_messages_for_summary_budget / serialize_conversation_for_summary_budget,
 * compaction.rs:398-484) to a message-count-based shrink: base's serializeConversation (utils.ts,
 * a separate migration unit) already truncates individual oversized tool results and isn't a
 * token-budget API, so an exact byte-budget port isn't available at this layer — this keeps the
 * same observable behavior (never fail compaction outright on overflow; retry with less,
 * disclosed, content) without re-deriving that machinery here.
 * pie: crates/agent/src/harness/compaction/compaction.rs:661-692 (compact's retry loop)
 */
function shrinkMessagesForOverflowRetry(messages: AgentMessage[]): { kept: AgentMessage[]; omitted: number } {
	const keep = Math.max(1, Math.ceil(messages.length / 2));
	return { kept: messages.slice(messages.length - keep), omitted: messages.length - keep };
}

/**
 * Token budget for the summary prompt, applied before sending.
 *
 * pie: `crates/agent/src/harness/compaction/compaction.rs:345-484`
 * （`summarization_prompt_budget` / `trim_messages_for_summary_budget` /
 *   `suffix_start_for_token_budget` / `serialize_conversation_for_summary_budget`）。
 *
 * **This layer did not exist here before.** The old approach sent the full prompt and, once
 * the provider refused it as too large, halved the message list and retried. The difference
 * is not cosmetic:
 *
 * - Every overflow burned a round trip, along with that request's input tokens. Upstream
 *   never sends an oversized prompt in the first place.
 * - Upstream deliberately leaves a fifth of the window as headroom, because estimating
 *   tokens by character class underestimates code and mixed scripts. Relying on the provider
 *   to refuse hands that headroom to the provider, and some of them shorten the input
 *   silently instead of erroring, which yields a quietly reduced summary with no signal.
 *
 * The overflow retry stays as a backstop: the budget is an estimate, and estimates can be wrong.
 */
const DEFAULT_SUMMARY_PROMPT_TOKEN_BUDGET = 64_000;
const SUMMARY_PROMPT_FRAMING_TOKENS = 512;

function summaryPromptOverheadTokens(customInstructions?: string): number {
	return (
		SUMMARY_PROMPT_FRAMING_TOKENS +
		estimateTextTokens(SUMMARIZATION_SYSTEM_PROMPT) +
		(customInstructions ? estimateTextTokens(customInstructions) : 0)
	);
}

function summarizePromptEstimateTokens(messages: AgentMessage[], customInstructions?: string): number {
	let conversation = 0;
	for (const m of messages) conversation += estimateTokens(m);
	return summaryPromptOverheadTokens(customInstructions) + conversation;
}

/**
 * The token budget available to the summary prompt.
 * pie: compaction.rs:371-379 — `(window - output) * 4 / 5`; that fifth is deliberate headroom.
 */
export function summarizationPromptBudget(model: Model<any>, reserveTokens: number): number {
	const window = model.contextWindow || 0;
	if (window === 0) return DEFAULT_SUMMARY_PROMPT_TOKEN_BUDGET;
	const output = summaryOutputTokens(model, reserveTokens);
	return Math.floor((Math.max(0, window - output) * 4) / 5);
}

/** pie: compaction.rs:398-436. Collects from the newest backwards until nothing more fits; the
 * number dropped is disclosed. */
function trimMessagesForSummaryBudget(
	messages: AgentMessage[],
	budgetTokens: number,
	customInstructions?: string,
): AgentMessage[] {
	if (summarizePromptEstimateTokens(messages, customInstructions) <= budgetTokens) {
		return [...messages];
	}

	const kept: AgentMessage[] = [];
	let total = summaryPromptOverheadTokens(customInstructions);
	for (let i = messages.length - 1; i >= 0; i--) {
		const messageTokens = estimateTokens(messages[i]);
		if (kept.length > 0 && total + messageTokens > budgetTokens) break;
		kept.push(messages[i]);
		total += messageTokens;
		if (total >= budgetTokens) break;
	}
	kept.reverse();

	const omitted = Math.max(0, messages.length - kept.length);
	if (omitted > 0) {
		kept.unshift({
			role: "user",
			content: `[compaction note: omitted ${omitted} older message(s) before summarization because the session exceeded the summarizer prompt budget]`,
			timestamp: Date.now(),
		} as AgentMessage);
	}
	return kept;
}

/**
 * The earliest character index a suffix of `s` can start at and still fit the budget.
 * pie: compaction.rs:439-457. Cuts on **character** boundaries rather than bytes, so surrogate
 * pairs stay intact.
 */
function suffixStartForTokenBudget(chars: string[], budgetTokens: number): number {
	let ascii = 0;
	let nonAscii = 0;
	let start = chars.length;
	for (let i = chars.length - 1; i >= 0; i--) {
		const isAscii = (chars[i].codePointAt(0) ?? 0) < 128;
		const nextAscii = isAscii ? ascii + 1 : ascii;
		const nextNonAscii = isAscii ? nonAscii : nonAscii + 1;
		if (Math.ceil(nextAscii / 4) + nextNonAscii > budgetTokens) break;
		ascii = nextAscii;
		nonAscii = nextNonAscii;
		start = i;
	}
	return start;
}

/**
 * Trim by message first, then shorten the serialised text at the tail: dropping messages
 * alone cannot bring a single oversized message under the budget.
 * pie: compaction.rs:459-484。
 */
export function serializeConversationForSummaryBudget(
	messages: AgentMessage[],
	budgetTokens: number,
	customInstructions?: string,
): string {
	const trimmed = trimMessagesForSummaryBudget(messages, budgetTokens, customInstructions);
	const conversation = serializeConversation(convertToLlm(trimmed));
	const availableTokens = Math.max(0, budgetTokens - summaryPromptOverheadTokens(customInstructions));
	if (estimateTextTokens(conversation) <= availableTokens) return conversation;

	const note =
		"[compaction note: omitted older serialized content before summarization because the session exceeded the summarizer prompt budget]\n\n";
	const noteTokens = estimateTextTokens(note);
	if (availableTokens <= noteTokens) {
		// The note is all ASCII, roughly four characters per token.
		return [...note].slice(0, availableTokens * 4).join("");
	}
	const chars = [...conversation];
	const start = suffixStartForTokenBudget(chars, availableTokens - noteTokens);
	return note + chars.slice(start).join("");
}

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	/**
	 * Overrides the stream function; falls back to `streamSimple` when absent.
	 * pie: compaction.rs:496 `GenerateSummaryRequest.stream_fn`，:535 `unwrap_or_else(default_stream_fn)`。
	 */
	streamFn?: StreamFn,
): Promise<Result<string, CompactionError>> {
	// pie: crates/agent/src/harness/compaction/compaction.rs:354-369 — cap output at
	// min(model.maxTokens, reserveTokens, contextWindow/4), not 0.8*reserveTokens.
	const maxTokens = summaryOutputTokens(model, reserveTokens);
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	let coreMessages = currentMessages;
	let omittedCount = 0;

	// pie: crates/agent/src/harness/compaction/compaction.rs:661-692 — retry with a shrunk prompt
	// instead of failing the whole compaction when the provider rejects the call as context
	// overflow. See shrinkMessagesForOverflowRetry for the message-count-based adaptation.
	for (let attempt = 0; ; attempt++) {
		let messagesForPrompt = coreMessages;
		if (omittedCount > 0) {
			const note: AgentMessage = {
				role: "user",
				content: `[compaction note: omitted ${omittedCount} older message(s) before summarization because the summarizer prompt was too large for the model]`,
				timestamp: Date.now(),
			};
			messagesForPrompt = [note, ...coreMessages];
		}
		// pie: compaction.rs:672 — trim to the budget **before** sending, rather than waiting for
		// the provider to refuse.
		const conversationText = serializeConversationForSummaryBudget(
			messagesForPrompt,
			summarizationPromptBudget(model, reserveTokens),
			customInstructions,
		);
		let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
		if (previousSummary) {
			promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
		}
		promptText += basePrompt;

		const summarizationMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: promptText }],
				timestamp: Date.now(),
			},
		];

		const completionOptions =
			model.reasoning && thinkingLevel && thinkingLevel !== "off"
				? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
				: { maxTokens, signal, apiKey, headers };

		const stream = await (streamFn ?? streamSimple)(
			model,
			{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
			completionOptions,
		);
		const response = await stream.result();
		if (response.stopReason === "aborted") {
			return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
		}
		if (response.stopReason === "error") {
			if (
				attempt < MAX_SUMMARY_OVERFLOW_RETRIES &&
				coreMessages.length > 1 &&
				isContextOverflow(response, model.contextWindow > 0 ? model.contextWindow : undefined)
			) {
				const shrunk = shrinkMessagesForOverflowRetry(coreMessages);
				coreMessages = shrunk.kept;
				omittedCount += shrunk.omitted;
				continue;
			}
			return err(
				new CompactionError(
					"summarization_failed",
					`Summarization failed: ${response.errorMessage || "Unknown error"}`,
				),
			);
		}

		const textContent = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		return ok(textContent);
	}
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
	/** Entry id where retained history starts. */
	firstKeptEntryId: string;
	/** Messages summarized into the history summary. */
	messagesToSummarize: AgentMessage[];
	/** Prefix messages summarized separately when compaction splits a turn. */
	turnPrefixMessages: AgentMessage[];
	/** Whether compaction splits a turn. */
	isSplitTurn: boolean;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Previous compaction summary used for iterative updates. */
	previousSummary?: string;
	/** File operations extracted from summarized history. */
	fileOps: FileOperations;
	/** Settings used to prepare compaction. */
	settings: CompactionSettings;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
	pathEntries: SessionTreeEntry[],
	settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
	if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
		return ok(undefined);
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return ok({
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	});
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export { serializeConversation } from "./utils.ts";

/** Generate compaction summary data from prepared session history. */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	/** Overrides the stream function, passed through to every model call below.
	 * pie: compaction.rs:640 `compact(.., stream_fn, ..)`. */
	streamFn?: StreamFn,
): Promise<Result<CompactionResult, CompactionError>> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	if (!firstKeptEntryId) {
		return err(new CompactionError("invalid_session", "First kept entry has no UUID - session may need migration"));
	}

	// pie: compaction.rs:643-651 -- `compact` short-circuits to an EMPTY summary when there is
	// nothing to summarize (`prep.entries_to_summarize.is_empty()`), WITHOUT calling the
	// summarizer. `doCompact` then drops the empty summary before persisting a compaction entry
	// or emitting `session_compact` (agent_harness.rs:2088-2090 + 2098-2099). Without this guard
	// a transcript whose entire history is already inside the keep-recent window still
	// round-trips through the summarizer and produces a bogus "compaction" of nothing.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		return ok({
			summary: "",
			firstKeptEntryId,
			tokensBefore,
			details: { readFiles, modifiedFiles } as CompactionDetails,
		});
	}

	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						headers,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
						streamFn,
					)
				: Promise.resolve(ok<string, CompactionError>("No prior history.")),
			generateTurnPrefixSummary(
				turnPrefixMessages,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				thinkingLevel,
				streamFn,
			),
		]);
		if (!historyResult.ok) return err(historyResult.error);
		if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
		summary = `${historyResult.value}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value}`;
	} else {
		const summaryResult = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
		);
		if (!summaryResult.ok) return err(summaryResult.error);
		summary = summaryResult.value;
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return ok({
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	});
}
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	/**
	 * Upstream has no counterpart, but this has to be threaded through too: `compact()` calls
	 * this function on the split-turn branch, and if the injected stream function does not
	 * reach here, a test that injected a fake would still make a real network request. A seam
	 * that leaks like that is worse than no seam at all.
	 */
	streamFn?: StreamFn,
): Promise<Result<string, CompactionError>> {
	// Turn-prefix summarization has no oracle counterpart (pie's compact() has no split-turn
	// concept); its own 0.5*reserveTokens output cap is left as-is. The overflow-retry loop below
	// mirrors generateSummary's for the same reason generateSummary has one: never fail
	// compaction outright on a provider context-overflow rejection.
	// pie: crates/agent/src/harness/compaction/compaction.rs:661-692
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	let coreMessages = messages;
	let omittedCount = 0;

	for (let attempt = 0; ; attempt++) {
		let messagesForPrompt = coreMessages;
		if (omittedCount > 0) {
			const note: AgentMessage = {
				role: "user",
				content: `[compaction note: omitted ${omittedCount} older message(s) before summarization because the summarizer prompt was too large for the model]`,
				timestamp: Date.now(),
			};
			messagesForPrompt = [note, ...coreMessages];
		}
		const llmMessages = convertToLlm(messagesForPrompt);
		const conversationText = serializeConversation(llmMessages);
		const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
		const summarizationMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: promptText }],
				timestamp: Date.now(),
			},
		];

		const stream = await (streamFn ?? streamSimple)(
			model,
			{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
			model.reasoning && thinkingLevel && thinkingLevel !== "off"
				? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
				: { maxTokens, signal, apiKey, headers },
		);
		const response = await stream.result();
		if (response.stopReason === "aborted") {
			return err(new CompactionError("aborted", response.errorMessage || "Turn prefix summarization aborted"));
		}
		if (response.stopReason === "error") {
			if (
				attempt < MAX_SUMMARY_OVERFLOW_RETRIES &&
				coreMessages.length > 1 &&
				isContextOverflow(response, model.contextWindow > 0 ? model.contextWindow : undefined)
			) {
				const shrunk = shrinkMessagesForOverflowRetry(coreMessages);
				coreMessages = shrunk.kept;
				omittedCount += shrunk.omitted;
				continue;
			}
			return err(
				new CompactionError(
					"summarization_failed",
					`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
				),
			);
		}

		return ok(
			response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n"),
		);
	}
}
