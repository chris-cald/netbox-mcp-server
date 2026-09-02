import { describe, expect, it } from "vitest";

import { CHARACTER_LIMIT } from "../../src/constants.js";
import {
  buildListPayload,
  displayRef,
  enforceCharacterLimit,
  renderListMarkdown,
  renderObjectMarkdown,
  toDisplayString,
} from "../../src/formatting.js";

describe("displayRef", () => {
  it("prefers display, then name, then slug", () => {
    expect(displayRef({ display: "D", name: "N", slug: "s" })).toBe("D");
    expect(displayRef({ name: "N", slug: "s" })).toBe("N");
    expect(displayRef({ slug: "s" })).toBe("s");
  });

  it("returns undefined for values with no label", () => {
    expect(displayRef({ id: 1 })).toBeUndefined();
    expect(displayRef(null)).toBeUndefined();
    expect(displayRef("string")).toBeUndefined();
  });
});

describe("toDisplayString", () => {
  // Regression: template literals over `unknown` produced "[object Object]"
  // in object titles, in nested-reference ids, and in every global-search hit.
  it("never yields [object Object]", () => {
    for (const value of [{ a: 1 }, [1, 2], new Map(), Symbol.iterator]) {
      expect(toDisplayString(value)).not.toContain("[object Object]");
    }
  });

  it("passes primitives through", () => {
    expect(toDisplayString("sw-core-01")).toBe("sw-core-01");
    expect(toDisplayString(7)).toBe("7");
    expect(toDisplayString(false)).toBe("false");
  });

  it("renders nullish as empty rather than the words null or undefined", () => {
    expect(toDisplayString(null)).toBe("");
    expect(toDisplayString(undefined)).toBe("");
  });

  it("uses a nested reference's label when there is one", () => {
    expect(toDisplayString({ id: 3, display: "DC1" })).toBe("DC1");
  });
});

describe("renderObjectMarkdown", () => {
  it("omits id, display and url from the body", () => {
    const text = renderObjectMarkdown({
      id: 7,
      display: "sw-core-01",
      url: "https://n/api/dcim/devices/7/",
      name: "sw-core-01",
    });
    expect(text).toContain("**name**");
    expect(text).not.toContain("**url**");
    expect(text).not.toContain("**display**");
  });

  it("renders a nested reference as label plus id", () => {
    const text = renderObjectMarkdown({
      id: 1,
      name: "x",
      site: { id: 4, display: "DC1" },
    });
    expect(text).toContain("DC1 (id=4)");
  });

  it("skips empty values rather than printing blanks", () => {
    const text = renderObjectMarkdown({ id: 1, name: "x", comments: "", tags: [] });
    expect(text).not.toContain("**comments**");
    expect(text).not.toContain("**tags**");
  });
});

describe("buildListPayload", () => {
  it("reports has_more and the next offset when the server has more rows", () => {
    const payload = buildListPayload([{ id: 1 }, { id: 2 }], 10, 2, 0);
    expect(payload.has_more).toBe(true);
    expect(payload.next_offset).toBe(2);
  });

  it("omits next_offset on the final page", () => {
    const payload = buildListPayload([{ id: 9 }], 5, 2, 4);
    expect(payload.has_more).toBe(false);
    expect(payload.next_offset).toBeUndefined();
  });

  it("handles an empty result set", () => {
    const payload = buildListPayload([], 0, 50, 0);
    expect(payload.has_more).toBe(false);
    expect(payload.count).toBe(0);
  });
});

describe("enforceCharacterLimit", () => {
  const bulky = Array.from({ length: 400 }, (_, i) => ({
    id: i,
    name: `device-${i}`,
    comments: "x".repeat(200),
  }));

  const render = (items: Record<string, unknown>[]) =>
    renderListMarkdown(items, { title: "Devices", total: 400, offset: 0 });

  it("leaves a response that already fits untouched", () => {
    const payload = buildListPayload([{ id: 1, name: "a" }], 1, 50, 0);
    const text = render(payload.items);
    const result = enforceCharacterLimit(text, payload, render);
    expect(result.text).toBe(text);
    expect(result.payload).toBe(payload);
  });

  it("trims an oversized response under the limit", () => {
    const payload = buildListPayload(bulky, 400, 400, 0);
    const result = enforceCharacterLimit(render(bulky), payload, render);
    expect(result.text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(result.payload.items.length).toBeLessThan(bulky.length);
  });

  it("tells the caller how to continue", () => {
    const payload = buildListPayload(bulky, 400, 400, 0);
    const result = enforceCharacterLimit(render(bulky), payload, render);
    expect(result.payload.has_more).toBe(true);
    expect(result.payload.next_offset).toBe(result.payload.items.length);
    expect(result.text).toContain(`offset=${result.payload.next_offset}`);
  });

  it("omits an enormous first item and marks the unadvanced offset", () => {
    const huge = [{ id: 1, name: "big", comments: "x".repeat(CHARACTER_LIMIT * 2) }];
    const payload = buildListPayload(huge, 1, 50, 0);
    const result = enforceCharacterLimit(render(huge), payload, render);
    expect(result.payload).toMatchObject({
      items: [],
      count: 0,
      items_truncated: true,
      has_more: true,
      next_offset: 0,
    });
    expect(result.text).toContain("first item is too large");
    expect(result.text).not.toContain("offset=0");
  });
});
