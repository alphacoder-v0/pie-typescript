import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_BASE_DIR } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { runMigrations } from "../src/migrations.ts";

// `getAgentDir()` resolves in the order `PIE_DIR`, `PI_CODING_AGENT_DIR`, `~/.pie`
// (config.ts:485-499). Setting only the second is overridden by a `PIE_DIR` from outside: once
// `test.sh` sets `PIE_DIR` to stop session directories leaking, the isolation here stops working and
// the test reads that empty temporary base directory instead. Setting both makes the isolation hold
// either way.
// It is also closer to upstream, whose `base_dir()` honours `PIE_DIR` alone (config.rs:10-17);
// `PI_CODING_AGENT_DIR` is an extra override inherited from the skeleton.
describe("keybindings migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAgentDir(config: Record<string, unknown>): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-keybindings-test-"));
		tempDirs.push(agentDir);
		fs.writeFileSync(path.join(agentDir, "keybindings.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		return agentDir;
	}

	it("rewrites old key names to namespaced ids", () => {
		const agentDir = createAgentDir({
			cursorUp: ["up", "ctrl+p"],
			expandTools: "ctrl+x",
		});
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		const previousBaseDir = process.env[ENV_BASE_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env[ENV_BASE_DIR] = agentDir;
		runMigrations(agentDir);
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		if (previousBaseDir === undefined) {
			delete process.env[ENV_BASE_DIR];
		} else {
			process.env[ENV_BASE_DIR] = previousBaseDir;
		}

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "keybindings.json"), "utf-8")) as Record<
			string,
			unknown
		>;
		expect(migrated).toEqual({
			"tui.editor.cursorUp": ["up", "ctrl+p"],
			"app.tools.expand": "ctrl+x",
		});
	});

	it("keeps the namespaced value when old and new names both exist", () => {
		const agentDir = createAgentDir({
			expandTools: "ctrl+x",
			"app.tools.expand": "ctrl+y",
		});
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		const previousBaseDir = process.env[ENV_BASE_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env[ENV_BASE_DIR] = agentDir;
		runMigrations(agentDir);
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		if (previousBaseDir === undefined) {
			delete process.env[ENV_BASE_DIR];
		} else {
			process.env[ENV_BASE_DIR] = previousBaseDir;
		}

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "keybindings.json"), "utf-8")) as Record<
			string,
			unknown
		>;
		expect(migrated).toEqual({
			"app.tools.expand": "ctrl+y",
		});
	});

	it("loads old key names in memory before the file is rewritten", () => {
		const agentDir = createAgentDir({
			selectConfirm: "enter",
			interrupt: "ctrl+x",
		});

		const keybindings = KeybindingsManager.create(agentDir);

		expect(keybindings.getUserBindings()).toEqual({
			"tui.select.confirm": "enter",
			"app.interrupt": "ctrl+x",
		});
		const effective = keybindings.getEffectiveConfig();
		expect(effective["tui.select.confirm"]).toBe("enter");
		expect(effective["app.interrupt"]).toBe("ctrl+x");
	});
});
