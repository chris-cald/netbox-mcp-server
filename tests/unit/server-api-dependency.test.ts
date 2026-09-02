/** Server-scoped API dependencies must win over the legacy global adapter. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NetBoxApi } from "../../src/client.js";
import { buildServer } from "../../src/server.js";
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
async function connect(apiDependency: NetBoxApi) {
  const server = buildServer(
    { NETBOX_URL: "https://isolated.example", NETBOX_TOKEN: "server-scoped-token" },
    { schema, api: apiDependency },
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
  it("keeps the configured API lazy while five tools are listed", async () => {
    const injected = api();
    const connection = await connect(injected.api);
    close = connection.close;
    expect((await connection.client.listTools()).tools).toHaveLength(5);
    expect(injected.list).not.toHaveBeenCalled();
  });
});
