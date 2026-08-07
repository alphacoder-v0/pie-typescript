#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getOAuthProvider, getOAuthProviders } from "./utils/oauth/index.ts";
import type { OAuthCredentials, OAuthProviderId } from "./utils/oauth/types.ts";

/**
 * Where this CLI keeps OAuth credentials.
 *
 * This used to be the bare relative string `"auth.json"`, so `pi-ai login <provider>` wrote the
 * access and refresh tokens into **whatever directory the user happened to be standing in**, with
 * default permissions. Run it once inside a repository and the credentials land next to the source,
 * unignored (this repo's own .gitignore covers only `.env`) and readable by every account on the
 * machine. Nothing warned about it and nothing cleaned it up.
 *
 * Resolved under the user config directory instead, mirroring
 * `packages/coding-agent/src/config.ts`'s `getAgentDir()` precedence — PIE_DIR verbatim, then
 * PI_CODING_AGENT_DIR, then ~/.pie. The precedence is duplicated rather than imported because
 * RULEBOOK §4 forbids `ai` depending on `coding-agent`; the two must be kept in step by hand.
 *
 * The stored shape is byte-identical to what coding-agent's auth-storage writes
 * (`Record<providerId, {type:"oauth"} & OAuthCredentials>`, auth-storage.ts:715), so pointing both
 * at the same file unifies them rather than colliding.
 */
function authDir(): string {
	const baseDirOverride = process.env.PIE_DIR;
	if (baseDirOverride) return baseDirOverride;
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return envDir === "~" ? homedir() : envDir.startsWith("~/") ? homedir() + envDir.slice(1) : envDir;
	return join(homedir(), ".pie");
}

function authFile(): string {
	return join(authDir(), "auth.json");
}

const PROVIDERS = getOAuthProviders();

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => rl.question(question, resolve));
}

function loadAuth(): Record<string, { type: "oauth" } & OAuthCredentials> {
	const file = authFile();
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return {};
	}
}

function saveAuth(auth: Record<string, { type: "oauth" } & OAuthCredentials>): void {
	// 0700 dir / 0600 file: these are bearer tokens. `mode` on writeFileSync applies only when the
	// file is created, so an existing file deliberately keeps whatever the owner set rather than
	// being silently re-chmodded underneath them.
	mkdirSync(authDir(), { recursive: true, mode: 0o700 });
	writeFileSync(authFile(), JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });
}

async function login(providerId: OAuthProviderId): Promise<void> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		console.error(`Unknown provider: ${providerId}`);
		process.exit(1);
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const promptFn = (msg: string) => prompt(rl, `${msg} `);

	try {
		const credentials = await provider.login({
			onAuth: (info) => {
				console.log(`\nOpen this URL in your browser:\n${info.url}`);
				if (info.instructions) console.log(info.instructions);
				console.log();
			},
			onPrompt: async (p) => {
				return await promptFn(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}:`);
			},
			onProgress: (msg) => console.log(msg),
		});

		const auth = loadAuth();
		auth[providerId] = { type: "oauth", ...credentials };
		saveAuth(auth);

		// The resolved absolute path, not a bare filename: the user needs to know *where* their
		// tokens now live, especially since this used to be the current directory.
		console.log(`\nCredentials saved to ${authFile()}`);
	} finally {
		rl.close();
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "help" || command === "--help" || command === "-h") {
		const providerList = PROVIDERS.map((p) => `  ${p.id.padEnd(20)} ${p.name}`).join("\n");
		console.log(`Usage: npx @pie/ai <command> [provider]

Commands:
  login [provider]  Login to an OAuth provider
  list              List available providers

Providers:
${providerList}

Examples:
  npx @pie/ai login              # interactive provider selection
  npx @pie/ai login anthropic    # login to specific provider
  npx @pie/ai list               # list providers
`);
		return;
	}

	if (command === "list") {
		console.log("Available OAuth providers:\n");
		for (const p of PROVIDERS) {
			console.log(`  ${p.id.padEnd(20)} ${p.name}`);
		}
		return;
	}

	if (command === "login") {
		let provider = args[1] as OAuthProviderId | undefined;

		if (!provider) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			console.log("Select a provider:\n");
			for (let i = 0; i < PROVIDERS.length; i++) {
				console.log(`  ${i + 1}. ${PROVIDERS[i].name}`);
			}
			console.log();

			const choice = await prompt(rl, `Enter number (1-${PROVIDERS.length}): `);
			rl.close();

			const index = parseInt(choice, 10) - 1;
			if (index < 0 || index >= PROVIDERS.length) {
				console.error("Invalid selection");
				process.exit(1);
			}
			provider = PROVIDERS[index].id;
		}

		if (!PROVIDERS.some((p) => p.id === provider)) {
			console.error(`Unknown provider: ${provider}`);
			console.error(`Use 'npx @pie/ai list' to see available providers`);
			process.exit(1);
		}

		console.log(`Logging in to ${provider}...`);
		await login(provider);
		return;
	}

	console.error(`Unknown command: ${command}`);
	console.error(`Use 'npx @pie/ai --help' for usage`);
	process.exit(1);
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
