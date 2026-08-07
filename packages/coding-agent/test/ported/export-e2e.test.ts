/**
 * char-tests port of oracle `crates/coding-agent/tests/export_e2e.rs` (pie @0a120dfd).
 *
 * Oracle module doc: "End-to-end test for the session transcript exporter (used by `/save`). Runs
 * the AgentHarness against a faux model, prompts twice, exports the active branch to a Markdown
 * file in a tempdir, then asserts the file contains the prompts + assistant replies in order."
 *
 * Oracle test functions: 1. Ported: 1. Skipped: 0.
 *
 * Construct mapping notes:
 * - `MemorySessionStorage` -> `InMemorySessionStorage` (both from the agent-core bucket; same
 *   role, renamed by the skeleton).
 * - `AgentHarnessOptions::new(model, session)` + `opts.stream_fn = Some(faux_stream(text))` ->
 *   the TS `AgentHarness` has no `streamFn` slot (agent-harness.ts:1613 documents the absence:
 *   it builds its own stream fn from the model's registered API provider). The equivalent faux
 *   provider is `@pie/ai`'s `registerFauxProvider` (the canonical in-repo faux-model harness,
 *   used the same way by `packages/agent/test/ported/harness-e2e.test.ts`), with the two replies
 *   queued in order. Oracle rebuilds a second harness over the SAME `Session` purely to swap the
 *   canned reply ("cheaper than juggling a shared interior mutability. Re-wires same Session so
 *   transcript is continuous"); that two-harness/one-session structure is preserved verbatim
 *   below even though a single harness would now suffice, because it is what oracle exercises.
 * - `AgentHarnessOptions` in TS additionally requires `env` (an `ExecutionEnv`) and, to run a
 *   turn, `getApiKeyAndHeaders`; neither exists on oracle's option struct. `NodeExecutionEnv` is
 *   NOT re-exported from the `@pie/agent-core` bucket (only from its `/node` subpath, which this
 *   package's vitest alias does not map to source), so it is imported through its source path --
 *   the same module the `@pie/agent-core` alias resolves to, so there is exactly one copy of the
 *   agent-core module graph in the run.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHarness, InMemorySessionStorage, Session } from "@pie/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pie/ai";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../agent/src/harness/env/nodejs.ts";
import { save } from "../../src/export.ts";

let registrations: FauxProviderRegistration[] = [];
let tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** pie: export_e2e.rs:24-40 (`faux_model`) -- oracle's literal `Model { id: "faux", .. }`; the
 * faux provider registration is what makes it streamable here (see the header note). */
function fauxProvider(): FauxProviderRegistration {
	const registration = registerFauxProvider({ provider: "faux", models: [{ id: "faux", name: "Faux" }] });
	registrations.push(registration);
	return registration;
}

afterEach(() => {
	for (const registration of registrations) registration.unregister();
	registrations = [];
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("export_e2e", () => {
	/** pie: export_e2e.rs:72-103 */
	it("save_writes_markdown_transcript_with_prompts_and_replies_in_order", async () => {
		const env = new NodeExecutionEnv({ cwd: tempDir("pie-ported-export-cwd-") });
		const registration = fauxProvider();
		// pie: export_e2e.rs:77 (`faux_stream("first ack")`) and :85 (`faux_stream("second ack")`)
		registration.setResponses([fauxAssistantMessage("first ack"), fauxAssistantMessage("second ack")]);

		// pie: export_e2e.rs:74-79
		const session = new Session(new InMemorySessionStorage());
		const harness = new AgentHarness({
			env,
			session,
			model: registration.getModel(),
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		await harness.prompt("first question");

		// pie: export_e2e.rs:81-86 -- second harness, same Session, so the transcript is continuous.
		const harness2 = new AgentHarness({
			env,
			session,
			model: registration.getModel(),
			getApiKeyAndHeaders: async () => ({ apiKey: "test-key" }),
		});
		await harness2.prompt("second question");

		// pie: export_e2e.rs:88-91
		const outdir = tempDir("pie-ported-export-out-");
		const dest = join(outdir, "transcript.md");
		const written = await save(session, dest);
		expect(written).toBe(dest);

		// pie: export_e2e.rs:93-102
		const body = readFileSync(dest, "utf-8");
		const posQ1 = body.indexOf("first question");
		expect(posQ1, "q1 present").toBeGreaterThanOrEqual(0);
		const posR1 = body.indexOf("first ack");
		expect(posR1, "r1 present").toBeGreaterThanOrEqual(0);
		const posQ2 = body.indexOf("second question");
		expect(posQ2, "q2 present").toBeGreaterThanOrEqual(0);
		const posR2 = body.indexOf("second ack");
		expect(posR2, "r2 present").toBeGreaterThanOrEqual(0);
		expect(posQ1 < posR1 && posR1 < posQ2 && posQ2 < posR2, `order: ${body}`).toBe(true);
		expect(body).toContain("# Session Transcript");
	});
});
