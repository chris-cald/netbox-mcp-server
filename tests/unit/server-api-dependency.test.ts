/**
 * Server-scoped API dependencies must win over the legacy process-global
 * adapter. This keeps one server instance isolated from another transport or
 * credential source without changing the five-tool public surface.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NetBoxApi } from "../../src/client.js";
import { handleApiError } from "../../src/errors.js";
import { buildServer } from "../../src/server.js";
import { registerLayeredTools } from "../../src/tools/layered/index.js";
import type {
  DescribeResult,
  ObjectTypeSummary,
  Operation,
  SchemaProvider,
} from "../../src/schema/types.js";

const device: ObjectTypeSummary = {
  object_type: "dcim.device",
  label: "Device",
  endpoint: "dcim/devices",
  app: "dcim",
  operations: ["list", "get", "create", "update", "delete"],
  summary: "A network device.",
};

const schema: SchemaProvider = {
  version: () => Promise.resolve("4.6.7"),
  listObjectTypes: () => Promise.resolve([device]),
  resolve: (key: string) =>
    Promise.resolve(key === device.object_type ? device : undefined),
  describe: (objectType: string, operation: Operation): Promise<DescribeResult> =>
    Promise.resolve({
      object_type: objectType,
      operation,
      endpoint: device.endpoint,
      fields: [],
      filters: [],
      filterNames: [],
      dependsOn: [],
      notes: [],
    }),
};

function api() {
  const list = vi
    .fn()
    .mockResolvedValue({ count: 1, next: null, previous: null, results: [{ id: 7 }] });
  return {
    api: {
      list,
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      del: vi.fn(),
    } satisfies NetBoxApi,
    list,
  };
}

async function connect(
  apiDependency: NetBoxApi,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer(
    { NETBOX_URL: "https://isolated.example", NETBOX_TOKEN: "server-scoped-token" },
    { schema, api: { api: apiDependency, sanitizeApiError: handleApiError } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("server API dependency", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("rejects an injected API without a sanitizer before any tool can expose its error", () => {
    const injected = api().api;
    const unsafeOptions = { schema, api: { api: injected } };

    expect(() =>
      buildServer(
        { NETBOX_URL: "https://isolated.example", NETBOX_TOKEN: "server-scoped-token" },
        unsafeOptions as never,
      ),
    ).toThrow("sanitizeApiError");

    const directServer = new McpServer({ name: "test", version: "0.0.0" });
    expect(() => registerLayeredTools(directServer, schema, () => injected)).toThrow(
      "sanitizeApiError",
    );
  });

  it("uses an injected API for a tool call instead of the process-global client", async () => {
    const injected = api();
    const connection = await connect(injected.api);
    close = connection.close;

    await connection.client.callTool({
      name: "netbox_read",
      arguments: { object_type: "dcim.device", operation: "list" },
    });

    expect(injected.list).toHaveBeenCalledWith("dcim/devices", { limit: 50, offset: 0 });
  });

  it("keeps the configured API lazy while tools are listed", async () => {
    const injected = api();
    const connection = await connect(injected.api);
    close = connection.close;

    const tools = await connection.client.listTools();

    expect(tools.tools).toHaveLength(5);
    expect(injected.list).not.toHaveBeenCalled();
  });

  it("sanitizes an injected API error before returning it as a tool result", async () => {
    const token = "injected-api-token-that-must-not-leak";
    const injected: NetBoxApi = {
      list: vi.fn().mockRejectedValue(new Error(`upstream reflected ${token}`)),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      del: vi.fn(),
    };
    const server = buildServer(
      { NETBOX_URL: "https://isolated.example", NETBOX_TOKEN: token },
      {
        schema,
        api: {
          api: injected,
          sanitizeApiError: (error) => String(error).replaceAll(token, "[redacted]"),
        },
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };

    const result = await client.callTool({
      name: "netbox_read",
      arguments: { object_type: "dcim.device", operation: "list" },
    });
    const toolResult = result as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    const text = toolResult.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

    expect(toolResult.isError).toBe(true);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(token);
  });
});
