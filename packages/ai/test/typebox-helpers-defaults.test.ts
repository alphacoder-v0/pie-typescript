/**
 * pie: crates/coding-agent/src/tools/install_skill.rs:799 emits `"default": false` — oracle's
 * schema system treats falsy defaults as legitimate. StringEnum's truthiness check used to drop
 * them from the emitted JSON Schema.
 */
import { describe, expect, it } from "vitest";
import { StringEnum } from "../src/utils/typebox-helpers.ts";

describe("StringEnum option emission", () => {
	it("keeps an empty-string default in the schema", () => {
		const schema = StringEnum(["", "a", "b"] as const, { default: "" }) as unknown as Record<string, unknown>;
		expect(schema).toHaveProperty("default", "");
	});

	it("keeps an empty-string description in the schema", () => {
		const schema = StringEnum(["a"] as const, { description: "" }) as unknown as Record<string, unknown>;
		expect(schema).toHaveProperty("description", "");
	});

	it("omits both keys when the options are absent", () => {
		const schema = StringEnum(["a", "b"] as const) as unknown as Record<string, unknown>;
		expect(schema).not.toHaveProperty("default");
		expect(schema).not.toHaveProperty("description");
		expect(schema.enum).toEqual(["a", "b"]);
	});

	it("still carries truthy values through", () => {
		const schema = StringEnum(["a", "b"] as const, { default: "b", description: "pick one" }) as unknown as Record<
			string,
			unknown
		>;
		expect(schema).toMatchObject({ default: "b", description: "pick one", type: "string" });
	});
});
