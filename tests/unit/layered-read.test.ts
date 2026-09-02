/**
 * `netbox_read`: pagination, truncation, and the errors that teach.
 *
 * The read half exists separately from the write half so `readOnlyHint: true`
 * is true of every call it can make. Nothing in this file may cause a write.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { CHARACTER_LIMIT } from "../../src/constants.js";
import type {
  DescribeResult,
  ObjectTypeSummary,
  Operation,
  SchemaProvider,
} from "../../src/schema/types.js";

const http = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  raw: vi.fn(),
}));

vi.mock("../../src/client.js", () => ({ getClient: () => http }));

const { registerLayeredTools } = await import("../../src/tools/layered/index.js");

const TYPES: ObjectTypeSummary[] = [
  {
    object_type: "dcim.device",
    label: "Device",
    endpoint: "dcim/devices",
    app: "dcim",
    operations: ["list", "get", "create", "update", "delete"],
    summary: "A piece of hardware installed in a rack.",
  },
  {
    object_type: "ipam.prefix",
    label: "Prefix",
    endpoint: "ipam/prefixes",
    app: "ipam",
    operations: ["list", "get", "create", "update", "delete"],
    summary: "An IPv4 or IPv6 network.",
  },
  {
    object_type: "core.objectchange",
    label: "Change Record",
    endpoint: "core/object-changes",
    app: "core",
    operations: ["list"],
    summary: "An audit-log entry. Cannot be fetched individually.",
  },
];

function provider(): SchemaProvider {
  return {
    version: () => Promise.resolve("4.6.7"),
    listObjectTypes: () => Promise.resolve(TYPES),
    resolve: (key: string) =>
      Promise.resolve(TYPES.find((t) => t.object_type === key) ?? undefined),
    describe: (objectType: string, operation: Operation): Promise<DescribeResult> =>
      Promise.resolve({
        object_type: objectType,
        operation,
        endpoint: "dcim/devices",
        fields: [],
        // Shaped like the real thing: `filters` is the summary a model is
        // shown, `filterNames` is the complete parameter set. `name__ic` is in
        // the complete set and not the summary; `status__n` is in neither and
        // has to pass on the lookup-suffix grammar alone.
        filters: [
          { name: "q", type: "string" },
          { name: "id", type: "integer" },
          { name: "name", type: "string" },
          { name: "site", type: "string", description: "Site slug." },
          { name: "status", type: "string" },
        ],
        filterNames: ["q", "id", "name", "site", "status", "name__ic", "id__gte"],
        filterGrammar: "Most filters accept `__n`, `__ic`, `__gte` and similar suffixes.",
        dependsOn: [],
        notes: [],
      }),
  };
}

async function connect(): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerLayeredTools(server, provider());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Parse a tool result without casts: content blocks, error flag, payload. */
const Outcome = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

interface ToolOutcome {
  text: string;
  isError: boolean;
  structured: Record<string, unknown> | undefined;
}

function outcome(raw: unknown): ToolOutcome {
  const parsed = Outcome.parse(raw);
  return {
    text: parsed.content[0]?.text ?? "",
    isError: parsed.isError === true,
    structured: parsed.structuredContent,
  };
}

async function read(client: Client, args: Record<string, unknown>): Promise<ToolOutcome> {
  return outcome(await client.callTool({ name: "netbox_read", arguments: args }));
}

function page(count: number, size: number, prefix = "sw"): unknown {
  return {
    count,
    next: null,
    previous: null,
    results: Array.from({ length: size }, (_, i) => ({
      id: i + 1,
      display: `${prefix}-${i + 1}`,
      name: `${prefix}-${i + 1}`,
    })),
  };
}

let client: Client;

beforeEach(async () => {
  for (const fn of Object.values(http)) fn.mockReset();
  client = await connect();
});

afterEach(async () => {
  await client.close();
});

describe("list", () => {
  it("passes limit, offset and filters to the resolved endpoint", async () => {
    http.list.mockResolvedValue(page(3, 3));
    await read(client, {
      object_type: "ipam.prefix",
      operation: "list",
      filters: { site: "dc1", status: ["active", "reserved"] },
      limit: 10,
      offset: 20,
    });
    expect(http.list).toHaveBeenCalledWith("ipam/prefixes", {
      site: "dc1",
      status: ["active", "reserved"],
      limit: 10,
      offset: 20,
    });
  });

  it("reports pagination state so the caller can continue", async () => {
    http.list.mockResolvedValue(page(130, 50));
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "list",
      limit: 50,
      offset: 0,
      response_format: "json",
    });
    expect(result.structured).toMatchObject({
      total: 130,
      count: 50,
      offset: 0,
      limit: 50,
      has_more: true,
      next_offset: 50,
    });
  });

  it("marks the final page as complete", async () => {
    http.list.mockResolvedValue(page(130, 30));
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "list",
      limit: 50,
      offset: 100,
      response_format: "json",
    });
    expect(result.structured).toMatchObject({ has_more: false });
    expect(result.structured?.next_offset).toBeUndefined();
  });

  it("truncates an oversized page and says where to resume", async () => {
    // 400 rows of padded text comfortably exceeds the 25,000-char budget.
    http.list.mockResolvedValue({
      count: 400,
      next: null,
      previous: null,
      results: Array.from({ length: 400 }, (_, i) => ({
        id: i + 1,
        display: `device-${i + 1}`,
        name: `device-${i + 1}`,
        comments: "x".repeat(200),
      })),
    });
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "list",
      limit: 400,
      offset: 0,
    });
    expect(result.text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(result.text).toContain("Response truncated");
    expect(result.text).toContain("offset=");
    expect(result.structured?.has_more).toBe(true);
    expect(result.structured?.count).toBeLessThan(400);
  });

  it("omits an oversized first item with an explicit truncation marker", async () => {
    http.list.mockResolvedValue({
      count: 1,
      next: null,
      previous: null,
      results: [{ id: 1, display: "oversized", comments: "x".repeat(30_000) }],
    });
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "list",
      limit: 1,
    });
    expect(result.text).toContain("first item is too large");
    expect(result.structured).toMatchObject({
      items: [],
      count: 0,
      items_truncated: true,
      has_more: true,
      next_offset: 0,
    });
    expect(
      result.text.length + JSON.stringify(result.structured).length,
    ).toBeLessThanOrEqual(CHARACTER_LIMIT);
  });

  it("renders an empty result without pretending it failed", async () => {
    http.list.mockResolvedValue(page(0, 0));
    const result = await read(client, { object_type: "dcim.device", operation: "list" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("(no results)");
  });

  it("centrally bounds error text from an upstream adapter", async () => {
    http.get.mockRejectedValue(new Error("x".repeat(30_000)));
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "get",
      id: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(result.text).toContain("complete MCP result budget");
  });

  it("points at netbox_describe when NetBox rejects a filter VALUE", async () => {
    // A name this type accepts, with a value it does not. That judgement is
    // NetBox's and it makes it: a live 4.6.0 answers 400 with the valid
    // choices. Only unknown NAMES are decided locally.
    http.list.mockRejectedValue(
      Object.assign(new Error("Request failed with status code 400"), {
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            status: ["Select a valid choice. nope is not one of the available choices."],
          },
        },
        toJSON: () => ({}),
      }),
    );
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "list",
      filters: { status: "nope" },
    });
    expect(http.list).toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Error: NetBox rejected the request (400 Bad Request)");
    expect(result.text).toContain("netbox_describe");
  });
});

/**
 * A live NetBox 4.6.0 answered HTTP 200 and the FULL unfiltered collection for
 * `?nb_mcp_contract_probe=1`. Nothing downstream can detect that: the model
 * asked for the devices at one site, got every device, and has no way to know.
 * NetBox will not reject an unknown filter name, so this layer must.
 */
describe("unknown filter names are rejected locally", () => {
  it("refuses a misspelled filter and never sends the request", async () => {
    http.list.mockResolvedValue(page(3, 3));
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "list",
      filters: { nmae: "sw-core-01" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("has no such filter");
    expect(result.text).toContain('"nmae"');
    expect(result.text).toContain("did you mean: name");
    expect(result.text).toMatch(/ignores query parameters it does not recognise/i);
    expect(http.list).not.toHaveBeenCalled();
  });

  it("accepts a lookup-suffix variant the summary elides", async () => {
    // `name__ic` is legitimate, is in the derived parameter set, and is NOT in
    // the list netbox_describe shows. Validating against the summary would
    // reject the exact thing filterGrammar tells models to write.
    http.list.mockResolvedValue(page(1, 1));
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "list",
      filters: { name__ic: "core" },
    });
    expect(result.isError).toBe(false);
    expect(http.list).toHaveBeenCalledWith("dcim/devices", {
      name__ic: "core",
      limit: 50,
      offset: 0,
    });
  });

  it("accepts a grammar suffix on a known base the instance did not declare", async () => {
    http.list.mockResolvedValue(page(1, 1));
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "list",
      filters: { status__n: "offline" },
    });
    expect(result.isError).toBe(false);
    expect(http.list).toHaveBeenCalled();
  });

  it("rejects a suffix on a base that does not exist", async () => {
    http.list.mockResolvedValue(page(3, 3));
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "list",
      filters: { nmae__ic: "core" },
    });
    expect(result.isError).toBe(true);
    expect(http.list).not.toHaveBeenCalled();
  });

  it("names every unknown filter, not just the first", async () => {
    http.list.mockResolvedValue(page(3, 3));
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "list",
      filters: { nonsense: "1", site: "dc1", alsowrong: "2" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('"nonsense"');
    expect(result.text).toContain('"alsowrong"');
    expect(http.list).not.toHaveBeenCalled();
  });
});

describe("get", () => {
  it("fetches by id and renders the object", async () => {
    http.get.mockResolvedValue({ id: 7, display: "sw-core-01", name: "sw-core-01" });
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "get",
      id: 7,
    });
    expect(http.get).toHaveBeenCalledWith("dcim/devices", 7);
    expect(result.text).toContain("sw-core-01");
  });

  it("asks for the id rather than guessing one", async () => {
    const result = await read(client, { object_type: "dcim.device", operation: "get" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("'get' needs an 'id'");
    expect(http.get).not.toHaveBeenCalled();
  });

  it("returns raw JSON when asked", async () => {
    http.get.mockResolvedValue({ id: 7, display: "sw-core-01", custom_fields: { a: 1 } });
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "get",
      id: 7,
      response_format: "json",
    });
    expect(result.text).toContain('"custom_fields"');
  });
});

describe("errors teach", () => {
  it("suggests near misses for an unknown object type", async () => {
    const result = await read(client, { object_type: "dcim.devcie", operation: "list" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Unknown object type "dcim.devcie"');
    expect(result.text).toContain("Did you mean: dcim.device");
    expect(http.list).not.toHaveBeenCalled();
  });

  it("suggests near misses for a plausible-but-wrong name", async () => {
    const result = await read(client, {
      object_type: "ipam.prefixes",
      operation: "list",
    });
    expect(result.text).toContain("Did you mean: ipam.prefix");
  });

  it("falls back to pointing at netbox_discover when nothing is close", async () => {
    const result = await read(client, { object_type: "zzzzzzzz", operation: "list" });
    expect(result.text).toContain("Call netbox_discover");
  });

  it("names the supported operations when one is not available", async () => {
    const result = await read(client, {
      object_type: "core.objectchange",
      operation: "get",
      id: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('does not support "get"');
    expect(result.text).toContain("Supported: list");
    expect(http.get).not.toHaveBeenCalled();
  });

  it("rejects a filter name that is not a query parameter", async () => {
    const result = await read(client, {
      object_type: "dcim.device",
      operation: "list",
      filters: { "site;drop": "x" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not a NetBox filter name");
    expect(http.list).not.toHaveBeenCalled();
  });
});
