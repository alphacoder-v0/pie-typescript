import { readFile } from "node:fs/promises";
import type { ImageContent } from "@pie/ai";
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Already PNG, no conversion needed
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const photon = await loadPhoton();
	if (!photon) {
		// Photon not available, can't convert
		return null;
	}

	try {
		const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			const pngBuffer = image.get_bytes();
			return {
				data: Buffer.from(pngBuffer).toString("base64"),
				mimeType: "image/png",
			};
		} finally {
			image.free();
		}
	} catch {
		// Conversion failed
		return null;
	}
}

// ---------------------------------------------------------------------------
// pie: image attachment loader for the CLI's `--image` flag.
// Diff-port of oracle crates/coding-agent/src/images.rs (whole file) — pi has no
// counterpart for this loader, so the entire block below is pie divergence.
// ---------------------------------------------------------------------------

/** pie: oracle crates/coding-agent/src/images.rs:10 */
export const MAX_PER_IMAGE_BYTES = 10 * 1024 * 1024;
/** pie: oracle crates/coding-agent/src/images.rs:11 */
export const MAX_IMAGES_PER_MESSAGE = 10;

function startsWith(bytes: Uint8Array, offset: number, ascii: readonly number[]): boolean {
	for (let i = 0; i < ascii.length; i++) {
		if (bytes[offset + i] !== ascii[i]) return false;
	}
	return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const; // \x89PNG\r\n\x1a\n
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46] as const; // RIFF
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50] as const; // WEBP
const GIF87A_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] as const; // GIF87a
const GIF89A_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const; // GIF89a

/**
 * Detect a supported image's mime type from its leading bytes. Supported: PNG, JPEG, WebP,
 * GIF — matches the providers' general intersection.
 *
 * pie: oracle crates/coding-agent/src/images.rs:15-29 (`infer_mime`). `Option<&'static str>`
 * maps to `string | undefined` per RULEBOOK §2.1.
 */
export function inferMime(bytes: Uint8Array): string | undefined {
	if (bytes.length >= 8 && startsWith(bytes, 0, PNG_MAGIC)) {
		return "image/png";
	}
	if (bytes.length >= 3 && startsWith(bytes, 0, JPEG_MAGIC)) {
		return "image/jpeg";
	}
	if (bytes.length >= 12 && startsWith(bytes, 0, RIFF_MAGIC) && startsWith(bytes, 8, WEBP_MAGIC)) {
		return "image/webp";
	}
	if (bytes.length >= 6 && (startsWith(bytes, 0, GIF87A_MAGIC) || startsWith(bytes, 0, GIF89A_MAGIC))) {
		return "image/gif";
	}
	return undefined;
}

/**
 * Build an image attachment from already-read bytes. Used by both `--image` paths and
 * clipboard paste, so format and size validation stay identical.
 *
 * pie: oracle crates/coding-agent/src/images.rs:41-62 (`load_bytes`). `bail!` maps to `throw`
 * per RULEBOOK §2.4; the two messages are user-visible and reproduced verbatim.
 */
export function loadImageBytes(label: string, bytes: Uint8Array): ImageContent {
	if (bytes.length > MAX_PER_IMAGE_BYTES) {
		throw new Error(
			`image ${label} exceeds ${Math.floor(MAX_PER_IMAGE_BYTES / 1024 / 1024)}MB cap (${bytes.length} bytes)`,
		);
	}
	const mime = inferMime(bytes);
	if (mime === undefined) {
		throw new Error(`unsupported image format for ${label}; expected PNG/JPEG/WebP/GIF`);
	}
	return {
		type: "image",
		data: Buffer.from(bytes).toString("base64"),
		mimeType: mime,
	};
}

/**
 * Load a single image into an ImageContent. Enforces the size cap.
 *
 * pie: oracle crates/coding-agent/src/images.rs:32-37 (`load_one`). `anyhow::Context` maps to
 * `new Error(msg, { cause })` per RULEBOOK §2.4; the label passed on is the path itself
 * (Rust `path.display().to_string()`).
 */
export async function loadImageFile(path: string): Promise<ImageContent> {
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch (cause) {
		throw new Error(`read image ${path}`, { cause });
	}
	return loadImageBytes(path, new Uint8Array(bytes));
}

/**
 * Load every path. Errors on the first failure so the user gets a clear, surfaceable error
 * instead of a partial attachment list.
 *
 * pie: oracle crates/coding-agent/src/images.rs:66-79 (`load_all`). Sequential await keeps the
 * oracle's fail-on-first-error ordering.
 */
export async function loadAllImages(paths: readonly string[]): Promise<ImageContent[]> {
	if (paths.length > MAX_IMAGES_PER_MESSAGE) {
		throw new Error(`${paths.length} images exceeds per-message cap of ${MAX_IMAGES_PER_MESSAGE}`);
	}
	const out: ImageContent[] = [];
	for (const p of paths) {
		out.push(await loadImageFile(p));
	}
	return out;
}
