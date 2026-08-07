import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Model } from "../src/types.ts";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);

	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key?.toLowerCase() === lowerName);
		return match?.[1] ?? null;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

async function captureOpenAIResponseHeaders(
	options: Parameters<typeof streamOpenAIResponses>[2],
	model: Model<"openai-responses"> = getModel("openai", "gpt-5.4"),
): Promise<{ sessionId: string | null; clientRequestId: string | null }> {
	const captured = { sessionId: null as string | null, clientRequestId: null as string | null };
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAIResponses(
		model,
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key", ...options },
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits reasoning when no reasoning is requested", async () => {
		const model = getModel("github-copilot", "gpt-5-mini");
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload).not.toMatchObject({
			reasoning: expect.anything(),
		});
	});

	it.each(["gpt-5.1", "gpt-5.2", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5"] as const)(
		"omits the reasoning key for OpenAI %s when no reasoning is requested (pie: openai_responses.rs:633-641)",
		async (modelId) => {
			const model = getModel("openai", modelId);
			let capturedPayload: unknown;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			// pie: crates/ai/src/providers/openai_responses.rs:633-641 — oracle writes `reasoning`
			// only when an effort is present; with thinking off the key is absent for EVERY model.
			// This test previously asserted pi's `{effort:"none"}`, which oracle never sends;
			// re-pointed at the oracle contract in phase 17 after parity S3 caught it on a default run.
			expect(capturedPayload).not.toHaveProperty("reasoning");
			expect(capturedPayload).not.toHaveProperty("include");
		},
	);

	it.each(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"] as const)(
		"omits reasoning effort for OpenAI %s when off is unsupported",
		async (modelId) => {
			const model = getModel("openai", modelId);
			let capturedPayload: unknown;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			expect(capturedPayload).not.toMatchObject({
				reasoning: expect.anything(),
			});
		},
	);

	it("sets cache-affinity headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured).toEqual({ sessionId: "session-123", clientRequestId: "session-123" });
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const sessionId = "x".repeat(67);
		let capturedPayload: { prompt_cache_key?: string } | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			getModel("openai", "gpt-5.4"),
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				sessionId,
				onPayload: (payload) => {
					capturedPayload = payload as { prompt_cache_key?: string };
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("sets cache-affinity headers for proxy OpenAI Responses requests with a sessionId", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured).toEqual({ sessionId: "session-123", clientRequestId: "session-123" });
	});

	it("can omit the session_id header while preserving other cache-affinity headers", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionIdHeader: false },
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured).toEqual({ sessionId: null, clientRequestId: "session-123" });
	});

	it("lets explicit headers override the default OpenAI cache-affinity headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured).toEqual({ sessionId: "override-session", clientRequestId: "override-request" });
	});

	// pie: crates/ai/src/providers/openai_responses.rs:180-185 vs :588-596 — oracle keys the
	// session_id/x-client-request-id headers purely on `options.session_id` being present; only the
	// request BODY's prompt_cache_key/prompt_cache_retention fields are additionally gated on
	// cache_retention != None. This test previously asserted pi's base (pre-divergence) behavior of
	// suppressing the headers too; that assertion is superseded by the oracle-aligned fix.
	it("still sends cache-affinity headers when cacheRetention is none (only the body's cache fields are gated)", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured).toEqual({ sessionId: "session-123", clientRequestId: "session-123" });
	});

	// PORT-DIVERGENCE: B3a (RULEBOOK §5) — crates/ai/src/providers/openai_responses.rs:542-564. Two
	// separable gaps used to be conflated here, and phase 18 closes only one of them:
	//
	//   1. Oracle never converts Model.cost into Usage.cost for ANY provider (no cost-catalog
	//      conversion function exists anywhere in oracle's `ai` crate), which is what pinned every
	//      user-visible cost figure at $0. FIXED: `processResponsesStream` now prices from the
	//      catalog for the whole Responses family.
	//   2. The service_tier cost MULTIPLIER is a capability oracle's own file header lists as an
	//      unimplemented TODO (openai_responses.rs:12,18). STILL UNPORTED for this provider, which
	//      wires no `applyServiceTierPricing` callback, so every tier bills at the base catalog rate.
	//      Only openai-codex-responses.ts opts in (see openai-codex-stream.test.ts's multiplier cases).
	//
	// The tier column below is therefore deliberately NOT applied to the expected dollar figures: the
	// same model must cost the same on flex, priority and default. gpt-5.4 bills $2.50/$15 per
	// million in/out and gpt-5.5 $5/$30, against this fixture's 1M input + 1M output tokens.
	it.each([
		["gpt-5.4", "priority", 2],
		["gpt-5.5", "priority", 2.5],
		["gpt-5.5", "flex", 0.5],
	] as const)(
		"prices usage.cost from the catalog for %s, unscaled by the %s service tier (PORT-DIVERGENCE: B3a)",
		async (modelId, serviceTier, _tierMultiplierNotApplied) => {
			const model = getModel("openai", modelId);
			const sse = `${[
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						status: "completed",
						service_tier: serviceTier,
						usage: {
							input_tokens: 1000000,
							output_tokens: 1000000,
							total_tokens: 2000000,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				})}`,
			].join("\n\n")}\n\n`;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{ apiKey: "test-key", serviceTier },
			);

			const result = await stream.result();

			const expected =
				modelId === "gpt-5.5"
					? { input: 5, output: 30, cacheRead: 0, cacheWrite: 0, total: 35 }
					: { input: 2.5, output: 15, cacheRead: 0, cacheWrite: 0, total: 17.5 };
			expect(result.usage.cost).toEqual(expected);
		},
	);
});
