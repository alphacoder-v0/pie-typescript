/**
 * Project trust store — the gate that decides whether a project-local `.pie/` config file may be
 * read at all.
 *
 * PORT-DIVERGENCE: B5 / B13 (RULEBOOK §5; oracle `crates/coding-agent/src/mcp_loader.rs:98-139,
 * 239-253` and `crates/coding-agent/src/lsp_supervisor.rs:76-103`). This module has **no oracle
 * counterpart** — oracle reads `<cwd>/.pie/mcp.toml` and `<cwd>/.pie/lsp.toml` unconditionally,
 * spawns the commands they name (eagerly for MCP stdio servers, lazily on the first matching
 * write/edit for LSP), and lets a project entry silently replace a same-named user entry. Cloning
 * an untrusted repository and merely opening it — or merely editing a file in it — therefore runs
 * arbitrary commands from a file inside that repository. Phase 18 deliberately diverges: default
 * deny, explicit allow.
 *
 * Design (deterministic, never interactive — this binary has to work headless and inside the
 * parity harness, so a confirmation prompt is not an option):
 *
 *  1. A project-local config is not read at all unless its directory is trusted.
 *  2. Trust is granted by any of:
 *     - a persisted entry in `~/.pie/trust.json` (same `~/.pie/` root as `auth.json`, resolved
 *       through `getAgentDir()` so `PIE_DIR`/`PI_CODING_AGENT_DIR` overrides apply);
 *     - `pie --trust-project`, which records that entry for the current directory and takes
 *       effect immediately for the same run (see `main.ts`);
 *     - `PIE_TRUST_PROJECT=1` (or case-insensitive `true`) in the environment — the CI/headless
 *       escape hatch, run-scoped only, never persisted. Value parsing matches `hooks.ts`'s
 *       `PIE_ALLOW_PROJECT_HOOKS` exactly.
 *  3. An existing-but-untrusted project config is skipped with one short stderr notice. Silence
 *     would be worse than the original bug: the user must learn that a config was ignored.
 *  4. Trusting a project does NOT restore oracle's silent override. A trusted project entry still
 *     wins over a same-named user entry (that is the point of a project override), but the
 *     substitution is announced on stderr — see {@link noteProjectEntryOverride}.
 *  5. Trust keys on the **resolved** (symlink-followed) absolute directory path, so a symlink
 *     farm cannot launder an untrusted directory into a trusted one.
 *  6. The gate is about *project* config. When `<cwd>/.pie` resolves to the **user config
 *     directory itself** — running `pie` from `$HOME`, or from whatever `PIE_DIR`'s parent is —
 *     there is no project config in play at all, only the user's own, which every loader reads
 *     unconditionally at user scope. The gate must not fire there: see
 *     {@link projectConfigDirIsUserConfigDir}.
 *
 * Every notice goes to **stderr**, never stdout: stdout is the machine-readable surface
 * (`--print`, `--mode json`, and the byte-compared parity scenarios).
 *
 * Read paths are strictly side-effect free — `isProjectTrusted` never creates `~/.pie/` and never
 * creates `trust.json`. Parity scenario S7 snapshots the entire `$HOME/.pie` file tree, so a store
 * that materialized itself on read would show up as a divergence.
 */

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";

/** Literal env var name, not derived from `APP_NAME` — same posture as `config.ts`'s
 * `ENV_BASE_DIR = "PIE_DIR"` and `hooks.ts`'s `ENV_ALLOW_PROJECT_HOOKS`. */
export const ENV_TRUST_PROJECT = "PIE_TRUST_PROJECT";

/** The CLI spelling that grants + records trust. Parsed in `main.ts` (ahead of `parseArgs`) so
 * `cli/args.ts` and the byte-exact `--help` page stay untouched. */
export const FLAG_TRUST_PROJECT = "--trust-project";

/** `~/.pie/trust.json`. */
export const TRUST_STORE_FILENAME = "trust.json";

/** Current on-disk schema version of `trust.json`. */
export const TRUST_STORE_VERSION = 1;

interface TrustEntry {
	/** ISO-8601 timestamp of the moment trust was granted. Informational only. */
	trustedAt: string;
}

interface TrustStoreFile {
	version: number;
	/** Keyed by resolved absolute project directory path. */
	projects: Record<string, TrustEntry>;
}

/**
 * Run-scoped trust, populated only when persisting failed (read-only `$HOME`, full disk, …).
 * `--trust-project` must still allow the current run in that case; it just cannot remember the
 * decision for next time.
 */
const runScopedTrust = new Set<string>();

/** Test-only: drop run-scoped trust so one test's fallback grant cannot leak into the next. */
export function resetRunScopedTrustForTesting(): void {
	runScopedTrust.clear();
}

export function getTrustStorePath(): string {
	return join(getAgentDir(), TRUST_STORE_FILENAME);
}

/**
 * The key a trust decision is recorded under: the absolute, symlink-resolved directory path.
 * Falls back to a plain `resolve()` when the path cannot be realpath'd (it may not exist yet);
 * an unresolvable path simply never matches a resolved stored key, which fails closed.
 */
export function resolveProjectKey(cwd: string): string {
	return resolveRealPath(cwd);
}

/** Absolute + symlink-followed, falling back to a plain `resolve()` for paths that do not exist
 * yet. The single primitive behind both {@link resolveProjectKey} and the user-config-dir
 * comparison, so the two can never disagree about what "the same directory" means. */
function resolveRealPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

/**
 * Does `<cwd>/.pie` *resolve to the user config directory itself*? True when `pie` is run from
 * `$HOME` (or from the parent of whatever `PIE_DIR`/`PI_CODING_AGENT_DIR` names).
 *
 * When it is true there is **no project config** — the file the project loader would look at is
 * literally the same file the user loader already read. Reporting it as "untrusted project config"
 * accuses the user's own config, and the remedy that notice suggests (`pie --trust-project` in
 * `$HOME`) is worse than the complaint: it writes the home directory into a security store whose
 * entire job is to name directories whose contents may spawn processes. So the gate does not fire
 * here at all — no notice, no skip — and {@link trustProject} refuses to record such a grant.
 *
 * The user directory comes from {@link getAgentDir} rather than being re-derived, so every
 * override path (`PIE_DIR`, `PI_CODING_AGENT_DIR`, `$HOME`) is honoured exactly once. Both sides
 * are compared as **resolved real paths**, so a symlinked `$HOME` (`/home/u` → `/real/u`) still
 * matches.
 *
 * This cannot be used to launder a hostile project: the only way for `<cwd>/.pie` to resolve onto
 * the user config directory is for it to *be* that directory, whose contents are read at user
 * scope on every run regardless of trust. Nothing new becomes readable.
 */
export function projectConfigDirIsUserConfigDir(cwd: string): boolean {
	return resolveRealPath(join(cwd, CONFIG_DIR_NAME)) === resolveRealPath(getAgentDir());
}

/** `PIE_TRUST_PROJECT=1` / `=true` (case-insensitive). Same accepted spellings as
 * `hooks.ts`'s `envAllowsProjectHooks`. */
function envTrustsProject(): boolean {
	const raw = process.env[ENV_TRUST_PROJECT];
	if (raw === undefined) return false;
	return raw === "1" || raw.toLowerCase() === "true";
}

/** Read `trust.json`. Never creates anything; any read/parse/shape failure yields an empty store
 * (fail closed — an unreadable trust store grants nothing). */
function readTrustStore(): TrustStoreFile {
	const empty: TrustStoreFile = { version: TRUST_STORE_VERSION, projects: {} };
	let text: string;
	try {
		text = readFileSync(getTrustStorePath(), "utf-8");
	} catch {
		return empty;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return empty;
	}
	if (typeof parsed !== "object" || parsed === null) return empty;
	const projects = (parsed as { projects?: unknown }).projects;
	if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return empty;
	const entries: Record<string, TrustEntry> = {};
	for (const [path, value] of Object.entries(projects as Record<string, unknown>)) {
		const trustedAt =
			typeof value === "object" && value !== null && typeof (value as TrustEntry).trustedAt === "string"
				? (value as TrustEntry).trustedAt
				: "";
		entries[path] = { trustedAt };
	}
	const version = (parsed as { version?: unknown }).version;
	return { version: typeof version === "number" ? version : TRUST_STORE_VERSION, projects: entries };
}

/**
 * Is this project directory allowed to contribute `.pie/` config? Order: env escape hatch, then
 * run-scoped grants, then the persisted store. Pure read — creates nothing.
 */
export function isProjectTrusted(cwd: string): boolean {
	if (envTrustsProject()) return true;
	const key = resolveProjectKey(cwd);
	if (runScopedTrust.has(key)) return true;
	return Object.hasOwn(readTrustStore().projects, key);
}

export interface TrustProjectResult {
	/** The resolved key the decision was recorded under. */
	path: string;
	/** `false` when the store could not be written, or when the grant was refused outright. */
	persisted: boolean;
	/** Present iff persisting was attempted and failed. */
	error?: string;
	/** Present iff the grant was **refused**: nothing was written, nothing was granted, and this
	 * string says why. Refusal is not a failure to report as one — see {@link trustProject}. */
	refused?: string;
}

/**
 * Grant trust to `cwd`: persist it to `~/.pie/trust.json` and make it effective immediately.
 *
 * Refuses when `cwd` is the user config directory's parent (`<cwd>/.pie` *is* `~/.pie`). Nothing
 * there is gated — the loaders read the user config unconditionally — so the grant would buy
 * nothing, and what it would cost is a security store that names the user's home directory. A
 * store read by a human months later must not contain an entry that reads "I trusted `$HOME`".
 * (Trust today is an exact-directory match, not inherited by descendants; refusing keeps it that
 * way by construction rather than by the current shape of `isProjectTrusted`.)
 *
 * Read-modify-write without a lock. A concurrent grant of a *different* directory can lose one of
 * the two entries; the failure mode is "you have to run `--trust-project` again", never "a
 * directory became trusted that you did not trust". `auth.json`'s `proper-lockfile` machinery is
 * deliberately not pulled in for that trade.
 */
export function trustProject(cwd: string): TrustProjectResult {
	const key = resolveProjectKey(cwd);
	if (projectConfigDirIsUserConfigDir(cwd)) {
		return {
			path: key,
			persisted: false,
			refused: `refusing to trust ${key}: ${join(key, CONFIG_DIR_NAME)} is your own pie config directory, which pie reads on every run whether or not it is trusted. There is no project config here to allow, and recording it would name your home directory in ${getTrustStorePath()}. Run ${FLAG_TRUST_PROJECT} from inside the project you want to allow instead.`,
		};
	}
	const store = readTrustStore();
	const next: TrustStoreFile = {
		version: TRUST_STORE_VERSION,
		projects: { ...store.projects, [key]: { trustedAt: new Date().toISOString() } },
	};
	const storePath = getTrustStorePath();
	const tempPath = `${storePath}.tmp-${process.pid}`;
	try {
		// `mode` here is a best effort, not a guarantee, and phase 19's F15 is the correction:
		// `mkdirSync` applies `mode` only to directories it actually creates, and by the time trust is
		// granted `~/.pie` almost always exists already — created by whichever component ran first,
		// under the process umask. Measured on a fresh HOME under umask 002: `~/.pie` is 775 after a
		// plain `pie --tui`, and stays 775 through `--trust-project`. **The oracle binary leaves it
		// 775 too**, so this is not a port regression and the mode is deliberately left alone.
		//
		// What actually protects the store is the line below: the file is 0600 at creation, then
		// atomically renamed. It names directories whose contents are allowed to spawn processes, so
		// it must never be world-readable, not even briefly — and that holds regardless of the
		// directory's bits (verified: `trust.json` is `-rw-------` inside a 775 `~/.pie`).
		mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
		writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		renameSync(tempPath, storePath);
		return { path: key, persisted: true };
	} catch (error) {
		runScopedTrust.add(key);
		return { path: key, persisted: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Revoke a previously granted trust. Returns `false` when the directory was not trusted (or the
 * store could not be rewritten). */
export function untrustProject(cwd: string): boolean {
	const key = resolveProjectKey(cwd);
	runScopedTrust.delete(key);
	const store = readTrustStore();
	if (!Object.hasOwn(store.projects, key)) return false;
	const projects = { ...store.projects };
	delete projects[key];
	const storePath = getTrustStorePath();
	const tempPath = `${storePath}.tmp-${process.pid}`;
	try {
		// Same caveat as `trustProject`: the directory `mode` binds only on creation (F15).
		mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
		writeFileSync(tempPath, `${JSON.stringify({ version: TRUST_STORE_VERSION, projects }, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(tempPath, storePath);
		return true;
	} catch {
		return false;
	}
}

/** Every trusted directory, as stored (resolved absolute paths). */
export function listTrustedProjects(): string[] {
	return Object.keys(readTrustStore().projects);
}

/** Single stderr sink so every trust notice is emitted the same way and tests can capture one
 * channel. stdout is off limits (machine-readable surface + byte-compared parity output). */
function writeNotice(line: string): void {
	process.stderr.write(`${line}\n`);
}

/**
 * The one notice a skipped project config produces. Names the exact file that was ignored and
 * both ways to allow it. Emitted once per skipped file.
 */
export function noteUntrustedProjectConfig(configPath: string, cwd: string): void {
	writeNotice(
		`pie: ignored untrusted project config ${configPath}; run \`pie ${FLAG_TRUST_PROJECT}\` in ${resolveProjectKey(cwd)} or set ${ENV_TRUST_PROJECT}=1 to load it`,
	);
}

/**
 * Announce that a trusted project entry replaced a same-named user entry.
 *
 * Oracle performs this substitution silently (`mcp_loader.rs:107-113`, `lsp_supervisor.rs:96-102`)
 * — the user keeps believing their own `~/.pie/` server is the one running. Trust is a decision
 * about *whether* the project file is read; it is not a licence to make the swap invisible.
 * The project entry still wins (that is what a project override is for), but never quietly.
 *
 * @param file      the project file, e.g. `"mcp.toml"`
 * @param entryKind the noun for the colliding entry, e.g. `"server"` / `"language"`
 * @param name      the colliding key
 * @param userPath  the user-scope file whose entry was replaced
 */
export function noteProjectEntryOverride(file: string, entryKind: string, name: string, userPath: string): void {
	writeNotice(`pie: project ${file} ${entryKind} '${name}' overrides the same-named entry in ${userPath}`);
}
