/**
 * Layer 2 — planning.
 *
 * Derived from the connected instance's own schema, so it cannot drift from
 * the instance the way a hand-written tool schema can. Still pure metadata:
 * no NetBox object is read or written here.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { handleApiError } from "../../errors.js";
import type { SchemaProvider } from "../../schema/types.js";
import {
  clampText,
  describePayload,
  errorResult,
  renderDescribe,
  requireOperation,
  resolveType,
  textResult,
  toErrorText,
} from "./shared.js";

const Input = {
  object_type: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Object type key from netbox_discover, e.g. 'dcim.device'. Not a URL and not an endpoint path — only keys the registry returned are accepted.",
    ),
  operation: z
    .enum(["list", "get", "create", "update", "delete"])
    .describe(
      "The operation you intend to perform. The answer differs per operation: 'list' returns filters, 'create' and 'update' return fields.",
    ),
};

const DESCRIPTION = `Explains one NetBox object type: what you must supply, what you may supply, what NetBox computes for you, and what has to exist first.

Call this AFTER netbox_discover (which gives you the object_type) and BEFORE netbox_read or netbox_write. It is generated from the connected instance's own API schema, so it describes that instance — including its plugins and custom fields — rather than a generic NetBox.

What you get per operation:
  - create / update  required fields, optional fields with types and exact enum values, the read-only fields you must NOT send, and 'depends on': the object types that must already exist (a device needs a site, a device type and a role).
  - list             the filters this endpoint accepts, summarised — NetBox exposes hundreds of lookup variants per endpoint and the full set is not usable.
  - get / delete     the arguments needed to address a single object.

Args:
  - object_type (string, required)  a key from netbox_discover.
  - operation   (string, required)  list | get | create | update | delete.

If you skip this and guess at fields, netbox_write will reject the call locally and hand you this same output — so calling it first is strictly cheaper.`;

export function registerDescribe(server: McpServer, schema: SchemaProvider): void {
  server.registerTool(
    "netbox_describe",
    {
      title: "Describe a NetBox Object Type",
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
        const described = await schema.describe(summary.object_type, args.operation);
        return textResult(
          clampText(renderDescribe(summary, described)),
          describePayload(summary, described),
        );
      } catch (error) {
        return errorResult(toErrorText(error, handleApiError));
      }
    },
  );
}
