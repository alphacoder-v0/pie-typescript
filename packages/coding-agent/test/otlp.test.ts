/**
 * Characterization tests for `packages/coding-agent/src/otlp.ts`
 * (port of oracle `crates/coding-agent/src/otlp.rs`, pie @0a120dfd).
 *
 * Oracle's own `#[cfg(test)]` module (otlp.rs:244-264) has exactly two tests —
 * `try_layer_returns_none_when_env_unset` and `hex_random_returns_correct_length` — both
 * translated below. The rest lock the OTLP/JSON wire shape, which RULEBOOK §4's probe gate
 * requires be checked as a full-depth comparison rather than a projection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectAttributes, hexRandom, OtlpLayer, tryLayer } from "../src/otlp.ts";

const ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";
const savedEndpoint = process.env[ENV];

beforeEach(() => {
	delete process.env[ENV];
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedEndpoint === undefined) delete process.env[ENV];
	else process.env[ENV] = savedEndpoint;
});

/** Captures every POST `flushOnce` fires, so the wire payload can be inspected. */
function stubFetch(): Array<{ url: string; init: RequestInit }> {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response("", { status: 200 });
	}) as unknown as typeof fetch);
	return calls;
}

/** The parsed OTLP document is deliberately untyped: these tests assert its shape, not its type. */
function body(call: { init: RequestInit } | undefined): any {
	return JSON.parse(String(call?.init.body));
}

describe("tryLayer (oracle otlp.rs:30-36)", () => {
	it("returns undefined when the env var is unset (oracle otlp.rs:248-254)", () => {
		expect(tryLayer()).toBeUndefined();
	});

	it("returns undefined when the env var is empty or whitespace (oracle otlp.rs:32-34)", () => {
		process.env[ENV] = "";
		expect(tryLayer()).toBeUndefined();
		process.env[ENV] = "   ";
		expect(tryLayer()).toBeUndefined();
	});

	it("returns a layer when the env var is set", () => {
		process.env[ENV] = "http://collector.invalid:4318";
		expect(tryLayer()).toBeInstanceOf(OtlpLayer);
	});
});

describe("hexRandom (oracle otlp.rs:202-214)", () => {
	it("returns 2 hex chars per byte and only hex digits (oracle otlp.rs:256-263)", () => {
		const a = hexRandom(8);
		expect(a).toHaveLength(16);
		const b = hexRandom(16);
		expect(b).toHaveLength(32);
		expect(/^[0-9a-f]+$/.test(a)).toBe(true);
		expect(/^[0-9a-f]+$/.test(b)).toBe(true);
	});

	it("advances the shared seed, so successive ids differ", () => {
		expect(hexRandom(16)).not.toBe(hexRandom(16));
	});

	it("returns the empty string for zero bytes", () => {
		expect(hexRandom(0)).toBe("");
	});
});

describe("collectAttributes (oracle otlp.rs:216-242)", () => {
	it("passes strings through (record_str, otlp.rs:226-229)", () => {
		expect(collectAttributes({ a: "value" }).get("a")).toBe("value");
	});

	it("stringifies integers and bigints (record_i64 / record_u64, otlp.rs:230-237)", () => {
		expect(collectAttributes({ a: 42 }).get("a")).toBe("42");
		expect(collectAttributes({ a: -7 }).get("a")).toBe("-7");
		expect(collectAttributes({ a: 9007199254740993n }).get("a")).toBe("9007199254740993");
	});

	it("stringifies booleans (record_bool, otlp.rs:238-241)", () => {
		expect(collectAttributes({ a: true }).get("a")).toBe("true");
		expect(collectAttributes({ a: false }).get("a")).toBe("false");
	});

	it("falls back to Debug formatting for everything else (record_debug, otlp.rs:222-225)", () => {
		expect(collectAttributes({ a: 1.5 }).get("a")).toBe("1.5");
		expect(collectAttributes({ a: { k: 1 } }).get("a")).toBe("{ k: 1 }");
		expect(collectAttributes({ a: undefined }).get("a")).toBe("undefined");
	});

	it("keys by field name and keeps every field", () => {
		expect([...collectAttributes({ b: "1", a: "2" }).keys()]).toEqual(["b", "a"]);
	});
});

describe("OtlpLayer span buffering + flush (oracle otlp.rs:88-121, 152-199)", () => {
	it("posts the full OTLP/JSON document for a closed span", async () => {
		const calls = stubFetch();
		const layer = new OtlpLayer("http://collector.invalid:4318");

		layer.onNewSpan(7, { name: "agent_turn", target: "pie::demo", fields: { attempt: 2 } });
		layer.onClose(7);
		await layer.flush();

		expect(calls).toHaveLength(1);
		// oracle otlp.rs:110 — `format!("{}/v1/traces", inner.endpoint)`.
		expect(calls[0]?.url).toBe("http://collector.invalid:4318/v1/traces");
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });

		// Full-shape comparison (RULEBOOK §4 probe gate): every key, at every depth.
		expect(body(calls[0])).toEqual({
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: "pie" } },
							{ key: "service.version", value: { stringValue: "0.75.0" } },
						],
					},
					scopeSpans: [
						{
							scope: { name: "pie" },
							spans: [
								{
									traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
									spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
									name: "agent_turn",
									kind: 1,
									startTimeUnixNano: expect.stringMatching(/^\d+000000$/),
									endTimeUnixNano: expect.stringMatching(/^\d+000000$/),
									attributes: [
										// oracle otlp.rs:178-182 puts `tracing.target` first, then the
										// recorded fields (otlp.rs:170-174).
										{ key: "tracing.target", value: { stringValue: "pie::demo" } },
										{ key: "attempt", value: { stringValue: "2" } },
									],
									status: { code: 1 },
								},
							],
						},
					],
				},
			],
		});
	});

	it("uses ms-resolution epoch nanos, with end >= start", async () => {
		const calls = stubFetch();
		const layer = new OtlpLayer("http://collector.invalid:4318");
		layer.onNewSpan(1, { name: "s", target: "t", fields: {} });
		layer.onClose(1);
		await layer.flush();

		const span = body(calls[0]).resourceSpans[0].scopeSpans[0].spans[0];
		expect(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)).toBe(true);
		expect(BigInt(span.startTimeUnixNano) / 1_000_000n > 1_700_000_000_000n).toBe(true);
	});

	it("strips trailing slashes from the endpoint (oracle otlp.rs:63-64)", async () => {
		const calls = stubFetch();
		const layer = new OtlpLayer("http://collector.invalid:4318///");
		layer.onNewSpan(1, { name: "s", target: "t", fields: {} });
		layer.onClose(1);
		await layer.flush();

		expect(calls[0]?.url).toBe("http://collector.invalid:4318/v1/traces");
	});

	it("sends nothing when the queue is empty (oracle otlp.rs:90-92)", async () => {
		const calls = stubFetch();
		await new OtlpLayer("http://collector.invalid:4318").flush();
		expect(calls).toHaveLength(0);
	});

	it("drains the queue, so a second flush sends nothing (std::mem::take, oracle otlp.rs:94)", async () => {
		const calls = stubFetch();
		const layer = new OtlpLayer("http://collector.invalid:4318");
		layer.onNewSpan(1, { name: "s", target: "t", fields: {} });
		layer.onClose(1);

		await layer.flush();
		await layer.flush();
		expect(calls).toHaveLength(1);
	});

	it("batches every closed span into one document", async () => {
		const calls = stubFetch();
		const layer = new OtlpLayer("http://collector.invalid:4318");
		for (const id of [1, 2, 3]) {
			layer.onNewSpan(id, { name: `s${id}`, target: "t", fields: {} });
			layer.onClose(id);
		}
		await layer.flush();

		const spans = body(calls[0]).resourceSpans[0].scopeSpans[0].spans;
		expect(spans.map((s: { name: string }) => s.name)).toEqual(["s1", "s2", "s3"]);
	});

	it("ignores a close for an id that was never opened (oracle otlp.rs:167-168)", async () => {
		const calls = stubFetch();
		const layer = new OtlpLayer("http://collector.invalid:4318");
		layer.onClose(99);
		await layer.flush();
		expect(calls).toHaveLength(0);
	});

	it("ignores a repeated close for the same id", async () => {
		const calls = stubFetch();
		const layer = new OtlpLayer("http://collector.invalid:4318");
		layer.onNewSpan(1, { name: "s", target: "t", fields: {} });
		layer.onClose(1);
		layer.onClose(1);
		await layer.flush();

		expect(body(calls[0]).resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
	});

	it("never rejects when the collector is unreachable (oracle otlp.rs:111,118: fire and forget)", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
		const layer = new OtlpLayer("http://collector.invalid:4318");
		layer.onNewSpan(1, { name: "s", target: "t", fields: {} });
		layer.onClose(1);

		await expect(layer.flush()).resolves.toBeUndefined();
	});
});

describe("OtlpLayer.withServiceName (oracle otlp.rs:78-86)", () => {
	it("renames service.name on the returned layer", async () => {
		const calls = stubFetch();
		const renamed = new OtlpLayer("http://collector.invalid:4318").withServiceName("pie-subagent");
		renamed.onNewSpan(1, { name: "s", target: "t", fields: {} });
		renamed.onClose(1);
		await renamed.flush();

		expect(body(calls[0]).resourceSpans[0].resource.attributes[0]).toEqual({
			key: "service.name",
			value: { stringValue: "pie-subagent" },
		});
	});

	it("starts the renamed layer on a fresh queue and leaves the original's alone", async () => {
		const calls = stubFetch();
		const original = new OtlpLayer("http://collector.invalid:4318");
		original.onNewSpan(1, { name: "original-span", target: "t", fields: {} });
		original.onClose(1);

		// oracle otlp.rs:127-134 (`clone_for_rename`) hands back empty `pending`/`open`.
		const renamed = original.withServiceName("pie-subagent");
		await renamed.flush();
		expect(calls).toHaveLength(0);

		await original.flush();
		expect(calls).toHaveLength(1);
		expect(body(calls[0]).resourceSpans[0].scopeSpans[0].spans[0].name).toBe("original-span");
		expect(body(calls[0]).resourceSpans[0].resource.attributes[0].value.stringValue).toBe("pie");
	});
});
