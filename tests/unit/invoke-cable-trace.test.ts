/* eslint-disable @typescript-eslint/unbound-method -- Vitest assertions inspect mock call state. */
import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { NetBoxApi } from "../../src/client.js";
import { createSchemaProviderFromDocument } from "../../src/schema/provider.js";
import type { SchemaProvider } from "../../src/schema/types.js";
import { registerLayeredTools } from "../../src/tools/layered/index.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/netbox-schema-subset.json", import.meta.url), "utf8"),
) as Parameters<typeof createSchemaProviderFromDocument>[0];

function api(): NetBoxApi & { detailAction: ReturnType<typeof vi.fn> } {
  const detailAction = vi.fn();
  return {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
    detailAction,
  } as NetBoxApi & { detailAction: ReturnType<typeof vi.fn> };
}

async function connect(schema: SchemaProvider, clientApi: NetBoxApi): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0" });
  registerLayeredTools(
    server,
    schema,
    () => clientApi,
    () => "safe upstream error",
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function resultText(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
}

describe("controlled cable trace actions", () => {
  it("derives only the captured GET detail contracts and advertises fixed no-input actions", async () => {
    const schema = createSchemaProviderFromDocument(fixture);
    for (const [objectType, action] of [
      ["dcim.interface", "trace"],
      ["dcim.frontport", "paths"],
      ["dcim.rearport", "paths"],
    ] as const) {
      await expect(
        schema.detailActionContract?.(objectType, action, "get"),
      ).resolves.toMatchObject({
        path_id_schema: { type: "integer" },
        request_content: "none",
        request_required: false,
        response_schema: { type: "object" },
      });
    }

    const http = api();
    const client = await connect(schema, http);
    try {
      const discovered = await client.callTool({
        name: "netbox_discover",
        arguments: { app: "dcim", query: "port" },
      });
      const items = (
        discovered as {
          structuredContent?: {
            items?: Array<{ object_type: string; semantic_actions?: unknown[] }>;
          };
        }
      ).structuredContent?.items;
      expect(
        items?.flatMap((item) =>
          item.semantic_actions?.map((action) => [
            item.object_type,
            (action as { name: string }).name,
          ]),
        ),
      ).toEqual([
        ["dcim.frontport", "dcim.front_port.paths"],
        ["dcim.rearport", "dcim.rear_port.paths"],
      ]);

      const described = await client.callTool({
        name: "netbox_describe",
        arguments: { object_type: "dcim.interface", operation: "get" },
      });
      const actions = (
        described as {
          structuredContent?: {
            semantic_actions?: Array<{ name: string; input_schema: unknown }>;
          };
        }
      ).structuredContent?.semantic_actions;
      expect(actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "dcim.interface.trace",
            input_schema: { type: "object", additionalProperties: false },
          }),
        ]),
      );
    } finally {
      await client.close();
    }
  });

  it("dispatches native GETs without a query and preserves trace and port-path nesting", async () => {
    const http = api();
    const interfacePath = [
      [{ id: 1, name: "edge-a" }],
      { id: 2, label: "C1" },
      [{ id: 3, name: "edge-b" }],
    ];
    const portPaths = [
      {
        id: 1,
        is_active: true,
        is_complete: true,
        is_split: false,
        path: [[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]],
      },
    ];
    http.detailAction
      .mockResolvedValueOnce(interfacePath)
      .mockResolvedValueOnce(portPaths);
    const client = await connect(createSchemaProviderFromDocument(fixture), http);
    try {
      const trace = await client.callTool({
        name: "netbox_invoke",
        arguments: { operation: "dcim.interface.trace", target: 7, input: {} },
      });
      expect(http.detailAction).toHaveBeenLastCalledWith(
        "dcim/interfaces",
        7,
        "trace",
        "get",
        undefined,
        undefined,
      );
      expect(
        (trace as { structuredContent?: { result?: unknown } }).structuredContent?.result,
      ).toEqual({
        kind: "interface-trace",
        path: interfacePath,
      });

      const paths = await client.callTool({
        name: "netbox_invoke",
        arguments: { operation: "dcim.front_port.paths", target: 8, input: {} },
      });
      expect(http.detailAction).toHaveBeenLastCalledWith(
        "dcim/front-ports",
        8,
        "paths",
        "get",
        undefined,
        undefined,
      );
      expect(
        (paths as { structuredContent?: { result?: unknown } }).structuredContent?.result,
      ).toEqual({
        kind: "port-paths",
        paths: portPaths,
      });
    } finally {
      await client.close();
    }
  });

  it("refuses non-positive ids, caller queries, and malformed OpenAPI contracts before a request", async () => {
    const http = api();
    const client = await connect(createSchemaProviderFromDocument(fixture), http);
    try {
      for (const arguments_ of [
        { operation: "dcim.rear_port.paths", target: 0, input: {} },
        {
          operation: "dcim.rear_port.paths",
          target: 9,
          input: { query: { render: "svg" } },
        },
        { operation: "dcim.rear_port.paths", target: 9, input: { width: 800 } },
      ]) {
        const result = await client.callTool({
          name: "netbox_invoke",
          arguments: arguments_,
        });
        expect(resultText(result)).not.toBe("");
      }
      expect(http.detailAction).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }

    const malformed = structuredClone(fixture);
    const trace = malformed.paths?.["/api/dcim/interfaces/{id}/trace/"]?.get;
    if (!trace) throw new Error("fixture GET trace contract is missing");
    trace.requestBody = {
      required: true,
      content: { "application/json": { schema: { type: "object" } } },
    };
    const malformedHttp = api();
    const malformedClient = await connect(
      createSchemaProviderFromDocument(malformed),
      malformedHttp,
    );
    try {
      const result = await malformedClient.callTool({
        name: "netbox_invoke",
        arguments: { operation: "dcim.interface.trace", target: 7, input: {} },
      });
      expect(resultText(result)).not.toBe("");
      expect(malformedHttp.detailAction).not.toHaveBeenCalled();
    } finally {
      await malformedClient.close();
    }
  });
});
