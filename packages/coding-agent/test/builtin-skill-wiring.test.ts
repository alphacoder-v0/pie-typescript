import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enabledBuiltinSkills, resolveBuiltins, setEnabledBuiltinSkills } from "../src/builtin-skills.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Wiring tests for `--builtin-skill` / `[builtin_skills] enabled`.
 *
 * `builtin-skills.test.ts` already covers oracle's own unit surface (resolve / merge / parse —
 * `builtin_skills.rs`'s inline tests, adjudicated `covered` in phase 21's ledger rows 20-21).
 * What was NEVER covered is the half that decides whether any of it reaches a user: the
 * **catalog the running CLI actually reads**. That gap is exactly how the first cut of this
 * wiring shipped inert — the resolved names were published into a registry that the real
 * consumer (`ResourceLoader`) never consulted, so the flag parsed, validated, and did nothing.
 *
 * So these tests assert against `ResourceLoader.getSkills()` — the same call `/skills`, the
 * startup line and the system-prompt catalog make (`main.ts:1550`, `slash-dispatch-skills.ts`).
 * A test that asserted on `enabledBuiltinSkills()` would have passed on the broken build.
 *
 * oracle: main.rs:695-707 — resolve, then `merge_with_user_project(resolved.skills,
 * &loaded_skills.skills)`, then the skills-state overlay, then `opts.skills = combined`.
 */
describe("--builtin-skill wiring reaches the loaded catalog", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pie-builtin-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		// Leave the process-wide registry empty for whatever runs next in this worker.
		setEnabledBuiltinSkills([]);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function writeDiskSkill(name: string, description: string): void {
		const dir = join(agentDir, "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
	}

	/**
	 * Assertions here are DIFFERENTIAL (does `karpathy-guidelines` appear / vanish / appear once),
	 * never "the catalog equals exactly this list".
	 *
	 * Not a softened bar — a necessary one. `test.sh` is hermetic for env vars but not for the
	 * storage root: it must never override `HOME` (hard constraint), so `ResourceLoader` also
	 * discovers whatever skills the developer really has under `~/.pie/skills` plus any package
	 * manager sources. On this machine that is 21 extra entries; on a clean CI checkout it is 0.
	 * An exact-list assertion would therefore be machine-dependent — green here, red there, and
	 * proving nothing either way. The differential form asserts the same behavior (built-in
	 * enters the catalog / is shadowed by a same-name disk skill) and is immune to that noise.
	 * See `migration/reviews/phase21/open-boundaries.md`, the fourth boundary, for the storage-root
	 * gap.
	 */
	function names(loader: DefaultResourceLoader): string[] {
		return loader.getSkills().skills.map((s) => s.name);
	}

	async function loadCatalog(): Promise<DefaultResourceLoader> {
		const loader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.create(tempDir, agentDir),
		});
		await loader.reload();
		return loader;
	}

	it("no request → no built-in enters the catalog", async () => {
		writeDiskSkill("disk-only", "on disk");
		setEnabledBuiltinSkills(resolveBuiltins([], []).skills);

		const loader = await loadCatalog();

		expect(names(loader)).toContain("disk-only");
		expect(names(loader)).not.toContain("karpathy-guidelines");
	});

	it("requested built-in appears in the catalog, built-ins first", async () => {
		writeDiskSkill("disk-only", "on disk");
		setEnabledBuiltinSkills(resolveBuiltins(["karpathy-guidelines"], []).skills);

		const loader = await loadCatalog();

		// Order is oracle's: `merge_with_user_project` starts from the built-in vec and pushes
		// the non-shadowing user/project skills onto the end (builtin_skills.rs:196-206) — so the
		// built-in is FIRST, ahead of every disk skill, whatever else the machine contributes.
		expect(names(loader)[0]).toBe("karpathy-guidelines");
		expect(names(loader)).toContain("disk-only");
	});

	it("same-name disk skill shadows the built-in — one entry, disk content wins", async () => {
		writeDiskSkill("karpathy-guidelines", "DISK-VERSION");
		setEnabledBuiltinSkills(resolveBuiltins(["karpathy-guidelines"], []).skills);

		const loader = await loadCatalog();
		const skills = loader.getSkills().skills;
		const matches = skills.filter((s) => s.name === "karpathy-guidelines");

		// Shadowed, not appended: exactly one entry survives and it is the disk one.
		expect(matches).toHaveLength(1);
		expect(matches[0]?.description).toBe("DISK-VERSION");
		expect(matches[0]?.baseDir).not.toBe("<builtin>");
	});

	it("config-only request reaches the catalog the same way the CLI flag does", async () => {
		// `[builtin_skills] enabled = [...]` — oracle's second source (main.rs:690).
		setEnabledBuiltinSkills(resolveBuiltins([], ["karpathy-guidelines"]).skills);

		const loader = await loadCatalog();

		expect(names(loader)).toContain("karpathy-guidelines");
	});

	it("built-in's synthetic path never touches the filesystem", async () => {
		setEnabledBuiltinSkills(resolveBuiltins(["karpathy-guidelines"], []).skills);

		// Regression guard, not hypothetical: `<builtin>/<name>/SKILL.md` (oracle's own format,
		// builtin_skills.rs:141-152) is a path that does not exist by construction, and the
		// loader's source-info fallback ends in `statSync`. The first working build of this
		// wiring crashed the whole CLI with ENOENT on that stat before printing a single line.
		const loader = await loadCatalog();
		const builtin = loader.getSkills().skills.find((s) => s.name === "karpathy-guidelines");

		expect(builtin?.filePath).toBe("<builtin>/karpathy-guidelines/SKILL.md");
		expect(builtin?.sourceInfo?.source).toBe("builtin");
	});

	it("refreshSkills re-merges without a full reload — the ordering fix main.ts depends on", async () => {
		// oracle merges after resolution; this side loads the catalog while building the session
		// and resolves later (main.ts), so the resolution point must be able to re-merge.
		setEnabledBuiltinSkills([]);
		const loader = await loadCatalog();
		const before = names(loader);
		expect(before).not.toContain("karpathy-guidelines");

		setEnabledBuiltinSkills(resolveBuiltins(["karpathy-guidelines"], []).skills);
		expect(enabledBuiltinSkills()).toHaveLength(1);
		// Nobody re-read the registry yet — the catalog is still the pre-resolution one.
		expect(names(loader)).toEqual(before);

		loader.refreshSkills();

		// The delta is exactly the built-in: nothing else moved, nothing else was dropped.
		expect(names(loader).filter((n) => !before.includes(n))).toEqual(["karpathy-guidelines"]);
		expect(before.filter((n) => !names(loader).includes(n))).toEqual([]);
	});
});
