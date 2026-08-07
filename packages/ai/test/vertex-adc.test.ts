import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildVertexJwt,
	fetchVertexAccessToken,
	loadVertexServiceAccount,
	VertexAdcError,
	type VertexServiceAccount,
} from "../src/utils/vertex-adc.ts";

// pie: crates/ai/src/vertex_adc.rs — 1:1 behavior port (no oracle rust tests skipped; both
// #[cfg(test)] cases below are ported, plus additional divergence-locking coverage for the TS-side
// error surface and fetch-based token exchange oracle's dead vertex_adc.rs never exercised through
// a live caller).

function generateTestKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

function decodeJwtPart(part: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
}

const originalGacEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;

afterEach(() => {
	if (originalGacEnv === undefined) {
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
	} else {
		process.env.GOOGLE_APPLICATION_CREDENTIALS = originalGacEnv;
	}
	vi.unstubAllGlobals();
});

describe("loadVertexServiceAccount", () => {
	// pie: vertex_adc.rs:206-222 (load_service_account_parses_minimal_json)
	it("parses a minimal service account JSON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vertex-adc-test-"));
		const path = join(dir, "sa.json");
		writeFileSync(
			path,
			JSON.stringify({
				client_email: "x@y.iam.gserviceaccount.com",
				private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
				token_uri: "https://oauth2.googleapis.com/token",
				project_id: "p",
			}),
		);

		const sa = await loadVertexServiceAccount(path);
		expect(sa.clientEmail).toBe("x@y.iam.gserviceaccount.com");
		expect(sa.tokenUri).toBe("https://oauth2.googleapis.com/token");
		expect(sa.projectId).toBe("p");
	});

	it("defaults token_uri when absent from the JSON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vertex-adc-test-"));
		const path = join(dir, "sa.json");
		writeFileSync(
			path,
			JSON.stringify({
				client_email: "x@y.iam.gserviceaccount.com",
				private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
			}),
		);

		const sa = await loadVertexServiceAccount(path);
		expect(sa.tokenUri).toBe("https://oauth2.googleapis.com/token");
		expect(sa.projectId).toBeUndefined();
	});

	it("throws io when GOOGLE_APPLICATION_CREDENTIALS is unset and no path is given", async () => {
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		await expect(loadVertexServiceAccount()).rejects.toThrow(VertexAdcError);
		try {
			await loadVertexServiceAccount();
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(VertexAdcError);
			expect((error as VertexAdcError).code).toBe("io");
		}
	});

	it("throws io when the file does not exist", async () => {
		await expect(loadVertexServiceAccount("/nonexistent/path/sa.json")).rejects.toThrowError(
			expect.objectContaining({ code: "io" }),
		);
	});

	it("throws parse on malformed JSON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vertex-adc-test-"));
		const path = join(dir, "sa.json");
		writeFileSync(path, "{ not json");
		await expect(loadVertexServiceAccount(path)).rejects.toThrowError(expect.objectContaining({ code: "parse" }));
	});

	it("throws parse when client_email or private_key is missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vertex-adc-test-"));
		const path = join(dir, "sa.json");
		writeFileSync(path, JSON.stringify({ client_email: "x@y.iam.gserviceaccount.com" }));
		await expect(loadVertexServiceAccount(path)).rejects.toThrowError(expect.objectContaining({ code: "parse" }));
	});

	it("reads the path from GOOGLE_APPLICATION_CREDENTIALS when no explicit path is given", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vertex-adc-test-"));
		const path = join(dir, "sa.json");
		writeFileSync(
			path,
			JSON.stringify({
				client_email: "env@y.iam.gserviceaccount.com",
				private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
			}),
		);
		process.env.GOOGLE_APPLICATION_CREDENTIALS = path;

		const sa = await loadVertexServiceAccount();
		expect(sa.clientEmail).toBe("env@y.iam.gserviceaccount.com");
	});
});

describe("buildVertexJwt", () => {
	// pie: vertex_adc.rs:167-204 (build_jwt_emits_three_dot_separated_parts)
	it("emits header.payload.signature with the expected claim shape", async () => {
		const { privateKeyPem } = generateTestKeyPair();
		const sa: VertexServiceAccount = {
			clientEmail: "svc@proj.iam.gserviceaccount.com",
			privateKey: privateKeyPem,
			tokenUri: "https://oauth2.googleapis.com/token",
			projectId: "proj",
		};

		const jwt = await buildVertexJwt(sa);
		const parts = jwt.split(".");
		expect(parts).toHaveLength(3);

		const header = decodeJwtPart(parts[0]!);
		expect(header).toEqual({ alg: "RS256", typ: "JWT" });

		const payload = decodeJwtPart(parts[1]!);
		expect(payload.iss).toBe("svc@proj.iam.gserviceaccount.com");
		expect(payload.aud).toBe("https://oauth2.googleapis.com/token");
		expect(payload.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
		expect(typeof payload.iat).toBe("number");
		expect(payload.exp).toBe((payload.iat as number) + 3600);
	});

	it("honors a custom scope", async () => {
		const { privateKeyPem } = generateTestKeyPair();
		const sa: VertexServiceAccount = {
			clientEmail: "svc@proj.iam.gserviceaccount.com",
			privateKey: privateKeyPem,
			tokenUri: "https://oauth2.googleapis.com/token",
		};

		const jwt = await buildVertexJwt(sa, "https://www.googleapis.com/auth/devstorage.read_only");
		const payload = decodeJwtPart(jwt.split(".")[1]!);
		expect(payload.scope).toBe("https://www.googleapis.com/auth/devstorage.read_only");
	});

	it("throws sign on a malformed private key", async () => {
		const sa: VertexServiceAccount = {
			clientEmail: "svc@proj.iam.gserviceaccount.com",
			privateKey: "not a pem key",
			tokenUri: "https://oauth2.googleapis.com/token",
		};

		await expect(buildVertexJwt(sa)).rejects.toThrowError(expect.objectContaining({ code: "sign" }));
	});
});

describe("fetchVertexAccessToken", () => {
	it("loads the service account, signs a JWT, and exchanges it for an access token", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vertex-adc-test-"));
		const path = join(dir, "sa.json");
		const { privateKeyPem } = generateTestKeyPair();
		writeFileSync(
			path,
			JSON.stringify({
				client_email: "svc@proj.iam.gserviceaccount.com",
				private_key: privateKeyPem,
				token_uri: "https://oauth2.googleapis.com/token",
			}),
		);
		process.env.GOOGLE_APPLICATION_CREDENTIALS = path;

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
			expect(String(input)).toBe("https://oauth2.googleapis.com/token");
			expect(init?.method).toBe("POST");
			const body = init?.body as URLSearchParams;
			expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
			expect(String(body.get("assertion")).split(".")).toHaveLength(3);
			return new Response(
				JSON.stringify({ access_token: "ya29.exchanged", expires_in: 1800, scope: "cloud-platform" }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const before = Math.floor(Date.now() / 1000);
		const token = await fetchVertexAccessToken();

		expect(token.token).toBe("ya29.exchanged");
		expect(token.scope).toBe("cloud-platform");
		expect(token.expiresAt).toBeGreaterThanOrEqual(before + 1800);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	// pie: vertex_adc.rs:139-144 (non-2xx status -> AdcError::Exchange)
	it("throws exchange on a non-2xx response", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vertex-adc-test-"));
		const path = join(dir, "sa.json");
		const { privateKeyPem } = generateTestKeyPair();
		writeFileSync(
			path,
			JSON.stringify({ client_email: "svc@proj.iam.gserviceaccount.com", private_key: privateKeyPem }),
		);
		process.env.GOOGLE_APPLICATION_CREDENTIALS = path;

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("invalid_grant: bad assertion", { status: 400 })),
		);

		await expect(fetchVertexAccessToken()).rejects.toThrowError(expect.objectContaining({ code: "exchange" }));
	});

	it("throws exchange when the response has no access_token", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vertex-adc-test-"));
		const path = join(dir, "sa.json");
		const { privateKeyPem } = generateTestKeyPair();
		writeFileSync(
			path,
			JSON.stringify({ client_email: "svc@proj.iam.gserviceaccount.com", private_key: privateKeyPem }),
		);
		process.env.GOOGLE_APPLICATION_CREDENTIALS = path;

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 })),
		);

		await expect(fetchVertexAccessToken()).rejects.toThrowError(expect.objectContaining({ code: "exchange" }));
	});

	it("propagates io when GOOGLE_APPLICATION_CREDENTIALS is unset", async () => {
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		await expect(fetchVertexAccessToken()).rejects.toThrowError(expect.objectContaining({ code: "io" }));
	});
});
