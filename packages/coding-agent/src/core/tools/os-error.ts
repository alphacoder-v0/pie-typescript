/**
 * Render a Node filesystem error the way Rust's `std::io::Error` Display renders it, so tool
 * error text that reaches the model is byte-identical to oracle's.
 *
 * pie: the tools in `crates/coding-agent/src/tools/` format their filesystem failures as
 * `format!("read {path}: {e}")` / `format!("write {path}: {e}")`, where `{e}` is
 * `std::io::Error`'s Display. For an OS-level failure that is exactly
 * `"{strerror(code)} (os error {code})"` — e.g. `No such file or directory (os error 2)`.
 *
 * Node throws `ErrnoException`s whose `message` is a different sentence entirely
 * (`ENOENT: no such file or directory, access '/x'`). Both pieces Rust prints are recoverable
 * from the Node error:
 *
 *  - the number: `err.errno` is libuv's errno, which on POSIX is the negated platform errno —
 *    the same integer Rust's `raw_os_error()` returns. Always taken from the error, never from
 *    the table below, so it stays correct on any platform.
 *  - the sentence: libuv's own strings do NOT match libc's (`EISDIR` is "illegal operation on a
 *    directory" in libuv vs "Is a directory" in glibc), so `util.getSystemErrorMap()` /
 *    `util.getSystemErrorMessage()` are not usable here. The table below is glibc `strerror`
 *    text, which is what oracle prints on the platform parity runs on.
 *
 * Codes outside the table fall through to Node's own message — a visibly different sentence is
 * better than a confidently wrong one.
 */

/**
 * glibc `strerror` text, keyed by the stable `err.code` string Node attaches.
 *
 * Limitation: these sentences are glibc's. A non-glibc libc (musl, macOS) words a few of them
 * differently, and there the text would diverge from a Rust binary built for that same platform.
 * The errno *number* is always the platform's own.
 */
const LIBC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
	EPERM: "Operation not permitted",
	ENOENT: "No such file or directory",
	ESRCH: "No such process",
	EINTR: "Interrupted system call",
	EIO: "Input/output error",
	ENXIO: "No such device or address",
	EBADF: "Bad file descriptor",
	EAGAIN: "Resource temporarily unavailable",
	ENOMEM: "Cannot allocate memory",
	EACCES: "Permission denied",
	EFAULT: "Bad address",
	EBUSY: "Device or resource busy",
	EEXIST: "File exists",
	EXDEV: "Invalid cross-device link",
	ENODEV: "No such device",
	ENOTDIR: "Not a directory",
	EISDIR: "Is a directory",
	EINVAL: "Invalid argument",
	ENFILE: "Too many open files in system",
	EMFILE: "Too many open files",
	ENOTTY: "Inappropriate ioctl for device",
	ETXTBSY: "Text file busy",
	EFBIG: "File too large",
	ENOSPC: "No space left on device",
	ESPIPE: "Illegal seek",
	EROFS: "Read-only file system",
	EMLINK: "Too many links",
	ENAMETOOLONG: "File name too long",
	ENOSYS: "Function not implemented",
	ENOTEMPTY: "Directory not empty",
	ELOOP: "Too many levels of symbolic links",
	ENOTSUP: "Operation not supported",
	ECANCELED: "Operation canceled",
};

/**
 * Format `error` the way `std::io::Error`'s Display would.
 *
 * Returns `"{strerror} (os error {errno})"` for recognized OS errors, and the error's own
 * message otherwise — which is also what Rust does for its non-OS `io::Error` variants, whose
 * Display is a bare sentence (e.g. `read_to_string`'s "stream did not contain valid UTF-8").
 */
export function formatOsError(error: unknown): string {
	const errnoError = error as NodeJS.ErrnoException | null | undefined;
	const code = typeof errnoError?.code === "string" ? errnoError.code : undefined;
	const message = code === undefined ? undefined : LIBC_ERROR_MESSAGES[code];
	const errno = typeof errnoError?.errno === "number" ? Math.abs(errnoError.errno) : undefined;
	if (message !== undefined && errno !== undefined) {
		return `${message} (os error ${errno})`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
