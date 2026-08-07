import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	atomicWriteSkill,
	auditUrlReference,
	classifyInstallSkillPermission,
	createInstallSkillTool,
	createInstallSkillToolDefinition,
	type InstallSkillToolDetails,
} from "../src/tools/install-skill.ts";

// pie: crates/coding-agent/src/tools/install_skill.rs (pie @0a120dfd) -- tests ported from the
// oracle `#[cfg(test)] mod tests` block. Two structural adaptations, both documented in
// install-skill.ts's module docs and NOT ported here as pass/fail assertions:
//  1. oracle wires a live `AgentHarness` + `reload_skills_from_disk` that this port approximates
//     with a stateless catalog-snapshot recompute (`reloadSkillCatalog`) -- assertions against
//     `harness.skills()` become assertions against `result.details.installed_visible_in_catalog`
//     / `total_skills_after` instead.
//  2. oracle appends a persistent `skill_install` session audit entry (`audit_entry_id`); no
//     session-append hook is reachable from `ToolDefinition.execute`'s `ExtensionContext` in this
//     codebase, so `audit_entry_id` is always `undefined` here. `install_writes_skill_install_audit_entry`
//     (oracle test) is intentionally NOT ported -- there is nothing on this side to assert against.

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((c) => c.type === "text")?.text ?? "";
}

function makeSkillMd(name: string, description: string, body: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

describe("install-skill tool", () => {
	let dir: string;
	let cwd: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "install-skill-root-"));
		cwd = mkdtempSync(join(tmpdir(), "install-skill-cwd-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	function tool() {
		return createInstallSkillTool(cwd, { skillsRoot: dir });
	}

	// pie: install_skill.rs:741-751,752-810 (verbatim description + schema shape)
	it("exposes the oracle schema shape (name/description/union/additionalProperties)", () => {
		const def = createInstallSkillToolDefinition(cwd, { skillsRoot: dir });
		expect(def.name).toBe("InstallSkill");
		expect(def.description).toBe(
			"Install a new skill into the user-global skills directory (~/.pie/skills/<name>/) " +
				"and hot-reload the catalog so the next turn can use it. Two-phase: first call " +
				"without `confirm` returns a preview (name, description, target path, hash, size). " +
				"Second call with `confirm: true` writes atomically and reloads. Same-name skill " +
				"requires `overwrite: true` when the new content hash differs. Source is one of: " +
				"https URL, absolute local path, or inline content. Body is never echoed back into " +
				"the tool result — only metadata + preview info.",
		);
		const params = def.parameters as unknown as {
			additionalProperties: boolean;
			required: string[];
			properties: {
				source: {
					description: string;
					type: string;
					oneOf: Array<{
						additionalProperties: boolean;
						required: string[];
						properties: Record<string, { enum?: string[]; const?: string; type?: string }>;
					}>;
				};
			};
		};
		expect(params.additionalProperties).toBe(false);
		expect(params.required).toEqual(["source"]);
		expect(params.properties.source.description).toBe("Where to fetch the SKILL.md from.");
		// pie: install_skill.rs:752-810 -- oracle hand-writes `oneOf` (not typebox's `anyOf`), and
		// `source` carries BOTH `"type": "object"` and the branch list. Verified byte-for-byte
		// against parity S5's captured oracle request body.
		expect(params.properties.source.type).toBe("object");
		expect(params.properties.source.oneOf).toHaveLength(3);
		// Branch discriminators: an `enum` (no `"type"`) for url, bare `const` for path/content.
		expect(params.properties.source.oneOf[0]?.properties.type?.enum).toEqual(["url", "https"]);
		expect(params.properties.source.oneOf[0]?.properties.type?.type).toBeUndefined();
		expect(params.properties.source.oneOf[1]?.properties.type?.const).toBe("path");
		expect(params.properties.source.oneOf[1]?.properties.type?.type).toBeUndefined();
		expect(params.properties.source.oneOf[2]?.properties.type?.const).toBe("content");
		expect(params.properties.source.oneOf.map((branch) => branch.required)).toEqual([
			["type", "url"],
			["type", "path"],
			["type", "content"],
		]);
		for (const branch of params.properties.source.oneOf) {
			expect(branch.additionalProperties).toBe(false);
		}
	});

	// pie: install_skill.rs:903-935 (preview_returns_metadata_without_writing)
	it("preview returns metadata without writing", async () => {
		const skillMd = makeSkillMd("alpha", "a useful skill", "do alpha things");
		const result = await tool().execute(
			"call-1",
			{ source: { type: "content", content: skillMd } },
			undefined,
			undefined,
		);
		const details = result.details as InstallSkillToolDetails;

		expect(details.phase).toBe("preview");
		expect(details.name).toBe("alpha");
		expect(details.description).toBe("a useful skill");
		expect(details.existing).toBe(false);
		expect(details.overwrite_required).toBe(false);
		const text = getText(result);
		expect(text).not.toContain("do alpha things");
		expect(() => readFileSync(join(dir, "alpha", "SKILL.md"))).toThrow();
	});

	// pie: install_skill.rs:941-959 (rejects_traversal_in_skill_name)
	it("rejects traversal in skill name", async () => {
		const evil = "---\nname: ../etc/passwd\ndescription: x\n---\nbody";
		await expect(
			tool().execute("call-1", { source: { type: "content", content: evil } }, undefined, undefined),
		).rejects.toThrow(/invalid characters|must contain/);
	});

	// pie: install_skill.rs:962-976 (rejects_http_url)
	it("rejects http url", async () => {
		await expect(
			tool().execute(
				"call-1",
				{ source: { type: "url", url: "http://example.com/skill.md" } },
				undefined,
				undefined,
			),
		).rejects.toThrow(/https/);
	});

	// pie: install_skill.rs:981-992 (accepts_https_source_alias_for_url) -- adapted: since schema
	// validation happens upstream of tool.execute in this architecture (not inside it, see
	// install-skill.ts's classifyInstallSkillPermission doc comment), we instead prove the "https"
	// discriminant reaches the same fetchUrlSource code path as "url" by observing it hits the
	// SSRF guard exactly like the canonical "url" type does.
	it("accepts the https source-type alias as equivalent to url", async () => {
		const withHttps = tool().execute(
			"call-1",
			{ source: { type: "https", url: "https://127.0.0.1/skill.md" } },
			undefined,
			undefined,
		);
		const withUrl = tool().execute(
			"call-1",
			{ source: { type: "url", url: "https://127.0.0.1/skill.md" } },
			undefined,
			undefined,
		);
		await expect(withHttps).rejects.toThrow(/SSRF|local|private/);
		await expect(withUrl).rejects.toThrow(/SSRF|local|private/);
	});

	// pie: install_skill.rs:994-1018 (rejects_private_and_loopback_hosts)
	it.each([
		"https://127.0.0.1/skill.md",
		"https://localhost/skill.md",
		"https://10.0.0.1/skill.md",
		"https://192.168.1.1/skill.md",
		"https://api.localhost/skill.md",
	])("rejects private/loopback host %s", async (url) => {
		await expect(tool().execute("call-1", { source: { type: "url", url } }, undefined, undefined)).rejects.toThrow(
			/SSRF|local|private/,
		);
	});

	// pie: install_skill.rs:1023-1054 (accepts_db9_sized_skill_body_without_echoing_body) -- no
	// small artifact-size cap; only the 16 MiB OOM guard applies.
	it("accepts a large (>64KiB) skill body without echoing it back", async () => {
		const marker = "large-skill-body-marker";
		const body = `${marker}\n${"x".repeat(128 * 1024)}`;
		const skillMd = makeSkillMd("large-skill", "large desc", body);

		const result = await tool().execute(
			"call-1",
			{ source: { type: "content", content: skillMd } },
			undefined,
			undefined,
		);
		const details = result.details as InstallSkillToolDetails;
		expect(details.phase).toBe("preview");
		expect(details.name).toBe("large-skill");
		expect(details.size).toBe(Buffer.byteLength(skillMd, "utf-8"));
		expect(getText(result)).not.toContain(marker);
		expect(JSON.stringify(details)).not.toContain(marker);
	});

	// pie: install_skill.rs:1059-1074 (rejects_skill_missing_frontmatter)
	it.each(["no frontmatter at all", "---\ndescription: only-desc\n---\nbody", "---\nname: foo\n"])(
		"rejects skill missing required frontmatter: %s",
		async (bad) => {
			await expect(
				tool().execute("call-1", { source: { type: "content", content: bad } }, undefined, undefined),
			).rejects.toThrow();
		},
	);

	// pie: install_skill.rs:1076-1128 (installs_skill_missing_description_with_warning)
	it("installs a skill with missing description using a fallback + warning", async () => {
		const skillMd = "---\nname: only-name\n---\n# Heading\nBody body.";
		const t = tool();

		const preview = await t.execute(
			"call-1",
			{ source: { type: "content", content: skillMd } },
			undefined,
			undefined,
		);
		const previewDetails = preview.details as InstallSkillToolDetails;
		expect(previewDetails.phase).toBe("preview");
		expect(previewDetails.name).toBe("only-name");
		expect(previewDetails.description).toBe("No description provided.");
		expect(previewDetails.warnings[0]).toContain("description missing");

		const installed = await t.execute(
			"call-2",
			{ source: { type: "content", content: skillMd }, confirm: true },
			undefined,
			undefined,
		);
		const installedDetails = installed.details as InstallSkillToolDetails;
		expect(installedDetails.phase).toBe("installed");
		expect(installedDetails.installed_visible_in_catalog).toBe(true);
		expect(installedDetails.warnings[0]).toContain("description missing");

		const written = readFileSync(join(dir, "only-name", "SKILL.md"), "utf-8");
		expect(written).toContain("description: No description provided.");
	});

	// pie: install_skill.rs:1130-1162 (previews_recoverable_description_format_with_warning)
	it.each([
		["---\nname: empty-desc\ndescription: '   '\n---\nBody.", "description empty"],
		[`---\nname: long-desc\ndescription: ${"x".repeat(1025)}\n---\nBody.`, "description exceeds"],
	])("previews recoverable description issues with a warning: %s", async (skillMd, expectedWarning) => {
		const result = await tool().execute(
			"call-1",
			{ source: { type: "content", content: skillMd } },
			undefined,
			undefined,
		);
		const details = result.details as InstallSkillToolDetails;
		expect(details.phase).toBe("preview");
		expect(details.description).toBe("No description provided.");
		expect(details.warnings[0]).toContain(expectedWarning);
	});

	// pie: install_skill.rs:1164-1203 (installs_block_scalar_oversized_description_with_warning)
	it("installs a block-scalar oversized description with a fallback + warning", async () => {
		const oversized = "x".repeat(1025);
		const skillMd = `---\nname: block-desc\ndescription: |\n  ${oversized}\nx-custom: true\n---\n# Heading\nBody.`;

		const installed = await tool().execute(
			"call-1",
			{ source: { type: "content", content: skillMd }, confirm: true },
			undefined,
			undefined,
		);
		const details = installed.details as InstallSkillToolDetails;
		expect(details.phase).toBe("installed");
		expect(details.installed_visible_in_catalog).toBe(true);
		expect(details.warnings[0]).toContain("description exceeds");

		const written = readFileSync(join(dir, "block-desc", "SKILL.md"), "utf-8");
		expect(written).toContain("description: No description provided.");
		expect(written).not.toContain(`  ${oversized}`);
		expect(written).toContain("x-custom: true");
	});

	// pie: install_skill.rs:1205-1220 (accepts_unknown_extra_frontmatter_fields)
	it("accepts unknown extra frontmatter fields", async () => {
		const skillMd = "---\nname: extra-field\ndescription: useful\nx-custom: true\n---\nBody.";
		const result = await tool().execute(
			"call-1",
			{ source: { type: "content", content: skillMd } },
			undefined,
			undefined,
		);
		const details = result.details as InstallSkillToolDetails;
		expect(details.phase).toBe("preview");
		expect(details.name).toBe("extra-field");
		expect(details.warnings).toHaveLength(0);
	});

	// pie: install_skill.rs:1225-1271 (overwrite_required_when_hash_differs)
	it("requires overwrite when the existing hash differs, and is idempotent on identical bytes", async () => {
		const oldMd = makeSkillMd("alpha", "desc", "old body");
		await atomicWriteSkill(join(dir, "alpha", "SKILL.md"), oldMd);
		const newMd = makeSkillMd("alpha", "desc", "new body");
		const t = tool();

		const preview = await t.execute("call-1", { source: { type: "content", content: newMd } }, undefined, undefined);
		const previewDetails = preview.details as InstallSkillToolDetails;
		expect(previewDetails.existing).toBe(true);
		expect(previewDetails.overwrite_required).toBe(true);

		await expect(
			t.execute("call-2", { source: { type: "content", content: newMd }, confirm: true }, undefined, undefined),
		).rejects.toThrow(/overwrite: true/);

		const samePreview = await t.execute(
			"call-3",
			{ source: { type: "content", content: oldMd } },
			undefined,
			undefined,
		);
		const samePreviewDetails = samePreview.details as InstallSkillToolDetails;
		expect(samePreviewDetails.existing).toBe(true);
		expect(samePreviewDetails.overwrite_required).toBe(false);
	});

	// pie: install_skill.rs:1276-1309 (install_writes_atomic_and_reloads_catalog) -- adapted per
	// module-level note: harness.skills() assertions become details.installed_visible_in_catalog /
	// total_skills_after; audit_entry_id assertion dropped (always undefined here, see note above).
	it("writes atomically and reports the new skill visible in the catalog", async () => {
		const skillMd = makeSkillMd("beta", "beta desc", "beta body");
		const install = await tool().execute(
			"call-1",
			{ source: { type: "content", content: skillMd }, confirm: true },
			undefined,
			undefined,
		);
		const details = install.details as InstallSkillToolDetails;
		expect(details.phase).toBe("installed");
		expect(details.name).toBe("beta");
		expect(readFileSync(join(dir, "beta", "SKILL.md"), "utf-8")).toBe(skillMd);
		expect(details.installed_visible_in_catalog).toBe(true);
		expect(details.total_skills_after ?? 0).toBeGreaterThanOrEqual(1);
		// TODO(port): oracle also asserts `audit_entry_id` is set (persistent session audit).
		// No session-append hook is reachable here; see module docs. Document the gap explicitly
		// rather than silently dropping the assertion.
		expect(details.audit_entry_id).toBeUndefined();
	});

	// pie: install_skill.rs:1364-1418 (install_permission_reason_uses_whitelisted_source_kind_only)
	it("permission reason uses a whitelisted source-kind label only", () => {
		for (const [inputType, expected] of [
			["url", "url"],
			["https", "url"],
			["path", "path"],
			["content", "content"],
		] as const) {
			const cls = classifyInstallSkillPermission({
				source: { type: inputType, url: "ignored-by-reason" } as never,
			} as never);
			expect(cls.type).toBe("prompt");
			expect((cls as { reason: string }).reason).toContain(expected);
			expect((cls as { reason: string }).reason).not.toContain("ignored-by-reason");
		}

		const evilCls = classifyInstallSkillPermission({
			source: {
				type: "https://hub.example/api?token=ABCDEFGHIJKLMNOPQRSTUVWXYZ_super_secret",
				url: "ignored",
			} as never,
		} as never);
		expect(evilCls.type).toBe("prompt");
		const reason = (evilCls as { reason: string }).reason;
		expect(reason).toContain("<unknown source>");
		expect(reason).not.toContain("token=");
		expect(reason).not.toContain("super_secret");
	});

	// pie: install_skill.rs:1420-1442 (url_audit_reference_redacts_secret_bearing_parts)
	it("redacts secret-bearing parts of a url audit reference", () => {
		const reference = auditUrlReference("https://user:pass@example.com/token-path/skill.md?api_key=SECRET#frag");
		const serialized = JSON.stringify(reference);
		expect((reference as { scheme: string }).scheme).toBe("https");
		expect((reference as { host: string }).host).toBe("example.com");
		expect((reference as { redacted: true }).redacted).toBe(true);
		expect((reference as { path_hash: string }).path_hash).toHaveLength(64);
		for (const forbidden of ["user", "pass", "token-path", "api_key", "SECRET", "frag"]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	// pie: install_skill.rs:1445-1462 (atomic_write_leaves_no_temp_artifact_on_success)
	it("atomic write leaves no temp artifact on success", async () => {
		const target = join(dir, "gamma", "SKILL.md");
		await atomicWriteSkill(target, "---\nname: gamma\ndescription: g\n---\nbody\n");
		const entries = readdirSync(join(dir, "gamma"));
		expect(entries).toEqual(["SKILL.md"]);
	});
});
