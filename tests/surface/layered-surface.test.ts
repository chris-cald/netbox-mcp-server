/**
 * The context cost of the layered surface.
 *
 * A client pays for `tools/list` before the user has said anything, so it is
 * subtracted from every conversation the server takes part in. The old
 * one-tool-per-operation surface cost 446 tools and 720,863 characters — about
 * 180,000 tokens, which does not fit in a 200k window at all.
 *
 * This is the test that proves the replacement: six tools, and a payload
 * small enough that nobody has to think about it again. The ceiling is
 * measured over the complete `tools/list` response — names, descriptions,
 * input schemas and annotations — because that is what a client receives.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  DescribeResult,
  ObjectTypeSummary,
  SchemaProvider,
} from "../../src/schema/types.js";
import { registerLayeredTools } from "../../src/tools/layered/index.js";

const CEILING_TOOLS = 6;
const CEILING_CHARS = 15_000;

const EXPECTED_TOOLS = [
  "netbox_describe",
  "netbox_discover",
  "netbox_global_search",
  "netbox_read",
  "netbox_write",
  "netbox_invoke",
];

/**
 * The surface must not depend on the connected instance: `tools/list` is
 * answered before any schema is fetched. A provider that throws on every call
 * is the strongest way to assert that.
 */
const inertProvider: SchemaProvider = {
  version: () => Promise.reject(new Error("tools/list must not fetch the schema")),
  listObjectTypes: (): Promise<ObjectTypeSummary[]> =>
    Promise.reject(new Error("tools/list must not fetch the schema")),
  resolve: () => Promise.reject(new Error("tools/list must not fetch the schema")),
  describe: (): Promise<DescribeResult> =>
    Promise.reject(new Error("tools/list must not fetch the schema")),
};

async function listTools(): Promise<Tool[]> {
  const server = new McpServer({ name: "netbox-mcp-server", version: "0.1.0" });
  registerLayeredTools(server, inertProvider);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "introspect", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.listTools();
    return result.tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("layered tool surface", () => {
  it("is six tools and a rounding error", async () => {
    const tools = await listTools();
    const size = JSON.stringify(tools).length;
    // Reported so a regression shows the number, not just the failure.
    console.log(`layered tools/list: ${tools.length} tools, ${size} characters`);

    expect(tools.length).toBe(CEILING_TOOLS);
    expect(size).toBeLessThan(CEILING_CHARS);
  });

  it("registers exactly the six layered tools", async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("namespaces every tool and documents it", async () => {
    for (const tool of await listTools()) {
      expect(tool.name.startsWith("netbox_"), `${tool.name} is not namespaced`).toBe(
        true,
      );
      expect(
        (tool.description ?? "").length,
        `${tool.name} has no description`,
      ).toBeGreaterThan(200);
    }
  });

  it("keeps the read/write annotation split honest", async () => {
    const tools = await listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of [
      "netbox_read",
      "netbox_discover",
      "netbox_describe",
      "netbox_global_search",
    ]) {
      const annotations = byName.get(name)?.annotations;
      expect(annotations?.readOnlyHint, `${name} must be readOnlyHint`).toBe(true);
      expect(annotations?.destructiveHint, `${name} must not be destructive`).toBe(false);
    }

    // The only reason there are two execution tools rather than one.
    const write = byName.get("netbox_write")?.annotations;
    expect(write?.readOnlyHint).toBe(false);
    expect(write?.destructiveHint).toBe(true);
    expect(write?.idempotentHint).toBe(false);
  });

  /**
   * The previous version of this test asserted that netbox_discover's
   * description says "START HERE". It did, and models obeyed it literally:
   * running six of them against the published 0.1.1 package, a trivial count
   * took four calls where one would do, and netbox_global_search — kept in the
   * surface precisely so a name lookup costs one call — was used by NEITHER
   * model on the task it exists for. See docs/reference/eval-model-in-loop.md.
   *
   * So the property worth pinning is not "the layer order is stated". It is
   * "every description points at the CHEAPER route as well as the thorough
   * one". A tool that only ever advertises the long way round gets taken the
   * long way round.
   */
  it("points each tool at its cheaper alternative, not just at the next layer", async () => {
    const byName = new Map(
      (await listTools()).map((t) => [t.name, t.description ?? ""] as const),
    );

    // Nothing may claim the start unconditionally. Case-SENSITIVE on purpose:
    // the defect was a shouted directive at the top of a description, not the
    // words themselves — "all start here" in ordinary prose is fine, and an
    // earlier version of this assertion failed on exactly that.
    for (const [name, description] of byName) {
      expect(description, `${name} claims to be the mandatory entry point`).not.toContain(
        "START HERE",
      );
    }

    // The two tools a model reaches for first must both name the shortcut.
    expect(byName.get("netbox_discover")).toContain("netbox_global_search");
    expect(byName.get("netbox_read")).toContain("netbox_global_search");

    // A model that already knows the type must be told it can go straight to
    // the read — that is the four-calls-for-a-count case.
    expect(byName.get("netbox_read")).toMatch(/call this directly/i);

    // The shortcut has to say what triggers it, in the first line, or it loses
    // the attention contest to whichever description is read first.
    const search = byName.get("netbox_global_search") ?? "";
    expect(search.split("\n")[0]).toMatch(/named thing|do not know what type/i);

    // The layer order still has to be recoverable for the cases that need it.
    expect(byName.get("netbox_discover")).toContain("netbox_describe");
    expect(byName.get("netbox_describe")).toContain("netbox_discover");
    expect(byName.get("netbox_describe")).toContain("netbox_write");
    expect(byName.get("netbox_write")).toContain("netbox_describe");
    expect(byName.get("netbox_global_search")).toContain("netbox_read");
  });

  it("exposes no argument that could carry a path", async () => {
    // Structural, not advisory: nothing in the input schemas is a URL or path.
    const forbidden = /\b(path|url|endpoint|uri)\b/i;
    for (const tool of await listTools()) {
      const properties = tool.inputSchema.properties ?? {};
      for (const key of Object.keys(properties)) {
        expect(
          forbidden.test(key),
          `${tool.name}.${key} looks like a path argument`,
        ).toBe(false);
      }
    }
  });
});
