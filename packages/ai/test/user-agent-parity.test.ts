// pie: crates/ai/src/utils/headers.rs:5-7 (user_agent) + crates/ai/src/utils/node_http_proxy.rs:19-22
// (build_client) — oracle's HTTP client sets User-Agent: pie-ai-rs/<CARGO_PKG_VERSION> (=
// "pie-ai-rs/0.75.0", crates/ai/Cargo.toml:3) as a default header, and every one of the 9 providers
// (anthropic.rs:203, openai_completions.rs:133, openai_responses.rs:160, mistral.rs:120,
// google.rs:116, google_vertex.rs:110, amazon_bedrock.rs:86, azure_openai_responses.rs:135,
// openai_codex_responses.rs:128) constructs its HTTP client through it, so the header rides on
// every outbound request regardless of provider.
//
// This suite locks the TS-side wire-observable consequence (F6 in
// migration/reviews/ai/findings-orchestrator.md): every provider's outbound request must carry
// `User-Agent: pie-ai-rs/0.75.0`.
//
// Coverage note: all 9 providers are exercised end-to-end against a real local HTTP server (no SDK
// internals are mocked) so the header capture reflects what actually goes over the wire, not just
// what a config object claims. amazon-bedrock is included even though the AWS SDK v3
// userAgentMiddleware unconditionally overwrites User-Agent at its own "build" step (customUserAgent
// only appends segments, it can't replace the header) — see the finalizeRequest-step middleware
// added in amazon-bedrock.ts's streamBedrock, which forces the literal value after the SDK's own
// middleware has already run.
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamBedrock } from "../src/providers/amazon-bedrock.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.ts";
import { streamGoogle } from "../src/providers/google.ts";
import { streamGoogleVertex } from "../src/providers/google-vertex.ts";
import { streamMistral } from "../src/providers/mistral.ts";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { AssistantMessage } from "../src/types.ts";

const ORACLE_USER_AGENT = "pie-ai-rs/0.75.0";
const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };

/**
 * Spins up a real local HTTP server, captures the headers of every request it receives, runs
 * `run(baseUrl)` against it, and tears the server down. `respond` controls what the server sends
 * back — kept minimal (usually just enough SSE framing to let the provider's stream loop reach
 * "done"/"error" without hanging), since these tests only care about the outbound request header.
 */
async function withServer(
	respond: (req: http.IncomingMessage, res: http.ServerResponse) => void,
	run: (baseUrl: string) => Promise<void>,
): Promise<http.IncomingHttpHeaders[]> {
	const captured: http.IncomingHttpHeaders[] = [];
	const server = http.createServer((req, res) => {
		captured.push(req.headers);
		respond(req, res);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const { port } = server.address() as AddressInfo;
		await run(`http://127.0.0.1:${port}`);
		return captured;
	} finally {
		server.close();
		await once(server, "close");
	}
}

function writeDoneSSE(res: http.ServerResponse): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	res.write("data: [DONE]\n\n");
	res.end();
}

/** Drains an AssistantMessageEventStream to completion; both "done" and "error" are acceptable
 * terminal states here since these tests only assert on the outbound request header, not on
 * response handling — the canned server responses above are deliberately minimal/incomplete. */
async function drain(stream: AsyncIterable<{ type: string; message?: AssistantMessage }>): Promise<void> {
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") return;
	}
}

const originalEnv: Record<string, string | undefined> = {};
function stubEnv(key: string, value: string): void {
	if (!(key in originalEnv)) originalEnv[key] = process.env[key];
	process.env[key] = value;
}

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const key of Object.keys(originalEnv)) delete originalEnv[key];
});

describe("user-agent parity (RULEBOOK F6: all 9 providers carry pie-ai-rs/<version>)", () => {
	it("openai-completions: carries the oracle User-Agent on the chat completions request", async () => {
		const model = { ...getModel("deepseek", "deepseek-v4-flash") };
		const headers = await withServer(
			(_req, res) => writeDoneSSE(res),
			async (baseUrl) => {
				await drain(streamOpenAICompletions({ ...model, baseUrl }, context, { apiKey: "test-key" }));
			},
		);
		expect(headers).toHaveLength(1);
		expect(headers[0]?.["user-agent"]).toBe(ORACLE_USER_AGENT);
	});

	it("openai-responses: carries the oracle User-Agent on the responses request", async () => {
		const model = { ...getModel("openai", "gpt-5-mini") };
		const headers = await withServer(
			(_req, res) => writeDoneSSE(res),
			async (baseUrl) => {
				await drain(streamOpenAIResponses({ ...model, baseUrl }, context, { apiKey: "test-key" }));
			},
		);
		expect(headers).toHaveLength(1);
		expect(headers[0]?.["user-agent"]).toBe(ORACLE_USER_AGENT);
	});

	it("openai-codex-responses: carries the oracle User-Agent, not the removed pi(...) identity string", async () => {
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const token = `aaa.${payload}.bbb`;
		const model = { ...getModel("openai-codex", "gpt-5.5") };
		const headers = await withServer(
			(_req, res) => writeDoneSSE(res),
			async (baseUrl) => {
				await drain(
					streamOpenAICodexResponses({ ...model, baseUrl }, context, { apiKey: token, transport: "sse" }),
				);
			},
		);
		expect(headers).toHaveLength(1);
		expect(headers[0]?.["user-agent"]).toBe(ORACLE_USER_AGENT);
		expect(headers[0]?.["user-agent"]).not.toMatch(/^pi \(/);
		// originator: "pi" is intentionally unchanged (matches oracle openai_codex_responses.rs:142)
		expect(headers[0]?.originator).toBe("pi");
	});

	it("azure-openai-responses: carries the oracle User-Agent on the responses request", async () => {
		const model = { ...getModel("azure-openai-responses", "gpt-4o-mini") };
		const headers = await withServer(
			(_req, res) => writeDoneSSE(res),
			async (baseUrl) => {
				await drain(streamAzureOpenAIResponses(model, context, { apiKey: "test-key", azureBaseUrl: baseUrl }));
			},
		);
		expect(headers).toHaveLength(1);
		expect(headers[0]?.["user-agent"]).toBe(ORACLE_USER_AGENT);
	});

	it("mistral: carries the oracle User-Agent, overriding the SDK's own CustomUserAgentHook", async () => {
		const model = { ...getModel("mistral", "devstral-medium-latest") };
		const headers = await withServer(
			(_req, res) => writeDoneSSE(res),
			async (baseUrl) => {
				await drain(streamMistral({ ...model, baseUrl }, context, { apiKey: "test-key" }));
			},
		);
		expect(headers).toHaveLength(1);
		expect(headers[0]?.["user-agent"]).toBe(ORACLE_USER_AGENT);
		expect(headers[0]?.["user-agent"]).not.toMatch(/^mistral-client-typescript\//);
	});

	it("anthropic: carries the oracle User-Agent on the (API-key) messages request", async () => {
		const model = { ...getModel("anthropic", "claude-haiku-4-5") };
		const headers = await withServer(
			(_req, res) => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end();
			},
			async (baseUrl) => {
				await drain(streamAnthropic({ ...model, baseUrl }, context, { apiKey: "test-key" }));
			},
		);
		expect(headers).toHaveLength(1);
		expect(headers[0]?.["user-agent"]).toBe(ORACLE_USER_AGENT);
	});

	it("google: carries the oracle User-Agent, overriding the @google/genai SDK's own default", async () => {
		const model = { ...getModel("google", "gemini-2.5-flash") };
		const headers = await withServer(
			(_req, res) => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write("data: {}\n\n");
				res.end();
			},
			async (baseUrl) => {
				await drain(streamGoogle({ ...model, baseUrl }, context, { apiKey: "test-key" }));
			},
		);
		expect(headers).toHaveLength(1);
		expect(headers[0]?.["user-agent"]).toBe(ORACLE_USER_AGENT);
	});

	it("google-vertex: carries the oracle User-Agent, overriding the @google/genai SDK's own default", async () => {
		const model = { ...getModel("google-vertex", "gemini-2.5-flash") };
		const headers = await withServer(
			(_req, res) => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write("data: {}\n\n");
				res.end();
			},
			async (baseUrl) => {
				await drain(streamGoogleVertex({ ...model, baseUrl }, context, { apiKey: "test-key" }));
			},
		);
		expect(headers).toHaveLength(1);
		expect(headers[0]?.["user-agent"]).toBe(ORACLE_USER_AGENT);
	});

	// amazon-bedrock: the AWS SDK v3's own userAgentMiddleware (build step) unconditionally
	// overwrites User-Agent with its own "aws-sdk-js/... md/... api/bedrock-runtime#..." string;
	// there's no config-level way to replace it (customUserAgent only appends segments). Forced via
	// a finalizeRequest-step middleware added right after client construction (see
	// amazon-bedrock.ts:streamBedrock). AWS_BEDROCK_FORCE_HTTP1 is required because this SDK version
	// defaults to NodeHttp2Handler, which needs real TLS/ALPN negotiation this plain-HTTP local
	// server can't provide; AWS_BEDROCK_SKIP_AUTH supplies dummy static credentials so SigV4 signing
	// succeeds locally without real AWS access.
	it("amazon-bedrock: carries the oracle User-Agent via the finalizeRequest override middleware", async () => {
		stubEnv("AWS_BEDROCK_FORCE_HTTP1", "1");
		stubEnv("AWS_BEDROCK_SKIP_AUTH", "1");
		const model = { ...getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0") };
		const headers = await withServer(
			(_req, res) => {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ message: "local test server does not implement ConverseStream" }));
			},
			async (baseUrl) => {
				await drain(streamBedrock({ ...model, baseUrl }, context, {}));
			},
		);
		expect(headers).toHaveLength(1);
		expect(headers[0]?.["user-agent"]).toBe(ORACLE_USER_AGENT);
	});
});
