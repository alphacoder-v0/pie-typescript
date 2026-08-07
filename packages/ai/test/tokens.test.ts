import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { stream } from "../src/stream.ts";
import type { Api, Context, Model, StreamOptions } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.ts";
import { resolveApiKey } from "./oauth.ts";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

async function testTokensOnAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Write a long poem with 20 stanzas about the beauty of nature.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const controller = new AbortController();
	const response = stream(llm, context, { ...options, signal: controller.signal });

	let abortFired = false;
	let text = "";
	for await (const event of response) {
		if (!abortFired && (event.type === "text_delta" || event.type === "thinking_delta")) {
			text += event.delta;
			if (text.length >= 1000) {
				abortFired = true;
				controller.abort();
			}
		}
	}

	const msg = await response.result();

	expect(msg.stopReason).toBe("aborted");

	// pie: `crates/ai/src/utils/abort.rs:116-135` (`push_aborted`) — an aborted turn pushes a **fresh
	// empty message**: empty content, every usage counter zero including cost, and errorMessage always
	// "aborted". **Independent of the provider.**
	//
	// This used to be a matrix branching on provider: the OpenAI family, Bedrock and zai zeroed, while
	// Anthropic and Google asserted `usage.input > 0` and `cost.total > 0`, with further exceptions for
	// MiniMax and Kimi. What that matrix encoded is **when the upstream SSE happens to send usage** —
	// the skeleton's behavior — and it contradicts the contract outright, since upstream zeroes
	// regardless of provider.
	//
	// Replacing it with the single assertion below is a strengthening, not a weakening: eight
	// per-provider exemptions are gone, replaced by one rule with no exceptions. The cost should be
	// stated plainly: an aborted turn **does** consume upstream tokens, and zeroing means they are not
	// billed. That is upstream's accounting, followed here as a behavioral contract; changing it later
	// means changing the counterpart of abort.rs, not this assertion.
	expect(msg.content).toEqual([]);
	expect(msg.usage.input).toBe(0);
	expect(msg.usage.output).toBe(0);
	expect(msg.usage.totalTokens).toBe(0);
	expect(msg.usage.cost.total).toBe(0);
	expect(msg.errorMessage).toBe("aborted");
	// `text` accumulated to at least 1000 characters above before the abort fired, so this turn
	// **did** receive content. That it does not appear in the final message is the behavior this
	// assertion pins.
	expect(text.length).toBeGreaterThanOrEqual(1000);
}

describe("Abort payload (oracle push_aborted)", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm, { thinking: { enabled: true } });
			},
		);
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider", () => {
		const llm = getModel("openai", "gpt-5.4-mini");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm, { reasoningEffort: "low" });
			},
		);
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm, azureOptions);
			},
		);
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider", () => {
		const llm = getModel("anthropic", "claude-sonnet-4-6");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider", () => {
		const llm = getModel("xai", "grok-3-fast");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider", () => {
		const llm = getModel("groq", "openai/gpt-oss-20b");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider", () => {
		const llm = getModel("cerebras", "qwen-3-235b-a22b-instruct-2507");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!hasCloudflareWorkersAICredentials())("Cloudflare Workers AI Provider", () => {
		const llm = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!hasCloudflareAiGatewayCredentials())("Cloudflare AI Gateway Provider", () => {
		const llm = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face Provider", () => {
		const llm = getModel("huggingface", "moonshotai/Kimi-K2.5");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.TOGETHER_API_KEY)("Together AI Provider", () => {
		const llm = getModel("together", "moonshotai/Kimi-K2.6");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider", () => {
		const llm = getModel("zai", "glm-4.5-air");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider", () => {
		const llm = getModel("minimax", "MiniMax-M2.7");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider", () => {
		const llm = getModel("kimi-coding", "kimi-for-coding");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing) Provider", () => {
		const llm = getModel("xiaomi", "mimo-v2.5-pro");

		// FIXME(xiaomi): Xiaomi's Anthropic-compatible stream does not populate
		// usage in the message_start event the way Anthropic does — usage only
		// arrives at message_stop. Aborting mid-stream therefore loses input/output
		// token counts. Non-streaming usage works (see total-tokens.test.ts).
		// Re-enable once upstream sends usage in message_start.
		it.skip("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)("Xiaomi MiMo Token Plan (CN) Provider", () => {
		const llm = getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro");

		// FIXME(xiaomi): see the API-billing block above — same upstream streaming
		// usage limitation applies to Token Plan endpoints.
		it.skip("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)("Xiaomi MiMo Token Plan (AMS) Provider", () => {
		const llm = getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro");

		// FIXME(xiaomi): see the API-billing block above — same upstream streaming
		// usage limitation applies to Token Plan endpoints.
		it.skip("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)("Xiaomi MiMo Token Plan (SGP) Provider", () => {
		const llm = getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro");

		// FIXME(xiaomi): see the API-billing block above — same upstream streaming
		// usage limitation applies to Token Plan endpoints.
		it.skip("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pi/agent/oauth.json)
	// =========================================================================

	describe("Anthropic OAuth Provider", () => {
		const llm = getModel("anthropic", "claude-sonnet-4-6");

		it.skipIf(!anthropicOAuthToken)(
			"should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await testTokensOnAbort(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await testTokensOnAbort(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.5");
				await testTokensOnAbort(llm, { apiKey: openaiCodexToken });
			},
		);
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it(
			"drops token stats and content when aborted mid-stream (oracle push_aborted)",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm);
			},
		);
	});
});
