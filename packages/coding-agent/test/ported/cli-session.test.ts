/**
 * 1:1 port of oracle `crates/coding-agent/tests/cli_session.rs` (pie @0a120dfd) — 2
 * `#[tokio::test]` functions, 2 tests here, 0 skipped.
 *
 * Oracle module doc: "CLI / session integration test (Phase 5 of the harness refactor plan).
 * Exercises the full happy path without going through `main.rs` or the TUI: PIE_DIR-scoped
 * sessions dir, harness assembly mirroring the binary, faux StreamFn for deterministic
 * responses, then drop everything and reopen via `JsonlSessionRepo` to verify the active branch
 * survived persistence."
 *
 * Construct mapping (each a naming/architecture translation, NOT a weakened assertion):
 * - `AgentHarnessOptions::stream_fn` has no TS slot — the harness builds its stream fn from the
 *   model's registered `@pie/ai` API provider. The canonical in-repo replacement is
 *   `registerFauxProvider()` with the replies queued in order; same idiom as
 *   `test/ported/export-e2e.test.ts` and `packages/agent/test/ported/harness-e2e.test.ts`.
 * - `MemorySessionStorage` -> `InMemorySessionStorage`;
 *   `session.storage().get_metadata_json()["id"]` -> `session.getMetadata().id` (the storage's
 *   typed metadata rather than its JSON projection).
 * - `JsonlSessionRepo::new(path)` -> `new JsonlSessionRepo({ fs, sessionsRoot })`; the TS repo
 *   takes its filesystem through an injected `ExecutionEnv` (browser-bundle constraint) instead
 *   of reaching for `std::fs`. `repo.list()` returns metadata records, so `repo.open(files[0])`
 *   takes the metadata rather than oracle's path handle.
 * - `AgentHarness::agent().state()` does not exist in TS: the per-turn agent state is rebuilt
 *   from `session.buildContext()` on every turn (see `agent-harness.ts:2100-2115`'s
 *   `rehydrateFromSession` doc, which spells out that `messages` is NOT persistent harness
 *   state the way oracle's is). Test 2's three `state.*` assertions are therefore made against
 *   the exact values that state is built from: `harness.getThinkingLevel()`,
 *   `harness.getModel()`, and the rehydrated `SessionContext.messages` — same facts, one fewer
 *   indirection, no assertion dropped.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@pie/agent-core";
import { AgentHarness, InMemorySessionStorage, JsonlSessionRepo, Session } from "@pie/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../agent/src/harness/env/nodejs.ts";

let registrations: FauxProviderRegistration[] = [];
let tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** pie: cli_session.rs:20-36 (`faux_model`). */
function fauxProvider(): FauxProviderRegistration {
	const registration = registerFauxProvider({ provider: "faux", models: [{ id: "faux", name: "Faux" }] });
	registrations.push(registration);
	return registration;
}

/** Text of a user or assistant `AgentMessage`, mirroring oracle's `filter_map` over
 * `UserContent::Text` / the first `ContentBlock::Text` (cli_session.rs:131-147). */
function messageText(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	const block = (content as Array<{ type: string; text?: string }>).find((b) => b.type === "text");
	return block?.text;
}

afterEach(() => {
	for (const registration of registrations) registration.unregister();
	registrations = [];
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("cli_session.rs (char-tests port)", () => {
	/**
	 * pie: cli_session.rs:73-149. Oracle doc: "Create → prompt twice → drop → reopen →
	 * build_context() returns both user + both assistant messages on the active branch. Uses a
	 * real jsonl repo on a `tempdir()` so the test goes through actual file IO."
	 */
	it("create_persist_reopen_resume_round_trips", async () => {
		const root = tempDir("pie-ported-cli-session-");
		const env = new NodeExecutionEnv({ cwd: root });
		const registration = fauxProvider();
		// pie: cli_session.rs:96 — `faux_stream_fn("ack")` answers every prompt with "ack".
		registration.setResponses([fauxAssistantMessage("ack"), fauxAssistantMessage("ack")]);

		let sessionId: string;
		{
			// pie: cli_session.rs:79-99
			const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "sessions") });
			const session = await repo.create({ cwd: "/some/cwd" });
			sessionId = (await session.getMetadata()).id;

			const harness = new AgentHarness({
				env,
				session,
				model: registration.getModel(),
				thinkingLevel: "off",
				getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
			});
			await harness.prompt("first");
			await harness.prompt("second");
		}

		// pie: cli_session.rs:102-106 — drop everything above, then reopen by id.
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "sessions") });
		const files = await repo.list();
		expect(files.length, "expected exactly one session file").toBe(1);

		// pie: cli_session.rs:107-120
		const reopened = await repo.open(files[0]!);
		const reopenedId = (await reopened.getMetadata()).id;
		expect(reopenedId, "metadata id must survive close/reopen").toBe(sessionId);

		// pie: cli_session.rs:122-129 — 2 user prompts + 2 assistant replies on the active branch.
		const ctx = await reopened.buildContext();
		expect(ctx.messages.length, `expected 4 messages; got: ${JSON.stringify(ctx.messages)}`).toBe(4);

		// pie: cli_session.rs:131-148
		const texts = ctx.messages.map(messageText).filter((t): t is string => t !== undefined);
		expect(texts).toEqual(["first", "ack", "second", "ack"]);
	});

	/**
	 * pie: cli_session.rs:155-189. Oracle doc: "`--resume`'s hand-rolled hydration moved into the
	 * harness in Phase 4. This test exercises the harness API directly: seed a thinking-level
	 * change, a model change, and a user message into a memory session, then build a *fresh*
	 * harness with cold defaults and verify `rehydrate_from_session` mirrors all three into agent
	 * state."
	 */
	it("rehydrate_after_reopen_mirrors_state_into_agent", async () => {
		const env = new NodeExecutionEnv({ cwd: tempDir("pie-ported-cli-session-rehydrate-") });
		const registration = fauxProvider();

		// pie: cli_session.rs:157-171
		const session = new Session(new InMemorySessionStorage());
		await session.appendThinkingLevelChange("high");
		await session.appendModelChange("faux", "faux");
		await session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "prior-prompt" }],
			timestamp: 0,
		} as AgentMessage);

		// pie: cli_session.rs:173-177 — cold-start harness: thinking off, the seeded model absent
		// from any catalog.
		const harness = new AgentHarness({
			env,
			session,
			model: registration.getModel(),
			thinkingLevel: "off",
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});

		// pie: cli_session.rs:179-181
		const ctx = await harness.rehydrateFromSession();
		expect(ctx.thinkingLevel).toBe("high");
		expect(ctx.model).not.toBeNull();

		// pie: cli_session.rs:183-188 (`harness.agent().state()` — see the header note on why the
		// three assertions read the values that state is rebuilt from).
		expect(ctx.messages.length).toBe(1);
		expect(harness.getThinkingLevel()).toBe("high");
		// The faux model isn't in the embedded catalog → keep the cold-start model. The point is
		// that rehydrate didn't blow it away or throw.
		expect(harness.getModel()).toBeDefined();
	});
});
