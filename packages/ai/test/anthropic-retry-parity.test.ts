/**
 * Locks in that anthropic.ts wires `sendWithRetry` (crates/ai/src/utils/retry.rs) into the
 * Anthropic SDK client's `fetch`, the same pattern used by openai-completions.ts and
 * openai-responses.ts, instead of relying solely on the Anthropic SDK's own built-in retry (which
 * has its own, oracle-independent, retryable-status set and backoff curve). Uses a real local HTTP
 * server (not a fake `options.client` injection) so the request actually goes through
 * `createClient`'s `fetch` wiring — same harness shape as
 * test/anthropic-eager-tool-input-compat.test.ts.
 *
 * pie: crates/ai/src/providers/anthropic.rs:238 (run, `send_with_retry`) + crates/ai/src/utils/retry.rs
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";

function createModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

interface RetryServer {
	port: number;
	requestCount: () => number;
	close: () => Promise<void>;
}

async function startRetryServer(firstStatusFailures: number): Promise<RetryServer> {
	let count = 0;
	const server = createServer((_req, res) => {
		count += 1;
		if (count <= firstStatusFailures) {
			res.writeHead(409, { "content-type": "text/plain" }).end("conflict");
			return;
		}
		writeEmptySseResponse(res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return {
		port: address.port,
		requestCount: () => count,
		close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}

describe("Anthropic retry parity (pie: providers/anthropic.rs:238 send_with_retry)", () => {
	it("retries a 409 once (via sendWithRetry-backed fetch) and succeeds on the second attempt", async () => {
		const server = await startRetryServer(1);
		try {
			const model = createModel(`http://127.0.0.1:${server.port}`);
			const stream = streamAnthropic(model, context, {
				apiKey: "test-key",
				cacheRetention: "none",
				maxRetries: 2,
				maxRetryDelayMs: 1000,
			});

			const result = await stream.result();

			expect(result.errorMessage, result.errorMessage).toBeUndefined();
			expect(result.stopReason).not.toBe("error");
			expect(server.requestCount()).toBe(2);
		} finally {
			await server.close();
		}
	});

	it("gives up once maxRetries is exhausted, matching sendWithRetry's own budget", async () => {
		const server = await startRetryServer(Number.POSITIVE_INFINITY);
		try {
			const model = createModel(`http://127.0.0.1:${server.port}`);
			const stream = streamAnthropic(model, context, {
				apiKey: "test-key",
				cacheRetention: "none",
				maxRetries: 1,
				maxRetryDelayMs: 200,
			});

			const result = await stream.result();

			expect(result.stopReason).toBe("error");
			// Initial attempt + 1 retry = 2 requests total, then give up (matching sendWithRetry.test.ts
			// integration coverage in test/retry.test.ts).
			expect(server.requestCount()).toBe(2);
		} finally {
			await server.close();
		}
	});
});
