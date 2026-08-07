/**
 * Characterization tests for `packages/coding-agent/src/extensions.ts`
 * (port of oracle `crates/coding-agent/src/extensions.rs`, pie @0a120dfd).
 *
 * `registry_isolates_failing_extension` is the direct translation of oracle extensions.rs:150-167;
 * the remaining cases lock the accumulation/ordering behaviour `init_all` (extensions.rs:71-99)
 * relies on but that oracle's single test does not assert.
 */
import { describe, expect, it } from "vitest";
import {
	type AgentExtension,
	type ExtensionContext,
	type ExtensionContribution,
	ExtensionRegistry,
	type ExtensionSlashCommand,
	extensionDescription,
} from "../src/extensions.ts";

function ctx(): ExtensionContext {
	// oracle extensions.rs:156-160 uses `std::env::current_dir()` + session id "t".
	return { cwd: process.cwd(), sessionId: "t" };
}

/** oracle extensions.rs:119-130 (`struct Hello`). */
const hello: AgentExtension = {
	name: () => "hello",
	init: () => ({ banner: "ready" }),
};

/** oracle extensions.rs:131-139 (`struct Boom`) — `anyhow::bail!("intentional failure")`. */
const boom: AgentExtension = {
	name: () => "boom",
	init: () => {
		throw new Error("intentional failure");
	},
};

/**
 * oracle extensions.rs:140-148 (`struct Panicker`) — `panic!("oops")`. A Rust panic unwinds with
 * a bare string payload, so the TS analogue throws a non-`Error` value; see `initAll`'s doc for
 * why that is what selects the "panicked during init" branch.
 */
const panicker: AgentExtension = {
	name: () => "panicker",
	init: () => {
		throw "oops";
	},
};

describe("ExtensionRegistry", () => {
	it("isolates a failing extension (oracle extensions.rs:150-167)", () => {
		const r = new ExtensionRegistry();
		r.register(hello);
		r.register(boom);
		r.register(panicker);

		const out = r.initAll(ctx());

		expect(out.banners.length).toBe(1);
		expect(out.banners[0]).toContain("hello");
		expect(out.errors.length).toBe(2);
		expect(out.errors.some((e) => e.includes("boom"))).toBe(true);
		expect(out.errors.some((e) => e.includes("panicker"))).toBe(true);
	});

	it("renders the two failure channels with oracle's exact strings", () => {
		const r = new ExtensionRegistry();
		r.register(boom);
		r.register(panicker);

		const out = r.initAll(ctx());

		// oracle extensions.rs:86 — `format!("{}: {e}", ext.name())`.
		expect(out.errors[0]).toBe("boom: intentional failure");
		// oracle extensions.rs:89 — fixed string for the catch_unwind branch.
		expect(out.errors[1]).toBe("panicker: panicked during init");
	});

	it("prefixes the banner with the extension name (oracle extensions.rs:82)", () => {
		const r = new ExtensionRegistry();
		r.register(hello);

		expect(r.initAll(ctx()).banners).toEqual(["hello: ready"]);
	});

	it("suppresses the banner when the contribution omits it (oracle extensions.rs:81)", () => {
		const r = new ExtensionRegistry();
		r.register({ name: () => "quiet", init: () => ({}) });

		const out = r.initAll(ctx());
		expect(out.banners).toEqual([]);
		expect(out.errors).toEqual([]);
		expect(out.tools).toEqual([]);
		expect(out.commands).toEqual([]);
	});

	it("concatenates tools and slash commands in registration order (oracle extensions.rs:79-80)", () => {
		const cmd = (name: string): ExtensionSlashCommand => ({ name: () => name, description: () => "" });
		const contribution = (n: string): ExtensionContribution => ({
			// The tool slot is an opaque carried value in this unit; a cast keeps the test from
			// asserting a shape `cron-deps.ts`'s stand-in has not settled on yet.
			tools: [{ label: () => n } as never],
			slashCommands: [cmd(n)],
		});
		const r = new ExtensionRegistry();
		r.register({ name: () => "a", init: () => contribution("a") });
		r.register({ name: () => "b", init: () => contribution("b") });

		const out = r.initAll(ctx());
		expect(out.tools.length).toBe(2);
		expect(out.commands.map((c) => c.name())).toEqual(["a", "b"]);
	});

	it("keeps contributions from extensions registered after a failing one", () => {
		const r = new ExtensionRegistry();
		r.register(boom);
		r.register(hello);

		const out = r.initAll(ctx());
		expect(out.banners).toEqual(["hello: ready"]);
		expect(out.errors).toEqual(["boom: intentional failure"]);
	});

	it("passes the context through to init unchanged (oracle extensions.rs:77)", () => {
		const seen: ExtensionContext[] = [];
		const r = new ExtensionRegistry();
		r.register({
			name: () => "spy",
			init: (c) => {
				seen.push(c);
				return {};
			},
		});

		const given = { cwd: "/tmp/pie-extensions-ctx", sessionId: "sess-1" };
		r.initAll(given);
		expect(seen).toEqual([given]);
	});

	it("iterates registered extensions in registration order (oracle extensions.rs:65-67)", () => {
		const r = new ExtensionRegistry();
		r.register(hello);
		r.register(boom);

		expect([...r.iter()].map((e) => e.name())).toEqual(["hello", "boom"]);
	});

	it("starts empty (oracle extensions.rs:55-59 / Default impl at 102-106)", () => {
		const r = new ExtensionRegistry();
		expect([...r.iter()]).toEqual([]);
		expect(r.initAll(ctx())).toEqual({ tools: [], commands: [], banners: [], errors: [] });
	});
});

describe("extensionDescription", () => {
	it("defaults to the empty string when description() is not implemented (oracle extensions.rs:39-41)", () => {
		expect(extensionDescription(hello)).toBe("");
	});

	it("returns the implementation's description when present", () => {
		expect(extensionDescription({ ...hello, description: () => "says hi" })).toBe("says hi");
	});
});
