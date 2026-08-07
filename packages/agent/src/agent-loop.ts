/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@pie/ai";
import { type SelectCase, selectBiased } from "./harness/select.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	ControlPlanePromptDecision,
	ControlPlanePromptRequest,
	PermissionClassification,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	// pie: agent_loop.rs:55-64 (run_agent_loop_continue) — oracle only guards against an empty
	// transcript; it has no "last message must not be assistant" check at all (the caller is
	// trusted to have a valid continuation point).
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	// pie: agent_loop.rs:55-64 (run_agent_loop_continue) — see agentLoopContinue's matching
	// comment above; oracle has no assistant-role guard here either.
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// pie: agent_loop.rs:73-179 (drive_loop) — a single flat loop, matching oracle's shape:
	// stream -> execute tools -> turn_end -> should_stop_after_turn -> terminate hard-stop ->
	// prepare_next_turn -> drain queues -> inject-and-continue or stop.
	while (true) {
		if (!firstTurn) {
			await emit({ type: "turn_start" });
		} else {
			firstTurn = false;
		}

		// Process pending messages (inject before next assistant response)
		if (pendingMessages.length > 0) {
			for (const message of pendingMessages) {
				await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				currentContext.messages.push(message);
				newMessages.push(message);
			}
			pendingMessages = [];
		}

		// Stream assistant response
		const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
		newMessages.push(message);

		if (message.stopReason === "error" || message.stopReason === "aborted") {
			await emit({ type: "turn_end", message, toolResults: [] });
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		// Check for tool calls
		const toolCalls = message.content.filter((c) => c.type === "toolCall");

		const toolResults: ToolResultMessage[] = [];
		let allTerminate = false;
		if (toolCalls.length > 0) {
			const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
			toolResults.push(...executedToolBatch.messages);
			allTerminate = executedToolBatch.terminate;

			for (const result of toolResults) {
				currentContext.messages.push(result);
				newMessages.push(result);
			}
		}

		await emit({ type: "turn_end", message, toolResults });

		// pie: agent_loop.rs:124-135 — should_stop_after_turn is evaluated before
		// prepare_next_turn and before the terminate hard-stop below, against the
		// pre-prepare_next_turn context (oracle order differs from a naive port).
		if (
			await config.shouldStopAfterTurn?.({
				message,
				toolResults,
				context: currentContext,
				newMessages,
			})
		) {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		// pie: agent_loop.rs:137-141 — a tool batch that unanimously requests early
		// termination is an unconditional hard stop: prepare_next_turn does not run and
		// steering/follow-up queues are never drained, so a queued message cannot resurrect
		// a terminated batch (unlike this loop's previous behavior).
		if (toolResults.length > 0 && allTerminate) {
			await emit({ type: "agent_end", messages: newMessages });
			return;
		}

		const continues = message.stopReason === "toolUse";

		// pie: agent_loop.rs:143-154 — prepare_next_turn runs after should_stop/terminate,
		// before steering/follow-up queues are drained.
		const nextTurnContext = {
			message,
			toolResults,
			context: currentContext,
			newMessages,
		};
		const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
		if (nextTurnSnapshot) {
			currentContext = nextTurnSnapshot.context ?? currentContext;
			config = {
				...config,
				model: nextTurnSnapshot.model ?? config.model,
				reasoning:
					nextTurnSnapshot.thinkingLevel === undefined
						? config.reasoning
						: nextTurnSnapshot.thinkingLevel === "off"
							? undefined
							: nextTurnSnapshot.thinkingLevel,
			};
		}

		// pie: agent_loop.rs:156-177 — steering is always drained; follow-up is drained only
		// when the turn would not otherwise continue (no tool-use stop reason) and steering
		// was empty. Any queued message (from either source) re-enters the loop regardless of
		// `continues`.
		let queued = (await config.getSteeringMessages?.()) || [];
		if (!continues && queued.length === 0) {
			queued = (await config.getFollowUpMessages?.()) || [];
		}
		if (queued.length > 0) {
			pendingMessages = queued;
			continue;
		}
		if (!continues) {
			break;
		}
		// continues === true and nothing queued: loop back for another LLM turn.
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * pie: agent_loop.rs:271-274 (`_ = cancel.cancelled() => ...`) — the "cancellation" branch of
 * `streamAssistantResponse`'s biased race. Resolves once `signal` fires (or immediately if it's
 * already aborted); never resolves when `signal` is undefined, so the race degrades to a plain
 * drain of the event iterator.
 */
function whenAbortedCase(signal: AbortSignal | undefined): SelectCase<"aborted"> {
	return {
		run(loserSignal: AbortSignal): Promise<"aborted"> {
			return new Promise((resolve) => {
				if (!signal) return;
				if (signal.aborted) {
					resolve("aborted");
					return;
				}
				const onAbort = () => resolve("aborted");
				signal.addEventListener("abort", onAbort, { once: true });
				loserSignal.addEventListener("abort", () => signal.removeEventListener("abort", onAbort), {
					once: true,
				});
			});
		},
	};
}

/** pie: agent_loop.rs:276-279 (`next = stream.next() => ...`) — pulls the next stream event. */
function nextEventCase<T>(iterator: AsyncIterator<T>): SelectCase<IteratorResult<T>> {
	return { run: () => iterator.next() };
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	// pie: agent_loop.rs:265-323 (call_llm's event loop) — race the stream's next event
	// against the abort signal, biased toward cancellation (`tokio::select! { biased;
	// _ = cancel.cancelled() => .., next = stream.next() => .. }`), so a stalled provider that
	// never notices `signal` doesn't block indefinitely. Closes oracle issue #18.
	const iterator = response[Symbol.asyncIterator]();
	while (true) {
		const winner = await selectBiased<IteratorResult<AssistantMessageEvent> | "aborted">([
			whenAbortedCase(signal),
			nextEventCase(iterator),
		]);
		if (winner.index === 0) {
			throw new Error("aborted");
		}
		const step = winner.value as IteratorResult<AssistantMessageEvent>;
		if (step.done) break;
		const event = step.value;
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_delta":
			case "text_end":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "text_start":
			case "thinking_start":
			case "toolcall_start":
				// pie: agent_loop.rs:293-298,321 — oracle's match arm groups TextDelta/TextEnd/
				// ThinkingDelta/ThinkingEnd/ToolCallDelta/ToolCallEnd together but does NOT
				// match TextStart/ThinkingStart/ToolCallStart; those fall through to the
				// catch-all `_ => {}` and are silently dropped — no state update, no event.
				// Only the message-level Start (MessageStart) is emitted for a new message.
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal, emit);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal, emit);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);

		// pie: agent_loop.rs:399-421 (issue #110 design v0.2 Artifact A) — per-tool
		// classification runs before beforeToolCall, against the prepared args. Block
		// short-circuits immediately (no beforeToolCall call, no prompt); Prompt synthesizes a
		// default ControlPlanePromptRequest the beforeToolCall hook may enrich; Allow (the
		// default when the tool doesn't opt in) falls through unchanged.
		const classification: PermissionClassification = tool.permissionClassification?.(validatedArgs) ?? {
			type: "allow",
		};
		if (classification.type === "block") {
			return {
				kind: "immediate",
				result: createErrorToolResult(classification.reason),
				isError: true,
			};
		}
		const synthesizedPrompt: ControlPlanePromptRequest | undefined =
			classification.type === "prompt"
				? {
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						argsHash: await computeArgsHash(validatedArgs),
						label: `Control-plane write: ${toolCall.name}`,
						payload: await defaultPromptPayload(toolCall.name, validatedArgs),
						reason: classification.reason,
					}
				: undefined;

		let hookPrompt: ControlPlanePromptRequest | undefined;
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			// pie: agent_loop.rs:470-486 — the classifier's Prompt is authoritative: a hook
			// MUST NOT silently erase a control-plane prompt requirement by returning a plain
			// `{ block: false }`. Block still wins over Prompt (checked below).
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
			hookPrompt = beforeResult?.prompt;
		}

		// pie: agent_loop.rs:492-520 — merge the classifier's synthesized prompt with any
		// beforeToolCall-supplied prompt. The runtime always owns toolCallId/toolName/argsHash;
		// a hook may only enrich label/payload, never spoof binding fields. When both are
		// present, the classifier's reason wins (it's the reason the gate exists) and the
		// hook's label/payload win (richer card).
		let effectivePrompt: ControlPlanePromptRequest | undefined;
		if (synthesizedPrompt && !hookPrompt) {
			effectivePrompt = synthesizedPrompt;
		} else if (!synthesizedPrompt && hookPrompt) {
			effectivePrompt = {
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				argsHash: await computeArgsHash(validatedArgs),
				label: hookPrompt.label,
				payload: hookPrompt.payload,
				reason: hookPrompt.reason,
			};
		} else if (synthesizedPrompt && hookPrompt) {
			effectivePrompt = {
				toolCallId: synthesizedPrompt.toolCallId,
				toolName: synthesizedPrompt.toolName,
				argsHash: synthesizedPrompt.argsHash,
				label: hookPrompt.label,
				payload: hookPrompt.payload,
				reason: synthesizedPrompt.reason,
			};
		}

		// pie: agent_loop.rs:521-587 — ask the embedder via onControlPlanePrompt (fail-closed
		// deny when no channel is configured), then map the decision to allow/block. Every
		// resolution emits control_plane_prompt_resolved, decision-final by the time it fires.
		if (effectivePrompt) {
			const decision: ControlPlanePromptDecision = config.onControlPlanePrompt
				? await config.onControlPlanePrompt(effectivePrompt, signal)
				: {
						type: "deny",
						reason:
							"control-plane prompt required but no onControlPlanePrompt hook configured (fail-closed deny — see issue #110 design v0.2)",
					};

			await emit({
				type: "control_plane_prompt_resolved",
				toolCallId: effectivePrompt.toolCallId,
				toolName: effectivePrompt.toolName,
				argsHash: effectivePrompt.argsHash,
				label: effectivePrompt.label,
				decision: decision.type,
				reason: decision.type === "deny" ? decision.reason : undefined,
			});

			if (decision.type === "deny") {
				return {
					kind: "immediate",
					result: createErrorToolResult(decision.reason || "tool call denied by user via control-plane prompt"),
					isError: true,
				};
			}
			if (decision.type === "timeout") {
				return {
					kind: "immediate",
					result: createErrorToolResult("control-plane prompt timed out — tool call denied"),
					isError: true,
				};
			}
			// decision.type === "allow" -> fall through to dispatch
		}

		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/**
 * pie: agent_loop.rs:867-886 (compute_args_hash) — canonical-JSON SHA-256 of the prepared tool
 * args, binding a control-plane prompt approval to the exact invocation. Uses the Web Crypto API
 * (not node:crypto) — this file is part of the browser bundle surface (see also
 * harness/session/uuid.ts, ai/utils/oauth/pkce.ts for the same pattern in this codebase).
 */
async function computeArgsHash(args: unknown): Promise<string> {
	const canonical = canonicalizeJson(args);
	const bytes = new TextEncoder().encode(canonical);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * pie: agent_loop.rs:888-904 (canonicalize) — object keys sorted lexicographically (ordinal,
 * matching Rust `BTreeMap<String, _>`/`str::cmp`), arrays keep source order, no extra whitespace.
 */
function canonicalizeJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>).sort();
		return `{${keys
			.map((k) => `${JSON.stringify(k)}:${canonicalizeJson((value as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * pie: agent_loop.rs:906-953 (default_prompt_payload) — redaction-safe by construction: only
 * tool_name, args_keys (sorted, <=32 keys, each <=64 chars, truncated with an ellipsis), and
 * args_hash. Never the raw prepared args, which may carry tokens or other secret-bearing values.
 */
async function defaultPromptPayload(toolName: string, args: unknown): Promise<unknown> {
	const MAX_KEYS = 32;
	const MAX_KEY_LEN = 64;
	let keys: string[] = [];
	if (args !== null && typeof args === "object" && !Array.isArray(args)) {
		keys = Object.keys(args as Record<string, unknown>)
			.slice(0, MAX_KEYS)
			.map((k) => (k.length <= MAX_KEY_LEN ? k : `${k.slice(0, MAX_KEY_LEN)}…`))
			.sort();
	}
	return {
		tool_name: toolName,
		args_keys: keys,
		args_hash: await computeArgsHash(args),
	};
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

/**
 * pie: crates/agent/src/agent_loop.rs:410-414, 474-478, 558-562, 571-578, 620-628, 821-832, 834-846
 * — every synthesized failure result (tool errored, tool missing, blocked by classifier / hook /
 * control-plane prompt, prompt timed out, join failure) carries `details: serde_json::Value::Null`,
 * which serializes into the transcript as `null`. An empty object is not the same value: it is what
 * a tool that returned *some* structured detail would look like.
 */
function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: null,
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
