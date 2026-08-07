/**
 * `InstallSkill` builtin tool.
 *
 * Lets the agent install a new skill into pi's user-global skills directory
 * (`<agentDir>/skills/<name>/SKILL.md`) from one of three sources: an `https://` URL, a local
 * absolute path, or inline content. Two-phase like a mutation confirmation dialog: the first
 * call (without `confirm: true`) is read-only -- fetch + parse + validate + return a bounded
 * preview (name/description/target path/hash/size/existing/overwrite_required). The skill body
 * is never echoed into the tool result. A second call with `confirm: true` (and `overwrite: true`
 * if a same-name skill already exists with different content) performs the write.
 *
 * Port of oracle `crates/coding-agent/src/tools/install_skill.rs` (pie @0a120dfd).
 *
 * pie: install_skill.rs:1-50 (module docs) -- oracle installs into `~/.pie/skills/<name>/`. This
 * port targets pi's existing canonical user-global skills directory
 * (`getAgentDir() + "/skills"`, see `../config.ts`), which `../core/skills.ts`'s `loadSkills()`
 * already treats as the "user" scope -- and, per the RULEBOOK user-dir-layout.md arbitration,
 * `getAgentDir()` now resolves to `~/.pie` itself, so this IS oracle's literal `~/.pie/skills/`,
 * not merely a redesign-equivalent location. `PIE_DIR` env var override: `getAgentDir()` checks
 * it first (highest priority, matching oracle `config.rs:11-13`), falling back to the pi-only
 * additive `PI_CODING_AGENT_DIR` (this repo's `ENV_AGENT_DIR`) for backward compatibility.
 *
 * pie: install_skill.rs:223-288 -- oracle hot-reloads a live `AgentHarness` singleton and
 * appends a persistent `Custom { custom_type: "skill_install" }` session entry for audit. Neither
 * concept exists at this layer in pi: `ToolDefinition.execute`'s `ExtensionContext`
 * (`../core/extensions/types.ts`) exposes only a **read-only** `sessionManager` and has no
 * append/write hook, and there is no long-lived harness object threaded into tool execution the
 * way oracle's `SkillHarnessCell` is. TODO(port): wiring either would mean reaching into
 * session-manager.ts / extensions-runner.ts, both outside this unit's file scope. Instead:
 *  - "hot reload" is approximated by recomputing the on-disk skill catalog immediately after the
 *    write (`reloadSkillCatalog`, below) purely to populate the tool RESULT fields
 *    (`total_skills_after`, `installed_visible_in_catalog`, diagnostics) -- it does not mutate any
 *    live running AgentSession's active tool/skill list.
 *  - the `skill_install` audit entry is not written; `audit_entry_id` is always `undefined` in the
 *    returned details.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isIPv4, isIPv6 } from "node:net";
import { join, resolve } from "node:path";
import type { AgentTool, PermissionClassification } from "@pie/agent-core";
import { type Static, Type } from "typebox";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CONFIG_DIR_NAME, getAgentDir, VERSION } from "../config.ts";
import type { ResourceDiagnostic } from "../core/diagnostics.ts";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { loadSkillsFromDir, type Skill } from "../core/skills.ts";
import { wrapToolDefinition } from "../core/tools/tool-definition-wrapper.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

// pie: install_skill.rs:76 -- OOM guard on the stream-read path, NOT a per-skill artifact cap
// (real skills can be hundreds of KiB). Applies to both the URL fetch and the local-path read.
const SKILL_FETCH_OOM_GUARD_BYTES = 16 * 1024 * 1024;
// pie: install_skill.rs:78
const HTTP_TIMEOUT_MS = 15_000;
// pie: install_skill.rs:79-80
const MAX_NAME_LEN = 64;
const MAX_DESCRIPTION_LEN = 1024;
const FALLBACK_DESCRIPTION = "No description provided.";
// pie: install_skill.rs:32-33 -- redirect(reqwest::redirect::Policy::limited(5))
const MAX_REDIRECTS = 5;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Count Unicode scalar values (matches Rust's `.chars().count()`, not UTF-16 code units). */
function charCount(s: string): number {
	return Array.from(s).length;
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Input
// ──────────────────────────────────────────────────────────────────────────────────────────

// pie: install_skill.rs:329-342 (Source enum, `#[serde(tag = "type", rename_all = "snake_case")]`,
// `#[serde(alias = "https")]` on Url)
const urlSourceSchema = Type.Object(
	{
		type: Type.Union([Type.Literal("url"), Type.Literal("https")], {
			description: 'Use "url" for HTTPS URLs. "https" is accepted as a compatibility alias.',
		}),
		url: Type.String({
			description: "https:// URL. http/file/data schemes are rejected; loopback and RFC1918 hosts are rejected.",
		}),
	},
	{ additionalProperties: false },
);

const pathSourceSchema = Type.Object(
	{
		type: Type.Literal("path"),
		path: Type.String({ description: "Absolute path to a local SKILL.md file." }),
	},
	{ additionalProperties: false },
);

const contentSourceSchema = Type.Object(
	{
		type: Type.Literal("content"),
		content: Type.String({ description: "Inline SKILL.md content (frontmatter + body)." }),
	},
	{ additionalProperties: false },
);

/**
 * Static type for `source`. The three `*SourceSchema` objects above exist only to derive this —
 * the wire schema is the hand-written literal below, because typebox renders a union as `anyOf`
 * with a `"type": "object"` on every branch and a `"type": "string"` on every `const`, none of
 * which oracle emits.
 */
type InstallSkillSourceInput = Static<typeof urlSourceSchema | typeof pathSourceSchema | typeof contentSourceSchema>;

/**
 * pie: install_skill.rs:752-810 (DEFINITION.parameters) — transcribed verbatim, including the
 * shape quirks: `source` carries BOTH `"type": "object"` and `oneOf`; no `oneOf` branch declares
 * its own `"type": "object"`; the url branch's discriminator has an `enum` but no `"type"`; and
 * the path/content discriminators are bare `{"const": ...}` with no `"type"` either.
 */
const installSkillSourceSchema = Type.Unsafe<InstallSkillSourceInput>({
	description: "Where to fetch the SKILL.md from.",
	type: "object",
	oneOf: [
		{
			additionalProperties: false,
			properties: {
				type: {
					description: 'Use "url" for HTTPS URLs. "https" is accepted as a compatibility alias.',
					enum: ["url", "https"],
				},
				url: {
					description:
						"https:// URL. http/file/data schemes are rejected; loopback and RFC1918 hosts are rejected.",
					type: "string",
				},
			},
			required: ["type", "url"],
		},
		{
			additionalProperties: false,
			properties: {
				path: { description: "Absolute path to a local SKILL.md file.", type: "string" },
				type: { const: "path" },
			},
			required: ["type", "path"],
		},
		{
			additionalProperties: false,
			properties: {
				content: { description: "Inline SKILL.md content (frontmatter + body).", type: "string" },
				type: { const: "content" },
			},
			required: ["type", "content"],
		},
	],
});

// pie: install_skill.rs:752-810 (DEFINITION.parameters, verbatim text)
const installSkillSchema = Type.Object(
	{
		source: installSkillSourceSchema,
		confirm: Type.Optional(
			Type.Boolean({
				default: false,
				description: "When false (default), returns a preview without writing. When true, performs the install.",
			}),
		),
		overwrite: Type.Optional(
			Type.Boolean({
				default: false,
				description: "Required when a skill of the same name already exists with different content.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type InstallSkillSource = Static<typeof installSkillSchema>["source"];
export type InstallSkillToolInput = Static<typeof installSkillSchema>;

// pie: install_skill.rs:197-311 -- details keys kept snake_case verbatim (full port, no base
// file style to follow; UI/log-only, never re-validated by anything downstream).
export interface InstallSkillToolDetails {
	phase: "preview" | "installed";
	name: string;
	description?: string;
	target_path: string;
	content_hash: string;
	size: number;
	existing?: boolean;
	overwrite_required?: boolean;
	overwrote?: boolean;
	total_skills_after?: number;
	diagnostics_count?: number;
	warnings: string[];
	installed_visible_in_catalog?: boolean;
	/** Always undefined -- see module docs (no session-append hook reachable from tool execute()). */
	audit_entry_id?: string;
}

export interface InstallSkillToolOptions {
	/**
	 * Root directory containing per-skill subdirectories (`<root>/<name>/SKILL.md`). Defaults to
	 * pi's canonical user-global skills directory. Tests override this to a temp dir (mirrors
	 * oracle's `InstallSkillTool::with_skills_root`).
	 */
	skillsRoot?: string;
	/** Agent config dir used to resolve the default `skillsRoot`. Defaults to `getAgentDir()`. */
	agentDir?: string;
}

// pie: install_skill.rs:110-120 (default_skills_root) -- see module docs for the ~/.pie -> pi
// agentDir mapping rationale.
export function defaultSkillsRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "skills");
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Fetch
// ──────────────────────────────────────────────────────────────────────────────────────────

interface Fetched {
	content: string;
}

/**
 * Reject hostnames that point at the loopback / private RFC1918 / link-local space. Pre-flight
 * check only (mirrors oracle: no re-validation on redirect hops either -- see fetchUrlSource).
 * pie: install_skill.rs:497-526 (is_private_or_local_host)
 */
function isPrivateOrLocalHost(hostRaw: string): boolean {
	const host = hostRaw.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
	if (host === "localhost" || host === "ip6-localhost" || host === "ip6-loopback" || host === "broadcasthost") {
		return true;
	}
	if (host.endsWith(".localhost") || host.endsWith(".local")) {
		return true;
	}
	if (isIPv4(host)) {
		const [a, b, c, d] = host.split(".").map(Number);
		if (a === 127) return true; // loopback 127.0.0.0/8
		if (a === 10) return true; // private 10.0.0.0/8
		if (a === 172 && b! >= 16 && b! <= 31) return true; // private 172.16.0.0/12
		if (a === 192 && b === 168) return true; // private 192.168.0.0/16
		if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
		if (a === 0 && b === 0 && c === 0 && d === 0) return true; // unspecified 0.0.0.0
		if (a === 255 && b === 255 && c === 255 && d === 255) return true; // broadcast
		return false;
	}
	if (isIPv6(host)) {
		if (host === "::1") return true; // loopback
		if (host === "::") return true; // unspecified
		// fc00::/7 (unique local). ULA addresses always have a non-zero first hextet, so RFC5952
		// "::" compression (which only ever elides runs of zero groups) never touches it -- reading
		// the literal first hextet before the first ':' is exact, not an approximation.
		const firstHextet = host.split(":")[0];
		if (firstHextet) {
			const val = Number.parseInt(firstHextet, 16);
			if (!Number.isNaN(val) && (val & 0xfe00) === 0xfc00) return true;
		}
		return false;
	}
	return false;
}

/** pie: install_skill.rs:389-453 (fetch_url) */
async function fetchUrlSource(rawUrl: string, signal: AbortSignal | undefined): Promise<Fetched> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch (err) {
		throw new Error(`invalid url: ${errorMessage(err)}`);
	}
	if (parsed.protocol !== "https:") {
		throw new Error("url must use https:// (http, file, data, and other schemes are refused)");
	}
	if (!parsed.hostname) {
		throw new Error("url must have a host");
	}
	if (isPrivateOrLocalHost(parsed.hostname)) {
		throw new Error(`refusing to fetch from local/private host '${parsed.hostname}' (SSRF guard)`);
	}

	const timeoutSignal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const headers = { "user-agent": getPiUserAgent(VERSION) };

	let currentUrl = parsed.toString();
	let response: Response;
	for (let redirectCount = 0; ; redirectCount++) {
		let resp: Response;
		try {
			resp = await fetch(currentUrl, { signal: combinedSignal, redirect: "manual", headers });
		} catch (err) {
			if (signal?.aborted) throw new Error("cancelled");
			throw new Error(`fetch failed: ${errorMessage(err)}`);
		}
		const location = resp.headers.get("location");
		if (resp.status >= 300 && resp.status < 400 && location) {
			if (redirectCount >= MAX_REDIRECTS) {
				throw new Error(`fetch failed: too many redirects (max ${MAX_REDIRECTS})`);
			}
			currentUrl = new URL(location, currentUrl).toString();
			continue;
		}
		response = resp;
		break;
	}
	if (!response.ok) {
		throw new Error(`fetch returned non-success status: ${response.status}`);
	}

	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	if (reader) {
		for (;;) {
			let result: Awaited<ReturnType<typeof reader.read>>;
			try {
				result = await reader.read();
			} catch (err) {
				if (signal?.aborted) throw new Error("cancelled");
				throw new Error(`read body: ${errorMessage(err)}`);
			}
			if (result.done) break;
			if (total + result.value.byteLength > SKILL_FETCH_OOM_GUARD_BYTES) {
				throw new Error(
					`fetched skill body exceeds ${SKILL_FETCH_OOM_GUARD_BYTES}-byte in-memory guard ` +
						`(${total} bytes received so far); refusing to install from a stream this large`,
				);
			}
			total += result.value.byteLength;
			chunks.push(result.value);
		}
	}
	const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
	try {
		return { content: new TextDecoder("utf-8", { fatal: true }).decode(buf) };
	} catch (err) {
		throw new Error(`skill body is not valid utf-8: ${errorMessage(err)}`);
	}
}

/**
 * pie: install_skill.rs:455-485 (fetch_path) -- NOT cancellation-aware in oracle (no
 * `tokio::select!` here, unlike fetch_url). Preserved bug-for-bug: `signal` is intentionally
 * not threaded into the fs calls below.
 */
async function fetchPathSource(path: string): Promise<Fetched> {
	if (!path.startsWith("/")) {
		throw new Error("path must be absolute (relative paths are ambiguous in agent context)");
	}
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(path);
	} catch (err) {
		throw new Error(`stat ${path}: ${errorMessage(err)}`);
	}
	if (!info.isFile()) {
		throw new Error(`${path} is not a regular file`);
	}
	if (info.size > SKILL_FETCH_OOM_GUARD_BYTES) {
		throw new Error(`${path} (${info.size} bytes) exceeds ${SKILL_FETCH_OOM_GUARD_BYTES}-byte in-memory guard`);
	}
	let buf: Buffer;
	try {
		buf = await readFile(path);
	} catch (err) {
		throw new Error(`read ${path}: ${errorMessage(err)}`);
	}
	try {
		return { content: new TextDecoder("utf-8", { fatal: true }).decode(buf) };
	} catch {
		throw new Error(`read ${path}: stream did not contain valid UTF-8`);
	}
}

async function fetchSource(source: InstallSkillSource, signal: AbortSignal | undefined): Promise<Fetched> {
	switch (source.type) {
		case "url":
		case "https":
			return fetchUrlSource(source.url, signal);
		case "path":
			return fetchPathSource(source.path);
		case "content":
			return { content: source.content };
	}
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Parse + validate
// ──────────────────────────────────────────────────────────────────────────────────────────

export interface ParsedSkill {
	name: string;
	description: string;
	normalizedContent: string;
	contentHash: string;
	size: number;
	warnings: string[];
}

/** pie: install_skill.rs:655-683 (validate_name) -- unlike `../core/skills.ts`'s validateName,
 * this does NOT check name === parent-directory-name: at install time there is no directory yet. */
function validateInstallSkillName(name: string): void {
	if (name.length === 0) {
		throw new Error("skill name must not be empty");
	}
	if (charCount(name) > MAX_NAME_LEN) {
		throw new Error(`skill name exceeds ${MAX_NAME_LEN} characters`);
	}
	if (!/^[a-z0-9-]*$/.test(name)) {
		throw new Error("skill name must contain only lowercase a-z, 0-9, and hyphens");
	}
	if (name.startsWith("-") || name.endsWith("-")) {
		throw new Error("skill name must not start or end with a hyphen");
	}
	if (name.includes("--")) {
		throw new Error("skill name must not contain consecutive hyphens");
	}
}

interface NormalizedDescription {
	description: string;
	warnings: string[];
	rewrite: boolean;
}

/** pie: install_skill.rs:598-624 (normalize_description) */
function normalizeDescription(description: string | undefined): NormalizedDescription {
	if (description === undefined) {
		return {
			description: FALLBACK_DESCRIPTION,
			warnings: ["description missing; using generated fallback"],
			rewrite: true,
		};
	}
	const trimmed = description.trim();
	if (trimmed === "") {
		return {
			description: FALLBACK_DESCRIPTION,
			warnings: ["description empty; using generated fallback"],
			rewrite: true,
		};
	}
	if (charCount(trimmed) > MAX_DESCRIPTION_LEN) {
		return {
			description: FALLBACK_DESCRIPTION,
			warnings: [`description exceeds ${MAX_DESCRIPTION_LEN} characters; using generated fallback`],
			rewrite: true,
		};
	}
	return { description: trimmed, warnings: [], rewrite: false };
}

/**
 * pie: install_skill.rs:630-653 (normalize_skill_content) -- reconstruct the document with the
 * `description` key overwritten (or appended), byte-for-byte structure matching oracle's
 * `serde_yaml`-round-trip approach (re-serialize the whole mapping, splice back into the
 * original body). JS object key insertion order mirrors `serde_yaml::Mapping`'s
 * insert-preserves-position-if-present / append-if-new behavior.
 */
function rewriteSkillDescription(normalized: string, yamlEnd: number, description: string): string {
	const yamlText = normalized.slice(4, yamlEnd);
	let frontmatter: unknown;
	try {
		frontmatter = parseYaml(yamlText) ?? {};
	} catch (err) {
		throw new Error(`invalid frontmatter yaml: ${errorMessage(err)}`);
	}
	if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
		throw new Error("skill frontmatter must be a YAML mapping");
	}
	(frontmatter as Record<string, unknown>).description = description;
	let serialized: string;
	try {
		serialized = stringifyYaml(frontmatter);
	} catch (err) {
		throw new Error(`failed to normalize frontmatter: ${errorMessage(err)}`);
	}
	const trimmedSerialized = serialized.startsWith("---\n") ? serialized.slice(4) : serialized;
	return `---\n${trimmedSerialized}${normalized.slice(yamlEnd)}`;
}

/**
 * Validate complete `SKILL.md` text (frontmatter + body) and normalize it. Shared with
 * `SkillBuilder` (`skill-builder.ts`), which renders its own content and runs it through here so
 * authored and installed skills obey identical rules.
 * pie: install_skill.rs:550-596 (parse_and_validate / parse_and_validate_skill_md)
 */
export function parseAndValidateSkillMd(content: string): ParsedSkill {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) {
		throw new Error("skill body missing YAML frontmatter (must start with `---` followed by name/description)");
	}
	const closeIdx = normalized.indexOf("\n---", 3);
	if (closeIdx === -1) {
		throw new Error("skill frontmatter missing closing `\\n---`");
	}
	const yamlText = normalized.slice(4, closeIdx);
	let frontmatter: { name?: unknown; description?: unknown };
	try {
		frontmatter = (parseYaml(yamlText) ?? {}) as { name?: unknown; description?: unknown };
	} catch (err) {
		throw new Error(`invalid frontmatter yaml: ${errorMessage(err)}`);
	}

	if (frontmatter.name !== undefined && typeof frontmatter.name !== "string") {
		throw new Error("invalid frontmatter yaml: `name` must be a string");
	}
	const name = frontmatter.name as string | undefined;
	if (name === undefined) {
		throw new Error("frontmatter missing required field: name");
	}
	validateInstallSkillName(name);

	if (frontmatter.description !== undefined && typeof frontmatter.description !== "string") {
		throw new Error("invalid frontmatter yaml: `description` must be a string");
	}
	const { description, warnings, rewrite } = normalizeDescription(frontmatter.description as string | undefined);
	const normalizedContent = rewrite ? rewriteSkillDescription(normalized, closeIdx, description) : normalized;

	const contentHash = createHash("sha256").update(normalizedContent, "utf-8").digest("hex");
	const size = Buffer.byteLength(normalizedContent, "utf-8");

	return { name, description, normalizedContent, contentHash, size, warnings };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Target path + atomic write
// ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Hash the on-disk SKILL.md bytes at `targetPath` using the same SHA256 + line-ending
 * normalization the new-content hash uses, so an idempotent re-install (same bytes already on
 * disk) does not require `overwrite: true`. Returns `undefined` if the file doesn't exist OR
 * can't be decoded as UTF-8 -- both collapse to "no existing hash", matching oracle's
 * `Option::ok()` on both the read and the `String::from_utf8` step.
 * pie: install_skill.rs:689-700 (on_disk_skill_hash)
 */
export async function onDiskSkillHash(targetPath: string): Promise<string | undefined> {
	try {
		const buf = await readFile(targetPath);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
		const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		return createHash("sha256").update(normalized, "utf-8").digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * Write to a sibling tempfile in the SAME directory so rename(2) is atomic (cross-fs rename would
 * not be), then rename over the target.
 * pie: install_skill.rs:702-735 (atomic_write_skill)
 */
export async function atomicWriteSkill(target: string, content: string): Promise<void> {
	const lastSlash = target.lastIndexOf("/");
	const parent = lastSlash > 0 ? target.slice(0, lastSlash) : undefined;
	if (!parent) {
		throw new Error("target path has no parent directory");
	}
	try {
		await mkdir(parent, { recursive: true });
	} catch (err) {
		throw new Error(`create ${parent}: ${errorMessage(err)}`);
	}

	const tmp = join(parent, `.SKILL.md.${process.pid}.${process.hrtime.bigint()}.tmp`);
	try {
		await writeFile(tmp, content, "utf-8");
	} catch (err) {
		throw new Error(`write ${tmp}: ${errorMessage(err)}`);
	}
	try {
		await rename(tmp, target);
	} catch (err) {
		try {
			await unlink(tmp);
		} catch {
			// best-effort cleanup only
		}
		throw new Error(`rename ${tmp} -> ${target}: ${errorMessage(err)}`);
	}
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Catalog snapshot (see module docs -- approximates oracle's harness hot-reload)
// ──────────────────────────────────────────────────────────────────────────────────────────

export interface SkillCatalogSnapshot {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Recompute the skill catalog by scanning `skillsRoot` (source "user") and the project skills
 * directory under `cwd` (source "project") via `../core/skills.ts`'s exported `loadSkillsFromDir`
 * -- imported, not reimplemented. Used both for pre-write shadow-collision warnings
 * (`skill-builder.ts`) and for the post-write "did it actually surface" check both tools report.
 */
export function reloadSkillCatalog(skillsRoot: string, cwd: string): SkillCatalogSnapshot {
	const user = loadSkillsFromDir({ dir: skillsRoot, source: "user" });
	const project = loadSkillsFromDir({ dir: resolve(cwd, CONFIG_DIR_NAME, "skills"), source: "project" });
	return {
		skills: [...user.skills, ...project.skills],
		diagnostics: [...user.diagnostics, ...project.diagnostics],
	};
}

/** pie: install_skill.rs:236-245 -- filter reload diagnostics down to ones relevant to this install. */
export function relevantDiagnosticWarnings(
	diagnostics: ResourceDiagnostic[],
	name: string,
	targetPath: string,
): string[] {
	return diagnostics
		.filter((d) => (d.path?.includes(name) ?? false) || d.path === targetPath)
		.map((d) => `${d.type}: ${d.message}`);
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Audit reference (redaction) -- pure, ported, currently unused pending an audit sink; see
// module docs. Kept + tested per RULEBOOK bug-for-bug posture rather than dropped.
// ──────────────────────────────────────────────────────────────────────────────────────────

/** pie: install_skill.rs:354-368 (audit_url_reference) */
export function auditUrlReference(
	url: string,
): { scheme: string; host: string; path_hash: string; redacted: true } | { redacted: true } {
	try {
		const parsed = new URL(url);
		const pathHash = createHash("sha256").update(parsed.pathname, "utf-8").digest("hex");
		return { scheme: parsed.protocol.replace(/:$/, ""), host: parsed.hostname, path_hash: pathHash, redacted: true };
	} catch {
		return { redacted: true };
	}
}

/** pie: install_skill.rs:344-352 (audit_source_reference) */
export function auditSourceReference(source: InstallSkillSource): unknown {
	switch (source.type) {
		case "url":
		case "https":
			return auditUrlReference(source.url);
		case "path":
			return source.path;
		case "content":
			return null;
	}
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Permission classification
// ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * pie: install_skill.rs:139-163 (permission_classification) -- always Prompt; the reason names
 * only a whitelisted source-kind label, never the URL/path/content itself (potentially
 * secret-bearing, e.g. tokenized URLs).
 *
 * pie: install_skill.rs:150-159 -- the `<unknown source>` fallback exists because oracle
 * classifies against a loosely-typed `serde_json::Value` BEFORE strict struct deserialization.
 * In this port, `permissionClassification` runs on already-schema-validated `Static<TParameters>`
 * args (pi's agent-loop validates before classifying -- see `packages/agent/src/agent-loop.ts`
 * `prepareToolCall`), so `source.type` is already constrained to the union's literal values on
 * every real tool-call path; the fallback branch is unreachable in production but preserved
 * verbatim (and tested via an `as` cast, matching how oracle's own test constructs a raw
 * `serde_json::Value` bypassing normal deserialization) for defense-in-depth and 1:1 parity.
 */
export function classifyInstallSkillPermission(preparedArgs: InstallSkillToolInput): PermissionClassification {
	const rawKind = (preparedArgs?.source as { type?: unknown } | undefined)?.type;
	const normalized =
		rawKind === "url" || rawKind === "https"
			? "url"
			: rawKind === "path"
				? "path"
				: rawKind === "content"
					? "content"
					: "<unknown source>";
	return { type: "prompt", reason: `install user skill from ${normalized}` };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Tool definition
// ──────────────────────────────────────────────────────────────────────────────────────────

export function createInstallSkillToolDefinition(
	cwd: string,
	options?: InstallSkillToolOptions,
): ToolDefinition<typeof installSkillSchema, InstallSkillToolDetails> {
	const agentDir = options?.agentDir ?? getAgentDir();
	const skillsRoot = options?.skillsRoot ?? defaultSkillsRoot(agentDir);

	return {
		name: "InstallSkill",
		label: "InstallSkill",
		// pie: install_skill.rs:743-751 (verbatim, "~/.pie/skills" left as-is: user-facing prose
		// describing the concept pi maps onto its own agentDir/skills location)
		description:
			"Install a new skill into the user-global skills directory (~/.pie/skills/<name>/) " +
			"and hot-reload the catalog so the next turn can use it. Two-phase: first call " +
			"without `confirm` returns a preview (name, description, target path, hash, size). " +
			"Second call with `confirm: true` writes atomically and reloads. Same-name skill " +
			"requires `overwrite: true` when the new content hash differs. Source is one of: " +
			"https URL, absolute local path, or inline content. Body is never echoed back into " +
			"the tool result — only metadata + preview info.",
		promptSnippet: "Install a new skill from a URL, local file, or inline content (two-phase confirm)",
		parameters: installSkillSchema,
		// pie: install_skill.rs:132-137
		executionMode: "sequential",
		// Declared on the definition (not only on the `AgentTool` built below) so the classifier
		// survives AgentSession's definition-first registry round trip -- see
		// `core/extensions/types.ts` `ToolDefinition.permissionClassification`.
		permissionClassification: classifyInstallSkillPermission,
		async execute(_toolCallId, { source, confirm, overwrite }, signal, _onUpdate, _ctx) {
			// Phase 1: fetch + parse + validate. Pure read; no fs writes happen here.
			const fetched = await fetchSource(source, signal);
			const parsed = parseAndValidateSkillMd(fetched.content);
			const targetPath = join(skillsRoot, parsed.name, "SKILL.md");
			const existingHash = await onDiskSkillHash(targetPath);
			const existing = existingHash !== undefined;
			const overwriteRequired = existing && existingHash !== parsed.contentHash;

			if (!confirm) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"preview only — call again with `confirm: true` to install. " +
								`name=${parsed.name} target=${targetPath} size=${parsed.size}B existing=${existing} overwrite_required=${overwriteRequired}`,
						},
					],
					details: {
						phase: "preview",
						name: parsed.name,
						description: parsed.description,
						warnings: parsed.warnings,
						target_path: targetPath,
						content_hash: parsed.contentHash,
						size: parsed.size,
						existing,
						overwrite_required: overwriteRequired,
					},
				};
			}

			// Phase 2: install. Refuse silent overwrite unless caller explicitly asked.
			if (overwriteRequired && !overwrite) {
				throw new Error(
					`skill '${parsed.name}' already exists with different content. Call again with ` +
						"`overwrite: true` to replace it (existing hash differs from new content).",
				);
			}

			await atomicWriteSkill(targetPath, parsed.normalizedContent);

			const reload = reloadSkillCatalog(skillsRoot, cwd);
			const installed = reload.skills.some((s) => s.name === parsed.name);
			const warnings = [
				...parsed.warnings,
				...relevantDiagnosticWarnings(reload.diagnostics, parsed.name, targetPath),
			];

			return {
				content: [
					{
						type: "text" as const,
						text: `installed skill '${parsed.name}' to ${targetPath} (${parsed.size}B). catalog now has ${reload.skills.length} skill(s).`,
					},
				],
				details: {
					phase: "installed",
					name: parsed.name,
					target_path: targetPath,
					content_hash: parsed.contentHash,
					size: parsed.size,
					overwrote: overwriteRequired,
					total_skills_after: reload.skills.length,
					diagnostics_count: reload.diagnostics.length,
					warnings,
					installed_visible_in_catalog: installed,
					audit_entry_id: undefined,
				},
			};
		},
	};
}

export function createInstallSkillTool(
	cwd: string,
	options?: InstallSkillToolOptions,
): AgentTool<typeof installSkillSchema, InstallSkillToolDetails> {
	const definition = createInstallSkillToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition) as AgentTool<typeof installSkillSchema, InstallSkillToolDetails>;
	return {
		...tool,
		permissionClassification: classifyInstallSkillPermission,
	};
}
