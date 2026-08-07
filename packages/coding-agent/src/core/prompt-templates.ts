import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
	name: string;
	description: string;
	argumentHint?: string;
	content: string;
	sourceInfo: SourceInfo;
	filePath: string; // Absolute path to the template file
}

/**
 * Parse command arguments respecting quoted strings (bash-style)
 * Returns array of arguments
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

/**
 * Substitute argument placeholders in template content
 * Supports:
 * - $1, $2, ... for positional args
 * - $@ and $ARGUMENTS for all args
 * - ${@:N} for args from Nth onwards (bash-style slicing)
 * - ${@:N:L} for L args starting from Nth
 *
 * Note: Replacement happens on the template string only. Argument values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	// Replace $1, $2, etc. with positional args FIRST (before wildcards)
	// This prevents wildcard replacement values containing $<digit> patterns from being re-substituted
	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	// Replace ${@:start} or ${@:start:length} with sliced args (bash-style)
	// Process BEFORE simple $@ to avoid conflicts
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
		let start = parseInt(startStr, 10) - 1; // Convert to 0-indexed (user provides 1-indexed)
		// Treat 0 as 1 (bash convention: args start at 1)
		if (start < 0) start = 0;

		if (lengthStr) {
			const length = parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}
		return args.slice(start).join(" ");
	});

	// Pre-compute all args joined (optimization)
	const allArgs = args.join(" ");

	// Replace $ARGUMENTS with all args joined (new syntax, aligns with Claude, Codex, OpenCode)
	result = result.replace(/\$ARGUMENTS/g, allArgs);

	// Replace $@ with all args joined (existing syntax)
	result = result.replace(/\$@/g, allArgs);

	return result;
}

/** Result of a template load pass: the templates plus any load-time diagnostics. */
export interface LoadedPromptTemplates {
	templates: PromptTemplate[];
	/**
	 * pie: templates.rs:11-14,23,40-43 -- oracle's `LoadedTemplates` carries the loader's
	 * diagnostics alongside the templates, and `main.rs:1001-1006` prints a startup summary line
	 * ("<n> template diagnostics: <first message>"). The pi skeleton dropped every load failure on
	 * the floor (`catch { return null }`), so a malformed template was silently invisible.
	 */
	diagnostics: ResourceDiagnostic[];
}

function loadTemplateFromFile(
	filePath: string,
	sourceInfo: SourceInfo,
): { template: PromptTemplate | null; diagnostics: ResourceDiagnostic[] } {
	let rawContent: string;
	try {
		rawContent = readFileSync(filePath, "utf-8");
	} catch (error) {
		// pie: prompt_templates.rs:111-120 -- read failure emits a `ReadFailed` diagnostic and skips
		// the file (the walk continues). Message text is the host error string on both sides.
		const message = error instanceof Error ? error.message : "failed to read prompt template";
		return { template: null, diagnostics: [{ type: "warning", message, path: filePath }] };
	}

	let frontmatter: Record<string, string>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<Record<string, string>>(rawContent));
	} catch (error) {
		// pie: prompt_templates.rs:121-131,159 -- YAML parse failure emits a `ParseFailed`
		// diagnostic (`format!("yaml: {e}")`) and skips the file rather than aborting the walk.
		const message = error instanceof Error ? error.message : "failed to parse prompt template";
		return { template: null, diagnostics: [{ type: "warning", message: `yaml: ${message}`, path: filePath }] };
	}

	// pie: prompt_templates.rs:132-138 -- oracle takes the command name from frontmatter `name`
	// and only falls back to the file stem (`frontmatter.name.unwrap_or(stem)`). The pi skeleton
	// always used the stem, so a template declaring `name:` registered under the wrong command.
	// (docs/prompt-templates.md still documents the pi-only "filename becomes the command name"
	// rule; the oracle implementation is the contract per RULEBOOK §0.)
	const stem = basename(filePath).replace(/\.md$/, "");
	const name = typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : stem;

	// Get description from frontmatter or first non-empty line.
	// pie: prompt_templates.rs:140 -- oracle stores `description: Option<String>` verbatim with no
	// first-line fallback and no truncation. The fallback/truncation below is a pi-skeleton extra
	// that only ever *adds* text where oracle would show none; kept per RULEBOOK §0 diff-port rule
	// keep the description in sync, since the autocomplete column depends on it.
	let description = frontmatter.description || "";
	if (!description) {
		const firstLine = body.split("\n").find((line) => line.trim());
		if (firstLine) {
			// Truncate if too long
			description = firstLine.slice(0, 60);
			if (firstLine.length > 60) description += "...";
		}
	}

	return {
		template: {
			name,
			description,
			...(frontmatter["argument-hint"] && { argumentHint: frontmatter["argument-hint"] }),
			content: body,
			sourceInfo,
			filePath,
		},
		diagnostics: [],
	};
}

/**
 * Scan a directory for .md files (non-recursive) and load them as prompt templates.
 */
function loadTemplatesFromDir(dir: string, getSourceInfo: (filePath: string) => SourceInfo): LoadedPromptTemplates {
	const templates: PromptTemplate[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	// pie: prompt_templates.rs:80-88 -- a missing root is skipped WITHOUT a diagnostic
	// (`FileErrorCode::NotFound` is filtered); most users have neither root.
	if (!existsSync(dir)) {
		return { templates, diagnostics };
	}

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		// pie: prompt_templates.rs:96-105 -- an unreadable directory emits a `ListFailed`
		// diagnostic; the remaining roots are still walked.
		const message = error instanceof Error ? error.message : "failed to list prompt template directory";
		return { templates, diagnostics: [{ type: "warning", message, path: dir }] };
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);

		// For symlinks, check if they point to a file
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const stats = statSync(fullPath);
				isFile = stats.isFile();
			} catch {
				// Broken symlink, skip it
				continue;
			}
		}

		if (isFile && entry.name.endsWith(".md")) {
			const result = loadTemplateFromFile(fullPath, getSourceInfo(fullPath));
			if (result.template) {
				templates.push(result.template);
			}
			diagnostics.push(...result.diagnostics);
		}
	}

	return { templates, diagnostics };
}

export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. */
	cwd: string;
	/** Agent config directory for global templates. */
	agentDir: string;
	/** Explicit prompt template paths (files or directories). */
	promptPaths: string[];
	/** Include default prompt directories. */
	includeDefaults: boolean;
}

function normalizePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
	return trimmed;
}

function resolvePromptPath(p: string, cwd: string): string {
	const normalized = normalizePath(p);
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

/**
 * Load all prompt templates from:
 * 1. Project: cwd/{CONFIG_DIR_NAME}/prompts/
 * 2. Global: agentDir/prompts/
 * 3. Explicit prompt paths
 *
 * Port of oracle `crates/coding-agent/src/templates.rs` `load_all` layered onto the pi loader:
 * same dual-root discovery with project winning on a name collision, plus the loader diagnostics
 * oracle surfaces at startup.
 *
 * TODO(port): oracle roots the two directories at `<cwd>/.pie/templates/` and
 * `<PIE_DIR|~/.pie>/templates/` (templates.rs:17-18), whereas this repo names the subdirectory
 * `prompts/` everywhere (resource-loader.ts:626,632, package-manager.ts:2200,2206,
 * migrations.ts:141, config-selector.ts). Renaming is a repo-wide layout decision outside this
 * unit; the production caller (resource-loader) supplies the roots explicitly anyway.
 */
export function loadPromptTemplatesWithDiagnostics(options: LoadPromptTemplatesOptions): LoadedPromptTemplates {
	const resolvedCwd = options.cwd;
	const resolvedAgentDir = options.agentDir;
	const promptPaths = options.promptPaths;
	const includeDefaults = options.includeDefaults;

	const templates: PromptTemplate[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	const globalPromptsDir = options.agentDir ? join(options.agentDir, "prompts") : resolvedAgentDir;
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSourceInfo = (resolvedPath: string): SourceInfo => {
		if (isUnderPath(resolvedPath, globalPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "user",
				baseDir: globalPromptsDir,
			});
		}
		if (isUnderPath(resolvedPath, projectPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "project",
				baseDir: projectPromptsDir,
			});
		}
		return createSyntheticSourceInfo(resolvedPath, {
			source: "local",
			baseDir: statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath),
		});
	};

	const addLoaded = (loaded: LoadedPromptTemplates): void => {
		templates.push(...loaded.templates);
		diagnostics.push(...loaded.diagnostics);
	};

	if (includeDefaults) {
		// pie: templates.rs:25,32-38 -- oracle loads user first, project second, and the project
		// entry *replaces* the same-name user entry in place (`combined[i] = t`), i.e. project wins
		// on a name collision. Every consumer of this list resolves a name by taking the FIRST
		// match (`expandPromptTemplate` below, `resource-loader.ts:788-811`'s `dedupePrompts`), so
		// the identical project-wins outcome is reproduced by loading project FIRST rather than by
		// flipping that shared first-wins policy -- exactly the fix already applied to the sibling
		// skills loader (`skills.ts:443-454`, oracle skills.rs:14-16,41).
		addLoaded(loadTemplatesFromDir(projectPromptsDir, getSourceInfo));
		addLoaded(loadTemplatesFromDir(globalPromptsDir, getSourceInfo));

		// pie: `templates.rs:16-19` — upstream reads its templates from `<cwd>/.pie/templates/` and
		// `<PIE_DIR|~/.pie>/templates/`, **not** `prompts/`. Both
		// call sites here had `prompts` hard-coded, so a user arriving with existing templates
		// loaded **none** of them: the slash command reported an unknown name, with no hint why.
		//
		// The fix reads **both** rather than renaming. The `prompts` directory is where the
		// skeleton has always kept them, and there is even a migration that moved them there, so
		// renaming would make templates disappear for those users instead. Reading one extra
		// directory is a superset of upstream behaviour; failing to read the upstream one is a
		// real defect.
		//
		// Order: upstream puts its own directory last. As the comment above explains, this side
		// implements "project overrides user" by letting the first loader win, so these appended
		// directories rank below a same-named entry under `prompts`. Nothing changes for existing
		// users.
		addLoaded(loadTemplatesFromDir(resolve(resolvedCwd, CONFIG_DIR_NAME, "templates"), getSourceInfo));
		if (options.agentDir) {
			addLoaded(loadTemplatesFromDir(join(options.agentDir, "templates"), getSourceInfo));
		}
	}

	// 3. Load explicit prompt paths (pi-only: oracle's `load_all` has no explicit-path layer)
	for (const rawPath of promptPaths) {
		const resolvedPath = resolvePromptPath(rawPath, resolvedCwd);
		if (!existsSync(resolvedPath)) {
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			if (stats.isDirectory()) {
				addLoaded(loadTemplatesFromDir(resolvedPath, getSourceInfo));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadTemplateFromFile(resolvedPath, getSourceInfo(resolvedPath));
				if (result.template) {
					templates.push(result.template);
				}
				diagnostics.push(...result.diagnostics);
			}
		} catch {
			// Ignore read failures
		}
	}

	return { templates, diagnostics };
}

/**
 * Load all prompt templates, discarding loader diagnostics.
 *
 * Kept as the pi-shaped entry point so existing callers (`resource-loader.ts:512`) are unchanged;
 * use {@link loadPromptTemplatesWithDiagnostics} to surface oracle's startup diagnostics line.
 */
export function loadPromptTemplates(options: LoadPromptTemplatesOptions): PromptTemplate[] {
	return loadPromptTemplatesWithDiagnostics(options).templates;
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;

	const templateName = match[1];
	const argsString = match[2] ?? "";

	const template = templates.find((t) => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		return substituteArgs(template.content, args);
	}

	return text;
}
