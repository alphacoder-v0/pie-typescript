import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cronSidecarPath, triggerSidecarPath } from "../src/core/session-manager.ts";
import { activateImported, defaultExportPath, exportSession, importSession } from "../src/session-archive.ts";

// pie: crates/coding-agent/src/session_archive.rs -- port coverage adapted from session_archive.rs's
// #[cfg(test)] module onto pi's own SessionManager file format (see session-archive.ts's file
// header comment for the adaptation notes: activeLeafId = last entry id, importedFrom camelCase).

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pie-session-archive-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function writeSourceSession(dir: string, id: string, cwd: string, entries: string[]): string {
	const path = join(dir, `${id}.jsonl`);
	const header = `{"type":"session","version":3,"id":"${id}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}"}`;
	writeFileSync(path, `${[header, ...entries].join("\n")}\n`);
	return path;
}

function triggerSidecarJson(rules: Array<{ id: string; enabled: boolean; firedAt: string | null }>): string {
	return JSON.stringify({
		version: 1,
		rules: rules.map((r) => ({
			id: r.id,
			condition: "when something happens",
			action: "do work",
			enabled: r.enabled,
			fire_once: true,
			fired_at: r.firedAt,
			promote_to_chat: false,
			created_at: "2026-01-01T00:00:00Z",
		})),
	});
}

function cronSidecarToml(jobs: Array<{ id: string; enabled: boolean }>): string {
	return jobs
		.map(
			(j) =>
				`[[jobs]]\nid = "${j.id}"\nschedule = "0 * * * *"\naction = "hourly work"\nenabled = ${j.enabled}\nrunning_trace_id = "trace-secret"\nlast_due_at = "2026-01-01T00:00:00Z"\nlast_error = "old error"\nskipped_overlap_count = 2\nstateful = false\ncreated_at = "2026-01-01T00:00:00Z"\n`,
		)
		.join("\n");
}

describe("exportSession / importSession round trip", () => {
	// pie: session_archive.rs:616-750 (export_import_rewrites_metadata_and_disables_automation)
	test("rewrites metadata, disables automation by default, preserves the transcript", async () => {
		const sourceDir = join(tempDir, "source-sessions");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", [
			'{"type":"custom","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","customType":"test_event","data":{"transcript":"preserved"}}',
		]);
		writeFileSync(
			triggerSidecarPath(sourcePath),
			triggerSidecarJson([{ id: "trigger-1", enabled: true, firedAt: "2026-01-01T00:00:00Z" }]),
		);
		writeFileSync(cronSidecarPath(sourcePath), cronSidecarToml([{ id: "cron-1", enabled: true }]));

		const archive = join(tempDir, "backup.piesession");
		const exportSummary = await exportSession(sourcePath, archive, false);
		expect(exportSummary.entryCount).toBe(1);
		expect(exportSummary.hasTriggers).toBe(true);
		expect(exportSummary.hasCron).toBe(true);

		const destSessionsDir = join(tempDir, "dest-sessions");
		const imported = await importSession(destSessionsDir, archive, "/dest/cwd", "off");
		expect(imported.entryCount).toBe(1);
		expect(imported.triggersImported).toBe(1);
		expect(imported.cronImported).toBe(1);
		expect(imported.sessionId).not.toBe(exportSummary.sessionId);

		const importedContent = readFileSync(imported.sessionPath, "utf8");
		const importedHeader = JSON.parse(importedContent.split("\n")[0]!);
		expect(importedHeader.id).toBe(imported.sessionId);
		expect(importedHeader.cwd).toBe("/dest/cwd");
		expect(importedHeader.importedFrom.sessionId).toBe(exportSummary.sessionId);
		expect(importedHeader.importedFrom.cwd).toBe("/source/cwd");
		expect(typeof importedHeader.importedFrom.exportedAt).toBe("string");
		expect(typeof importedHeader.importedFrom.pieVersion).toBe("string");
		expect(importedContent).toContain('"transcript":"preserved"');

		const importedTriggers = JSON.parse(readFileSync(triggerSidecarPath(imported.sessionPath), "utf8"));
		expect(importedTriggers.rules[0].enabled).toBe(false);
		// fired_at is history: a fire-once rule that already fired must not re-fire after a
		// later manual enable, so import preserves it in every activation mode.
		expect(importedTriggers.rules[0].fired_at).toBe("2026-01-01T00:00:00Z");

		const importedCronText = readFileSync(cronSidecarPath(imported.sessionPath), "utf8");
		expect(importedCronText).toContain("enabled = false");
		expect(importedCronText).not.toContain("trace-secret");
		expect(importedCronText).not.toContain("old error");
		expect(importedCronText).toContain("skipped_overlap_count = 0");

		// excludeTriggers = true drops both sidecars from the archive.
		const excludedArchive = join(tempDir, "backup-no-automation.piesession");
		const exportWithoutAutomation = await exportSession(sourcePath, excludedArchive, true);
		expect(exportWithoutAutomation.hasTriggers).toBe(false);
		expect(exportWithoutAutomation.hasCron).toBe(false);
		const importedWithoutAutomation = await importSession(destSessionsDir, excludedArchive, "/dest/cwd", "off");
		expect(importedWithoutAutomation.triggersImported).toBe(0);
		expect(importedWithoutAutomation.cronImported).toBe(0);
	});

	// pie: session_archive.rs:1020-1076 (activation_on_preserves_source_disabled_automation)
	test("activateTriggers=on ANDs with each rule's own enabled flag (never widens)", async () => {
		const sourceDir = join(tempDir, "source-sessions");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", []);
		writeFileSync(
			triggerSidecarPath(sourcePath),
			triggerSidecarJson([
				{ id: "was-enabled", enabled: true, firedAt: "2026-01-01T00:00:00Z" },
				{ id: "was-disabled", enabled: false, firedAt: null },
			]),
		);
		writeFileSync(
			cronSidecarPath(sourcePath),
			cronSidecarToml([
				{ id: "job-on", enabled: true },
				{ id: "job-off", enabled: false },
			]),
		);
		const archive = join(tempDir, "backup.piesession");
		await exportSession(sourcePath, archive, false);

		const destSessionsDir = join(tempDir, "dest-sessions");
		const imported = await importSession(destSessionsDir, archive, "/dest/cwd", "on");

		const triggers = JSON.parse(readFileSync(triggerSidecarPath(imported.sessionPath), "utf8"));
		const enabledRule = triggers.rules.find((r: { id: string }) => r.id === "was-enabled");
		const disabledRule = triggers.rules.find((r: { id: string }) => r.id === "was-disabled");
		expect(enabledRule.enabled).toBe(true);
		expect(enabledRule.fired_at).toBe("2026-01-01T00:00:00Z");
		expect(disabledRule.enabled).toBe(false);

		const cronText = readFileSync(cronSidecarPath(imported.sessionPath), "utf8");
		expect(cronText).toMatch(/id = "job-on"[\s\S]*?enabled = true/);
		expect(cronText).toMatch(/id = "job-off"[\s\S]*?enabled = false/);
	});
});

test("ask activation is explicitly rejected until interactive confirm exists", async () => {
	// pie: session_archive.rs:760-775 (ask_activation_is_explicitly_rejected_until_interactive_confirm_exists)
	await expect(
		importSession(join(tempDir, "sessions"), join(tempDir, "missing.piesession"), tempDir, "ask"),
	).rejects.toThrow(/activate-triggers=ask.*not implemented/s);
});

test("rejects checksum-mismatched archives", async () => {
	const sourceDir = join(tempDir, "source-sessions");
	mkdirSync(sourceDir, { recursive: true });
	const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", []);
	const archive = join(tempDir, "backup.piesession");
	await exportSession(sourcePath, archive, false);

	// Corrupt the embedded session.jsonl content in place (breaks the sha256 the manifest
	// recorded) by flipping a byte in the archive's session.jsonl payload region.
	const bytes = readFileSync(archive);
	const flipped = Buffer.from(bytes);
	const idx = flipped.indexOf(Buffer.from('"cwd":"/source/cwd"'));
	expect(idx).toBeGreaterThan(-1);
	flipped[idx]! ^= 0xff;
	const tamperedArchive = join(tempDir, "tampered.piesession");
	writeFileSync(tamperedArchive, flipped);

	await expect(importSession(join(tempDir, "dest"), tamperedArchive, tempDir, "off")).rejects.toThrow(
		/checksum mismatch|parse session metadata|is not a valid session entry/,
	);
});

test("export refuses to overwrite an existing output file", async () => {
	const sourceDir = join(tempDir, "source-sessions");
	mkdirSync(sourceDir, { recursive: true });
	const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", []);
	const archive = join(tempDir, "backup.piesession");
	await exportSession(sourcePath, archive, false);
	const originalBytes = readFileSync(archive);

	await expect(exportSession(sourcePath, archive, false)).rejects.toThrow(/exists/);
	expect(readFileSync(archive)).toEqual(originalBytes);
});

test("export throws for a missing session file", async () => {
	await expect(exportSession(join(tempDir, "nope.jsonl"), join(tempDir, "out.piesession"), false)).rejects.toThrow();
});

if (process.platform !== "win32") {
	test("export archive is owner-only (0600)", async () => {
		const sourceDir = join(tempDir, "source-sessions");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", []);
		const archive = join(tempDir, "backup.piesession");
		await exportSession(sourcePath, archive, false);
		const mode = statSync(archive).mode & 0o777;
		expect(mode).toBe(0o600);
	});
}

test("successful import leaves no temp files behind", async () => {
	const sourceDir = join(tempDir, "source-sessions");
	mkdirSync(sourceDir, { recursive: true });
	const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", []);
	const archive = join(tempDir, "backup.piesession");
	await exportSession(sourcePath, archive, false);

	const destSessionsDir = join(tempDir, "dest-sessions");
	await importSession(destSessionsDir, archive, "/dest/cwd", "off");

	for (const name of readdirSync(destSessionsDir)) {
		expect(name.endsWith(".tmp")).toBe(false);
	}
});

test("activateImported re-enables only the originally-enabled ids and preserves the rest", async () => {
	const sourceDir = join(tempDir, "source-sessions");
	mkdirSync(sourceDir, { recursive: true });
	const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", []);
	writeFileSync(
		triggerSidecarPath(sourcePath),
		triggerSidecarJson([
			{ id: "was-enabled", enabled: true, firedAt: null },
			{ id: "was-disabled", enabled: false, firedAt: null },
		]),
	);
	writeFileSync(
		cronSidecarPath(sourcePath),
		cronSidecarToml([
			{ id: "job-on", enabled: true },
			{ id: "job-off", enabled: false },
		]),
	);
	const archive = join(tempDir, "backup.piesession");
	await exportSession(sourcePath, archive, false);

	const destSessionsDir = join(tempDir, "dest-sessions");
	const imported = await importSession(destSessionsDir, archive, "/dest/cwd", "off");

	expect(imported.originallyEnabledTriggers).toEqual(["was-enabled"]);
	expect(imported.originallyEnabledCron).toEqual(["job-on"]);

	const { triggersEnabled, cronEnabled } = activateImported(
		imported.sessionPath,
		imported.originallyEnabledTriggers,
		imported.originallyEnabledCron,
	);
	expect(triggersEnabled).toBe(1);
	expect(cronEnabled).toBe(1);

	const triggers = JSON.parse(readFileSync(triggerSidecarPath(imported.sessionPath), "utf8"));
	expect(triggers.rules.find((r: { id: string }) => r.id === "was-enabled").enabled).toBe(true);
	expect(triggers.rules.find((r: { id: string }) => r.id === "was-disabled").enabled).toBe(false);

	const cronText = readFileSync(cronSidecarPath(imported.sessionPath), "utf8");
	expect(cronText).toMatch(/id = "job-on"[\s\S]*?enabled = true/);
	expect(cronText).toMatch(/id = "job-off"[\s\S]*?enabled = false/);
});

describe("transcript parsing matches oracle's parse_session_jsonl", () => {
	// pie: session_archive.rs:389-393 -- `entry.parent_id()` is an `Option<String>`, so an entry
	// line with NO `parentId` key deserializes to `None` and skips the dangling-parent check.
	test("an entry with no parentId key is accepted, not treated as a dangling reference", async () => {
		const sourceDir = join(tempDir, "source-sessions");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", [
			'{"type":"custom","id":"e1","timestamp":"2026-01-01T00:00:01Z","customType":"x","data":{}}',
		]);
		const archive = join(tempDir, "backup.piesession");
		const summary = await exportSession(sourcePath, archive, false);
		expect(summary.entryCount).toBe(1);
	});

	// An explicitly non-null parentId that names no earlier entry is still rejected.
	test("a parentId naming an unseen entry is still a dangling reference", async () => {
		const sourceDir = join(tempDir, "source-sessions");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", [
			'{"type":"custom","id":"e1","parentId":"nope","timestamp":"2026-01-01T00:00:01Z","customType":"x","data":{}}',
		]);
		await expect(exportSession(sourcePath, join(tempDir, "backup.piesession"), false)).rejects.toThrow(
			/dangling parent reference/,
		);
	});

	// pie: session_archive.rs:366-369 -- `lines.next().ok_or_else(|| anyhow!(...))?`. Rust's
	// `str::lines()` yields nothing for a zero-length string, so an empty transcript gets its own
	// error rather than falling through to the `parse session metadata` context.
	test("a zero-byte session file reports `session transcript is empty`", async () => {
		const sourceDir = join(tempDir, "source-sessions");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = join(sourceDir, "empty.jsonl");
		writeFileSync(sourcePath, "");
		await expect(exportSession(sourcePath, join(tempDir, "backup.piesession"), false)).rejects.toThrow(
			/^session transcript is empty$/,
		);
	});

	// A lone newline is one (empty) line in Rust, so it takes the metadata-parse path instead.
	test("a lone newline still reports `parse session metadata`", async () => {
		const sourceDir = join(tempDir, "source-sessions");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = join(sourceDir, "newline.jsonl");
		writeFileSync(sourcePath, "\n");
		await expect(exportSession(sourcePath, join(tempDir, "backup.piesession"), false)).rejects.toThrow(
			/parse session metadata/,
		);
	});
});

describe("imported sidecars are schema-validated before anything is written", () => {
	// pie: session_archive.rs:103-107 (`DynamicTriggerFile`) + triggers/dynamic.rs:41-53
	// (`DynamicTriggerRule`: id/condition/action/enabled/created_at carry NO `#[serde(default)]`).
	// serde therefore fails the whole `import_session` at session_archive.rs:240-243, whose `?`
	// precedes the `create_dir_all` at :272 -- oracle writes nothing at all.
	test("a trigger sidecar missing required fields aborts the import and leaves no destination", async () => {
		const sourceDir = join(tempDir, "source-sessions");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", []);
		// No `version`; rule has no `condition`/`action`/`created_at`.
		writeFileSync(triggerSidecarPath(sourcePath), '{"rules":[{"id":"r1","enabled":true}]}');
		const archive = join(tempDir, "backup.piesession");
		await exportSession(sourcePath, archive, false);

		const destSessionsDir = join(tempDir, "dest-sessions");
		await expect(importSession(destSessionsDir, archive, "/dest/cwd", "off")).rejects.toThrow(
			/parse trigger sidecar/,
		);
		expect(existsSync(destSessionsDir)).toBe(false);
	});

	// pie: session_archive.rs:109-113 (`CronJobsFile`) + triggers/cron.rs:37-60 (`CronJob`:
	// id/schedule/action/enabled/created_at carry NO `#[serde(default)]`).
	test("a cron sidecar job missing required fields aborts the import and leaves no destination", async () => {
		const sourceDir = join(tempDir, "source-sessions");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", []);
		writeFileSync(cronSidecarPath(sourcePath), '[[jobs]]\nid = "j1"\nenabled = true\n');
		const archive = join(tempDir, "backup.piesession");
		await exportSession(sourcePath, archive, false);

		const destSessionsDir = join(tempDir, "dest-sessions");
		await expect(importSession(destSessionsDir, archive, "/dest/cwd", "off")).rejects.toThrow(/parse cron sidecar/);
		expect(existsSync(destSessionsDir)).toBe(false);
	});

	// Serde materializes `#[serde(default)]` fields on deserialize, and oracle re-serializes the
	// struct (`serde_json::to_string_pretty`, session_archive.rs:288), so the imported sidecar
	// always carries fire_once/fired_at/promote_to_chat.
	test("optional trigger fields are defaulted on import, matching serde", async () => {
		const sourceDir = join(tempDir, "source-sessions");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", []);
		writeFileSync(
			triggerSidecarPath(sourcePath),
			JSON.stringify({
				version: 1,
				rules: [
					{
						id: "r1",
						condition: "when x",
						action: "do y",
						enabled: false,
						created_at: "2026-01-01T00:00:00Z",
					},
				],
			}),
		);
		const archive = join(tempDir, "backup.piesession");
		await exportSession(sourcePath, archive, false);

		const destSessionsDir = join(tempDir, "dest-sessions");
		const imported = await importSession(destSessionsDir, archive, "/dest/cwd", "off");
		const rules = JSON.parse(readFileSync(triggerSidecarPath(imported.sessionPath), "utf8")).rules;
		expect(rules[0].fire_once).toBe(true); // dynamic.rs:46-47 default_fire_once
		expect(rules[0].fired_at).toBe(null); // dynamic.rs:48-49
		expect(rules[0].promote_to_chat).toBe(false); // dynamic.rs:50-51
	});
});

// pie: session_archive.rs:343-356 -- `CronJobsFile.jobs` DOES carry `#[serde(default)]`
// (:109-113), so a cron sidecar with no `jobs` key deserializes to an empty vec: the loop spins
// zero times, the file is rewritten as `jobs = []`, and the call returns `(n, 0)`.
test("activateImported tolerates a cron sidecar with no `jobs` key", async () => {
	const sourceDir = join(tempDir, "source-sessions");
	mkdirSync(sourceDir, { recursive: true });
	const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", []);
	writeFileSync(triggerSidecarPath(sourcePath), triggerSidecarJson([{ id: "t1", enabled: true, firedAt: null }]));
	writeFileSync(cronSidecarPath(sourcePath), cronSidecarToml([{ id: "job-on", enabled: true }]));
	const archive = join(tempDir, "backup.piesession");
	await exportSession(sourcePath, archive, false);

	const destSessionsDir = join(tempDir, "dest-sessions");
	const imported = await importSession(destSessionsDir, archive, "/dest/cwd", "off");
	// Drop the `jobs` key entirely (a hand-edited or externally-truncated sidecar).
	writeFileSync(cronSidecarPath(imported.sessionPath), "# no jobs here\n");

	const { triggersEnabled, cronEnabled } = activateImported(imported.sessionPath, ["t1"], ["job-on"]);
	expect(triggersEnabled).toBe(1);
	expect(cronEnabled).toBe(0);
	// The trigger sidecar was still rewritten -- no partial-state abort mid-way.
	const triggers = JSON.parse(readFileSync(triggerSidecarPath(imported.sessionPath), "utf8"));
	expect(triggers.rules[0].enabled).toBe(true);
	expect(readFileSync(cronSidecarPath(imported.sessionPath), "utf8")).toMatch(/jobs\s*=\s*\[\s*\]/);
});

test("defaultExportPath truncates the session id to 16 chars", () => {
	expect(defaultExportPath("/some/cwd", "0199abcd-ef01-7234-8000-abcdef012345")).toBe(
		join("/some/cwd", "pie-session-0199abcd-ef01-72.piesession"),
	);
});

describe("manifest.json wire shape (RULEBOOK §4 wire-construction probe)", () => {
	test("uses literal snake_case field names, matching oracle's Manifest struct (no rename_all)", async () => {
		const sourceDir = join(tempDir, "source-sessions");
		mkdirSync(sourceDir, { recursive: true });
		const sourcePath = writeSourceSession(sourceDir, "source-id", "/source/cwd", [
			'{"type":"custom","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","customType":"t","data":{}}',
		]);
		const archive = join(tempDir, "backup.piesession");
		await exportSession(sourcePath, archive, false);

		// Locate manifest.json inside the hand-rolled ustar archive: its 512-byte header names
		// the entry "manifest.json" at byte offset 0, followed immediately by its content block.
		const bytes = readFileSync(archive);
		const nameField = bytes.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
		expect(nameField).toBe("manifest.json");
		const sizeOctal = bytes.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim();
		const size = Number.parseInt(sizeOctal, 8);
		const manifestJson = bytes.subarray(512, 512 + size).toString("utf8");
		const manifest = JSON.parse(manifestJson);

		expect(Object.keys(manifest).sort()).toEqual(
			["content", "created_at", "pie_version", "schema", "sensitivity", "source"].sort(),
		);
		expect(Object.keys(manifest.source).sort()).toEqual(["cwd", "session_id", "session_path"].sort());
		expect(Object.keys(manifest.content).sort()).toEqual(
			["active_leaf_id", "entry_count", "has_cron", "has_triggers", "session_jsonl_sha256"].sort(),
		);
		expect(Object.keys(manifest.sensitivity).sort()).toEqual(
			[
				"mcp_config_included",
				"provider_credentials_included",
				"separate_auth_stores_included",
				"session_transcript_preserved",
			].sort(),
		);
		expect(manifest.schema).toBe("pie.session_export.v1");
		expect(manifest.content.active_leaf_id).toBe("e1");
		expect(manifest.content.entry_count).toBe(1);
	});
});
