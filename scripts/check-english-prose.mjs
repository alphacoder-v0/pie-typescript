#!/usr/bin/env node
/**
 * Fails when Chinese prose appears where English is expected.
 *
 * ## Why this is not simply "no CJK anywhere"
 *
 * Some Chinese in this repository is not prose — it is what the program matches on.
 * The trigger parser splits sentences on Chinese connectives, the cron parser
 * recognises Chinese schedule aliases, and the system prompt lists Chinese trigger
 * words for the model to key on. Test fixtures use CJK strings deliberately, to
 * exercise column width (one character, two columns), token estimation for
 * non-ASCII text, surrogate pair handling, and hashing of non-ASCII input.
 *
 * Translating any of those changes behavior. The parity harness compares bytes
 * against the upstream implementation, so it would notice.
 *
 * So the check reports two numbers instead of one:
 *
 *   - prose Chinese, which must be zero
 *   - allowlisted Chinese, which must match `migration/cjk-allowlist.tsv` exactly
 *
 * The second number matters as much as the first. If it drops, someone translated a
 * literal the program depends on. If it grows, someone added Chinese without
 * recording why it has to stay.
 *
 * ## Usage
 *
 *   node scripts/check-english-prose.mjs
 *   node scripts/check-english-prose.mjs --list    print every offending line
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = join(repoRoot, "migration/cjk-allowlist.tsv");

/**
 * Any codepoint in the CJK Unified Ideographs block.
 *
 * Written as escapes rather than literal characters so that this file does not
 * report itself. A character class containing real ideographs is indistinguishable
 * from prose to the check that reads it.
 */
const CJK = /[\u4e00-\u9fff]/;

/**
 * Files whose prose must be English. Audit write-ups under `migration/reviews`
 * are excluded: they are a separate body of work and no gate parses them.
 */
const TARGET_GLOBS = [
	// Both forms are needed: `**` requires at least one intermediate directory, so
	// `packages/*/test/**/*.ts` silently misses every file sitting directly in `test/`.
	"packages/*/src/*.ts",
	"packages/*/src/**/*.ts",
	"packages/*/test/*.ts",
	"packages/*/test/**/*.ts",
	"scripts/*.mjs",
	"migration/*.tsv",
	"migration/*.md",
	"migration/parity/**/*",
	"migration/scripts/*",
	"migration/reviews/*/*.tsv",
];

/**
 * `--only <glob>` narrows the check to a subset. It exists for negative controls:
 * proving the check can fail requires a scope where the guarded condition already
 * holds, and the full repository does not qualify while translation is in progress.
 *
 * Narrowing the scope narrows the allowlist with it. Without that, every allowlist
 * row outside the subset reports as unaccounted and the resulting failure says
 * nothing about the Chinese the control just injected.
 */
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

function targetFiles() {
	// `--others --exclude-standard` includes files that are not staged yet. Without it
	// a newly written file is invisible to this check until someone commits it, which is
	// exactly backwards: the moment to catch untranslated prose is before the commit.
	const flags = "--cached --others --exclude-standard";
	if (ONLY) {
		const out = execSync(`git ls-files ${flags} '${ONLY}'`, { cwd: repoRoot, encoding: "utf-8" });
		return [...new Set(out.split("\n").filter(Boolean))];
	}
	const out = execSync(`git ls-files ${flags} ${TARGET_GLOBS.map((g) => `'${g}'`).join(" ")}`, {
		cwd: repoRoot,
		encoding: "utf-8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return [...new Set(out.split("\n").filter(Boolean))].filter(
		(f) => !/^migration\/reviews\/.*\.md$/.test(f),
	);
}

function readAllowlist() {
	if (!existsSync(ALLOWLIST)) {
		console.error(`check:english-prose: ${ALLOWLIST} is missing`);
		process.exit(1);
	}
	const rows = readFileSync(ALLOWLIST, "utf-8").trim().split("\n").slice(1);
	const byKey = new Map();
	for (const row of rows) {
		const [path, line, kind, reason] = row.split("\t");
		if (!path || !line) continue;
		byKey.set(`${path}:${line}`, { kind, reason });
	}
	return byKey;
}

const allow = readAllowlist();
const list = process.argv.includes("--list");

let prose = 0;
let allowed = 0;
const proseHits = [];
const unaccounted = [];
const seenAllowKeys = new Set();

for (const rel of targetFiles()) {
	const abs = join(repoRoot, rel);
	if (!existsSync(abs)) continue;
	let text;
	try {
		text = readFileSync(abs, "utf-8");
	} catch {
		continue; // binary or unreadable; nothing to check
	}
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!CJK.test(lines[i])) continue;
		const key = `${rel}:${i + 1}`;
		if (allow.has(key)) {
			allowed += 1;
			seenAllowKeys.add(key);
			continue;
		}
		prose += 1;
		proseHits.push([key, lines[i].trim().slice(0, 90)]);
	}
}

// An allowlist row whose line no longer contains Chinese means the literal was
// translated after all, or the file shifted and the row now points somewhere else.
// Either way the allowlist has stopped describing reality.
const scanned = new Set(targetFiles());
for (const key of allow.keys()) {
	// Only rows whose file was actually scanned can be judged. Under `--only` the
	// rest were never looked at, so calling them unaccounted would be false.
	const file = key.slice(0, key.lastIndexOf(":"));
	if (!scanned.has(file)) continue;
	if (!seenAllowKeys.has(key)) unaccounted.push(key);
}

console.log(
	`check:english-prose: prose Chinese ${prose} (must be 0) · allowlisted ${allowed} of ${allow.size}`,
);

if (unaccounted.length > 0) {
	console.error(`  ${unaccounted.length} allowlist rows no longer point at Chinese:`);
	for (const k of unaccounted.slice(0, 10)) console.error(`    ${k}`);
	console.error("  Either a behavioral literal was translated, or the line numbers moved.");
	process.exit(1);
}

if (prose > 0) {
	console.error(`  ${prose} lines of Chinese prose remain:`);
	for (const [key, text] of proseHits.slice(0, list ? proseHits.length : 15)) {
		console.error(`    ${key}  ${text}`);
	}
	if (!list && proseHits.length > 15) {
		console.error(`    … ${proseHits.length - 15} more (--list to see all)`);
	}
	process.exit(1);
}

console.log("  All prose in the target set is English.");
