import { afterEach, describe, expect, it } from "vitest";
import { envVarNames, findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalCopilotGitHubToken = process.env.COPILOT_GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
const originalGitHubToken = process.env.GITHUB_TOKEN;

afterEach(() => {
	if (originalCopilotGitHubToken === undefined) {
		delete process.env.COPILOT_GITHUB_TOKEN;
	} else {
		process.env.COPILOT_GITHUB_TOKEN = originalCopilotGitHubToken;
	}

	if (originalGhToken === undefined) {
		delete process.env.GH_TOKEN;
	} else {
		process.env.GH_TOKEN = originalGhToken;
	}

	if (originalGitHubToken === undefined) {
		delete process.env.GITHUB_TOKEN;
	} else {
		process.env.GITHUB_TOKEN = originalGitHubToken;
	}
});

describe("environment API keys", () => {
	it("does not treat generic GitHub tokens as GitHub Copilot credentials", () => {
		delete process.env.COPILOT_GITHUB_TOKEN;
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toBeUndefined();
		expect(getEnvApiKey("github-copilot")).toBeUndefined();
	});

	it("resolves GitHub Copilot credentials from COPILOT_GITHUB_TOKEN", () => {
		process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toEqual(["COPILOT_GITHUB_TOKEN"]);
		expect(getEnvApiKey("github-copilot")).toBe("copilot-token");
	});

	// pie: crates/ai/src/env_api_keys.rs:56-59 (ds4_uses_dedicated_local_env_var)
	describe("ds4 (pie: crates/ai/src/env_api_keys.rs:22)", () => {
		const originalDs4Key = process.env.DS4_API_KEY;

		afterEach(() => {
			if (originalDs4Key === undefined) {
				delete process.env.DS4_API_KEY;
			} else {
				process.env.DS4_API_KEY = originalDs4Key;
			}
		});

		it('uses a dedicated local env var, matching oracle\'s env_var_names("ds4")', () => {
			expect(envVarNames("ds4")).toEqual(["DS4_API_KEY"]);
		});

		it("resolves the ds4 API key from DS4_API_KEY", () => {
			delete process.env.DS4_API_KEY;
			expect(findEnvKeys("ds4")).toBeUndefined();
			expect(getEnvApiKey("ds4")).toBeUndefined();

			process.env.DS4_API_KEY = "ds4-local-key";
			expect(findEnvKeys("ds4")).toEqual(["DS4_API_KEY"]);
			expect(getEnvApiKey("ds4")).toBe("ds4-local-key");
		});
	});

	// pie: crates/ai/src/env_api_keys.rs:9 openai-codex shares OPENAI_API_KEY with openai
	it("falls back to OPENAI_API_KEY for openai-codex", () => {
		const original = process.env.OPENAI_API_KEY;
		try {
			delete process.env.OPENAI_API_KEY;
			expect(getEnvApiKey("openai-codex")).toBeUndefined();

			process.env.OPENAI_API_KEY = "openai-key";
			expect(envVarNames("openai-codex")).toEqual(["OPENAI_API_KEY"]);
			expect(getEnvApiKey("openai-codex")).toBe("openai-key");
		} finally {
			if (original === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = original;
		}
	});

	// pie: crates/ai/src/env_api_keys.rs:11 google checks GOOGLE_API_KEY before GEMINI_API_KEY
	describe("google", () => {
		const originalGoogleApiKey = process.env.GOOGLE_API_KEY;
		const originalGeminiApiKey = process.env.GEMINI_API_KEY;

		afterEach(() => {
			if (originalGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY;
			else process.env.GOOGLE_API_KEY = originalGoogleApiKey;
			if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
			else process.env.GEMINI_API_KEY = originalGeminiApiKey;
		});

		it("lists GOOGLE_API_KEY before GEMINI_API_KEY", () => {
			expect(envVarNames("google")).toEqual(["GOOGLE_API_KEY", "GEMINI_API_KEY"]);
		});

		it("still resolves from GEMINI_API_KEY alone", () => {
			delete process.env.GOOGLE_API_KEY;
			process.env.GEMINI_API_KEY = "gemini-key";
			expect(getEnvApiKey("google")).toBe("gemini-key");
		});

		it("prefers GOOGLE_API_KEY when both are set", () => {
			process.env.GOOGLE_API_KEY = "google-key";
			process.env.GEMINI_API_KEY = "gemini-key";
			expect(getEnvApiKey("google")).toBe("google-key");
		});
	});

	// pie: crates/ai/src/env_api_keys.rs:26 huggingface checks HUGGINGFACE_API_KEY before HF_TOKEN
	describe("huggingface", () => {
		const originalHuggingfaceApiKey = process.env.HUGGINGFACE_API_KEY;
		const originalHfToken = process.env.HF_TOKEN;

		afterEach(() => {
			if (originalHuggingfaceApiKey === undefined) delete process.env.HUGGINGFACE_API_KEY;
			else process.env.HUGGINGFACE_API_KEY = originalHuggingfaceApiKey;
			if (originalHfToken === undefined) delete process.env.HF_TOKEN;
			else process.env.HF_TOKEN = originalHfToken;
		});

		it("lists HUGGINGFACE_API_KEY before HF_TOKEN", () => {
			expect(envVarNames("huggingface")).toEqual(["HUGGINGFACE_API_KEY", "HF_TOKEN"]);
		});

		it("still resolves from HF_TOKEN alone", () => {
			delete process.env.HUGGINGFACE_API_KEY;
			process.env.HF_TOKEN = "hf-token";
			expect(getEnvApiKey("huggingface")).toBe("hf-token");
		});

		it("prefers HUGGINGFACE_API_KEY when both are set", () => {
			process.env.HUGGINGFACE_API_KEY = "huggingface-key";
			process.env.HF_TOKEN = "hf-token";
			expect(getEnvApiKey("huggingface")).toBe("huggingface-key");
		});
	});

	it("envVarNames returns an empty list for unknown providers", () => {
		expect(envVarNames("totally-unknown-provider")).toEqual([]);
	});
});
