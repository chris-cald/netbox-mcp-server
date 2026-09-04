/**
 * Layer 1 derivation, against the committed subset of NetBox 4.6.7's own
 * generated schema. Nothing here touches the network.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyCollectionWrite,
  type OpenApiDocument,
} from "../../src/schema/openapi.js";
import {
  buildRegistry,
  classifyPath,
  formatDiagnostics,
  objectTypeKey,
  singularise,
  verboseNameFromDescription,
} from "../../src/schema/registry.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/netbox-schema-subset.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as OpenApiDocument;
const registry = buildRegistry(fixture);

/**
 * The 12 collection paths on stock 4.6.7 that are NOT object types
 * (derivation doc §2.2). Four are in the fixture verbatim; the rest are
 * reproduced here in their documented shape so the rule is tested against all
 * twelve, not just the four that fit in 256 KB.
 */
const NON_OBJECT_TYPE_COLLECTIONS: Record<
  string,
  "get-only" | "get+detail" | "singleton"
> = {
  "/api/core/background-queues/": "get-only",
  "/api/core/background-workers/": "get-only",
  "/api/core/background-tasks/": "get+detail",
  "/api/core/data-files/": "get+detail",
  "/api/core/jobs/": "get+detail",
  "/api/core/object-changes/": "get+detail",
  "/api/core/object-types/": "get+detail",
  "/api/dcim/cable-terminations/": "get+detail",
  "/api/dcim/connected-device/": "get-only",
  "/api/extras/tagged-objects/": "get+detail",
  "/api/users/config/": "get-only",
  "/api/extras/dashboard/": "singleton",
};

function nonObjectTypeDocument(): OpenApiDocument {
  const paths: NonNullable<OpenApiDocument["paths"]> = {};
  for (const [path, shape] of Object.entries(NON_OBJECT_TYPE_COLLECTIONS)) {
    paths[path] = {
      get: { operationId: "x_list", description: "Get a list of thing objects." },
      ...(shape === "singleton"
        ? {
            put: {
              requestBody: {
                content: {
                  "application/json": { schema: { $ref: "#/c/DashboardRequest" } },
                },
              },
            },
            patch: {},
            delete: {},
          }
        : {}),
    };
    if (shape === "get+detail") {
      paths[`${path}{id}/`] = { get: {}, put: {}, patch: {}, delete: {} };
    }
  }
  // A control: an ordinary object type must still be derived from the same doc.
  paths["/api/dcim/sites/"] = {
    get: { description: "Get a list of site objects." },
    post: {
      requestBody: {
        content: {
          "application/json": {
            schema: {
              oneOf: [
                { $ref: "#/components/schemas/WritableSiteRequest" },
                {
                  type: "array",
                  items: { $ref: "#/components/schemas/WritableSiteRequest" },
                },
              ],
            },
          },
        },
      },
    },
  };
  paths["/api/dcim/sites/{id}/"] = {
    get: {},
    put: {
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/WritableSiteRequest" },
          },
        },
      },
    },
    patch: {},
    delete: {},
  };
  return { info: { version: "4.6.7" }, paths, components: { schemas: {} } };
}

describe("path classification", () => {
  it("classifies by segment count after /api, keeping the /api prefix", () => {
    expect(classifyPath("/api/dcim/devices/", {}).kind).toBe("collection");
    expect(classifyPath("/api/dcim/devices/{id}/", {}).kind).toBe("detail");
    expect(classifyPath("/api/ipam/prefixes/{id}/available-ips/", {}).kind).toBe("other");
    expect(classifyPath("/api/status/", {}).kind).toBe("other");
    expect(classifyPath("/api/core/background-queues/{name}/", {}).kind).toBe("other");
  });

  it("treats a plugin path as app plugins/<plugin>", () => {
    const collection = classifyPath("/api/plugins/netbox_inventory/assets/", {});
    expect(collection.kind).toBe("collection");
    expect(collection.app).toBe("plugins/netbox_inventory");
    expect(objectTypeKey(collection.app, collection.slug)).toBe(
      "plugins.netbox_inventory.asset",
    );
    expect(classifyPath("/api/plugins/netbox_inventory/assets/{id}/", {}).kind).toBe(
      "detail",
    );
  });

  it("singularises the slugs a naive -s strip gets wrong", () => {
    expect(singularise("ip-addresses")).toBe("ipaddress");
    expect(singularise("prefixes")).toBe("prefix");
    expect(singularise("vlan-translation-policies")).toBe("vlantranslationpolicy");
    expect(singularise("virtual-chassis")).toBe("virtualchassis");
    expect(singularise("console-server-ports")).toBe("consoleserverport");
    expect(singularise("devices")).toBe("device");
    expect(singularise("rirs")).toBe("rir");
  });

  /**
   * `plugins/inventory/purchases` derived as `plugins.inventory.purchas` on a
   * live 4.6.0: stripping `-es` after any sibilant is right for `addresses`
   * and wrong for `purchases`. The endpoint sweep did not catch it because the
   * endpoint is stored, not reconstructed — but the key is what a model passes
   * to netbox_read, and no user would ever guess the misspelling.
   */
  it("does not eat the -e of a -ses plural whose singular is not sibilant", () => {
    expect(singularise("purchases")).toBe("purchase");
    expect(singularise("licenses")).toBe("license");
    expect(singularise("deliveries")).toBe("delivery");
  });

  it("still strips -es where the singular really is sibilant-final", () => {
    expect(singularise("addresses")).toBe("address");
    expect(singularise("mac-addresses")).toBe("macaddress");
    expect(singularise("boxes")).toBe("box");
    expect(singularise("statuses")).toBe("status");
  });

  it("leaves the slugs the previous rule already got right alone", () => {
    expect(singularise("ip-addresses")).toBe("ipaddress");
    expect(singularise("device-types")).toBe("devicetype");
    expect(singularise("interfaces")).toBe("interface");
    expect(singularise("assets")).toBe("asset");
    expect(singularise("services")).toBe("service");
  });
});

/**
 * The slug is a routing convenience. The component the schema resolves is the
 * serializer's own name for the model, and it is the thing the singularisation
 * heuristic is guessing at — so where the two agree modulo pluralisation, the
 * component wins.
 */
describe("the object-type key prefers a resolved component over the slug", () => {
  function pluginDocument(slug: string, model: string): OpenApiDocument {
    return {
      info: { version: "4.6.0" },
      paths: {
        [`/api/plugins/inventory/${slug}/`]: {
          get: { description: `Get a list of ${model.toLowerCase()} objects.` },
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${model}Request` },
                },
              },
            },
          },
        },
        [`/api/plugins/inventory/${slug}/{id}/`]: {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: `#/components/schemas/${model}` },
                  },
                },
              },
            },
          },
          put: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${model}Request` },
                },
              },
            },
          },
        },
      },
      components: { schemas: {} },
    };
  }

  it("derives plugins.inventory.purchase from the Purchase component", () => {
    const derived = buildRegistry(pluginDocument("purchases", "Purchase"));
    expect([...derived.types.keys()]).toEqual(["plugins.inventory.purchase"]);
    // The endpoint is stored, never reconstructed from the key.
    expect(derived.types.get("plugins.inventory.purchase")?.summary.endpoint).toBe(
      "plugins/inventory/purchases",
    );
  });

  it("keeps working for a plugin whose component and slug already agreed", () => {
    expect([...buildRegistry(pluginDocument("assets", "Asset")).types.keys()]).toEqual([
      "plugins.inventory.asset",
    ]);
    expect([
      ...buildRegistry(pluginDocument("deliveries", "Delivery")).types.keys(),
    ]).toEqual(["plugins.inventory.delivery"]);
  });

  it("ignores a component that is not the URL's noun", () => {
    // `dcim/devices` resolves `DeviceWithConfigContext` and `users/permissions`
    // resolves `ObjectPermission`. Trusting either blindly renames a core type.
    expect([
      ...buildRegistry(pluginDocument("devices", "DeviceWithConfigContext")).types.keys(),
    ]).toEqual(["plugins.inventory.device"]);
    expect([
      ...buildRegistry(pluginDocument("permissions", "ObjectPermission")).types.keys(),
    ]).toEqual(["plugins.inventory.permission"]);
  });

  it("derives every object-type key represented by the fixture", () => {
    expect([...registry.types.keys()].sort()).toEqual([
      "dcim.device",
      "dcim.frontport",
      "dcim.interface",
      "dcim.rearport",
      "dcim.site",
      "ipam.ipaddress",
      "ipam.prefix",
      // Still `permission`, not `objectpermission`: the fixture's own
      // `ObjectPermission` component is not the URL's noun and is not trusted.
      "users.permission",
    ]);
  });
});

describe("the object-type rule", () => {
  it("excludes all twelve non-object-type collections and keeps a real one", () => {
    const derived = buildRegistry(nonObjectTypeDocument());
    expect([...derived.types.keys()]).toEqual(["dcim.site"]);
    for (const path of Object.keys(NON_OBJECT_TYPE_COLLECTIONS)) {
      expect(derived.diagnostics.excludedCollections).toContain(path);
    }
    expect(derived.diagnostics.excludedCollections).toHaveLength(12);
  });

  it("does not admit a collection merely because it has a get", () => {
    // Every stock collection has a `get`; the guard that actually discards
    // anything is `post` + a matching /{id}/ detail path.
    const withGetOnly = buildRegistry({
      paths: { "/api/core/jobs/": { get: {} }, "/api/core/jobs/{id}/": { get: {} } },
    });
    expect(withGetOnly.types.size).toBe(0);
  });

  it("derives the fixture's eight object types and excludes its four traps", () => {
    expect([...registry.types.keys()].sort()).toEqual([
      "dcim.device",
      "dcim.frontport",
      "dcim.interface",
      "dcim.rearport",
      "dcim.site",
      "ipam.ipaddress",
      "ipam.prefix",
      "users.permission",
    ]);
    expect(registry.diagnostics.excludedCollections).toEqual(
      expect.arrayContaining([
        "/api/dcim/connected-device/",
        "/api/extras/dashboard/",
        "/api/core/background-queues/",
        "/api/extras/scripts/",
      ]),
    );
  });

  it("labels a type from the operation-description template, not the slug", () => {
    expect(verboseNameFromDescription("Get a list of IP address objects.")).toBe(
      "IP address",
    );
    expect(registry.types.get("ipam.ipaddress")?.summary.label).toBe("IP address");
    expect(registry.types.get("dcim.device")?.summary.label).toBe("Device");
    expect(registry.types.get("dcim.device")?.summary.summary).toContain("dcim/devices");
    expect(registry.types.get("dcim.device")?.summary.endpoint).toBe("dcim/devices");
    expect(registry.types.get("dcim.device")?.summary.app).toBe("dcim");
  });
});

describe("bulk versus singleton operations", () => {
  it("reads the request body shape, not the HTTP method", () => {
    const sites = fixture.paths?.["/api/dcim/sites/"];
    const dashboard = fixture.paths?.["/api/extras/dashboard/"];
    // Same method, same 3-segment collection path, opposite semantics.
    expect(classifyCollectionWrite(sites?.put)).toBe("bulk");
    expect(classifyCollectionWrite(sites?.delete)).toBe("bulk");
    expect(classifyCollectionWrite(dashboard?.put)).toBe("singleton");
    expect(classifyCollectionWrite(dashboard?.patch)).toBe("singleton");
    // The collection POST is `oneOf: [single, array]`, so it does document a
    // single-object create.
    expect(classifyCollectionWrite(sites?.post)).toBe("singleton");
  });

  it("never turns a collection's bulk PUT/DELETE into a single-object verb", () => {
    const collectionOnly = buildRegistry({
      paths: {
        "/api/dcim/sites/": {
          get: {},
          post: {
            requestBody: {
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/W" } },
              },
            },
          },
          put: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/x/W" } },
                },
              },
            },
          },
          delete: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/x/W" } },
                },
              },
            },
          },
        },
        // A detail path with only a GET: no single-object update or delete.
        "/api/dcim/sites/{id}/": { get: {} },
      },
    });
    expect(collectionOnly.types.get("dcim.site")?.summary.operations).toEqual([
      "list",
      "get",
      "create",
    ]);
  });

  it("gives the fixture's real types the full single-object verb set", () => {
    expect(registry.types.get("dcim.site")?.summary.operations).toEqual([
      "list",
      "get",
      "create",
      "update",
      "delete",
    ]);
  });

  it("keeps the singleton dashboard out of the registry entirely", () => {
    expect(registry.types.has("extras.dashboard")).toBe(false);
  });
});

describe("diagnostics", () => {
  it("reports a self-audit that would surface a silent derivation failure", () => {
    const text = formatDiagnostics(registry.diagnostics);
    expect(text).toContain("NetBox 4.6.7");
    expect(text).toContain("8 object types");
    expect(registry.diagnostics.writeSchemasResolvedByName).toBe(0);
    expect(registry.diagnostics.typesWithoutWriteSchema).toEqual([]);
    expect(registry.diagnostics.typesWithoutPatchSchema).toEqual([]);
    expect(registry.diagnostics.typesWithoutReadSchema).toEqual([]);
    expect(registry.diagnostics.otherPaths).toEqual(
      expect.arrayContaining(["/api/status/", "/api/schema/"]),
    );
  });

  it("counts a type whose POST has no application/json body as create-undescribable", () => {
    // `/api/extras/scripts/` is exactly this on stock 4.6.7 (1 of 126).
    const derived = buildRegistry({
      paths: {
        "/api/extras/scripts/": {
          get: {},
          post: { operationId: "extras_scripts_create" },
        },
        "/api/extras/scripts/{id}/": { get: {} },
      },
    });
    const entry = derived.types.get("extras.script");
    expect(entry).toBeDefined();
    expect(entry?.writeSchemaName).toBeUndefined();
    expect(derived.diagnostics.typesWithoutWriteSchema).toEqual(["extras.script"]);
    // No write body means no single-object create to advertise.
    expect(entry?.summary.operations).toEqual(["list", "get"]);
  });
});
