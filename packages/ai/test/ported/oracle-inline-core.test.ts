/**
 * phase 20-3: ports the inline tests in upstream `crates/ai` other than the request-body group.
 *
 * The assertions are **upstream's**, not current TypeScript behavior. Each case names the `#[test]`
 * it was ported from.
 *
 * The deduplication method is in `migration/reviews/phase20/ai-inline-port.md`: upstream has 82
 * inline tests in `crates/ai`, 36 of whose names are already referenced directly by tests here
 * because they were deliberately ported, leaving 46 judged one at a time by reading the test body.
 * This file holds the registry, pure-function and environment-variable group.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	type ApiProvider,
	clearApiProviders,
	getApiProvider,
	registerApiProvider,
	unregisterApiProviders,
} from "../../src/api-registry.ts";
import { getEnvApiKey } from "../../src/env-api-keys.ts";
import { transformMessages } from "../../src/providers/transform-messages.ts";
import type { Api, AssistantMessage, Message, Model, Usage } from "../../src/types.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { isContextOverflow } from "../../src/utils/overflow.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(api: string, id = "m1"): Model<Api> {
	return {
		id,
		name: id,
		api: api as never,
		provider: "test-provider",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

function assistant(
	content: AssistantMessage["content"],
	provider: string,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider,
		model: "src-model",
		usage: ZERO_USAGE,
		stopReason,
		timestamp: 0,
	};
}

/** A stream that emits one done with `message.model` set to the given marker, so the caller can tell
 * whether stream or streamSimple ran. */
function markedStream(marker: string, api: string): AssistantMessageEventStream {
	const s = new AssistantMessageEventStream();
	s.push({
		type: "done",
		reason: "stop",
		message: {
			role: "assistant",
			content: [],
			api: api as never,
			provider: "test-provider",
			model: marker,
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 0,
		},
	});
	return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// api_registry.rs
// ─────────────────────────────────────────────────────────────────────────────

const RACE_API = "race-api";

function raceProvider(): ApiProvider {
	return {
		api: RACE_API as never,
		stream: (() => markedStream("stream", RACE_API)) as never,
		streamSimple: (() => markedStream("simple", RACE_API)) as never,
	};
}

describe("api_registry: a handle stays usable after unregister or clear", () => {
	afterEach(() => {
		clearApiProviders();
	});

	// pie: crates/ai/src/api_registry.rs `handle_survives_unregister_after_lookup`
	// A caller that already holds a handle should not have it fail midstream because the source was
	// unregistered elsewhere: registry lookup and stream lifetime are two different things.
	it("a handle taken before unregisterApiProviders can still complete a stream", async () => {
		registerApiProvider(raceProvider(), "race-source");
		const handle = getApiProvider(RACE_API as never);
		expect(handle).toBeDefined();

		unregisterApiProviders("race-source");
		expect(getApiProvider(RACE_API as never)).toBeUndefined();

		let doneModel: string | undefined;
		for await (const ev of handle!.stream(model(RACE_API), { messages: [] })) {
			if (ev.type === "done") doneModel = ev.message.model;
		}
		expect(doneModel).toBe("stream");
	});

	// pie: crates/ai/src/api_registry.rs `handle_survives_clear_after_lookup_for_simple_stream`
	it("a handle taken before clearApiProviders can still complete a streamSimple", async () => {
		registerApiProvider(raceProvider());
		const handle = getApiProvider(RACE_API as never);
		expect(handle).toBeDefined();

		clearApiProviders();
		expect(getApiProvider(RACE_API as never)).toBeUndefined();

		let doneModel: string | undefined;
		for await (const ev of handle!.streamSimple(model(RACE_API), { messages: [] })) {
			if (ev.type === "done") doneModel = ev.message.model;
		}
		expect(doneModel).toBe("simple");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// utils/overflow.rs
// ─────────────────────────────────────────────────────────────────────────────

function errMsg(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "test-provider",
		model: "m1",
		usage: { ...ZERO_USAGE },
		stopReason: "error",
		errorMessage: text,
		timestamp: 0,
	};
}

describe("overflow: the provider error strings upstream matches verbatim", () => {
	// pie: crates/ai/src/utils/overflow.rs `detects_anthropic_overflow`
	it("Anthropic's 'prompt is too long: N tokens > M maximum'", () => {
		expect(isContextOverflow(errMsg("prompt is too long: 213462 tokens > 200000 maximum"))).toBe(true);
	});

	// pie: crates/ai/src/utils/overflow.rs `detects_openai_and_gemini`
	it("OpenAI's 'exceeds the context window' and Gemini's 'input token count … exceeds the maximum'", () => {
		expect(isContextOverflow(errMsg("Your input exceeds the context window of this model"))).toBe(true);
		expect(
			isContextOverflow(errMsg("The input token count (1196265) exceeds the maximum number of tokens allowed")),
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// providers/transform_messages.rs
// ─────────────────────────────────────────────────────────────────────────────

describe("transform_messages: thinking across models, and an orphaned tool call", () => {
	const target = model("anthropic-messages", "target-model");

	// pie: crates/ai/src/providers/transform_messages.rs `cross_model_thinking_becomes_text`
	// A thinking block from another provider cannot be replayed as-is because the signature does not
	// match, so upstream degrades it to text.
	it("a thinking block from another provider degrades to text", () => {
		const out = transformMessages(
			[assistant([{ type: "thinking", thinking: "let me think" }], "openai", "stop")],
			target,
		);
		const first = out[0] as AssistantMessage;
		expect(first.role).toBe("assistant");
		expect(first.content[0]?.type).toBe("text");
	});

	// pie: crates/ai/src/providers/transform_messages.rs `orphaned_tool_call_gets_synthetic_result`
	// The assistant started a tool call and the next message is from the user, meaning an interruption.
	// Upstream appends a synthetic toolResult with isError, or the provider refuses the whole request
	// for having a tool_use with no tool_result.
	it("a tool call the user interrupted gets a synthetic toolResult with isError", () => {
		const msgs: Message[] = [
			assistant([{ type: "toolCall", id: "call_1", name: "tool", arguments: { x: 1 } }], "anthropic", "toolUse"),
			{ role: "user", content: "interrupt", timestamp: 0 },
		];
		const out = transformMessages(msgs, target);

		expect(out).toHaveLength(3);
		const synthetic = out[1] as Extract<Message, { role: "toolResult" }>;
		expect(synthetic.role).toBe("toolResult");
		expect(synthetic.toolCallId).toBe("call_1");
		expect(synthetic.isError).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// bedrock_provider.rs
// ─────────────────────────────────────────────────────────────────────────────

describe("bedrock: reports no credential when AWS credentials are absent", () => {
	// pie: crates/ai/src/bedrock_provider.rs `creds_from_env_returns_none_without_keys`
	// Saved and restored so other cases stay clean, the same way the upstream test of this name does.
	// Only variable names are touched; no value is read.
	it("returns undefined when neither AWS_ACCESS_KEY_ID nor AWS_SECRET_ACCESS_KEY is set", () => {
		const saved = {
			id: process.env.AWS_ACCESS_KEY_ID,
			secret: process.env.AWS_SECRET_ACCESS_KEY,
			bearer: process.env.AWS_BEARER_TOKEN_BEDROCK,
		};
		delete process.env.AWS_ACCESS_KEY_ID;
		delete process.env.AWS_SECRET_ACCESS_KEY;
		delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		try {
			expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
		} finally {
			if (saved.id !== undefined) process.env.AWS_ACCESS_KEY_ID = saved.id;
			if (saved.secret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
			if (saved.bearer !== undefined) process.env.AWS_BEARER_TOKEN_BEDROCK = saved.bearer;
		}
	});
});
