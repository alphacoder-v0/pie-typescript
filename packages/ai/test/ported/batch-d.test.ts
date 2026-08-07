import { describe, expect, it } from "vitest";
import { getImagesApiProvider, registerImagesApiProvider } from "../../src/images-api-registry.ts";
import { EventStream } from "../../src/utils/event-stream.ts";
import { validateToolCall } from "../../src/utils/validation.ts";

/**
 * phase 22 batch D wrap-up — the remaining `new-test` verdicts on the ai side.
 *
 * Batch D sits against **external protocols**: provider registration, event streams, SSE, and the
 * MCP JSON-RPC envelope. A porting error at this layer only shows up against a real provider, and
 * live tests do not gate — which makes the absence of behavioral assertions on these functions one
 * of the gaps most worth closing.
 */
describe("phase 22 batch D wrap-up — ai", () => {
	// ── ai/src/images_api_registry.rs::register_images_api_provider@27 / get@35 ──
	//
	// The image provider registry. Registering something and not getting it back — or getting someone
	// else's — means a command like `/image` silently reaches the wrong backend, or reports that it is
	// unsupported.
	//
	// This is a separate registry from `api_registry`; crossed wires would call a text model as an
	// image model.
	describe("the images provider registry", () => {
		it("returns a provider keyed to the api that was registered", () => {
			// Note that what comes back is **not** the object that went in: registration rebuilds an
			// internal provider and wraps generateImages (images-api-registry.ts:42-48), so identity can
			// only be asserted through `api`, not by comparing references with toBe.
			const api = "test-images-api" as never;
			registerImagesApiProvider({ api, generateImages: async () => ({ images: [] }) } as never);

			expect(getImagesApiProvider(api)?.api).toBe(api);
		});

		it("returns undefined for an api that was never registered", () => {
			expect(getImagesApiProvider("never-registered-api" as never)).toBeUndefined();
		});

		it("re-registering the same api replaces the entry rather than duplicating it", () => {
			// A second registration has to replace rather than coexist; coexisting would leave which one
			// comes back to the luck of Map iteration order.
			const api = "replaceable-images-api" as never;
			registerImagesApiProvider({ api, generateImages: async () => ({ images: ["first"] }) } as never);
			const afterFirst = getImagesApiProvider(api);
			registerImagesApiProvider({ api, generateImages: async () => ({ images: ["second"] }) } as never);

			expect(getImagesApiProvider(api)).not.toBe(afterFirst);
		});
	});

	// ── ai/src/utils/validation.rs::validate@22 ───────────────────────────────
	//
	// Validation of tool call arguments. It is the only gatekeeper between the model and the tool: let
	// a bad argument through and the tool reads a file, or runs a command, with undefined.
	//
	// The entry point here is `validateToolCall(tools, toolCall)`, which carries upstream `validate`'s
	// responsibility.
	describe("validateToolCall（oracle validate）", () => {
		const tool = {
			name: "echo",
			description: "echo back",
			parameters: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
		} as never;

		it("accepts a call whose arguments satisfy the schema", () => {
			expect(() =>
				validateToolCall([tool], { id: "1", name: "echo", arguments: { text: "hi" } } as never),
			).not.toThrow();
		});

		it("rejects a call naming a tool that is not registered — with the tool name in the message", () => {
			// The error has to name the tool: seeing `Tool "X" not found` is how the model learns it called
			// the wrong thing. A generic "invalid call" only makes it retry the same mistake.
			expect(() => validateToolCall([tool], { id: "1", name: "nope", arguments: {} } as never)).toThrow(
				/Tool "nope" not found/,
			);
		});

		it("rejects a call missing a required argument", () => {
			expect(() => validateToolCall([tool], { id: "1", name: "echo", arguments: {} } as never)).toThrow();
		});
	});

	// ── ai/src/utils/event_stream.rs::new@71 / close@54 / is_closed@49 ────────
	//
	// The event stream's lifecycle. Every provider response flows to the caller through it: failing to
	// close it leaves the consumer waiting forever, with the interface stuck on "thinking"; closing it
	// early truncates the message.
	//
	// Upstream's `close` corresponds to `end(result?)` here, and the observable surface of `is_closed`
	// is `result()` having settled (`event-stream.ts:38/64`).
	describe("EventStream lifecycle (upstream new / close / is_closed)", () => {
		it("a freshly constructed stream yields nothing until something is pushed", async () => {
			const stream = new EventStream<{ done: boolean }, string>(
				(e) => e.done,
				() => "result",
			);
			stream.end("empty");

			expect(await stream.result()).toBe("empty");
		});

		it("delivers pushed events in order to an async iterator", async () => {
			const stream = new EventStream<{ n: number; done: boolean }, number>(
				(e) => e.done,
				(e) => e.n,
			);
			stream.push({ n: 1, done: false });
			stream.push({ n: 2, done: true });

			const seen: number[] = [];
			for await (const e of stream) seen.push(e.n);

			expect(seen).toEqual([1, 2]);
		});

		it("end() settles result() — without it the consumer waits forever", async () => {
			// This holds the line on the stuck-on-thinking failure: the stream is never closed and result()
			// never resolves.
			const stream = new EventStream<{ done: boolean }, string>(
				(e) => e.done,
				() => "from-event",
			);
			stream.end("closed-explicitly");

			await expect(stream.result()).resolves.toBe("closed-explicitly");
		});
	});
});
