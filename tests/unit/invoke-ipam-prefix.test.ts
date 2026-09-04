/* eslint-disable @typescript-eslint/unbound-method -- Vitest assertions inspect mock call state. */
import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { NetBoxApi } from "../../src/client.js";
import { createSchemaProviderFromDocument } from "../../src/schema/provider.js";
import type { ObjectTypeSummary, SchemaProvider } from "../../src/schema/types.js";
import { registerLayeredTools } from "../../src/tools/layered/index.js";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/netbox-schema-subset.json", import.meta.url), "utf8"),
) as Parameters<typeof createSchemaProviderFromDocument>[0];

const prefix: ObjectTypeSummary = {
  object_type: "ipam.prefix",
  label: "Prefix",
  endpoint: "ipam/prefixes",
  app: "ipam",
  operations: ["list", "get", "create", "update", "delete"],
  summary: "Prefix objects (ipam/prefixes).",
};

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
    (error) =>
      `safe upstream error: ${error instanceof Error ? error.message : "unknown"}`,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function resultText(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content[0]?.text ?? "";
}

function semanticActions(result: unknown): Array<Record<string, unknown>> {
  return (
    (
      result as {
        structuredContent?: { semantic_actions?: Array<Record<string, unknown>> };
      }
    ).structuredContent?.semantic_actions ?? []
  );
}

describe("IPAM prefix controlled semantic actions", () => {
  it("derives only fixture-proven available-IP action metadata and envelopes", async () => {
    const schema = createSchemaProviderFromDocument(fixture);
    const get = await schema.detailActionContract?.(
      "ipam.prefix",
      "available-ips",
      "get",
    );
    const post = await schema.detailActionContract?.(
      "ipam.prefix",
      "available-ips",
      "post",
    );
    const unknown = await schema.detailActionContract?.(
      "ipam.prefix",
      "available-prefixes",
      "get",
    );
    expect(get).toMatchObject({
      path_id_schema: { type: "integer" },
      query_schema: {
        type: "object",
        properties: { brief: { type: "boolean" }, fields: { type: "string" } },
      },
      response_schema: { type: "array", items: { type: "object" } },
    });
    expect(get?.query_schema.properties).not.toHaveProperty("limit");
    expect(post).toMatchObject({
      path_id_schema: { type: "integer" },
      request_required: true,
      request_schema: { type: "array", items: { type: "object" } },
      response_schema: { type: "array", items: { type: "object" } },
    });
    expect(unknown).toBeUndefined();

    const http = api();
    const client = await connect(schema, http);
    try {
      const discovered = await client.callTool({
        name: "netbox_discover",
        arguments: { query: "ipam.prefix" },
      });
      const discoveredActions = (
        discovered as {
          structuredContent?: {
            items?: Array<{ semantic_actions?: Array<Record<string, unknown>> }>;
          };
        }
      ).structuredContent?.items?.[0]?.semantic_actions;
      expect(discoveredActions?.map((action) => action.name)).toEqual([
        "ipam.prefix.available_ips",
        "ipam.prefix.allocate_ip",
      ]);

      const response = await client.callTool({
        name: "netbox_describe",
        arguments: { object_type: "ipam.prefix", operation: "get" },
      });
      const actions = semanticActions(response);
      expect(actions.map((action) => action.name)).toEqual([
        "ipam.prefix.available_ips",
        "ipam.prefix.allocate_ip",
      ]);
      expect(actions[0]).toMatchObject({
        input_schema: {
          properties: {
            query: {
              properties: { brief: { type: "boolean" }, fields: { type: "string" } },
            },
          },
        },
        output_schema: { type: "array", items: { type: "object" } },
      });
      expect(
        (
          actions[0]?.input_schema as {
            properties?: { query?: { properties?: Record<string, unknown> } };
          }
        ).properties?.query?.properties,
      ).not.toHaveProperty("limit");
      expect(actions[1]).toMatchObject({
        input_schema: {
          required: ["data"],
          properties: { data: { type: "array", items: { type: "object" } } },
        },
        output_schema: { type: "array", items: { type: "object" } },
      });
    } finally {
      await client.close();
    }
  });

  it("preserves required native query parameters in metadata and rejects requests that omit them", async () => {
    const requiredQuery = structuredClone(fixture);
    const queryParameters =
      requiredQuery.paths?.["/api/ipam/prefixes/{id}/available-ips/"]?.get?.parameters;
    const brief = queryParameters?.find((parameter) => parameter.name === "brief");
    if (!brief)
      throw new Error("fixture GET action unexpectedly lacks brief query parameter");
    brief.required = true;

    const schema = createSchemaProviderFromDocument(requiredQuery);
    const contract = await schema.detailActionContract?.(
      "ipam.prefix",
      "available-ips",
      "get",
    );
    expect(contract?.query_schema.required).toEqual(["brief"]);

    const http = api();
    const client = await connect(schema, http);
    try {
      const described = await client.callTool({
        name: "netbox_describe",
        arguments: { object_type: "ipam.prefix", operation: "get" },
      });
      expect(
        (
          semanticActions(described)[0]?.input_schema as {
            properties?: { query?: { required?: string[] } };
          }
        ).properties?.query?.required,
      ).toEqual(["brief"]);

      const rejected = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.available_ips",
          target: 7,
          input: { query: {} },
        },
      });
      expect(resultText(rejected)).toContain("query.brief is required");
      expect(http.detailAction).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("rejects absent, non-JSON, or malformed capabilities, unknown actions, and invalid input before requests", async () => {
    const noContract: SchemaProvider = {
      version: () => Promise.resolve("4.6.7"),
      listObjectTypes: () => Promise.resolve([prefix]),
      resolve: (key) => Promise.resolve(key === prefix.object_type ? prefix : undefined),
      describe: () =>
        Promise.resolve({
          object_type: prefix.object_type,
          operation: "get",
          endpoint: prefix.endpoint,
          fields: [],
          dependsOn: [],
          notes: [],
        }),
      supportsDetailAction: () => Promise.resolve(true),
    };
    const http = api();
    const client = await connect(noContract, http);
    try {
      const unavailable = await client.callTool({
        name: "netbox_invoke",
        arguments: { operation: "ipam.prefix.available_ips", target: 7, input: {} },
      });
      expect(resultText(unavailable)).toContain("not available");
      const unknown = await client.callTool({
        name: "netbox_invoke",
        arguments: { operation: "not.an.action", target: 7, input: {} },
      });
      expect(resultText(unknown)).toContain("Invalid enum value");
      expect(http.detailAction).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }

    const malformed = structuredClone(fixture);
    const malformedPost =
      malformed.paths?.["/api/ipam/prefixes/{id}/available-ips/"]?.post;
    if (!malformedPost?.requestBody?.content?.["application/json"]?.schema) {
      throw new Error("fixture post action unexpectedly missing its body");
    }
    malformedPost.requestBody.content["application/json"].schema = { type: "object" };
    const malformedHttp = api();
    const malformedClient = await connect(
      createSchemaProviderFromDocument(malformed),
      malformedHttp,
    );
    try {
      const invalid = await malformedClient.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.allocate_ip",
          target: 7,
          input: { data: { dns_name: "host.example" } },
        },
      });
      expect(resultText(invalid)).toContain("not available");
      expect(malformedHttp.detailAction).not.toHaveBeenCalled();
    } finally {
      await malformedClient.close();
    }

    const nonJson = structuredClone(fixture);
    const nonJsonPost = nonJson.paths?.["/api/ipam/prefixes/{id}/available-ips/"]?.post;
    if (!nonJsonPost?.requestBody) {
      throw new Error("fixture post action unexpectedly lacks a request body");
    }
    nonJsonPost.requestBody.content = { "text/plain": { schema: { type: "array" } } };
    const nonJsonHttp = api();
    const nonJsonClient = await connect(
      createSchemaProviderFromDocument(nonJson),
      nonJsonHttp,
    );
    try {
      const rejected = await nonJsonClient.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.allocate_ip",
          target: 7,
          input: { data: [{}] },
        },
      });
      expect(resultText(rejected)).toContain("not available");
      expect(nonJsonHttp.detailAction).not.toHaveBeenCalled();
    } finally {
      await nonJsonClient.close();
    }
  });

  it("does not advertise or dispatch allocation when its POST requires query parameters", async () => {
    const requiredQuery = structuredClone(fixture);
    const post = requiredQuery.paths?.["/api/ipam/prefixes/{id}/available-ips/"]?.post;
    if (!post) throw new Error("fixture post action unexpectedly missing");
    post.parameters = [
      ...(post.parameters ?? []),
      {
        in: "query",
        name: "required_query",
        required: true,
        schema: { type: "string" },
      },
    ];

    const http = api();
    const client = await connect(createSchemaProviderFromDocument(requiredQuery), http);
    try {
      const discovered = await client.callTool({
        name: "netbox_discover",
        arguments: { query: "ipam.prefix" },
      });
      const actions = (
        discovered as {
          structuredContent?: {
            items?: Array<{ semantic_actions?: Array<{ name: string }> }>;
          };
        }
      ).structuredContent?.items?.[0]?.semantic_actions;
      expect(actions?.map((action) => action.name)).toEqual([
        "ipam.prefix.available_ips",
      ]);

      const response = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.allocate_ip",
          target: 7,
          input: { data: [{}] },
        },
      });
      expect(resultText(response)).toContain("not available");
      expect(http.detailAction).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("does not advertise or dispatch allocation when its POST array items are not objects", async () => {
    const malformed = structuredClone(fixture);
    const requestSchema =
      malformed.paths?.["/api/ipam/prefixes/{id}/available-ips/"]?.post?.requestBody
        ?.content?.["application/json"]?.schema;
    if (!requestSchema)
      throw new Error("fixture post action unexpectedly lacks its body");
    requestSchema.items = { type: "string" };

    const http = api();
    const client = await connect(createSchemaProviderFromDocument(malformed), http);
    try {
      const discovered = await client.callTool({
        name: "netbox_discover",
        arguments: { query: "ipam.prefix" },
      });
      const actions = (
        discovered as {
          structuredContent?: {
            items?: Array<{ semantic_actions?: Array<{ name: string }> }>;
          };
        }
      ).structuredContent?.items?.[0]?.semantic_actions;
      expect(actions?.map((action) => action.name)).toEqual([
        "ipam.prefix.available_ips",
      ]);

      const response = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.allocate_ip",
          target: 7,
          input: { data: [{}] },
        },
      });
      expect(resultText(response)).toContain("not available");
      expect(http.detailAction).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("sends exact schema-derived query/body envelopes and reports bounded arrays", async () => {
    const http = api();
    http.detailAction
      .mockResolvedValueOnce(
        Array.from({ length: 60 }, (_, id) => ({
          address: `192.0.2.${id}`,
          family: 4,
          vrf: null,
        })),
      )
      .mockResolvedValueOnce([]);
    const client = await connect(createSchemaProviderFromDocument(fixture), http);
    try {
      const read = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.available_ips",
          target: 7,
          input: { query: { brief: true, fields: "id,address" } },
        },
      });
      expect(http.detailAction).toHaveBeenLastCalledWith(
        "ipam/prefixes",
        7,
        "available-ips",
        "get",
        undefined,
        { brief: true, fields: "id,address" },
      );
      const bounded = (
        read as { structuredContent?: { result?: unknown[]; result_truncated?: boolean } }
      ).structuredContent;
      expect(bounded?.result).toHaveLength(50);
      expect(bounded?.result_truncated).toBe(true);

      await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.allocate_ip",
          target: 7,
          input: { data: [{ prefix_length: 31 }] },
        },
      });
      expect(http.detailAction).toHaveBeenLastCalledWith(
        "ipam/prefixes",
        7,
        "available-ips",
        "post",
        [{ prefix_length: 31 }],
        undefined,
      );

      const invalid = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.available_ips",
          target: 7,
          input: { limit: 2 },
        },
      });
      expect(resultText(invalid)).toContain("Invalid input");

      const multipleAllocations = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.allocate_ip",
          target: 7,
          input: { data: [{}, {}] },
        },
      });
      expect(resultText(multipleAllocations)).toContain("exactly one item");

      const oversizedAllocation = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.allocate_ip",
          target: 7,
          input: { data: [{ padding: "x".repeat(25 * 1024) }] },
        },
      });
      expect(resultText(oversizedAllocation)).toContain("25 KiB");
      expect(http.detailAction).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
    }
  });

  it("rejects unknown and out-of-range NetBox versions before requests", async () => {
    for (const version of ["unknown", "4.5.9", "4.7.0"]) {
      const versionedFixture = structuredClone(fixture);
      versionedFixture.info = { ...versionedFixture.info, version };
      const http = api();
      const client = await connect(
        createSchemaProviderFromDocument(versionedFixture),
        http,
      );
      try {
        const response = await client.callTool({
          name: "netbox_invoke",
          arguments: {
            operation: "ipam.prefix.available_ips",
            target: 7,
            input: { query: {} },
          },
        });
        expect(resultText(response)).toContain("NetBox 4.6.x");
        expect(http.detailAction).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    }
  });

  it("bounds the complete structured action result, including oversized action metadata", async () => {
    const oversizedMetadata = structuredClone(fixture);
    const availableIp = oversizedMetadata.components?.schemas?.AvailableIP;
    if (!availableIp) throw new Error("fixture unexpectedly lacks AvailableIP schema");
    availableIp.description = "x".repeat(26_000);
    const http = api();
    http.detailAction.mockResolvedValue([]);
    const client = await connect(
      createSchemaProviderFromDocument(oversizedMetadata),
      http,
    );
    try {
      const response = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.available_ips",
          target: 7,
          input: { query: {} },
        },
      });
      const structured = (response as { structuredContent?: unknown }).structuredContent;
      expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
      expect(
        resultText(response).length + JSON.stringify(structured).length,
      ).toBeLessThanOrEqual(25_000);
      expect(structured).toMatchObject({ action_metadata_truncated: true });
    } finally {
      await client.close();
    }
  });

  it("does not advertise or invoke an action without a required integer path id", async () => {
    for (const mutate of [
      (document: typeof fixture) => {
        const parameter = document.paths?.[
          "/api/ipam/prefixes/{id}/available-ips/"
        ]?.get?.parameters?.find((entry) => entry.in === "path" && entry.name === "id");
        if (parameter) parameter.required = false;
      },
      (document: typeof fixture) => {
        const parameter = document.paths?.[
          "/api/ipam/prefixes/{id}/available-ips/"
        ]?.get?.parameters?.find((entry) => entry.in === "path" && entry.name === "id");
        if (parameter?.schema) parameter.schema.type = "string";
      },
    ]) {
      const malformed = structuredClone(fixture);
      mutate(malformed);
      const http = api();
      const client = await connect(createSchemaProviderFromDocument(malformed), http);
      try {
        const discovered = await client.callTool({
          name: "netbox_discover",
          arguments: { query: "ipam.prefix" },
        });
        const row = (
          discovered as {
            structuredContent?: {
              items?: Array<{ semantic_actions?: Array<Record<string, unknown>> }>;
            };
          }
        ).structuredContent?.items?.[0];
        expect(row?.semantic_actions?.map((action) => action.name)).toEqual([
          "ipam.prefix.allocate_ip",
        ]);

        const response = await client.callTool({
          name: "netbox_invoke",
          arguments: {
            operation: "ipam.prefix.available_ips",
            target: 7,
            input: { query: {} },
          },
        });
        expect(resultText(response)).toContain("not available");
        expect(http.detailAction).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    }
  });

  it("rejects native action responses whose items omit schema-required fields", async () => {
    const http = api();
    http.detailAction.mockResolvedValue([{ address: "192.0.2.1", vrf: null }]);
    const client = await connect(createSchemaProviderFromDocument(fixture), http);
    try {
      const response = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.available_ips",
          target: 7,
          input: { query: {} },
        },
      });
      expect(resultText(response)).toContain("response[0].family is required");
      expect(http.detailAction).toHaveBeenCalledOnce();
    } finally {
      await client.close();
    }
  });

  it("rejects role:null when the captured response contract declares an object", async () => {
    const http = api();
    http.detailAction.mockResolvedValue([
      {
        address: "192.0.2.1/32",
        assigned_object: null,
        created: null,
        display: "192.0.2.1/32",
        display_url: "http://netbox.test/ipam/ip-addresses/1/",
        family: { value: 4, label: "IPv4" },
        id: 1,
        last_updated: null,
        nat_outside: [],
        role: null,
        url: "http://netbox.test/api/ipam/ip-addresses/1/",
      },
    ]);
    const client = await connect(createSchemaProviderFromDocument(fixture), http);
    try {
      const response = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.allocate_ip",
          target: 7,
          input: { data: [{}] },
        },
      });
      expect(resultText(response)).toContain("response[0].role must be an object");
      expect(http.detailAction).toHaveBeenCalledOnce();
    } finally {
      await client.close();
    }
  });

  it("compacts oversized action metadata in discover and describe structured content", async () => {
    const oversizedMetadata = structuredClone(fixture);
    const availableIp = oversizedMetadata.components?.schemas?.AvailableIP;
    if (!availableIp) throw new Error("fixture unexpectedly lacks AvailableIP schema");
    availableIp.description = "x".repeat(26_000);
    const http = api();
    const client = await connect(
      createSchemaProviderFromDocument(oversizedMetadata),
      http,
    );
    try {
      for (const request of [
        { name: "netbox_discover", arguments: { query: "ipam.prefix" } },
        {
          name: "netbox_describe",
          arguments: { object_type: "ipam.prefix", operation: "get" },
        },
      ] as const) {
        const response = await client.callTool(request);
        const structured = (response as { structuredContent?: Record<string, unknown> })
          .structuredContent;
        expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
        expect(structured).toMatchObject({ semantic_actions_metadata_truncated: true });
      }
    } finally {
      await client.close();
    }
  });

  it("bounds invoke validation errors without echoing caller-controlled keys", async () => {
    const http = api();
    const client = await connect(createSchemaProviderFromDocument(fixture), http);
    const callerKey = "untrusted_" + "x".repeat(30_000);
    try {
      const response = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.available_ips",
          target: 7,
          input: { [callerKey]: true },
        },
      });
      const text = resultText(response);
      expect(text.length).toBeLessThanOrEqual(1_000);
      expect(text).not.toContain(callerKey);
      expect(http.detailAction).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("surfaces allocation conflicts once without retrying", async () => {
    const http = api();
    http.detailAction.mockRejectedValue(new Error("409 allocation conflict"));
    const client = await connect(createSchemaProviderFromDocument(fixture), http);
    try {
      const result = await client.callTool({
        name: "netbox_invoke",
        arguments: {
          operation: "ipam.prefix.allocate_ip",
          target: 7,
          input: { data: [{}] },
        },
      });
      expect(resultText(result)).toContain("safe upstream error");
      expect(http.detailAction).toHaveBeenCalledOnce();
    } finally {
      await client.close();
    }
  });
});
