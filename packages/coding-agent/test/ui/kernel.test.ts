/**
 * Tests for the port of oracle `crates/coding-agent/src/ui/kernel.rs` (pie @0a120dfd).
 *
 * Oracle carries NO `#[cfg(test)]` module in `kernel.rs` — the module is exercised only indirectly
 * through `ui/mod.rs`'s REPL tests, which are a different manifest unit. Everything below is
 * therefore net-new coverage written against the oracle source line by line: each `it()` names the
 * oracle line range it pins.
 *
 * The harness is a hand-rolled stub rather than a real `AgentHarness`: every method this kernel
 * touches is a thin delegation, so the assertions are about *which* harness call each turn
 * constructor makes with *which* arguments — a live harness would only add network/session
 * machinery between the assertion and the fact.
 */

import type { AgentHarness } from "@pie/agent-core";
import type { ImageContent, Model } from "@pie/ai";
import { describe, expect, it } from "vitest";
import type { RetrySettings } from "../../src/core/settings-manager.ts";
import {
	newTurnState,
	pollTurn,
	type QueuedTurn,
	queuedTurnDisplay,
	ReplKernel,
	type TurnState,
} from "../../src/ui/kernel.ts";

type HarnessCall =
	| { method: "prompt"; text: string; images?: ImageContent[] }
	| { method: "promptFromTemplate"; name: string; vars: Record<string, unknown> }
	| { method: "compact"; custom: string | undefined }
	| { method: "continue" }
	| { method: "abort" };

interface StubHarness {
	calls: HarnessCall[];
	/** Gates the next turn-producing call; absent means "resolve immediately". */
	gate?: { promise: Promise<void>; release: () => void };
	compactRan: boolean;
	modelInput: ("text" | "image")[];
	failWith?: Error;
	abortRejection?: Error;
	asHarness: AgentHarness;
}

function makeGate(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release: () => release() };
}

function stubHarness(overrides: Partial<Pick<StubHarness, "compactRan" | "modelInput">> = {}): StubHarness {
	const stub: StubHarness = {
		calls: [],
		compactRan: overrides.compactRan ?? true,
		modelInput: overrides.modelInput ?? ["text"],
		asHarness: undefined as unknown as AgentHarness,
	};

	const settle = async (): Promise<void> => {
		if (stub.gate) {
			await stub.gate.promise;
		}
		if (stub.failWith) {
			throw stub.failWith;
		}
	};

	const impl = {
		async prompt(text: string, options?: { images?: ImageContent[] }) {
			stub.calls.push({ method: "prompt", text, images: options?.images });
			await settle();
			return undefined;
		},
		async promptFromTemplate(name: string, vars: Record<string, unknown>) {
			stub.calls.push({ method: "promptFromTemplate", name, vars });
			await settle();
			return undefined;
		},
		async compact(custom: string | undefined) {
			stub.calls.push({ method: "compact", custom });
			await settle();
			return stub.compactRan ? { ran: true as const, result: {} } : { ran: false as const };
		},
		async continue() {
			stub.calls.push({ method: "continue" });
			await settle();
			return undefined;
		},
		async abort() {
			stub.calls.push({ method: "abort" });
			if (stub.abortRejection) {
				throw stub.abortRejection;
			}
			return { clearedSteer: [], clearedFollowUp: [] };
		},
		getModel(): Model<any> {
			return { input: stub.modelInput } as unknown as Model<any>;
		},
	};

	stub.asHarness = impl as unknown as AgentHarness;
	return stub;
}

const RETRY: RetrySettings = { enabled: true, maxRetries: 5, baseDelayMs: 1000 };

function kernelWith(stub: StubHarness): ReplKernel {
	return new ReplKernel(stub.asHarness, RETRY);
}

describe("TurnState / poll_turn — kernel.rs:23-34", () => {
	it("newTurnState mirrors #[derive(Default)] (kernel.rs:23-29)", () => {
		const state: TurnState = newTurnState();
		expect(state.fut).toBeUndefined();
		expect(state.aborted).toBe(false);
		expect(state.prefix).toBe("");
	});

	it("pollTurn panics with oracle's expect message when no turn is staged (kernel.rs:33)", () => {
		expect(() => pollTurn(undefined)).toThrow("turn future present");
	});

	it("pollTurn yields the staged future's value (kernel.rs:31-34)", async () => {
		await expect(pollTurn(Promise.resolve("compaction ran"))).resolves.toBe("compaction ran");
	});
});

describe("QueuedTurn::display — kernel.rs:58-67", () => {
	it("returns the display string for every variant", () => {
		const turns: QueuedTurn[] = [
			{ kind: "user_prompt", display: "u", prompt: "p", images: [] },
			{ kind: "agent_prompt", display: "a", prompt: "p", errorContext: "triggered turn: " },
			{ kind: "prompt_template", display: "t", name: "n", vars: {} },
			{ kind: "compaction", display: "c", custom: undefined },
		];
		expect(turns.map(queuedTurnDisplay)).toEqual(["u", "a", "t", "c"]);
	});
});

describe("ReplKernel accessors — kernel.rs:76-99", () => {
	it("harness() hands back the injected harness (kernel.rs:80-82)", () => {
		const stub = stubHarness();
		expect(kernelWith(stub).harness()).toBe(stub.asHarness);
	});

	it("retry() carries the settings the kernel was built with (kernel.rs:72)", () => {
		expect(kernelWith(stubHarness()).retry()).toBe(RETRY);
	});

	it("current_model_accepts_images is true only when the model lists Image (kernel.rs:92-99)", () => {
		expect(kernelWith(stubHarness({ modelInput: ["text"] })).currentModelAcceptsImages()).toBe(false);
		expect(kernelWith(stubHarness({ modelInput: ["text", "image"] })).currentModelAcceptsImages()).toBe(true);
	});

	it("abort() is void-returning and reaches the harness (kernel.rs:84-86)", async () => {
		const stub = stubHarness();
		expect(kernelWith(stub).abort()).toBeUndefined();
		// `detach()` runs the call in a microtask; one turn of the loop is enough to observe it.
		await Promise.resolve();
		expect(stub.calls).toEqual([{ method: "abort" }]);
	});

	it("a rejecting harness abort does not escape the detached call (kernel.rs:84-86)", async () => {
		const stub = stubHarness();
		stub.abortRejection = new Error("teardown hook blew up");
		kernelWith(stub).abort();
		await Promise.resolve();
		await Promise.resolve();
		expect(stub.calls).toEqual([{ method: "abort" }]);
	});
});

describe("ReplKernel turn constructors — kernel.rs:101-159", () => {
	it("prompt_turn drives harness.prompt and yields no status line (kernel.rs:101-104)", async () => {
		const stub = stubHarness();
		await expect(kernelWith(stub).promptTurn("hello")).resolves.toBeUndefined();
		expect(stub.calls).toEqual([{ method: "prompt", text: "hello", images: undefined }]);
	});

	it("user_prompt_turn without images takes the plain prompt branch (kernel.rs:121-124)", async () => {
		const stub = stubHarness();
		await expect(kernelWith(stub).userPromptTurn("hi", [])).resolves.toBeUndefined();
		expect(stub.calls).toEqual([{ method: "prompt", text: "hi", images: undefined }]);
	});

	it("user_prompt_turn with images takes the prompt_with_images branch (kernel.rs:113-119)", async () => {
		const stub = stubHarness();
		const images: ImageContent[] = [{ type: "image", data: "AAA=", mimeType: "image/png" }];
		await expect(kernelWith(stub).userPromptTurn("look", images)).resolves.toBeUndefined();
		expect(stub.calls).toEqual([{ method: "prompt", text: "look", images }]);
	});

	it("template_turn forwards name and vars verbatim (kernel.rs:129-141)", async () => {
		const stub = stubHarness();
		const vars = { a: 1, b: "two" };
		await expect(kernelWith(stub).templateTurn("review", vars)).resolves.toBeUndefined();
		expect(stub.calls).toEqual([{ method: "promptFromTemplate", name: "review", vars }]);
	});

	it("compaction_turn maps ran=true to 'compaction ran' (kernel.rs:146-152)", async () => {
		const stub = stubHarness({ compactRan: true });
		await expect(kernelWith(stub).compactionTurn("focus on tests")).resolves.toBe("compaction ran");
		expect(stub.calls).toEqual([{ method: "compact", custom: "focus on tests" }]);
	});

	it("compaction_turn maps ran=false to 'nothing to compact' (kernel.rs:146-152)", async () => {
		const stub = stubHarness({ compactRan: false });
		await expect(kernelWith(stub).compactionTurn(undefined)).resolves.toBe("nothing to compact");
		expect(stub.calls).toEqual([{ method: "compact", custom: undefined }]);
	});

	it("continue_turn drives harness.continue (kernel.rs:156-159)", async () => {
		const stub = stubHarness();
		await expect(kernelWith(stub).continueTurn()).resolves.toBeUndefined();
		expect(stub.calls).toEqual([{ method: "continue" }]);
	});

	it("a failing turn rejects rather than resolving (RULEBOOK §2.4)", async () => {
		const stub = stubHarness();
		stub.failWith = new Error("provider exploded");
		await expect(kernelWith(stub).promptTurn("boom")).rejects.toThrow("provider exploded");
	});
});

describe("ReplKernel.is_streaming — kernel.rs:88-90", () => {
	it("is false when idle and true while a turn is outstanding", async () => {
		const stub = stubHarness();
		stub.gate = makeGate();
		const kernel = kernelWith(stub);

		expect(kernel.isStreaming()).toBe(false);
		const fut = kernel.promptTurn("slow");
		expect(kernel.isStreaming()).toBe(true);

		stub.gate.release();
		await fut;
		expect(kernel.isStreaming()).toBe(false);
	});

	it("clears the in-flight flag when the turn fails, not just when it succeeds", async () => {
		const stub = stubHarness();
		stub.gate = makeGate();
		stub.failWith = new Error("nope");
		const kernel = kernelWith(stub);

		const fut = kernel.continueTurn();
		expect(kernel.isStreaming()).toBe(true);
		stub.gate.release();
		await expect(fut).rejects.toThrow("nope");
		expect(kernel.isStreaming()).toBe(false);
	});

	it("a staged-but-never-awaited failing turn does not raise an unhandled rejection", async () => {
		const seen: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			seen.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const stub = stubHarness();
			stub.failWith = new Error("dropped turn");
			// Deliberately discard the TurnFut, the way `ui/mod.rs` drops `turn.fut` on Ctrl-C.
			kernelWith(stub).promptTurn("dropped");
			// Give the rejection several macrotask turns to surface if it were unguarded.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(seen).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
