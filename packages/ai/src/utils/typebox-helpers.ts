import { type TUnsafe, Type } from "typebox";

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as any,
		// A falsy-but-legitimate value (empty string, and by symmetry any falsy default a caller
		// passes) must survive into the emitted JSON Schema — oracle's schema system treats falsy
		// defaults as valid (e.g. crates/coding-agent/src/tools/install_skill.rs:799 emits
		// `"default": false`). A truthiness check silently drops them.
		...(options?.description !== undefined && { description: options.description }),
		...(options?.default !== undefined && { default: options.default }),
	});
}
