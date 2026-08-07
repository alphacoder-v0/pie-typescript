import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
	DEFAULT_RELAY_BASE_URL,
	getAgentDir,
	getConfigTomlPath,
	getMemoryDir,
	parseRelayBaseUrl,
	parseTriggerPollIntervalSecs,
	relayBaseUrl,
} from "../src/config.ts";

// pie: crates/coding-agent/src/config.rs -- diff-port coverage for the config.toml readers and
// path helpers this unit adds (memory_dir, parse_trigger_poll_interval_secs,
// parse_relay_base_url, relay_base_url). ported tests mirror config.rs's #[cfg(test)] module.

describe("getMemoryDir", () => {
	test("is global under the agent dir, not per-cwd", () => {
		expect(getMemoryDir()).toBe(join(getAgentDir(), "memory"));
	});
});

describe("getConfigTomlPath", () => {
	test("is <agentDir>/config.toml", () => {
		expect(getConfigTomlPath()).toBe(join(getAgentDir(), "config.toml"));
	});
});

// pie: config.rs:10-17 (`base_dir`) -- `PathBuf::from(p)`, verbatim. No tilde expansion.
describe("getAgentDir with PIE_DIR", () => {
	const originalPieDir = process.env.PIE_DIR;

	afterEach(() => {
		if (originalPieDir === undefined) {
			delete process.env.PIE_DIR;
		} else {
			process.env.PIE_DIR = originalPieDir;
		}
	});

	test("takes PIE_DIR verbatim, without expanding a leading tilde", () => {
		process.env.PIE_DIR = "~/custom-pie";
		expect(getAgentDir()).toBe("~/custom-pie");
	});

	test("uses an absolute PIE_DIR as-is", () => {
		process.env.PIE_DIR = "/var/tmp/pie-base";
		expect(getAgentDir()).toBe("/var/tmp/pie-base");
	});
});

describe("parseTriggerPollIntervalSecs", () => {
	// pie: config.rs:111-117 (parse_trigger_poll_interval_reads_config_value)
	test("reads the config value", () => {
		const text = "\n[triggers]\npoll_interval_secs = 15\n";
		expect(parseTriggerPollIntervalSecs(text)).toBe(15);
	});

	// pie: config.rs:119-122 (parse_trigger_poll_interval_defaults_when_missing)
	test("returns undefined when missing", () => {
		expect(parseTriggerPollIntervalSecs("")).toBeUndefined();
	});

	// pie: config.rs:132-138 (parse_trigger_poll_interval_rejects_zero)
	test("rejects zero", () => {
		const text = "\n[triggers]\npoll_interval_secs = 0\n";
		expect(() => parseTriggerPollIntervalSecs(text)).toThrow("`[triggers] poll_interval_secs` must be at least 1");
	});

	test("throws a `parse config.toml:` prefixed error on malformed TOML", () => {
		expect(() => parseTriggerPollIntervalSecs("not = [valid toml")).toThrow(/^parse config\.toml: /);
	});

	test("throws on wrong-typed value instead of silently coercing", () => {
		const text = '\n[triggers]\npoll_interval_secs = "fifteen"\n';
		expect(() => parseTriggerPollIntervalSecs(text)).toThrow(/parse config\.toml/);
	});
});

describe("parseRelayBaseUrl", () => {
	// pie: config.rs:124-129 (parse_relay_base_url_reads_override_and_defaults)
	test("defaults when absent", () => {
		expect(parseRelayBaseUrl("")).toBe(DEFAULT_RELAY_BASE_URL);
	});

	test("reads an override and strips a trailing slash", () => {
		const text = '[relay]\nbase_url = "http://127.0.0.1:8787/"\n';
		expect(parseRelayBaseUrl(text)).toBe("http://127.0.0.1:8787");
	});

	test("strips multiple trailing slashes", () => {
		const text = '[relay]\nbase_url = "http://127.0.0.1:8787///"\n';
		expect(parseRelayBaseUrl(text)).toBe("http://127.0.0.1:8787");
	});

	test("rejects non-http(s) schemes", () => {
		expect(() => parseRelayBaseUrl('[relay]\nbase_url = "ftp://x"\n')).toThrow(
			"`[relay] base_url` must start with http(s)://",
		);
	});
});

// pie: config.rs:42-46, 64-66 -- "Unknown sections and keys are ignored so feature-specific
// readers can coexist while the config surface is still small."
describe("config.toml whole-document tolerance", () => {
	test("ignores unrelated sections and keys", () => {
		const text = '[foo]\nbar = 1\nbaz = "qux"\n\n[relay]\nbase_url = "https://relay.example.com"\n';
		expect(parseRelayBaseUrl(text)).toBe("https://relay.example.com");
		expect(parseTriggerPollIntervalSecs(text)).toBeUndefined();
	});

	// A legal i64 in an unrelated key must not fail the whole read: `toml` deserializes it fine
	// for oracle, and neither reader looks at it.
	test("tolerates an integer outside JS's safe range in an unrelated key", () => {
		const text = '[foo]\nmax = 9223372036854775807\n\n[relay]\nbase_url = "https://relay.example.com"\n';
		expect(parseRelayBaseUrl(text)).toBe("https://relay.example.com");
		expect(parseTriggerPollIntervalSecs(text)).toBeUndefined();
	});

	test("tolerates a top-level out-of-range integer too", () => {
		expect(parseTriggerPollIntervalSecs("max = 9223372036854775807\n")).toBeUndefined();
		expect(parseRelayBaseUrl("max = 9223372036854775807\n")).toBe(DEFAULT_RELAY_BASE_URL);
	});

	// ...but genuinely malformed TOML must still be an error, not a silent default. These two
	// cases are the pair that pins the `integersAsBigInt: "asNeeded"` parse option in config.ts:
	// out-of-range integer = tolerated, structurally broken document = thrown. If a future
	// smol-toml bump changes either behaviour this goes red instead of silently regressing.
	test("still throws on malformed TOML", () => {
		expect(() => parseRelayBaseUrl("not toml [")).toThrow(/^parse config\.toml: /);
		expect(() => parseTriggerPollIntervalSecs("not toml [")).toThrow(/^parse config\.toml: /);
	});

	test("still throws on an unclosed table header", () => {
		expect(() => parseRelayBaseUrl("[foo")).toThrow(/^parse config\.toml: /);
		expect(() => parseTriggerPollIntervalSecs("[foo")).toThrow(/^parse config\.toml: /);
	});

	// Residual, inherent boundary (see the TODO(port) at parseTriggerPollIntervalSecs): oracle's
	// own field is `u64`, so it accepts this value; JS cannot carry it losslessly, so TS rejects
	// it loudly rather than rounding. Only pie's *own* fields are affected -- unknown keys above
	// stay tolerated, which is the case oracle's "unknown sections and keys are ignored" covers.
	test("still rejects an out-of-range integer in one of pie's own fields", () => {
		expect(() => parseTriggerPollIntervalSecs("[triggers]\npoll_interval_secs = 9223372036854775807\n")).toThrow(
			/^parse config\.toml: /,
		);
	});
});

// pie: config.rs:90-99 -- `triggers`/`relay` are `Option<Section>` structs, so a scalar in a table
// position is a deserialization error, not an absent section silently falling back to defaults.
describe("config.toml section type errors", () => {
	test("rejects a scalar `relay` instead of connecting to the default relay", () => {
		const text = 'relay = "https://example.com"\n';
		expect(() => parseRelayBaseUrl(text)).toThrow(
			'parse config.toml: invalid type: string "https://example.com", expected struct RelayConfigSection',
		);
		// Oracle deserializes the same `ConfigFile` struct in both readers, so this errors there too.
		expect(() => parseTriggerPollIntervalSecs(text)).toThrow(/^parse config\.toml: invalid type: /);
	});

	test("rejects a scalar `triggers`", () => {
		expect(() => parseTriggerPollIntervalSecs("triggers = 5\n")).toThrow(
			"parse config.toml: invalid type: integer `5`, expected struct TriggerConfigSection",
		);
	});

	test("rejects an array-of-tables in a table position", () => {
		expect(() => parseRelayBaseUrl('[[relay]]\nbase_url = "https://x.dev"\n')).toThrow(
			"parse config.toml: invalid type: sequence, expected struct RelayConfigSection",
		);
	});
});

describe("relayBaseUrl", () => {
	const originalPieDir = process.env.PIE_DIR;
	let tempDir: string | undefined;

	afterEach(() => {
		if (originalPieDir === undefined) {
			delete process.env.PIE_DIR;
		} else {
			process.env.PIE_DIR = originalPieDir;
		}
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	test("falls back to the default when config.toml is missing", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pie-relay-"));
		process.env.PIE_DIR = tempDir;
		await expect(relayBaseUrl()).resolves.toBe(DEFAULT_RELAY_BASE_URL);
	});

	test("reads the override from <base_dir>/config.toml", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pie-relay-"));
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "config.toml"), '[relay]\nbase_url = "https://relay.example.com"\n');
		process.env.PIE_DIR = tempDir;
		await expect(relayBaseUrl()).resolves.toBe("https://relay.example.com");
	});

	test("propagates parse errors unwrapped (no `read ...:` prefix)", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pie-relay-"));
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "config.toml"), '[relay]\nbase_url = "ftp://nope"\n');
		process.env.PIE_DIR = tempDir;
		await expect(relayBaseUrl()).rejects.toThrow("`[relay] base_url` must start with http(s)://");
	});
});
