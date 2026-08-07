import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createMemoryTool,
	createMemoryToolDefinition,
	loadMemoryBlock,
	type MemoryToolDetails,
} from "../src/tools/memory.ts";

// pie: crates/coding-agent/src/tools/memory.rs has one #[cfg(test)] module (tests/tools.rs
// memory_save_then_load_block, memory_block_excludes_memory_md_index_file, ported below as the
// first two `it`s in the "load_memory_block" describe block) plus additional coverage here for
// save/list/read/forget and the B11 divergence.

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((c) => c.type === "text")?.text ?? "";
}

describe("memory tool", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "coding-agent-memory-tool-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("should expose the oracle schema shape (name/description/enum/required)", () => {
		// pie: crates/coding-agent/src/tools/memory.rs:300-320 (verbatim description)
		const def = createMemoryToolDefinition(dir);
		expect(def.name).toBe("memory");
		expect(def.label).toBe("memory");
		expect(def.description).toBe(
			"Persistent cross-session memory. action=save (requires name/description/content/optional type), action=list, action=read (requires name), action=forget (requires name). Saved entries are auto-injected into the system prompt of future sessions.",
		);
		const params = def.parameters as unknown as { required: string[]; additionalProperties?: boolean };
		expect(params.required).toEqual(["action"]);
		// pie: memory.rs:306-320 has no "additionalProperties" key at all (unlike task.rs's)
		expect(params.additionalProperties).toBeUndefined();
	});

	it("save should write frontmatter + body and update MEMORY.md", async () => {
		const tool = createMemoryTool(dir);
		const result = await tool.execute(
			"m1",
			{
				action: "save",
				name: "User Likes Tabs",
				description: "indentation preference",
				content: "The user prefers tabs over spaces.",
				type: "user",
			},
			undefined,
			undefined,
		);
		expect(getText(result)).toContain("Saved memory `user-likes-tabs`");
		const details = result.details as MemoryToolDetails;
		expect(details).toEqual({ name: "user-likes-tabs", path: join(dir, "user-likes-tabs.md") });

		const entryBody = await readFile(join(dir, "user-likes-tabs.md"), "utf-8");
		// pie: memory.rs:115-118 (verbatim frontmatter shape)
		expect(entryBody).toBe(
			"---\nname: user-likes-tabs\ndescription: indentation preference\nmetadata:\n  type: user\n---\n\nThe user prefers tabs over spaces.\n",
		);

		const index = await readFile(join(dir, "MEMORY.md"), "utf-8");
		expect(index).toBe("- [user-likes-tabs](user-likes-tabs.md) — indentation preference\n");
	});

	it('save should default `type` to "user" when omitted', async () => {
		const tool = createMemoryTool(dir);
		await tool.execute(
			"m1",
			{ action: "save", name: "no type given", description: "d", content: "c" },
			undefined,
			undefined,
		);
		const entryBody = await readFile(join(dir, "no-type-given.md"), "utf-8");
		expect(entryBody).toContain("metadata:\n  type: user\n");
	});

	it("save should slugify the name (lowercase, spaces/underscores to hyphens, punctuation dropped, collapsed/trimmed hyphens)", async () => {
		// pie: crates/coding-agent/src/tools/memory.rs:27-51
		const tool = createMemoryTool(dir);
		const result = await tool.execute(
			"m1",
			{ action: "save", name: "  Hello__World!!  --Foo", description: "d", content: "c" },
			undefined,
			undefined,
		);
		const details = result.details as { name: string };
		expect(details.name).toBe("hello-world-foo");
	});

	it("save should reject a name that slugifies to an empty string", async () => {
		const tool = createMemoryTool(dir);
		await expect(
			tool.execute("m1", { action: "save", name: "!!!", description: "d", content: "c" }, undefined, undefined),
		).rejects.toThrow("name slugifies to empty string");
	});

	it("save re-saving the same slug should replace the index line in place, not duplicate it", async () => {
		const tool = createMemoryTool(dir);
		await tool.execute(
			"m1",
			{ action: "save", name: "topic", description: "v1", content: "c1" },
			undefined,
			undefined,
		);
		await tool.execute(
			"m2",
			{ action: "save", name: "topic", description: "v2", content: "c2" },
			undefined,
			undefined,
		);
		const index = await readFile(join(dir, "MEMORY.md"), "utf-8");
		expect(index).toBe("- [topic](topic.md) — v2\n");
	});

	it("save should reject missing name/description/content with oracle's exact messages", async () => {
		const tool = createMemoryTool(dir);
		await expect(
			tool.execute("m1", { action: "save", description: "d", content: "c" } as any, undefined, undefined),
		).rejects.toThrow("missing `name`");
		await expect(
			tool.execute("m1", { action: "save", name: "n", content: "c" } as any, undefined, undefined),
		).rejects.toThrow("missing `description`");
		await expect(
			tool.execute("m1", { action: "save", name: "n", description: "d" } as any, undefined, undefined),
		).rejects.toThrow("missing `content`");
	});

	it('list should return "[no memories]" when the dir doesn\'t exist yet, then created lazily', async () => {
		const freshDir = join(dir, "does-not-exist-yet");
		const tool = createMemoryTool(freshDir);
		const result = await tool.execute("m1", { action: "list" }, undefined, undefined);
		// pie: memory.rs:76-79 -- `create_dir_all` runs before dispatch even for `list`.
		expect(getText(result)).toBe("[no memories]");
		const details = result.details as MemoryToolDetails;
		expect(details).toEqual({ memories: [] });
	});

	it("list should exclude MEMORY.md, strip .md, and sort names", async () => {
		const tool = createMemoryTool(dir);
		await tool.execute("m1", { action: "save", name: "zebra", description: "d", content: "c" }, undefined, undefined);
		await tool.execute("m2", { action: "save", name: "apple", description: "d", content: "c" }, undefined, undefined);
		const result = await tool.execute("m3", { action: "list" }, undefined, undefined);
		const details = result.details as { memories: string[] };
		expect(details.memories).toEqual(["apple", "zebra"]);
		expect(getText(result)).toBe("Memories:\n  apple\n  zebra\n");
	});

	it("read should return the full file body including frontmatter", async () => {
		const tool = createMemoryTool(dir);
		await tool.execute(
			"m1",
			{ action: "save", name: "topic", description: "d", content: "body text" },
			undefined,
			undefined,
		);
		const result = await tool.execute("m2", { action: "read", name: "topic" }, undefined, undefined);
		expect(getText(result)).toBe("---\nname: topic\ndescription: d\nmetadata:\n  type: user\n---\n\nbody text\n");
		const details = result.details as { path: string };
		expect(details.path).toBe(join(dir, "topic.md"));
	});

	it("read should error with 'read memory: ...' when the entry doesn't exist", async () => {
		const tool = createMemoryTool(dir);
		await expect(tool.execute("m1", { action: "read", name: "nope" }, undefined, undefined)).rejects.toThrow(
			/^read memory: /,
		);
	});

	it("forget should remove the entry file and its index line, and silently no-op when the file is already gone", async () => {
		const tool = createMemoryTool(dir);
		await tool.execute("m1", { action: "save", name: "topic", description: "d", content: "c" }, undefined, undefined);
		const result = await tool.execute("m2", { action: "forget", name: "topic" }, undefined, undefined);
		expect(getText(result)).toBe("Forgot memory `topic`.");
		const index = await readFile(join(dir, "MEMORY.md"), "utf-8");
		expect(index).toBe("");

		// pie: memory.rs:196-197 -- removal failure is silently swallowed, not surfaced.
		await expect(
			tool.execute("m3", { action: "forget", name: "topic" }, undefined, undefined),
		).resolves.toBeDefined();
	});

	it("should reject an unsupported/omitted action", async () => {
		const def = createMemoryToolDefinition(dir);
		await expect(
			def.execute("m1", {} as any, undefined, undefined, {} as Parameters<typeof def.execute>[4]),
		).rejects.toThrow();
	});
});

describe("load_memory_block (pie: crates/coding-agent/src/tools/memory.rs:254-296)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "coding-agent-memory-block-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("ported: memory_save_then_load_block", async () => {
		const tool = createMemoryTool(dir);
		await tool.execute(
			"m1",
			{
				action: "save",
				name: "User Likes Tabs",
				description: "indentation preference",
				content: "The user prefers tabs over spaces.",
				type: "user",
			},
			undefined,
			undefined,
		);

		const block = await loadMemoryBlock(dir);
		expect(block).toContain("<memory>");
		expect(block).toContain("tabs");
		expect(block).toContain("</memory>");
	});

	it("ported: memory_block_excludes_memory_md_index_file", async () => {
		writeFileSync(
			join(dir, "MEMORY.md"),
			"INDEX_SENTINEL_SHOULD_NOT_LEAK\n- [User Likes Tabs](user_likes_tabs.md)\n",
		);
		writeFileSync(
			join(dir, "user_likes_tabs.md"),
			"---\nname: user-likes-tabs\ndescription: indentation\nmetadata:\n  type: user\n---\n\nThe user prefers tabs.\n",
		);

		const block = await loadMemoryBlock(dir);
		expect(block).toContain("<memory>");
		expect(block).toContain("prefers tabs");
		expect(block).not.toContain("INDEX_SENTINEL_SHOULD_NOT_LEAK");
		expect(block).not.toContain("--- MEMORY.md ---");
	});

	it("should return an empty string when the dir doesn't exist", async () => {
		const block = await loadMemoryBlock(join(dir, "does-not-exist"));
		expect(block).toBe("");
	});

	it(// BUG(port): B11 (migration/RULEBOOK.md §5), defect 1 -- "the MEMORY.md index is kept up to date,
	// but the startup injection never reads it". The index is deliberately corrupted/out of sync with
	// the real entries (missing
	// one real entry, listing a bogus one that doesn't exist on disk); loadMemoryBlock must be
	// completely unaffected by that divergence because it never reads MEMORY.md's content at
	// all -- it lists the directory directly.
	"index is never consulted: a stale/wrong MEMORY.md has zero effect on the injected block", async () => {
		const tool = createMemoryTool(dir);
		await tool.execute(
			"m1",
			{ action: "save", name: "real-one", description: "d1", content: "REAL_ONE_BODY" },
			undefined,
			undefined,
		);
		await tool.execute(
			"m2",
			{ action: "save", name: "real-two", description: "d2", content: "REAL_TWO_BODY" },
			undefined,
			undefined,
		);

		// Hand-corrupt the index after both saves: drop the real-two entry, add a phantom
		// entry pointing at a file that was never created.
		writeFileSync(
			join(dir, "MEMORY.md"),
			"- [real-one](real-one.md) — d1\n- [phantom](phantom.md) — this file does not exist on disk\n",
		);

		const block = await loadMemoryBlock(dir);
		// Both real entries appear regardless of what the (wrong) index says.
		expect(block).toContain("REAL_ONE_BODY");
		expect(block).toContain("REAL_TWO_BODY");
		// The phantom index entry contributes nothing (there's no phantom.md to read).
		expect(block).not.toContain("phantom");
		expect(block).not.toContain("this file does not exist on disk");
	});

	it(// BUG(port): B11, defect 2 -- "every body other than MEMORY.md is concatenated into the system
	// prompt in full and without bound, with no cap on count, characters, relevance or project
	// boundary". Many large entries must ALL appear in full, uncapped.
	"is unbounded: many large entries are concatenated in full with no count/size cap", async () => {
		const tool = createMemoryTool(dir);
		const entryCount = 50;
		const largeBody = "X".repeat(5000);
		for (let i = 0; i < entryCount; i++) {
			await tool.execute(
				`m${i}`,
				{
					action: "save",
					name: `entry-${String(i).padStart(3, "0")}`,
					description: `d${i}`,
					content: `${largeBody}-${i}`,
				},
				undefined,
				undefined,
			);
		}

		const block = await loadMemoryBlock(dir);
		for (let i = 0; i < entryCount; i++) {
			expect(block).toContain(`${largeBody}-${i}`);
		}
		// entryCount full copies of a 5000-char body is well past any plausible fixed cap.
		expect(block.length).toBeGreaterThan(entryCount * largeBody.length);
	});

	it("entries are ordered by filename, sorted ascending", async () => {
		const tool = createMemoryTool(dir);
		await tool.execute(
			"m1",
			{ action: "save", name: "zzz-last", description: "d", content: "LAST_BODY" },
			undefined,
			undefined,
		);
		await tool.execute(
			"m2",
			{ action: "save", name: "aaa-first", description: "d", content: "FIRST_BODY" },
			undefined,
			undefined,
		);

		const block = await loadMemoryBlock(dir);
		expect(block.indexOf("FIRST_BODY")).toBeLessThan(block.indexOf("LAST_BODY"));
	});
});
