/**
 * `netbox_write`: local validation and the delete confirmation gate.
 *
 * Two behaviours are load-bearing here.
 *
 *  - A bad `data` object never leaves the process, and the rejection carries
 *    the layer-2 description, so the caller can fix the call from the error
 *    alone rather than bouncing off a NetBox 400 (RFC-003 D1).
 *  - A delete requires the caller to echo the object's current `display`
 *    value. NetBox cascades deletes and there is no undo (RFC-003 D2).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  BulkOperation,
  BulkOperationContract,
  DescribeResult,
  FieldSpec,
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
  collectionAction: vi.fn(),
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
    object_type: "core.job",
    label: "Job",
    endpoint: "core/jobs",
    app: "core",
    operations: ["list", "get"],
    summary: "A background job. Read-only.",
  },
];

const DEVICE_FIELDS: FieldSpec[] = [
  { name: "id", type: "integer", required: false, readOnly: true },
  { name: "display", type: "string", required: false, readOnly: true },
  { name: "name", type: "string", required: true, readOnly: false },
  {
    name: "site",
    type: "integer",
    required: true,
    readOnly: false,
    refersTo: "dcim.site",
    acceptsId: true,
  },
  {
    name: "status",
    type: "string",
    required: false,
    readOnly: false,
    enum: ["active", "offline", "planned"],
  },
  { name: "comments", type: "string", required: false, readOnly: false },
  {
    name: "vc_position",
    type: "integer",
    required: false,
    readOnly: false,
    nullable: true,
  },
];

function bulkOperationContract(
  _objectType: string,
  operation: BulkOperation,
): Promise<BulkOperationContract> {
  return Promise.resolve({
    method:
      operation === "bulk_create"
        ? "post"
        : operation === "bulk_update"
          ? "patch"
          : "delete",
    request_schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          status: { type: "string", enum: ["active", "offline"] },
        },
        required: operation === "bulk_create" ? ["name"] : ["id"],
        additionalProperties: false,
      },
    },
    response_content: operation === "bulk_delete" ? "none" : "json",
    ...(operation === "bulk_delete"
      ? {}
      : { response_schema: { type: "array", items: { type: "object" } } }),
  });
}

function provider(includeBulk = true): SchemaProvider {
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
        fields: DEVICE_FIELDS,
        dependsOn: ["dcim.site"],
        notes: ["A device name must be unique within its site."],
      }),
    ...(includeBulk ? { bulkOperationContract } : {}),
  };
}

async function connect(schema: SchemaProvider = provider()): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerLayeredTools(server, schema);
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

async function write(
  client: Client,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  return outcome(await client.callTool({ name: "netbox_write", arguments: args }));
}

let client: Client;

beforeEach(async () => {
  for (const fn of Object.values(http)) fn.mockReset();
  client = await connect();
});

afterEach(async () => {
  await client.close();
});

/** Every local rejection must hand back the describe output. */
function expectsDescribeOutput(text: string): void {
  expect(text).toContain("# Device (`dcim.device`)");
  expect(text).toContain("## Required fields");
  expect(text).toContain("`site`");
  expect(text).toContain("Must exist first");
}

describe("create validation", () => {
  it("rejects an unknown field and returns the describe output", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "create",
      data: { name: "sw-core-01", site: 1, colour: "blue" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown field `colour`");
    expect(result.text).toContain("nothing was sent to NetBox");
    expectsDescribeOutput(result.text);
    expect(http.create).not.toHaveBeenCalled();
  });

  it("rejects a missing required field and returns the describe output", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "create",
      data: { name: "sw-core-01" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Missing required field `site`");
    expect(result.text).toContain("a reference to dcim.site");
    expectsDescribeOutput(result.text);
    expect(http.create).not.toHaveBeenCalled();
  });

  it("rejects a bad enum value and names the accepted ones", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "create",
      data: { name: "sw-core-01", site: 1, status: "running" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("must be one of: active, offline, planned");
    expect(result.text).toContain('Received the string "running"');
    expectsDescribeOutput(result.text);
    expect(http.create).not.toHaveBeenCalled();
  });

  it("rejects a read-only field", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "create",
      data: { name: "sw-core-01", site: 1, id: 99 },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("`id` is read-only");
    expect(http.create).not.toHaveBeenCalled();
  });

  it("rejects a wrong scalar type", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "create",
      data: { name: 7, site: "dc1" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("`name` must be a string");
    expect(result.text).toContain("`site` must be the numeric id of a dcim.site");
    expect(http.create).not.toHaveBeenCalled();
  });

  it("reports every problem at once rather than one per round-trip", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "create",
      data: { colour: "blue", status: "running" },
    });
    expect(result.text).toContain("Unknown field `colour`");
    expect(result.text).toContain("must be one of");
    expect(result.text).toContain("Missing required field `name`");
    expect(result.text).toContain("Missing required field `site`");
  });

  it("requires data", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "create",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("'data' is required");
    expectsDescribeOutput(result.text);
  });

  it("sends a valid payload through unchanged", async () => {
    http.create.mockResolvedValue({ id: 12, display: "sw-core-01", name: "sw-core-01" });
    const data = { name: "sw-core-01", site: 1, status: "active" };
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "create",
      data,
    });
    expect(result.isError).toBe(false);
    expect(http.create).toHaveBeenCalledWith("dcim/devices", data);
    expect(result.text).toContain("Created Device `sw-core-01` (id=12)");
  });

  it("accepts a nested object where a foreign key is expected", async () => {
    http.create.mockResolvedValue({ id: 13, display: "sw-core-02" });
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "create",
      data: { name: "sw-core-02", site: { slug: "dc1" } },
    });
    expect(result.isError).toBe(false);
  });

  it("accepts null for a nullable field", async () => {
    http.create.mockResolvedValue({ id: 14, display: "sw-core-03" });
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "create",
      data: { name: "sw-core-03", site: 1, vc_position: null },
    });
    expect(result.isError).toBe(false);
  });
});

describe("update validation", () => {
  it("does not demand create-required fields on a partial update", async () => {
    http.update.mockResolvedValue({ id: 12, display: "sw-core-01" });
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "update",
      id: 12,
      data: { status: "offline" },
    });
    expect(result.isError).toBe(false);
    expect(http.update).toHaveBeenCalledWith("dcim/devices", 12, { status: "offline" });
    expect(result.text).toContain("Updated Device");
  });

  it("still rejects unknown fields", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "update",
      id: 12,
      data: { colour: "blue" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown field `colour`");
    expect(http.update).not.toHaveBeenCalled();
  });

  it("refuses an update with no id", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "update",
      data: { status: "offline" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("'update' needs an 'id'");
    expect(http.update).not.toHaveBeenCalled();
  });

  it("refuses an empty update", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "update",
      id: 12,
      data: {},
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("at least one field to change");
    expect(http.update).not.toHaveBeenCalled();
  });
});

describe("delete confirmation", () => {
  beforeEach(() => {
    http.get.mockResolvedValue({ id: 12, display: "sw-core-01", name: "sw-core-01" });
  });

  it("refuses on a confirm mismatch and shows both values", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "delete",
      id: 12,
      confirm: "sw-core-02",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('confirm="sw-core-02"');
    expect(result.text).toContain('id=12 is "sw-core-01"');
    expect(http.del).not.toHaveBeenCalled();
  });

  it("refuses when confirm is absent, and quotes the value to echo", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "delete",
      id: 12,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('confirm="sw-core-01"');
    expect(result.text).toContain("cannot be undone");
    expect(http.del).not.toHaveBeenCalled();
  });

  it("deletes when confirm matches the object's display value", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "delete",
      id: 12,
      confirm: "sw-core-01",
    });
    expect(result.isError).toBe(false);
    expect(http.del).toHaveBeenCalledWith("dcim/devices", 12);
    expect(result.text).toContain('Deleted Device "sw-core-01"');
  });

  it("tolerates surrounding whitespace but nothing else", async () => {
    const ok = await write(client, {
      object_type: "dcim.device",
      operation: "delete",
      id: 12,
      confirm: "  sw-core-01 ",
    });
    expect(ok.isError).toBe(false);

    http.del.mockClear();
    const wrongCase = await write(client, {
      object_type: "dcim.device",
      operation: "delete",
      id: 12,
      confirm: "SW-CORE-01",
    });
    expect(wrongCase.isError).toBe(true);
    expect(http.del).not.toHaveBeenCalled();
  });

  it("refuses a delete with no id without reading anything", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "delete",
      confirm: "sw-core-01",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("'delete' needs an 'id'");
    expect(http.get).not.toHaveBeenCalled();
    expect(http.del).not.toHaveBeenCalled();
  });
});

describe("native bulk writes", () => {
  it("refuses an unconfirmed collection operation before a request", async () => {
    const unconfirmed = await connect(provider(false));
    try {
      const result = await write(unconfirmed, {
        object_type: "dcim.device",
        operation: "bulk_create",
        items: [{ name: "sw-core-01" }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("must confirm its collection path");
      expect(http.collectionAction).not.toHaveBeenCalled();
    } finally {
      await unconfirmed.close();
    }
  });

  it("uses only the schema-confirmed collection method for a bulk create", async () => {
    http.collectionAction.mockResolvedValue([{ id: 12, display: "sw-core-01" }]);
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "bulk_create",
      items: [{ name: "sw-core-01" }],
    });
    expect(result.isError).toBe(false);
    expect(http.collectionAction).toHaveBeenCalledTimes(1);
    expect(http.collectionAction).toHaveBeenCalledWith("dcim/devices", "post", [
      { name: "sw-core-01" },
    ]);
    expect(result.structured).toMatchObject({
      object_type: "dcim.device",
      operation: "bulk_create",
      result: [{ id: 12, display: "sw-core-01" }],
    });
  });

  it("requires a payload-bound confirmation before a bulk update", async () => {
    const args = {
      object_type: "dcim.device",
      operation: "bulk_update",
      items: [{ id: 12, status: "offline" }],
    };
    const refused = await write(client, args);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("random token for this exact operation");
    const confirm = /confirm="([^"]+)"/.exec(refused.text)?.[1];
    expect(confirm).toBeDefined();
    expect(confirm).not.toContain("bulk_update");
    expect(http.collectionAction).not.toHaveBeenCalled();

    http.collectionAction.mockResolvedValue([{ id: 12, display: "sw-core-01" }]);
    const confirmed = await write(client, { ...args, confirm });
    expect(confirmed.isError).toBe(false);
    expect(http.collectionAction).toHaveBeenCalledWith(
      "dcim/devices",
      "patch",
      args.items,
    );
  });

  it("binds destructive deletion confirmation to the exact payload and never retries", async () => {
    const args = {
      object_type: "dcim.device",
      operation: "bulk_delete",
      items: [{ id: 12 }],
    };
    const refused = await write(client, args);
    const confirm = /confirm="([^"]+)"/.exec(refused.text)?.[1];
    expect(confirm).toBeDefined();

    http.collectionAction.mockRejectedValue(new Error("connection reset"));
    const failed = await write(client, { ...args, confirm });
    expect(failed.isError).toBe(true);
    expect(http.collectionAction).toHaveBeenCalledTimes(1);

    http.collectionAction.mockClear();
    const changedTargets = await write(client, {
      ...args,
      items: [{ id: 13 }],
      confirm,
    });
    expect(changedTargets.isError).toBe(true);
    expect(changedTargets.text).toContain("invalid, expired, already used");
    expect(http.collectionAction).not.toHaveBeenCalled();

    const retried = await write(client, { ...args, confirm });
    expect(retried.isError).toBe(true);
    expect(retried.text).toContain("invalid, expired, already used");
    expect(http.collectionAction).not.toHaveBeenCalled();
  });

  it("issues distinct random grants only from refusals and enforces the item limit", async () => {
    const args = {
      object_type: "dcim.device",
      operation: "bulk_update",
      items: [{ id: 12 }],
    };
    const first = await write(client, args);
    const second = await write(client, args);
    const firstToken = /confirm="([^"]+)"/.exec(first.text)?.[1];
    const secondToken = /confirm="([^"]+)"/.exec(second.text)?.[1];
    expect(firstToken).toBeDefined();
    expect(secondToken).toBeDefined();
    expect(firstToken).not.toBe(secondToken);

    const tooMany = await write(client, {
      ...args,
      items: Array.from({ length: 101 }, (_, id) => ({ id: id + 1 })),
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toContain("at most 100 items");
    expect(tooMany.text).not.toContain('confirm="');
    expect(http.collectionAction).not.toHaveBeenCalled();
  });

  it("rejects invalid bulk items before a request", async () => {
    const result = await write(client, {
      object_type: "dcim.device",
      operation: "bulk_update",
      items: [{ id: "12", colour: "blue" }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("items[0].id");
    expect(result.text).toContain("items[0].colour");
    expect(http.collectionAction).not.toHaveBeenCalled();
  });
});

describe("operation support", () => {
  it("names what IS supported when the operation is not", async () => {
    const result = await write(client, {
      object_type: "core.job",
      operation: "create",
      data: { name: "x" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('does not support "create"');
    expect(result.text).toContain("Supported: list, get");
    expect(http.create).not.toHaveBeenCalled();
  });
});

describe("upstream failures", () => {
  it("routes a NetBox error through handleApiError rather than echoing it", async () => {
    const upstream = Object.assign(new Error("Request failed with status code 400"), {
      isAxiosError: true,
      response: { status: 400, data: { name: ["This field must be unique."] } },
      config: { headers: { Authorization: "Token s3cr3t-should-never-appear" } },
      toJSON: () => ({}),
    });
    http.create.mockRejectedValue(upstream);

    const result = await write(client, {
      object_type: "dcim.device",
      operation: "create",
      data: { name: "sw-core-01", site: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Error: NetBox rejected the request (400 Bad Request)");
    expect(result.text).not.toContain("s3cr3t");
    expect(result.text).not.toContain("Authorization");
  });
});
