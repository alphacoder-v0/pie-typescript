import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Ports crates/ai/src/providers/google.rs's #[test]s (lines 480-538) and
// crates/ai/src/providers/google_shared.rs's map_stop_reason, plus locks the divergences found
// this session: mapStopReason's default case is "stop" (not "error"), usage.totalTokens falls back
// to the locally-computed sum only when the field is absent (not whenever falsy), and the
// tool-call-id counter is scoped per stream instead of a process-lifetime global.
//
// Oracle also has no cost calculation anywhere (BUG(port) B3a). That one is now a deliberate
// PORT-DIVERGENCE — phase 18 prices usage.cost from the catalog; see the pricing assertions below.

describe("mapStopReason (google-shared)", () => {
	// pie: crates/ai/src/providers/google_shared.rs:30-37 (map_stop_reason) — only STOP/MAX_TOKENS/
	// {SAFETY,RECITATION,BLOCKLIST,PROHIBITED_CONTENT} are special-cased; everything else is "stop".
	it("maps the recognized oracle cases", async () => {
		const { mapStopReason } = await import("../src/providers/google-shared.ts");
		const { FinishReason } = await import("@google/genai");
		expect(mapStopReason(FinishReason.STOP)).toBe("stop");
		expect(mapStopReason(FinishReason.MAX_TOKENS)).toBe("length");
		expect(mapStopReason(FinishReason.SAFETY)).toBe("error");
		expect(mapStopReason(FinishReason.RECITATION)).toBe("error");
		expect(mapStopReason(FinishReason.BLOCKLIST)).toBe("error");
		expect(mapStopReason(FinishReason.PROHIBITED_CONTENT)).toBe("error");
	});

	it("maps every other reason to stop, not error (oracle's catch-all)", async () => {
		const { mapStopReason } = await import("../src/providers/google-shared.ts");
		const { FinishReason } = await import("@google/genai");
		expect(mapStopReason(FinishReason.SPII)).toBe("stop");
		expect(mapStopReason(FinishReason.IMAGE_SAFETY)).toBe("stop");
		expect(mapStopReason(FinishReason.IMAGE_PROHIBITED_CONTENT)).toBe("stop");
		expect(mapStopReason(FinishReason.IMAGE_RECITATION)).toBe("stop");
		expect(mapStopReason(FinishReason.IMAGE_OTHER)).toBe("stop");
		expect(mapStopReason(FinishReason.FINISH_REASON_UNSPECIFIED)).toBe("stop");
		expect(mapStopReason(FinishReason.OTHER)).toBe("stop");
		expect(mapStopReason(FinishReason.LANGUAGE)).toBe("stop");
		expect(mapStopReason(FinishReason.MALFORMED_FUNCTION_CALL)).toBe("stop");
		expect(mapStopReason(FinishReason.UNEXPECTED_TOOL_CALL)).toBe("stop");
		expect(mapStopReason(FinishReason.NO_IMAGE)).toBe("stop");
	});
});

describe("mapStopReasonString (google-shared, currently unreferenced)", () => {
	it("mirrors mapStopReason's oracle-faithful default", async () => {
		const { mapStopReasonString } = await import("../src/providers/google-shared.ts");
		expect(mapStopReasonString("STOP")).toBe("stop");
		expect(mapStopReasonString("MAX_TOKENS")).toBe("length");
		expect(mapStopReasonString("SAFETY")).toBe("error");
		expect(mapStopReasonString("SOME_UNRECOGNIZED_FUTURE_REASON")).toBe("stop");
	});
});

describe("google request body shape (onPayload capture)", () => {
	interface GooglePayload {
		model: string;
		contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
		config?: { systemInstruction?: string; tools?: Array<{ functionDeclarations: unknown[] }> };
	}

	async function capturePayload(
		context: Parameters<typeof import("../src/index.ts").complete>[1],
	): Promise<GooglePayload> {
		const { getModel } = await import("../src/models.ts");
		const { complete } = await import("../src/index.ts");
		const model = { ...getModel("google", "gemini-2.5-flash"), baseUrl: "http://127.0.0.1:9" };
		let captured: GooglePayload | undefined;
		await complete(model, context, {
			apiKey: "fake-key",
			onPayload: (payload) => {
				captured = payload as unknown as GooglePayload;
				return payload;
			},
		});
		if (!captured) throw new Error("Expected payload to be captured before request failure");
		return captured;
	}

	// pie: crates/ai/src/providers/google.rs:480-495 (body_has_contents_and_system_instruction)
	it("puts contents[0] as the user turn and config.systemInstruction as the system prompt", async () => {
		const payload = await capturePayload({
			systemPrompt: "be brief",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});
		expect(payload.config?.systemInstruction).toBe("be brief");
		expect(payload.contents[0]?.role).toBe("user");
		expect(payload.contents[0]?.parts[0]?.text).toBe("hi");
	});

	// pie: crates/ai/src/providers/google.rs:522-538 (tools_become_function_declarations) +
	// google_shared.rs:134-146 (convert_tools) — a single tools[] entry wraps ALL declarations.
	it("wraps tools into a single functionDeclarations entry", async () => {
		const payload = await capturePayload({
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [{ name: "lookup", description: "look", parameters: { type: "object", properties: {} } }],
		});
		expect(payload.config?.tools).toHaveLength(1);
		expect(payload.config?.tools?.[0]?.functionDeclarations).toHaveLength(1);
	});
});

describe("google streaming: usage/cost/tool-id-counter", () => {
	const googleGenAiMock = vi.hoisted(() => ({ constructorCalls: [] as Array<Record<string, unknown>> }));

	beforeEach(() => {
		googleGenAiMock.constructorCalls.length = 0;
	});

	afterEach(() => {
		vi.doUnmock("@google/genai");
		vi.resetModules();
	});

	it("keeps usage.cost at zero, falls back totalTokens to the computed sum when absent, and resets the tool-id counter per stream", async () => {
		vi.doMock("@google/genai", async () => {
			const actual = await vi.importActual<typeof import("@google/genai")>("@google/genai");
			return {
				...actual,
				GoogleGenAI: class {
					// providers/google-retry.ts wires pie's `send_with_retry` (crates/ai/src/utils/retry.rs)
					// into the SDK's single request egress, `ApiClient#apiCall`, and throws if that entry
					// point is absent rather than silently shipping a Gemini client with no retry at all.
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
		const { streamGoogle } = await import("../src/providers/google.ts");

		const model = getModel("google", "gemini-2.5-flash");
		const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };

		const first = await streamGoogle(model, context, { apiKey: "fake-key" }).result();
		const second = await streamGoogle(model, context, { apiKey: "fake-key" }).result();

		// pie: crates/ai/src/providers/google.rs:391-415 (update_usage) — input = prompt - cached =
		// 20; output = candidates + thoughts = 10; total falls back to 20+10+80 = 110 (totalTokenCount
		// absent from the mock chunk).
		expect(first.usage.input).toBe(20);
		expect(first.usage.output).toBe(10);
		expect(first.usage.cacheRead).toBe(80);
		expect(first.usage.totalTokens).toBe(110);
		// PORT-DIVERGENCE: B3a (RULEBOOK §5) — no ORACLE provider computes usage.cost, which pinned
		// every user-visible cost figure at $0; phase 18 prices it from the catalog instead.
		// gemini-2.5-flash bills $0.30/$2.50/$0.03 per million in/out/cacheRead, and the 80 cached
		// tokens are charged at the cacheRead rate only — never also at the full input rate.
		expect(first.usage.cost.input).toBeCloseTo(0.000006, 12); // $0.30/M * 20
		expect(first.usage.cost.output).toBeCloseTo(0.000025, 12); // $2.50/M * 10
		expect(first.usage.cost.cacheRead).toBeCloseTo(0.0000024, 12); // $0.03/M * 80
		expect(first.usage.cost.cacheWrite).toBe(0);
		expect(first.usage.cost.total).toBeCloseTo(0.0000334, 12);

		// pie: crates/ai/src/providers/google.rs:186,275-284 — tool_counter resets to 0 per stream,
		// so two independent streams with a missing functionCall.id produce ids with the same
		// trailing counter suffix ("_1"), not an ever-increasing one.
		const firstToolCall = first.content.find((b) => b.type === "toolCall");
		const secondToolCall = second.content.find((b) => b.type === "toolCall");
		expect(firstToolCall?.id).toMatch(/^lookup_\d+_1$/);
		expect(secondToolCall?.id).toMatch(/^lookup_\d+_1$/);
	});
});
