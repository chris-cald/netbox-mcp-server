import { describe, expect, it } from "vitest";

import type { DetailActionSchema } from "../../src/schema/types.js";
import { validateBulkItems } from "../../src/tools/layered/validate.js";

describe("bulk OpenAPI validation", () => {
  const schema: DetailActionSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, maximum: 3 },
        name: { type: "string", minLength: 2, maxLength: 4 },
        selector: {
          anyOf: [
            { type: "integer", minimum: 10 },
            { type: "string", minLength: 3 },
          ],
        },
      },
      required: ["count", "name", "selector"],
      additionalProperties: false,
    },
  };

  it("enforces preserved scalar bounds and accepts any matching anyOf branch", () => {
    expect(validateBulkItems([{ count: 1, name: "ok", selector: 10 }], schema)).toEqual({
      ok: true,
      errors: [],
    });
    expect(
      validateBulkItems([{ count: 3, name: "four", selector: "abc" }], schema),
    ).toEqual({ ok: true, errors: [] });

    expect(
      validateBulkItems([{ count: 0, name: "x", selector: false }], schema).errors,
    ).toEqual([
      "items[0].count must be at least 1.",
      "items[0].name must be at least 2 character(s).",
      "items[0].selector does not match any allowed value.",
    ]);
    expect(
      validateBulkItems([{ count: 4, name: "fives", selector: 9 }], schema).errors,
    ).toEqual([
      "items[0].count must be at most 3.",
      "items[0].name must be at most 4 character(s).",
      "items[0].selector does not match any allowed value.",
    ]);
  });
});
