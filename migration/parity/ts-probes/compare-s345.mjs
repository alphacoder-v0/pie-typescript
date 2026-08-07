#!/usr/bin/env node
// compare-s345.mjs — round-2 judge gate for the pilot unit A Responses request-body encoding family
// fixed in packages/ai/src/providers/openai-responses-shared.ts (convertResponsesMessages).
//
// Spawns the TS S3/S4/S5 harness probe (s345-probe.mts), collects its 4 JSON lines, and grades:
//   S3       — usage six fields + cost five fields against the fixed oracle values.
//   S4       — exactly two requests + finalText === "fixture says hi".
//   S5       — seq === [system,user,reasoning,assistant,user] (role/type projection).
//   S5-body  — deep structural diff of the full second-request body against oracle's captured
//              migration/parity/out/oracle/S5/req2body.json: top-level key set, store/stream
//              values, input array shape, and every content/summary sub-item's key set + type +
//              text (masked only for the top-level `model` value and the system item's text —
//              user/assistant/reasoning text must match exactly, per spec).
//
// Prints "PROBE-PARITY: GREEN" and exits 0 on a full pass; otherwise prints every diff and exits 1.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const probePath = join(here, "s345-probe.mts");
const oracleBodyPath = join(repoRoot, "migration/parity/out/oracle/S5/req2body.json");

const failures = [];
function fail(msg) {
	failures.push(msg);
}

function keySet(obj) {
	return new Set(Object.keys(obj ?? {}));
}

function diffKeySets(label, tsKeys, oracleKeys) {
	for (const k of oracleKeys) if (!tsKeys.has(k)) fail(`${label}: missing key "${k}" (present in oracle, absent in TS)`);
	for (const k of tsKeys) if (!oracleKeys.has(k)) fail(`${label}: extra key "${k}" (present in TS, absent in oracle)`);
}

// ---- 1. run the probe, collect its 4 JSON lines ----
const run = spawnSync("npx", ["tsx", probePath], { cwd: repoRoot, encoding: "utf8" });
if (run.status !== 0) {
	console.error("PROBE-PARITY: RED (probe process failed)");
	console.error(run.stdout);
	console.error(run.stderr);
	process.exit(1);
}
const lines = run.stdout
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l));
const byScenario = Object.fromEntries(lines.map((l) => [l.scenario, l]));

for (const s of ["S3", "S4", "S5", "S5-body"]) {
	if (!byScenario[s]) fail(`missing scenario line: ${s}`);
}

// ---- 2. S3: usage six fields + cost five fields ----
if (byScenario.S3) {
	const u = byScenario.S3.usage;
	const expectUsage = { input: 100, output: 10, cacheRead: 80, cacheWrite: 0, totalTokens: 190 };
	for (const [k, v] of Object.entries(expectUsage)) {
		if (u?.[k] !== v) fail(`S3 usage.${k}: expected ${v}, got ${JSON.stringify(u?.[k])}`);
	}
	const expectCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	for (const [k, v] of Object.entries(expectCost)) {
		if (u?.cost?.[k] !== v) fail(`S3 usage.cost.${k}: expected ${v}, got ${JSON.stringify(u?.cost?.[k])}`);
	}
}

// ---- 3. S4: exactly two requests + finalText ----
if (byScenario.S4) {
	const { reqs, finalText } = byScenario.S4;
	if (!Array.isArray(reqs) || reqs.length !== 2) {
		fail(`S4 reqs: expected length 2, got ${JSON.stringify(reqs)}`);
	}
	if (finalText !== "fixture says hi") {
		fail(`S4 finalText: expected "fixture says hi", got ${JSON.stringify(finalText)}`);
	}
}

// ---- 4. S5: seq projection ----
if (byScenario.S5) {
	const seq = byScenario.S5.seq ?? [];
	const projected = seq.map((it) => it.role ?? it.type);
	const expected = ["system", "user", "reasoning", "assistant", "user"];
	if (JSON.stringify(projected) !== JSON.stringify(expected)) {
		fail(`S5 seq: expected ${JSON.stringify(expected)}, got ${JSON.stringify(projected)}`);
	}
}

// ---- 5. S5-body: deep structural diff vs oracle's captured req2body.json ----
function compareSubArray(label, tsArr, oracleArr, { maskText = false } = {}) {
	tsArr = tsArr ?? [];
	oracleArr = oracleArr ?? [];
	if (tsArr.length !== oracleArr.length) {
		fail(`${label}.length: expected ${oracleArr.length}, got ${tsArr.length}`);
		return;
	}
	for (let j = 0; j < oracleArr.length; j++) {
		const subLabel = `${label}[${j}]`;
		const tsSub = tsArr[j];
		const oracleSub = oracleArr[j];
		diffKeySets(subLabel, keySet(tsSub), keySet(oracleSub));
		if (tsSub?.type !== oracleSub?.type) {
			fail(`${subLabel}.type: expected ${JSON.stringify(oracleSub?.type)}, got ${JSON.stringify(tsSub?.type)}`);
		}
		if ("text" in (oracleSub ?? {})) {
			if (maskText) {
				// Masked: the probe's fixed "probe system prompt" differs from pie's real system prompt
				// by design (the spec says the text of the system item differs, because the probe prompt is not
				// pie's system prompt). Only require
				// both sides actually carry a non-empty string, not byte equality.
				if (typeof tsSub?.text !== "string" || tsSub.text.length === 0) {
					fail(`${subLabel}.text: expected a non-empty string (masked), got ${JSON.stringify(tsSub?.text)}`);
				}
			} else if (tsSub?.text !== oracleSub?.text) {
				fail(`${subLabel}.text: expected ${JSON.stringify(oracleSub?.text)}, got ${JSON.stringify(tsSub?.text)}`);
			}
		}
	}
}

function compareInputItem(i, tsItem, oracleItem) {
	const label = `S5-body input[${i}]`;
	if (!tsItem || !oracleItem) {
		fail(`${label}: expected both items present, got ts=${JSON.stringify(tsItem)} oracle=${JSON.stringify(oracleItem)}`);
		return;
	}
	diffKeySets(label, keySet(tsItem), keySet(oracleItem));
	if ("type" in oracleItem || "type" in tsItem) {
		if (tsItem.type !== oracleItem.type) fail(`${label}.type: expected ${JSON.stringify(oracleItem.type)}, got ${JSON.stringify(tsItem.type)}`);
	}
	if ("role" in oracleItem || "role" in tsItem) {
		if (tsItem.role !== oracleItem.role) fail(`${label}.role: expected ${JSON.stringify(oracleItem.role)}, got ${JSON.stringify(tsItem.role)}`);
	}
	const isSystemItem = oracleItem.role === "system";
	if (Array.isArray(oracleItem.content) || Array.isArray(tsItem.content)) {
		compareSubArray(`${label}.content`, tsItem.content, oracleItem.content, { maskText: isSystemItem });
	}
	if (Array.isArray(oracleItem.summary) || Array.isArray(tsItem.summary)) {
		compareSubArray(`${label}.summary`, tsItem.summary, oracleItem.summary, {});
	}
}

if (byScenario["S5-body"]) {
	const tsBody = byScenario["S5-body"].body;
	let oracleBody;
	try {
		oracleBody = JSON.parse(readFileSync(oracleBodyPath, "utf8"));
	} catch (e) {
		fail(`S5-body: could not read/parse oracle capture at ${oracleBodyPath}: ${e.message}`);
		oracleBody = null;
	}

	if (oracleBody && tsBody) {
		// Top-level key set, EXCLUDING "tools": the S345 probe drives streamOpenAIResponses directly
		// against a bare Context (no `tools`), while oracle's S5 capture came from a real
		// pie-coding-agent CLI session that always attaches its full built-in tool registry (~23 tools
		// with verbose JSON-Schema descriptions, defined in a different package entirely). Tool-schema
		// serialization is a separate parity concern (convertResponsesTools / oracle's
		// serialize_tools, openai_responses.rs:648-660) outside the message-encoding family this round
		// fixes, so it's excluded here rather than silently replicated or silently ignored.
		const EXCLUDED_TOP_KEYS = new Set(["tools"]);
		const tsKeys = new Set(Object.keys(tsBody).filter((k) => !EXCLUDED_TOP_KEYS.has(k)));
		const oracleKeys = new Set(Object.keys(oracleBody).filter((k) => !EXCLUDED_TOP_KEYS.has(k)));
		diffKeySets("S5-body top-level", tsKeys, oracleKeys);

		// model: masked value, presence-only check (already covered by the key-set check above; a
		// missing/empty string is still worth flagging explicitly).
		if (typeof tsBody.model !== "string" || tsBody.model.length === 0) {
			fail(`S5-body model: expected a non-empty string (masked), got ${JSON.stringify(tsBody.model)}`);
		}

		// store/stream: exact value equality
		if (tsBody.store !== oracleBody.store) fail(`S5-body store: expected ${JSON.stringify(oracleBody.store)}, got ${JSON.stringify(tsBody.store)}`);
		if (tsBody.stream !== oracleBody.stream) fail(`S5-body stream: expected ${JSON.stringify(oracleBody.stream)}, got ${JSON.stringify(tsBody.stream)}`);

		// input array: length + per-item key set/type/role, recursing into content/summary sub-items
		const tsInput = tsBody.input ?? [];
		const oracleInput = oracleBody.input ?? [];
		if (tsInput.length !== oracleInput.length) {
			fail(`S5-body input.length: expected ${oracleInput.length}, got ${tsInput.length}`);
		} else {
			for (let i = 0; i < oracleInput.length; i++) {
				compareInputItem(i, tsInput[i], oracleInput[i]);
			}
		}
	}
}

if (failures.length === 0) {
	console.log("PROBE-PARITY: GREEN");
	process.exit(0);
} else {
	console.error(`PROBE-PARITY: RED (${failures.length} diff${failures.length === 1 ? "" : "s"})`);
	for (const f of failures) console.error(` - ${f}`);
	process.exit(1);
}
