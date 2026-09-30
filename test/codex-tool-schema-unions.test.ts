import { describe, expect, it } from "vitest";
import { normalizeCodexToolSchemas } from "../src/providers/codex";

function constBranches(values: unknown[]) {
  return values.map((value, index) => ({
    const: value,
    description: `choice ${index}`,
  }));
}

function toolWithProperty(name: string, property: Record<string, unknown>) {
  return [{
    type: "function",
    name: "lookup",
    parameters: {
      type: "object",
      properties: {
        [name]: property,
        sibling: { type: "string" },
      },
      required: [name],
    },
  }];
}

describe("Codex pure const union schema normalization", () => {
  it("converts an 8+ branch oneOf of pure unique consts into an enum", () => {
    const values = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const normalized = normalizeCodexToolSchemas(toolWithProperty("action", {
      type: "string",
      description: "Action to perform",
      oneOf: constBranches(values),
    })) as Array<Record<string, unknown>>;

    const parameters = normalized[0]?.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.action!.enum).toEqual(values);
    expect(properties.action!.oneOf).toBeUndefined();
    expect(properties.action!.type).toBe("string");
    expect(properties.action!.description).toBe("Action to perform");
    expect(properties.sibling).toEqual({ type: "string" });
    expect(parameters.required).toEqual(["action"]);
  });

  it("normalizes anyOf with the same pure-const proof", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    const normalized = normalizeCodexToolSchemas(toolWithProperty("mode", {
      anyOf: constBranches(values),
    })) as Array<Record<string, unknown>>;
    const property = ((normalized[0]?.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).mode!;
    expect(property.enum).toEqual(values);
    expect(property.anyOf).toBeUndefined();
  });

  it("removes a redundant union only when an existing enum is semantically identical", () => {
    const values = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const normalized = normalizeCodexToolSchemas(toolWithProperty("mode", {
      enum: [...values].reverse(),
      oneOf: constBranches(values),
    })) as Array<Record<string, unknown>>;
    const property = ((normalized[0]?.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).mode!;
    expect(property.enum).toEqual([...values].reverse());
    expect(property.oneOf).toBeUndefined();

    const mismatched = normalizeCodexToolSchemas(toolWithProperty("mode", {
      enum: [...values.slice(0, 7), "other"],
      oneOf: constBranches(values),
    })) as Array<Record<string, unknown>>;
    const mismatchedProperty = ((mismatched[0]?.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).mode!;
    expect(mismatchedProperty.oneOf).toHaveLength(8);
  });

  it("leaves small, mixed-constraint, duplicate, and compound unions untouched", () => {
    const small = normalizeCodexToolSchemas(toolWithProperty("mode", {
      oneOf: constBranches(["a", "b", "c", "d", "e", "f", "g"]),
    })) as Array<Record<string, unknown>>;
    expect((((small[0]?.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).mode!).oneOf).toHaveLength(7);

    const mixedBranches = constBranches(["a", "b", "c", "d", "e", "f", "g", "h"]);
    mixedBranches[3] = { ...mixedBranches[3], type: "string" } as typeof mixedBranches[number];
    const mixed = normalizeCodexToolSchemas(toolWithProperty("mode", { oneOf: mixedBranches })) as Array<Record<string, unknown>>;
    expect((((mixed[0]?.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).mode!).oneOf).toHaveLength(8);

    const duplicateValues = ["a", "b", "c", "d", "e", "f", "g", "a"];
    const duplicate = normalizeCodexToolSchemas(toolWithProperty("mode", { oneOf: constBranches(duplicateValues) })) as Array<Record<string, unknown>>;
    expect((((duplicate[0]?.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).mode!).oneOf).toHaveLength(8);

    const compound = normalizeCodexToolSchemas(toolWithProperty("mode", {
      oneOf: constBranches(["a", "b", "c", "d", "e", "f", "g", "h"]),
      anyOf: constBranches(["a", "b", "c", "d", "e", "f", "g", "h"]),
    })) as Array<Record<string, unknown>>;
    const compoundProperty = ((compound[0]?.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).mode!;
    expect(compoundProperty.oneOf).toHaveLength(8);
    expect(compoundProperty.anyOf).toHaveLength(8);
  });

  it("preserves property names containing dots, colons, and backslashes", () => {
    const names = ["action.type", ":action", "path\\segment"];
    const parameters = {
      type: "object",
      properties: Object.fromEntries(names.map((name) => [name, {
        type: "string",
        oneOf: constBranches(["a", "b", "c", "d", "e", "f", "g", "h"]),
      }])),
    };
    const normalized = (normalizeCodexToolSchemas([{ type: "function", name: "lookup", parameters }]) as Array<Record<string, unknown>>)[0]!;
    const properties = (normalized.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;

    expect(Object.keys(properties)).toEqual(names);
    for (const name of names) {
      expect(properties[name]?.enum).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
      expect(properties[name]?.oneOf).toBeUndefined();
    }
  });

  it("preserves null, boolean, number, and string const values without coercion", () => {
    const values = [null, true, false, 0, 1, "1", "true", "null"];
    const normalized = normalizeCodexToolSchemas(toolWithProperty("mode", {
      oneOf: constBranches(values),
    })) as Array<Record<string, unknown>>;
    const property = ((normalized[0]?.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).mode!;
    expect(property.enum).toEqual(values);
  });
});
