/**
 * The message payload emitted on abort, asserted hermetically.
 *
 * pie: `crates/ai/src/utils/abort.rs:116-135` (`push_aborted`) pushes a **fresh empty message**:
 * `content: []`, every `usage` counter zero including cost, `response_model`, `response_id` and
 * `diagnostics` all empty, `stop_reason: Aborted`, and `error_message` always `"aborted"`.
 *
 * **Why this file has to exist.** `migration/reviews/ai/divergence-ledger.tsv:46` once claimed this
 * behavior was "independently confirmed live and working via packages/ai/test/abort.test.ts". On
 * re-checking: all six describes in that file are **gated on credentials** (`describe.skipIf` at
 * :102, :114, :131, :143, :157 and :169), so under a hermetic `npm test` it reports `33 tests | 33
 * skipped` — **no coverage at all**. Worse, its substantive assertion is
 * `expect(msg.content.length).toBeGreaterThan(0)`, which points the **opposite way** from upstream
 * pushing an empty message.
 * That "verified" claim fails on both counts: it never runs under the gates, and the behavior it
 * asserts contradicts the contract.
 *
 * Before the fix, each of the nine providers pushed the **accumulated `output`** from its catch
 * block — partial content, accumulated tokens and cost, and the underlying error text. The result:
 * an aborted turn came back with a non-zero `usage.cost`, and any caller summing cost without
 * filtering on `stopReason` first billed for it.
 *
 * How it stays hermetic: `baseUrl` points at `127.0.0.1:1`, which refuses the connection immediately
 * without leaving the machine, and the signal is aborted up front. Together they guarantee the catch
 * block runs with `signal.aborted` true — the abort branch exactly.
 */
import { describe, expect, it } from "vitest";
import { streamBedrock } from "../src/providers/amazon-bedrock.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.ts";
import { streamGoogle } from "../src/providers/google.ts";
import { streamGoogleVertex } from "../src/providers/google-vertex.ts";
import { streamMistral } from "../src/providers/mistral.ts";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Api, AssistantMessage, Context, Model } from "../src/types.ts";
import { abortedMessage, zeroUsage } from "../src/utils/abort.ts";

/** An address that refuses the connection immediately; the request never leaves the machine. */
const DEAD_URL = "http://127.0.0.1:1";

function model<T extends Api>(api: T, id = "test-model"): Model<T> {
	return {
		id,
		name: id,
		api,
		provider: "test-provider",
		baseUrl: DEAD_URL,
		reasoning: false,
		input: ["text"],
		// The unit prices are deliberately non-zero: if the implementation fell back to accumulated usage,
		// cost would not be 0, and the assertion would catch it.
		cost: { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 },
		contextWindow: 200000,
		maxTokens: 32000,
	} as Model<T>;
}

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

/** The entry point of each of the nine providers, all with the signature (model, context, options). */
const PROVIDERS: Array<{ name: string; run: (signal: AbortSignal) => { result(): Promise<AssistantMessage> } }> = [
	{
		name: "anthropic",
		run: (signal) => streamAnthropic(model("anthropic-messages"), context, { apiKey: "test-key", signal }),
	},
	{
		name: "openai-completions",
		run: (signal) => streamOpenAICompletions(model("openai-completions"), context, { apiKey: "test-key", signal }),
	},
	{
		name: "openai-responses",
		run: (signal) => streamOpenAIResponses(model("openai-responses"), context, { apiKey: "test-key", signal }),
	},
	{
		name: "azure-openai-responses",
		run: (signal) =>
			streamAzureOpenAIResponses(model("azure-openai-responses"), context, { apiKey: "test-key", signal }),
	},
	{
		name: "openai-codex-responses",
		run: (signal) =>
			streamOpenAICodexResponses(model("openai-codex-responses"), context, { apiKey: "test-key", signal }),
	},
	{
		name: "google",
		run: (signal) => streamGoogle(model("google-generative-ai"), context, { apiKey: "test-key", signal }),
	},
	{
		name: "google-vertex",
		run: (signal) => streamGoogleVertex(model("google-vertex"), context, { apiKey: "test-key", signal }),
	},
	{
		name: "amazon-bedrock",
		run: (signal) => streamBedrock(model("bedrock-converse-stream"), context, { apiKey: "test-key", signal }),
	},
	{
		name: "mistral",
		run: (signal) => streamMistral(model("mistral-conversations"), context, { apiKey: "test-key", signal }),
	},
];

describe("the abort payload matches upstream push_aborted", () => {
	it("abortedMessage equals the upstream synthetic message field for field", () => {
		const m = model("anthropic-messages", "claude-x");
		const msg = abortedMessage(m);

		expect(msg.role).toBe("assistant");
		expect(msg.content).toEqual([]); // abort.rs:119 `content: vec![]`
		expect(msg.api).toBe("anthropic-messages");
		expect(msg.provider).toBe("test-provider");
		expect(msg.model).toBe("claude-x");
		expect(msg.stopReason).toBe("aborted"); // abort.rs:127
		expect(msg.errorMessage).toBe("aborted"); // abort.rs:128 — always this string, never the underlying error text
		expect(msg.usage).toEqual(zeroUsage()); // abort.rs:126 `Usage::default()`
		expect(msg.usage.cost.total).toBe(0);
		// abort.rs:123-125 — all three are None
		expect(msg.responseModel).toBeUndefined();
		expect(msg.responseId).toBeUndefined();
		expect(msg.diagnostics).toBeUndefined();
	});

	for (const { name, run } of PROVIDERS) {
		it(`${name}: an aborted turn carries no content and no cost`, async () => {
			const controller = new AbortController();
			controller.abort();
			const msg = await run(controller.signal).result();

			expect(msg.stopReason).toBe("aborted");
			// A note on how much this case can discriminate: the connection is refused immediately, so
			// `output` is empty anyway, and what actually separates the old implementation from the new one
			// **here** is `errorMessage` below (the old one gave the underlying text `Request was aborted.`).
			// The cost and content assertions are regression guards in this case, not discriminators; what
			// gives them discriminating power is `abort-payload-midstream.test.ts`, which lets content and
			// usage accumulate before aborting.
			expect(msg.usage.cost.total).toBe(0);
			expect(msg.usage.totalTokens).toBe(0);
			expect(msg.content).toEqual([]);
			expect(msg.errorMessage).toBe("aborted");
			expect(msg.responseId).toBeUndefined();
		}, 20_000);
	}

	// Negative control: with no abort on the signal, a **different** path has to run — a real error,
	// whose text comes from underneath rather than being "aborted".
	// Without it, the nine above would also pass under an implementation that treats every failure as
	// an abort — which swallows errors into aborts, and is worse.
	it("negative control: a failure without an abort is still an error and keeps the underlying text", async () => {
		const msg = await streamAnthropic(model("anthropic-messages"), context, { apiKey: "test-key" }).result();

		expect(msg.stopReason).toBe("error");
		expect(msg.errorMessage).toBeTruthy();
		expect(msg.errorMessage).not.toBe("aborted");
	}, 20_000);
});
