import { parse } from "yaml";
import { type ExecutionEnv, type PromptTemplate, type Result, toError } from "./types.ts";

export type PromptTemplateDiagnosticCode = "file_info_failed" | "list_failed" | "read_failed" | "parse_failed";

/** Warning produced while loading prompt templates. */
export interface PromptTemplateDiagnostic {
	/** Diagnostic severity. Currently only warnings are emitted. */
	type: "warning";
	/** Stable diagnostic code. */
	code: PromptTemplateDiagnosticCode;
	/** Human-readable diagnostic message. */
	message: string;
	/** Path associated with the diagnostic. */
	path: string;
}

interface PromptTemplateFrontmatter {
	name?: string;
	description?: string;
	"argument-hint"?: string;
	[key: string]: unknown;
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// PromptTemplateRegistry -- in-memory lookup + `{{var}}` interpolation.
//
// pie: prompt_templates.rs:18-51 this class had no TS counterpart at all; the harness (wired in
// `agent_harness.rs`, out of scope for this unit) looks templates up by name and interpolates
// named `{{var}}` placeholders through this exact API. It is a DIFFERENT mechanism from
// `formatPromptTemplateInvocation`/`substituteArgs` below (bash-style positional `$1`/`$@`
// substitution), which is the pi skeleton's own pre-existing, separately-used API (still called
// by `agent-harness.ts`) and is kept as-is.
// ──────────────────────────────────────────────────────────────────────────────────────────

export class PromptTemplateRegistry {
	private readonly templates: PromptTemplate[];

	constructor(templates: PromptTemplate[]) {
		this.templates = templates;
	}

	list(): readonly PromptTemplate[] {
		return this.templates;
	}

	get(name: string): PromptTemplate | undefined {
		return this.templates.find((t) => t.name === name);
	}

	/** Interpolate `{{var}}` placeholders. Missing keys leave the placeholder verbatim. */
	static interpolate(template: PromptTemplate, vars: Record<string, unknown>): string {
		let out = template.content;
		for (const [key, value] of Object.entries(vars)) {
			const needle = `{{${key}}}`;
			// pie: prompt_templates.rs:43-46 non-string values are rendered via `Value::to_string()`,
			// which for `serde_json::Value` is its compact JSON text (numbers/booleans/null render as
			// their JSON literal; `JSON.stringify` matches that for the same JSON-ish value shapes).
			const rendered = typeof value === "string" ? value : JSON.stringify(value);
			out = out.split(needle).join(rendered);
		}
		return out;
	}
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// File loader
// ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Load prompt templates from one or more directories.
 *
 * Loads direct `.md` children of each directory, non-recursively. Missing directories are skipped without a diagnostic;
 * other filesystem failures are returned as diagnostics.
 */
export async function loadPromptTemplates(
	env: ExecutionEnv,
	dirs: string | string[],
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
	const promptTemplates: PromptTemplate[] = [];
	const diagnostics: PromptTemplateDiagnostic[] = [];
	for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
		const infoResult = await env.fileInfo(dir);
		if (!infoResult.ok) {
			if (infoResult.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: infoResult.error.message,
					path: dir,
				});
			}
			continue;
		}
		const info = infoResult.value;
		// pie: prompt_templates.rs:74-96 -- unlike skills.rs, the oracle loader never resolves
		// symlinks (no `resolve_kind`-equivalent call anywhere in this file) and only ever
		// accepts DIRECTORY inputs (the parameter is literally named `dirs`); a bare file path,
		// or a symlink to one, is silently skipped (no diagnostic), matching the raw
		// `!matches!(info.kind, FileKind::Directory)` check below.
		if (info.kind !== "directory") continue;
		const result = await loadTemplatesFromDir(env, info.path);
		promptTemplates.push(...result.promptTemplates);
		diagnostics.push(...result.diagnostics);
	}
	return { promptTemplates, diagnostics };
}

/**
 * Load prompt templates from source-tagged directories.
 *
 * Source values are preserved exactly and attached to every loaded prompt template and diagnostic. The agent package does
 * not interpret source values; applications define their own provenance shape.
 */
export async function loadSourcedPromptTemplates<TSource, TPromptTemplate extends PromptTemplate = PromptTemplate>(
	env: ExecutionEnv,
	inputs: Array<{ path: string; source: TSource }>,
	mapPromptTemplate?: (promptTemplate: PromptTemplate, source: TSource) => TPromptTemplate,
): Promise<{
	promptTemplates: Array<{ promptTemplate: TPromptTemplate; source: TSource }>;
	diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }>;
}> {
	const promptTemplates: Array<{ promptTemplate: TPromptTemplate; source: TSource }> = [];
	const diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }> = [];
	for (const input of inputs) {
		const result = await loadPromptTemplates(env, input.path);
		for (const promptTemplate of result.promptTemplates) {
			promptTemplates.push({
				promptTemplate: mapPromptTemplate
					? mapPromptTemplate(promptTemplate, input.source)
					: (promptTemplate as TPromptTemplate),
				source: input.source,
			});
		}
		for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, source: input.source });
	}
	return { promptTemplates, diagnostics };
}

async function loadTemplatesFromDir(
	env: ExecutionEnv,
	dir: string,
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
	const promptTemplates: PromptTemplate[] = [];
	const diagnostics: PromptTemplateDiagnostic[] = [];
	const entriesResult = await env.listDir(dir);
	if (!entriesResult.ok) {
		diagnostics.push({
			type: "warning",
			code: "list_failed",
			message: entriesResult.error.message,
			path: dir,
		});
		return { promptTemplates, diagnostics };
	}
	const entries = entriesResult.value;

	// pie: prompt_templates.rs:108-114 -- entries are NOT sorted; the oracle loop iterates raw
	// `list_dir` order (no `.sort_by` call anywhere in `load_templates`), and each entry's kind
	// is checked directly (`matches!(entry.kind, FileKind::File)`) without symlink resolution.
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (entry.kind !== "file") continue;
		const result = await loadTemplateFromFile(env, entry.path);
		if (result.promptTemplate) promptTemplates.push(result.promptTemplate);
		diagnostics.push(...result.diagnostics);
	}
	return { promptTemplates, diagnostics };
}

async function loadTemplateFromFile(
	env: ExecutionEnv,
	filePath: string,
): Promise<{ promptTemplate: PromptTemplate | null; diagnostics: PromptTemplateDiagnostic[] }> {
	const diagnostics: PromptTemplateDiagnostic[] = [];
	const rawContent = await env.readTextFile(filePath);
	if (!rawContent.ok) {
		diagnostics.push({
			type: "warning",
			code: "read_failed",
			message: rawContent.error.message,
			path: filePath,
		});
		return { promptTemplate: null, diagnostics };
	}

	const parsed = parseFrontmatter<PromptTemplateFrontmatter>(rawContent.value);
	if (!parsed.ok) {
		diagnostics.push({
			type: "warning",
			code: "parse_failed",
			message: parsed.error.message,
			path: filePath,
		});
		return { promptTemplate: null, diagnostics };
	}

	const { frontmatter, body } = parsed.value;
	// pie: prompt_templates.rs:137-148 -- `name` prefers frontmatter (only when the key is
	// ABSENT, not merely falsy, does it fall back to the file stem) and `description` is a
	// plain passthrough of the frontmatter value -- no "derive from body's first line" heuristic
	// exists in oracle (that heuristic was TS-only and is removed here).
	const stem = basenameEnvPath(filePath).replace(/\.md$/i, "");
	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName !== undefined ? frontmatterName : stem;
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;

	return {
		promptTemplate: {
			name,
			description,
			content: body,
			filePath,
		},
		diagnostics,
	};
}

function parseFrontmatter<T extends Record<string, unknown>>(
	content: string,
): Result<{ frontmatter: T; body: string }, Error> {
	try {
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (!normalized.startsWith("---")) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const endIndex = normalized.indexOf("\n---", 3);
		if (endIndex === -1) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const yamlString = normalized.slice(4, endIndex);
		const body = normalized.slice(endIndex + 4).trim();
		return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}) as T, body } };
	} catch (error) {
		return { ok: false, error: toError(error) };
	}
}

function basenameEnvPath(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

/** Parse an argument string using simple shell-style single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

/** Substitute prompt template placeholders (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`) with command arguments. */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;
	result = result.replace(/\$(\d+)/g, (_, num: string) => args[parseInt(num, 10) - 1] ?? "");
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr: string, lengthStr?: string) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
		return args.slice(start).join(" ");
	});
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}

/** Format a prompt template invocation with positional arguments. */
export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[] = []): string {
	return substituteArgs(template.content, args);
}
