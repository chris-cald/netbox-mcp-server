/**
 * Layer 0 — cross-object fuzzy search.
 *
 * Ported from `src/tools/search.ts` essentially unchanged, because it answers
 * a question the layers do not: *find an instance*, not *find a type*. Without
 * it, "the switch called sw-core-01" costs a discover → describe → read chain
 * every time.
 *
 * NetBox has no single search endpoint, but `q` is accepted on every list
 * endpoint, so this fans one query across the commonly searched resources in
 * parallel. The endpoint list is fixed and internal — no caller-supplied path.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  getClient,
  type NetBoxApiProvider,
  type PaginatedResponse,
} from "../../client.js";
import { displayRef, ResponseFormat, toDisplayString } from "../../formatting.js";
import { ResponseFormatField } from "../../schemas/common.js";
import type { ApiErrorSanitizer } from "./shared.js";
import {
  clampText,
  errorResult,
  requireApiErrorSanitizer,
  textResult,
  toErrorText,
} from "./shared.js";

const SEARCH_TARGETS: { endpoint: string; label: string }[] = [
  { endpoint: "dcim/sites", label: "sites" },
  { endpoint: "dcim/racks", label: "racks" },
  { endpoint: "dcim/devices", label: "devices" },
  { endpoint: "dcim/interfaces", label: "interfaces" },
  { endpoint: "ipam/prefixes", label: "prefixes" },
  { endpoint: "ipam/ip-addresses", label: "ip_addresses" },
  { endpoint: "ipam/vlans", label: "vlans" },
  { endpoint: "ipam/vrfs", label: "vrfs" },
  { endpoint: "plugins/inventory/assets", label: "assets" },
];

const RESOURCE_LABELS = [
  "sites",
  "racks",
  "devices",
  "interfaces",
  "prefixes",
  "ip_addresses",
  "vlans",
  "vrfs",
  "assets",
] as const;

const Input = {
  query: z
    .string()
    .min(1)
    .max(200)
    .describe("Text to search for (passed as NetBox's `q` parameter on every resource)."),
  limit_per_resource: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe("Max hits to return per resource (1-50, default 5)."),
  resources: z
    .array(z.enum(RESOURCE_LABELS))
    .optional()
    .describe("If provided, restrict the search to these resource labels."),
  response_format: ResponseFormatField,
};

const DESCRIPTION = `**Finds a named thing when you do not know what type it is.** One call, across sites, racks, devices, interfaces, prefixes, IP addresses, VLANs and VRFs.

Use this the moment a request contains a specific identifier — a hostname, a partial name, an IP or prefix, a VLAN name, a serial. "What's the management IP for sw-core-01?", "where is rack R12?", "what is 10.0.4.7?" all start here. It returns each hit's numeric id, which you hand straight to netbox_read (operation='get') or netbox_write.

It is the shortcut past the layers. Going netbox_discover -> netbox_describe -> netbox_read to look one named object up costs three calls and answers the same question this one does.

Use netbox_discover instead when you need to know which object *types* exist, and netbox_read when you already know the type and want a filtered list.

Args:
  - query (string, required)         the text to search for.
  - limit_per_resource (number)      max hits per resource (default 5).
  - resources (string[])             restrict to a subset of resource labels.
  - response_format ('markdown' | 'json')

Returns hits grouped by resource with per-resource totals and each hit's numeric id. A resource with no matches is reported as empty, not as an error.`;

interface SectionResult {
  label: string;
  total: number;
  items: Record<string, unknown>[];
  error?: string;
}

export function registerLayeredSearch(
  server: McpServer,
  api: NetBoxApiProvider = getClient,
  sanitizeApiError?: ApiErrorSanitizer,
): void {
  const errorSanitizer = requireApiErrorSanitizer(api, sanitizeApiError);
  server.registerTool(
    "netbox_global_search",
    {
      title: "Global NetBox Search",
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
        const client = api();
        const selected: readonly string[] | undefined = args.resources;
        const targets = selected
          ? SEARCH_TARGETS.filter((t) => selected.includes(t.label))
          : SEARCH_TARGETS;

        const settled = await Promise.allSettled(
          targets.map(async (t) => {
            const data: PaginatedResponse<Record<string, unknown>> = await client.list(
              t.endpoint,
              { q: args.query, limit: args.limit_per_resource },
            );
            const section: SectionResult = {
              label: t.label,
              total: data.count,
              items: data.results,
            };
            return section;
          }),
        );

        const sections: SectionResult[] = settled.map((r, i) =>
          r.status === "fulfilled"
            ? r.value
            : {
                label: targets[i]?.label ?? "unknown",
                total: 0,
                items: [],
                error: toErrorText(r.reason, errorSanitizer),
              },
        );

        const grandTotal = sections.reduce((s, x) => s + x.total, 0);
        const structured: Record<string, unknown> = {
          query: args.query,
          grand_total: grandTotal,
          results: Object.fromEntries(sections.map((s) => [s.label, s])),
        };

        if (args.response_format === ResponseFormat.JSON) {
          return textResult(clampText(JSON.stringify(structured, null, 2)), structured);
        }
        return textResult(
          clampText(renderSections(args.query, sections, grandTotal)),
          structured,
        );
      } catch (error) {
        return errorResult(toErrorText(error, errorSanitizer));
      }
    },
  );
}

function renderSections(
  query: string,
  sections: SectionResult[],
  grandTotal: number,
): string {
  const lines: string[] = [
    `# NetBox search: "${query}"`,
    "",
    `Found ${grandTotal} total hits across ${sections.length} resource(s).`,
    "",
  ];
  for (const section of sections) {
    if (section.error) {
      lines.push(`## ${section.label} — ERROR`, section.error, "");
      continue;
    }
    lines.push(`## ${section.label} (${section.total} total)`);
    if (section.items.length === 0) {
      lines.push("_(no hits)_");
    } else {
      for (const item of section.items) {
        lines.push(renderHit(item));
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderHit(item: Record<string, unknown>): string {
  const display = toDisplayString(
    item.display ??
      item.name ??
      displayRef(item) ??
      item.address ??
      item.prefix ??
      item.vid ??
      `#${toDisplayString(item.id)}`,
  );
  const extras: string[] = [];
  const parent = displayRef(item.device) ?? displayRef(item.site) ?? displayRef(item.vrf);
  if (parent) extras.push(`on ${parent}`);
  if (item.status && typeof item.status === "object") {
    const statusLabel = displayRef(item.status);
    if (statusLabel) extras.push(`status=${statusLabel}`);
  }
  return `- **${display}** (id=${toDisplayString(item.id)})${
    extras.length > 0 ? " — " + extras.join(", ") : ""
  }`;
}
