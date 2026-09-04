import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { buildServer, SERVER_VERSION } from "../../src/server.js";

interface Fixture {
  url: string;
  token: string;
  prefix: { id: number };
  topology: {
    sourceInterface: { id: number };
    frontPort: { id: number };
    rearPort: { id: number };
  };
  logPath: string;
}

interface FixtureRunner {
  withNetBoxFixture<T>(callback: (fixture: Fixture) => Promise<T>): Promise<T>;
}

async function connectMcp(
  url: string,
  token: string,
): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = buildServer({ NETBOX_URL: url, NETBOX_TOKEN: token });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "netbox-e2e", version: SERVER_VERSION });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe.skipIf(process.env.NETBOX_E2E !== "1")(
  "patched NetBox 4.6.7 semantic-action fixture",
  () => {
    it("validates the nullable-role patch, preserves native reads, and allocates one persisted IP without retrying", async () => {
      const runnerUrl = new URL("../../scripts/e2e-netbox.mjs", import.meta.url);
      const runner = (await import(runnerUrl.href)) as unknown as FixtureRunner;
      await runner.withNetBoxFixture(
        async ({ url, token, prefix, topology, logPath }) => {
          const headers = {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          };
          const schemaResponse = await fetch(new URL("/api/schema/?format=json", url), {
            headers,
          });
          expect(
            schemaResponse.status,
            `schema request failed; redacted log: ${logPath}`,
          ).toBe(200);
          const schema = (await schemaResponse.json()) as {
            components?: {
              schemas?: { IPAddress?: { properties?: { role?: unknown } } };
            };
          };
          expect(schema.components?.schemas?.IPAddress?.properties?.role).toMatchObject({
            nullable: true,
          });

          const nativeBeforeResponse = await fetch(
            new URL(`/api/ipam/prefixes/${prefix.id}/available-ips/`, url),
            { headers },
          );
          expect(
            nativeBeforeResponse.status,
            `native request failed; redacted log: ${logPath}`,
          ).toBe(200);
          const nativeBefore = await nativeBeforeResponse.json();
          expect(Array.isArray(nativeBefore)).toBe(true);
          if (!Array.isArray(nativeBefore))
            throw new Error("Native availability response was not an array.");

          const mcp = await connectMcp(url, token);
          try {
            const read = await mcp.client.callTool({
              name: "netbox_invoke",
              arguments: {
                operation: "ipam.prefix.available_ips",
                target: prefix.id,
                input: { query: {} },
              },
            });
            const readStructured = read as { structuredContent?: { result?: unknown } };
            expect(readStructured.structuredContent?.result).toEqual(nativeBefore);

            for (const action of [
              {
                operation: "dcim.interface.trace",
                target: topology.sourceInterface.id,
                path: `/api/dcim/interfaces/${topology.sourceInterface.id}/trace/`,
                resultKey: "path",
                resultKind: "interface-trace",
              },
              {
                operation: "dcim.front_port.paths",
                target: topology.frontPort.id,
                path: `/api/dcim/front-ports/${topology.frontPort.id}/paths/`,
                resultKey: "paths",
                resultKind: "port-paths",
              },
              {
                operation: "dcim.rear_port.paths",
                target: topology.rearPort.id,
                path: `/api/dcim/rear-ports/${topology.rearPort.id}/paths/`,
                resultKey: "paths",
                resultKind: "port-paths",
              },
            ] as const) {
              const nativeResponse = await fetch(new URL(action.path, url), { headers });
              expect(nativeResponse.status, `native ${action.operation} failed`).toBe(
                200,
              );
              const native = await nativeResponse.json();
              expect(
                Array.isArray(native),
                `native ${action.operation} was not an array`,
              ).toBe(true);
              expect(native, `fixture ${action.operation} was empty`).not.toHaveLength(0);

              const invoked = await mcp.client.callTool({
                name: "netbox_invoke",
                arguments: {
                  operation: action.operation,
                  target: action.target,
                  input: {},
                },
              });
              const result = (
                invoked as {
                  structuredContent?: { result?: Record<string, unknown> };
                }
              ).structuredContent?.result;
              // The E2E assertion deliberately compares NetBox's native JSON: no local trace walk.
              expect(result).toEqual({
                kind: action.resultKind,
                [action.resultKey]: native,
              });
            }

            const allocation = await mcp.client.callTool({
              name: "netbox_invoke",
              arguments: {
                operation: "ipam.prefix.allocate_ip",
                target: prefix.id,
                input: { data: [{}] },
              },
            });
            const allocationStructured = allocation as {
              content?: Array<{ text?: string }>;
              structuredContent?: { result?: unknown };
            };
            const allocatedItems = allocationStructured.structuredContent?.result;
            const allocationText = (allocationStructured.content ?? [])
              .map(({ text }) => text ?? "")
              .join("\n");
            expect(Array.isArray(allocatedItems), allocationText).toBe(true);
            if (!Array.isArray(allocatedItems) || allocatedItems.length !== 1) {
              throw new Error("MCP allocation did not return exactly one IP address.");
            }
            const allocated = allocatedItems[0] as { id?: unknown; address?: unknown };
            const { id, address } = allocated;
            expect(Number.isInteger(id)).toBe(true);
            expect(typeof address).toBe("string");
            expect(allocated).toMatchObject({ role: null });
            if (
              typeof id !== "number" ||
              !Number.isInteger(id) ||
              typeof address !== "string"
            ) {
              throw new Error(
                "MCP allocation returned an IP address without an id and address.",
              );
            }

            const [nativeAfterResponse, persistedResponse] = await Promise.all([
              fetch(new URL(`/api/ipam/prefixes/${prefix.id}/available-ips/`, url), {
                headers,
              }),
              fetch(new URL(`/api/ipam/ip-addresses/${id}/`, url), { headers }),
            ]);
            expect(nativeAfterResponse.status).toBe(200);
            expect(persistedResponse.status).toBe(200);
            const nativeAfter = await nativeAfterResponse.json();
            expect(Array.isArray(nativeAfter)).toBe(true);
            if (!Array.isArray(nativeAfter))
              throw new Error("Native availability response was not an array.");
            expect(nativeAfter).toHaveLength(nativeBefore.length - 1);
            expect(nativeAfter).not.toContainEqual(expect.objectContaining({ address }));

            const persisted = await persistedResponse.json();
            expect(persisted).toEqual(allocated);

            const bulkBase = `mcp-bulk-${prefix.id}-${Date.now()}`;
            const bulkItems = [1, 2].map((number) => ({
              name: `${bulkBase}-${number}`,
              slug: `${bulkBase}-${number}`,
            }));
            const bulkCreated = await mcp.client.callTool({
              name: "netbox_write",
              arguments: {
                object_type: "dcim.site",
                operation: "bulk_create",
                items: bulkItems,
              },
            });
            const createdSites = (
              bulkCreated as { structuredContent?: { result?: unknown } }
            ).structuredContent?.result;
            expect(Array.isArray(createdSites)).toBe(true);
            if (!Array.isArray(createdSites) || createdSites.length !== bulkItems.length)
              throw new Error("Native bulk POST did not return both isolated sites.");
            const siteIds = createdSites.map((site) => (site as { id?: unknown }).id);
            expect(siteIds.every((id) => Number.isInteger(id))).toBe(true);
            if (!siteIds.every((id): id is number => typeof id === "number"))
              throw new Error("Native bulk POST returned a site without an id.");

            const changedDescription = `updated by ${bulkBase}`;
            const bulkPatchArgs = {
              object_type: "dcim.site",
              operation: "bulk_update",
              items: siteIds.map((id) => ({ id, description: changedDescription })),
            };
            const patchPreflight = await mcp.client.callTool({
              name: "netbox_write",
              arguments: bulkPatchArgs,
            });
            const patchText = (
              patchPreflight as { content?: Array<{ text?: string }> }
            ).content
              ?.map(({ text }) => text ?? "")
              .join("\n");
            const patchConfirm = /confirm="([^"]+)"/.exec(patchText ?? "")?.[1];
            expect(patchConfirm).toBeDefined();

            const patched = await mcp.client.callTool({
              name: "netbox_write",
              arguments: { ...bulkPatchArgs, confirm: patchConfirm },
            });
            expect((patched as { isError?: boolean }).isError).not.toBe(true);
            const reusedPatchToken = await mcp.client.callTool({
              name: "netbox_write",
              arguments: { ...bulkPatchArgs, confirm: patchConfirm },
            });
            expect((reusedPatchToken as { isError?: boolean }).isError).toBe(true);
            const persistedSites = await Promise.all(
              siteIds.map(async (id) => {
                const response = await fetch(new URL(`/api/dcim/sites/${id}/`, url), {
                  headers,
                });
                expect(response.status).toBe(200);
                return response.json();
              }),
            );
            expect(persistedSites).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  id: siteIds[0],
                  description: changedDescription,
                }),
                expect.objectContaining({
                  id: siteIds[1],
                  description: changedDescription,
                }),
              ]),
            );

            const bulkDeleteArgs = {
              object_type: "dcim.site",
              operation: "bulk_delete",
              // NetBox's native DELETE request schema reuses SiteRequest, so
              // provide its required name/slug alongside the target id.
              items: siteIds.map((id, index) => ({ id, ...bulkItems[index] })),
            };
            const deletePreflight = await mcp.client.callTool({
              name: "netbox_write",
              arguments: bulkDeleteArgs,
            });
            const deleteText = (
              deletePreflight as { content?: Array<{ text?: string }> }
            ).content
              ?.map(({ text }) => text ?? "")
              .join("\n");
            const deleteConfirm = /confirm="([^"]+)"/.exec(deleteText ?? "")?.[1];
            expect(deleteConfirm, deleteText).toBeDefined();
            const deleted = await mcp.client.callTool({
              name: "netbox_write",
              arguments: { ...bulkDeleteArgs, confirm: deleteConfirm },
            });
            expect((deleted as { isError?: boolean }).isError).not.toBe(true);
            const deletedResponses = await Promise.all(
              siteIds.map((id) =>
                fetch(new URL(`/api/dcim/sites/${id}/`, url), { headers }),
              ),
            );
            expect(deletedResponses.map((response) => response.status)).toEqual([
              404, 404,
            ]);
            // The fixture tears down its isolated container and volumes even if this test fails.
          } finally {
            await mcp.close();
          }
        },
      );
    }, 360_000);
  },
);
