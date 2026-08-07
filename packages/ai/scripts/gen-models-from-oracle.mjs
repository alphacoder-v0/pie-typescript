#!/usr/bin/env node
// Regenerates packages/ai/src/models.generated.ts from the oracle's frozen model catalog
// snapshot, instead of the live-network generator (scripts/generate-models.ts).
//
// Why: packages/ai/src/models.generated.ts previously carried a pi@<SKELETON_PI_SHA> vendor
// snapshot (32 providers / 942 models). Oracle (pie@<ORACLE_PIE_SHA>) freezes 32 providers /
// 938 models, and migration parity scenario S1 asserts that count verbatim ("Supported
// providers (32), models (938)" — see migration/parity/out/oracle/S1/help.norm). Bug-for-bug
// parity requires the TS catalog to equal the oracle catalog, so this script regenerates the
// file from oracle's own crates/ai/src/models.generated.json (self-documented by oracle's
// models_generated.rs as extracted from this same TS file) instead of fetching current
// upstream data. Deterministic and fully offline.
//
// See PROVENANCE.md bootstrap-adaptation entry 7 and
// migration/reviews/ai/divergence-ledger.tsv (unit ai/models_generated) for the full rationale.
//
// Usage: node scripts/gen-models-from-oracle.mjs
// (wired as the default `npm run regen-models`; the old network-based generator is preserved
// as `npm run regen-models:live`.)

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, ".."); // packages/ai
const repoRoot = resolve(packageRoot, "../.."); // repo root

/** Reads ORACLE_PIE_DIR (and ORACLE_PIE_SHA, for the header comment) out of migration/sources.env
 * without requiring a shell to source it (only handles the `$HOME` expansion this repo's
 * sources.env actually uses). */
function loadSourcesEnv() {
	const sourcesEnvPath = join(repoRoot, "migration", "sources.env");
	const raw = readFileSync(sourcesEnvPath, "utf8");

	const dirMatch = raw.match(/^ORACLE_PIE_DIR=(.+)$/m);
	if (!dirMatch) {
		throw new Error(`ORACLE_PIE_DIR not found in ${sourcesEnvPath}`);
	}
	const shaMatch = raw.match(/^ORACLE_PIE_SHA=(.+)$/m);

	const expand = (value) => value.trim().replace(/\$\{?HOME\}?/g, homedir());

	return {
		oraclePieDir: expand(dirMatch[1]),
		oraclePieSha: shaMatch ? shaMatch[1].trim() : "unknown",
	};
}

const { oraclePieDir, oraclePieSha } = loadSourcesEnv();
const oracleJsonPath = join(oraclePieDir, "crates", "ai", "src", "models.generated.json");
const outPath = join(packageRoot, "src", "models.generated.ts");

const catalog = JSON.parse(readFileSync(oracleJsonPath, "utf8"));

// Canonical per-model field order, matching the pre-existing models.generated.ts formatting
// (and packages/ai/src/types.ts's Model<TApi> interface field set). Verified against oracle's
// JSON: every one of its 938 model objects already emits keys in this exact order (id, name,
// api, provider, baseUrl, [headers], [compat], reasoning, [thinkingLevelMap], input, cost,
// contextWindow, maxTokens) — this list is enforced explicitly rather than trusting JSON.parse's
// key-insertion order, so the generator stays correct even if that ever changes upstream.
const FIELD_ORDER = [
	"id",
	"name",
	"api",
	"provider",
	"baseUrl",
	"headers",
	"compat",
	"reasoning",
	"thinkingLevelMap",
	"input",
	"cost",
	"contextWindow",
	"maxTokens",
];
const REQUIRED_FIELDS = [
	"id",
	"name",
	"api",
	"provider",
	"baseUrl",
	"reasoning",
	"input",
	"cost",
	"contextWindow",
	"maxTokens",
];
const KNOWN_FIELDS = new Set(FIELD_ORDER);
const COST_FIELD_ORDER = ["input", "output", "cacheRead", "cacheWrite"];

function serializeStringArray(values) {
	return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}

function serializeCost(cost) {
	const lines = ["\t\t\tcost: {"];
	for (const key of COST_FIELD_ORDER) {
		if (!(key in cost)) {
			throw new Error(`cost object missing "${key}"`);
		}
		lines.push(`\t\t\t\t${key}: ${cost[key]},`);
	}
	lines.push("\t\t\t},");
	return lines.join("\n");
}

function serializeModel(providerKey, modelId, model) {
	for (const key of Object.keys(model)) {
		if (!KNOWN_FIELDS.has(key)) {
			throw new Error(`Unknown model field "${key}" on ${providerKey}/${modelId}`);
		}
	}
	for (const key of REQUIRED_FIELDS) {
		if (!(key in model)) {
			throw new Error(`Missing required field "${key}" on ${providerKey}/${modelId}`);
		}
	}

	const lines = [`\t\t"${modelId}": {`];
	for (const key of FIELD_ORDER) {
		if (!(key in model)) continue;
		const value = model[key];
		switch (key) {
			case "id":
			case "name":
			case "api":
			case "provider":
			case "baseUrl":
				lines.push(`\t\t\t${key}: ${JSON.stringify(value)},`);
				break;
			case "headers":
			case "compat":
			case "thinkingLevelMap":
				lines.push(`\t\t\t${key}: ${JSON.stringify(value)},`);
				break;
			case "reasoning":
				lines.push(`\t\t\treasoning: ${value},`);
				break;
			case "input":
				lines.push(`\t\t\tinput: ${serializeStringArray(value)},`);
				break;
			case "cost":
				lines.push(serializeCost(value));
				break;
			case "contextWindow":
			case "maxTokens":
				lines.push(`\t\t\t${key}: ${value},`);
				break;
			default:
				throw new Error(`Unhandled field "${key}"`);
		}
	}
	lines.push(`\t\t} satisfies Model<${JSON.stringify(model.api)}>,`);
	return lines.join("\n");
}

function serializeProvider(providerKey, models) {
	const lines = [`\t"${providerKey}": {`];
	for (const modelId of Object.keys(models)) {
		if (models[modelId].provider !== providerKey) {
			throw new Error(
				`Model ${providerKey}/${modelId} has mismatched provider field "${models[modelId].provider}"`,
			);
		}
		lines.push(serializeModel(providerKey, modelId, models[modelId]));
	}
	lines.push("\t},");
	return lines.join("\n");
}

const providerKeys = Object.keys(catalog);
const providerBlocks = providerKeys.map((providerKey) => serializeProvider(providerKey, catalog[providerKey]));

const modelCount = providerKeys.reduce((sum, p) => sum + Object.keys(catalog[p]).length, 0);

const header = `// This file is auto-generated by scripts/gen-models-from-oracle.mjs
// Do not edit manually - run 'npm run regen-models' to update
//
// Source of truth: oracle pie@${oraclePieSha}'s crates/ai/src/models.generated.json (frozen
// catalog snapshot; see migration/sources.env ORACLE_PIE_DIR and PROVENANCE.md entry 7).
// Regenerating from live upstream data (models.dev/OpenRouter/AI Gateway) instead is available
// via 'npm run regen-models:live' (scripts/generate-models.ts), but will drift from oracle and
// break migration parity scenario S1.

import type { Model } from "./types.ts";

export const MODELS = {
`;

const footer = `
} as const;
`;

const output = header + providerBlocks.join("\n") + footer;

writeFileSync(outPath, output);

console.log(`Wrote ${outPath}`);
console.log(`providers=${providerKeys.length} models=${modelCount}`);
