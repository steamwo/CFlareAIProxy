import { describe, expect, it } from "vitest";
import { normalizeKimiToolSchemas } from "./kimi";

function parameters(body: Record<string, unknown>): Record<string, any> {
  const tools = body.tools as Array<Record<string, any>>;
  return tools[0]!.function.parameters;
}

describe("Kimi tool schema normalization", () => {
  it("inlines local $defs refs, keeps sibling fields, and removes definitions", () => {
    const body = normalizeKimiToolSchemas({
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            $defs: {
              Query: {
                type: "object",
                properties: { q: { type: "string", description: "base" } },
                required: ["q"],
              },
            },
            properties: {
              query: { $ref: "#/$defs/Query", description: "overridden sibling" },
            },
          },
        },
      }],
    });

    expect(parameters(body)).toEqual({
      type: "object",
      properties: {
        query: {
          type: "object",
          properties: { q: { type: "string", description: "base" } },
          required: ["q"],
          description: "overridden sibling",
        },
      },
    });
  });

  it("normalizes legacy functions and preserves an existing non-object root type", () => {
    const body = normalizeKimiToolSchemas({
      functions: [{
        name: "legacy",
        parameters: {
          type: "string",
          definitions: { Value: { type: "string" } },
          allOf: [{ $ref: "#/definitions/Value" }],
        },
      }],
    });

    const fn = (body.functions as Array<Record<string, any>>)[0]!;
    expect(fn.parameters.type).toBe("string");
    expect(fn.parameters).not.toHaveProperty("definitions");
    expect(fn.parameters.allOf).toEqual([{ type: "string" }]);
  });

  it("leaves external refs unresolved without throwing", () => {
    const body = normalizeKimiToolSchemas({
      tools: [{
        type: "function",
        function: { name: "external", parameters: { $ref: "https://example.com/schema.json", description: "remote" } },
      }],
    });

    expect(parameters(body)).toMatchObject({
      type: "object",
      $ref: "https://example.com/schema.json",
      description: "remote",
    });
  });

  it("keeps cyclic local definitions available instead of recursively expanding forever", () => {
    const body = normalizeKimiToolSchemas({
      tools: [{
        type: "function",
        function: {
          name: "tree",
          parameters: {
            $defs: {
              Node: {
                type: "object",
                properties: { next: { $ref: "#/$defs/Node" } },
              },
            },
            $ref: "#/$defs/Node",
          },
        },
      }],
    });

    const normalized = parameters(body);
    expect(normalized.type).toBe("object");
    expect(normalized.$defs).toBeDefined();
    expect(normalized.properties.next.$ref).toBe("#/$defs/Node");
  });

  it("does not alter non-object parameter values", () => {
    const body = normalizeKimiToolSchemas({
      tools: [{ type: "function", function: { name: "noop", parameters: true } }],
      functions: [{ name: "legacy", parameters: null }],
    });

    expect((body.tools as Array<Record<string, any>>)[0]!.function.parameters).toBe(true);
    expect((body.functions as Array<Record<string, any>>)[0]!.parameters).toBeNull();
  });
});
