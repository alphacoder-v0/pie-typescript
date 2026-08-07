/**
 * phase 21 batch C — the three fixture-server tests in upstream
 * `crates/coding-agent/src/local_models.rs`.
 *
 * These are among the few upstream tests that **actually start a local HTTP server, actually send a
 * request, and actually consume the stream**:
 *
 * | upstream test | what it asserts |
 * |---|---|
 * | `loaded_openai_responses_model_streams_text_from_local_fixture` | a custom model loaded from models.json reassembles the SSE text back into `"OK"` |
 * | `loaded_openai_responses_model_streams_tool_call_from_local_fixture` | the same, but what comes back is a tool call |
 * | `ds4_responses_model_uses_ds4_env_not_openai_env` | the `Authorization` on the wire carries **this provider's** key, and not one byte of the other provider's value appears |
 *
 * ## Why this was not covered before
 *
 * - `local-models.test.ts` asserts only at the **configuration layer** — descriptor fields, whether
 *   a model registers, override precedence — with no HTTP at all.
 * - `models-json-harm.test.ts` does start a server, but it asserts on the **outbound request**
 *   (`captured[0].authorization`), and its `complete(...).catch(() => undefined)` swallows any
 *   stream-parsing failure whole. So it proves the request reached that address, not that the
 *   response can be parsed back.
 *
 * Together they still miss what these three upstream tests hold: **whether the `api` field in
 * models.json really selects a working adapter**, and **whether a custom provider's credential scope
 * holds on the wire**.
 *
 * That is worth closing here in particular: batch A of phase 21 had just found custom models to be
 * invisible to the `/model` command — a surface asserted only at the configuration layer, where
 * nothing goes red when it breaks.
 *
 * Hermetic: the server binds `127.0.0.1:0`, so the kernel picks a port and nothing is contended;
 * `models.json` is written in a `mkdtemp` directory with `PIE_DIR` pointed at it; nothing leaves the
 * machine, the real `~/.pie/` is untouched, and every credential is synthetic.
 */

import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stream } from "@pie/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_BASE_DIR } from "../../src/config.ts";
import { getCustomModel, loadAll, unregisterCustomModel } from "../../src/local-models.ts";

/** Upstream's `serve_once` (a test helper in local_models.rs): answers one SSE exchange and records
 * the request it received. */
function serveOnce(body: string) {
	const captured: { authorization: string | undefined; raw: string }[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			captured.push({
				authorization: req.headers.authorization,
				raw: `${JSON.stringify(req.headers)}\n${Buffer.concat(chunks).toString("utf8")}`,
			});
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(body);
		});
	});
	return { server, captured };
}

/** Upstream's `model_json(provider, id, api, base_url)`. Field names are in wire form (camelCase; see
 * the serde renames in types.rs). */
function modelsJson(provider: string, id: string, api: string, baseUrl: string): string {
	return JSON.stringify({
		models: [
			{
				id,
				name: `${id} (fixture)`,
				api,
				provider,
				baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 64,
			},
		],
	});
}

const SSE_TEXT = `data: {"type":"response.created","response":{"id":"resp_test","model":"model","output":[]}}

data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_test","type":"message","status":"in_progress","role":"assistant","content":[]}}

data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"OK"}

data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"OK"}

data: {"type":"response.completed","response":{"id":"resp_test","status":"completed","model":"model","output":[{"id":"msg_test","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}

`;

const SSE_TOOL_CALL = `data: {"type":"response.created","response":{"id":"resp_tc","model":"model","output":[]}}

data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","status":"in_progress","name":"probe","arguments":"","call_id":"call_1"}}

data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"x\\":1}"}

data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"x\\":1}"}

data: {"type":"response.completed","response":{"id":"resp_tc","status":"completed","model":"model","output":[{"id":"fc_1","type":"function_call","status":"completed","name":"probe","arguments":"{\\"x\\":1}","call_id":"call_1"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}

`;

describe("local models drive a real fixture endpoint (local_models.rs:378+)", () => {
	const ENV_NAMES = [ENV_BASE_DIR, "OPENAI_API_KEY", "DS4_API_KEY", "DS4_BASE_URL", "DS4_URL"];
	let dir: string;
	let saved: Record<string, string | undefined>;
	const registered: [string, string][] = [];
	let server: http.Server | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pie-local-models-stream-"));
		mkdirSync(join(dir, ".pie"), { recursive: true });
		saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
		for (const n of ENV_NAMES) delete process.env[n];
		process.env[ENV_BASE_DIR] = join(dir, ".pie");
	});

	afterEach(() => {
		for (const [p, id] of registered) unregisterCustomModel(p, id);
		registered.length = 0;
		if (server) {
			server.close();
			server = undefined;
		}
		for (const [n, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[n];
			else process.env[n] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	/** Starts the fixture, writes models.json, loads it and returns the model plus the capture array. */
	async function loadModelServedBy(body: string, provider: string, id: string) {
		const fixture = serveOnce(body);
		server = fixture.server;
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const { port } = server.address() as AddressInfo;

		writeFileSync(
			join(dir, ".pie", "models.json"),
			modelsJson(provider, id, "openai-responses", `http://127.0.0.1:${port}/v1`),
			"utf8",
		);
		await loadAll(dir);
		registered.push([provider, id]);

		const model = getCustomModel(provider, id);
		expect(model, `${provider}/${id} from models.json has to be registered`).toBeDefined();
		return { model: model as NonNullable<typeof model>, captured: fixture.captured };
	}

	it("streams text back from a models.json-declared model", async () => {
		// pie: local_models.rs:378-425
		//   let base_url = serve_once(body).await;
		//   load_all_from_paths(&[path]).unwrap();
		//   let model = pie_ai::get_model(...).unwrap();
		//   let mut stream = pie_ai::stream(&model, &context(None), Some(&StreamOptions{ api_key: Some("local") }));
		//   while let Some(event) = stream.next().await { TextDelta => text.push_str(&delta), ... }
		//   assert_eq!(text, "OK");
		//
		// This is the only evidence that the `api: "openai-responses"` field **really selects an adapter
		// that can parse SSE**.
		const { model } = await loadModelServedBy(SSE_TEXT, "local-test-text", "text");

		let text = "";
		for await (const event of stream(
			model as never,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never,
			{ apiKey: "local-synthetic", maxTokens: 8 } as never,
		)) {
			const e = event as { type: string; delta?: string; error?: { errorMessage?: string } };
			if (e.type === "error") throw new Error(`provider error: ${e.error?.errorMessage}`);
			if (e.type === "text_delta" && e.delta) text += e.delta;
			if (e.type === "done") break;
		}
		expect(text).toBe("OK");
	}, 30_000);

	it("streams a tool call back from a models.json-declared model", async () => {
		// pie: local_models.rs (`loaded_openai_responses_model_streams_tool_call_from_local_fixture`)
		// Structurally the same as the previous one, but through the function_call branch: text and tool
		// calls are two separate parsing paths in the responses adapter, and one working says nothing
		// about the other.
		const { model } = await loadModelServedBy(SSE_TOOL_CALL, "local-test-tc", "tc");

		const names: (string | undefined)[] = [];
		for await (const event of stream(
			model as never,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never,
			{ apiKey: "local-synthetic", maxTokens: 8 } as never,
		)) {
			const e = event as {
				type: string;
				toolCall?: { name?: string };
				error?: { errorMessage?: string };
				message?: { content?: { type?: string; name?: string }[] };
			};
			if (e.type === "error") throw new Error(`provider error: ${e.error?.errorMessage}`);
			if (e.toolCall?.name) names.push(e.toolCall.name);
			if (e.type === "done") {
				for (const block of e.message?.content ?? []) {
					if (block.type === "toolCall") names.push(block.name);
				}
				break;
			}
		}
		expect(names).toContain("probe");
	}, 30_000);

	it("sends the provider's own key on the wire, never another provider's", async () => {
		// pie: local_models.rs (`ds4_responses_model_uses_ds4_env_not_openai_env`)
		//   let request = request_rx.await.unwrap();
		//   assert!(request.to_ascii_lowercase().contains("authorization: bearer dsv4-local"), "{request}");
		//   assert!(!request.contains("real-openai-should-not-leak"));
		//
		// This is the **on-the-wire half** of the risk the env-decoy test in batch B covers: that one
		// proves the lookup does not pick up the decoy, this one proves the decoy is not in the bytes
		// actually sent.
		process.env.OPENAI_API_KEY = "real-openai-should-not-leak-synthetic";
		const { model, captured } = await loadModelServedBy(SSE_TEXT, "local-test-scope", "scoped");

		for await (const event of stream(
			model as never,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never,
			{ apiKey: "dsv4-local-synthetic", maxTokens: 8 } as never,
		)) {
			if ((event as { type: string }).type === "done") break;
		}

		expect(
			captured.length,
			"the fixture has to have received a request, or the negative assertion below means nothing",
		).toBeGreaterThan(0);
		expect(captured[0]?.authorization?.toLowerCase()).toBe("bearer dsv4-local-synthetic");
		expect(captured[0]?.raw, "not one byte of the other provider's key may appear on the wire").not.toContain(
			"real-openai-should-not-leak-synthetic",
		);
	}, 30_000);
});
