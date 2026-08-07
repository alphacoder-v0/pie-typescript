import { HTTPClient, Mistral } from "@mistralai/mistralai";
import type {
	ChatCompletionStreamRequest,
	ChatCompletionStreamRequestMessage,
	CompletionEvent,
	ContentChunk,
	FunctionTool,
} from "@mistralai/mistralai/models/components";
import { getEnvApiKey } from "../env-api-keys.ts";
import { clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types.ts";
import { computeCost } from "../usage.ts";
import { abortedMessage } from "../utils/abort.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { userAgent } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sendWithRetry } from "../utils/retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

const MISTRAL_TOOL_CALL_ID_LENGTH = 9;
const MAX_MISTRAL_ERROR_BODY_CHARS = 4000;

/**
 * Provider-specific options for the Mistral API.
 */
type MistralReasoningEffort = "none" | "high";

export interface MistralOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } };
	promptMode?: "reasoning";
	reasoningEffort?: MistralReasoningEffort;
}

/**
 * Stream responses from Mistral using `chat.stream`.
 */
export const streamMistral: StreamFunction<"mistral-conversations", MistralOptions> = (
	model: Model<"mistral-conversations">,
	context: Context,
	options?: MistralOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createOutput(model);

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider);
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			// Intentionally per-request: avoids shared SDK mutable state across concurrent consumers.
			// pie: crates/ai/src/providers/mistral.rs:148 (run, `send_with_retry`) +
			// crates/ai/src/utils/retry.rs — oracle retries exclusively through
			// `crate::utils::retry::send_with_retry`, not the SDK's own retry loop (already disabled
			// below via `retries: { strategy: "none" }`, which previously left mistral with no retry
			// behavior at all instead of the shared `sendWithRetry` util every other provider uses).
			const mistral = new Mistral({
				apiKey,
				serverURL: model.baseUrl,
				httpClient: new HTTPClient({
					// The SDK's HTTPClient calls `fetcher(request)` with a single already-built `Request`
					// object whose body is a single-use stream; sendWithRetry's `doSend` contract requires
					// a fresh, replayable request per attempt (retry.ts:119-125), so clone it on every
					// attempt instead of re-fetching the same (already-consumed-after-attempt-1) Request.
					fetcher: (input, init) =>
						sendWithRetry(
							() => {
								const target = input instanceof Request ? input.clone() : input;
								if (target instanceof Request) {
									// pie: crates/ai/src/utils/node_http_proxy.rs:19-22 (build_client) +
									// crates/ai/src/utils/headers.rs:5-7 (user_agent) — oracle sets
									// User-Agent: pie-ai-rs/<version> as the HTTP client default. The Mistral
									// SDK's built-in CustomUserAgentHook (hooks/custom_user_agent.ts) runs
									// before this fetcher and unconditionally overwrites User-Agent with its
									// own "mistral-client-typescript/<sdk-version>", so the override has to
									// happen here, right before the network call.
									target.headers.set("User-Agent", userAgent());
								}
								return fetch(target, init);
							},
							{
								maxRetries: options?.maxRetries,
								maxRetryDelayMs: options?.maxRetryDelayMs,
								signal: options?.signal,
							},
						),
				}),
			});

			const normalizeMistralToolCallId = createMistralToolCallIdNormalizer();
			const transformedMessages = transformMessages(context.messages, model, (id) => normalizeMistralToolCallId(id));

			let payload = buildChatPayload(model, context, transformedMessages, options);
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload as ChatCompletionStreamRequest;
			}
			const mistralStream = await mistral.chat.stream(payload, buildRequestOptions(model, options));
			stream.push({ type: "start", partial: output });
			await consumeChatStream(model, output, stream, mistralStream);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				// partialArgs is only a streaming scratch buffer; never persist it.
				delete (block as { partialArgs?: string }).partialArgs;
			}
			// pie: crates/ai/src/utils/abort.rs:116-135 (`push_aborted`) — an abort pushes a
			// **fresh empty message**, not the accumulated output. This previously
			// carried out the partial content, the accumulated tokens and **cost**, and the
			// underlying error text, so an aborted turn reported a non-zero cost where upstream
			// reports zero.
			if (options?.signal?.aborted) {
				stream.push({ type: "error", reason: "aborted", error: abortedMessage(model) });
				stream.end();
				return;
			}
			output.stopReason = "error";
			output.errorMessage = formatMistralError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Maps provider-agnostic `SimpleStreamOptions` to Mistral options.
 */
export const streamSimpleMistral: StreamFunction<"mistral-conversations", SimpleStreamOptions> = (
	model: Model<"mistral-conversations">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		// pie: crates/ai/src/providers/mistral.rs:107-115 — oracle's `run()` reports the missing key
		// through the stream (`push_error`, mistral.rs:486-495), in this exact wording, rather than
		// as a thrown error. Same shape as anthropic.rs:182-191.
		return pushErrorStream(model, "MISTRAL_API_KEY is not set");
	}

	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
	const shouldUseReasoning = model.reasoning && reasoning !== undefined;

	return streamMistral(model, context, {
		...base,
		promptMode: shouldUseReasoning && usesPromptModeReasoning(model) ? "reasoning" : undefined,
		reasoningEffort:
			shouldUseReasoning && usesReasoningEffort(model) ? mapReasoningEffort(model, reasoning) : undefined,
	} satisfies MistralOptions);
};

/**
 * pie: crates/ai/src/providers/mistral.rs:486-495 (`push_error`) — an empty partial marked
 * `StopReason::Error` with `error_message`, emitted as the stream's single `Error` event, so the
 * failure travels through the stream (agent_loop.rs:317-319 turns it into `AgentRunError::Other`).
 */
function pushErrorStream(model: Model<"mistral-conversations">, message: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const error: AssistantMessage = { ...createOutput(model), stopReason: "error", errorMessage: message };
	stream.push({ type: "error", reason: "error", error });
	stream.end();
	return stream;
}

function createOutput(model: Model<"mistral-conversations">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
	};
}

function createMistralToolCallIdNormalizer(): (id: string) => string {
	const idMap = new Map<string, string>();
	const reverseMap = new Map<string, string>();

	return (id: string): string => {
		const existing = idMap.get(id);
		if (existing) return existing;

		let attempt = 0;
		while (true) {
			const candidate = deriveMistralToolCallId(id, attempt);
			const owner = reverseMap.get(candidate);
			if (!owner || owner === id) {
				idMap.set(id, candidate);
				reverseMap.set(candidate, id);
				return candidate;
			}
			attempt++;
		}
	};
}

function deriveMistralToolCallId(id: string, attempt: number): string {
	const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	if (attempt === 0 && normalized.length === MISTRAL_TOOL_CALL_ID_LENGTH) return normalized;
	const seedBase = normalized || id;
	const seed = attempt === 0 ? seedBase : `${seedBase}:${attempt}`;
	return shortHash(seed)
		.replace(/[^a-zA-Z0-9]/g, "")
		.slice(0, MISTRAL_TOOL_CALL_ID_LENGTH);
}

function formatMistralError(error: unknown): string {
	if (error instanceof Error) {
		const sdkError = error as Error & { statusCode?: unknown; body?: unknown };
		const statusCode = typeof sdkError.statusCode === "number" ? sdkError.statusCode : undefined;
		const bodyText = typeof sdkError.body === "string" ? sdkError.body.trim() : undefined;
		if (statusCode !== undefined && bodyText) {
			return `Mistral API error (${statusCode}): ${truncateErrorText(bodyText, MAX_MISTRAL_ERROR_BODY_CHARS)}`;
		}
		if (statusCode !== undefined) return `Mistral API error (${statusCode}): ${error.message}`;
		return error.message;
	}
	return safeJsonStringify(error);
}

function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

function buildRequestOptions(model: Model<"mistral-conversations">, options?: MistralOptions) {
	const requestOptions: {
		signal?: AbortSignal;
		retries: { strategy: "none" };
		headers?: Record<string, string>;
	} = {
		retries: { strategy: "none" },
	};
	if (options?.signal) requestOptions.signal = options.signal;

	const headers: Record<string, string> = {};
	if (model.headers) Object.assign(headers, model.headers);
	if (options?.headers) Object.assign(headers, options.headers);

	// Mistral infrastructure uses `x-affinity` for KV-cache reuse (prefix caching).
	// Respect explicit caller-provided header values.
	if (options?.sessionId && !headers["x-affinity"]) {
		headers["x-affinity"] = options.sessionId;
	}

	if (Object.keys(headers).length > 0) {
		requestOptions.headers = headers;
	}

	return requestOptions;
}

function buildChatPayload(
	model: Model<"mistral-conversations">,
	context: Context,
	messages: Message[],
	options?: MistralOptions,
): ChatCompletionStreamRequest {
	const payload: ChatCompletionStreamRequest = {
		model: model.id,
		stream: true,
		messages: toChatMessages(messages, model.input.includes("image")),
	};

	if (context.tools?.length) payload.tools = toFunctionTools(context.tools);
	if (options?.temperature !== undefined) payload.temperature = options.temperature;
	if (options?.maxTokens !== undefined) payload.maxTokens = options.maxTokens;
	if (options?.toolChoice) payload.toolChoice = mapToolChoice(options.toolChoice);
	if (options?.promptMode) payload.promptMode = options.promptMode;
	if (options?.reasoningEffort) payload.reasoningEffort = options.reasoningEffort;

	if (context.systemPrompt) {
		payload.messages.unshift({
			role: "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	return payload;
}

async function consumeChatStream(
	model: Model<"mistral-conversations">,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	mistralStream: AsyncIterable<CompletionEvent>,
): Promise<void> {
	let currentBlock: TextContent | ThinkingContent | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	const toolBlocksByKey = new Map<string, number>();

	const finishCurrentBlock = (block?: typeof currentBlock) => {
		if (!block) return;
		if (block.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex: blockIndex(),
				content: block.text,
				partial: output,
			});
			return;
		}
		if (block.type === "thinking") {
			stream.push({
				type: "thinking_end",
				contentIndex: blockIndex(),
				content: block.thinking,
				partial: output,
			});
		}
	};

	for await (const event of mistralStream) {
		const chunk = event.data;
		// Mistral's streamed CompletionChunk carries an id field. Keep the first non-empty one,
		// mirroring how OpenAI-style streaming exposes a stable response identifier per stream.
		output.responseId ||= chunk.id;

		if (chunk.usage) {
			output.usage.input = chunk.usage.promptTokens || 0;
			output.usage.output = chunk.usage.completionTokens || 0;
			output.usage.cacheRead = 0;
			output.usage.cacheWrite = 0;
			// pie: crates/ai/src/providers/mistral.rs:338-346 (update_usage) — oracle always
			// recomputes total_tokens locally as input+output+cacheRead+cacheWrite; it never reads or
			// trusts the provider's own `usage.total_tokens` field (unlike the previous
			// `chunk.usage.totalTokens || ...` here, which preferred it when present).
			output.usage.totalTokens =
				output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			// PORT-DIVERGENCE: B3a (RULEBOOK §5) — crates/ai/src/providers/mistral.rs has no
			// cost-calculation anywhere in the file, like every other oracle provider (same finding as
			// openai_responses.rs:542-564's B3a site), which is what pinned every user-visible cost figure
			// at $0 (B3). Phase 18 prices it here. Mistral reports no cache buckets at all (both are
			// hardcoded 0 above), so `promptTokens` is trivially the uncached input.
			output.usage.cost = computeCost(model.cost, output.usage);
		}

		const choice = chunk.choices[0];
		if (!choice) continue;

		if (choice.finishReason) {
			output.stopReason = mapChatStopReason(choice.finishReason);
		}

		const delta = choice.delta;
		if (delta.content !== null && delta.content !== undefined) {
			const contentItems = typeof delta.content === "string" ? [delta.content] : delta.content;
			for (const item of contentItems) {
				if (typeof item === "string") {
					const textDelta = sanitizeSurrogates(item);
					if (!currentBlock || currentBlock.type !== "text") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "text", text: "" };
						output.content.push(currentBlock);
						stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
					}
					currentBlock.text += textDelta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: textDelta,
						partial: output,
					});
					continue;
				}

				if (item.type === "thinking") {
					const deltaText = item.thinking
						.map((part) => ("text" in part ? part.text : ""))
						.filter((text) => text.length > 0)
						.join("");
					const thinkingDelta = sanitizeSurrogates(deltaText);
					if (!thinkingDelta) continue;
					if (!currentBlock || currentBlock.type !== "thinking") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "thinking", thinking: "" };
						output.content.push(currentBlock);
						stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
					}
					currentBlock.thinking += thinkingDelta;
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: thinkingDelta,
						partial: output,
					});
					continue;
				}

				if (item.type === "text") {
					const textDelta = sanitizeSurrogates(item.text);
					if (!currentBlock || currentBlock.type !== "text") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "text", text: "" };
						output.content.push(currentBlock);
						stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
					}
					currentBlock.text += textDelta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: textDelta,
						partial: output,
					});
				}
			}
		}

		const toolCalls = delta.toolCalls || [];
		for (const toolCall of toolCalls) {
			if (currentBlock) {
				finishCurrentBlock(currentBlock);
				currentBlock = null;
			}
			// pie: crates/ai/src/providers/mistral.rs:264,271 (run) — oracle unconditionally runs every
			// inbound streamed tool-call id through `normalize_tool_call_id` (the same 9-char
			// alphanumeric normalizer used outbound), not just as a missing-id fallback.
			const callId =
				toolCall.id && toolCall.id !== "null"
					? deriveMistralToolCallId(toolCall.id, 0)
					: deriveMistralToolCallId(`toolcall:${toolCall.index ?? 0}`, 0);
			const key = `${callId}:${toolCall.index || 0}`;
			const existingIndex = toolBlocksByKey.get(key);
			let block: (ToolCall & { partialArgs?: string }) | undefined;

			if (existingIndex !== undefined) {
				const existing = output.content[existingIndex];
				if (existing?.type === "toolCall") {
					block = existing as ToolCall & { partialArgs?: string };
				}
			}

			if (!block) {
				block = {
					type: "toolCall",
					id: callId,
					name: toolCall.function.name,
					arguments: {},
					partialArgs: "",
				};
				output.content.push(block);
				toolBlocksByKey.set(key, output.content.length - 1);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
			}

			const argsDelta =
				typeof toolCall.function.arguments === "string"
					? toolCall.function.arguments
					: JSON.stringify(toolCall.function.arguments || {});
			block.partialArgs = (block.partialArgs || "") + argsDelta;
			block.arguments = parseStreamingJson<Record<string, unknown>>(block.partialArgs);
			stream.push({
				type: "toolcall_delta",
				contentIndex: toolBlocksByKey.get(key)!,
				delta: argsDelta,
				partial: output,
			});
		}
	}

	finishCurrentBlock(currentBlock);
	for (const index of toolBlocksByKey.values()) {
		const block = output.content[index];
		if (block.type !== "toolCall") continue;
		const toolBlock = block as ToolCall & { partialArgs?: string };
		toolBlock.arguments = parseStreamingJson<Record<string, unknown>>(toolBlock.partialArgs);
		// Finalize in-place and strip the scratch buffer so replay only
		// carries parsed arguments.
		delete toolBlock.partialArgs;
		stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: toolBlock,
			partial: output,
		});
	}
}

function toFunctionTools(tools: Tool[]): Array<FunctionTool & { type: "function" }> {
	// pie: crates/ai/src/providers/mistral.rs:377-391 (serialize_tools) — oracle's tool function
	// object is exactly `{name, description, parameters}`; it never emits a "strict" key (the SDK's
	// `FunctionT.strict` field is optional, so omitting it here drops the key from the wire body
	// entirely instead of sending `strict: false`).
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: stripSymbolKeys(tool.parameters) as Record<string, unknown>,
		},
	}));
}

function stripSymbolKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => stripSymbolKeys(item));
	}

	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = stripSymbolKeys(entry);
		}
		return result;
	}

	return value;
}

function toChatMessages(messages: Message[], supportsImages: boolean): ChatCompletionStreamRequestMessage[] {
	const result: ChatCompletionStreamRequestMessage[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				result.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				continue;
			}
			const hadImages = msg.content.some((item) => item.type === "image");
			const content: ContentChunk[] = msg.content
				.filter((item) => item.type === "text" || supportsImages)
				.map((item) => {
					if (item.type === "text") return { type: "text", text: sanitizeSurrogates(item.text) };
					return { type: "image_url", imageUrl: `data:${item.mimeType};base64,${item.data}` };
				});
			if (content.length > 0) {
				result.push({ role: "user", content });
				continue;
			}
			if (hadImages && !supportsImages) {
				result.push({ role: "user", content: "(image omitted: model does not support images)" });
			}
			continue;
		}

		if (msg.role === "assistant") {
			const contentParts: ContentChunk[] = [];
			const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length > 0) {
						contentParts.push({ type: "text", text: sanitizeSurrogates(block.text) });
					}
					continue;
				}
				if (block.type === "thinking") {
					if (block.thinking.trim().length > 0) {
						contentParts.push({
							type: "thinking",
							thinking: [{ type: "text", text: sanitizeSurrogates(block.thinking) }],
						});
					}
					continue;
				}
				toolCalls.push({
					id: block.id,
					type: "function",
					function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
				});
			}

			const assistantMessage: ChatCompletionStreamRequestMessage = { role: "assistant" };
			if (contentParts.length > 0) assistantMessage.content = contentParts;
			if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
			if (contentParts.length > 0 || toolCalls.length > 0) result.push(assistantMessage);
			continue;
		}

		const toolContent: ContentChunk[] = [];
		const textResult = msg.content
			.filter((part) => part.type === "text")
			.map((part) => (part.type === "text" ? sanitizeSurrogates(part.text) : ""))
			.join("\n");
		const hasImages = msg.content.some((part) => part.type === "image");
		const toolText = buildToolResultText(textResult, hasImages, supportsImages, msg.isError);
		toolContent.push({ type: "text", text: toolText });
		for (const part of msg.content) {
			if (!supportsImages) continue;
			if (part.type !== "image") continue;
			toolContent.push({
				type: "image_url",
				imageUrl: `data:${part.mimeType};base64,${part.data}`,
			});
		}
		result.push({
			role: "tool",
			toolCallId: msg.toolCallId,
			name: msg.toolName,
			content: toolContent,
		});
	}

	return result;
}

function buildToolResultText(text: string, hasImages: boolean, supportsImages: boolean, isError: boolean): string {
	const trimmed = text.trim();
	const errorPrefix = isError ? "[tool error] " : "";

	if (trimmed.length > 0) {
		const imageSuffix = hasImages && !supportsImages ? "\n[tool image omitted: model does not support images]" : "";
		return `${errorPrefix}${trimmed}${imageSuffix}`;
	}

	if (hasImages) {
		if (supportsImages) {
			return isError ? "[tool error] (see attached image)" : "(see attached image)";
		}
		return isError
			? "[tool error] (image omitted: model does not support images)"
			: "(image omitted: model does not support images)";
	}

	return isError ? "[tool error] (no tool output)" : "(no tool output)";
}

function usesReasoningEffort(model: Model<"mistral-conversations">): boolean {
	return model.id === "mistral-small-2603" || model.id === "mistral-small-latest" || model.id === "mistral-medium-3.5";
}

function usesPromptModeReasoning(model: Model<"mistral-conversations">): boolean {
	return model.reasoning && !usesReasoningEffort(model);
}

function mapReasoningEffort(
	model: Model<"mistral-conversations">,
	level: Exclude<SimpleStreamOptions["reasoning"], undefined>,
): MistralReasoningEffort {
	return (model.thinkingLevelMap?.[level] ?? "high") as MistralReasoningEffort;
}

function mapToolChoice(
	choice: MistralOptions["toolChoice"],
): "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } } | undefined {
	if (!choice) return undefined;
	if (choice === "auto" || choice === "none" || choice === "any" || choice === "required") {
		return choice as any;
	}
	return {
		type: "function",
		function: { name: choice.function.name },
	};
}

function mapChatStopReason(reason: string | null): StopReason {
	// pie: crates/ai/src/providers/mistral.rs:320-325 — oracle's match has no "error" arm; any
	// unrecognized finish_reason (including a hypothetical "error") falls through to its catch-all
	// `_ => StopReason::Stop`, not an Error stop reason.
	if (reason === null) return "stop";
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
		case "model_length":
			return "length";
		case "tool_calls":
			return "toolUse";
		default:
			return "stop";
	}
}
