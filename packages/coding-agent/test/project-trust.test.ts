import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_BASE_DIR } from "../src/config.ts";
import {
	ENV_TRUST_PROJECT,
	FLAG_TRUST_PROJECT,
	getTrustStorePath,
	isProjectTrusted,
	listTrustedProjects,
	noteProjectEntryOverride,
	noteUntrustedProjectConfig,
	projectConfigDirIsUserConfigDir,
	resetRunScopedTrustForTesting,
	resolveProjectKey,
	TRUST_STORE_VERSION,
	trustProject,
	untrustProject,
} from "../src/core/project-trust.ts";

// PORT-DIVERGENCE: B5 / B13 (RULEBOOK §5). This module has no oracle counterpart -- oracle has no
// trust concept at all -- so there is no oracle test to port. These are the gate's own invariants:
// default deny, fail closed, resolved-path keying, and a read path with zero side effects.

describe("project-trust", () => {
	let tempHome: string;
	let tempCwd: string;
	let originalPieDir: string | undefined;
	let originalTrustEnv: string | undefined;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "pi-test-trust-home-"));
		tempCwd = mkdtempSync(join(tmpdir(), "pi-test-trust-proj-"));
		originalPieDir = process.env[ENV_BASE_DIR];
		process.env[ENV_BASE_DIR] = tempHome;
		originalTrustEnv = process.env[ENV_TRUST_PROJECT];
		delete process.env[ENV_TRUST_PROJECT];
		resetRunScopedTrustForTesting();
	});

	afterEach(() => {
		resetRunScopedTrustForTesting();
		if (originalPieDir === undefined) delete process.env[ENV_BASE_DIR];
		else process.env[ENV_BASE_DIR] = originalPieDir;
		if (originalTrustEnv === undefined) delete process.env[ENV_TRUST_PROJECT];
		else process.env[ENV_TRUST_PROJECT] = originalTrustEnv;
		rmSync(tempHome, { recursive: true, force: true });
		rmSync(tempCwd, { recursive: true, force: true });
	});

	describe("default deny", () => {
		it("a directory is untrusted until something says otherwise", () => {
			expect(isProjectTrusted(tempCwd)).toBe(false);
		});

		it("asking the question creates nothing -- no trust.json", () => {
			isProjectTrusted(tempCwd);
			expect(existsSync(getTrustStorePath())).toBe(false);
			// The whole point: parity scenario S7 snapshots the `$HOME/.pie` file tree, so a store
			// that materialized on read would register as a divergence.
			expect(existsSync(tempHome)).toBe(true);
		});
	});

	describe("granting and revoking", () => {
		it("trustProject persists a versioned record and takes effect immediately", () => {
			const result = trustProject(tempCwd);
			expect(result.persisted).toBe(true);
			expect(result.path).toBe(resolveProjectKey(tempCwd));
			expect(isProjectTrusted(tempCwd)).toBe(true);

			const stored = JSON.parse(readFileSync(getTrustStorePath(), "utf-8"));
			expect(stored.version).toBe(TRUST_STORE_VERSION);
			expect(Object.keys(stored.projects)).toEqual([resolveProjectKey(tempCwd)]);
			// ISO-8601, informational only.
			const trustedAt = stored.projects[resolveProjectKey(tempCwd)].trustedAt;
			expect(typeof trustedAt).toBe("string");
			expect(new Date(trustedAt).toString()).not.toBe("Invalid Date");
		});

		it("the store is owner-only (it names directories allowed to spawn processes)", () => {
			trustProject(tempCwd);
			expect(statSync(getTrustStorePath()).mode & 0o777).toBe(0o600);
		});

		it("trusting a second directory keeps the first", () => {
			const other = mkdtempSync(join(tmpdir(), "pi-test-trust-other-"));
			try {
				trustProject(tempCwd);
				trustProject(other);
				expect(listTrustedProjects().sort()).toEqual([resolveProjectKey(tempCwd), resolveProjectKey(other)].sort());
			} finally {
				rmSync(other, { recursive: true, force: true });
			}
		});

		it("untrustProject revokes, and reports whether there was anything to revoke", () => {
			expect(untrustProject(tempCwd)).toBe(false);
			trustProject(tempCwd);
			expect(untrustProject(tempCwd)).toBe(true);
			expect(isProjectTrusted(tempCwd)).toBe(false);
			expect(listTrustedProjects()).toEqual([]);
		});

		it("leaves no temp file behind", () => {
			trustProject(tempCwd);
			untrustProject(tempCwd);
			expect(existsSync(`${getTrustStorePath()}.tmp-${process.pid}`)).toBe(false);
		});
	});

	describe("keys on the resolved (symlink-followed) absolute path", () => {
		it("trusting through a symlink and asking about the real path agree", () => {
			const link = join(tempHome, "link-to-project");
			symlinkSync(tempCwd, link);

			trustProject(link);

			// Stored under the real path, not the link.
			expect(listTrustedProjects()).toEqual([resolveProjectKey(tempCwd)]);
			expect(isProjectTrusted(tempCwd)).toBe(true);
			expect(isProjectTrusted(link)).toBe(true);
		});

		it("a symlink sitting inside a trusted directory does not launder its target", () => {
			const untrusted = mkdtempSync(join(tmpdir(), "pi-test-trust-hostile-"));
			try {
				trustProject(tempCwd);
				const link = join(tempCwd, "sneaky");
				symlinkSync(untrusted, link);
				// The link lives inside a trusted directory, but it resolves elsewhere.
				expect(isProjectTrusted(link)).toBe(false);
			} finally {
				rmSync(untrusted, { recursive: true, force: true });
			}
		});

		it("a relative path resolves against cwd before being compared", () => {
			expect(resolveProjectKey(".")).toBe(resolveProjectKey(process.cwd()));
		});
	});

	describe("fails closed", () => {
		it("a corrupt trust.json grants nothing", () => {
			trustProject(tempCwd);
			expect(isProjectTrusted(tempCwd)).toBe(true);
			writeFileSync(getTrustStorePath(), "{ not json", "utf-8");
			expect(isProjectTrusted(tempCwd)).toBe(false);
		});

		it("a well-formed but wrong-shaped trust.json grants nothing", () => {
			mkdirSync(tempHome, { recursive: true });
			writeFileSync(getTrustStorePath(), JSON.stringify({ version: 1, projects: [tempCwd] }), "utf-8");
			expect(isProjectTrusted(tempCwd)).toBe(false);
		});

		it("an entry for a different directory does not leak across", () => {
			const other = mkdtempSync(join(tmpdir(), "pi-test-trust-other-"));
			try {
				trustProject(other);
				expect(isProjectTrusted(tempCwd)).toBe(false);
			} finally {
				rmSync(other, { recursive: true, force: true });
			}
		});
	});

	describe(`${ENV_TRUST_PROJECT} escape hatch`, () => {
		it.each(["1", "true", "TRUE", "True"])("%s opts in", (value) => {
			process.env[ENV_TRUST_PROJECT] = value;
			expect(isProjectTrusted(tempCwd)).toBe(true);
			// Run-scoped: never persisted.
			expect(existsSync(getTrustStorePath())).toBe(false);
		});

		it.each(["0", "false", "yes", "", "on"])("'%s' does not opt in", (value) => {
			process.env[ENV_TRUST_PROJECT] = value;
			expect(isProjectTrusted(tempCwd)).toBe(false);
		});
	});

	// phase 19 F5. Running `pie` from `$HOME` makes `<cwd>/.pie` *be* the user config directory, so
	// the gate accused the user's own config of being an untrusted project config -- and the remedy
	// it printed (`pie --trust-project` in `$HOME`) would have written the home directory into the
	// store that names directories allowed to spawn processes. HOME is never touched here: the
	// `PIE_DIR` override points the user config dir at `<tempCwd>/.pie`, which is the same shape.
	describe("the user config directory is not a project (F5)", () => {
		/** Point the user config dir at `<dir>/.pie`, i.e. make `dir` behave as `$HOME`. */
		function makeUserConfigParent(dir: string): string {
			const userDir = join(dir, CONFIG_DIR_NAME);
			mkdirSync(userDir, { recursive: true });
			process.env[ENV_BASE_DIR] = userDir;
			return userDir;
		}

		it("recognizes the directory whose `.pie` IS the user config dir", () => {
			makeUserConfigParent(tempCwd);
			expect(projectConfigDirIsUserConfigDir(tempCwd)).toBe(true);
		});

		it("an ordinary project directory is not that -- the exemption stays narrow", () => {
			// PIE_DIR is `tempHome` (set in beforeEach); `tempCwd` is a plain project directory.
			expect(projectConfigDirIsUserConfigDir(tempCwd)).toBe(false);
			mkdirSync(join(tempCwd, CONFIG_DIR_NAME), { recursive: true });
			expect(projectConfigDirIsUserConfigDir(tempCwd)).toBe(false);
			// Neither is a sibling that merely shares a suffix, nor the config dir's own inside.
			expect(projectConfigDirIsUserConfigDir(join(tempCwd, "sub"))).toBe(false);
			expect(projectConfigDirIsUserConfigDir(tempHome)).toBe(false);
		});

		it("a symlinked home still matches -- compared on resolved real paths", () => {
			const userDir = makeUserConfigParent(tempCwd);
			const link = join(tempHome, "link-to-home");
			symlinkSync(tempCwd, link);
			// Reached through the symlink, `PIE_DIR` names a different string but the same directory.
			process.env[ENV_BASE_DIR] = join(link, CONFIG_DIR_NAME);
			expect(resolveProjectKey(join(link, CONFIG_DIR_NAME))).toBe(resolveProjectKey(userDir));
			expect(projectConfigDirIsUserConfigDir(tempCwd)).toBe(true);
			expect(projectConfigDirIsUserConfigDir(link)).toBe(true);
		});

		it(`${FLAG_TRUST_PROJECT} refuses there, explains why, and records nothing`, () => {
			makeUserConfigParent(tempCwd);

			const result = trustProject(tempCwd);

			expect(result.refused).toBeDefined();
			expect(result.persisted).toBe(false);
			// Refused, not failed: no write was attempted, so there is no errno to report.
			expect(result.error).toBeUndefined();
			// The message has to say *why*, or the user reads it as a permission problem.
			expect(result.refused).toContain(join(resolveProjectKey(tempCwd), CONFIG_DIR_NAME));
			expect(result.refused).toContain("your own pie config directory");
			expect(result.refused).toContain(getTrustStorePath());
			// Nothing granted, nothing written: the home directory never enters the store.
			expect(existsSync(getTrustStorePath())).toBe(false);
			expect(listTrustedProjects()).toEqual([]);
			expect(isProjectTrusted(tempCwd)).toBe(false);
		});

		it("a real project directory is still grantable -- refusal does not spread", () => {
			const result = trustProject(tempCwd);
			expect(result.refused).toBeUndefined();
			expect(result.persisted).toBe(true);
			expect(isProjectTrusted(tempCwd)).toBe(true);
		});
	});

	describe("notices", () => {
		it("the skip notice names the file, the directory, the flag and the env var -- on stderr", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				const configPath = join(tempCwd, ".pie", "mcp.toml");
				noteUntrustedProjectConfig(configPath, tempCwd);
				expect(spy.mock.calls.map((c) => String(c[0])).join("")).toBe(
					`pie: ignored untrusted project config ${configPath}; run \`pie ${FLAG_TRUST_PROJECT}\` in ${resolveProjectKey(tempCwd)} or set ${ENV_TRUST_PROJECT}=1 to load it\n`,
				);
			} finally {
				spy.mockRestore();
			}
		});

		it("the override notice names the entry and the user file it displaced -- on stderr", () => {
			const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				noteProjectEntryOverride("mcp.toml", "server", "github", "/home/user/.pie/mcp.toml");
				expect(spy.mock.calls.map((c) => String(c[0])).join("")).toBe(
					"pie: project mcp.toml server 'github' overrides the same-named entry in /home/user/.pie/mcp.toml\n",
				);
			} finally {
				spy.mockRestore();
			}
		});
	});
});
