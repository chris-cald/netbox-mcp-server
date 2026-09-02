/**
 * Layer 3 — execution, read half.
 *
 * Split from `netbox_write` so that `readOnlyHint: true` is the truth rather
 * than an average. A host that gates on annotations must be able to let every
 * call to this tool through without prompting.
 *
 * The endpoint comes from the schema provider, never from the caller.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  getClient,
  type NetBoxApiProvider,
  type PaginatedResponse,
} from "../../client.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../../constants.js";
import {
  buildListPayload,
  enforceCharacterLimit,
  renderListMarkdown,
  renderObjectMarkdown,
  ResponseFormat,
} from "../../formatting.js";
import { ResponseFormatField } from "../../schemas/common.js";
import type {
  DescribeResult,
  ObjectTypeSummary,
  SchemaProvider,
} from "../../schema/types.js";
import type { ApiErrorSanitizer } from "./shared.js";
import {
  clampText,
  errorResult,
  requireApiErrorSanitizer,
  requireOperation,
  resolveType,
  suggestNames,
  textResult,
  toErrorText,
} from "./shared.js";

/** A query-parameter name NetBox could plausibly accept. */
const FILTER_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * The `__` lookup suffixes `FILTER_GRAMMAR` promises a model it may append.
 *
 * The derived parameter set already contains almost every combination, so this
 * is a safety net rather than the rule: a suffix the instance did not happen to
 * declare on a filter it did declare must not be rejected, because the grammar
 * told the model to use it.
 */
const LOOKUP_SUFFIXES = new Set([
  "n",
  "ic",
  "nic",
  "isw",
  "nisw",
  "iew",
  "niew",
  "ie",
  "nie",
  "empty",
  "regex",
  "iregex",
  "lt",
  "lte",
  "gt",
  "gte",
  "any",
]);

/** Parameters `netbox_read` supplies itself; always legitimate. */
const PAGINATION_PARAMETERS = ["limit", "offset"];

const FilterValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

type FilterInput = z.infer<typeof FilterValue>;

const Input = {
  object_type: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Object type key from netbox_discover, e.g. 'dcim.device'. Not a path and not a URL: the endpoint is resolved from the registry.",
    ),
  operation: z
    .enum(["list", "get"])
    .describe("'list' for a filtered collection, 'get' for one object by id."),
  id: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Numeric NetBox id. Required for 'get', ignored for 'list'."),
  filters: z
    .record(z.string(), FilterValue)
    .optional()
    .describe(
      "Query filters for 'list', as NetBox query-parameter names, e.g. { site: 'dc1', status: 'active', q: 'sw-core' }. Call netbox_describe(object_type, 'list') for the accepted names. An array value repeats the parameter (OR semantics for most filters). A name this object type does not accept is rejected here rather than sent: NetBox silently ignores unknown parameters and would return the whole unfiltered collection.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Page size for 'list' (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Rows to skip for 'list'. Use next_offset from a previous response."),
  response_format: ResponseFormatField,
};

const DESCRIPTION = `Reads NetBox objects: one by id, or a filtered, paginated list. Never modifies anything.

**If you know the object_type, call this directly.** Keys are \`<app>.<model>\`, singular — \`dcim.device\`, \`ipam.prefix\`, \`ipam.ipaddress\`, \`dcim.site\`. A wrong key is answered with near-misses, so guessing a plausible one costs no more than looking it up first. "How many devices are there?" is one call to this tool: list \`dcim.device\` and read the total.

Reach for another tool when:
  - the user named a THING rather than a type ("the switch sw-core-01") —
    netbox_global_search finds it across types in one call;
  - you need filter names you cannot guess, or are about to write —
    netbox_describe;
  - the type is a plugin model, which is not guessable — netbox_discover.

Args:
  - object_type (string, required)  e.g. 'ipam.prefix'.
  - operation   (string, required)  'list' or 'get'.
  - id          (number)            required for 'get'.
  - filters     (object)            for 'list'; NetBox query-parameter names -> values.
  - limit / offset (number)         pagination for 'list'.
  - response_format ('markdown' | 'json')  use 'json' when chaining to another call.

Returns Markdown by default, or JSON shaped { total, count, offset, limit, items, has_more, next_offset? }. The total is reported whatever the limit, so limit=1 is enough to count. Long responses are truncated and tell you the offset to resume from — paginate or filter rather than raising limit.

A filter value is usually a slug or an id, not a display name: filter devices by site='dc1' (slug) or site_id=3, not site='DC 1'. An unknown filter name is rejected here with the valid ones listed, because NetBox itself would ignore it and return everything.`;

export function registerRead(
  server: McpServer,
  schema: SchemaProvider,
  api: NetBoxApiProvider = getClient,
  sanitizeApiError?: ApiErrorSanitizer,
): void {
  const errorSanitizer = requireApiErrorSanitizer(api, sanitizeApiError);
  server.registerTool(
    "netbox_read",
    {
      title: "Read NetBox Objects",
      description: DESCRIPTION,
      inputSchema: Input,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const summary = await resolveType(schema, args.object_type);
        requireOperation(summary, args.operation);
        return args.operation === "get"
          ? await runGet(summary, args, api)
          : await runList(summary, args, schema, api, errorSanitizer);
      } catch (error) {
        return errorResult(toErrorText(error, errorSanitizer));
      }
    },
  );
}

interface ReadArgs {
  operation: "list" | "get";
  id?: number | undefined;
  filters?:
    Record<string, string | number | boolean | (string | number | boolean)[]> | undefined;
  limit: number;
  offset: number;
  response_format: ResponseFormat;
}

async function runGet(
  summary: ObjectTypeSummary,
  args: ReadArgs,
  api: NetBoxApiProvider,
): Promise<CallToolResult> {
  if (args.id === undefined) {
    return errorResult(
      `Error: 'get' needs an 'id'. Either supply the numeric id of the ${summary.label}, ` +
        `or call netbox_read with operation='list' (optionally with filters) to find it.`,
    );
  }
  const object = await api().get<Record<string, unknown>>(summary.endpoint, args.id);
  if (args.response_format === ResponseFormat.JSON) {
    return textResult(clampText(JSON.stringify(object, null, 2)), {
      object_type: summary.object_type,
      item: object,
    });
  }
  return textResult(clampText(renderObjectMarkdown(object)), {
    object_type: summary.object_type,
    item: object,
  });
}

/**
 * Every filter name this type accepts, as a set.
 *
 * The summarised list a model is shown is not the valid set — it elides the
 * `__` lookup variants (120 of 158 on `dcim.site`) — so the complete derived
 * parameter list is what a name is checked against, with the summary folded in
 * for a provider that only supplies one.
 */
function acceptedFilterNames(described: DescribeResult): Set<string> {
  return new Set([
    ...(described.filterNames ?? []),
    ...(described.filters ?? []).map((filter) => filter.name),
    ...PAGINATION_PARAMETERS,
  ]);
}

function isAcceptedFilter(name: string, accepted: Set<string>): boolean {
  if (accepted.has(name)) return true;
  const separator = name.lastIndexOf("__");
  if (separator <= 0) return false;
  return (
    LOOKUP_SUFFIXES.has(name.slice(separator + 2)) &&
    accepted.has(name.slice(0, separator))
  );
}

/**
 * Reject a filter name this instance does not have.
 *
 * NetBox is TOLERANT of unknown query parameters: a live 4.6.0 answered HTTP
 * 200 with the full unfiltered collection for `?nb_mcp_contract_probe=1`, and
 * said nothing. So a model that misspells `site` does not get an error — it
 * gets EVERY device, believes it filtered, and acts on the result. NetBox will
 * not catch this, which is why it is caught here.
 *
 * Only unknown NAMES are rejected. A known filter with a bad value is NetBox's
 * to judge and it does: it answers 400 naming the valid choices.
 */
function unknownFilterMessage(
  summary: ObjectTypeSummary,
  described: DescribeResult,
  unknown: string[],
): string {
  const accepted = acceptedFilterNames(described);
  const advertised = (described.filters ?? []).map((filter) => filter.name);
  const suggestionPool = advertised.length > 0 ? advertised : [...accepted];
  const named = unknown
    .map((name) => {
      const near = suggestNames(name, suggestionPool, 3);
      return near.length > 0
        ? `"${name}" (did you mean: ${near.join(", ")}?)`
        : `"${name}"`;
    })
    .join(", ");
  return (
    `Error: ${summary.object_type} has no such filter: ${named}. ` +
    "The request was NOT sent: NetBox ignores query parameters it does not recognise and " +
    "would have returned the whole unfiltered collection as though the filter had applied. " +
    `Call netbox_describe with object_type="${summary.object_type}" and operation="list" ` +
    "for the accepted names, then retry."
  );
}

/**
 * NetBox turns brief mode on for ANY non-empty value of `brief`. The check is
 * `request.GET.get('brief')` — a bare truthiness test on the raw string — so
 * `brief=false` and `brief=0` both ENABLE it, because `'false'` and `'0'` are
 * truthy Python strings. Absence is the only way to turn it off.
 *
 * That inverts the obvious call. A model asking for full objects writes
 * `{ brief: false }` and receives the compact form, which is a well-formed
 * object with most of its fields missing — it does not look like an error, and
 * a caller that then reports a field as absent from NetBox would be wrong.
 * Same failure shape as the misspelled filter that returned the whole
 * collection: the request succeeds and the answer is not what was asked for.
 *
 * So `brief` is translated rather than forwarded — falsey values drop the
 * parameter, truthy ones send the canonical `true`. Both directions are what
 * the caller asked for; nothing else is touched, and real boolean filters like
 * `enabled=false` keep going through verbatim.
 *
 * Source-level reading of `netbox/netbox/api/viewsets/__init__.py` on 4.6.8,
 * not documented behaviour: it could change without a release note.
 */
export function normaliseBrief(
  filters: Record<string, FilterInput>,
): Record<string, FilterInput> {
  if (!("brief" in filters)) return filters;
  const { brief, ...rest } = filters;
  const off =
    brief === undefined ||
    brief === false ||
    brief === 0 ||
    brief === "" ||
    brief === "false" ||
    brief === "0";
  return off ? rest : { ...rest, brief: true };
}

async function runList(
  summary: ObjectTypeSummary,
  args: ReadArgs,
  schema: SchemaProvider,
  api: NetBoxApiProvider,
  sanitizeApiError: ApiErrorSanitizer,
): Promise<CallToolResult> {
  const filters = args.filters ?? {};
  const names = Object.keys(filters);
  const badKeys = names.filter((k) => !FILTER_KEY.test(k));
  if (badKeys.length > 0) {
    return errorResult(
      `Error: not a NetBox filter name: ${badKeys.map((k) => `"${k}"`).join(", ")}. ` +
        `Call netbox_describe with object_type="${summary.object_type}" and operation="list" for the accepted filters.`,
    );
  }

  if (names.length > 0) {
    const described = await schema.describe(summary.object_type, "list");
    const accepted = acceptedFilterNames(described);
    const unknown = names.filter((name) => !isAcceptedFilter(name, accepted));
    if (unknown.length > 0) {
      return errorResult(unknownFilterMessage(summary, described, unknown));
    }
  }

  let response: PaginatedResponse<Record<string, unknown>>;
  try {
    response = await api().list<Record<string, unknown>>(summary.endpoint, {
      ...normaliseBrief(filters),
      limit: args.limit,
      offset: args.offset,
    });
  } catch (error) {
    return errorResult(
      `${toErrorText(error, sanitizeApiError)}\nIf a filter name is the problem, call netbox_describe with ` +
        `object_type="${summary.object_type}" and operation="list" for the accepted filters.`,
    );
  }

  const payload = buildListPayload(
    response.results,
    response.count,
    args.limit,
    args.offset,
  );
  const title = `${summary.label} (${summary.object_type})`;
  const renderer = (items: Record<string, unknown>[]): string =>
    renderListMarkdown(items, {
      title,
      total: response.count,
      offset: args.offset,
    });

  if (args.response_format === ResponseFormat.JSON) {
    const jsonRenderer = (items: Record<string, unknown>[]): string =>
      JSON.stringify({ ...payload, count: items.length, items }, null, 2);
    const bounded = enforceCharacterLimit(
      jsonRenderer(payload.items),
      payload,
      jsonRenderer,
    );
    return textResult(bounded.text, {
      object_type: summary.object_type,
      ...bounded.payload,
    });
  }

  const bounded = enforceCharacterLimit(renderer(payload.items), payload, renderer);
  return textResult(bounded.text, {
    object_type: summary.object_type,
    ...bounded.payload,
  });
}
