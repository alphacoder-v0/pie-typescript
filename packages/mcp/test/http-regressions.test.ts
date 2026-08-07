/**
 * Regression coverage for the phase-6 fixer pass's `HttpMcpTransport` findings, using a real
 * `node:http` server the same way `test/ported/http-fixture.test.ts` does (genuine HTTP
 * round-trip through `fetch`, not a mocked transport):
 *  - finding #1 (http.rs:305-310): a body-read error on a POST-triggered SSE response must be
 *    dropped silently, never routed onto the shared line channel — routing it there would make
 *    `McpClient`'s read pump treat it as a fatal transport-closed error and drain every other
 *    in-flight request.
 *  - finding #2 (http.rs:184-186 vs. 242,255-257): a POST timeout must map to
 *    `McpError.transport`, distinct from a GET/SSE-connect timeout which stays
 *    `McpError.timeout`.
 *  - finding #5a (http.rs's `send_line`, no `close_token`): `close()` must not abort an in-flight
 *    POST.
 *  - finding #5b (http.rs:205-210 `handle.abort()`): the SSE read loop must actually release the
 *    underlying connection (`reader.cancel()`) on every exit path, not just release the JS-level
 *    lock — demonstrated here via an idle-timeout exit, which involves no `AbortSignal` at all, so
 *    any connection teardown observed is attributable only to the `finally` block's own cleanup.
 *
 * Not a port of any single oracle test — implementer-added regression coverage per the fixer
 * task, in the same spirit as `wire-shapes.test.ts`'s RULEBOOK §4 self-declared "not a port"
 * fixtures.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { McpError } from "../src/errors.ts";
import { createHttpMcpTransportOptions, HttpMcpTransport, type HttpMcpTransportOptions } from "../src/http.ts";

interface JsonRpcPayload {
	id?: number;
	method?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

interface Fixture {
	endpoint: string;
	close(): Promise<void>;
}

/** Spawns a POST-only JSON-RPC fixture; `handlePost` decides how each request's `res` is answered. */
async function spawnJsonRpcFixture(
	handlePost: (payload: JsonRpcPayload, res: ServerResponse) => void,
): Promise<Fixture> {
	const server = createServer((req, res) => {
		void (async () => {
			if (req.method !== "POST") {
				res.statusCode = 404;
				res.end();
				return;
			}
			const body = await readBody(req);
			const payload = JSON.parse(body) as JsonRpcPayload;
			handlePost(payload, res);
		})().catch((error) => {
			res.statusCode = 500;
			res.end(String(error));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address() as AddressInfo;
	return {
		endpoint: `http://127.0.0.1:${address.port}/mcp`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

describe("HttpMcpTransport phase-6 fixer regressions", () => {
	it("finding #1: a body-read error on a POST-triggered SSE response is dropped silently and other in-flight requests are unaffected", async () => {
		const fixture = await spawnJsonRpcFixture((payload, res) => {
			if (payload.id === 1) {
				// Content-type text/event-stream whose single data line exceeds bodyCapBytes below —
				// SseParser.push() throws inside the detached background readSseResponse() task.
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(`data: ${"x".repeat(500)}\n\n`);
				return;
			}
			res.setHeader("content-type", "application/json");
			res.statusCode = 200;
			res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { ok: true } }));
		});
		try {
			const options: HttpMcpTransportOptions = {
				...createHttpMcpTransportOptions(fixture.endpoint),
				bodyCapBytes: 256,
			};
			const transport = HttpMcpTransport.connect(options);

			await transport.sendLine('{"jsonrpc":"2.0","id":1,"method":"whatever"}');
			// Give the detached background SSE-body read task time to hit its cap-exceeded error.
			await new Promise((resolve) => setTimeout(resolve, 100));

			await transport.sendLine('{"jsonrpc":"2.0","id":2,"method":"whatever"}');
			// If request #1's background failure had leaked onto the shared channel, this would throw
			// (FIFO: the stray error entry would be ahead of request #2's response).
			const line = await transport.recvLine();
			expect(line).toBeDefined();
			expect(JSON.parse(line as string)).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });

			await transport.close();
		} finally {
			await fixture.close();
		}
	});

	it("finding #2: a POST timeout maps to McpError.transport, not McpError.timeout", async () => {
		const fixture = await spawnJsonRpcFixture(() => {
			// Never respond — forces the client's per-request timeout to fire.
		});
		try {
			const options: HttpMcpTransportOptions = {
				...createHttpMcpTransportOptions(fixture.endpoint),
				requestTimeoutMs: 100,
			};
			const transport = HttpMcpTransport.connect(options);

			let caught: unknown;
			try {
				await transport.sendLine('{"jsonrpc":"2.0","id":1,"method":"hang"}');
				throw new Error("expected sendLine to reject");
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(McpError);
			expect((caught as McpError).code).toBe("transport");
			expect((caught as McpError).code).not.toBe("timeout");

			await transport.close();
		} finally {
			await fixture.close();
		}
	});

	it("finding #5a: close() does not abort an in-flight POST", async () => {
		const fixture = await spawnJsonRpcFixture((payload, res) => {
			setTimeout(() => {
				res.setHeader("content-type", "application/json");
				res.statusCode = 200;
				res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { ok: true } }));
			}, 300);
		});
		try {
			const transport = HttpMcpTransport.connect(createHttpMcpTransportOptions(fixture.endpoint));
			const sendPromise = transport.sendLine('{"jsonrpc":"2.0","id":1,"method":"slow"}');

			await new Promise((resolve) => setTimeout(resolve, 100));
			await transport.close(); // called while the POST above is still in flight

			// Must resolve normally — close() must not have aborted it.
			await expect(sendPromise).resolves.toBeUndefined();
			const line = await transport.recvLine();
			expect(JSON.parse(line as string)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
		} finally {
			await fixture.close();
		}
	});

	it("finding #5b: an idle SSE read timeout releases the underlying connection (reader.cancel())", async () => {
		let socketClosed = false;
		let resolveClosed: (() => void) | undefined;
		const closedPromise = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});

		const server = createServer((req, res) => {
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(": connected\n\n"); // heartbeat only, then go silent — idle timeout must fire.
				req.socket.on("close", () => {
					socketClosed = true;
					resolveClosed?.();
				});
				return;
			}
			res.statusCode = 404;
			res.end();
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address() as AddressInfo;
		const endpoint = `http://127.0.0.1:${address.port}/mcp`;

		try {
			const options: HttpMcpTransportOptions = {
				...createHttpMcpTransportOptions(endpoint),
				sseIdleTimeoutMs: 150,
				// Avoid an immediate reconnect attempt racing with/muddying the assertion below.
				reconnectPolicy: { initialDelayMs: 10_000, maxDelayMs: 10_000, maxAttempts: undefined },
			};
			const transport = HttpMcpTransport.connect(options);

			await Promise.race([
				closedPromise,
				new Promise<void>((_resolve, reject) =>
					setTimeout(
						() => reject(new Error("server never observed the GET socket close after the idle timeout")),
						3000,
					),
				),
			]);
			expect(socketClosed).toBe(true);

			await transport.close();
		} finally {
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
