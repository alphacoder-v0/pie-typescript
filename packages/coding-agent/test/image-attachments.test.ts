/**
 * Characterization tests for the `--image` attachment loader.
 * Port of oracle crates/coding-agent/src/images.rs tests (lines 81-137).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	inferMime,
	loadAllImages,
	loadImageBytes,
	loadImageFile,
	MAX_IMAGES_PER_MESSAGE,
	MAX_PER_IMAGE_BYTES,
} from "../src/utils/image-convert.ts";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pie-images-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("inferMime", () => {
	// oracle images.rs:86-90
	it("infers png", () => {
		expect(inferMime(new Uint8Array(Buffer.concat([PNG_HEADER, Buffer.from("0000more")])))).toBe("image/png");
	});

	// oracle images.rs:92-96
	it("infers jpeg", () => {
		expect(
			inferMime(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("00more")]))),
		).toBe("image/jpeg");
	});

	// oracle images.rs:98-105
	it("infers webp", () => {
		const bytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPmore")]);
		expect(inferMime(new Uint8Array(bytes))).toBe("image/webp");
	});

	it("infers gif87a and gif89a", () => {
		expect(inferMime(new Uint8Array(Buffer.from("GIF87amore")))).toBe("image/gif");
		expect(inferMime(new Uint8Array(Buffer.from("GIF89amore")))).toBe("image/gif");
	});

	// oracle images.rs:107-110
	it("rejects unknown format", () => {
		expect(inferMime(new Uint8Array(Buffer.from("not an image")))).toBeUndefined();
	});

	it("requires the full magic length (RIFF without WEBP is not an image)", () => {
		const bytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEmore")]);
		expect(inferMime(new Uint8Array(bytes))).toBeUndefined();
		// Truncated PNG magic does not match.
		expect(inferMime(new Uint8Array(PNG_HEADER.subarray(0, 7)))).toBeUndefined();
	});
});

describe("loadImageFile / loadImageBytes", () => {
	// oracle images.rs:112-127
	it("round trips a png and matches the bytes path", async () => {
		const p = join(dir, "x.png");
		const bytes = Buffer.concat([
			PNG_HEADER,
			Buffer.from("the rest is not a real png but this test only checks load + mime"),
		]);
		writeFileSync(p, bytes);

		const img = await loadImageFile(p);
		expect(img.mimeType).toBe("image/png");
		expect(img.type).toBe("image");
		expect(img.data.length).toBeGreaterThan(0);

		const fromBytes = loadImageBytes("clipboard", new Uint8Array(bytes));
		expect(fromBytes.mimeType).toBe("image/png");
		expect(fromBytes.data).toBe(img.data);
	});

	// oracle images.rs:129-136
	it("rejects unknown format with the oracle message", async () => {
		const p = join(dir, "x.bin");
		writeFileSync(p, "hello");
		await expect(loadImageFile(p)).rejects.toThrow(/unsupported image format/);
		await expect(loadImageFile(p)).rejects.toThrow(`unsupported image format for ${p}; expected PNG/JPEG/WebP/GIF`);
	});

	// oracle images.rs:42-49
	it("enforces the per-image size cap verbatim", () => {
		const oversized = Buffer.alloc(MAX_PER_IMAGE_BYTES + 1);
		PNG_HEADER.copy(oversized, 0);
		expect(() => loadImageBytes("big.png", new Uint8Array(oversized))).toThrow(
			`image big.png exceeds 10MB cap (${MAX_PER_IMAGE_BYTES + 1} bytes)`,
		);
	});

	it("accepts exactly the cap (cap is exclusive upper bound)", () => {
		const atCap = Buffer.alloc(MAX_PER_IMAGE_BYTES);
		PNG_HEADER.copy(atCap, 0);
		expect(loadImageBytes("edge.png", new Uint8Array(atCap)).mimeType).toBe("image/png");
	});

	// oracle images.rs:33-35 — read failure wraps with `read image {path}`.
	it("wraps read failure with the oracle context message", async () => {
		const missing = join(dir, "does-not-exist.png");
		await expect(loadImageFile(missing)).rejects.toThrow(`read image ${missing}`);
	});
});

describe("loadAllImages", () => {
	// oracle images.rs:67-73
	it("rejects more than the per-message cap with the oracle message", async () => {
		const paths = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, i) => join(dir, `n${i}.png`));
		await expect(loadAllImages(paths)).rejects.toThrow(
			`${MAX_IMAGES_PER_MESSAGE + 1} images exceeds per-message cap of ${MAX_IMAGES_PER_MESSAGE}`,
		);
	});

	it("loads every path in order and fails on the first bad one", async () => {
		const good = join(dir, "a.png");
		writeFileSync(good, Buffer.concat([PNG_HEADER, Buffer.from("body")]));
		const bad = join(dir, "b.bin");
		writeFileSync(bad, "nope");

		const loaded = await loadAllImages([good, good]);
		expect(loaded).toHaveLength(2);
		expect(loaded.every((i) => i.mimeType === "image/png")).toBe(true);

		await expect(loadAllImages([good, bad, good])).rejects.toThrow(/unsupported image format/);
	});

	it("accepts an empty list", async () => {
		expect(await loadAllImages([])).toEqual([]);
	});
});
