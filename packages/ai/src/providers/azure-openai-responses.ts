import { AzureOpenAI } from "openai";
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
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

const DEFAULT_AZURE_API_VERSION = "v1";
const AZURE_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "azure-openai-responses"]);

function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

function resolveDeploymentName(model: Model<"azure-openai-responses">, options?: AzureOpenAIResponsesOptions): string {
	if (options?.azureDeploymentName) {
		return options.azureDeploymentName;
	}
	const mappedDeployment = parseDeploymentNameMap(process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id);
	return mappedDeployment || model.id;
}

// pie: crates/ai/src/providers/azure_openai_responses.rs:18-20 (`use
// crate::providers::openai_responses::{build_request_body, consume_responses_sse, resolve_compat}`)
// — azure reuses the exact same `resolve_compat`/`build_request_body` functions as plain
// openai_responses.rs (not a copy — the identical Rust function). openai-responses.ts (pilot-locked,
// do not touch) already implements this compat resolution + cache-retention gating locally; that
// file's implementation can't be imported here without touching it, so this duplicates the same
// logic for azure's own `buildParams` below.
function getCompat(model: Model<"azure-openai-responses">): Required<OpenAIResponsesCompat> {
	// The pi model-catalog type only types `compat` for openai-completions/openai-responses/
	// anthropic-messages (`never` for azure-openai-responses), so no azure catalog entry can
	// currently populate it in valid TS — oracle's untyped `Option<Value>` `Model.compat` has no such
	// restriction. Read through an unknown-cast so this still resolves correctly if a future catalog
	// entry ever sets it, while defaulting identically to openai-responses.ts today.
	const compat = (model as unknown as { compat?: Partial<OpenAIResponsesCompat> }).compat;
	return {
		sendSessionIdHeader: compat?.sendSessionIdHeader ?? true,
		supportsLongCacheRetention: compat?.supportsLongCacheRetention ?? true,
		requiresReasoningContentOnAssistantMessages: compat?.requiresReasoningContentOnAssistantMessages ?? false,
	};
}

function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

function formatAzureOpenAIError(error: unknown): string {
	if (error instanceof Error) {
		const status = (error as Error & { status?: unknown }).status;
		const statusCode = typeof status === "number" ? status : undefined;
		if (statusCode !== undefined) {
			return `Azure OpenAI API error (${statusCode}): ${error.message}`;
		}
		return error.message;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

// Azure OpenAI Responses-specific options
export interface AzureOpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
}

/**
 * Generate function for Azure OpenAI Responses API
 */
export const streamAzureOpenAIResponses: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const deploymentName = resolveDeploymentName(model, options);

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "azure-openai-responses" as Api,
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
			// Create Azure OpenAI client
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const client = createClient(model, apiKey, options);
			let params = buildParams(model, context, options, deploymentName);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				// pie: crates/ai/src/utils/retry.rs — retries are handled entirely by the
				// `sendWithRetry`-backed `fetch` wired into the client above; disable the SDK's own
				// retry loop so a single logical send isn't retried twice.
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await client.responses.create(params, requestOptions).withResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

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
			output.errorMessage = formatAzureOpenAIError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * pie: `push_error` (imported by azure_openai_responses.rs:18-20 from openai_responses.rs) — an
 * empty partial marked `StopReason::Error` with `error_message`, emitted as the stream's single
 * `Error` event, so the failure travels through the stream rather than as a thrown error.
 */
function pushErrorStream(model: Model<"azure-openai-responses">, message: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const error: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "azure-openai-responses" as Api,
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
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: "error", error });
	stream.end();
	return stream;
}

export const streamSimpleAzureOpenAIResponses: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		// pie: crates/ai/src/providers/azure_openai_responses.rs:107-121.
		return pushErrorStream(model, "AZURE_OPENAI_API_KEY is not set");
	}

	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return streamAzureOpenAIResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies AzureOpenAIResponsesOptions);
};

function normalizeAzureBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
	}

	const isAzureHost =
		url.hostname.endsWith(".openai.azure.com") || url.hostname.endsWith(".cognitiveservices.azure.com");
	const normalizedPath = url.pathname.replace(/\/+$/, "");

	// Ensure Azure hosts have /openai/v1 as base path so the AzureOpenAI SDK
	// can append /deployments/<model>/... and ?api-version=v1 correctly.
	if (isAzureHost && (normalizedPath === "" || normalizedPath === "/" || normalizedPath === "/openai")) {
		url.pathname = "/openai/v1";
		url.search = "";
	}

	return url.toString().replace(/\/+$/, "");
}

function buildDefaultBaseUrl(resourceName: string): string {
	return `https://${resourceName}.openai.azure.com/openai/v1`;
}

function resolveAzureConfig(
	model: Model<"azure-openai-responses">,
	options?: AzureOpenAIResponsesOptions,
): { baseUrl: string; apiVersion: string } {
	const apiVersion = options?.azureApiVersion || process.env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;

	const baseUrl = options?.azureBaseUrl?.trim() || process.env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = options?.azureResourceName || process.env.AZURE_OPENAI_RESOURCE_NAME;

	let resolvedBaseUrl = baseUrl;

	if (!resolvedBaseUrl && resourceName) {
		resolvedBaseUrl = buildDefaultBaseUrl(resourceName);
	}

	if (!resolvedBaseUrl && model.baseUrl) {
		resolvedBaseUrl = model.baseUrl;
	}

	if (!resolvedBaseUrl) {
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	return {
		baseUrl: normalizeAzureBaseUrl(resolvedBaseUrl),
		apiVersion,
	};
}

function createClient(model: Model<"azure-openai-responses">, apiKey: string, options?: AzureOpenAIResponsesOptions) {
	if (!apiKey) {
		if (!process.env.AZURE_OPENAI_API_KEY) {
			throw new Error(
				"Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = process.env.AZURE_OPENAI_API_KEY;
	}

	// pie: crates/ai/src/utils/node_http_proxy.rs:19-22 (build_client) + crates/ai/src/utils/headers.rs:5-7
	// (user_agent) — oracle sets User-Agent: pie-ai-rs/<version> as the HTTP client default for every
	// outbound request; seed it here as the lowest-priority default so model.headers/options.headers can
	// still override it.
	const headers: Record<string, string> = { "User-Agent": userAgent(), ...model.headers };

	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	return new AzureOpenAI({
		apiKey,
		apiVersion,
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers,
		baseURL: baseUrl,
		// pie: crates/ai/src/providers/azure_openai_responses.rs:163 (run, `send_with_retry`) +
		// crates/ai/src/utils/retry.rs — azure reuses the exact same `send_with_retry` call as plain
		// openai_responses.rs, not the SDK's own retry loop. Mirrors openai-responses.ts's
		// (pilot-locked) `fetch` override; `maxRetries: 0` on the request options below disables the
		// SDK's own retry so a single logical send isn't retried twice.
		fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
			sendWithRetry(() => fetch(input, init), {
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: init?.signal ?? undefined,
			})) as typeof fetch,
	});
}

function buildParams(
	model: Model<"azure-openai-responses">,
	context: Context,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
) {
	const compat = getCompat(model);
	// pie: crates/ai/src/providers/openai_responses.rs:36-57 (resolve_compat) — resolved once here,
	// same as openai-responses.ts, instead of a shared module peeking at `model.compat` unsafely.
	const messages = convertResponsesMessages(model, context, AZURE_TOOL_CALL_PROVIDERS, {
		replayReasoningContent: compat.requiresReasoningContentOnAssistantMessages,
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const params: ResponseCreateParamsStreaming = {
		model: deploymentName,
		input: messages,
		stream: true,
		// pie: crates/ai/src/providers/openai_responses.rs:588-596 (build_request_body, reused
		// verbatim by azure) — `prompt_cache_key`/`prompt_cache_retention` are only set when
		// cache_retention != "none", and oracle sends the RAW session id (no length clamp exists
		// anywhere in the ai crate). The previous unconditional `clampOpenAIPromptCacheKey(...)` here
		// neither gated on cacheRetention nor matched oracle's unclamped value.
		prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		// pie: crates/ai/src/providers/openai_responses.rs:648-660 (serialize_tools, reused verbatim
		// by azure via the shared `build_request_body`) — oracle never emits a "strict" key.
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
		} else if (model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	return params;
}
