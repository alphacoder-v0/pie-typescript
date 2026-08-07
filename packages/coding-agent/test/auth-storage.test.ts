import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider } from "@pie/ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_BASE_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	describe("API key resolution", () => {
		test("literal API key is returned directly", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "sk-ant-literal-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("sk-ant-literal-key");
		});

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo test-api-key-from-command" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo '  spaced-key  '" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf 'line1\\nline2'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!exit 1" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!nonexistent-command-12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf ''" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeAuthJson({
				anthropic: { type: "api_key", key: "literal_api_key_value" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo 'hello world' | tr ' ' '-'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("hello-world");
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				// Use a command that writes to a file to count invocations
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				// Call multiple times
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");

				// Command should have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across AuthStorage instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				// Create multiple AuthStorage instances
				const storage1 = AuthStorage.create(authJsonPath);
				await storage1.getApiKey("anthropic");

				const storage2 = AuthStorage.create(authJsonPath);
				await storage2.getApiKey("anthropic");

				// Command should still have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("clearConfigValueCache allows command to run again", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);
				await authStorage.getApiKey("anthropic");

				// Clear cache and call again
				clearConfigValueCache();
				await authStorage.getApiKey("anthropic");

				// Command should have run twice
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands are cached separately", async () => {
				writeAuthJson({
					anthropic: { type: "api_key", key: "!echo key-anthropic" },
					openai: { type: "api_key", key: "!echo key-openai" },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const keyA = await authStorage.getApiKey("anthropic");
				const keyB = await authStorage.getApiKey("openai");

				expect(keyA).toBe("key-anthropic");
				expect(keyB).toBe("key-openai");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				// Call multiple times - all should return undefined
				const key1 = await authStorage.getApiKey("anthropic");
				const key2 = await authStorage.getApiKey("anthropic");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				// Command should have only run once despite failures
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_AUTH_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeAuthJson({
						anthropic: { type: "api_key", key: envVarName },
					});

					authStorage = AuthStorage.create(authJsonPath);

					const key1 = await authStorage.getApiKey("anthropic");
					expect(key1).toBe("first-value");

					// Change env var
					process.env[envVarName] = "second-value";

					const key2 = await authStorage.getApiKey("anthropic");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});

	describe("oauth lock compromise handling", () => {
		test("returns undefined on compromised lock and allows a later retry", async () => {
			const providerId = `test-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return {
						...credentials,
						access: "refreshed-access-token",
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});

			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			const realLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi.spyOn(lockfile, "lock");
			lockSpy.mockImplementationOnce(async (file, options) => {
				options?.onCompromised?.(new Error("Unable to update lock within the stale threshold"));
				return realLock(file, options);
			});

			const firstTry = await authStorage.getApiKey(providerId);
			expect(firstTry).toBeUndefined();

			lockSpy.mockRestore();

			const secondTry = await authStorage.getApiKey(providerId);
			expect(secondTry).toBe("Bearer refreshed-access-token");
		});
	});

	describe("persistence semantics", () => {
		test("set preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic.key).toBe("new-anthropic");
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("remove preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic).toBeUndefined();
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		// pie: commands.rs:1997-2011 (`save_api_key`) -- a failed `AuthStore::load()` aborts the
		// save AND returns `Err("load auth store: {e}")`; the malformed file is left untouched and
		// the caller is told. Both halves are asserted here: silently returning success while
		// nothing reaches disk is the bug this guards against.
		test("does not overwrite malformed auth file after load error, and reports the failure", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			expect(() => authStorage.set("openai", { type: "api_key", key: "openai-key" })).toThrow(/load auth store/);

			const raw = readFileSync(authJsonPath, "utf-8");
			expect(raw).toBe("{invalid-json");
			// Nothing was mutated in memory either -- oracle mutates only after a successful load.
			expect(authStorage.get("openai")).toBeUndefined();
		});

		test("remove reports the failure and leaves a malformed auth file untouched", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			// pie: commands.rs:2032-2036 -- `/logout` returns `CommandOutcome::Error` on load failure.
			expect(() => authStorage.remove("anthropic")).toThrow(/load auth store/);

			expect(readFileSync(authJsonPath, "utf-8")).toBe("{invalid-json");
			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });
		});

		// pie: auth.rs:96-115 (`AuthStore::save_to`) -- tmp file -> chmod 0600 -> rename.
		describe("persists atomically (tmp -> chmod 0600 -> rename)", () => {
			test("a write that dies part-way leaves the previous auth.json fully intact", () => {
				writeAuthJson({ anthropic: { type: "api_key", key: "anthropic-key" } });
				authStorage = AuthStorage.create(authJsonPath);

				// Force the payload write to fail (EISDIR) at exactly the point where the old
				// in-place `writeFileSync(authPath, ...)` would already have truncated the real
				// auth.json. Because the bytes go to `<path>.tmp` and only a rename publishes
				// them, the live file must be untouched -- the same guarantee oracle gets from
				// its rename-temp write.
				mkdirSync(`${authJsonPath}.tmp`);

				expect(() => authStorage.set("openai", { type: "api_key", key: "openai-key" })).toThrow();

				const raw = readFileSync(authJsonPath, "utf-8");
				expect(JSON.parse(raw)).toEqual({ anthropic: { type: "api_key", key: "anthropic-key" } });

				// Not truncated => the next start does not land in the "parse error latches
				// loadError and silently disables all writes" trap.
				rmSync(`${authJsonPath}.tmp`, { recursive: true });
				const reopened = AuthStorage.create(authJsonPath);
				expect(reopened.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });
				expect(() => reopened.set("openai", { type: "api_key", key: "openai-key" })).not.toThrow();
			});

			test("no temp file is left behind after a successful write", () => {
				writeAuthJson({ anthropic: { type: "api_key", key: "anthropic-key" } });
				authStorage = AuthStorage.create(authJsonPath);
				authStorage.set("openai", { type: "api_key", key: "openai-key" });
				expect(existsSync(`${authJsonPath}.tmp`)).toBe(false);
				expect(JSON.parse(readFileSync(authJsonPath, "utf-8"))).toEqual({
					anthropic: { type: "api_key", key: "anthropic-key" },
					openai: { type: "api_key", key: "openai-key" },
				});
			});

			// chmod is a no-op for POSIX mode bits on Windows.
			describe.skipIf(process.platform === "win32")("file mode", () => {
				test("loading does not create auth.json; the first write creates it 0600 under a permissive umask", () => {
					const previousUmask = process.umask(0o000);
					try {
						// pie: crates/coding-agent/src/auth.rs:79-91 (`AuthStore::load_from`) --
						// `if !path.exists() { return Ok(Self::default()); }`. Reading credentials must
						// leave the filesystem untouched; constructing a store for a user who has never
						// logged in used to mint an empty `~/.pie/auth.json` (parity S7 caught it).
						authStorage = AuthStorage.create(authJsonPath);
						expect(existsSync(authJsonPath)).toBe(false);
						// FileAuthStorageBackend.ensureFileExists still runs on the first write, and
						// still creates the file 0600 regardless of umask.
						authStorage.set("anthropic", { type: "api_key", key: "anthropic-key" });
						expect(existsSync(authJsonPath)).toBe(true);
						expect(statSync(authJsonPath).mode & 0o777).toBe(0o600);
					} finally {
						process.umask(previousUmask);
					}
				});

				test("the persisted auth.json is 0600 even under a permissive umask", () => {
					const previousUmask = process.umask(0o000);
					try {
						authStorage = AuthStorage.create(authJsonPath);
						authStorage.set("anthropic", { type: "api_key", key: "anthropic-key" });
						expect(statSync(authJsonPath).mode & 0o777).toBe(0o600);
					} finally {
						process.umask(previousUmask);
					}
				});

				test("a pre-existing world-readable temp file cannot publish credentials at 0666", () => {
					// A `<path>.tmp` left over from an earlier crash (or planted by another local
					// process) keeps its own mode through `writeFileSync` -- the explicit
					// chmod-before-rename (pie: auth.rs:106-113) is what stops those bytes from
					// being published world-readable.
					writeAuthJson({ anthropic: { type: "api_key", key: "anthropic-key" } });
					writeFileSync(`${authJsonPath}.tmp`, "stale", { mode: 0o666 });
					chmodSync(`${authJsonPath}.tmp`, 0o666);

					authStorage = AuthStorage.create(authJsonPath);
					authStorage.set("openai", { type: "api_key", key: "openai-key" });

					expect(statSync(authJsonPath).mode & 0o777).toBe(0o600);
					expect(readFileSync(authJsonPath, "utf-8")).toContain("openai-key");
				});
			});
		});

		// pie: auth.rs:86-88 -- `if text.trim().is_empty() { return Ok(Self::default()); }`.
		// Regression guard: `"\n"` is truthy in JS, so a whitespace-only auth.json used to blow up
		// in JSON.parse, latch into `loadError`, and make every later `set()` a silent no-op --
		// the user saw "logged in" and lost the credential on restart.
		describe("blank auth.json is an empty store, not a parse error", () => {
			for (const [label, blank] of [
				["a single newline", "\n"],
				["an empty file", ""],
				["spaces and tabs", "  \t "],
				["CRLF", "\r\n"],
			] as const) {
				test(`${label} loads empty and still persists a later login`, () => {
					writeFileSync(authJsonPath, blank, "utf-8");

					authStorage = AuthStorage.create(authJsonPath);
					expect(authStorage.list()).toEqual([]);
					expect(authStorage.drainErrors()).toEqual([]);

					// The observable failure: /login must actually reach disk.
					expect(() => authStorage.set("foo", { type: "api_key", key: "foo-key" })).not.toThrow();
					expect(authStorage.get("foo")).toEqual({ type: "api_key", key: "foo-key" });

					const onDisk = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
					expect(onDisk).toEqual({ foo: { type: "api_key", key: "foo-key" } });

					// And survives a restart.
					const reopened = AuthStorage.create(authJsonPath);
					expect(reopened.get("foo")).toEqual({ type: "api_key", key: "foo-key" });
				});
			}

			test("a blank file written after load does not disable persistence", () => {
				writeAuthJson({ anthropic: { type: "api_key", key: "anthropic-key" } });
				authStorage = AuthStorage.create(authJsonPath);

				// Interrupted external write leaves only a newline behind.
				writeFileSync(authJsonPath, "\n", "utf-8");
				authStorage.reload();
				expect(authStorage.list()).toEqual([]);

				authStorage.set("openai", { type: "api_key", key: "openai-key" });
				const onDisk = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
				expect(onDisk).toEqual({ openai: { type: "api_key", key: "openai-key" } });
			});
		});

		// pie: mcp_loader.rs:319-320 / commands.rs:1998-2000 -- `AuthStore::load()?`: a store that
		// will not load must abort the operation with an error, not read as an empty store.
		describe("getLoadError", () => {
			test("is undefined for a clean load", () => {
				writeAuthJson({ anthropic: { type: "api_key", key: "anthropic-key" } });
				authStorage = AuthStorage.create(authJsonPath);
				expect(authStorage.getLoadError()).toBeUndefined();
			});

			test("is undefined for missing / empty / whitespace-only files (pie: auth.rs:78-88)", () => {
				expect(AuthStorage.create(join(tempDir, "absent.json")).getLoadError()).toBeUndefined();

				writeFileSync(authJsonPath, "", "utf-8");
				expect(AuthStorage.create(authJsonPath).getLoadError()).toBeUndefined();

				writeFileSync(authJsonPath, "\n \t\n", "utf-8");
				expect(AuthStorage.create(authJsonPath).getLoadError()).toBeUndefined();
			});

			test("reports a real parse failure and is non-destructive", () => {
				writeFileSync(authJsonPath, "{invalid-json", "utf-8");
				authStorage = AuthStorage.create(authJsonPath);

				const first = authStorage.getLoadError();
				expect(first).toBeInstanceOf(Error);
				// Repeated reads return the same value -- unlike drainErrors(), reading does not
				// consume it, so an injected store can be inspected by more than one caller.
				expect(authStorage.getLoadError()).toBe(first);
				expect(authStorage.drainErrors().length).toBeGreaterThan(0);
				expect(authStorage.getLoadError()).toBe(first);
			});

			test("is cleared by a successful reload", () => {
				writeFileSync(authJsonPath, "{invalid-json", "utf-8");
				authStorage = AuthStorage.create(authJsonPath);
				expect(authStorage.getLoadError()).toBeInstanceOf(Error);

				writeAuthJson({ anthropic: { type: "api_key", key: "anthropic-key" } });
				authStorage.reload();
				expect(authStorage.getLoadError()).toBeUndefined();
				expect(() => authStorage.set("openai", { type: "api_key", key: "k" })).not.toThrow();
			});

			test("agrees with set/remove: while it reports an error, persisting throws", () => {
				writeFileSync(authJsonPath, "{invalid-json", "utf-8");
				authStorage = AuthStorage.create(authJsonPath);

				expect(authStorage.getLoadError()).toBeInstanceOf(Error);
				expect(() => authStorage.set("openai", { type: "api_key", key: "k" })).toThrow(/load auth store/);
				expect(() => authStorage.remove("openai")).toThrow(/load auth store/);
			});
		});

		test("reload records parse errors and drainErrors clears buffer", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			// Keeps previous in-memory data on reload failure
			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			const firstDrain = authStorage.drainErrors();
			expect(firstDrain.length).toBeGreaterThan(0);
			expect(firstDrain[0]).toBeInstanceOf(Error);

			const secondDrain = authStorage.drainErrors();
			expect(secondDrain).toHaveLength(0);
		});
	});

	describe("auth status", () => {
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				openai: {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-access-token");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-refresh-token");
		});
	});

	describe("runtime overrides", () => {
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});

		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
	});

	// pie: crates/coding-agent/src/auth.rs -- diff-port unit (manifest `coding-agent/auth`). See
	// this file's module-doc "diff-port note" for the full storage-location/format/precedence
	// writeup and divergence-ledger.tsv's `coding-agent/auth` row for the ledger entry.
	describe("diff-port: oracle auth.rs alignment", () => {
		let originalPieDir: string | undefined;
		let tempAgentDir: string;

		beforeEach(() => {
			tempAgentDir = join(
				tmpdir(),
				`pi-test-auth-storage-agentdir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			originalPieDir = process.env[ENV_BASE_DIR];
			process.env[ENV_BASE_DIR] = tempAgentDir;
		});

		afterEach(() => {
			if (originalPieDir === undefined) {
				delete process.env[ENV_BASE_DIR];
			} else {
				process.env[ENV_BASE_DIR] = originalPieDir;
			}
			if (existsSync(tempAgentDir)) {
				rmSync(tempAgentDir, { recursive: true, force: true });
			}
		});

		test("AuthStorage.create() with no explicit path resolves against getAgentDir() (pie: auth.rs:21-23 auth_path())", () => {
			const storage = AuthStorage.create();
			storage.set("anthropic", { type: "api_key", key: "sk-agent-dir-default" });

			const expectedPath = join(tempAgentDir, "auth.json");
			expect(existsSync(expectedPath)).toBe(true);
			const onDisk = JSON.parse(readFileSync(expectedPath, "utf-8")) as Record<string, { key: string }>;
			expect(onDisk.anthropic.key).toBe("sk-agent-dir-default");
		});

		// FLIPPED 2026-08-04. This test used to pin the opposite assertion ("stored-should-win"),
		// characterizing an escalated, not-applied divergence. It now pins oracle's actual behavior:
		// `resolve_for_provider` (auth.rs:129-143) iterates the provider's env vars FIRST and only
		// falls back to `auth.json` -- "Env var wins; auth.json is the fallback", oracle's own doc
		// comment. Exporting ANTHROPIC_API_KEY to override a stale or revoked stored login is the
		// standard CLI escape hatch, and it was a no-op on this port while the order was inverted.
		test("getApiKey prefers the environment variable over the stored auth.json credential (pie: auth.rs:129-143 resolve_for_provider, 'env var wins')", async () => {
			const envVar = "ANTHROPIC_API_KEY";
			const originalEnv = process.env[envVar];
			process.env[envVar] = "env-should-win";
			try {
				const storage = AuthStorage.create(join(tempAgentDir, "auth.json"));
				storage.set("anthropic", { type: "api_key", key: "stored-should-lose" });

				expect(await storage.getApiKey("anthropic")).toBe("env-should-win");
			} finally {
				if (originalEnv === undefined) {
					delete process.env[envVar];
				} else {
					process.env[envVar] = originalEnv;
				}
			}
		});

		// The other half of oracle's rule: with no env var set, auth.json IS the credential.
		// pie: auth.rs:139-142 -- the `match self.providers.get(provider)?` arm, reached only after
		// the env loop finds nothing.
		test("getApiKey falls back to the stored credential when no env var is set (pie: auth.rs:139-142)", async () => {
			const envVar = "ANTHROPIC_API_KEY";
			const originalEnv = process.env[envVar];
			delete process.env[envVar];
			try {
				const storage = AuthStorage.create(join(tempAgentDir, "auth.json"));
				storage.set("anthropic", { type: "api_key", key: "stored-is-the-fallback" });

				expect(await storage.getApiKey("anthropic")).toBe("stored-is-the-fallback");
			} finally {
				if (originalEnv !== undefined) {
					process.env[envVar] = originalEnv;
				}
			}
		});

		// pie: auth.rs:134 (`if !v.trim().is_empty()`) -- oracle skips a blank env var rather than
		// returning it, so a stored credential still wins over a whitespace-only ANTHROPIC_API_KEY.
		test("getApiKey ignores a blank env var and uses the stored credential (pie: auth.rs:134)", async () => {
			const envVar = "ANTHROPIC_API_KEY";
			const originalEnv = process.env[envVar];
			process.env[envVar] = "   ";
			try {
				const storage = AuthStorage.create(join(tempAgentDir, "auth.json"));
				storage.set("anthropic", { type: "api_key", key: "stored-beats-blank-env" });

				expect(await storage.getApiKey("anthropic")).toBe("stored-beats-blank-env");
			} finally {
				if (originalEnv === undefined) {
					delete process.env[envVar];
				} else {
					process.env[envVar] = originalEnv;
				}
			}
		});

		// A runtime override (CLI --api-key) is a pi-only surface with no oracle counterpart --
		// oracle's `resolve_for_provider` reads env + auth.json and nothing else. It stays ABOVE the
		// env var, where it already was, so aligning the env/auth.json order did not disturb it.
		test("a runtime override still outranks the environment variable", async () => {
			const envVar = "ANTHROPIC_API_KEY";
			const originalEnv = process.env[envVar];
			process.env[envVar] = "env-should-lose-to-runtime";
			try {
				const storage = AuthStorage.create(join(tempAgentDir, "auth.json"));
				storage.setRuntimeApiKey("anthropic", "runtime-wins");

				expect(await storage.getApiKey("anthropic")).toBe("runtime-wins");
			} finally {
				if (originalEnv === undefined) {
					delete process.env[envVar];
				} else {
					process.env[envVar] = originalEnv;
				}
			}
		});
	});

	// ED14 (phase 19). Phases 9/12 put both binaries on the same `~/.pie/auth.json`, so a user
	// upgrading from Rust pie arrives with a file in oracle's shape. The read side accepts both
	// shapes; the write side is unchanged and still emits this port's flat shape.
	//
	// Fixtures below are oracle's literal serialization, read off
	// `$ORACLE_PIE_DIR/crates/coding-agent/src/auth.rs:25-73`:
	//   #[serde(tag = "kind", rename_all = "snake_case")] enum ProviderCredential {
	//       ApiKey { value: String },
	//       Oauth { access_token, refresh_token: Option<String>, expires_at: Option<i64> /* Unix
	//               epoch SECONDS */, #[serde(default)] scopes: Vec<String> } }
	//   struct AuthStore { #[serde(default = "default_version")] version: u32,
	//                      #[serde(default)] providers: HashMap<String, ProviderCredential> }
	// `refresh_token`/`expires_at` are `skip_serializing_if = "Option::is_none"`; `scopes` is not,
	// so it is always present on a saved Oauth entry.
	describe("ED14: a Rust-pie (oracle-shape) auth.json survives the upgrade", () => {
		function writeRustPieAuthJson(providers: Record<string, unknown>, version: number | undefined = 1) {
			const store = version === undefined ? { providers } : { version, providers };
			writeFileSync(authJsonPath, JSON.stringify(store, null, 2));
		}

		describe("reads oracle's shape", () => {
			test("an api_key entry is still a usable login (oracle: ProviderCredential::ApiKey)", async () => {
				writeRustPieAuthJson({ anthropic: { kind: "api_key", value: "sk-oracle-stored" } });

				authStorage = AuthStorage.create(authJsonPath);

				expect(authStorage.getLoadError()).toBeUndefined();
				expect(authStorage.list()).toEqual(["anthropic"]);
				expect(authStorage.has("anthropic")).toBe(true);
				expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "sk-oracle-stored" });
				expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
				expect(await authStorage.getApiKey("anthropic")).toBe("sk-oracle-stored");
			});

			test("an oauth entry maps access_token/refresh_token and converts expires_at seconds to ms", () => {
				writeRustPieAuthJson({
					anthropic: {
						kind: "oauth",
						access_token: "tok",
						refresh_token: "rtok",
						expires_at: 1_900_000_000,
						scopes: ["chat"],
					},
				});

				authStorage = AuthStorage.create(authJsonPath);

				expect(authStorage.get("anthropic")).toEqual({
					type: "oauth",
					access: "tok",
					refresh: "rtok",
					expires: 1_900_000_000_000,
					// Oracle-only field: no slot in this port's credential, so it is carried
					// verbatim instead of being dropped on the next write.
					rustPieFields: { scopes: ["chat"] },
				});
			});

			test("explicit nulls for oracle's Option fields deserialize like absent ones", () => {
				// `Option<String>`/`Option<i64>` accept both an absent key and an explicit null.
				writeRustPieAuthJson({
					anthropic: { kind: "oauth", access_token: "tok", refresh_token: null, expires_at: null, scopes: [] },
				});

				authStorage = AuthStorage.create(authJsonPath);

				expect(authStorage.get("anthropic")).toEqual({
					type: "oauth",
					access: "tok",
					refresh: "",
					expires: Number.MAX_SAFE_INTEGER,
					// Preservation is verbatim, so an empty `scopes` is carried too rather than
					// second-guessed away.
					rustPieFields: { scopes: [] },
				});
			});

			test("a store written without `version` is still imported (oracle: #[serde(default)])", () => {
				writeRustPieAuthJson({ openai: { kind: "api_key", value: "sk-no-version" } }, undefined);

				authStorage = AuthStorage.create(authJsonPath);

				expect(authStorage.get("openai")).toEqual({ type: "api_key", key: "sk-no-version" });
			});

			test("an empty oracle store loads as an empty store and still persists a later login", () => {
				writeRustPieAuthJson({});

				authStorage = AuthStorage.create(authJsonPath);
				expect(authStorage.list()).toEqual([]);
				expect(authStorage.getLoadError()).toBeUndefined();
				expect(authStorage.drainErrors()).toEqual([]);

				authStorage.set("openai", { type: "api_key", key: "openai-key" });
				expect(JSON.parse(readFileSync(authJsonPath, "utf-8"))).toEqual({
					openai: { type: "api_key", key: "openai-key" },
				});
			});

			test("an oauth entry with no expires_at is used as-is, never pushed into the refresh path", async () => {
				// oracle `needs_refresh` (auth.rs:47-58) returns false for `expires_at: None`, and
				// such an entry usually carries no refresh_token either -- treating it as expired
				// would fail the refresh and silently drop the provider from model discovery.
				const providerId = `test-oauth-no-expiry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
				registerOAuthProvider({
					id: providerId,
					name: "Test OAuth Provider (no expiry)",
					async login() {
						throw new Error("Not used in this test");
					},
					async refreshToken() {
						throw new Error("must not refresh a credential with no known expiry");
					},
					getApiKey(credentials) {
						return `Bearer ${credentials.access}`;
					},
				});

				writeRustPieAuthJson({ [providerId]: { kind: "oauth", access_token: "tok", scopes: [] } });

				authStorage = AuthStorage.create(authJsonPath);

				expect(await authStorage.getApiKey(providerId)).toBe("Bearer tok");
			});
		});

		describe("still reads this port's own flat shape", () => {
			test("api_key and oauth entries are untouched by the importer", async () => {
				writeAuthJson({
					anthropic: { type: "api_key", key: "sk-pi-shape" },
					openai: { type: "oauth", access: "a", refresh: "r", expires: 1_900_000_000_000 },
				});

				authStorage = AuthStorage.create(authJsonPath);

				expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "sk-pi-shape" });
				expect(authStorage.get("openai")).toEqual({
					type: "oauth",
					access: "a",
					refresh: "r",
					expires: 1_900_000_000_000,
				});
				expect(await authStorage.getApiKey("anthropic")).toBe("sk-pi-shape");
			});

			test("a provider literally named `providers` is not mistaken for oracle's wrapper", () => {
				// Detection is on the shape of the entries, not on the key name alone: this is a
				// valid flat store whose single provider id happens to be `providers`.
				writeAuthJson({ providers: { type: "api_key", key: "sk-provider-named-providers" } });

				authStorage = AuthStorage.create(authJsonPath);

				expect(authStorage.get("providers")).toEqual({
					type: "api_key",
					key: "sk-provider-named-providers",
				});
			});
		});

		describe("round trip: importing then writing loses nothing", () => {
			test("a later /login rewrites the file in this port's shape with every imported credential intact", async () => {
				writeRustPieAuthJson({
					anthropic: { kind: "api_key", value: "sk-oracle-stored" },
					"github-copilot": {
						kind: "oauth",
						access_token: "tok",
						refresh_token: "rtok",
						expires_at: 1_900_000_000,
						scopes: ["chat"],
					},
				});

				authStorage = AuthStorage.create(authJsonPath);
				authStorage.set("openai", { type: "api_key", key: "sk-new-login" });

				// Write side unchanged: flat shape, no `{version, providers}` wrapper...
				const onDisk = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
				expect(onDisk).toEqual({
					anthropic: { type: "api_key", key: "sk-oracle-stored" },
					"github-copilot": {
						type: "oauth",
						access: "tok",
						refresh: "rtok",
						expires: 1_900_000_000_000,
						rustPieFields: { scopes: ["chat"] },
					},
					openai: { type: "api_key", key: "sk-new-login" },
				});

				// ...and the pre-existing logins still resolve after a restart.
				const reopened = AuthStorage.create(authJsonPath);
				expect(await reopened.getApiKey("anthropic")).toBe("sk-oracle-stored");
				expect(reopened.get("github-copilot")).toEqual({
					type: "oauth",
					access: "tok",
					refresh: "rtok",
					expires: 1_900_000_000_000,
					rustPieFields: { scopes: ["chat"] },
				});
			});

			test("an OAuth refresh replaces the token without dropping imported oracle-only fields", async () => {
				const providerId = `test-oauth-imported-${Date.now()}-${Math.random().toString(36).slice(2)}`;
				registerOAuthProvider({
					id: providerId,
					name: "Test OAuth Provider (imported)",
					async login() {
						throw new Error("Not used in this test");
					},
					// Deliberately builds fresh credentials instead of spreading the input, the way
					// a real provider (e.g. refreshAnthropicToken) does.
					async refreshToken(credentials) {
						return {
							refresh: credentials.refresh,
							access: "refreshed-access-token",
							expires: Date.now() + 60_000,
						};
					},
					getApiKey(credentials) {
						return `Bearer ${credentials.access}`;
					},
				});

				writeRustPieAuthJson({
					[providerId]: {
						kind: "oauth",
						access_token: "expired-tok",
						refresh_token: "rtok",
						expires_at: Math.floor((Date.now() - 10_000) / 1000),
						scopes: ["chat"],
					},
				});

				authStorage = AuthStorage.create(authJsonPath);
				expect(await authStorage.getApiKey(providerId)).toBe("Bearer refreshed-access-token");

				const onDisk = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, Record<string, unknown>>;
				expect(onDisk[providerId]?.access).toBe("refreshed-access-token");
				expect(onDisk[providerId]?.rustPieFields).toEqual({ scopes: ["chat"] });
			});
		});

		describe("malformed or unrecognized stores fall back to the pre-existing behavior", () => {
			test("a truncated oracle file reports a load error and is left untouched", () => {
				const truncated = '{"version":1,"providers":{"anthropic":{"kind":"api_key"';
				writeFileSync(authJsonPath, truncated, "utf-8");

				authStorage = AuthStorage.create(authJsonPath);

				expect(authStorage.getLoadError()).toBeInstanceOf(Error);
				expect(() => authStorage.set("openai", { type: "api_key", key: "k" })).toThrow(/load auth store/);
				expect(readFileSync(authJsonPath, "utf-8")).toBe(truncated);
			});

			test("an entry with an unknown `kind` blocks the import instead of importing half a store", () => {
				// Oracle's own loader is all-or-nothing (serde fails the whole file), so a store this
				// port cannot fully represent is not imported at all -- and, exactly as before this
				// importer existed, the raw block is still carried through the next write rather
				// than deleted.
				writeRustPieAuthJson({
					anthropic: { kind: "api_key", value: "sk-oracle-stored" },
					weird: { kind: "passkey", value: "???" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				expect(authStorage.getLoadError()).toBeUndefined();
				expect(authStorage.get("anthropic")).toBeUndefined();

				authStorage.set("openai", { type: "api_key", key: "k" });
				const onDisk = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
				expect(onDisk.providers).toEqual({
					anthropic: { kind: "api_key", value: "sk-oracle-stored" },
					weird: { kind: "passkey", value: "???" },
				});
				expect(onDisk.openai).toEqual({ type: "api_key", key: "k" });
			});

			test("an oauth entry missing access_token blocks the import", () => {
				writeRustPieAuthJson({ anthropic: { kind: "oauth", refresh_token: "rtok" } });

				authStorage = AuthStorage.create(authJsonPath);

				expect(authStorage.getLoadError()).toBeUndefined();
				expect(authStorage.get("anthropic")).toBeUndefined();
			});
		});
	});
});
