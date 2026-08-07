import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const outputPath = join(tmpdir(), "pi-browser-smoke.js");
const errorLogPath = join(tmpdir(), "pi-browser-smoke-errors.log");

/**
 * The entry points.
 *
 * The written rule says both packages are inside the browser bundling surface as whole
 * packages, but this gate previously bundled a single hand-written entry file, which only
 * protects that file's reachable graph rather than the whole package tree. That mismatch
 * was recorded and the decision left open.
 *
 * The decision taken: extend to what a consumer actually imports, meaning each package's
 * public index. Both of those bundle for the browser today, so this is a real tightening
 * at no cost — from now on anything Node-only reaching their graphs fails immediately.
 *
 * It was **not** extended to the whole tree. Several files are Node-only by design and are
 * not on the browser surface at all; bundling everything would produce a pile of expected
 * failures and turn the gate into noise. Guarding the public entry points is what the rule
 */
const ENTRY_POINTS = ["scripts/browser-smoke-entry.ts", "packages/ai/src/index.ts", "packages/agent/src/index.ts"];

try {
	await build({
		entryPoints: ENTRY_POINTS,
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		outdir: outputPath.replace(/\.js$/, "-out"),
	});
	process.exit(0);
} catch (error) {
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location
					? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
					: "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
	console.error(`Browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
