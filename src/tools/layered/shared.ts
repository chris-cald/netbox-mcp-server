/**
 * Helpers shared by the five layered tools.
 *
 * Two invariants live here and nowhere else:
 *
 *  1. A caller never supplies a path. `object_type` is resolved through the
 *     `SchemaProvider` to an endpoint (`resolveType`), and the endpoint the
 *     provider hands back is itself checked (`assertSafeEndpoint`) before it
 *     reaches the HTTP client. There is no argument on any layered tool
 *     through which an arbitrary URL can be reached.
 *  2. Nothing from an upstream response body is interpolated into an error
 *     message except through `handleApiError`, which is the single place that
 *     decides what an upstream body is allowed to say.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { getClient, type NetBoxApiProvider } from "../../client.js";
import { CHARACTER_LIMIT } from "../../constants.js";
import { handleApiError } from "../../errors.js";
import type {
  DescribeResult,
  FieldSpec,
  ObjectTypeKey,
  ObjectTypeSummary,
  Operation,
  SchemaProvider,
} from "../../schema/types.js";
import { UnknownObjectTypeError, UnsupportedOperationError } from "../../schema/types.js";

/** Number of near-miss object types offered when a name does not resolve. */
const MAX_SUGGESTIONS = 5;

/**
 * An endpoint is a `<app>/<collection>` pair of URL-safe segments. Anything
 * that could climb out of the API root — a dot segment, a scheme, a leading
 * slash, an encoded separator — is refused.
 *
 * The tool layer already prevents a caller from supplying one of these. This
 * is the second line: it also refuses a bad endpoint from the schema layer,
 * so a defect on the other side of the contract cannot become a traversal.
 */
const SAFE_ENDPOINT = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;

export function assertSafeEndpoint(endpoint: string): string {
  const bad =
    !SAFE_ENDPOINT.test(endpoint) ||
    endpoint.split("/").some((segment) => segment === "." || segment === "..");
  if (bad) {
    throw new Error(
      `Refusing to build a request for endpoint "${endpoint}": not a plain NetBox collection path.`,
    );
  }
  return endpoint;
}

/** A tool result carrying Markdown text and an optional structured payload. */
export function textResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (structuredContent) result.structuredContent = structuredContent;
  return result;
}

/** A failed tool result. Always a teaching message, never a bare status code. */
export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Turn any thrown value into a message safe to hand to a model.
 *
 * Local errors (unknown object type, unsupported operation, validation) carry
 * their own guidance; upstream failures go through `handleApiError`, which is
 * the only code permitted to read a NetBox response body.
 */
/**
 * Formats an error before it becomes MCP tool text. Injected API adapters use
 * this narrow contract to redact their active request secret without exposing
 * the secret or a redactor to the tool layer.
 */
export type ApiErrorSanitizer = (error: unknown) => string;

export function requireApiErrorSanitizer(
  api: NetBoxApiProvider,
  sanitize: ApiErrorSanitizer | undefined,
): ApiErrorSanitizer {
  if (sanitize) return sanitize;
  if (api === getClient) return handleApiError;
  throw new Error(
    "An injected NetBox API requires sanitizeApiError so upstream errors cannot reach tool output.",
  );
}

export function toErrorText(error: unknown, sanitize: ApiErrorSanitizer): string {
  return sanitize(error);
}

/** Truncate a single-object rendering that overruns the response budget. */
export function clampText(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT - 200) +
    "\n\n---\n_Response truncated to fit the character limit. " +
    "Request a narrower set of objects if you need the rest._"
  );
}

/**
 * Resolve an `object_type` to its registry entry, or throw an
 * `UnknownObjectTypeError` carrying near-miss suggestions.
 *
 * This is the only way any layered tool obtains an endpoint.
 */
export async function resolveType(
  schema: SchemaProvider,
  objectType: string,
): Promise<ObjectTypeSummary> {
  const summary = await schema.resolve(objectType);
  if (summary) {
    assertSafeEndpoint(summary.endpoint);
    return summary;
  }
  throw new UnknownObjectTypeError(objectType, await suggestTypes(schema, objectType));
}

/** Throw unless the type genuinely supports the operation as a single action. */
export function requireOperation(summary: ObjectTypeSummary, operation: Operation): void {
  if (!summary.operations.includes(operation)) {
    throw new UnsupportedOperationError(
      summary.object_type,
      operation,
      summary.operations,
    );
  }
}

/**
 * Rank the registry against a name that did not resolve.
 *
 * Uses a bigram Dice coefficient over the normalised name, so a typo
 * (`dcim.devcie`), a wrong separator (`dcim/devices`) and a wrong noun
 * (`dcim.machine`) all land near the right entry.
 */
export async function suggestTypes(
  schema: SchemaProvider,
  objectType: string,
): Promise<ObjectTypeKey[]> {
  let candidates: ObjectTypeSummary[];
  try {
    candidates = await schema.listObjectTypes();
  } catch {
    // A failed registry lookup must not mask the original error.
    return [];
  }
  const needle = normalise(objectType);
  if (needle === "") return [];

  const scored = candidates
    .map((c) => ({
      key: c.object_type,
      score: Math.max(
        diceCoefficient(needle, normalise(c.object_type)),
        diceCoefficient(needle, normalise(c.label)),
      ),
    }))
    .filter((c) => c.score >= 0.34)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  return scored.slice(0, MAX_SUGGESTIONS).map((c) => c.key);
}

/**
 * Rank arbitrary names against one that did not match. Used for filter names,
 * where NetBox's silent tolerance of unknown parameters means a typo has to be
 * diagnosed locally or not at all.
 *
 * Bigram overlap alone is not enough here: filter names are short and the
 * commonest typo is a transposition, which shares NO bigrams with the word it
 * came from — `nmae` scores 0 against `name`. Edit distance catches exactly
 * that, so the better of the two is used.
 */
export function suggestNames(
  needle: string,
  candidates: Iterable<string>,
  limit = MAX_SUGGESTIONS,
): string[] {
  const target = normalise(needle);
  if (target === "") return [];
  return [...candidates]
    .map((name) => {
      const other = normalise(name);
      return {
        name,
        score: Math.max(diceCoefficient(target, other), editSimilarity(target, other)),
      };
    })
    .filter((entry) => entry.score >= 0.34)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}

/** 1 for identical, 0 when every character differs. */
function editSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - levenshtein(a, b) / longest;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/** Fields the caller supplies: everything the instance does not compute. */
export function writableFields(fields: FieldSpec[]): FieldSpec[] {
  return fields.filter((f) => !f.readOnly);
}

/** Render one field as a single documentation line. */
function fieldLine(field: FieldSpec): string {
  const bits: string[] = [field.type];
  if (field.enum && field.enum.length > 0) {
    bits.push(`one of: ${field.enum.join(" | ")}`);
  }
  if (field.refersTo) {
    bits.push(
      field.acceptsId
        ? `reference to ${field.refersTo} (pass its numeric id)`
        : `reference to ${field.refersTo}`,
    );
  }
  if (field.nullable) bits.push("nullable");
  const description = field.description?.trim();
  const tail = description ? ` — ${description}` : "";
  return `- \`${field.name}\` (${bits.join(", ")})${tail}`;
}

/**
 * Render a `DescribeResult` as the Markdown that `netbox_describe` returns.
 *
 * `netbox_write` returns the same text inside a validation failure, so a
 * caller that guessed wrong gets everything it needs to fix the call without
 * a second describe round-trip.
 */
export function renderDescribe(
  summary: ObjectTypeSummary,
  result: DescribeResult,
): string {
  const lines: string[] = [
    `# ${summary.label} (\`${summary.object_type}\`) — operation \`${result.operation}\``,
    "",
    summary.summary,
    "",
    `Endpoint: \`${result.endpoint}\`. Supported operations: ${summary.operations.join(", ") || "none"}.`,
    "",
  ];

  if (result.dependsOn.length > 0) {
    lines.push(
      "## Must exist first",
      "These object types are referenced by this one; create or look them up before writing:",
      ...result.dependsOn.map((d) => `- \`${d}\``),
      "",
    );
  }

  const writable = writableFields(result.fields);
  const required = writable.filter((f) => f.required);
  const optional = writable.filter((f) => !f.required);
  const readOnly = result.fields.filter((f) => f.readOnly);

  if (result.operation === "create" || result.operation === "update") {
    lines.push("## Required fields");
    lines.push(
      required.length > 0
        ? required.map(fieldLine).join("\n")
        : "_(none — every field is optional)_",
    );
    if (result.operation === "update") {
      lines.push(
        "",
        "_Update is a partial write: send only the fields you are changing. " +
          "The fields above are required by `create`, not by `update`._",
      );
    }
    lines.push("", "## Optional fields");
    lines.push(optional.length > 0 ? optional.map(fieldLine).join("\n") : "_(none)_", "");
    if (readOnly.length > 0) {
      lines.push(
        "## Read-only fields",
        "Returned by NetBox, computed by NetBox. Do NOT put these in `data` — " +
          "`netbox_write` rejects them locally:",
        readOnly.map((f) => `\`${f.name}\``).join(", "),
        "",
      );
    }
  }

  if (result.operation === "list") {
    lines.push("## Accepted filters");
    const filters = result.filters ?? [];
    lines.push(
      filters.length > 0
        ? filters
            .map(
              (f) =>
                `- \`${f.name}\` (${f.type})${f.description ? ` — ${f.description}` : ""}`,
            )
            .join("\n")
        : "_(none beyond the universal ones)_",
    );
    if (result.filterGrammar) lines.push("", result.filterGrammar);
    lines.push("");
  }

  if (result.operation === "get" || result.operation === "delete") {
    lines.push(
      "## Arguments",
      result.operation === "get"
        ? "- `id` (integer) — the numeric NetBox id of the object to fetch."
        : "- `id` (integer) — the numeric NetBox id of the object to delete.\n" +
            "- `confirm` (string) — must equal the object's current `display` value.",
      "",
    );
  }

  if (result.notes.length > 0) {
    lines.push("## Notes", ...result.notes.map((n) => `- ${n}`), "");
  }

  return lines.join("\n").trimEnd();
}

/** The structured mirror of `renderDescribe`, for callers that want JSON. */
export function describePayload(
  summary: ObjectTypeSummary,
  result: DescribeResult,
): Record<string, unknown> {
  const writable = writableFields(result.fields);
  return {
    object_type: summary.object_type,
    label: summary.label,
    endpoint: result.endpoint,
    operation: result.operation,
    supported_operations: summary.operations,
    depends_on: result.dependsOn,
    required_fields: writable.filter((f) => f.required),
    optional_fields: writable.filter((f) => !f.required),
    read_only_fields: result.fields.filter((f) => f.readOnly).map((f) => f.name),
    filters: result.filters ?? [],
    filter_grammar: result.filterGrammar ?? null,
    notes: result.notes,
    // Mirrors the prose note that `notes` already carries as its first entry.
    // Callers that render Markdown see the note; callers that read
    // `structuredContent` get the same facts as data, with the removal version
    // and its certainty separated from the sentence describing them.
    deprecations: result.deprecations ?? [],
  };
}
