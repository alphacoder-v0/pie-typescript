/**
 * phase 20-5: ports two security assertions from upstream `crates/coding-agent`.
 *
 * - `session_archive.rs rejects_unsafe_archive_paths`
 * - `local_models.rs ds4_responses_model_fails_closed_without_ds4_env_even_when_openai_env_exists`
 *
 * The assertions are **upstream's**.
 */
import { envVarNames, getEnvApiKey } from "@pie/ai";
import { describe, expect, it } from "vitest";
import { validateArchivePath } from "../../src/session-archive.ts";

describe("session archives: path validation", () => {
	// pie: crates/coding-agent/src/session_archive.rs `rejects_unsafe_archive_paths`
	//
	// An archive is **external input**: a user may take a session archive from anywhere and import it.
	// Without validating entry paths, a `../` or an absolute path lets the extraction write outside the
	// destination — zip-slip. Upstream's four cases cover both kinds: escaping relative paths, and
	// absolute ones.
	it("an ordinary relative path is allowed; `../` and absolute paths are rejected", () => {
		expect(() => validateArchivePath("manifest.json")).not.toThrow();
		expect(() => validateArchivePath("sidecars/triggers.json")).not.toThrow();

		expect(() => validateArchivePath("../session.jsonl")).toThrow();
		expect(() => validateArchivePath("/tmp/session.jsonl")).toThrow();
	});

	// The extra kinds this side rejects beyond upstream — Windows separators, NUL, empty segments and
	// `.` — are pinned here too, so nothing simplifies them away later.
	it("backslashes, NUL, empty segments and `.` are rejected too", () => {
		expect(() => validateArchivePath("sidecars\\triggers.json")).toThrow();
		expect(() => validateArchivePath("a\0b")).toThrow();
		expect(() => validateArchivePath("a//b")).toThrow();
		expect(() => validateArchivePath("./manifest.json")).toThrow();
	});
});

describe("the scope of ds4 credentials", () => {
	// pie: crates/coding-agent/src/local_models.rs
	//      `ds4_responses_model_fails_closed_without_ds4_env_even_when_openai_env_exists`
	//
	// ds4 uses the openai-responses API family, which makes "just fall back to OPENAI_API_KEY" a very
	// natural slip — and one that sends the user's OpenAI key to a local or third-party endpoint. In
	// upstream's assertion OPENAI_API_KEY is **present**, and that is the crux: without it, this test
	// proves nothing.
	//
	// `env-api-keys.test.ts:59` and `:63` already assert that ds4 accepts only DS4_API_KEY, but neither
	// has OPENAI set at the same time.
	it("with DS4_API_KEY absent it must not fall back, even when OPENAI_API_KEY is present", () => {
		const saved = { ds4: process.env.DS4_API_KEY, openai: process.env.OPENAI_API_KEY };
		try {
			delete process.env.DS4_API_KEY;
			process.env.OPENAI_API_KEY = "openai-should-not-leak";

			// The structural guarantee: ds4's variable table holds only its own.
			expect(envVarNames("ds4")).toEqual(["DS4_API_KEY"]);
			// The behavioral guarantee: it does not resolve even with OPENAI present.
			expect(getEnvApiKey("ds4")).toBeUndefined();
		} finally {
			if (saved.ds4 === undefined) delete process.env.DS4_API_KEY;
			else process.env.DS4_API_KEY = saved.ds4;
			if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = saved.openai;
		}
	});

	// Negative control: with DS4_API_KEY present it has to resolve, or the `toBeUndefined()` above
	// might be passing only because the ds4 provider is not wired into credential resolution at all.
	it("negative control: with DS4_API_KEY present it does resolve", () => {
		const saved = process.env.DS4_API_KEY;
		try {
			process.env.DS4_API_KEY = "ds4-local-key";
			expect(getEnvApiKey("ds4")).toBe("ds4-local-key");
		} finally {
			if (saved === undefined) delete process.env.DS4_API_KEY;
			else process.env.DS4_API_KEY = saved;
		}
	});
});
