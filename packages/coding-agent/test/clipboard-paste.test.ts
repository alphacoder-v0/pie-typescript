/**
 * Characterization tests for the pie clipboard-paste port.
 * Port of oracle crates/coding-agent/src/clipboard_image.rs tests (lines 85-115), plus the
 * tri-state `read_clipboard` contract (clipboard_image.rs:26-47).
 *
 * Hermetic: `child_process` and the native clipboard addon are both mocked, so nothing here
 * touches a real clipboard, a real DISPLAY, or a real subprocess.
 */

import { inflateSync } from "node:zlib";
import type { SpawnSyncReturns } from "child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
	return {
		spawnSync: vi.fn<(command: string, args: string[], options: unknown) => SpawnSyncReturns<Buffer>>(),
		clipboard: {
			hasImage: vi.fn<() => boolean>(),
			getImageBinary: vi.fn<() => Promise<Uint8Array | null>>(),
		},
	};
});

vi.mock("child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("../src/utils/clipboard-native.js", () => ({ clipboard: mocks.clipboard }));

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function spawnOk(stdout: Buffer): SpawnSyncReturns<Buffer> {
	return {
		pid: 1,
		output: [Buffer.alloc(0), stdout, Buffer.alloc(0)],
		stdout,
		stderr: Buffer.alloc(0),
		status: 0,
		signal: null,
	};
}

function spawnFail(): SpawnSyncReturns<Buffer> {
	return {
		pid: 1,
		output: [Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)],
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		status: 1,
		signal: null,
	};
}

beforeEach(() => {
	vi.resetModules();
	mocks.spawnSync.mockReset();
	mocks.clipboard.hasImage.mockReset();
	mocks.clipboard.getImageBinary.mockReset();
	mocks.spawnSync.mockImplementation(() => spawnFail());
	mocks.clipboard.hasImage.mockReturnValue(false);
});

describe("encodeRgbaClipboardImage", () => {
	// oracle clipboard_image.rs:90-106
	test("encodes an rgba clipboard image as png", async () => {
		const { encodeRgbaClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const img = encodeRgbaClipboardImage(1, 1, new Uint8Array([255, 0, 0, 255]));

		expect(img.width).toBe(1);
		expect(img.height).toBe(1);
		expect(img.image.mimeType).toBe("image/png");
		expect(img.image.type).toBe("image");
		const decoded = Buffer.from(img.image.data, "base64");
		expect(decoded.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
		expect(img.encodedBytes).toBe(decoded.length);
	});

	test("produces a structurally valid PNG whose pixels round-trip", async () => {
		const { encodeRgbaClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const rgba = new Uint8Array([
			// row 0: red, green
			255, 0, 0, 255, 0, 255, 0, 255,
			// row 1: blue, transparent white
			0, 0, 255, 255, 255, 255, 255, 0,
		]);
		const img = encodeRgbaClipboardImage(2, 2, rgba);
		const png = Buffer.from(img.image.data, "base64");

		// IHDR: length(4) + "IHDR" starts at byte 8; width/height at 16/20.
		expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
		expect(png.readUInt32BE(16)).toBe(2);
		expect(png.readUInt32BE(20)).toBe(2);
		expect(png[24]).toBe(8); // bit depth
		expect(png[25]).toBe(6); // RGBA
		expect(png.subarray(png.length - 8, png.length - 4).toString("latin1")).toBe("IEND");

		// IDAT payload inflates back to filter-0 scanlines of the original pixels.
		const idatStart = png.indexOf(Buffer.from("IDAT", "latin1"));
		const idatLength = png.readUInt32BE(idatStart - 4);
		const raw = inflateSync(png.subarray(idatStart + 4, idatStart + 4 + idatLength));
		expect(Array.from(raw)).toEqual([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0]);
	});

	// oracle clipboard_image.rs:108-114
	test("rejects invalid rgba buffer size", async () => {
		const { encodeRgbaClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(() => encodeRgbaClipboardImage(2, 2, new Uint8Array(3))).toThrow(/invalid RGBA buffer/);
		expect(() => encodeRgbaClipboardImage(2, 2, new Uint8Array(3))).toThrow(
			"clipboard image has invalid RGBA buffer: expected 16 bytes, got 3",
		);
	});

	// oracle clipboard_image.rs:54-57
	test("rejects dimensions that cannot be represented exactly", async () => {
		const { encodeRgbaClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(() => encodeRgbaClipboardImage(2 ** 40, 2 ** 40, new Uint8Array(0))).toThrow(
			"clipboard image dimensions are too large",
		);
		expect(() => encodeRgbaClipboardImage(-1, 1, new Uint8Array(0))).toThrow(
			"clipboard image dimensions are too large",
		);
	});

	test("rejects a zero-sized image before encoding", async () => {
		const { encodeRgbaClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(() => encodeRgbaClipboardImage(0, 0, new Uint8Array(0))).toThrow("encode clipboard image as PNG");
	});
});

describe("readClipboard", () => {
	test("returns an image paste with dimensions and encoded size", async () => {
		const { encodeRgbaClipboardImage, readClipboard } = await import("../src/utils/clipboard-image.ts");
		const png = Buffer.from(encodeRgbaClipboardImage(3, 2, new Uint8Array(3 * 2 * 4)).image.data, "base64");

		mocks.clipboard.hasImage.mockReturnValue(true);
		mocks.clipboard.getImageBinary.mockResolvedValue(new Uint8Array(png));

		const paste = await readClipboard({ platform: "linux", env: {} });
		expect(paste.kind).toBe("image");
		if (paste.kind !== "image") throw new Error("unreachable");
		expect(paste.image.width).toBe(3);
		expect(paste.image.height).toBe(2);
		expect(paste.image.encodedBytes).toBe(png.length);
		expect(paste.image.image.mimeType).toBe("image/png");
		// Image wins over text: the text readers are never consulted.
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	test("falls back to text when there is no image", async () => {
		const { readClipboard } = await import("../src/utils/clipboard-image.ts");
		mocks.spawnSync.mockImplementation((command: string) =>
			command === "xclip" ? spawnOk(Buffer.from("hello from the clipboard")) : spawnFail(),
		);

		const paste = await readClipboard({ platform: "linux", env: {} });
		expect(paste).toEqual({ kind: "text", text: "hello from the clipboard" });
	});

	test("empty text reads as an empty paste", async () => {
		const { readClipboard } = await import("../src/utils/clipboard-image.ts");
		mocks.spawnSync.mockImplementation(() => spawnOk(Buffer.alloc(0)));

		const paste = await readClipboard({ platform: "linux", env: {} });
		expect(paste).toEqual({ kind: "empty" });
	});

	test("empty clipboard reads as an empty paste", async () => {
		const { readClipboard } = await import("../src/utils/clipboard-image.ts");
		const paste = await readClipboard({ platform: "linux", env: {} });
		expect(paste).toEqual({ kind: "empty" });
	});

	test("darwin reads text via pbpaste", async () => {
		const { readClipboard } = await import("../src/utils/clipboard-image.ts");
		mocks.spawnSync.mockImplementation((command: string) =>
			command === "pbpaste" ? spawnOk(Buffer.from("mac text")) : spawnFail(),
		);

		const paste = await readClipboard({ platform: "darwin", env: {} });
		expect(paste).toEqual({ kind: "text", text: "mac text" });
	});
});
