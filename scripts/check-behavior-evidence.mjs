#!/usr/bin/env node
/**
 * Behavioral evidence gate — guards `migration/reviews/phase23/evidence.tsv`.
 *
 * ## What it guards
 *
 * Every public function in the roster needs one piece of behavioral evidence: either
 * a pointer to an assertion that already existed (`existing-test`) or a test written
 * to cover it (`new-test`). "Looks fine" is not evidence.
 *
 * ## Why each check is here
 *
 * None of these are hypothetical. Each one is a mistake that actually happened:
 *
 * 1. **Every roster row exists in the oracle.** Guards against upstream drift and
 *    typos. The roster is maintained by hand as well as by script, and it does not
 *    update itself when a function upstream is renamed or deleted.
 * 2. **The roster size is pinned.** The lesson from `check-triage-ledger.mjs`: once
 *    the size is allowed to float, "we covered fewer" becomes indistinguishable from
 *    "upstream has fewer".
 * 3. **The evidence line must contain an assertion.** This rule was promoted from a
 *    human habit to a machine check after the same mistake happened three times —
 *    one batch pointed at an `it(...)` line, another reused one line for two tests,
 *    a third pointed at setup code. The machine checks the form; a person still has
 *    to check the substance, which is whether that assertion would actually fail if
 *    the function were wrong.
 * 4. **The file the evidence points at exists.** Hand-written paths get mistyped,
 *    especially long ones like `packages/<pkg>/test/...`.
 *
 * ## What it deliberately does not do
 *
 * **It does not treat "the evidence table equals some computed set" as an invariant.**
 * An earlier version did, and it reported fifteen false failures as soon as porting
 * started — because a ported test mentions the upstream test name in a comment, which
 * legitimately removed those entries from the computed set. The roster is a fixed list
 * with a pinned size; the evidence table only has to cover it.
 *
 * ## Usage
 *
 *   node scripts/check-behavior-evidence.mjs
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROSTER = join(repoRoot, "migration/reviews/phase23/roster.tsv");
const EVIDENCE = join(repoRoot, "migration/reviews/phase23/evidence.tsv");

/**
 * The roster size, pinned. Must match `ROSTER_SIZE` in `build-roster-513.mjs`.
 *
 * 513 is every public function in the oracle. Earlier rounds worked through them in
 * groups and left the evidence in two tables with different shapes;
 * `build-roster-513.mjs` merged those into one.
 */
const ROSTER_SIZE = 513;

/**
 * The verdicts this gate accepts.
 *
 * The original design allowed only `existing-test` and `new-test`, on the assumption
 * that every roster function has a counterpart here — after all, the surface-coverage
 * gate reported only forty unmatched out of 513.
 *
 * Calibration disproved that assumption. Two of thirty sampled functions have no
 * counterpart at all: one takes image input that was never ported, and one parses the
 * AWS binary event-stream format, whose whole path is absent here. Neither can produce
 * an `existing-test` (there is no implementation to point at) or a `new-test` (there is
 * nothing to assert). Inventing evidence for them would be the worst option available,
 * and preventing exactly that is why this gate exists.
 *
 * Hence `not-portable`, which requires a written reason instead of a file and line.
 *
 * This is also bad news about the surface-coverage gate: it counts both of those as
 * matched, which means its "forty unmatched" understates the real gap.
 */
const ALLOWED_KINDS = new Set([
	"existing-test",
	"new-test",
	"not-portable",
	// Merged in from an earlier round's verdicts. Both are argued in full elsewhere and
	// mean something different from `not-portable`: that one says there is nothing on
	// this side to test, these two say there is nothing on the oracle side to compare
	// against. Folding them into `not-portable` would destroy real information.
	"dissolved-dependency",
	"oracle-stub",
]);

/**
 * For these verdicts the evidence column holds a written reason rather than a file and
 * line, because there is no implementation to point at. All three require a reason of
 * at least `MIN_NOTE_CHARS` and skip the assertion-line check.
 *
 * - `not-portable` — nothing on this side implements it.
 * - `dissolved-dependency` — the capability comes from a vendored dependency instead of
 *   ported code. The one instance is request signing, which a signing library provides.
 *   A test for it would exercise that library, not the fidelity of this port.
 * - `oracle-stub` — the oracle itself is an unimplemented stub that returns an error.
 *   Requiring behavioral agreement would mean requiring this side to fail too, which
 *   would break an implementation that works.
 */
const REASON_KINDS = new Set(["not-portable", "dissolved-dependency", "oracle-stub"]);

/** Minimum length of a written reason, in codepoints. Short enough to be reasonable,
 * long enough that "not done yet" does not qualify. */
const MIN_NOTE_CHARS = 20;

/**
 * A floor that only ever rises. While the roster was being worked through, a plain
 * "must be complete" switch would have been red from the first batch to the last, and
 * a check that is always red gets ignored, which makes it worthless. Raising this
 * number at the end of each batch let the gate enforce "progress never goes backwards"
 * without anyone having to remember to.
 *
 * It now equals the roster size and is kept as the record of that ratchet.
 */
const MIN_ADJUDICATED = 513;

/**
 * The final state: with the roster complete, anything short of full coverage fails.
 */
const REQUIRE_COMPLETE = true;

const BATCHES = ["HIGH", "A", "B", "C", "D", "E1", "E2", "U", "F", "G", "H"];

function oracleDir() {
	const out = execSync("bash -c 'source migration/sources.env && echo $ORACLE_PIE_DIR'", {
		cwd: repoRoot,
		encoding: "utf-8",
	}).trim();
	return out && existsSync(out) ? out : null;
}

function readTsv(path, expectedCols) {
	if (!existsSync(path)) return null;
	const lines = readFileSync(path, "utf-8").trim().split("\n");
	const header = lines[0].split("\t");
	if (header.length !== expectedCols) {
		console.error(`${path}: header has ${header.length} columns, expected ${expectedCols}`);
		process.exit(1);
	}
	return lines.slice(1).map((line, i) => ({ fields: line.split("\t"), lineNo: i + 2 }));
}

/**
 * The fourth column, `anchor`, is optional. The first rows written did not have it and
 * later batches did. Accepting both widths let the anchor be added batch by batch
 * instead of rewriting the whole table at once.
 */
function readTsvFlexible(path, allowedCols) {
	if (!existsSync(path)) return null;
	const lines = readFileSync(path, "utf-8").trim().split("\n");
	const header = lines[0].split("\t");
	if (!allowedCols.includes(header.length)) {
		console.error(`${path}: header has ${header.length} columns, expected ${allowedCols.join(" or ")}`);
		process.exit(1);
	}
	return lines.slice(1).map((line, i) => ({ fields: line.split("\t"), lineNo: i + 2 }));
}

// ── Load ──────────────────────────────────────────────────────────────────────

const rosterRows = readTsv(ROSTER, 6);
if (!rosterRows) {
	console.error(`Roster not found at ${ROSTER}. Generate it with build-roster-513.mjs first.`);
	process.exit(1);
}

const errors = [];

if (rosterRows.length !== ROSTER_SIZE) {
	errors.push(`Roster has ${rosterRows.length} rows, pinned at ${ROSTER_SIZE}. Either the selection rule changed or upstream drifted; both need an explanation before this passes.`);
}

const roster = new Map();
for (const { fields, lineNo } of rosterRows) {
	const [oracleFile, fnName, oracleLine, source, ruleHit, batch] = fields;
	// The key includes the upstream line number because one source file can define
	// several functions with the same name in different impl blocks. Those are distinct
	// functions, not duplicated rows. Two real cases exist: two constructors named `new`
	// in one file, and two named `text` in another. The first version of this gate is
	// what surfaced that flaw in the key design.
	const key = `${oracleFile}::${fnName}@${oracleLine}`;
	if (roster.has(key)) errors.push(`roster line ${lineNo}: ${key} is duplicated — the line number failed to separate two functions with the same name`);
	if (!BATCHES.includes(batch)) errors.push(`roster line ${lineNo}: batch "${batch}" is not one of ${BATCHES.join("/")}`);
	if (source === "low" && !ruleHit) errors.push(`roster line ${lineNo}: a low-tier row must record which rule selected it`);
	roster.set(key, { oracleFile, fnName, oracleLine, source, ruleHit, batch });
}

// ── Check 1: every roster row exists upstream ─────────────────────────────────

const oracle = oracleDir();
if (oracle) {
	const srcCache = new Map();
	for (const [key, r] of roster) {
		if (!srcCache.has(r.oracleFile)) {
			const p = join(oracle, "crates", r.oracleFile);
			srcCache.set(r.oracleFile, existsSync(p) ? readFileSync(p, "utf-8") : null);
		}
		const src = srcCache.get(r.oracleFile);
		if (src === null) {
			errors.push(`roster: ${key} names a file that does not exist upstream — ${r.oracleFile}`);
			continue;
		}
		const esc = r.fnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (!new RegExp(`\\bfn\\s+${esc}\\b`).test(src)) {
			errors.push(`roster: ${key} is not in the upstream source — did upstream drift, or is the name mistyped?`);
		}
	}
} else {
	console.log("  (no upstream checkout; skipping the check that every roster row exists there)");
}

// ── Checks 2 to 4: the evidence table ─────────────────────────────────────────

const evidenceRows = readTsvFlexible(EVIDENCE, [3, 4]) ?? [];
const adjudicated = new Map();

for (const { fields, lineNo } of evidenceRows) {
	const [fnKey, kind, evidence, rest] = fields;
	const at = `evidence line ${lineNo} (${fnKey})`;

	if (!roster.has(fnKey)) {
		errors.push(`${at}: not in the roster. Keys look like <file>::<fn>@<line>. The evidence table covers the roster; it cannot add entries of its own.`);
		continue;
	}
	if (adjudicated.has(fnKey)) {
		errors.push(`${at}: ${fnKey} already has a verdict on line ${adjudicated.get(fnKey)}`);
		continue;
	}
	adjudicated.set(fnKey, lineNo);

	if (!ALLOWED_KINDS.has(kind)) {
		errors.push(`${at}: verdict is "${kind}", must be one of ${[...ALLOWED_KINDS].join(" / ")}`);
		continue;
	}

	// For reason-carrying verdicts the evidence column is prose, not a path and line,
	// because there is no implementation to point at.
	if (REASON_KINDS.has(kind)) {
		if ([...evidence].length < MIN_NOTE_CHARS) {
			errors.push(
				`${at}: the reason for ${kind} is ${[...evidence].length} characters, minimum is ${MIN_NOTE_CHARS}. ` +
					"It has to say why no comparable behavior exists, not that the work is pending.",
			);
		}
		continue;
	}

	const m = evidence.match(/^(.+):(\d+)$/);
	if (!m) {
		errors.push(`${at}: evidence must be <path>:<line>, got "${evidence}"`);
		continue;
	}
	const [, path, lineStr] = m;
	const line = Number(lineStr);
	const abs = join(repoRoot, path);
	if (!existsSync(abs)) {
		errors.push(`${at}: evidence points at a file that does not exist — ${path}`);
		continue;
	}
	const src = readFileSync(abs, "utf-8").split("\n");
	if (line < 1 || line > src.length) {
		errors.push(`${at}: evidence points at ${path}:${line}, but that file has only ${src.length} lines`);
		continue;
	}

	/**
	 * What counts as an assertion line. Tightened twice, both times after a real miss:
	 *
	 * 1. **Comment lines are excluded.** A ported test often quotes the upstream
	 *    assertion verbatim in a comment. That upstream macro is spelled `assert!`,
	 *    which a bare word-boundary match on "assert" happily accepted — so one verdict
	 *    ended up pointing at a comment.
	 * 2. **`assert` must be followed by a dot or a parenthesis.** `assert.ok(...)` and
	 *    `assert(...)` are real assertions; the word "assert" inside prose is not.
	 *
	 * `expect(` needs no such tightening: it carries its own parenthesis and has no
	 * non-assertion use here.
	 */
	const isAssertion = (text) => {
		const t = (text ?? "").trim();
		if (t.startsWith("//") || t.startsWith("*")) return false;
		return /\bexpect\(|\bassert\s*[.(]/.test(t);
	};

	// Promoted to a rule after the same mistake happened three times: the evidence must
	// point at an assertion. Only `expect(` and `assert` count — most packages use the
	// first, the terminal package uses the second.
	if (!isAssertion(src[line - 1])) {
		// Line numbers drift as a matter of course, not by accident: the formatter run
		// inside `npm run check` rewraps code, and adding a few lines to a test file
		// shifts everything below. Rather than asking a person to recount, the anchor
		// column lets the gate work out the new line and say so.
		const anchor = (rest ?? "").trim();
		if (anchor) {
			const hits = src.map((t, i) => [t, i + 1]).filter(([t]) => t.includes(anchor) && isAssertion(t));
			if (hits.length === 1) {
				errors.push(`${at}: the line drifted — ${path}:${line} is no longer an assertion. The anchor is now on line ${hits[0][1]}; use that.`);
				continue;
			}
			errors.push(
				`${at}: the line drifted and the anchor ${JSON.stringify(anchor.slice(0, 40))} matches ${hits.length} times in ${path}. ` +
					"Zero matches means the assertion was rewritten or removed, so the evidence is stale and needs a fresh verdict. " +
					"More than one means the anchor is not distinctive enough.",
			);
			continue;
		}
		errors.push(
			`${at}: evidence points at ${path}:${line}, which is not an assertion line — ` +
				`${JSON.stringify((src[line - 1] ?? "").trim().slice(0, 60))}。` +
				"it must be the line holding expect(...), not it(...), describe(...) or setup code. " +
				"Adding an anchor in the fourth column lets this gate report the new line when it drifts again.",
		);
	} else if (rest && !src[line - 1].includes(rest.trim())) {
		// The line is an assertion but does not contain the anchor. Usually two verdicts
		// point at the same line, or the anchor was copied wrong.
		errors.push(`${at}: line ${line} is an assertion but does not contain the anchor ${JSON.stringify(rest.trim().slice(0, 40))}`);
	}
}

// ── Report ────────────────────────────────────────────────────────────────────

if (errors.length > 0) {
	console.error(`check:behavior-evidence: ${errors.length} problems\n`);
	for (const e of errors) console.error(`  ${e}`);
	process.exit(1);
}

const done = adjudicated.size;
console.log(
	`check:behavior-evidence: OK — roster ${roster.size} entries, all present upstream; ${done}/${ROSTER_SIZE} decided`,
);

const kindTally = { "existing-test": 0, "new-test": 0, "not-portable": 0 };
for (const { fields } of evidenceRows) if (ALLOWED_KINDS.has(fields[1])) kindTally[fields[1]]++;
if (done > 0) {
	// The hit rate excludes not-portable functions from its denominator. They have no
	// counterpart here, so they are neither a hit nor a miss; counting them would
	// distort the reading of how much was already covered by existing tests.
	const testable = kindTally["existing-test"] + kindTally["new-test"];
	const rate = testable > 0 ? ((kindTally["existing-test"] / testable) * 100).toFixed(1) : "n/a";
	console.log(
		`  existing-test ${kindTally["existing-test"]} · new-test ${kindTally["new-test"]} · ` +
			`not-portable ${kindTally["not-portable"]} (existing-test hit rate ${rate}%, excluding not-portable)`,
	);
}

for (const b of BATCHES) {
	const total = [...roster.values()].filter((r) => r.batch === b).length;
	const doneInBatch = [...adjudicated.keys()].filter((k) => roster.get(k).batch === b).length;
	console.log(`  batch ${b.padEnd(2)}: ${String(doneInBatch).padStart(3)}/${String(total).padEnd(3)} decided`);
}

if (done < MIN_ADJUDICATED) {
	console.error(
		`  ${done} decided, below the floor of ${MIN_ADJUDICATED}. Progress went backwards. ` +
			"Either evidence was deleted or entries fell out when the roster grew; both need an explanation.",
	);
	process.exit(1);
}

if (done < ROSTER_SIZE) {
	const msg = `  ${ROSTER_SIZE - done} still undecided (floor is ${MIN_ADJUDICATED})`;
	if (REQUIRE_COMPLETE) {
		console.error(`${msg} — this gate requires a verdict for every roster entry`);
		process.exit(1);
	}
	console.log(msg);
} else {
	console.log("  Every roster entry has a verdict.");
}
