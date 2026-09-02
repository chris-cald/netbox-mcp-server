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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { getClient, type NetBoxApiProvider } from "../../client.js";
import { renderObjectMarkdown, toDisplayString } from "../../formatting.js";
import type {
  DescribeResult,
  ObjectTypeSummary,
  SchemaProvider,
} from "../../schema/types.js";
import {
  clampText,
  errorResult,
  renderDescribe,
  requireOperation,
  resolveType,
  textResult,
  toErrorText,
} from "./shared.js";
import { validateWriteData } from "./validate.js";

const Input = {
  object_type: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Object type key from netbox_discover, e.g. 'dcim.device'. Not a path and not a URL: the endpoint is resolved from the registry.",
    ),
  operation: z
    .enum(["create", "update", "delete"])
    .describe(
      "'create' makes a new object, 'update' patches an existing one, 'delete' removes it permanently.",
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
  confirm: z
    .string()
    .optional()
    .describe(
      "Required for 'delete': the object's current 'display' value, exactly as netbox_read returned it. If it does not match, the delete is refused.",
    ),
};

const DESCRIPTION = `Creates, updates or deletes a NetBox object. This changes the source of truth for someone's network — treat it accordingly.

Call netbox_discover first (for the object_type), then netbox_describe with the operation you intend (for the fields and prerequisites), then this. Skipping describe does not save a round-trip: this tool validates 'data' against the instance's schema before sending anything, and a rejection returns that same description.

Args:
  - object_type (string, required)  key from netbox_discover.
  - operation   (string, required)  'create' | 'update' | 'delete'.
  - id          (number)            required for 'update' and 'delete'.
  - data        (object)            field values; required for 'create' and 'update'.
  - confirm     (string)            required for 'delete'.

Rules that are enforced, not advisory:
  - References are ids. A device needs its site, device_type and role to exist already; create or look them up first (netbox_describe lists them under 'must exist first').
  - 'update' is a partial write. Only the fields present in 'data' change; everything else is left alone.
  - 'delete' requires 'confirm' to equal the object's current 'display' value. Read the object first (netbox_read with operation='get'), copy the 'display' value, and pass it. A mismatch refuses the delete and shows both values. Deletes cascade in NetBox — removing a site can remove its racks, devices and prefixes — and cannot be undone, so confirm with the user before calling.`;

export function registerWrite(
  server: McpServer,
  schema: SchemaProvider,
  api: NetBoxApiProvider = getClient,
): void {
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
        requireOperation(summary, args.operation);

        if (args.operation === "delete") {
          return await runDelete(summary, args.id, args.confirm, api);
        }
        return await runWrite(schema, summary, args.operation, args.id, args.data, api);
      } catch (error) {
        return errorResult(toErrorText(error));
      }
    },
  );
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
