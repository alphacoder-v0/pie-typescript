/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 *
 * diff-port note (manifest `coding-agent/auth`, curated semantic map to pi counterpart): oracle
 * counterpart is `crates/coding-agent/src/auth.rs` (pie @0a120dfd) -- `crate::auth::AuthStore`,
 * the actual store `/login`/`/logout` and the LLM-request stream wrapper resolve credentials
 * against (`main.rs::stream_fn_with_auth_store`, `commands.rs`'s Login/Logout commands). Storage
 * location: `~/.pie/auth.json` on both sides -- pie: `auth.rs:21-23` (`auth_path() = base_dir()
 * .join("auth.json")`), matches this file's `join(getAgentDir(), "auth.json")` (`getAgentDir()`
 * is `base_dir()`'s TS counterpart, phase 9's unified `~/.pie/` root -- see `config.ts:483`);
 * confirmed no hardcoded path here.
 *
 * Format: oracle's on-disk shape is `{ version: number, providers: { [id]: ProviderCredential } }`
 * (tagged-union credential, `#[serde(tag = "kind")]`) -- NOT ported. This file's flat
 * `Record<provider, AuthCredential>` shape is pi's own pre-existing, independently-designed
 * format (this file predates this migration unit; oracle's coding-agent binary is being replaced
 * wholesale, not run side-by-side against the same `auth.json`, so there is no cross-binary wire
 * dependency on oracle's literal JSON layout to preserve -- unlike a still-shared wire protocol).
 * Adopting oracle's wrapper here would be a breaking rewrite of an established, independently
 * correct pi format with no runtime benefit; kept as-is per diff-port's minimal-overlay mandate.
 *
 * Upgrade-path importer (ED14, phase 19 -- behavior NEITHER side has, see PROVENANCE.md): because
 * phases 9/12 put both binaries on the same `~/.pie/auth.json`, a user upgrading from Rust pie
 * arrives with a file in oracle's shape. The read side therefore accepts BOTH shapes
 * (`importRustPieStore` below); the write side is unchanged and still emits pi's flat shape, so
 * the first `/login` after the upgrade rewrites the file in this port's format with every
 * previously stored credential carried across. Oracle fields with no slot in this port's
 * credential (today: `scopes`) are preserved verbatim under `rustPieFields` rather than dropped.
 * One-way by construction: nothing here ever writes oracle's shape back.
 *
 * Precedence: ALIGNED with oracle (was: observed-but-not-applied; resolved 2026-08-04). Oracle's
 * `resolve_for_provider` (auth.rs:129-143) checks the provider's env var BEFORE the stored
 * `auth.json` credential -- "env var wins; auth.json is the fallback", oracle's own doc comment --
 * and `getApiKey` now does the same. The earlier note kept pi's inverted order and escalated the
 * call; re-reading its three reasons against the founding rule (oracle is the behavior contract),
 * none of them says the inversion is *required* here:
 *   (a) "wide blast radius" is true and is the point -- every provider credential lookup goes
 *       through this one function, which is exactly why the inversion made `export
 *       ANTHROPIC_API_KEY=...` (the standard way to override a stale or revoked stored login) do
 *       nothing at all, app-wide;
 *   (b) "oracle's own OAuth refresh is dead code" does not conflict: env-first only shadows the
 *       stored OAuth credential when the user has explicitly exported a key, which is the intended
 *       override. With no env var set, the refresh path below runs exactly as before;
 *   (c) "no RULEBOOK line authorizes the reorder" is a process reason; standing rule 7 ("the old code is the
 *       spec") already makes oracle the default when no rule covers a case.
 * Two pi-only extras stay OUTSIDE oracle's rule and keep their existing positions: the runtime
 * override (highest, no oracle counterpart) and `getEnvApiKey`'s `google-vertex`
 * `"<authenticated>"` ADC sentinel (below the stored credential -- see `getApiKey`'s inline notes).
 * `migration/reviews/coding-agent-tools/divergence-ledger.tsv`'s `coding-agent/auth` row carries
 * the original escalation and this resolution.
 */

import {
	findEnvKeys,
	getEnvApiKey,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@pie/ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@pie/ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

/**
 * Fields carried over verbatim from a Rust-pie (oracle) `auth.json` entry that this port's flat
 * credential shape has no slot for -- today only oracle's `scopes` (auth.rs:38-39). Written back
 * out as-is so that importing an oracle-shape file and later persisting any provider never
 * silently discards part of a working credential. Only ever set by `importRustPieStore`; a fresh
 * `/login` writes a credential without it. See ED14 and this file's module doc.
 */
export type RustPieFields = Record<string, unknown>;

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	rustPieFields?: RustPieFields;
};

export type OAuthCredential = {
	type: "oauth";
	rustPieFields?: RustPieFields;
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

/**
 * The two -- and only two -- top-level keys oracle's `AuthStore` serializes (auth.rs:61-69):
 * `version` (`#[serde(default = "default_version")]`, so absent is legal on read) and `providers`.
 */
const RUST_PIE_STORE_KEYS: ReadonlySet<string> = new Set(["version", "providers"]);

/**
 * `expires` for an imported OAuth credential whose oracle entry carried no `expires_at`
 * (`Option<i64>`, `skip_serializing_if = "Option::is_none"`). Oracle treats that as "never needs
 * refresh" (`ProviderCredential::needs_refresh`, auth.rs:47-58, returns `false` for `None`) and
 * hands the stored `access_token` straight to the provider, so the import must too: such a
 * credential usually has no `refresh_token` either, and marking it expired would push it into the
 * refresh path, fail there, and make the provider vanish from model discovery.
 */
const NO_KNOWN_EXPIRY = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withRustPieFields<T extends AuthCredential>(credential: T, extra: Record<string, unknown>): T {
	return Object.keys(extra).length === 0 ? credential : { ...credential, rustPieFields: extra };
}

/**
 * Map one oracle `ProviderCredential` (auth.rs:25-41, `#[serde(tag = "kind", rename_all =
 * "snake_case")]`) into this port's credential. Returns `undefined` when `entry` is not a
 * well-formed member of that tagged union -- oracle's own loader is all-or-nothing (a single bad
 * entry fails `serde_json::from_str` for the whole file), so a store containing one is not treated
 * as oracle-shaped at all rather than partially imported.
 */
function importRustPieCredential(entry: unknown): AuthCredential | undefined {
	if (!isRecord(entry)) {
		return undefined;
	}

	if (entry.kind === "api_key") {
		const { kind: _kind, value, ...rest } = entry;
		if (typeof value !== "string") {
			return undefined;
		}
		return withRustPieFields({ type: "api_key", key: value }, rest);
	}

	if (entry.kind === "oauth") {
		const { kind: _kind, access_token, refresh_token, expires_at, ...rest } = entry;
		if (typeof access_token !== "string") {
			return undefined;
		}
		// `Option<T>` deserializes from both an absent key and an explicit `null`, so accept both.
		if (refresh_token != null && typeof refresh_token !== "string") {
			return undefined;
		}
		if (expires_at != null && typeof expires_at !== "number") {
			return undefined;
		}
		return withRustPieFields(
			{
				type: "oauth",
				access: access_token,
				refresh: typeof refresh_token === "string" ? refresh_token : "",
				// oracle's `expires_at` is "Unix epoch seconds" (auth.rs:35); `expires` here is ms.
				expires: typeof expires_at === "number" ? expires_at * 1000 : NO_KNOWN_EXPIRY,
			},
			rest,
		);
	}

	return undefined;
}

/**
 * Read-only compatibility import of a Rust-pie (oracle) `auth.json`. Returns `undefined` -- leaving
 * the caller to parse the blob as this port's own flat shape, exactly as before -- unless the
 * parsed JSON really is oracle's `{version, providers}` store.
 *
 * Detection is on the actual shape, not on `version` alone: this port's format is a bare
 * `Record<providerId, credential>` whose every value is an object, so a provider legitimately named
 * `providers` or `version` is representable and must not be mistaken for oracle's wrapper. A blob
 * is oracle's only when *all* of these hold:
 *   - it has no top-level key outside `{version, providers}`;
 *   - `providers` is a plain object and `version`, if present, is a number (oracle: `u32`);
 *   - every `providers` entry maps cleanly onto a `kind`-tagged oracle credential.
 * The empty case (`providers: {}`) additionally requires the numeric `version`, so that a lone
 * pi-format provider named `providers` is never swallowed.
 */
function importRustPieStore(parsed: Record<string, unknown>): AuthStorageData | undefined {
	for (const key of Object.keys(parsed)) {
		if (!RUST_PIE_STORE_KEYS.has(key)) {
			return undefined;
		}
	}

	const { version, providers } = parsed;
	if (!isRecord(providers)) {
		return undefined;
	}
	if (version !== undefined && typeof version !== "number") {
		return undefined;
	}

	const entries = Object.entries(providers);
	if (entries.length === 0) {
		return typeof version === "number" ? {} : undefined;
	}

	const imported: [string, AuthCredential][] = [];
	for (const [provider, entry] of entries) {
		const credential = importRustPieCredential(entry);
		if (!credential) {
			return undefined;
		}
		imported.push([provider, credential]);
	}
	// `Object.fromEntries` defines own properties, so a provider id of `__proto__` cannot reach the
	// prototype setter the way plain assignment would.
	return Object.fromEntries(imported);
}

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

type LockResult<T> = {
	result: T;
	next?: string;
};

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
	/**
	 * Read-only, side-effect-free peek at the stored blob; `undefined` when nothing is stored.
	 *
	 * pie: crates/coding-agent/src/auth.rs:79-91 (`AuthStore::load_from`) -- `if !path.exists()
	 * { return Ok(Self::default()); }`. Loading credentials never creates, locks, or otherwise
	 * touches `auth.json`. Optional so third-party `AuthStorageBackend` implementations keep
	 * compiling; `AuthStorage.reload` falls back to `withLock` when it is absent.
	 */
	read?(): string | undefined;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = authPath;
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	/**
	 * Create the store file if it is missing (proper-lockfile needs an existing target).
	 *
	 * pie: crates/coding-agent/src/auth.rs:96-115 (`AuthStore::save_to`) never leaves the
	 * credential file readable by anyone but the owner. The previous `writeFileSync(...)` then
	 * `chmodSync(...)` pair opened a window in which the file existed at the umask default
	 * (0644 under the common umask 022). `flag: "wx"` + `mode` creates it 0600 in a single
	 * syscall, and the exclusive flag also means a concurrent creator cannot be clobbered --
	 * `existsSync` alone is a TOCTOU check.
	 */
	private ensureFileExists(): void {
		if (existsSync(this.authPath)) {
			return;
		}
		try {
			writeFileSync(this.authPath, "{}", { encoding: "utf-8", flag: "wx", mode: 0o600 });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as { code?: unknown }).code
					: undefined;
			if (code !== "EEXIST") {
				throw error;
			}
			return;
		}
		// `mode` is masked by the process umask, so normalize (a umask like 0177 would have
		// produced 0400). Never widens: the create above is 0600 at its most permissive.
		chmodSync(this.authPath, 0o600);
	}

	/**
	 * pie: crates/coding-agent/src/auth.rs:96-115 (`AuthStore::save_to`) -- write `<path>.tmp`,
	 * chmod it 0600, then `rename` it over the target. Two properties the previous
	 * write-in-place-then-chmod sequence did not have:
	 *
	 *  1. Atomicity. A crash / kill / ENOSPC mid-write leaves the *temp* file truncated; the
	 *     real `auth.json` is either the complete old content or the complete new one. Writing
	 *     straight into the target left a truncated `auth.json` behind, which then parsed as a
	 *     hard error on the next start.
	 *  2. No permission window. The bytes only ever reach a path that is 0600 before the rename
	 *     publishes it, so the credentials are never momentarily world-readable under a default
	 *     umask.
	 */
	private writeAtomic(contents: string): void {
		const tmpPath = `${this.authPath}.tmp`;
		writeFileSync(tmpPath, contents, { encoding: "utf-8", mode: 0o600 });
		chmodSync(tmpPath, 0o600);
		renameSync(tmpPath, this.authPath);
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	/**
	 * pie: crates/coding-agent/src/auth.rs:79-91 (`AuthStore::load_from`) -- a missing file is an
	 * empty store, and reading one never creates it. Going through `withLock` here instead used to
	 * make merely *starting* `pie` mint a `~/.pie/auth.json` (plus its `.lock`) for users who have
	 * never logged in -- an artifact oracle never leaves behind, caught by parity scenario S7.
	 */
	read(): string | undefined {
		return existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				this.writeAtomic(next);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				this.writeAtomic(next);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	read(): string | undefined {
		return this.value;
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private storage: AuthStorageBackend;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	/**
	 * pie: crates/coding-agent/src/auth.rs:78-88 (`AuthStore::load_from`). A missing file
	 * (`!path.exists()`) AND a file whose contents are blank after trimming
	 * (`if text.trim().is_empty()`) both yield `Self::default()` -- an empty store, NOT a parse
	 * error. Only genuinely malformed JSON reaches `serde_json::from_str` and errors out.
	 *
	 * A bare `if (!content)` misses the whitespace case: `"\n"` is truthy in JS, so an
	 * `auth.json` left holding a single newline (a very common result of an interrupted write
	 * or an editor round-trip) used to throw out of `JSON.parse`, get latched into
	 * `loadError`, and permanently disable persistence -- `/login` would report success while
	 * nothing reached disk.
	 *
	 * pie: crates/coding-agent/src/auth.rs:60-70 (`AuthStore { version, providers }` with a
	 * `#[serde(tag = "kind")]` tagged-union credential) -- this port keeps pi's flat
	 * `Record<provider, AuthCredential>` shape on the write side, but reads both: a file still in
	 * oracle's shape (a user upgrading from Rust pie, which shares this path) is mapped in by
	 * `importRustPieStore`. Anything that is not oracle's shape parses exactly as it did before.
	 * See ED14 in migration/parity/explained-divergences.tsv and this file's module doc.
	 */
	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content || content.trim() === "") {
			return {};
		}
		const parsed = JSON.parse(content) as unknown;
		if (isRecord(parsed)) {
			const imported = importRustPieStore(parsed);
			if (imported) {
				return imported;
			}
		}
		return parsed as AuthStorageData;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		try {
			if (this.storage.read) {
				// pie: auth.rs:79-91 -- pure read, no create, no lock. See `AuthStorageBackend.read`.
				content = this.storage.read();
			} else {
				this.storage.withLock((current) => {
					content = current;
					return { result: undefined };
				});
			}
			this.data = this.parseStorageData(content);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	/**
	 * Persist a single provider entry, merging into whatever is on disk right now.
	 *
	 * pie: crates/coding-agent/src/commands.rs:1997-2011 (`save_api_key`) and :2029-2047
	 * (`/logout`): both start with `AuthStore::load()` and, when it fails, **return the error to
	 * the caller** (`Err("load auth store: {e}")` / `CommandOutcome::Error(...)`) without writing
	 * anything. Failure is loud and the malformed file is left untouched.
	 *
	 * This method used to `return` silently on `loadError` and swallow write failures into
	 * `recordError`, so a corrupt (or, before the `parseStorageData` fix above, merely
	 * whitespace-only) `auth.json` turned every subsequent `set`/`remove` into a no-op that
	 * still looked like success to the caller. Both paths now throw: the file is still never
	 * clobbered (no `next` is produced when parsing fails), but `/login` and `/logout` surface
	 * the failure -- see interactive-mode.ts:4727-4733 and :4599-4601, which already wrap these
	 * calls in try/catch and render "Failed to save API key ..." / "Logout failed: ...".
	 *
	 * The `JSON.stringify` below emits pi's flat `Record<provider, AuthCredential>`, never oracle's
	 * `{version, providers}` tagged union (auth.rs:60-70) -- see `parseStorageData` above. When the
	 * file on disk is still oracle's, `parseStorageData` imports it first, so this merge rewrites
	 * the whole store in this port's shape *with every previously stored credential included*
	 * (ED14). That conversion is the only thing that ever changes the file's shape, it happens only
	 * on a write the user asked for (`/login`, `/logout`, an OAuth refresh), and it is one-way.
	 */
	private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
		if (this.loadError) {
			const error = new Error(`load auth store: ${this.loadError.message}`);
			this.recordError(error);
			throw error;
		}

		try {
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
			throw error;
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * Set credential for a provider. Throws if the change cannot be persisted.
	 *
	 * pie: commands.rs:1998-2011 (`save_api_key`) mutates the store only *after* `AuthStore::load()`
	 * succeeds, so a load failure leaves nothing changed anywhere. Persisting before touching
	 * `this.data` reproduces that: a caller that sees the throw is not left with an in-memory
	 * credential that will vanish on restart.
	 */
	set(provider: string, credential: AuthCredential): void {
		this.persistProviderChange(provider, credential);
		this.data[provider] = credential;
	}

	/**
	 * Remove credential for a provider. Throws if the change cannot be persisted.
	 * pie: commands.rs:2032-2047 (`/logout`) -- same load-then-mutate order as `set`.
	 */
	remove(provider: string): void {
		this.persistProviderChange(provider, undefined);
		delete this.data[provider];
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		if (this.data[provider]) {
			return { configured: true, source: "stored" };
		}

		if (this.runtimeOverrides.has(provider)) {
			return { configured: false, source: "runtime", label: "--api-key" };
		}

		const envKeys = findEnvKeys(provider);
		if (envKeys?.[0]) {
			return { configured: false, source: "environment", label: envKeys[0] };
		}

		if (this.fallbackResolver?.(provider)) {
			return { configured: false, source: "fallback", label: "custom provider config" };
		}

		return { configured: false };
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * The error from the most recent failed load of the credential store, or `undefined` if the
	 * store loaded cleanly.
	 *
	 * Non-destructive and load-specific, unlike {@link drainErrors} (which empties its buffer on
	 * read and mixes in persist/refresh failures). This is the accessor to use for oracle's
	 * `AuthStore::load()?` error paths -- pie: crates/coding-agent/src/mcp_loader.rs:319-320 and
	 * commands.rs:1998-2000, where a store that will not load must abort the operation with an
	 * error rather than be treated as an empty store.
	 *
	 * Semantics, matching oracle's `AuthStore::load_from` (auth.rs:78-88):
	 *  - a missing file, an empty file, and a whitespace-only file are NOT errors -- they load as
	 *    an empty store and this returns `undefined`;
	 *  - only a genuine read/parse failure sets it;
	 *  - it is state, not a queue: repeated calls return the same value, and it is cleared by the
	 *    next successful {@link reload} (or successful locked OAuth refresh).
	 *
	 * It is the same latched value `set`/`remove` consult before persisting: while this returns an
	 * error those calls throw rather than silently no-op, so callers see one consistent story.
	 */
	getLoadError(): Error | undefined {
		return this.loadError ?? undefined;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const result = await this.storage.withLockAsync(async (current) => {
			const currentData = this.parseStorageData(current);
			this.data = currentData;
			this.loadError = null;

			const cred = currentData[providerId];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			// A refresh replaces the token, not the credential's provenance: `rustPieFields` (ED14)
			// is re-attached because the OAuth provider builds `newCredentials` from scratch and
			// this write is exactly the "next write" that would otherwise drop an imported field.
			const merged: AuthStorageData = {
				...currentData,
				[providerId]: {
					type: "oauth",
					...refreshed.newCredentials,
					...(cred.rustPieFields ? { rustPieFields: cred.rustPieFields } : {}),
				},
			};
			this.data = merged;
			this.loadError = null;
			return { result: refreshed, next: JSON.stringify(merged, null, 2) };
		});

		return result;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed with locking)
	 * 4. Environment variable
	 * 5. Fallback resolver (models.json custom providers)
	 */
	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		// pie: crates/coding-agent/src/auth.rs:129-143 (`resolve_for_provider`) -- "Env var wins;
		// auth.json is the fallback" is oracle's own doc comment, and every provider credential
		// lookup in oracle goes through it. Exporting `ANTHROPIC_API_KEY=...` to override a stale or
		// revoked stored login is the standard CLI escape hatch; this port used to resolve the stored
		// credential first, which silently disabled it.
		//
		// Gated on `findEnvKeys` rather than calling `getEnvApiKey` outright because `getEnvApiKey`
		// is broader than oracle's rule: with no env var set at all it still answers
		// `"<authenticated>"` for `google-vertex` when gcloud ADC files + project + location are
		// present (env-api-keys.ts:192-206). That sentinel is a pi-only ADC probe with no oracle
		// counterpart -- oracle reads environment variables and nothing else -- so it must not
		// outrank a stored credential. `findEnvKeys` is non-empty only when a real env var for this
		// provider is actually set, which is exactly oracle's precondition.
		//
		// Residual difference: oracle walks *every* env var name for the provider and takes the first
		// non-blank one; `getEnvApiKey` reads only the first name `findEnvKeys` reports as set (with
		// bun's `/proc/self/environ` fallback). A whitespace-only first var alongside a real second
		// var therefore falls through to auth.json here instead of to the second var.
		const envNames = findEnvKeys(providerId);
		if (envNames && envNames.length > 0) {
			const envWins = getEnvApiKey(providerId);
			// pie: auth.rs:134 (`if !v.trim().is_empty()`) -- a blank env var is not a credential.
			if (envWins && envWins.trim() !== "") return envWins;
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			return resolveConfigValue(cred.key);
		}

		if (cred?.type === "oauth") {
			const provider = getOAuthProvider(providerId);
			if (!provider) {
				// Unknown OAuth provider, can't get API key
				return undefined;
			}

			// Check if token needs refresh
			const needsRefresh = Date.now() >= cred.expires;

			if (needsRefresh) {
				// Use locked refresh to prevent race conditions
				try {
					const result = await this.refreshOAuthTokenWithLock(providerId);
					if (result) {
						return result.apiKey;
					}
				} catch (error) {
					this.recordError(error);
					// Refresh failed - re-read file to check if another instance succeeded
					this.reload();
					const updatedCred = this.data[providerId];

					if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
						// Another instance refreshed successfully, use those credentials
						return provider.getApiKey(updatedCred);
					}

					// Refresh truly failed - return undefined so model discovery skips this provider
					// User can /login to re-authenticate (credentials preserved for retry)
					return undefined;
				}
			} else {
				// Token not expired, use current access token
				return provider.getApiKey(cred);
			}
		}

		// Second `getEnvApiKey` call, reachable only when NO env var for this provider is set: it is
		// here for the pi-only surfaces oracle has no counterpart for -- today the `google-vertex`
		// `"<authenticated>"` ADC sentinel (env-api-keys.ts:192-206). Oracle's env-var rule itself
		// already ran above, ahead of the stored credential; these extras stay behind it, since a
		// stored `/login` must beat an ambient gcloud ADC config.
		const envKey = getEnvApiKey(providerId);
		if (envKey) return envKey;

		// Fall back to custom resolver (e.g., models.json custom providers)
		if (options?.includeFallback !== false) {
			return this.fallbackResolver?.(providerId) ?? undefined;
		}

		return undefined;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}
