/** Generic, controlled semantic action tool. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  InvokeInput,
  applicablePrefixAction,
  prefixAction,
  prefixActionVersionError,
  requestForAction,
  supportsPrefixActionVersion,
  validateActionResponse,
  type PrefixActionName,
} from "../actions/ipam-prefix.js";
import type { NetBoxApiProvider } from "../client.js";
import { CHARACTER_LIMIT } from "../constants.js";
import type { SchemaProvider } from "../schema/types.js";
import {
  assertSafeEndpoint,
  errorResult,
  requireApiErrorSanitizer,
  textResult,
  toErrorText,
  type ApiErrorSanitizer,
} from "./layered/shared.js";

const MAX_ACTION_ITEMS = 50;
const MAX_INVOKE_ERROR_CHARS = 1_000;

const DESCRIPTION = `Runs one controlled semantic NetBox action. This is not a generic HTTP client: operation is a closed allowlist and target is always a numeric ipam.prefix id. Do not supply a path, URL, or method.

Available operations are advertised by netbox_discover and netbox_describe only when the connected instance reports NetBox 4.6.x and its OpenAPI schema confirms their exact native request, query, and response shapes. Unknown or out-of-range versions are refused. This server currently has no available-prefixes action because its captured schema fixture provides no evidence for that contract.

Availability is always obtained from NetBox. Allocation accepts exactly one native array item with a 25 KiB UTF-8 JSON body limit, POSTs the endpoint once, and is never automatically retried, preserving NetBox's allocation concurrency behavior.`;

/** The small metadata identity retained if a schema-derived action contract is huge. */
function compactActionMetadata(action: Record<string, unknown>): Record<string, unknown> {
  return {
    name: action.name,
    target_resource_type: action.target_resource_type,
    classification: action.classification,
    native: action.native,
  };
}

function boundedInvokeError(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_INVOKE_ERROR_CHARS
    ? compact
    : `${compact.slice(0, MAX_INVOKE_ERROR_CHARS - 1)}…`;
}

function parseInvokeInput(args: unknown): z.infer<typeof InvokeInput> {
  const parsed = InvokeInput.safeParse(args);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path[0];
  if (field === "operation") {
    throw new Error(
      "Invalid enum value for operation. Choose an advertised controlled operation.",
    );
  }
  if (field === "target") {
    throw new Error("Invalid target. Supply a positive numeric ipam.prefix id.");
  }
  throw new Error(
    "Invalid invoke arguments. Supply a supported operation, positive numeric target, and an object input.",
  );
}

function serializedLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : serialized.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Bound the whole structured MCP result, rather than treating response items as
 * the only untrusted-size component. Schema-derived action metadata can itself
 * be very large on an instance with extensive custom-field definitions.
 */
function boundedActionResult(
  result: unknown,
  action: Record<string, unknown>,
  operation: string,
  target: number,
  classification: Record<string, unknown>,
): {
  payload: Record<string, unknown>;
  truncated: boolean;
  metadataTruncated: boolean;
} {
  if (!Array.isArray(result)) {
    throw new Error(
      "NetBox returned a response that does not match the schema-confirmed array result.",
    );
  }

  let actionMetadata: Record<string, unknown> = action;
  let metadataTruncated = false;
  const makePayload = (
    items: unknown[],
    truncated: boolean,
  ): Record<string, unknown> => ({
    operation,
    target,
    classification,
    action: actionMetadata,
    ...(metadataTruncated ? { action_metadata_truncated: true } : {}),
    result: items,
    result_truncated: truncated,
  });

  // Keep action identity even when its full schema metadata consumes the budget.
  if (serializedLength(makePayload([], result.length > 0)) > CHARACTER_LIMIT) {
    actionMetadata = compactActionMetadata(action);
    metadataTruncated = true;
  }

  const items: unknown[] = [];
  for (const item of result) {
    if (items.length >= MAX_ACTION_ITEMS) break;
    const candidate = [...items, item];
    if (
      serializedLength(makePayload(candidate, candidate.length !== result.length)) >
      CHARACTER_LIMIT
    )
      break;
    items.push(item);
  }
  const truncated = items.length !== result.length;
  return { payload: makePayload(items, truncated), truncated, metadataTruncated };
}

export function registerInvoke(
  server: McpServer,
  schema: SchemaProvider,
  api: NetBoxApiProvider,
  sanitizeApiError?: ApiErrorSanitizer,
): void {
  const errorSanitizer = requireApiErrorSanitizer(api, sanitizeApiError);
  server.registerTool(
    "netbox_invoke",
    {
      title: "Invoke a Controlled NetBox Semantic Action",
      description: DESCRIPTION,
      inputSchema: {
        operation: InvokeInput.shape.operation,
        target: InvokeInput.shape.target,
        input: InvokeInput.shape.input,
      },
      // One tool serves both read and write actions, so the annotation must be
      // conservative. Per-operation classification is returned in metadata.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const parsed = parseInvokeInput(args);
        const definition = prefixAction(parsed.operation);
        if (!definition)
          throw new Error(`Unknown controlled operation "${parsed.operation}".`);

        // An action is executable only when its full OpenAPI contract is
        // compatible. A method/path match alone is deliberately insufficient.
        const version = await schema.version();
        if (!supportsPrefixActionVersion(version)) {
          throw new Error(prefixActionVersionError(version));
        }
        const action = await applicablePrefixAction(schema, definition, version);
        if (!action) {
          throw new Error(
            `Operation "${definition.name}" is not available on this NetBox instance. ` +
              "Its native request, query, or response contract is absent or incompatible.",
          );
        }
        const request = requestForAction(action, parsed.input);

        const summary = await schema.resolve(action.definition.target_resource_type);
        if (!summary)
          throw new Error(
            "The ipam.prefix object type is not available on this instance.",
          );
        const endpoint = assertSafeEndpoint(summary.endpoint);
        // Allocation is intentionally a single native POST. There is no retry
        // wrapper here: NetBox owns availability and conflict semantics.
        const nativeResult = await api().prefixDetailAction(
          endpoint,
          parsed.target,
          action.definition.native.action,
          action.definition.native.method,
          request.body,
          request.params,
        );
        const bounded = boundedActionResult(
          validateActionResponse(action, nativeResult),
          action.metadata as unknown as Record<string, unknown>,
          action.definition.name,
          parsed.target,
          action.definition.classification,
        );
        return textResult(
          `${action.definition.classification.access === "read" ? "Read" : "Allocated via"} ${action.definition.name} for ipam.prefix ${parsed.target}.${bounded.truncated ? " Returned a bounded native response." : ""}${bounded.metadataTruncated ? " Action metadata was compacted to fit the response limit." : ""}`,
          bounded.payload,
        );
      } catch (error) {
        return errorResult(boundedInvokeError(toErrorText(error, errorSanitizer)));
      }
    },
  );
}

export type { PrefixActionName };
