import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// crates/ai/src/providers/google_vertex.rs reuses google.rs's `build_request_body` and
// `consume_gemini_sse` verbatim (lines 19-21), so the same B3a-pricing/totalTokens-fallback/
// tool-id-counter treatment applied to google.ts (see test/google-oracle-parity.test.ts) applies
// here — but google-vertex.ts has its own separate (duplicated, not shared) TS implementation, so it
// needs its own locking test. Oracle's one #[test] (`host_is_regional_or_global`, lines 176-182)
// has no portable analog: base delegates host/URL construction entirely to the @google/genai SDK's
// project+location+apiVersion config (SDK-adoption territory, RULEBOOK §1) rather than a hand-rolled
// string builder like oracle's `vertex_host` — no-rust-tests-equivalent for that specific function.

const googleGenAiMock = vi.hoisted(() => ({ constructorCalls: [] as Array<Record<string, unknown>> }));

beforeEach(() => {
	googleGenAiMock.constructorCalls.length = 0;
	process.env.GOOGLE_CLOUD_PROJECT = "test-project";
	process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
	// pie: crates/ai/src/vertex_provider.rs:37-42 — clear the new token-resolution env vars so an
	// ambient dev/CI shell can't change which auth mode these apiKey-mode tests exercise.
	delete process.env.GOOGLE_OAUTH_TOKEN;
	delete process.env.GOOGLE_API_KEY;
	delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
});

afterEach(() => {
	delete process.env.GOOGLE_CLOUD_PROJECT;
	delete process.env.GOOGLE_CLOUD_LOCATION;
	delete process.env.GOOGLE_OAUTH_TOKEN;
	delete process.env.GOOGLE_API_KEY;
	delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
	vi.doUnmock("@google/genai");
	vi.resetModules();
});

describe("google-vertex streaming: usage/cost/tool-id-counter", () => {
	it("prices usage.cost from the catalog, falls back totalTokens to the computed sum when absent, and resets the tool-id counter per stream", async () => {
		vi.doMock("@google/genai", async () => {
			const actual = await vi.importActual<typeof import("@google/genai")>("@google/genai");
			return {
				...actual,
				GoogleGenAI: class {
					// providers/google-retry.ts wires pie's `send_with_retry` (crates/ai/src/utils/retry.rs)
					// into the SDK's single request egress, `ApiClient#apiCall`, and throws if that entry
					// point is absent rather than silently shipping a Vertex client with no retry at all.
					// A double for GoogleGenAI therefore has to carry it. Never invoked here —
					// `generateContentStream` below is fully faked, so no request reaches a transport.
					apiClient = { apiCall: async () => new Response(null, { status: 200 }) };
					models = {
						generateContentStream: async function* () {
							yield {
								responseId: "resp-1",
								candidates: [
									{
										content: { parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }] },
										finishReason: actual.FinishReason.STOP,
									},
								],
								// no totalTokenCount field at all — must fall back to the computed sum.
								usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 80, candidatesTokenCount: 10 },
							};
						},
					};
					constructor(config: Record<string, unknown>) {
						googleGenAiMock.constructorCalls.push(config);
					}
				},
			};
		});

		vi.resetModules();
		const { getModel } = await import("../src/models.ts");
		const { streamGoogleVertex } = await import("../src/providers/google-vertex.ts");

		const model = getModel("google-vertex", "gemini-2.5-flash");
		const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };

		const first = await streamGoogleVertex(model, context, { apiKey: "fake-key" }).result();
		const second = await streamGoogleVertex(model, context, { apiKey: "fake-key" }).result();

		expect(first.usage.input).toBe(20);
		expect(first.usage.output).toBe(10);
		expect(first.usage.cacheRead).toBe(80);
		expect(first.usage.totalTokens).toBe(110);
		// PORT-DIVERGENCE: B3a (RULEBOOK §5) — oracle computes no cost at all; phase 18 prices from the
		// catalog. gemini-2.5-flash on Vertex bills $0.30/$2.50/$0.03 per million in/out/cacheRead, and
		// the 80 cached tokens are charged at the cacheRead rate only, never also at the input rate.
		expect(first.usage.cost.input).toBeCloseTo(0.000006, 12); // $0.30/M * 20
		expect(first.usage.cost.output).toBeCloseTo(0.000025, 12); // $2.50/M * 10
		expect(first.usage.cost.cacheRead).toBeCloseTo(0.0000024, 12); // $0.03/M * 80
		expect(first.usage.cost.cacheWrite).toBe(0);
		expect(first.usage.cost.total).toBeCloseTo(0.0000334, 12);

		const firstToolCall = first.content.find((b) => b.type === "toolCall");
		const secondToolCall = second.content.find((b) => b.type === "toolCall");
		expect(firstToolCall?.id).toMatch(/^lookup_\d+_1$/);
		expect(secondToolCall?.id).toMatch(/^lookup_\d+_1$/);
	});
});
