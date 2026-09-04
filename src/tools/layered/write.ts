/**
 * Layer 3 — execution, write half.
 *
 * Separate from `netbox_read` so `destructiveHint: true` is honest: every call
 * to this tool can change or remove data, and a host that prompts on the hint
 * prompts exactly when it should.
 *
 * Two local controls run before anything leaves the process:
 *
 *  - `data` is validated against the layer-2 schema, and a failure returns the
 *    layer-2 description so the caller self-heals in one round-trip instead of
 *    bouncing off a NetBox 400 (RFC-003 D1).
 *  - a delete must echo the object's current `display` value (RFC-003 D2).
 *    NetBox cascades deletes and there is no undo, so a mis-targeted id has to
 *    fail here rather than at the database.
 */

import { randomBytes } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { getClient, type NetBoxApiProvider } from "../../client.js";
import { renderObjectMarkdown, toDisplayString } from "../../formatting.js";
import type {
  BulkOperation,
  BulkOperationContract,
  DescribeResult,
  ObjectTypeSummary,
  SchemaProvider,
} from "../../schema/types.js";
import type { ApiErrorSanitizer } from "./shared.js";
import {
  clampText,
  errorResult,
  requireApiErrorSanitizer,
  renderDescribe,
  requireOperation,
  resolveType,
  textResult,
  toErrorText,
} from "./shared.js";
import { validateBulkItems, validateWriteData } from "./validate.js";

const Input = {
  object_type: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Object type key from netbox_discover, e.g. 'dcim.device'. Not a path and not a URL: the endpoint is resolved from the registry.",
    ),
  operation: z
    .enum(["create", "update", "delete", "bulk_create", "bulk_update", "bulk_delete"])
    .describe(
      "'create' makes one object, 'update' patches one object, 'delete' removes one object; bulk operations use schema-confirmed native collection writes.",
    ),
  id: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Numeric NetBox id. Required for 'update' and 'delete'."),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Field values. Required for 'create' and 'update'. Use exactly the field names netbox_describe returned; unknown fields, read-only fields and bad enum values are rejected locally before any request is sent. For 'update', send only the fields you are changing.",
    ),
  items: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .optional()
    .describe(
      "Required for bulk_create, bulk_update and bulk_delete. Items are validated against the native collection operation's OpenAPI request schema before sending.",
    ),
  confirm: z
    .string()
    .optional()
    .describe(
      "Required for 'delete', 'bulk_update' and 'bulk_delete'. Bulk confirmation is the exact payload-bound token returned by a prior refused call.",
    ),
};

const DESCRIPTION = `Creates, updates or deletes NetBox objects.

Use netbox_discover and netbox_describe before writing. Single create/update use data; update is partial. Single delete requires the current display as confirm.

Native bulk_create, bulk_update and bulk_delete use items. They run only when the instance OpenAPI schema confirms the collection path, method, JSON array request and success response. bulk_update uses PATCH, never collection PUT. At most 100 items and 25 KiB are accepted. bulk_update and bulk_delete first refuse and issue a random, one-use, five-minute payload-bound confirm token; the confirmed request is sent once with no retry. Bulk deletes can cascade and cannot be undone.`;

const MAX_BULK_ITEMS = 100;
const BULK_CONFIRMATION_TTL_MS = 5 * 60_000;
const MAX_BULK_CONFIRMATIONS = 100;

type BulkConfirmationGrant = {
  operation: BulkOperation;
  objectType: string;
  payload: string;
  expiresAt: number;
};

export function registerWrite(
  server: McpServer,
  schema: SchemaProvider,
  api: NetBoxApiProvider = getClient,
  sanitizeApiError?: ApiErrorSanitizer,
): void {
  const errorSanitizer = requireApiErrorSanitizer(api, sanitizeApiError);
  // ponytail: bounded per-server grants; persistent confirmation needs an audited store.
  const bulkConfirmations = new Map<string, BulkConfirmationGrant>();
  server.registerTool(
    "netbox_write",
    {
      title: "Create, Update or Delete a NetBox Object",
      description: DESCRIPTION,
      inputSchema: Input,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const summary = await resolveType(schema, args.object_type);
        if (isBulkOperation(args.operation)) {
          return await runBulkWrite(
            summary,
            args.operation,
            args.items,
            args.confirm,
            schema,
            api,
            bulkConfirmations,
          );
        }
        requireOperation(summary, args.operation);
        if (args.operation === "delete") {
          return await runDelete(summary, args.id, args.confirm, api);
        }
        return await runWrite(schema, summary, args.operation, args.id, args.data, api);
      } catch (error) {
        return errorResult(toErrorText(error, errorSanitizer));
      }
    },
  );
}

function isBulkOperation(operation: string): operation is BulkOperation {
  return (
    operation === "bulk_create" ||
    operation === "bulk_update" ||
    operation === "bulk_delete"
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function issueBulkConfirmation(
  grants: Map<string, BulkConfirmationGrant>,
  operation: BulkOperation,
  objectType: string,
  payload: string,
): string {
  const now = Date.now();
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(token);
  }
  if (grants.size >= MAX_BULK_CONFIRMATIONS) {
    const oldest = grants.keys().next().value;
    if (oldest) grants.delete(oldest);
  }
  const token = randomBytes(32).toString("base64url");
  grants.set(token, {
    operation,
    objectType,
    payload,
    expiresAt: now + BULK_CONFIRMATION_TTL_MS,
  });
  return token;
}

function consumeBulkConfirmation(
  grants: Map<string, BulkConfirmationGrant>,
  token: string,
  operation: BulkOperation,
  objectType: string,
  payload: string,
): boolean {
  const grant = grants.get(token);
  if (!grant) return false;
  grants.delete(token);
  return (
    grant.expiresAt > Date.now() &&
    grant.operation === operation &&
    grant.objectType === objectType &&
    grant.payload === payload
  );
}

function confirmationRequired(operation: BulkOperation): boolean {
  return operation === "bulk_update" || operation === "bulk_delete";
}

function bulkResult(
  summary: ObjectTypeSummary,
  operation: BulkOperation,
  contract: BulkOperationContract,
  nativeResponse: unknown,
  count: number,
): CallToolResult {
  const result =
    contract.response_content === "json"
      ? Array.isArray(nativeResponse)
        ? nativeResponse
        : [nativeResponse]
      : [];
  return textResult(
    `${operation === "bulk_delete" ? "Deleted" : operation === "bulk_update" ? "Updated" : "Created"} ${count} ${summary.label} object(s) with NetBox's native bulk operation.`,
    { object_type: summary.object_type, operation, count, result },
  );
}

async function runBulkWrite(
  summary: ObjectTypeSummary,
  operation: BulkOperation,
  items: Record<string, unknown>[] | undefined,
  confirm: string | undefined,
  schema: SchemaProvider,
  api: NetBoxApiProvider,
  bulkConfirmations: Map<string, BulkConfirmationGrant>,
): Promise<CallToolResult> {
  if (!items)
    return errorResult(`Error: '${operation}' needs a non-empty 'items' array.`);
  const contract = await schema.bulkOperationContract?.(summary.object_type, operation);
  if (!contract) {
    return errorResult(
      `Error: '${operation}' is not available for ${summary.object_type}. The instance schema must confirm its collection path, method, JSON array request and successful response before anything is sent.`,
    );
  }
  if (items.length > MAX_BULK_ITEMS) {
    return errorResult(
      `Error: '${operation}' has ${items.length} items; native bulk operations allow at most ${MAX_BULK_ITEMS} items per request — nothing was sent to NetBox.`,
    );
  }
  const body = stableJson(items);
  if (Buffer.byteLength(body, "utf8") > 25 * 1024) {
    return errorResult(
      `Error: '${operation}' items exceed the 25 KiB native bulk request limit — nothing was sent to NetBox. Split the confirmed target set into smaller batches.`,
    );
  }
  const validation = validateBulkItems(items, contract.request_schema);
  if (!validation.ok) {
    return errorResult(
      `Error: '${operation}' rejected locally — nothing was sent to NetBox.\n` +
        validation.errors.map((error) => `  - ${error}`).join("\n"),
    );
  }
  if (confirmationRequired(operation)) {
    if (confirm === undefined) {
      const token = issueBulkConfirmation(
        bulkConfirmations,
        operation,
        summary.object_type,
        body,
      );
      return errorResult(
        `Error: '${operation}' needs 'confirm'. This refusal issued a random token for this exact operation, object type and payload. Confirm with the user, then call again within five minutes with confirm="${token}". The token is one-use, including if dispatch fails.`,
      );
    }
    if (
      !consumeBulkConfirmation(
        bulkConfirmations,
        confirm.trim(),
        operation,
        summary.object_type,
        body,
      )
    ) {
      return errorResult(
        `Error: ${operation} refused — confirmation is invalid, expired, already used or does not match this exact operation, object type and payload. Request a new confirmation token before retrying.`,
      );
    }
  }
  // Native bulk mutations are one-shot. Retrying can apply a changed target set.
  const nativeResponse = await api().collectionAction(
    summary.endpoint,
    contract.method,
    items,
  );
  return bulkResult(summary, operation, contract, nativeResponse, items.length);
}

async function runWrite(
  schema: SchemaProvider,
  summary: ObjectTypeSummary,
  operation: "create" | "update",
  id: number | undefined,
  data: Record<string, unknown> | undefined,
  api: NetBoxApiProvider,
): Promise<CallToolResult> {
  if (operation === "update" && id === undefined) {
    return errorResult(
      `Error: 'update' needs an 'id'. Find the ${summary.label} first with netbox_read ` +
        `(operation='list' with filters, or 'get' if you already know the id).`,
    );
  }

  const described = await schema.describe(summary.object_type, operation);

  if (data === undefined) {
    return errorResult(
      withDescription(
        `Error: 'data' is required for '${operation}'.`,
        summary,
        described,
      ),
    );
  }

  const outcome = validateWriteData(data, described, operation);
  if (!outcome.ok) {
    return errorResult(
      withDescription(
        `Error: '${operation}' rejected locally — nothing was sent to NetBox.\n` +
          outcome.errors.map((e) => `  - ${e}`).join("\n"),
        summary,
        described,
      ),
    );
  }

  const client = api();
  const result =
    operation === "create"
      ? await client.create<Record<string, unknown>>(summary.endpoint, data)
      : await client.update<Record<string, unknown>>(
          summary.endpoint,
          // Checked above; `update` cannot reach here with an undefined id.
          id ?? 0,
          data,
        );

  const verb = operation === "create" ? "Created" : "Updated";
  return textResult(
    clampText(
      `${verb} ${summary.label} \`${toDisplayString(result.display ?? result.name ?? result.id)}\` (id=${toDisplayString(result.id)}).\n\n` +
        renderObjectMarkdown(result),
    ),
    { object_type: summary.object_type, operation, item: result },
  );
}

/**
 * Delete, gated on the caller echoing the object's own `display` value.
 *
 * The object is fetched first for two reasons: the comparison needs the
 * current value, and a wrong id then fails as a 404 on a read rather than as
 * a cascading delete of the wrong thing.
 */
async function runDelete(
  summary: ObjectTypeSummary,
  id: number | undefined,
  confirm: string | undefined,
  api: NetBoxApiProvider,
): Promise<CallToolResult> {
  if (id === undefined) {
    return errorResult(
      `Error: 'delete' needs an 'id'. Find the ${summary.label} with netbox_read first.`,
    );
  }

  const client = api();
  const object = await client.get<Record<string, unknown>>(summary.endpoint, id);
  const display = toDisplayString(
    object.display ?? object.name ?? object.slug ?? object.address ?? object.prefix ?? "",
  );

  if (confirm === undefined) {
    return errorResult(
      `Error: 'delete' needs 'confirm'. ${summary.label} id=${id} is currently ` +
        `"${display}". Confirm the deletion with the user, then call again with ` +
        `confirm="${display}". Deleting it in NetBox cascades to objects that depend on it and cannot be undone.`,
    );
  }

  if (confirm.trim() !== display.trim()) {
    return errorResult(
      `Error: delete refused — confirmation mismatch. You supplied confirm="${confirm}", ` +
        `but ${summary.object_type} id=${id} is "${display}". ` +
        `Either the id is wrong or the object changed; re-read it with netbox_read ` +
        `(operation='get') and use its current 'display' value.`,
    );
  }

  await client.del(summary.endpoint, id);
  return textResult(
    `Deleted ${summary.label} "${display}" (${summary.object_type} id=${id}). ` +
      "Objects that depended on it may have been removed with it.",
    { object_type: summary.object_type, operation: "delete", id, display, deleted: true },
  );
}

/** Attach the layer-2 description so a rejected call can be fixed in place. */
function withDescription(
  message: string,
  summary: ObjectTypeSummary,
  described: DescribeResult,
): string {
  return clampText(
    `${message}\n\n---\nThis is what \`${summary.object_type}\` accepts for \`${described.operation}\` ` +
      `(the same output netbox_describe returns). Fix the call from this and try again:\n\n` +
      renderDescribe(summary, described),
  );
}
