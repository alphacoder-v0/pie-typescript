import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { convertMessages, streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, Usage } from "../src/types.ts";

// Ports oracle #[test]s from crates/ai/src/providers/openai_completions.rs:693-802 and locks the
// residual divergences fixed this session against that file:
//   - map_stop_reason (openai_completions.rs:432-440): unrecognized finish_reason -> "stop", not "error"
//   - normalize_base (openai_completions.rs:462-470): bare-host baseUrl gets a "/v1" prefix
//   - run (openai_completions.rs:159, send_with_retry): retries route through the shared
//     packages/ai/src/utils/retry.ts `sendWithRetry`, not the SDK's own retry
//   - convert_messages (openai_completions.rs:518-558): multiple Text blocks in one assistant turn
//     join with "\n", not concatenated bare
// PORT-DIVERGENCE B2 (phase 18's fix for the usage double-count at openai_completions.rs:442-456)
// is locked separately in test/openai-completions-tool-choice.test.ts ("preserves
// prompt_tokens_details cache read/write...").

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

function buildModel(baseUrl = "http://127.0.0.1:1"): Model<"openai-completions"> {
	return {
		id: "repro-model",
		name: "Repro Model",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

function buildAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "repro-provider",
		model: "repro-model",
		usage: emptyUsage,
		stopReason: "stop",
		timestamp: 2,
	};
}

function buildContext(assistant: AssistantMessage): Context {
	return {
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant,
			{ role: "user", content: "continue", timestamp: 3 },
		],
	};
}

describe("openai-completions oracle parity", () => {
	afterEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	// pie: crates/ai/src/providers/openai_completions.rs:518-558 (convert_messages) — oracle joins
	// multiple Text blocks within one assistant turn with "\n" between them.
	it("joins multiple text blocks in one assistant turn with a newline", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext(
				buildAssistant([
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				]),
			),
			compat,
		);

		expect(messages[1]).toEqual({
			role: "assistant",
			content: "first\nsecond",
		});
	});

	async function runAgainstServer(
		handler: (req: http.IncomingMessage, res: http.ServerResponse, requestIndex: number) => void,
	): Promise<{ requestPaths: string[]; result: AssistantMessage }> {
		const requestPaths: string[] = [];
		let requestIndex = 0;
		const server = http.createServer((req, res) => {
			requestPaths.push(req.url ?? "");
			handler(req, res, requestIndex);
			requestIndex++;
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const { port } = server.address() as AddressInfo;
			const events: AssistantMessage[] = [];
			for await (const event of streamOpenAICompletions(
				buildModel(`http://127.0.0.1:${port}`),
				{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
				{ apiKey: "test-key", maxRetries: 1, maxRetryDelayMs: 50 },
			)) {
				if (event.type === "done") {
					events.push(event.message);
				} else if (event.type === "error") {
					events.push(event.error);
				}
			}
			return { requestPaths, result: events[events.length - 1] };
		} finally {
			server.close();
			await once(server, "close");
		}
	}

	function writeSseDone(res: http.ServerResponse): void {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-oracle-parity",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
			})}\n\n`,
		);
		res.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-oracle-parity",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			})}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	}

	// pie: crates/ai/src/providers/openai_completions.rs:462-470,694-707 (normalize_base,
	// base_url_normalizes_to_v1) — a bare-host baseUrl gets "/v1" inserted before "/chat/completions".
	it("normalizes a bare-host baseUrl to include /v1 before /chat/completions", async () => {
		const { requestPaths } = await runAgainstServer((_req, res) => writeSseDone(res));
		expect(requestPaths).toEqual(["/v1/chat/completions"]);
	});

	// pie: crates/ai/src/providers/openai_completions.rs:432-440 (map_stop_reason) — an unrecognized
	// finish_reason value maps to "stop" via oracle's catch-all, not an error.
	it("maps an unrecognized finish_reason to stop instead of erroring", async () => {
		const { result } = await runAgainstServer((_req, res) => {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-unknown-finish",
					choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-unknown-finish",
					choices: [{ index: 0, delta: {}, finish_reason: "some_vendor_specific_reason" }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});
		expect(result.stopReason).toBe("stop");
	});

	// pie: crates/ai/src/providers/openai_completions.rs:159 (run, send_with_retry) +
	// crates/ai/src/utils/retry.ts — a transient 5xx is retried through sendWithRetry before giving up.
	it("retries a transient 500 through sendWithRetry before succeeding", async () => {
		const { requestPaths, result } = await runAgainstServer((_req, res, requestIndex) => {
			if (requestIndex === 0) {
				res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "boom" }));
				return;
			}
			writeSseDone(res);
		});
		expect(requestPaths).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
		expect(result.stopReason).toBe("stop");
	});
});
