import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type HttpOptions,
	ResourceScope,
	type ThinkingConfig,
	ThinkingLevel,
} from "@google/genai";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ThinkingLevel as PiThinkingLevel,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ToolCall,
} from "../types.ts";
import { computeCost } from "../usage.ts";
import { abortedMessage } from "../utils/abort.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { userAgent } from "../utils/headers.ts";
import type { RetrySendOptions } from "../utils/retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { fetchVertexAccessToken } from "../utils/vertex-adc.ts";
import { wireOracleRetry } from "./google-retry.ts";
import type { GoogleThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReason,
	mapToolChoice,
	retainThoughtSignature,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface GoogleVertexOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleThinkingLevel;
	};
	project?: string;
	location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

const THINKING_LEVEL_MAP: Record<GoogleThinkingLevel, ThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: ThinkingLevel.MINIMAL,
	LOW: ThinkingLevel.LOW,
	MEDIUM: ThinkingLevel.MEDIUM,
	HIGH: ThinkingLevel.HIGH,
};

export const streamGoogleVertex: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	// pie: crates/ai/src/providers/google_vertex.rs:19-21 (reuses google.rs's consume_gemini_sse
	// verbatim) + google.rs:186,275-284 — oracle's `tool_counter` is local to one streaming call,
	// reset to 0 each time; the previous module-level `toolCallCounter` kept incrementing across the
	// process lifetime instead.
	let toolCallCounter = 0;

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-vertex" as Api,
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
			// pie: crates/ai/src/vertex_provider.rs:26-52 (VertexCreds::from_env) — token
			// resolution priority: explicit options.apiKey/GOOGLE_CLOUD_API_KEY (pi-only, unchanged)
			// beats GOOGLE_OAUTH_TOKEN beats GOOGLE_API_KEY beats vertex-adc.ts's JWT exchange beats
			// the @google/genai SDK's own blackbox ADC.
			const auth = await resolveVertexAuth(options);
			// pie: crates/ai/src/utils/retry.rs:45-48 — oracle reads the retry budget and delay cap off
			// the same `StreamOptions` the caller passed, defaulting to 2 retries / 60s.
			const retry: RetrySendOptions = {
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			};
			const client =
				auth.mode === "apiKey"
					? createClientWithApiKey(model, auth.apiKey, options?.headers, retry)
					: createClient(
							model,
							resolveProject(options),
							resolveLocation(options),
							auth.bearerToken
								? { Authorization: `Bearer ${auth.bearerToken}`, ...options?.headers }
								: options?.headers,
							retry,
						);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			const googleStream = await client.models.generateContentStream(params);

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			for await (const chunk of googleStream) {
				// Vertex uses the same @google/genai GenerateContentResponse type as Gemini.
				// responseId is documented there as an output-only identifier for each response.
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text !== undefined) {
							const isThinking = isThinkingPart(part);
							if (
								!currentBlock ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
								if (currentBlock) {
									if (currentBlock.type === "text") {
										stream.push({
											type: "text_end",
											contentIndex: blocks.length - 1,
											content: currentBlock.text,
											partial: output,
										});
									} else {
										stream.push({
											type: "thinking_end",
											contentIndex: blockIndex(),
											content: currentBlock.thinking,
											partial: output,
										});
									}
								}
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							} else {
								currentBlock.text += part.text;
								currentBlock.textSignature = retainThoughtSignature(
									currentBlock.textSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						}

						if (part.functionCall) {
							if (currentBlock) {
								if (currentBlock.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial: output,
									});
								} else {
									stream.push({
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial: output,
									});
								}
								currentBlock = null;
							}

							const providedId = part.functionCall.id;
							const needsNewId =
								!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
							const toolCallId = needsNewId
								? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
								: providedId;

							const toolCall: ToolCall = {
								type: "toolCall",
								id: toolCallId,
								name: part.functionCall.name || "",
								arguments: (part.functionCall.args as Record<string, any>) ?? {},
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};

							output.content.push(toolCall);
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: JSON.stringify(toolCall.arguments),
								partial: output,
							});
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						}
					}
				}

				if (candidate?.finishReason) {
					output.stopReason = mapStopReason(candidate.finishReason);
					if (output.content.some((b) => b.type === "toolCall")) {
						output.stopReason = "toolUse";
					}
				}

				if (chunk.usageMetadata) {
					const input =
						(chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0);
					const outputTokens =
						(chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0);
					const cacheRead = chunk.usageMetadata.cachedContentTokenCount || 0;
					const tokens = {
						input,
						output: outputTokens,
						cacheRead,
						cacheWrite: 0,
						// pie: crates/ai/src/providers/google_vertex.rs:19-21 (reuses google.rs's
						// consume_gemini_sse verbatim) + google.rs:391-415 (update_usage) — oracle falls
						// back to the locally-computed sum only when `totalTokenCount` is absent from the
						// JSON, not whenever it's falsy.
						totalTokens: chunk.usageMetadata.totalTokenCount ?? input + outputTokens + cacheRead,
					};
					// PORT-DIVERGENCE: B3a (RULEBOOK §5) — crates/ai/src/providers/google_vertex.rs reuses
					// google.rs, which has no cost-calculation anywhere; no oracle provider ever computes
					// usage.cost, which is what pinned every user-visible cost figure at $0 (B3). Phase 18
					// prices it here. `input` above is already net of `cachedContentTokenCount`.
					output.usage = { ...tokens, cost: computeCost(model.cost, tokens) };
				}
			}

			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// Remove internal index property used during streaming
			for (const block of output.content) {
				if ("index" in block) {
					delete (block as { index?: number }).index;
				}
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
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleGoogleVertex: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, options, undefined);
	if (!options?.reasoning) {
		return streamGoogleVertex(model, context, {
			...base,
			thinking: { enabled: false },
		} satisfies GoogleVertexOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	const effort = (clampedReasoning === "off" ? "high" : clampedReasoning) as ClampedThinkingLevel;
	const geminiModel = model as unknown as Model<"google-generative-ai">;

	if (isGemini3ProModel(geminiModel) || isGemini3FlashModel(geminiModel)) {
		return streamGoogleVertex(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getGemini3ThinkingLevel(effort, geminiModel),
			},
		} satisfies GoogleVertexOptions);
	}

	return streamGoogleVertex(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(geminiModel, effort, options.thinkingBudgets),
		},
	} satisfies GoogleVertexOptions);
};

// pie: crates/ai/src/providers/google_vertex.rs:139 — oracle sends *every* Vertex request through
// `crate::utils::retry::send_with_retry`, the same util and the same policy as the Gemini path.
// `@google/genai` has no `fetch` hook to hang the shared `sendWithRetry` off, and its own
// `httpOptions.retryOptions` expresses none of oracle's policy; see providers/google-retry.ts for
// the full comparison and the interception point used instead.
function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	optionsHeaders?: Record<string, string>,
	retry: RetrySendOptions = {},
): GoogleGenAI {
	return wireOracleRetry(
		new GoogleGenAI({
			vertexai: true,
			project,
			location,
			apiVersion: API_VERSION,
			httpOptions: buildHttpOptions(model, optionsHeaders),
		}),
		retry,
	);
}

function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	optionsHeaders?: Record<string, string>,
	retry: RetrySendOptions = {},
): GoogleGenAI {
	return wireOracleRetry(
		new GoogleGenAI({
			vertexai: true,
			apiKey,
			apiVersion: API_VERSION,
			httpOptions: buildHttpOptions(model, optionsHeaders),
		}),
		retry,
	);
}

function buildHttpOptions(model: Model<"google-vertex">, optionsHeaders?: Record<string, string>): HttpOptions {
	// pie: crates/ai/src/utils/node_http_proxy.rs:19-22 (build_client) + crates/ai/src/utils/headers.rs:5-7
	// (user_agent) — oracle sets User-Agent: pie-ai-rs/<version> as the HTTP client default for every
	// outbound request. `httpOptions.headers` is deep-merged on top of the SDK's own default headers
	// (patchHttpOptions in @google/genai), so seeding it here overrides the SDK's own User-Agent while
	// still letting model.headers/optionsHeaders win over it.
	const httpOptions: HttpOptions = { headers: { "User-Agent": userAgent(), ...model.headers, ...optionsHeaders } };
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		if (baseUrlIncludesApiVersion(baseUrl)) {
			httpOptions.apiVersion = "";
		}
	}

	return httpOptions;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed || trimmed.includes("{location}")) {
		return undefined;
	}
	return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
	} catch {
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	const apiKey = options?.apiKey?.trim() || process.env.GOOGLE_CLOUD_API_KEY?.trim();
	if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
		return undefined;
	}
	return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
	return /^<[^>]+>$/.test(apiKey);
}

type VertexAuthResolution = { mode: "apiKey"; apiKey: string } | { mode: "adc"; bearerToken?: string };

/**
 * pie: crates/ai/src/vertex_provider.rs:26-52 (VertexCreds::from_env) + vertex_adc.rs
 * (fetch_access_token, "closes pie#14's Vertex ADC gap"). Oracle's own header frames
 * GOOGLE_OAUTH_TOKEN/GOOGLE_API_KEY as "intentionally minimal" v1 auth, with the full ADC chain
 * (service-account JSON -> JWT -> token exchange) as an explicit follow-up — vertex-adc.ts is that
 * follow-up. options.apiKey/GOOGLE_CLOUD_API_KEY is a pi-only explicit override with no oracle
 * counterpart and keeps top priority unchanged (existing, tested behavior).
 */
async function resolveVertexAuth(options?: GoogleVertexOptions): Promise<VertexAuthResolution> {
	const explicitApiKey = resolveApiKey(options);
	if (explicitApiKey) {
		return { mode: "apiKey", apiKey: explicitApiKey };
	}

	// pie: vertex_provider.rs:37-39 — GOOGLE_OAUTH_TOKEN (set by `gcloud auth print-access-token`)
	// is sent as `Authorization: Bearer ...`.
	const oauthToken = process.env.GOOGLE_OAUTH_TOKEN?.trim();
	if (oauthToken) {
		return { mode: "adc", bearerToken: oauthToken };
	}

	// pie: vertex_provider.rs:40-42 — GOOGLE_API_KEY is Vertex's alternative auth, sent as `?key=`
	// (same URL-param semantics as this function's existing GOOGLE_CLOUD_API_KEY branch above).
	const oracleApiKey = process.env.GOOGLE_API_KEY?.trim();
	if (oracleApiKey && oracleApiKey !== GCP_VERTEX_CREDENTIALS_MARKER && !isPlaceholderApiKey(oracleApiKey)) {
		return { mode: "apiKey", apiKey: oracleApiKey };
	}

	// pie: vertex_adc.rs — only attempted when GOOGLE_APPLICATION_CREDENTIALS is explicitly set; a
	// failure here is surfaced (not swallowed), since the user deliberately pointed at a
	// credentials file. When unset, fall through silently to the @google/genai SDK's own ADC
	// resolution (gcloud cached creds / GCE metadata server), a strict superset of the
	// service-account-JSON path vertex-adc.ts covers.
	if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
		const token = await fetchVertexAccessToken();
		return { mode: "adc", bearerToken: token.token };
	}

	return { mode: "adc" };
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project = options?.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	// pie: crates/ai/src/vertex_provider.rs:35-36 (VertexCreds::from_env) — GOOGLE_CLOUD_LOCATION
	// defaults to "us-central1" rather than requiring it.
	return options?.location || process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
}

function buildParams(
	model: Model<"google-vertex">,
	context: Context,
	options: GoogleVertexOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
		...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }),
	};

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		config.toolConfig = {
			functionCallingConfig: {
				mode: mapToolChoice(options.toolChoice),
			},
		};
	} else {
		config.toolConfig = undefined;
	}

	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = THINKING_LEVEL_MAP[options.thinking.level];
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = getDisabledThinkingConfig(model);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}

type ClampedThinkingLevel = Exclude<PiThinkingLevel, "xhigh">;

function isGemini3ProModel(model: Model<"google-generative-ai">): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

function isGemini3FlashModel(model: Model<"google-generative-ai">): boolean {
	return /gemini-3(?:\.\d+)?-flash/.test(model.id.toLowerCase());
}

function getDisabledThinkingConfig(model: Model<"google-vertex">): ThinkingConfig {
	// Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
	// do not support full thinking-off either. For Gemini 3 models, use the lowest supported
	// thinkingLevel without includeThoughts so hidden thinking remains invisible to pi.
	const geminiModel = model as unknown as Model<"google-generative-ai">;
	if (isGemini3ProModel(geminiModel)) {
		return { thinkingLevel: ThinkingLevel.LOW };
	}
	if (isGemini3FlashModel(geminiModel)) {
		return { thinkingLevel: ThinkingLevel.MINIMAL };
	}

	// Gemini 2.x supports disabling via thinkingBudget = 0.
	return { thinkingBudget: 0 };
}

function getGemini3ThinkingLevel(
	effort: ClampedThinkingLevel,
	model: Model<"google-generative-ai">,
): GoogleThinkingLevel {
	if (isGemini3ProModel(model)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "LOW";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	switch (effort) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}

function getGoogleBudget(
	model: Model<"google-generative-ai">,
	effort: ClampedThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ClampedThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[effort];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<ClampedThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[effort];
	}

	return -1;
}
