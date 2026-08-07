/**
 * phase 20-3: ports the group of inline tests in upstream `crates/ai` covering URL resolution,
 * compatibility flags and stop-reason mapping.
 *
 * The assertions are **upstream's**. Each case names the `#[test]` it was ported from.
 * A local HTTP server on `127.0.0.1:0` captures the real request path, because URL resolution rules
 * are only decidable once a request is actually sent.
 */
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { getModel } from "../../src/models.ts";
import { streamAzureOpenAIResponses } from "../../src/providers/azure-openai-responses.ts";
import { streamOpenAICodexResponses } from "../../src/providers/openai-codex-responses.ts";
import { streamOpenAICompletions } from "../../src/providers/openai-completions.ts";
import type { Api, AssistantMessage, Context, Model, StopReason } from "../../src/types.ts";

const CONTEXT: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

/** Starts a server that records nothing but the request path, and closes when the body is done. */
async function withServer<T>(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
	body: (baseUrl: string, paths: string[]) => Promise<T>,
): Promise<T> {
	const paths: string[] = [];
	const server = http.createServer((req, res) => {
		paths.push(req.url ?? "");
		handler(req, res);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = server.address() as AddressInfo;
		return await body(`http://127.0.0.1:${port}`, paths);
	} finally {
		server.close();
		await once(server, "close");
	}
}

function completionsModel(baseUrl: string): Model<Api> {
	return {
		id: "m",
		name: "m",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as Model<Api>;
}

/** Emits a minimal SSE stream carrying the given finish_reason. */
function writeFinish(res: http.ServerResponse, finishReason: string): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	res.write(
		`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "x" } }] })}\n\n`,
	);
	res.write(
		`data: ${JSON.stringify({
			id: "c",
			choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// providers/openai_completions.rs `finish_reason_mapping`
// ─────────────────────────────────────────────────────────────────────────────

describe("openai-completions: mapping finish_reason to stopReason", () => {
	async function stopReasonFor(finishReason: string): Promise<StopReason> {
		return withServer(
			(_req, res) => writeFinish(res, finishReason),
			async (baseUrl) => {
				let last: AssistantMessage | undefined;
				for await (const ev of streamOpenAICompletions(completionsModel(baseUrl) as never, CONTEXT, {
					apiKey: "fake-key",
				})) {
					if (ev.type === "done") last = ev.message;
					else if (ev.type === "error") last = ev.error;
				}
				if (!last) throw new Error("the stream produced no terminal message");
				return last.stopReason;
			},
		);
	}

	// pie: crates/ai/src/providers/openai_completions.rs `finish_reason_mapping`
	// Upstream lists four, of which content_filter → Error is the only one that maps to an error. The
	// existing openai-completions-oracle-parity.test.ts covers only the fallback of an unrecognised
	// value to stop, and none of these four.
	it("stop→stop, length→length, tool_calls→toolUse, content_filter→error", async () => {
		expect(await stopReasonFor("stop")).toBe("stop");
		expect(await stopReasonFor("length")).toBe("length");
		expect(await stopReasonFor("tool_calls")).toBe("toolUse");
		expect(await stopReasonFor("content_filter")).toBe("error");
	}, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// providers/openai_codex_responses.rs `url_resolution`
// ─────────────────────────────────────────────────────────────────────────────

describe("openai-codex-responses: resolving baseUrl to a request path", () => {
	/** codex extracts accountId from the token before building the payload, so the fake key has to be
	 * JWT-shaped. */
	function codexToken(): string {
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		return `aaa.${payload}.bbb`;
	}

	async function pathFor(suffix: string): Promise<string> {
		return withServer(
			(_req, res) => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`data: ${JSON.stringify({ type: "response.completed", response: { id: "r", output: [] } })}\n\n`);
				res.end();
			},
			async (baseUrl, paths) => {
				const model = { ...getModel("openai-codex", "gpt-5.3-codex"), baseUrl: `${baseUrl}${suffix}` };
				await streamOpenAICodexResponses(model as never, CONTEXT, {
					apiKey: codexToken(),
					transport: "sse",
				}).result();
				return paths[0] ?? "";
			},
		);
	}

	// pie: crates/ai/src/providers/openai_codex_responses.rs `url_resolution`
	// Three input shapes each complete to the same endpoint `…/codex/responses`, and one that is
	// already complete gains nothing further.
	it("/backend-api gains /codex/responses, /codex gains /responses, a complete path is left alone", async () => {
		expect(await pathFor("/backend-api")).toBe("/backend-api/codex/responses");
		expect(await pathFor("/codex")).toBe("/codex/responses");
		expect(await pathFor("/codex/responses")).toBe("/codex/responses");
	}, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// providers/azure_openai_responses.rs — resolving the deployment name
// ─────────────────────────────────────────────────────────────────────────────

describe("azure-openai-responses: the deployment name", () => {
	function azureModel(): Model<Api> {
		return {
			id: "gpt-5",
			name: "gpt-5",
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "http://127.0.0.1:9/openai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		} as Model<Api>;
	}

	async function payloadModelField(options: Record<string, unknown>): Promise<string> {
		let captured: Record<string, any> | undefined;
		const saved = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
		delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
		try {
			await streamAzureOpenAIResponses(azureModel() as never, CONTEXT, {
				apiKey: "fake-key",
				...options,
				onPayload: (payload: unknown) => {
					captured = payload as Record<string, any>;
					return payload;
				},
			} as never).result();
		} finally {
			if (saved !== undefined) process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = saved;
		}
		if (!captured) throw new Error("the payload was never captured");
		return captured.model;
	}

	// pie: crates/ai/src/providers/azure_openai_responses.rs `deployment_name_defaults_to_model_id`
	it("with nothing configured, the deployment name is model.id", async () => {
		expect(await payloadModelField({})).toBe("gpt-5");
	}, 20_000);

	// pie: crates/ai/src/providers/azure_openai_responses.rs `deployment_name_from_option`
	it("an explicit azureDeploymentName wins over model.id", async () => {
		expect(await payloadModelField({ azureDeploymentName: "my-deploy" })).toBe("my-deploy");
	}, 20_000);
});

// `parse_callback` and `parse_callback_no_query` from utils/oauth/anthropic.rs are **not in this
// file**: they have to drive `loginAnthropic`, which binds the fixed port 53692 — the same one
// `anthropic-oauth.test.ts` uses. Running files in parallel under vitest collides with EADDRINUSE,
// intermittently, depending on scheduling order. They now live in `anthropic-oauth.test.ts`, under
// the same describe.sequential as everything else that takes that port.

// `fireworks_compat_disables_cache_on_tools` from providers/anthropic.rs is **not in this file**:
// deduplicating by name put it among the 46 counted as unported, but the behavior is already covered
// `packages/ai/test/fireworks-models.test.ts:56`（"sets Fireworks-specific compat for session
// affinity and unsupported tool fields"), and by :212 and :183. That is a false negative from
// name-based deduplication, recorded as covered in the dedup table in
// migration/reviews/phase20/ai-inline-port.md.
