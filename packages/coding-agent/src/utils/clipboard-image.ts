import { deflateSync } from "node:zlib";
import type { ImageContent } from "@pie/ai";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clipboard } from "./clipboard-native.ts";
import { loadImageBytes } from "./image-convert.ts";
import { loadPhoton } from "./photon.ts";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_READ_TIMEOUT_MS = 3000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base);
}

/**
 * Convert unsupported image formats to PNG using Photon.
 * Returns null if conversion is unavailable or fails.
 */
async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

function runCommand(
	command: string,
	args: string[],
	options?: { timeoutMs?: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv },
): { stdout: Buffer; ok: boolean } {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

	const result = spawnSync(command, args, {
		timeout: timeoutMs,
		maxBuffer: maxBufferBytes,
		env: options?.env,
	});

	if (result.error) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	if (result.status !== 0) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(result.stdout ?? "", typeof result.stdout === "string" ? "utf-8" : undefined);

	return { ok: true, stdout };
}

function readClipboardImageViaWlPaste(): ClipboardImage | null {
	const list = runCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (!list.ok) {
		return null;
	}

	const types = list.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		return null;
	}

	const data = runCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (!data.ok || data.stdout.length === 0) {
		return null;
	}

	return { bytes: data.stdout, mimeType: baseMimeType(selectedType) };
}

function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true;
	}

	try {
		const release = readFileSync("/proc/version", "utf-8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}

/**
 * On WSL, the Linux clipboard (Wayland/X11) does not receive image data from
 * Windows screenshots (Win+Shift+S). PowerShell can access the Windows clipboard
 * directly, so we use it as a fallback.
 */
function readClipboardImageViaPowerShell(): ClipboardImage | null {
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.png`);

	try {
		const winPathResult = runCommand("wslpath", ["-w", tmpFile], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
		if (!winPathResult.ok) {
			return null;
		}

		const winPath = winPathResult.stdout.toString("utf-8").trim();
		if (!winPath) {
			return null;
		}

		const psQuotedWinPath = winPath.replaceAll("'", "''");
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuotedWinPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");

		const result = runCommand("powershell.exe", ["-NoProfile", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		});
		if (!result.ok) {
			return null;
		}

		const output = result.stdout.toString("utf-8").trim();
		if (output !== "ok") {
			return null;
		}

		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) {
			return null;
		}

		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors.
		}
	}
}

function readClipboardImageViaXclip(): ClipboardImage | null {
	const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	let candidateTypes: string[] = [];
	if (targets.ok) {
		candidateTypes = targets.stdout
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
	}

	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null;
	const tryTypes = preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : [...SUPPORTED_IMAGE_MIME_TYPES];

	for (const mimeType of tryTypes) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(mimeType) };
		}
	}

	return null;
}

async function readClipboardImageViaNativeClipboard(): Promise<ClipboardImage | null> {
	if (!clipboard || !clipboard.hasImage()) {
		return null;
	}

	const imageData = await clipboard.getImageBinary();
	if (!imageData || imageData.length === 0) {
		return null;
	}

	const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData);
	return { bytes, mimeType: "image/png" };
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	if (env.TERMUX_VERSION) {
		return null;
	}

	let image: ClipboardImage | null = null;

	if (platform === "linux") {
		const wsl = isWSL(env);
		const wayland = isWaylandSession(env);

		if (wayland || wsl) {
			image = readClipboardImageViaWlPaste() ?? readClipboardImageViaXclip();
		}

		if (!image && wsl) {
			image = readClipboardImageViaPowerShell();
		}

		if (!image && !wayland) {
			image = await readClipboardImageViaNativeClipboard();
		}
	} else {
		image = await readClipboardImageViaNativeClipboard();
	}

	if (!image) {
		return null;
	}

	// Convert unsupported formats (e.g., BMP from WSLg) to PNG
	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}

// ---------------------------------------------------------------------------
// pie: clipboard paste for the full-screen TUI.
// Diff-port of oracle crates/coding-agent/src/clipboard_image.rs. pi's base above
// only answers "is there an image on the clipboard"; pie additionally models the
// tri-state paste (image / text / empty), carries pixel dimensions plus encoded
// size for the attachment label, and re-encodes raw RGBA buffers into PNG.
// ---------------------------------------------------------------------------

/**
 * pie: oracle clipboard_image.rs:11-17 (`struct ClipboardImage`).
 * Renamed to `ClipboardImageAttachment` because the base file already exports a
 * `ClipboardImage` (raw clipboard bytes + mime) that `interactive-mode.ts` depends on.
 */
export type ClipboardImageAttachment = {
	image: ImageContent;
	width: number;
	height: number;
	encodedBytes: number;
};

/**
 * pie: oracle clipboard_image.rs:19-24 (`enum ClipboardPaste`).
 * Data-carrying enum -> tagged discriminated union (RULEBOOK §2.1). Not a wire type,
 * so the tag field name is local.
 */
export type ClipboardPaste =
	| { kind: "image"; image: ClipboardImageAttachment }
	| { kind: "text"; text: string }
	| { kind: "empty" };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Uint32Array | undefined;

function crc32(buf: Uint8Array): number {
	if (!crcTable) {
		const table = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) {
				c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			}
			table[n] = c >>> 0;
		}
		crcTable = table;
	}
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c = (crcTable[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([length, body, crc]);
}

/**
 * Encode an 8-bit RGBA buffer as a non-interlaced PNG.
 *
 * pie: stands in for oracle's `image::DynamicImage::ImageRgba8(..).write_to(.., ImageFormat::Png)`
 * (clipboard_image.rs:67-73). RULEBOOK §1 has no image-codec dependency on the whitelist, so this
 * is written against node built-ins only (`node:zlib` deflate + a CRC-32 table).
 * PERF(port): filter type 0 on every scanline and a single IDAT chunk; the Rust `image` crate picks
 * adaptive filters, so byte-for-byte output differs. Only the decoded pixels are behavioral.
 */
function encodeRgbaAsPng(width: number, height: number, rgba: Uint8Array): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type: truecolor with alpha
	ihdr[10] = 0; // compression: deflate
	ihdr[11] = 0; // filter method 0
	ihdr[12] = 0; // no interlace

	const stride = width * 4;
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		const rowStart = y * (stride + 1);
		raw[rowStart] = 0; // filter type: None
		Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
	}

	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/**
 * pie: oracle clipboard_image.rs:49-83 (`encode_rgba_clipboard_image`).
 * Every guard message is reproduced verbatim because they surface through the TUI's
 * "clipboard paste failed: {e}" line (oracle ui/mod.rs:1037).
 */
export function encodeRgbaClipboardImage(
	width: number,
	height: number,
	rgbaBytes: Uint8Array,
): ClipboardImageAttachment {
	// pie: oracle clipboard_image.rs:54-57 — `checked_mul` chain. JS has no integer overflow, so the
	// equivalent guard is "the product is still an exact integer".
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 0 ||
		height < 0 ||
		!Number.isSafeInteger(width * height) ||
		!Number.isSafeInteger(width * height * 4)
	) {
		throw new Error("clipboard image dimensions are too large");
	}
	const expected = width * height * 4;
	if (rgbaBytes.length !== expected) {
		// pie: oracle clipboard_image.rs:58-63
		throw new Error(`clipboard image has invalid RGBA buffer: expected ${expected} bytes, got ${rgbaBytes.length}`);
	}

	// pie: oracle clipboard_image.rs:65-66 — `u32::try_from`.
	if (width > 0xffffffff) {
		throw new Error("clipboard image width is too large");
	}
	if (height > 0xffffffff) {
		throw new Error("clipboard image height is too large");
	}

	if (width === 0 || height === 0) {
		// TODO(port): oracle relies on the `image` crate to reject zero-sized PNGs; the exact Rust
		// error text is unverified, so take the most conservative branch and reuse the encode context.
		throw new Error("encode clipboard image as PNG");
	}

	const png = encodeRgbaAsPng(width, height, rgbaBytes);
	const encodedBytes = png.length;
	// pie: oracle clipboard_image.rs:75 — label is exactly "clipboard image".
	const image = loadImageBytes("clipboard image", new Uint8Array(png));

	return { image, width, height, encodedBytes };
}

/**
 * Read the pixel dimensions of an already-encoded image.
 *
 * pie: oracle gets width/height for free from arboard's RGBA handoff (clipboard_image.rs:34-39);
 * the TS clipboard readers above hand back encoded bytes instead, so the dimensions have to be
 * recovered. PNG is parsed from the IHDR header directly; anything else falls back to photon,
 * which this file already depends on for format conversion.
 */
async function imageDimensions(bytes: Uint8Array): Promise<{ width: number; height: number }> {
	if (bytes.length >= 24 && Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)) {
		const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
		return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
	}

	const photon = await loadPhoton();
	if (!photon) {
		// TODO(port): dimensions unavailable without a decoder; report 0x0 rather than dropping the
		// attachment, since oracle always produces an attachment once the bytes decode.
		return { width: 0, height: 0 };
	}
	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			return { width: image.get_width(), height: image.get_height() };
		} finally {
			image.free();
		}
	} catch {
		return { width: 0, height: 0 };
	}
}

function readClipboardText(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
	if (platform === "darwin") {
		const out = runCommand("pbpaste", []);
		return out.ok ? out.stdout.toString("utf-8") : null;
	}
	if (platform === "win32") {
		const out = runCommand("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		});
		return out.ok ? out.stdout.toString("utf-8") : null;
	}
	if (isWaylandSession(env)) {
		const out = runCommand("wl-paste", ["--no-newline"]);
		if (out.ok) {
			return out.stdout.toString("utf-8");
		}
	}
	const xclip = runCommand("xclip", ["-selection", "clipboard", "-o"]);
	return xclip.ok ? xclip.stdout.toString("utf-8") : null;
}

/**
 * pie: oracle clipboard_image.rs:26-47 (`read_clipboard` / `read_clipboard_sync`).
 * Order is load-bearing: image wins over text, and an empty-string text reads as Empty.
 * Oracle runs this on `spawn_blocking`; per RULEBOOK §2.2 that becomes a plain async call.
 */
export async function readClipboard(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardPaste> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	const raw = await readClipboardImage({ env, platform });
	if (raw) {
		// pie: oracle re-encodes arboard's RGBA buffer, so its attachment is always PNG. The TS readers
		// hand back the clipboard's own encoding, which `loadImageBytes` already accepts (PNG/JPEG/
		// WebP/GIF), so the bytes are passed through rather than re-encoded.
		const { width, height } = await imageDimensions(raw.bytes);
		const image = loadImageBytes("clipboard image", raw.bytes);
		return { kind: "image", image: { image, width, height, encodedBytes: raw.bytes.length } };
	}

	const text = readClipboardText(env, platform);
	if (text !== null && text.length > 0) {
		return { kind: "text", text };
	}

	return { kind: "empty" };
}
