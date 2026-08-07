#!/usr/bin/env node
/**
 * Guards the ledger of upstream inline tests that were reviewed one by one.
 *
 * ## How this differs from the three counting gates
 *
 * `check-inline-test-ports.mjs` counts how many upstream assertion names appear
 * anywhere in this repository's test corpus. That number is an upper bound on the gap,
 * not the gap itself — as its own header says, tests here are named in prose, so a name
 * failing to match does not mean the behavior is uncovered.
 *
 * Deciding which of those unmatched entries are real gaps takes a person: open the
 * upstream test, work out what it asserts, then look for an assertion here that covers
 * the same thing. An earlier round did part of that work; this ledger holds the rest.
 *
 * **What this gate guards is the completeness and honesty of that review**, not another
 * count. It answers two questions:
 *
 *   1. Does the set of entries in the ledger match a fresh scan of the upstream source?
 *      (Catches ledger drift, and catches the hard entries being quietly dropped.)
 *   2. Does the evidence for each verdict survive a machine check? (Does the line a
 *      `covered` verdict cites exist? Does the file a `gap` verdict names exist?)
 *
 * ## Three verdicts, no fourth
 *
 * | verdict        | meaning                                             | evidence |
 * |----------------|-----------------------------------------------------|----------|
 * | `covered`      | a test here asserts the same behavior, not necessarily under the same name or at the same granularity | `<path>:<line>` pointing at that assertion |
 * | `not-portable` | the assertion is about something specific to the source language or platform that does not exist here | a written note |
 * | `gap`          | upstream states an expectation this repository did not assert, and a test was written for it | the ported test file |
 *
 * ## What this gate cannot guard
 *
 * It verifies that the cited line **exists**. It cannot verify that the line asserts
 * what the upstream test asserted — only a person reading both can judge that. That is
 * why each batch also required a spot check with both assertions quoted side by side.
 * The machine guards the form; the sampling guards the substance.
 *
 * It also cannot stop someone marking every hard entry `not-portable` with an invented
 * reason. What stops that is the sampling, plus the rule that certain safety-related
 * entries may not carry that verdict at all.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = join(repoRoot, "migration/reviews/phase21/triage-ledger.tsv");

// `TODO` used to be accepted here and was removed once every entry had a verdict.
// From then on, adding a row to the ledger means reaching a conclusion at the same
// time. "Note it now, look at it later" is exactly how the previous round ended up
// with a hundred entries nobody had ever opened.
const ALLOWED_VERDICTS = new Set(["covered", "not-portable", "gap"]);

/**
 * Minimum length of a written reason, in codepoints. Long enough that a placeholder
 * phrase does not reach it.
 */
const MIN_NOTE_CHARS = 20;

/**
 * Upstream files an earlier round already reviewed line by line, recording the
 * corresponding line here for each. Their unmatched entries stay out of this ledger:
 * redoing the work has no value, and mixing them in would make the ledger size
 * meaningless, since it would no longer be clear which entries this round actually read.
 */
const ALREADY_TRIAGED = new Set([
	"agent/src/harness/trigger.rs",
	"agent/src/harness/trigger_runtime.rs",
	"agent/src/harness/permission.rs",
	"agent/src/harness/notification_hook.rs",
	"agent/src/harness/system_prompt.rs",
	"agent/src/harness/prompt_templates.rs",
	"agent/src/harness/utils/truncate.rs",
	"agent/src/harness/skills.rs",
	"agent/src/harness/env/native.rs",
	"agent/src/harness/compaction/compaction.rs",
	"coding-agent/src/ui/mod.rs",
	"coding-agent/src/session/mod.rs",
	"coding-agent/src/tools/edit.rs",
	"coding-agent/src/tools/find.rs",
	"coding-agent/src/tools/grep.rs",
	"coding-agent/src/tools/bash.rs",
	"coding-agent/src/tools/skill.rs",
	"ai/src/sigv4.rs",
	"ai/src/utils/aws_eventstream.rs",
	"ai/src/event_stream.rs",
	"ai/src/bedrock_anthropic.rs",
]);

/**
 * Batches are cut by what a reviewer has to think about, not by size. Grouping entries
 * that share a perspective means nobody has to switch between "credential redaction"
 * and "markdown rendering" every few rows. Files not listed here fall into the last batch.
 */
const BATCH_OF_FILE = new Map([
	// A — the CLI and command surface: bytes the user sees directly
	["coding-agent/src/commands.rs", "A"],
	["coding-agent/src/main.rs", "A"],
	// B — credentials and security: a gap here is a security gap, not a coverage number
	["coding-agent/src/auth.rs", "B"],
	["coding-agent/src/mcp_loader.rs", "B"],
	["coding-agent/src/debug.rs", "B"],
	["coding-agent/src/bug_report.rs", "B"],
	["ai/src/utils/oauth/anthropic.rs", "B"],
	["coding-agent/src/hooks.rs", "B"],
	// C — model and skill configuration
	["coding-agent/src/skills_state.rs", "C"],
	["coding-agent/src/local_models.rs", "C"],
	["coding-agent/src/model_picker.rs", "C"],
	["coding-agent/src/builtin_skills.rs", "C"],
	["coding-agent/src/model.rs", "C"],
	// D — session archival and restore: paths that can destroy a user's data
	["coding-agent/src/session_archive.rs", "D"],
	["coding-agent/src/resume_picker.rs", "D"],
	["coding-agent/src/agent_session.rs", "D"],
	// E — rendering, input, media and everything else (the catch-all batch)
	["coding-agent/src/markdown.rs", "E"],
	["coding-agent/src/images.rs", "E"],
	["coding-agent/src/mentions.rs", "E"],
	["coding-agent/src/readline.rs", "E"],
	["coding-agent/src/clipboard_image.rs", "E"],
	["ai/src/providers/faux.rs", "E"],
	["ai/src/utils/overflow.rs", "E"],
	["ai/src/providers/anthropic.rs", "E"],
	["ai/src/utils/abort.rs", "E"],
	["ai/src/vertex_provider.rs", "E"],
]);

const BATCHES = ["A", "B", "C", "D", "E"];

/** Same logic as the other coverage gates: the values hold shell variables and have to be expanded. */
function readSourcesEnv() {
	const p = join(repoRoot, "migration/sources.env");
	if (!existsSync(p)) return { path: null, reason: `${p} does not exist` };
	const m = readFileSync(p, "utf-8").match(/^ORACLE_PIE_DIR=(.*)$/m);
	if (!m) return { path: null, reason: "sources.env has no ORACLE_PIE_DIR" };
	const expanded = m[1]
		.replace(/^["']|["']$/g, "")
		.trim()
		// Handles both `$VAR` and `${VAR:-default}`. The default-value form matters because
		// sources.env uses it so that `source`-ing the file under `set -u` does not abort when
		// the variable is unset. A regex that only knows `${VAR}` leaves the `:-}` behind and
		// then reports a nonsense path in its skip message.
		.replace(/\$\{(\w+):-([^}]*)\}/g, (_, name, dflt) => process.env[name] ?? dflt)
		.replace(/\$\{?(\w+)\}?/g, (_, name) => process.env[name] ?? "");
	return { path: expanded, reason: null };
}

function walk(dir, ext, out = []) {
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir)) {
		if (e === "node_modules" || e === "dist" || e === "target") continue;
		const p = join(dir, e);
		if (statSync(p).isDirectory()) walk(p, ext, out);
		else if (e.endsWith(ext)) out.push(p);
	}
	return out;
}

const normalize = (s) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/**
 * The roster size, fixed when the upstream source was scanned to decide what this round
 * would review.
 *
 * It does not move as porting progresses. That distinction was learned the hard way; see
 * the comment on `scanOracle` below. Changing this number means saying which entries were
 * added or removed and why.
 */
const ROSTER_SIZE = 121;

/**
 * Scans the upstream source and returns two sets:
 *   - `all`: every inline test upstream, used to confirm each roster row really exists
 *   - `unmatchedNow`: the ones currently unmatched after normalisation, minus the files
 *     an earlier round already reviewed
 *
 * Structurally identical to `check-inline-test-ports.mjs`: same pattern, same
 * normalisation, same corpus directories.
 *
 * ## Why the roster must not equal `unmatchedNow`
 *
 * The first version of this gate treated "roster equals the current unmatched set" as an
 * invariant, and it went red on fifteen entries as soon as porting started. The ledger was
 * not wrong; the invariant was. Porting a gap means writing the upstream test name into a
 * comment in the new test file, because traceability requires it — and that makes the
 * substring scan match, which legitimately removes the entry from the unmatched set.
 *
 * Follow that definition to its conclusion and porting every entry would report an error
 * for every entry, while the fact that all of them were reviewed becomes inexpressible. So:
 *
 *   - the roster is a fixed list whose size is pinned at {@link ROSTER_SIZE};
 *   - every roster row must be a test that really exists upstream, which guards against
 *     upstream drift and typos;
 *   - every entry in `unmatchedNow` must appear in the roster, which guards against
 *     upstream adding a test that nobody reviewed.
 *
 * Only that last direction needs to be strict. The reverse — a roster entry no longer in
 * `unmatchedNow` — is good news: it means the entry was ported. The script reports it as
 * progress rather than as an error.
 */
function scanOracle(oracle) {
	const all = [];
	for (const crate of ["ai", "agent", "coding-agent", "mcp"]) {
		for (const f of walk(join(oracle, "crates", crate, "src"), ".rs")) {
			const src = readFileSync(f, "utf-8");
			const i = src.indexOf("#[cfg(test)]");
			if (i < 0) continue;
			const rel = f.replace(`${oracle}/crates/`, "");
			for (const m of src.slice(i).matchAll(/#\[(?:tokio::)?test\][^\n]*\n\s*(?:async\s+)?fn\s+(\w+)/g)) {
				all.push({ oracleFile: rel, testName: m[1] });
			}
		}
	}

	const corpus = [];
	for (const pkg of ["packages/ai/test", "packages/agent/test", "packages/coding-agent/test", "packages/mcp/test"]) {
		for (const f of walk(join(repoRoot, pkg), ".ts")) corpus.push(readFileSync(f, "utf-8"));
	}
	const blob = normalize(corpus.join("\n"));

	const unmatchedNow = all
		.filter(({ testName }) => !blob.includes(normalize(testName)))
		.filter(({ oracleFile }) => !ALREADY_TRIAGED.has(oracleFile));

	return { all, unmatchedNow };
}

const key = (r) => `${r.oracleFile}\t${r.testName}`;

const HEADER = ["oracle_file", "test_name", "batch", "verdict", "evidence", "note"];

function readLedger() {
	if (!existsSync(LEDGER)) return null;
	const lines = readFileSync(LEDGER, "utf-8").split("\n");
	// The empty string a trailing newline produces is not a data row
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	const header = lines[0].split("\t");
	const rows = lines.slice(1).map((line, i) => {
		const c = line.split("\t");
		return {
			lineNo: i + 2, // 1-based, counting the header
			oracleFile: c[0] ?? "",
			testName: c[1] ?? "",
			batch: c[2] ?? "",
			verdict: c[3] ?? "",
			evidence: c[4] ?? "",
			note: c[5] ?? "",
		};
	});
	return { header, rows };
}

// ── No upstream checkout: the two cases must read differently ──────────────────
// Conflating them hides the difference between a machine that simply has no copy and a
// path that is configured wrong, and only the second needs someone to act.
const { path: oracle, reason } = readSourcesEnv();
if (!oracle) {
	console.log(`check:triage-ledger: SKIP — ${reason}`);
	console.log("  Normal on a fresh clone or in CI; this check needs the upstream source to recompute the entry set.");
	process.exit(0);
}
if (!existsSync(join(oracle, "crates"))) {
	console.log(`check:triage-ledger: SKIP — ORACLE_PIE_DIR points at ${oracle}, which has no crates/ under it`);
	console.log("  If a local copy exists, this path is wrong and worth fixing rather than skipping past.");
	process.exit(0);
}

const { all: oracleAll, unmatchedNow } = scanOracle(oracle);

// ── --generate: write the initial ledger ────────────────────────────────────────
if (process.argv.includes("--generate")) {
	const sorted = [...unmatchedNow].sort((a, b) =>
		a.oracleFile === b.oracleFile ? a.testName.localeCompare(b.testName) : a.oracleFile.localeCompare(b.oracleFile),
	);
	const body = sorted.map((r) =>
		[r.oracleFile, r.testName, BATCH_OF_FILE.get(r.oracleFile) ?? "E", "TODO", "", ""].join("\t"),
	);
	writeFileSync(LEDGER, `${[HEADER.join("\t"), ...body].join("\n")}\n`, "utf-8");
	console.log(`Wrote ${LEDGER}`);
	console.log(`  ${body.length} entries awaiting a verdict, plus one header row = ${body.length + 1} lines`);
	process.exit(0);
}

// ── Checks ────────────────────────────────────────────────────────────────────
const ledger = readLedger();
if (!ledger) {
	console.error(`check:triage-ledger: FAIL — no ledger at ${LEDGER}`);
	console.error("  Create one with `node scripts/check-triage-ledger.mjs --generate`.");
	process.exit(1);
}

const errors = [];

if (ledger.header.join("\t") !== HEADER.join("\t")) {
	errors.push(`Header mismatch. Expected ${HEADER.join(" / ")}, got ${ledger.header.join(" / ")}`);
}

// 1) Roster integrity. Three checks, each in a different direction; see scanOracle.
const ledgerKeys = new Set(ledger.rows.map(key));
const oracleKeys = new Set(oracleAll.map(key));

// (a) Every row must be a test that really exists upstream. Guards drift and typos.
for (const k of ledgerKeys) {
	if (!oracleKeys.has(k)) errors.push(`Ledger entry does not exist upstream — renamed, deleted, or mistyped: ${k.replace("\t", " :: ")}`);
}

// (b) The roster size is pinned. Guards against quietly dropping the hard entries.
if (ledger.rows.length !== ROSTER_SIZE) {
	errors.push(`Roster has ${ledger.rows.length} rows, expected ${ROSTER_SIZE}. Changing it means saying which entries moved and why`);
}
if (ledgerKeys.size !== ledger.rows.length) {
	errors.push(`Ledger has duplicates: ${ledger.rows.length} rows but only ${ledgerKeys.size} distinct entries`);
}

// (c) Everything still unmatched must be in the roster. Guards against upstream adding
//     a test that nobody reviewed. The reverse is not checked: a roster entry leaving
//     the unmatched set means it was ported, which is success, not an error.
for (const k of unmatchedNow.map(key)) {
	if (!ledgerKeys.has(k)) {
		errors.push(`An unmatched upstream test is missing from the roster and needs a verdict: ${k.replace("\t", " :: ")}`);
	}
}

// 2) Check each row's verdict and evidence
for (const r of ledger.rows) {
	const at = `line ${r.lineNo} (${r.oracleFile} :: ${r.testName})`;

	if (!BATCHES.includes(r.batch)) {
		errors.push(`${at}: batch is "${r.batch}", must be one of ${BATCHES.join("/")}`);
	}
	if (!ALLOWED_VERDICTS.has(r.verdict)) {
		errors.push(`${at}: verdict is "${r.verdict}", must be one of ${[...ALLOWED_VERDICTS].join(" / ")}`);
		continue;
	}

	if (r.verdict === "covered") {
		const m = r.evidence.match(/^(.+):(\d+)$/);
		if (!m) {
			errors.push(`${at}: evidence for covered must be <path>:<line>, got "${r.evidence}"`);
			continue;
		}
		const [, path, lineStr] = m;
		const abs = join(repoRoot, path);
		if (!existsSync(abs)) {
			errors.push(`${at}: covered points at a file that does not exist: ${path}`);
			continue;
		}
		const src = readFileSync(abs, "utf-8").split("\n");
		const line = Number(lineStr);
		if (!Number.isInteger(line) || line < 1 || line > src.length) {
			errors.push(`${at}: covered points at ${path}:${line}, but that file has only ${src.length} lines`);
			continue;
		}
		// That line must be an assertion. The written rule always said so, but only people
		// enforced it — and three separate spot checks each caught a violation (a pointer to
		// an `it(...)` line, a pointer to setup code, one line cited by two upstream tests).
		// Three repeats of the same mistake, so the rule moved into the gate.
		//
		// Only `expect(` and `assert` count; the tests here use no third form.
		// This still cannot catch an assertion about the wrong thing — that is what the
		// sampling is for. The machine guards the form, a person guards the substance.
		if (!/\bexpect\(|\bassert\b/.test(src[line - 1] ?? "")) {
			errors.push(
				`${at}: covered points at ${path}:${line}, which is not an assertion line — ` +
					`${JSON.stringify((src[line - 1] ?? "").trim().slice(0, 60))}。` +
					"evidence must point at the line holding expect(...), not it(...), describe(...) or setup code",
			);
		}
	} else if (r.verdict === "gap") {
		if (!r.evidence) {
			errors.push(`${at}: a gap must cite the ported test file in its evidence`);
		} else if (!existsSync(join(repoRoot, r.evidence.replace(/:\d+$/, "")))) {
			errors.push(`${at}: the test file a gap cites does not exist: ${r.evidence}`);
		}
	} else if (r.verdict === "not-portable") {
		const chars = Array.from(r.note).length;
		if (chars < MIN_NOTE_CHARS) {
			errors.push(`${at}: the note for not-portable is ${chars} characters, minimum is ${MIN_NOTE_CHARS}. Say which kind of unportable this is.`);
		}
	}
}

if (errors.length) {
	console.error(`check:triage-ledger: FAIL — ${errors.length} problems`);
	for (const e of errors.slice(0, 40)) console.error(`    ${e}`);
	if (errors.length > 40) console.error(`    … and ${errors.length - 40} more`);
	console.error("  The method and the criteria for each verdict are documented alongside the ledger.");
	process.exit(1);
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`check:triage-ledger: OK — roster ${ledger.rows.length} entries, all present upstream; nothing unmatched is missing`);
// A progress figure, not an error: roster entries that have left the unmatched set,
// which happens when a ported test file mentions the upstream test name.
const stillUnmatched = unmatchedNow.filter((r) => ledgerKeys.has(key(r))).length;
console.log(`  ${stillUnmatched} roster entries are still unmentioned by any test here; the other ${ledger.rows.length - stillUnmatched} are mentioned`);

const tally = (rows) => {
	const t = { covered: 0, "not-portable": 0, gap: 0, TODO: 0 };
	for (const r of rows) t[r.verdict]++;
	return t;
};

const overall = tally(ledger.rows);
for (const b of BATCHES) {
	const rows = ledger.rows.filter((r) => r.batch === b);
	const t = tally(rows);
	console.log(
		`  batch ${b}: ${rows.length} entries — covered ${t.covered} · not-portable ${t["not-portable"]} · gap ${t.gap} · TODO ${t.TODO}`,
	);
}
console.log(
	`  total: ${ledger.rows.length} entries — covered ${overall.covered} · not-portable ${overall["not-portable"]} · gap ${overall.gap}`,
);
console.log(`  TODO remaining: ${overall.TODO}`);
if (overall.TODO === 0 && ALLOWED_VERDICTS.has("TODO")) {
	console.log("  Every entry has a verdict.");
}
