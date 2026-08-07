/**
 * pie: crates/mcp/tests/http_fixture.rs — ported per manifest row `mcp/tests/http_fixture`
 * (char-tests). "Hermetic Streamable HTTP transport fixture. No real hub/Cloudflare calls."
 * Oracle spins up a real in-process `axum` server; this port spins up a real `node:http` server
 * for the same reason (genuine HTTP round-trip through `fetch`, not a mocked transport) —
 * matching the spirit of the oracle file's own doc comment, and satisfying the RULEBOOK §4 wire
 * construct probe gate's expectation that fixtures exercise real transports where oracle does.
 *
 * 3 tests, matching the 3 `#[tokio::test]` functions in the oracle file 1:1.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { McpClient } from "../../src/client.ts";
import { McpError } from "../../src/errors.ts";
import { createHttpMcpTransportOptions, HttpMcpTransport, withBearerAuth } from "../../src/http.ts";

type FixtureMode = "normal" | "http-error" | "oversize";

interface Fixture {
	endpoint: string;
	seenAuth: string[];
	close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** pie: http_fixture.rs:14-19,100-116 (`struct FixtureState` + `spawn_fixture`). */
async function spawnFixture(mode: FixtureMode): Promise<Fixture> {
	const seenAuth: string[] = [];

	const server = createServer((req, res) => {
		void handleRequest(req, res, mode, seenAuth).catch((error) => {
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
		seenAuth,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** pie: http_fixture.rs:166-177 (`fn check_auth`). */
function checkAuth(req: IncomingMessage, res: ServerResponse, seenAuth: string[]): boolean {
	const auth = req.headers.authorization ?? "";
	seenAuth.push(auth);
	if (auth !== "Bearer fixture-token") {
		res.statusCode = 401;
		res.end();
		return false;
	}
	return true;
}

/** pie: http_fixture.rs:118-153 (`async fn post_mcp`). */
async function handlePost(req: IncomingMessage, res: ServerResponse, mode: FixtureMode): Promise<void> {
	if (mode === "http-error") {
		res.statusCode = 400;
		res.end("hub_agent_should_not_leak payload secret");
		return;
	}
	if (mode === "oversize") {
		res.statusCode = 200;
		res.end("x".repeat(2 * 1024 * 1024));
		return;
	}
	const body = await readBody(req);
	const payload = JSON.parse(body) as { id?: number; method?: string };
	if (payload.id === undefined) {
		res.statusCode = 202;
		res.end();
		return;
	}
	let result: unknown;
	if (payload.method === "initialize") {
		result = {
			protocolVersion: "2025-03-26",
			capabilities: {},
			serverInfo: { name: "fixture-hub", version: "0.1.0" },
		};
	} else if (payload.method === "tools/list") {
		result = { tools: [{ name: "send_notification", description: "fixture", inputSchema: { type: "object" } }] };
	} else {
		throw new Error(`unexpected method ${payload.method}`);
	}
	res.setHeader("content-type", "application/json");
	res.statusCode = 200;
	res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
}

/** pie: http_fixture.rs:155-164 (`async fn get_mcp`) — identical across all fixture modes. */
function handleGet(res: ServerResponse): void {
	res.setHeader("content-type", "text/event-stream");
	res.statusCode = 200;
	res.end(
		'id: fixture-1\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/agent_message","params":{"_meta":{"pie_summary":"fixture","pie_dedup_key":"fixture-1"}}}\n\n',
	);
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	mode: FixtureMode,
	seenAuth: string[],
): Promise<void> {
	if (!checkAuth(req, res, seenAuth)) return;
	if (req.method === "POST" && req.url === "/mcp") {
		await handlePost(req, res, mode);
		return;
	}
	if (req.method === "GET" && req.url === "/mcp") {
		handleGet(res);
		return;
	}
	res.statusCode = 404;
	res.end();
}

describe("mcp streamable-http fixture (pie: crates/mcp/tests/http_fixture.rs)", () => {
	it("streamable_http_posts_requests_and_receives_sse_notifications", async () => {
		const fixture = await spawnFixture("normal");
		try {
			const transport = HttpMcpTransport.connect(
				withBearerAuth(createHttpMcpTransportOptions(fixture.endpoint), "fixture-token"),
			);
			const client = new McpClient(transport);

			const init = await client.initialize("pie-test");
			expect(init.serverInfo.name).toBe("fixture-hub");

			const notifications = client.takeNotifications();
			expect(notifications).toBeDefined();
			if (!notifications) throw new Error("unreachable");

			const tools = await client.toolsList();
			expect(tools.length).toBe(1);
			expect(tools[0]?.name).toBe("send_notification");

			const notification = await Promise.race([
				notifications.recv(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("notification should arrive")), 2000)),
			]);
			expect(notification).toBeDefined();
			expect(notification?.method).toBe("notifications/agent_message");
			const meta = (notification?.params as { _meta?: { pie_summary?: string } } | undefined)?._meta;
			expect(meta?.pie_summary).toBe("fixture");

			await transport.close();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fixture.seenAuth.length).toBeGreaterThan(0);
			expect(fixture.seenAuth.every((header) => header === "Bearer fixture-token")).toBe(true);
		} finally {
			await fixture.close();
		}
	});

	it("streamable_http_error_body_is_redacted", async () => {
		const fixture = await spawnFixture("http-error");
		try {
			const transport = HttpMcpTransport.connect(
				withBearerAuth(createHttpMcpTransportOptions(fixture.endpoint), "fixture-token"),
			);

			let message = "";
			try {
				await transport.sendLine('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
				throw new Error("expected sendLine to reject");
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).toContain("400 Bad Request");
			expect(message).not.toContain("hub_agent_should_not_leak");
			expect(message).not.toContain("payload secret");

			await transport.close();
		} finally {
			await fixture.close();
		}
	});

	it("streamable_http_body_cap_rejects_oversize_response", async () => {
		const fixture = await spawnFixture("oversize");
		try {
			const transport = HttpMcpTransport.connect(
				withBearerAuth(createHttpMcpTransportOptions(fixture.endpoint), "fixture-token"),
			);

			let caught: unknown;
			try {
				await transport.sendLine('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(McpError);
			expect((caught as McpError).code).toBe("protocol");
			expect((caught as McpError).message).toContain("exceeded cap");

			await transport.close();
		} finally {
			await fixture.close();
		}
	});
});
