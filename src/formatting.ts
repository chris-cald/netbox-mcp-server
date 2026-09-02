/**
 * Shared formatting helpers for tool responses.
 *
 * All list/get tools return both `text` (human-friendly) and `structuredContent`
 * (machine-friendly). For `response_format="markdown"` we render a concise
 * summary; for `response_format="json"` we serialize the structured data.
 */

import { CHARACTER_LIMIT } from "./constants.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/**
 * NetBox nested-object references (e.g. `site`, `tenant`, `device_type`) have
 * a consistent shape. This pulls out a short label for them.
 */
export function displayRef(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.display === "string") return v.display;
  if (typeof v.name === "string") return v.name;
  if (typeof v.slug === "string") return v.slug;
  if (typeof v.address === "string") return v.address;
  if (typeof v.prefix === "string") return v.prefix;
  return undefined;
}

/**
 * Coerce an arbitrary NetBox field into something safe to interpolate.
 *
 * Template literals over `unknown` silently produce "[object Object]", which
 * reaches the model as if it were data. Every label in a response goes through
 * here instead.
 */
export function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return displayRef(value) ?? "[object]";
}

/** Render a NetBox row as a concise Markdown heading + bullet list. */
export function renderObjectMarkdown(
  obj: Record<string, unknown>,
  opts: { title?: string | undefined; fields?: string[] | undefined } = {},
): string {
  const id = toDisplayString(obj.id);
  const display = toDisplayString(
    obj.display ?? obj.name ?? obj.slug ?? obj.address ?? obj.prefix ?? `#${id}`,
  );
  const title = opts.title ?? `${display} (id=${id})`;

  const lines: string[] = [`## ${title}`];
  const fields = opts.fields ?? Object.keys(obj);

  for (const field of fields) {
    if (field === "id" || field === "display" || field === "url") continue;
    const val = obj[field];
    if (val === undefined || val === null || val === "") continue;
    const rendered = renderValue(val);
    if (rendered === undefined) continue;
    lines.push(`- **${field}**: ${rendered}`);
  }
  return lines.join("\n");
}

/** Render a collection of NetBox rows as a Markdown list. */
export function renderListMarkdown(
  objects: Record<string, unknown>[],
  opts: {
    title: string;
    total: number;
    offset: number;
    fields?: string[] | undefined;
  },
): string {
  const lines: string[] = [
    `# ${opts.title}`,
    "",
    `Found ${opts.total} total; showing ${objects.length} starting at offset ${opts.offset}.`,
    "",
  ];
  if (objects.length === 0) {
    lines.push("_(no results)_");
    return lines.join("\n");
  }
  for (const obj of objects) {
    lines.push(renderObjectMarkdown(obj, { fields: opts.fields }));
    lines.push("");
  }
  return lines.join("\n");
}

function renderValue(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
    return String(val);
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return undefined;
    const rendered = val.map((v) => renderValue(v)).filter(Boolean);
    return rendered.join(", ");
  }
  if (typeof val === "object") {
    const ref = displayRef(val);
    if (ref) {
      const id = (val as Record<string, unknown>).id;
      return id !== undefined ? `${ref} (id=${toDisplayString(id)})` : ref;
    }
    // Don't dump full nested objects into bullet lists — use JSON format for that.
    return "[object]";
  }
  return toDisplayString(val);
}

export interface ListPayload<T> {
  total: number;
  count: number;
  offset: number;
  limit: number;
  items: T[];
  has_more: boolean;
  next_offset?: number;
  /** Present when even the first returned item was too large to include. */
  items_truncated?: boolean;
}

export function buildListPayload<T>(
  results: T[],
  total: number,
  limit: number,
  offset: number,
): ListPayload<T> {
  const hasMore = total > offset + results.length;
  const payload: ListPayload<T> = {
    total,
    count: results.length,
    offset,
    limit,
    items: results,
    has_more: hasMore,
  };
  if (hasMore) payload.next_offset = offset + results.length;
  return payload;
}

/**
 * If the serialized response exceeds CHARACTER_LIMIT, trim the list and attach
 * a truncation message telling the caller how to paginate or filter.
 */
export function enforceCharacterLimit(
  text: string,
  payload: ListPayload<Record<string, unknown>>,
  markdownRenderer: (items: Record<string, unknown>[]) => string,
): { text: string; payload: ListPayload<Record<string, unknown>> } {
  if (text.length <= CHARACTER_LIMIT) return { text, payload };

  // Binary-trim down to a size that fits. Zero is valid: returning one
  // oversized item breaks the response budget and conceals the truncation.
  let lo = 0;
  let hi = payload.items.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const trial = markdownRenderer(payload.items.slice(0, mid));
    if (trial.length <= CHARACTER_LIMIT - 300) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const truncated = payload.items.slice(0, best);
  const newPayload: ListPayload<Record<string, unknown>> = {
    ...payload,
    count: truncated.length,
    items: truncated,
    has_more: true,
    next_offset: payload.offset + truncated.length,
    items_truncated: true,
  };
  const message =
    `\n\n---\n_Response truncated from ${payload.items.length} to ${truncated.length} items to fit the character limit. ` +
    (truncated.length === 0
      ? "The first item is too large to return; add filters to narrow the response."
      : `Call the same tool again with offset=${newPayload.next_offset} to continue, ` +
        "or add filters to narrow the result set.") +
    "_";
  const newText = markdownRenderer(truncated) + message;
  return { text: newText, payload: newPayload };
}
