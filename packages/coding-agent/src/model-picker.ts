/**
 * Curated model catalog + state machine for the interactive picker (TUI overlay and web
 * dropdown).
 *
 * Port of oracle crates/coding-agent/src/model_picker.rs (whole file).
 *
 * Only models speaking one of the two supported API families are surfaced: OpenAI-compatible
 * (`openai-completions`, `openai-responses`, `openai-codex-responses`) and Claude-compatible
 * (`anthropic-messages`). `/model <provider:model-id>` remains the uncurated escape hatch.
 *
 * Construct mapping notes:
 * - `pie_ai::list_models()` is a process-global merge of the static catalog and models registered
 *   by `local_models.rs`. Its TS equivalent is `ModelRegistry` (`core/model-registry.ts`), taken
 *   as an injected dependency for exactly the reason `model.ts:8-13` documents: `@pie/ai`'s static
 *   `getModels` cannot see custom models.
 * - `BTreeMap<String, Vec<ModelEntry>>` → a `Map` plus an explicit sort. Rust `String: Ord` is
 *   UTF-8 byte order, which equals code-point order, so {@link compareUtf8} is used instead of
 *   JS's default UTF-16 code-unit comparison (the two differ only above the BMP).
 * - `enum PickerLevel` (data-carrying) → tagged discriminated union (RULEBOOK §2.1).
 * - `Option<(String, String)>` → `{ provider, id } | undefined` (§2.1).
 * - Rust slice indexing panics on out-of-range; `panic!` maps to a throw (§2.4). No `invariant`
 *   helper exists in this repo yet (see `extensions.ts:150-151`), so the throws are explicit.
 *
 * TODO(port): the WebUI half of oracle's "TUI overlay and web dropdown" (issue #223) is a phase 15
 * unit. Oracle `#[derive(Serialize)]`s {@link ModelEntry} and {@link ProviderGroup} with serde's
 * default field naming, so the JSON the web dropdown receives uses `provider` / `has_credential` /
 * `models` / `id` / `name`. The interfaces below stay camelCase because they are internal state
 * first; whoever lands the web endpoint must map `hasCredential` → `has_credential` at the wire
 * boundary (RULEBOOK §2.1 "TS object field names are wire names" applies to the serialized shape).
 *
 * TODO(port): the TUI overlay (key handling + rendering) is a phase 14 unit. Oracle drives this
 * state machine from `ui/mod.rs:857-905`: Up/`k` → {@link ModelPickerState.up}, Down/`j` →
 * {@link ModelPickerState.down}, Enter → {@link ModelPickerState.enter} (a returned spec closes the
 * overlay and switches the model), Esc → {@link ModelPickerState.back} (`true` closes), ctrl+c →
 * close, key-release events ignored; rendering calls {@link ModelPickerState.view}.
 */

import { type Api, envVarNames, type Model } from "@pie/ai";
import type { AuthStorage } from "./core/auth-storage.ts";

/** model_picker.rs:12-17 -- the two API families the curated catalog surfaces. */
export const SUPPORTED_APIS: readonly string[] = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
];

/** model_picker.rs:19-23 */
export interface ModelEntry {
	id: string;
	name: string;
}

/** model_picker.rs:25-30 */
export interface ProviderGroup {
	provider: string;
	hasCredential: boolean;
	models: ModelEntry[];
}

/** The process-global lookups oracle's `catalog()` reaches for, injected instead. */
export interface ModelCatalogDeps {
	/** `pie_ai::list_models()` (model_picker.rs:40), via the merged registry view. */
	modelRegistry: { getAll(): Model<Api>[] };
	/** `crate::auth::AuthStore::load()` (commands.rs:952). Omit to behave as an empty store. */
	authStorage?: AuthStorage;
	/** `std::env::var` (commands.rs:944). Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

/**
 * commands.rs:941-958 -- the *predicate half* of `model_credential_hint(provider).is_none()`:
 * a provider counts as credentialed when any of its API-key env vars is set to a non-blank value,
 * or when the auth store holds an entry for it.
 *
 * Only the predicate is ported here because that is all `catalog()` consumes
 * (model_picker.rs:34). The hint *text* (commands.rs:960-965) belongs to the
 * `coding-agent/commands` unit and is deliberately not duplicated.
 */
export function providerHasCredential(
	provider: string,
	deps: { authStorage?: AuthStorage; env?: Record<string, string | undefined> } = {},
): boolean {
	const env = deps.env ?? process.env;
	const hasEnv = envVarNames(provider).some((name) => (env[name] ?? "").trim() !== "");
	if (hasEnv) {
		return true;
	}
	return deps.authStorage?.get(provider) !== undefined;
}

/** model_picker.rs:32-35 -- filtered + grouped catalog with live credential detection. */
export function catalog(deps: ModelCatalogDeps): ProviderGroup[] {
	return catalogWith(deps.modelRegistry.getAll(), (provider) =>
		providerHasCredential(provider, { authStorage: deps.authStorage, env: deps.env }),
	);
}

/** model_picker.rs:37-63 -- testable core: credential detection injected. */
export function catalogWith(
	models: readonly Model<Api>[],
	hasCredential: (provider: string) => boolean,
): ProviderGroup[] {
	const groups = new Map<string, ModelEntry[]>();
	for (const model of models) {
		if (!SUPPORTED_APIS.includes(model.api)) {
			continue;
		}
		let entries = groups.get(model.provider);
		if (entries === undefined) {
			entries = [];
			groups.set(model.provider, entries);
		}
		entries.push({ id: model.id, name: model.name });
	}
	// model_picker.rs:39,52 -- `BTreeMap` iterates in key order, so providers come out sorted.
	return [...groups.keys()].sort(compareUtf8).map((provider) => {
		const entries = groups.get(provider) ?? [];
		// model_picker.rs:55 -- models sorted by id within each provider.
		entries.sort((a, b) => compareUtf8(a.id, b.id));
		return { provider, hasCredential: hasCredential(provider), models: entries };
	});
}

/**
 * Rust `String: Ord` compares UTF-8 bytes, which is code-point order. JS's default string
 * comparison is UTF-16 code-unit order; the two disagree only for code points above the BMP
 * (surrogates sort below U+E000..U+FFFF in UTF-16). Model and provider ids are ASCII today, so
 * this only matters for exotic custom registrations -- but the ordering is user-visible.
 */
export function compareUtf8(a: string, b: string): number {
	const ca = Array.from(a);
	const cb = Array.from(b);
	const shared = Math.min(ca.length, cb.length);
	for (let i = 0; i < shared; i++) {
		const x = ca[i].codePointAt(0) ?? 0;
		const y = cb[i].codePointAt(0) ?? 0;
		if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return ca.length - cb.length;
}

/** model_picker.rs:65-69 -- `PickerLevel`, as a tagged union (RULEBOOK §2.1). */
export type PickerLevel = { kind: "providers" } | { kind: "models"; providerIdx: number };

/** model_picker.rs:76-77 -- the active `(provider, id)`, marked `●` in the model list. */
export interface ActiveModel {
	provider: string;
	id: string;
}

/**
 * model_picker.rs:71-195 -- pure two-level navigation state. Rendering and IO live in the TUI
 * layer (phase 14); nothing here touches a terminal.
 */
export class ModelPickerState {
	groups: ProviderGroup[];
	level: PickerLevel;
	cursor: number;
	active: ActiveModel | undefined;

	/** model_picker.rs:81-88 */
	constructor(groups: ProviderGroup[], active?: ActiveModel) {
		this.groups = groups;
		this.level = { kind: "providers" };
		this.cursor = 0;
		this.active = active;
	}

	/** model_picker.rs:90-95 */
	private len(): number {
		if (this.level.kind === "providers") {
			return this.groups.length;
		}
		return this.group(this.level.providerIdx).models.length;
	}

	private group(providerIdx: number): ProviderGroup {
		const group = this.groups[providerIdx];
		if (group === undefined) {
			// Rust indexes the slice directly here and would panic (RULEBOOK §2.4 -> throw).
			throw new Error(`model picker: provider index ${providerIdx} out of range`);
		}
		return group;
	}

	/** model_picker.rs:97-99 */
	up(): void {
		this.cursor = Math.max(0, this.cursor - 1);
	}

	/** model_picker.rs:101-105 */
	down(): void {
		if (this.cursor + 1 < this.len()) {
			this.cursor += 1;
		}
	}

	/**
	 * model_picker.rs:107-134 -- Enter: descend at provider level (returns `undefined`), select at
	 * model level (returns the `provider:id` spec).
	 */
	enter(): string | undefined {
		if (this.level.kind === "providers") {
			if (this.groups.length === 0) {
				return undefined;
			}
			const providerIdx = this.cursor;
			const group = this.group(providerIdx);
			// model_picker.rs:117-122 -- descending lands on the active model of this provider when
			// there is one, otherwise on the first row.
			const active = this.active;
			const activeIdx =
				active !== undefined && active.provider === group.provider
					? group.models.findIndex((m) => m.id === active.id)
					: -1;
			this.cursor = activeIdx === -1 ? 0 : activeIdx;
			this.level = { kind: "models", providerIdx };
			return undefined;
		}
		const group = this.group(this.level.providerIdx);
		const model = group.models[this.cursor];
		if (model === undefined) {
			// model_picker.rs:130 indexes `group.models[self.cursor]` unguarded (§2.4 -> throw).
			throw new Error(`model picker: model index ${this.cursor} out of range`);
		}
		return `${group.provider}:${model.id}`;
	}

	/**
	 * model_picker.rs:136-147 -- Esc: model list → provider list (returns `false`), provider list →
	 * close (returns `true`).
	 */
	back(): boolean {
		if (this.level.kind === "providers") {
			return true;
		}
		const providerIdx = this.level.providerIdx;
		this.level = { kind: "providers" };
		this.cursor = providerIdx;
		return false;
	}

	/** model_picker.rs:149-194 -- window of rows around the cursor. */
	view(visible: number): { title: string; rows: Array<{ text: string; selected: boolean }> } {
		let title: string;
		let rows: string[];
		if (this.level.kind === "providers") {
			title = "Select provider";
			rows = this.groups.map((g) => {
				const key = g.hasCredential ? "" : " · no key";
				return `${g.provider} (${g.models.length})${key}`;
			});
		} else {
			const group = this.group(this.level.providerIdx);
			title = `${group.provider} models`;
			const active = this.active;
			rows = group.models.map((m) => {
				const isActive = active !== undefined && active.provider === group.provider && active.id === m.id;
				return isActive ? `${m.id} ●` : m.id;
			});
		}

		const clampedVisible = Math.max(visible, 1);
		// model_picker.rs:185 -- `(cursor + 1).saturating_sub(visible)`: the cursor sits on the last
		// visible row while scrolling down, and the window pins to the top before that.
		const start = Math.max(0, this.cursor + 1 - clampedVisible);
		const windowed = rows
			.map((text, i) => ({ text, selected: i === this.cursor }))
			.slice(start, start + clampedVisible);
		return { title, rows: windowed };
	}
}
