/**
 * Characterization tests for the control-plane prompt hooks.
 * Port target: oracle crates/coding-agent/src/control_plane_prompt.rs (no Rust tests there, so
 * these lock the documented decision paths against the source).
 */

import type { ControlPlanePromptRequest } from "@pie/agent-core";
import { describe, expect, it } from "vitest";
import { allowHook, denyHook, interactiveHook } from "../src/control-plane-prompt.ts";

function request(toolCallId = "call_1"): ControlPlanePromptRequest {
	return {
		toolCallId,
		toolName: "InstallSkill",
		argsHash: "deadbeef",
		label: "install skill foo",
		payload: { name: "foo" },
		reason: "escalating write",
	};
}

describe("denyHook / allowHook", () => {
	// oracle control_plane_prompt.rs:53-63
	it("denyHook always denies with the given reason", async () => {
		const hook = denyHook("headless mode");
		expect(await hook(request())).toEqual({ type: "deny", reason: "headless mode" });
		expect(await hook(request("call_2"), AbortSignal.abort())).toEqual({ type: "deny", reason: "headless mode" });
	});

	// oracle control_plane_prompt.rs:65-71
	it("allowHook always allows", async () => {
		const hook = allowHook();
		expect(await hook(request())).toEqual({ type: "allow" });
	});
});

describe("interactiveHook", () => {
	// oracle control_plane_prompt.rs:24-39 — the request reaches the UI queue verbatim.
	it("hands the request to the queue and returns the UI's decision", async () => {
		const { hook, prompts } = interactiveHook();
		const pending = hook(request());

		const ui = await prompts.next();
		expect(ui?.request).toEqual(request());
		ui?.resolve({ type: "allow" });

		expect(await pending).toEqual({ type: "allow" });
	});

	it("forwards a deny decision with its reason", async () => {
		const { hook, prompts } = interactiveHook();
		const pending = hook(request());

		(await prompts.next())?.resolve({ type: "deny", reason: "user said no" });
		expect(await pending).toEqual({ type: "deny", reason: "user said no" });
	});

	// oracle control_plane_prompt.rs:29-39 — a closed channel means the UI is gone.
	it("denies when the prompt queue is closed", async () => {
		const { hook, prompts } = interactiveHook();
		prompts.close();

		expect(await hook(request())).toEqual({
			type: "deny",
			reason: "control-plane prompt UI is unavailable",
		});
	});

	// oracle control_plane_prompt.rs:41-43 — the responder was dropped without a decision.
	it("denies when the UI abandons the prompt", async () => {
		const { hook, prompts } = interactiveHook();
		const pending = hook(request());

		(await prompts.next())?.close();
		expect(await pending).toEqual({
			type: "deny",
			reason: "control-plane prompt UI closed before a decision",
		});
	});

	// oracle control_plane_prompt.rs:44-46 — cancellation wins the select.
	it("denies when cancellation fires before a decision", async () => {
		const { hook, prompts } = interactiveHook();
		const controller = new AbortController();
		const pending = hook(request(), controller.signal);

		await prompts.next();
		controller.abort();

		expect(await pending).toEqual({ type: "deny", reason: "control-plane prompt cancelled" });
	});

	it("denies immediately when the signal is already aborted", async () => {
		const { hook } = interactiveHook();
		expect(await hook(request(), AbortSignal.abort())).toEqual({
			type: "deny",
			reason: "control-plane prompt cancelled",
		});
	});

	it("keeps a decision that arrived before cancellation", async () => {
		const { hook, prompts } = interactiveHook();
		const controller = new AbortController();
		const pending = hook(request(), controller.signal);

		(await prompts.next())?.resolve({ type: "allow" });
		const decided = await pending;
		controller.abort();

		expect(decided).toEqual({ type: "allow" });
	});

	it("ignores a second resolve (oracle drops the send result)", async () => {
		const { hook, prompts } = interactiveHook();
		const pending = hook(request());

		const ui = await prompts.next();
		ui?.resolve({ type: "allow" });
		expect(() => ui?.resolve({ type: "deny", reason: "too late" })).not.toThrow();
		expect(() => ui?.close()).not.toThrow();

		expect(await pending).toEqual({ type: "allow" });
	});

	it("queues concurrent prompts independently", async () => {
		const { hook, prompts } = interactiveHook();
		const first = hook(request("call_a"));
		const second = hook(request("call_b"));

		const uiA = await prompts.next();
		const uiB = await prompts.next();
		expect(uiA?.request.toolCallId).toBe("call_a");
		expect(uiB?.request.toolCallId).toBe("call_b");

		uiB?.resolve({ type: "allow" });
		uiA?.resolve({ type: "deny", reason: "no" });

		expect(await first).toEqual({ type: "deny", reason: "no" });
		expect(await second).toEqual({ type: "allow" });
	});
});
