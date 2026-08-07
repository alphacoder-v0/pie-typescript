import { accessSync, constants, existsSync, readFileSync, realpathSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep, win32 } from "path";
import { parse as parseToml } from "smol-toml";
import { fileURLToPath } from "url";
import { spawnProcessSync } from "./utils/child-process.ts";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

interface SelfUpdateCommandStep {
	command: string;
	args: string[];
	display: string;
}

export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	steps?: SelfUpdateCommandStep[];
}

function makeSelfUpdateCommand(
	installStep: SelfUpdateCommandStep,
	uninstallStep?: SelfUpdateCommandStep,
): SelfUpdateCommand {
	if (!uninstallStep) return installStep;
	return {
		...installStep,
		display: `${uninstallStep.display} && ${installStep.display}`,
		steps: [uninstallStep, installStep],
	};
}

function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	return {
		command,
		args,
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
	const packageDir = getPackageDir();
	const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
	const parent = path.dirname(packageDir);
	let root: string | undefined;
	if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
		root = path.dirname(parent);
	} else if (path.basename(parent) === "node_modules") {
		root = parent;
	}
	if (!root) return undefined;
	const rootParent = path.dirname(root);
	if (path.basename(rootParent) === "lib") return { root, prefix: path.dirname(rootParent) };
	// Windows global npm prefixes use `<prefix>\\node_modules`, which is
	// indistinguishable from local project installs by path shape alone. Do not
	// infer unsupported Windows custom prefixes without `npm root -g` evidence.
	return undefined;
}

function getSelfUpdateCommandForMethod(
	method: InstallMethod,
	installedPackageName: string,
	updatePackageName = installedPackageName,
	npmCommand?: string[],
): SelfUpdateCommand | undefined {
	switch (method) {
		case "bun-binary":
			return undefined;
		case "pnpm":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("pnpm", ["install", "-g", "--ignore-scripts", updatePackageName]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("pnpm", ["remove", "-g", installedPackageName]),
			);
		case "yarn":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("yarn", ["global", "add", "--ignore-scripts", updatePackageName]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
			);
		case "bun":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("bun", ["install", "-g", "--ignore-scripts", updatePackageName]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
			);
		case "npm": {
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
			const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
			const installStep = makeSelfUpdateCommandStep(command, [
				...prefixArgs,
				"install",
				"-g",
				"--ignore-scripts",
				updatePackageName,
			]);
			const uninstallStep =
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
			return makeSelfUpdateCommand(installStep, uninstallStep);
		}
		case "unknown":
			return undefined;
	}
}

function readCommandOutput(
	command: string,
	args: string[],
	options: { requireSuccess?: boolean } = {},
): string | undefined {
	const result = spawnProcessSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status === 0) return result.stdout.trim() || undefined;
	if (options.requireSuccess) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
	}
	return undefined;
}

function getGlobalPackageRoots(method: InstallMethod, _packageName: string, npmCommand?: string[]): string[] {
	switch (method) {
		case "npm": {
			const configured = !!npmCommand?.length;
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			if (configured && command === "bun") {
				const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
					requireSuccess: true,
				});
				const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
				if (bunBin) {
					roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
				}
				return roots;
			}
			const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
				requireSuccess: configured,
			});
			const inferred = configured ? undefined : getInferredNpmInstall();
			return [root, inferred?.root].filter((x): x is string => !!x);
		}
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			return root ? [root, dirname(root)] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "unknown":
			return [];
	}
}

function normalizeExistingPathForComparison(path: string, resolveSymlinks: boolean): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath = resolvedPath;
	if (resolveSymlinks) {
		try {
			normalizedPath = realpathSync(resolvedPath);
		} catch {
			return undefined;
		}
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

function getPathComparisonCandidates(path: string): string[] {
	return Array.from(
		new Set(
			[normalizeExistingPathForComparison(path, false), normalizeExistingPathForComparison(path, true)].filter(
				(candidate): candidate is string => !!candidate,
			),
		),
	);
}

function getEntrypointPackageDir(): string | undefined {
	const entrypoint = process.argv[1];
	if (!entrypoint) return undefined;
	let dir = dirname(entrypoint);
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return undefined;
}

function isSelfUpdatePathWritable(): boolean {
	const packageDir = getPackageDir();
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function isManagedByGlobalPackageManager(method: InstallMethod, packageName: string, npmCommand?: string[]): boolean {
	const packageDirs = [getPackageDir(), getEntrypointPackageDir()].filter((dir): dir is string => !!dir);
	const packageDirCandidates = packageDirs.flatMap((dir) => getPathComparisonCandidates(dir));
	return getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
		return getPathComparisonCandidates(root).some((normalizedRoot) => {
			const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
			return packageDirCandidates.some((packageDir) => packageDir.startsWith(rootPrefix));
		});
	});
}

export function getSelfUpdateCommand(
	packageName: string,
	npmCommand?: string[],
	updatePackageName = packageName,
): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageName, npmCommand);
	if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
		return undefined;
	}
	return command;
}

export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updatePackageName = packageName,
): string {
	const method = detectInstallMethod();
	if (method === "bun-binary") {
		return `Download from: https://github.com/earendil-works/pi-mono/releases/latest`;
	}
	const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageName, npmCommand);
	if (command) {
		if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
			return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
		}
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${updatePackageName} using the package manager, wrapper, or source checkout that provides this installation.`;
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (command) {
		return `Run: ${command.display}`;
	}
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;

const piConfigName: string | undefined = pkg.piConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@pie/coding-agent";
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pie";
export const VERSION: string = pkg.version || "0.0.0";

// e.g., PI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

export function expandTildePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return homedir() + path.slice(1);
	return path;
}

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.pie/*)
// =============================================================================

/**
 * Environment variable oracle uses to override the whole base directory (highest priority).
 * pie: crates/coding-agent/src/config.rs:10-17 `base_dir()` — `${PIE_DIR:-$HOME/.pie}`. This is
 * independent from `ENV_AGENT_DIR` below, which is a pi-only additive override kept for backward
 * compatibility (derived from `APP_NAME`, e.g. `PI_CODING_AGENT_DIR`).
 */
export const ENV_BASE_DIR = "PIE_DIR";

/** Get the agent config directory (e.g., ~/.pie/) */
export function getAgentDir(): string {
	const baseDirOverride = process.env[ENV_BASE_DIR];
	if (baseDirOverride) {
		// Taken verbatim, no tilde expansion: oracle is `PathBuf::from(p)`, and a shell that does
		// not expand `~` (or a quoted value) leaves it literal there too. The pi-only overrides
		// below keep their historical expandTildePath behaviour.
		// pie: crates/coding-agent/src/config.rs:10-17 (`base_dir`).
		return baseDirOverride;
	}
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME);
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/**
 * Get path to the cross-session memory directory. Global (not per-cwd) -- that's the whole
 * point of cross-session memory.
 * pie: crates/coding-agent/src/config.rs:27-29 (`memory_dir`).
 */
export function getMemoryDir(): string {
	return join(getAgentDir(), "memory");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}

/** Get path to `~/.pie/config.toml`. pie: crates/coding-agent/src/config.rs:80 (`relay_base_url`). */
export function getConfigTomlPath(): string {
	return join(getAgentDir(), "config.toml");
}

// =============================================================================
// config.toml — [triggers] / [relay] sections
// pie: crates/coding-agent/src/config.rs:40-88. smol-toml is the RULEBOOK §1 whitelisted TOML
// parser; `Result<T, String>` -> throw (RULEBOOK §2.4).
// =============================================================================

interface TriggersConfigSection {
	poll_interval_secs?: unknown;
}

interface RelayConfigSection {
	base_url?: unknown;
}

interface ConfigFileShape {
	triggers?: TriggersConfigSection;
	relay?: RelayConfigSection;
}

/** serde's `Unexpected` wording, for the `invalid type: ...` errors reproduced below. */
function tomlUnexpected(value: unknown): string {
	if (typeof value === "string") return `string ${JSON.stringify(value)}`;
	if (typeof value === "bigint") return `integer \`${value}\``;
	if (typeof value === "number") {
		return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
	}
	if (typeof value === "boolean") return `boolean \`${value}\``;
	if (Array.isArray(value)) return "sequence";
	if (value instanceof Date) return "datetime";
	return "map";
}

/**
 * Oracle declares both sections as `Option<Section>` structs, so a scalar (or array) sitting in a
 * table position is a hard deserialization error, not an absent section. Reading through it with
 * `parsed.relay?.base_url` would silently fall back to the default instead.
 * pie: crates/coding-agent/src/config.rs:90-99 (`ConfigFile`, `RelayConfigSection`,
 * `TriggerConfigSection`).
 */
function requireTableSection(value: unknown, structName: string): void {
	if (value === undefined) return;
	if (typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)) return;
	throw new Error(`parse config.toml: invalid type: ${tomlUnexpected(value)}, expected struct ${structName}`);
}

/**
 * Whole-document read shared by both readers, mirroring oracle's single `ConfigFile` struct.
 *
 * `integersAsBigInt: "asNeeded"` is load-bearing: smol-toml otherwise rejects *any* integer
 * outside JS's safe range with "integer value cannot be represented losslessly" and fails the
 * entire document, so an unrelated `[foo] max = 9223372036854775807` -- legal TOML, a plain i64
 * for oracle's `toml` crate, and in a section neither reader looks at -- would take the whole
 * config read down with it. Oracle documents the opposite contract in so many words: "Unknown
 * sections and keys are ignored so feature-specific readers can coexist" (config.rs:42-46, 64-66).
 * With the option on, out-of-range integers surface as `bigint` values and genuinely malformed
 * TOML still throws `parse config.toml: ...`.
 */
function parseConfigFileToml(tomlText: string): ConfigFileShape {
	let parsed: ConfigFileShape;
	try {
		parsed = parseToml(tomlText, { integersAsBigInt: "asNeeded" }) as unknown as ConfigFileShape;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`parse config.toml: ${message}`);
	}
	requireTableSection(parsed.triggers, "TriggerConfigSection");
	requireTableSection(parsed.relay, "RelayConfigSection");
	return parsed;
}

/**
 * Parse the `[triggers] poll_interval_secs = N` setting from `config.toml` text. Unknown
 * sections and keys are ignored so feature-specific readers can coexist while the config
 * surface is still small.
 * pie: crates/coding-agent/src/config.rs:44-57 (`parse_trigger_poll_interval_secs`).
 */
export function parseTriggerPollIntervalSecs(tomlText: string): number | undefined {
	const parsed = parseConfigFileToml(tomlText);
	const secs = parsed.triggers?.poll_interval_secs;
	if (secs === undefined) return undefined;
	// TODO(port): config.rs:44-57 -- oracle's field is `Option<u64>`, so a value above
	// Number.MAX_SAFE_INTEGER parses fine there (it arrives here as a `bigint`) while JS cannot
	// carry it losslessly. Rejecting loudly is the conservative choice over silently rounding.
	if (typeof secs !== "number" || !Number.isInteger(secs) || secs < 0) {
		throw new Error("parse config.toml: `poll_interval_secs` must be a non-negative integer");
	}
	if (secs === 0) {
		throw new Error("`[triggers] poll_interval_secs` must be at least 1");
	}
	return secs;
}

/**
 * Default public relay endpoint for `/web-connect` (issue #22). Override with `[relay] base_url`
 * in `~/.pie/config.toml` (e.g. a wrangler dev instance).
 * pie: crates/coding-agent/src/config.rs:59-61.
 */
export const DEFAULT_RELAY_BASE_URL = "https://pie.0xfefe.me";

/**
 * Parse `[relay] base_url` from config.toml text. Returns the default when absent.
 * pie: crates/coding-agent/src/config.rs:63-75 (`parse_relay_base_url`).
 */
export function parseRelayBaseUrl(tomlText: string): string {
	const parsed = parseConfigFileToml(tomlText);
	const url = parsed.relay?.base_url;
	if (url === undefined) return DEFAULT_RELAY_BASE_URL;
	if (typeof url !== "string") {
		throw new Error("parse config.toml: `[relay] base_url` must be a string");
	}
	const trimmed = url.trim().replace(/\/+$/, "");
	if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
		throw new Error("`[relay] base_url` must start with http(s)://");
	}
	return trimmed;
}

/**
 * Read the relay base URL from `<base_dir>/config.toml`, falling back to the default on a
 * missing file. Parse errors are thrown so the command can surface them.
 * pie: crates/coding-agent/src/config.rs:77-88 (`relay_base_url`).
 */
export async function relayBaseUrl(): Promise<string> {
	const path = getConfigTomlPath();
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return DEFAULT_RELAY_BASE_URL;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`read ${path}: ${message}`);
	}
	// Parse errors propagate as-is (not wrapped in "read ...:") -- only the read I/O step gets
	// that wrapper, matching oracle's match arms (config.rs:79-88).
	return parseRelayBaseUrl(text);
}
