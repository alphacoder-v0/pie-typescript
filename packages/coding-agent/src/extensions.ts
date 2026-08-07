/**
 * Extension trait + registry for c4pt0r/pie#10 Part B.
 *
 * Port of oracle `crates/coding-agent/src/extensions.rs` (pie @0a120dfd).
 *
 * v1 ships the in-process surface: a trait that extensions implement, plus a registry that the
 * CLI consults at startup. WASM and dylib hosts plug in behind the same trait — those land as
 * follow-up commits without breaking this API. The shape mirrors the skills loader (#10 Part A):
 * per-extension `name()` + `init(ctx)` that returns the tools, slash-commands, lifecycle
 * observers the extension contributes. Failures during init are isolated — one bad extension
 * can't take down the agent.
 *
 * **Unwired, by design.** Oracle carries `#![allow(dead_code)]` on this module (extensions.rs:10)
 * and has no caller anywhere in the crate: nothing constructs an `ExtensionRegistry`, and
 * `main.rs` never consults one. RULEBOOK §4 ("what this port does not do") makes that explicit for this port —
 * "do not wire up the extensions loader (upstream's own extensions.rs is unwired; port it as-is)" — and
 * `migration/manifest.tsv` row `coding-agent/extensions` repeats it ("unwired extension registry
 * — port as-is (audit: dead code allowed)"). This file therefore intentionally has no importer
 * in `packages/coding-agent`; do not invent one.
 *
 * Two collaborator types have no settled TS counterpart yet and are modelled as narrow local
 * stand-ins — see `ExtensionSlashCommand` below and the `AgentTool` import.
 */

// oracle extensions.rs:14 — `use pie_agent_core::AgentTool`. pie's Rust `AgentTool` is a
// method-based trait (`definition()` / `label()` / `execute(...)`) that does not structurally
// match `@pie/agent-core`'s object-literal `AgentTool<TParameters, TDetails>`; reconciling the
// two is an open design question tracked in `triggers/cron-deps.ts`'s header. Reusing that
// module's existing stand-in (type-only import, no runtime coupling) rather than defining a
// second copy here — RULEBOOK §4 forbids a second implementation of a shared shape.
import type { AgentTool } from "./triggers/cron-deps.ts";

/**
 * oracle extensions.rs:16 — `use crate::commands::SlashCommand`.
 *
 * TODO(port): replace with the real trait-shaped slash command once manifest row
 * `coding-agent/commands` (`crates/coding-agent/src/commands.rs` → `core/slash-commands.ts`,
 * phase 13) lands. `extensions.rs` only ever *carries* `Arc<dyn SlashCommand>` values — it
 * stores them in `ExtensionContribution.slash_commands` and concatenates them into
 * `InitOutput.commands`, never calling `run()` — so this unit models just the identity slice of
 * oracle's trait (commands.rs:188-200: `name()` + `description()`, both `&'static str`).
 * Naming it `ExtensionSlashCommand` avoids colliding with the unrelated data-shaped
 * `SlashCommand` that `core/slash-commands.ts` exports today.
 */
export interface ExtensionSlashCommand {
	/** oracle commands.rs:190 — canonical name without the leading `/`. */
	name(): string;
	/** oracle commands.rs:195. */
	description(): string;
}

/**
 * Inputs an extension may consult during initialization. oracle extensions.rs:19-22
 * (`ExtensionContext<'a>`); `&Path` → `string` per RULEBOOK §2.3.
 */
export interface ExtensionContext {
	cwd: string;
	sessionId: string;
}

/**
 * What an extension may contribute. oracle extensions.rs:25-31 (`ExtensionContribution`,
 * `#[derive(Default)]` — all vecs default to empty).
 */
export interface ExtensionContribution {
	tools?: AgentTool[];
	slashCommands?: ExtensionSlashCommand[];
	/**
	 * Free-form per-extension banner line shown at startup. Absent suppresses.
	 * oracle: `Option<String>` → `string | undefined` (RULEBOOK §2.1).
	 */
	banner?: string;
}

/**
 * The extension trait. oracle extensions.rs:35-45 (`trait AgentExtension: Send + Sync`) —
 * `trait` → `interface` per RULEBOOK §2.1; `Arc<dyn AgentExtension>` → a plain value of this
 * interface type (§2.1 `Arc<T>` row).
 *
 * `init` returns `anyhow::Result<ExtensionContribution>` in oracle; RULEBOOK §2.4 maps
 * `Result::Err` propagation onto `throw`, so a TS extension signals failure by throwing.
 */
export interface AgentExtension {
	/** Canonical name. Used for collision resolution + diagnostics. oracle extensions.rs:37. */
	name(): string;
	/**
	 * Brief one-line description for `/extensions`. oracle extensions.rs:39-41 provides a
	 * defaulted trait method returning `""`; TS has no default methods, so the member is
	 * optional and {@link extensionDescription} applies the same `""` default at the call site.
	 */
	description?(): string;
	/**
	 * Build the contribution. Called once at session startup; failures are logged + the
	 * extension is skipped for that session. oracle extensions.rs:44.
	 */
	init(ctx: ExtensionContext): ExtensionContribution;
}

/**
 * Applies oracle's defaulted `description()` (extensions.rs:39-41) for implementations that omit
 * it. Exported because the `/extensions` display surface is a separate (unported) unit.
 */
export function extensionDescription(ext: AgentExtension): string {
	return ext.description?.() ?? "";
}

/** oracle extensions.rs:108-113 (`struct InitOutput`). */
export interface InitOutput {
	tools: AgentTool[];
	commands: ExtensionSlashCommand[];
	banners: string[];
	errors: string[];
}

/**
 * Static registry. oracle extensions.rs:50-106 (`ExtensionRegistry` + its `Default` impl, which
 * just forwards to `new()`).
 *
 * Extensions are added at construction time today; the WASM/dylib loader (which would read
 * `~/.pie/extensions/*` at runtime and construct trait objects) is explicitly out of scope here
 * — see the module header.
 */
export class ExtensionRegistry {
	private readonly extensions: AgentExtension[] = [];

	/** oracle extensions.rs:61-63 (`register`). */
	register(ext: AgentExtension): void {
		this.extensions.push(ext);
	}

	/** oracle extensions.rs:65-67 (`iter`) — `impl Iterator<Item = &Arc<dyn AgentExtension>>`. */
	iter(): IterableIterator<AgentExtension> {
		return this.extensions.values();
	}

	/**
	 * Init every extension, collecting their contributions. Per-extension failures emit a
	 * diagnostic in the returned `errors` array but never abort the load.
	 * oracle extensions.rs:71-99 (`init_all`).
	 *
	 * Error-vs-panic split (RULEBOOK §2.4): oracle distinguishes two failure channels —
	 * `Ok(Err(e))` from `init`'s `anyhow::Result` renders `"{name}: {e}"` (extensions.rs:85-87),
	 * while a *panic* caught by `catch_unwind` renders the fixed `"{name}: panicked during init"`
	 * (extensions.rs:88-90). TypeScript has a single `throw` channel, so the split is recovered
	 * from the thrown value's shape: a thrown `Error` is the `anyhow` branch (an `anyhow::Error`
	 * always carries a message), a thrown non-`Error` is the panic branch (`panic!("oops")`
	 * unwinds with a bare string payload, exactly what `throw "oops"` produces here).
	 *
	 * TODO(port): switch the panic branch to `err instanceof InvariantError` once RULEBOOK §2.4's
	 * single `invariant(cond, msg)` helper exists in `@pie/agent-core` — it does not today (no
	 * `invariant`/`InvariantError` export anywhere in `packages/agent`), so the shape heuristic
	 * above is the most faithful mapping available at this phase.
	 */
	initAll(ctx: ExtensionContext): InitOutput {
		const tools: AgentTool[] = [];
		const commands: ExtensionSlashCommand[] = [];
		const banners: string[] = [];
		const errors: string[] = [];
		for (const ext of this.extensions) {
			try {
				const contribution = ext.init(ctx);
				// oracle extensions.rs:79-83: extend, then push the banner only when present.
				tools.push(...(contribution.tools ?? []));
				commands.push(...(contribution.slashCommands ?? []));
				if (contribution.banner !== undefined) {
					banners.push(`${ext.name()}: ${contribution.banner}`);
				}
			} catch (err) {
				errors.push(err instanceof Error ? `${ext.name()}: ${err.message}` : `${ext.name()}: panicked during init`);
			}
		}
		return { tools, commands, banners, errors };
	}
}
