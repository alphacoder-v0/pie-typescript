/**
 * `memory` tool -- write to / read from cross-session memory. Models the same idea as Claude
 * Code's `MEMORY.md`-style auto memory: the assistant calls this to persist a fact ("the user
 * prefers X", "the API key lives at Y"), and on startup the harness injects the existing memory
 * into the system prompt so the agent sees it for free in every new session (via
 * {@link loadMemoryBlock}, exported for that caller to wire in -- not this port unit's job, same
 * convention `git.ts`/`task.ts` establish for their own wiring-left-to-caller notes).
 *
 * Layout under `<memory_dir>/` (pie: crates/coding-agent/src/tools/memory.rs:6-8):
 * - `MEMORY.md` -- index, always maintained by save/forget
 * - `<slug>.md` -- individual entries with YAML frontmatter (name / description / type)
 */

import { join } from "node:path";
import type { AgentTool } from "@pie/agent-core";
import {
	mkdir as fsMkdir,
	readdir as fsReaddir,
	readFile as fsReadFile,
	rm as fsRm,
	writeFile as fsWriteFile,
} from "fs/promises";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../core/extensions/types.ts";
import { wrapToolDefinition } from "../core/tools/tool-definition-wrapper.ts";

// pie: crates/coding-agent/src/tools/memory.rs:27-51 (`fn slugify`)
function slugify(s: string): string {
	let out = "";
	for (const c of s) {
		if (/[a-zA-Z0-9]/.test(c)) {
			out += c.toLowerCase();
			// pie: memory.rs:32 (`c.is_whitespace()`) -- Rust's Unicode whitespace predicate;
			// JS `\s` (no `u` flag needed since `c` is already one code point from `for...of`)
			// covers ASCII + common Unicode space separators, a close-enough match for slug
			// input. Any other non-ASCII-alnum, non-whitespace/hyphen/underscore character is
			// dropped entirely, matching oracle's implicit `else` (no push).
		} else if (/\s/.test(c) || c === "-" || c === "_") {
			out += "-";
		}
	}
	// collapse multiple hyphens (memory.rs:36-49)
	let compact = "";
	let prevHyphen = false;
	for (const c of out) {
		if (c === "-") {
			if (!prevHyphen) compact += c;
			prevHyphen = true;
		} else {
			compact += c;
			prevHyphen = false;
		}
	}
	// memory.rs:50 (`.trim_matches('-')`)
	return compact.replace(/^-+|-+$/g, "");
}

const memorySchema = Type.Object({
	// pie: memory.rs:306-320 — oracle hand-writes `{"type": "string", "enum": [...]}`.
	// `Type.Union([Type.Literal ...])` renders as `anyOf: [{const, type}]`, a different wire schema.
	action: Type.Unsafe<"save" | "list" | "read" | "forget">({
		type: "string",
		enum: ["save", "list", "read", "forget"],
		description: "Operation to perform.",
	}),
	name: Type.Optional(Type.String({ description: "Short kebab-case slug (required for save/read/forget)." })),
	description: Type.Optional(Type.String({ description: "One-line summary (save only)." })),
	type: Type.Optional(
		Type.String({ description: "Memory category (e.g. user/feedback/project/reference). Default: user." }),
	),
	content: Type.Optional(Type.String({ description: "Body of the memory (save only)." })),
	// pie: memory.rs:306-320 -- oracle's `parameters` json! object has no `"additionalProperties"`
	// key at all (unlike task.rs's, which sets it to `false`); JSON Schema's default (additional
	// properties allowed) applies, so `Type.Object` is intentionally NOT given that option here.
});

export type MemoryToolInput = Static<typeof memorySchema>;

/**
 * pie: memory.rs:129, 169, 185, 201 -- oracle hand-builds a differently-shaped `details` object
 * per action (save: name+path, list: memories, read: path, forget: name); kept as a union of the
 * exact per-action shapes rather than one shape with everything optional, matching what oracle
 * literally produces. `details` is logs/UI-only, never sent to the model (same convention as
 * `git.ts`'s `GitToolDetails` / `task.ts`'s `TaskToolDetails`).
 */
export type MemoryToolDetails =
	| { name: string; path: string } // save (memory.rs:129)
	| { memories: string[] } // list (memory.rs:141, 169)
	| { path: string } // read (memory.rs:185)
	| { name: string }; // forget (memory.rs:201)

type MemoryExecuteResult = { content: [{ type: "text"; text: string }]; details: MemoryToolDetails };

function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// pie: memory.rs:207-235 (`async fn update_index`)
async function updateIndex(dir: string, slug: string, description: string): Promise<void> {
	const indexPath = join(dir, "MEMORY.md");
	let existing: string;
	try {
		existing = await fsReadFile(indexPath, "utf-8");
	} catch {
		// pie: memory.rs:213-215 (`.unwrap_or_default()`) -- a missing/unreadable index is
		// treated as an empty starting document, not an error.
		existing = "";
	}
	const line = `- [${slug}](${slug}.md) — ${description}\n`;
	let out = "";
	let replaced = false;
	const prefix = `- [${slug}](`;
	const lines = existing.length === 0 ? [] : existing.split("\n").slice(0, existing.endsWith("\n") ? -1 : undefined);
	for (const l of lines) {
		if (l.startsWith(prefix)) {
			out += line;
			replaced = true;
		} else {
			out += `${l}\n`;
		}
	}
	if (!replaced) {
		out += line;
	}
	try {
		await fsWriteFile(indexPath, out, "utf-8");
	} catch (error) {
		throw new Error(`write index: ${errMsg(error)}`);
	}
}

// pie: memory.rs:237-252 (`async fn remove_index_entry`)
async function removeIndexEntry(dir: string, slug: string): Promise<void> {
	const indexPath = join(dir, "MEMORY.md");
	let existing: string;
	try {
		existing = await fsReadFile(indexPath, "utf-8");
	} catch {
		// pie: memory.rs:239-241 (`let Ok(existing) = ... else { return Ok(()); }`) -- a
		// missing/unreadable index silently no-ops instead of erroring.
		return;
	}
	const prefix = `- [${slug}](`;
	const lines = existing.length === 0 ? [] : existing.split("\n").slice(0, existing.endsWith("\n") ? -1 : undefined);
	const out = lines
		.filter((l) => !l.startsWith(prefix))
		.map((l) => `${l}\n`)
		.join("");
	try {
		await fsWriteFile(indexPath, out, "utf-8");
	} catch (error) {
		throw new Error(`rewrite index: ${errMsg(error)}`);
	}
}

async function doSave(dir: string, params: MemoryToolInput): Promise<MemoryExecuteResult> {
	const name = params.name;
	if (!name) throw new Error("missing `name`");
	const description = params.description;
	if (description === undefined) throw new Error("missing `description`");
	const body = params.content;
	if (body === undefined) throw new Error("missing `content`");
	const kind = params.type ?? "user";

	const slug = slugify(name);
	if (slug.length === 0) throw new Error("name slugifies to empty string");
	const path = join(dir, `${slug}.md`);

	// pie: memory.rs:115-118 (verbatim frontmatter shape; no YAML escaping of `description`/
	// `kind` -- naive interpolation, replicated as-is).
	const frontmatter = `---\nname: ${slug}\ndescription: ${description}\nmetadata:\n  type: ${kind}\n---\n\n`;
	const payload = `${frontmatter}${body}\n`;
	try {
		await fsWriteFile(path, payload, "utf-8");
	} catch (error) {
		throw new Error(`write memory: ${errMsg(error)}`);
	}
	await updateIndex(dir, slug, description);

	return {
		content: [{ type: "text", text: `Saved memory \`${slug}\` (${path})` }],
		details: { name: slug, path },
	};
}

async function doList(dir: string): Promise<MemoryExecuteResult> {
	let entries: string[];
	try {
		entries = await fsReaddir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// pie: memory.rs:136-143 (`Err(e) if e.kind() == std::io::ErrorKind::NotFound`)
			return { content: [{ type: "text", text: "[no memories]" }], details: { memories: [] } };
		}
		throw new Error(`list memories: ${errMsg(error)}`);
	}
	const names = entries
		.filter((name) => name.endsWith(".md") && name !== "MEMORY.md")
		.map((name) => name.slice(0, -".md".length))
		.sort();
	const text = names.length === 0 ? "[no memories]" : `Memories:\n${names.map((n) => `  ${n}\n`).join("")}`;
	return { content: [{ type: "text", text }], details: { memories: names } };
}

async function doRead(dir: string, params: MemoryToolInput): Promise<MemoryExecuteResult> {
	const name = params.name;
	if (!name) throw new Error("missing `name`");
	const path = join(dir, `${slugify(name)}.md`);
	let buffer: Buffer;
	try {
		buffer = await fsReadFile(path);
	} catch (error) {
		throw new Error(`read memory: ${errMsg(error)}`);
	}
	let body: string;
	try {
		// pie: memory.rs:180-182 (`tokio::fs::read_to_string`) errors on invalid UTF-8 (same
		// validation `read.ts` already applies for the `read` FS tool); Node's Buffer#toString
		// never throws, so decode explicitly with a fatal TextDecoder to match.
		body = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		throw new Error("read memory: stream did not contain valid UTF-8");
	}
	return { content: [{ type: "text", text: body }], details: { path } };
}

async function doForget(dir: string, params: MemoryToolInput): Promise<MemoryExecuteResult> {
	const name = params.name;
	if (!name) throw new Error("missing `name`");
	const slug = slugify(name);
	const path = join(dir, `${slug}.md`);
	// pie: memory.rs:196-197 (`let _ = tokio::fs::remove_file(&path).await;`) -- result
	// deliberately discarded; a missing file (or any other removal failure) is silently
	// ignored, not surfaced as a tool error.
	try {
		await fsRm(path);
	} catch {
		// intentionally swallowed, matching oracle
	}
	await removeIndexEntry(dir, slug);
	return { content: [{ type: "text", text: `Forgot memory \`${slug}\`.` }], details: { name: slug } };
}

export function createMemoryToolDefinition(dir: string): ToolDefinition<typeof memorySchema, MemoryToolDetails> {
	return {
		name: "memory",
		label: "memory",
		// pie: crates/coding-agent/src/tools/memory.rs:302-305 (verbatim)
		description:
			"Persistent cross-session memory. action=save (requires name/description/content/optional type), action=list, action=read (requires name), action=forget (requires name). Saved entries are auto-injected into the system prompt of future sessions.",
		parameters: memorySchema,
		async execute(_toolCallId, params) {
			// pie: memory.rs:76-79 -- `create_dir_all` runs unconditionally before dispatch, for
			// every action (including `list`/`read`/`forget`, which don't themselves write).
			try {
				await fsMkdir(dir, { recursive: true });
			} catch (error) {
				throw new Error(`memory dir: ${errMsg(error)}`);
			}

			switch (params.action) {
				case "save":
					return doSave(dir, params);
				case "list":
					return doList(dir);
				case "read":
					return doRead(dir, params);
				case "forget":
					return doForget(dir, params);
				default:
					// pie: memory.rs:85 (`other => Err(...)`) -- unreachable given the schema's
					// enum constraint, but kept for defensive parity with oracle's `match`.
					throw new Error(`unknown action \`${params.action}\``);
			}
		},
	};
}

export function createMemoryTool(dir: string): AgentTool<typeof memorySchema> {
	return wrapToolDefinition(createMemoryToolDefinition(dir));
}

/**
 * Load existing memory into a text block suitable for the system prompt. Returns an empty
 * string when no memory exists. Walks `<dir>/*.md` (excluding `MEMORY.md`) and concatenates.
 *
 * BUG(port): B11 (migration/RULEBOOK.md §5) -- replicated verbatim from
 * pie: crates/coding-agent/src/tools/memory.rs:254-296. Two defects, both intentional:
 *  1. `MEMORY.md`'s own content is never read here -- the index that `updateIndex`/
 *     `removeIndexEntry` keep continuously up to date is completely ignored at startup-
 *     injection time. This function lists the directory directly and does not open or consult
 *     `MEMORY.md` for anything (not even to decide entry order); the index and this block can
 *     silently diverge (e.g. a stale/incorrect index) with zero effect on what gets injected.
 *  2. Every *other* `.md` file's full body is concatenated with NO bound of any kind -- no cap
 *     on entry count, no per-entry or total character/byte limit, no relevance ranking, and no
 *     project-scoping (a memory dir with hundreds of large entries injects all of them, in
 *     full, into every future session's system prompt).
 */
export async function loadMemoryBlock(dir: string): Promise<string> {
	let names: string[];
	try {
		names = await fsReaddir(dir);
	} catch {
		return "";
	}
	const entries = names
		.filter((name) => name.endsWith(".md") && name !== "MEMORY.md")
		.map((name) => ({ name, path: join(dir, name) }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	let block = "";
	let count = 0;
	for (const { name, path } of entries) {
		let body: string;
		try {
			body = await fsReadFile(path, "utf-8");
		} catch {
			continue;
		}
		if (count === 0) {
			block += "<memory>\n";
			block += "Persistent cross-session memory. These notes were saved in prior conversations and may be helpful. ";
			block += "Use the `memory` tool with action=save to add more, action=forget to remove.\n\n";
		}
		block += `--- ${name} ---\n`;
		block += body.trim();
		block += "\n\n";
		count += 1;
	}
	if (count > 0) {
		block += "</memory>";
	}
	return block;
}
