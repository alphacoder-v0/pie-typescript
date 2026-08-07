import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pie: crates/ai/src/vertex_provider.rs:26-52 (VertexCreds::from_env) + vertex_adc.rs — locks the
// token-resolution priority chain wired into google-vertex.ts's streamGoogleVertex:
//   options.apiKey / GOOGLE_CLOUD_API_KEY (pi-only, unchanged)
//     > GOOGLE_OAUTH_TOKEN (bearer)
//     > GOOGLE_API_KEY (Vertex `?key=`, oracle-sourced)
//     > vertex-adc.ts JWT exchange (only when GOOGLE_APPLICATION_CREDENTIALS is set)
//     > @google/genai SDK's own blackbox ADC (unchanged fallback, no explicit header)
// Also locks resolveLocation's new "us-central1" default (vertex_provider.rs:35-36).

const googleGenAiMock = vi.hoisted(() => ({ constructorCalls: [] as Array<Record<string, unknown>> }));

const ENV_KEYS = [
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_OAUTH_TOKEN",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	googleGenAiMock.constructorCalls.length = 0;
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	vi.doUnmock("@google/genai");
	vi.doUnmock("../src/utils/vertex-adc.ts");
	vi.resetModules();
});

function mockGoogleGenAi() {
	vi.doMock("@google/genai", async () => {
		const actual = await vi.importActual<typeof import("@google/genai")>("@google/genai");
		return {
			...actual,
			GoogleGenAI: class {
				// providers/google-retry.ts wires pie's `send_with_retry` (crates/ai/src/utils/retry.rs)
				// into the SDK's single request egress, `ApiClient#apiCall`, and throws if that entry point
				// is absent rather than silently shipping a Vertex client with no retry at all. A double
				// for GoogleGenAI therefore has to carry it. Never invoked here — `generateContentStream`
				// below is fully faked, so no request reaches a transport.
				apiClient = { apiCall: async () => new Response(null, { status: 200 }) };
				models = {
					generateContentStream: async function* () {
						yield {
							responseId: "resp-1",
							candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: actual.FinishReason.STOP }],
							usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
						};
					},
				};
				constructor(config: Record<string, unknown>) {
					googleGenAiMock.constructorCalls.push(config);
				}
			},
		};
	});
}

async function loadStreamGoogleVertex() {
	vi.resetModules();
	const { getModel } = await import("../src/models.ts");
	const { streamGoogleVertex } = await import("../src/providers/google-vertex.ts");
	const model = getModel("google-vertex", "gemini-2.5-flash");
	const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
	return { streamGoogleVertex, model, context };
}

describe("google-vertex token resolution priority", () => {
	it("uses GOOGLE_OAUTH_TOKEN as a Bearer header on the ADC-mode client", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "test-project";
		process.env.GOOGLE_OAUTH_TOKEN = "ya29.gcloud-token";
		mockGoogleGenAi();

		const { streamGoogleVertex, model, context } = await loadStreamGoogleVertex();
		await streamGoogleVertex(model, context, {}).result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		const call = googleGenAiMock.constructorCalls[0]!;
		expect(call).toMatchObject({ vertexai: true, project: "test-project", location: "us-central1" });
		expect(call).not.toHaveProperty("apiKey");
		expect((call.httpOptions as Record<string, unknown>)?.headers).toMatchObject({
			Authorization: "Bearer ya29.gcloud-token",
		});
	});

	it("falls back to GOOGLE_API_KEY (apiKey-mode client) when GOOGLE_OAUTH_TOKEN is unset", async () => {
		process.env.GOOGLE_API_KEY = "AIzaOracleAlternateAuthKey";
		mockGoogleGenAi();

		const { streamGoogleVertex, model, context } = await loadStreamGoogleVertex();
		await streamGoogleVertex(model, context, {}).result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			apiKey: "AIzaOracleAlternateAuthKey",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("project");
	});

	it("prefers GOOGLE_OAUTH_TOKEN over GOOGLE_API_KEY when both are set", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "test-project";
		process.env.GOOGLE_OAUTH_TOKEN = "ya29.gcloud-token";
		process.env.GOOGLE_API_KEY = "AIzaOracleAlternateAuthKey";
		mockGoogleGenAi();

		const { streamGoogleVertex, model, context } = await loadStreamGoogleVertex();
		await streamGoogleVertex(model, context, {}).result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({ vertexai: true, project: "test-project" });
	});

	it("prefers the existing options.apiKey/GOOGLE_CLOUD_API_KEY path over GOOGLE_OAUTH_TOKEN (zero regression)", async () => {
		process.env.GOOGLE_OAUTH_TOKEN = "ya29.gcloud-token";
		process.env.GOOGLE_CLOUD_API_KEY = "AIzaExistingPiApiKey";
		mockGoogleGenAi();

		const { streamGoogleVertex, model, context } = await loadStreamGoogleVertex();
		await streamGoogleVertex(model, context, {}).result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({ vertexai: true, apiKey: "AIzaExistingPiApiKey" });
	});

	it("exchanges a token via vertex-adc.ts when GOOGLE_APPLICATION_CREDENTIALS is set and no higher-priority auth exists", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "test-project";
		process.env.GOOGLE_APPLICATION_CREDENTIALS = "/fake/sa.json";
		mockGoogleGenAi();
		vi.doMock("../src/utils/vertex-adc.ts", () => ({
			fetchVertexAccessToken: vi.fn(async () => ({ token: "adc.exchanged.token", expiresAt: 0 })),
		}));

		const { streamGoogleVertex, model, context } = await loadStreamGoogleVertex();
		await streamGoogleVertex(model, context, {}).result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		const call = googleGenAiMock.constructorCalls[0]!;
		expect((call.httpOptions as Record<string, unknown>)?.headers).toMatchObject({
			Authorization: "Bearer adc.exchanged.token",
		});
	});

	it("surfaces a vertex-adc.ts exchange failure as a stream error instead of silently falling back to SDK ADC", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "test-project";
		process.env.GOOGLE_APPLICATION_CREDENTIALS = "/fake/sa.json";
		mockGoogleGenAi();
		vi.doMock("../src/utils/vertex-adc.ts", () => ({
			fetchVertexAccessToken: vi.fn(async () => {
				throw new Error("token exchange failed: 400 invalid_grant");
			}),
		}));

		const { streamGoogleVertex, model, context } = await loadStreamGoogleVertex();
		const result = await streamGoogleVertex(model, context, {}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("token exchange failed");
		expect(googleGenAiMock.constructorCalls).toHaveLength(0);
	});

	it("falls through to the SDK's blackbox ADC (no explicit Authorization header) when none of the new env vars are set", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "test-project";
		process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
		mockGoogleGenAi();

		const { streamGoogleVertex, model, context } = await loadStreamGoogleVertex();
		await streamGoogleVertex(model, context, {}).result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		const call = googleGenAiMock.constructorCalls[0]!;
		expect(call).not.toHaveProperty("apiKey");
		// pie: crates/ai/src/utils/node_http_proxy.rs:19-22 (build_client) — no explicit Authorization
		// header is forwarded (this test's actual point), but httpOptions.headers is never unset now
		// that the shared User-Agent default lives there.
		expect(call.httpOptions).toEqual({ headers: { "User-Agent": "pie-ai-rs/0.75.0" } });
	});

	it("defaults location to us-central1 when GOOGLE_CLOUD_LOCATION is unset", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "test-project";
		mockGoogleGenAi();

		const { streamGoogleVertex, model, context } = await loadStreamGoogleVertex();
		await streamGoogleVertex(model, context, {}).result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({ location: "us-central1" });
	});

	it("still throws when no project is configured (unchanged from base; oracle has no default for project either)", async () => {
		mockGoogleGenAi();

		const { streamGoogleVertex, model, context } = await loadStreamGoogleVertex();
		const result = await streamGoogleVertex(model, context, {}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("project");
	});
});
