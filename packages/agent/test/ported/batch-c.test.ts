import { describe, expect, it } from "vitest";
import { notificationHookStatusPending } from "../../src/harness/notification-hook.ts";
import { ExecutionError, FileError } from "../../src/harness/types.ts";
import { Agent } from "../../src/index.ts";

/**
 * phase 22 batch C wrap-up — the remaining `new-test` verdicts in the agent's main loop.
 *
 * This batch is the heart of the agent. Every failure mode here is **silent**: the model suddenly
 * "forgets" what was said, a queued message goes missing, a status query returns last turn's
 * snapshot — with no error anywhere.
 *
 * `PendingMessageQueue` (`agent.ts:133`) is not exported, so the queue family (`enqueue`, `hasItems`,
 * `drain`) can only be tested through `Agent`'s public surface (`steer`, `followUp`,
 * `hasQueuedMessages`, `clearAllQueues`) — which is also how they are driven in real use.
 */
describe("phase 22 batch C wrap-up", () => {
	const userMessage = (content: string) => ({ role: "user" as const, content, timestamp: 0 });

	// ── agent/src/agent.rs::new@79 ────────────────────────────────────────────
	//
	// Upstream's `Agent::new` builds a clean agent. The constructor decides the **initial state**:
	// leftover history means a new session carries the previous session's messages.
	describe("constructing an Agent (upstream new)", () => {
		it("starts with an empty message history", () => {
			expect(new Agent().state.messages).toEqual([]);
		});

		it("starts not streaming and with nothing queued", () => {
			const agent = new Agent();

			expect([agent.state.isStreaming, agent.hasQueuedMessages()]).toEqual([false, false]);
		});

		it("two instances do not share queues", () => {
			// Holds the line on "not a module-level singleton" — crossed wires would let two sessions see
			// each other's queued messages.
			const a = new Agent();
			const b = new Agent();
			a.steer(userMessage("only in a"));

			expect(b.hasQueuedMessages()).toBe(false);
		});
	});

	// ── agent/src/agent.rs::state@142 ─────────────────────────────────────────
	//
	// Upstream's `state()` returns the current snapshot. Every caller — TUI, SDK, export — reads state
	// through it, and a stale snapshot means the interface shows something other than what is running.
	describe("Agent.state", () => {
		it("exposes both messages and isStreaming", () => {
			expect(Object.keys(new Agent().state)).toEqual(expect.arrayContaining(["messages", "isStreaming"]));
		});

		it("reports isStreaming false while idle", () => {
			expect(new Agent().state.isStreaming).toBe(false);
		});
	});

	// ── agent/src/agent.rs::enqueue@86 / has_items@104 / drain@90 ─────────────
	//
	// The three queue operations. Upstream's `QueueMode` decides how much `drain` releases at once:
	// `all` takes everything, `one-at-a-time` takes only the head. Getting it wrong loses messages or
	// reorders them — the user types three, the model sees one.
	describe("the pending queue (upstream enqueue / has_items / drain)", () => {
		it("a steered message shows up as queued", () => {
			const agent = new Agent();

			agent.steer(userMessage("steer me"));

			// Drop it and the next turn's model never sees what the user just typed.
			expect(agent.hasQueuedMessages()).toBe(true);
		});

		it("a follow-up message also counts as queued", () => {
			const agent = new Agent();

			agent.followUp(userMessage("and then this"));

			expect(agent.hasQueuedMessages()).toBe(true);
		});

		it("clearing all queues empties both — steering and follow-up are separate queues", () => {
			const agent = new Agent();
			agent.steer(userMessage("a"));
			agent.followUp(userMessage("b"));

			agent.clearAllQueues();

			expect(agent.hasQueuedMessages()).toBe(false);
		});

		it("clearing only the steering queue leaves the follow-up queue intact", () => {
			// This holds the line on the two queues being independent — clearing the wrong one discards the
			// follow-ups the user has already queued.
			const agent = new Agent();
			agent.followUp(userMessage("keep me"));

			agent.clearSteeringQueue();

			expect(agent.hasQueuedMessages()).toBe(true);
		});
	});

	// ── agent/src/harness/types.rs::new@52 / new@83 ───────────────────────────
	//
	// **Two** `new` functions in the same `.rs`: `FileError::new` (52) and `ExecutionError::new` (83).
	// The roster keys carry upstream line numbers precisely so the two can be told apart (see
	// phase22/README.md).
	//
	// Both store `code` as a backend-independent error code. Callers branch on `code`, so storing the
	// wrong one turns "file does not exist" into "permission denied".
	describe("constructing FileError and ExecutionError (the two new functions in upstream types.rs)", () => {
		it("FileError keeps its code, message and path", () => {
			const err = new FileError("not_found", "no such file", "/tmp/x");

			expect([err.code, err.message, err.path, err.name]).toEqual([
				"not_found",
				"no such file",
				"/tmp/x",
				"FileError",
			]);
		});

		it("ExecutionError keeps its code and message — and is a distinct type from FileError", () => {
			const err = new ExecutionError("timeout", "took too long");

			expect([err.code, err.message, err.name]).toEqual(["timeout", "took too long", "ExecutionError"]);
		});

		it("both are real Errors — instanceof must hold for catch-site narrowing", () => {
			expect([
				new FileError("not_found", "m") instanceof Error,
				new ExecutionError("timeout", "m") instanceof Error,
			]).toEqual([true, true]);
		});
	});

	// ── agent/src/harness/notification_hook.rs::pending@135 ───────────────────
	//
	// The initial state of a hook that has not started. The implementation comment spells out an easy
	// mistake: the four `Option<T>` fields serialise upstream as **`null`, not omitted**, while
	// `JSON.stringify` drops keys whose value is `undefined` — writing `undefined` silently changes
	// the wire format.
	describe("notificationHookStatusPending（oracle pending）", () => {
		it("starts disconnected with the not-yet-started reason", () => {
			expect(notificationHookStatusPending().state).toEqual({ kind: "disconnected", reason: "not yet started" });
		});

		it("uses null (not undefined) for the optional fields — undefined would drop the keys on the wire", () => {
			const wire = JSON.parse(JSON.stringify(notificationHookStatusPending())) as Record<string, unknown>;

			expect(Object.hasOwn(wire, "last_event_at") && Object.hasOwn(wire, "last_ack_at")).toBe(true);
		});
	});

	// ── the companion surface to agent/src/agent.rs::abort@159: reset ─────────
	//
	// `reset()` returns the agent to its constructed state. It shares one definition of "clean state"
	// with the constructor, so both are held here together: after a reset the agent has to match a
	// freshly constructed one.
	describe("Agent.reset", () => {
		it("leaves the agent equivalent to a freshly constructed one", () => {
			const agent = new Agent();
			agent.steer(userMessage("noise"));

			agent.reset();

			expect([agent.state.messages, agent.hasQueuedMessages(), agent.state.isStreaming]).toEqual([[], false, false]);
		});
	});
});
