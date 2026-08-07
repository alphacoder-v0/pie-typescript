import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.ts";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.ts";
import { abortedMessage } from "../utils/abort.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, userAgent } from "../utils/headers.ts";
import { sendWithRetry } from "../utils/retry.ts";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		// pie: crates/ai/src/providers/openai_responses.rs:36-57 (resolve_compat)
		requiresReasoningContentOnAssistantMessages: model.compat?.requiresReasoningContentOnAssistantMessages ?? false,
	};
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

function formatOpenAIResponsesError(error: unknown): string {
	if (error instanceof Error) {
		const status = (error as Error & { status?: unknown }).status;
		const statusCode = typeof status === "number" ? status : undefined;
		if (statusCode !== undefined) {
			return `OpenAI API error (${statusCode}): ${error.message}`;
		}
		return error.message;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
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

		try {
			// Create OpenAI client
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			// pie: crates/ai/src/providers/openai_responses.rs:180-185 vs :588-596 — the
			// session_id/x-client-request-id headers are keyed purely on `options.session_id` being
			// present; only the request BODY's prompt_cache_key/prompt_cache_retention fields are
			// additionally gated on cache_retention != None. `buildParams` below applies that body-side
			// gating on its own, so the raw (ungated) sessionId is what the headers should see.
			const client = createClient(model, context, apiKey, options, options?.sessionId);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				// pie: crates/ai/src/utils/retry.rs — retries are handled entirely by the
				// `sendWithRetry`-backed `fetch` wired into the client below; disable the SDK's own
				// retry loop so a single logical send isn't retried twice.
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await client.responses.create(params, requestOptions).withResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			// PORT-DIVERGENCE: B3a — `processResponsesStream` prices usage.cost from the catalog itself
			// (see openai-responses-shared.ts). No `applyServiceTierPricing` callback is wired up here:
			// oracle lists the service_tier cost multiplier as an unimplemented TODO
			// (openai_responses.rs:12,18), so this provider stays on the base catalog price.
			await processResponsesStream(openaiStream, output, stream, model);

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
				delete (block as { index?: number }).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
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
			output.errorMessage = formatOpenAIResponsesError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return streamOpenAIResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey?: string,
	options?: OpenAIResponsesOptions,
	sessionId?: string,
) {
	if (!apiKey) {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = process.env.OPENAI_API_KEY;
	}

	const compat = getCompat(model);
	// pie: crates/ai/src/utils/node_http_proxy.rs:19-22 (build_client) + crates/ai/src/utils/headers.rs:5-7
	// (user_agent) — oracle sets User-Agent: pie-ai-rs/<version> as the HTTP client default for every
	// outbound request; seed it here as the lowest-priority default so model.headers/options.headers can
	// still override it.
	const headers: Record<string, string> = { "User-Agent": userAgent(), ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sendSessionIdHeader) {
			headers.session_id = sessionId;
		}
		headers["x-client-request-id"] = sessionId;
	}

	// Merge options headers last so they can override defaults
	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const defaultHeaders =
		model.provider === "cloudflare-ai-gateway"
			? {
					...headers,
					Authorization: headers.Authorization ?? null,
					"cf-aig-authorization": `Bearer ${apiKey}`,
				}
			: headers;

	return new OpenAI({
		apiKey,
		baseURL: isCloudflareProvider(model.provider)
			? resolveCloudflareBaseUrl(model)
			: normalizeOpenAIResponsesBaseUrl(model.baseUrl),
		dangerouslyAllowBrowser: true,
		defaultHeaders,
		// pie: crates/ai/src/utils/retry.rs + crates/ai/src/providers/openai_responses.rs:194
		// (send_with_retry(&options, req)) — retry every attempt through pie's own retryable-status
		// set and backoff/cap semantics instead of the SDK's built-in retry (disabled above via
		// requestOptions.maxRetries: 0).
		fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
			sendWithRetry(() => fetch(input, init), {
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: init?.signal ?? undefined,
			})) as typeof fetch,
	});
}

/**
 * Normalize the Responses endpoint base URL. The catalog sets `baseUrl` to either the host root
 * (`https://api.openai.com`) or one that already includes the `/v1` prefix; unlike oracle's
 * `build_responses_url`, the OpenAI SDK's own baseURL + path joining does not insert a missing
 * `/v1`, so a bare-host baseUrl would otherwise silently 404 instead of hitting `/v1/responses`.
 * pie: crates/ai/src/providers/openai_responses.rs:756-766 (build_responses_url)
 */
function normalizeOpenAIResponsesBaseUrl(base: string): string {
	const trimmed = base.replace(/\/+$/, "");
	if (trimmed.endsWith("/v1") || trimmed.includes("/v1/")) {
		return trimmed;
	}
	return `${trimmed}/v1`;
}

function buildParams(model: Model<"openai-responses">, context: Context, options?: OpenAIResponsesOptions) {
	const compat = getCompat(model);
	// pie: crates/ai/src/providers/openai_responses.rs:36-57 (resolve_compat) — resolve the compat
	// flag once here and pass it through, instead of letting the shared module peek at `model.compat`
	// itself via an unsafe cast (that field's shape isn't known for the generic `Model<TApi>` there).
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		replayReasoningContent: compat.requiresReasoningContentOnAssistantMessages,
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0) {
		// pie: crates/ai/src/providers/openai_responses.rs:648-660 (`serialize_tools`) — oracle emits
		// exactly `{type, name, description, parameters}` per tool and never a `strict` key, for all
		// three Responses-family providers that share this function. azure/codex already opted in via
		// `omitStrict`; this call site was the last one still emitting pi's `strict: false`, which
		// showed up on all 25 tools in parity S5's `req2body`.
		params.tools = convertResponsesTools(context.tools, { omitStrict: true });
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		}
		// pie: crates/ai/src/providers/openai_responses.rs:633-641 — oracle writes `body["reasoning"]`
		// ONLY inside the `if let Some(effort)` arm above. There is no else branch: with thinking off,
		// `map_reasoning_effort` yields `None`, nothing lands in `provider_extras`, and the key is
		// simply absent — for every model, not just the ones whose `thinkingLevelMap.off` is null.
		//
		// pi sent `reasoning: {effort: "none"}` here for models that support `off`, and omitted it only
		// when `off` was unsupported. Parity S3 caught the difference on a default (no `--thinking`)
		// run. Removed rather than narrowed: narrowing would still emit a key oracle never sends.
	}

	return params;
}

// PORT-DIVERGENCE: B3a (RULEBOOK §5) — crates/ai/src/providers/openai_responses.rs:542-564. Oracle's
// openai_responses provider never converts Model.cost into Usage.cost at all (confirmed: no
// cost-catalog conversion function exists anywhere in oracle's `ai` crate; only ModelCost::default()
// appears, in test fixtures), which is why every user-visible cost figure was $0 (B3). Phase 18
// diverges: `processResponsesStream` (openai-responses-shared.ts) prices usage.cost from the catalog
// for every Responses-family provider, this one included.
//
// The service_tier cost MULTIPLIER remains unported here: oracle's own file header lists it as an
// unimplemented TODO ("service_tier knob (cost multiplier TODO)", openai_responses.rs:12,18), so
// this provider wires no applyServiceTierPricing callback and bills every tier at the base catalog
// rate. Only openai-codex-responses.ts — where the multiplier is a separately-tested duty — opts in.
