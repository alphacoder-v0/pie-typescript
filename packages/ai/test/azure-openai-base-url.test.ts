import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.ts";
import type { Context } from "../src/types.ts";

interface CapturedAzureClientOptions {
	apiKey: string;
	apiVersion: string;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders?: Record<string, string>;
	baseURL: string;
}

interface CapturedAzureResponsesPayload {
	prompt_cache_key?: string;
}

const azureMock = vi.hoisted(() => ({
	constructorCalls: [] as CapturedAzureClientOptions[],
	lastParams: undefined as CapturedAzureResponsesPayload | undefined,
}));

vi.mock("openai", () => {
	class AzureOpenAI {
		responses = {
			create: (params: CapturedAzureResponsesPayload) => {
				azureMock.lastParams = params;
				throw new Error("mock create");
			},
		};

		constructor(config: CapturedAzureClientOptions) {
			azureMock.constructorCalls.push(config);
		}
	}

	return { AzureOpenAI };
});

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const originalAzureOpenAIBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
const originalAzureOpenAIResourceName = process.env.AZURE_OPENAI_RESOURCE_NAME;
const originalAzureOpenAIApiVersion = process.env.AZURE_OPENAI_API_VERSION;
const originalAzureOpenAIApiKey = process.env.AZURE_OPENAI_API_KEY;

beforeEach(() => {
	azureMock.constructorCalls.length = 0;
	azureMock.lastParams = undefined;
	delete process.env.AZURE_OPENAI_BASE_URL;
	delete process.env.AZURE_OPENAI_RESOURCE_NAME;
	delete process.env.AZURE_OPENAI_API_VERSION;
	delete process.env.AZURE_OPENAI_API_KEY;
});

afterEach(() => {
	if (originalAzureOpenAIBaseUrl === undefined) {
		delete process.env.AZURE_OPENAI_BASE_URL;
	} else {
		process.env.AZURE_OPENAI_BASE_URL = originalAzureOpenAIBaseUrl;
	}

	if (originalAzureOpenAIResourceName === undefined) {
		delete process.env.AZURE_OPENAI_RESOURCE_NAME;
	} else {
		process.env.AZURE_OPENAI_RESOURCE_NAME = originalAzureOpenAIResourceName;
	}

	if (originalAzureOpenAIApiVersion === undefined) {
		delete process.env.AZURE_OPENAI_API_VERSION;
	} else {
		process.env.AZURE_OPENAI_API_VERSION = originalAzureOpenAIApiVersion;
	}

	if (originalAzureOpenAIApiKey === undefined) {
		delete process.env.AZURE_OPENAI_API_KEY;
	} else {
		process.env.AZURE_OPENAI_API_KEY = originalAzureOpenAIApiKey;
	}
});

async function captureClientBaseUrl(baseUrl: string): Promise<string> {
	process.env.AZURE_OPENAI_BASE_URL = baseUrl;
	const model = getModel("azure-openai-responses", "gpt-4o-mini");
	await streamAzureOpenAIResponses(model, context, { apiKey: "test-api-key" }).result();
	expect(azureMock.constructorCalls).toHaveLength(1);
	return azureMock.constructorCalls[0].baseURL;
}

describe("azure-openai-responses base URL normalization", () => {
	it("normalizes Cognitive Services root endpoints to /openai/v1", async () => {
		const baseURL = await captureClientBaseUrl("https://marc-quicktests-resource.cognitiveservices.azure.com");
		expect(baseURL).toBe("https://marc-quicktests-resource.cognitiveservices.azure.com/openai/v1");
	});

	it("normalizes Azure OpenAI root endpoints to /openai/v1", async () => {
		const baseURL = await captureClientBaseUrl("https://my-resource.openai.azure.com");
		expect(baseURL).toBe("https://my-resource.openai.azure.com/openai/v1");
	});

	it("normalizes /openai to /openai/v1", async () => {
		const baseURL = await captureClientBaseUrl("https://my-resource.cognitiveservices.azure.com/openai");
		expect(baseURL).toBe("https://my-resource.cognitiveservices.azure.com/openai/v1");
	});

	it("preserves /openai/v1 endpoints", async () => {
		const baseURL = await captureClientBaseUrl("https://my-resource.cognitiveservices.azure.com/openai/v1");
		expect(baseURL).toBe("https://my-resource.cognitiveservices.azure.com/openai/v1");
	});

	it("preserves explicit non-Azure proxy paths", async () => {
		const baseURL = await captureClientBaseUrl("https://my-proxy.example.com/v1");
		expect(baseURL).toBe("https://my-proxy.example.com/v1");
	});

	it("strips query params when normalizing Azure host URLs", async () => {
		const baseURL = await captureClientBaseUrl("https://my-resource.openai.azure.com/openai?api-version=2024-12-01");
		expect(baseURL).toBe("https://my-resource.openai.azure.com/openai/v1");
	});

	it("preserves query params on non-Azure proxy URLs", async () => {
		const baseURL = await captureClientBaseUrl("https://my-proxy.example.com/v1?custom=true");
		expect(baseURL).toBe("https://my-proxy.example.com/v1?custom=true");
	});

	it("throws on invalid URLs", async () => {
		process.env.AZURE_OPENAI_BASE_URL = "not-a-url";
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		const result = await streamAzureOpenAIResponses(model, context, { apiKey: "test-api-key" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid Azure OpenAI base URL");
	});

	// pie: crates/ai/src/providers/openai_responses.rs:588-596 (build_request_body, reused verbatim
	// by azure_openai_responses.rs) — oracle sends the raw session id as `prompt_cache_key` with no
	// length clamp anywhere in the ai crate. Previously this test asserted a pi-only 64-char clamp
	// that has no oracle counterpart; it now locks the oracle-faithful unclamped passthrough instead.
	it("does not clamp prompt_cache_key (oracle sends the raw session id, no length limit)", async () => {
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		const sessionId = "x".repeat(67);
		await streamAzureOpenAIResponses(model, context, {
			apiKey: "test-api-key",
			azureBaseUrl: "https://my-resource.openai.azure.com",
			sessionId,
		}).result();

		expect(azureMock.lastParams?.prompt_cache_key).toBe(sessionId);
		expect(azureMock.lastParams?.prompt_cache_key).toHaveLength(67);
	});

	it("builds correct default URL from AZURE_OPENAI_RESOURCE_NAME", async () => {
		process.env.AZURE_OPENAI_RESOURCE_NAME = "my-resource";
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		await streamAzureOpenAIResponses(model, context, { apiKey: "test-api-key" }).result();
		expect(azureMock.constructorCalls).toHaveLength(1);
		expect(azureMock.constructorCalls[0].baseURL).toBe("https://my-resource.openai.azure.com/openai/v1");
	});
});
