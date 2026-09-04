/**
 * The seam the tool layer sees. These tests exist to keep two promises: the
 * provider is lazy, and it never hands the OpenAPI document to a caller.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { NetBoxConfig } from "../../src/config.js";
import { createCredentialProvider } from "../../src/credentials.js";
import type { HttpGet } from "../../src/schema/loader.js";
import type { OpenApiDocument } from "../../src/schema/openapi.js";
import {
  createSchemaProvider,
  createSchemaProviderFromDocument,
} from "../../src/schema/provider.js";
import {
  UnknownObjectTypeError,
  UnsupportedOperationError,
  type SchemaProvider,
} from "../../src/schema/types.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/netbox-schema-subset.json", import.meta.url),
);
const fixtureText = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(fixtureText) as OpenApiDocument;
const provider: SchemaProvider = createSchemaProviderFromDocument(fixture);

const config: NetBoxConfig = {
  baseUrl: "https://netbox.example.com",
  apiUrl: "https://netbox.example.com/api",
  credentials: createCredentialProvider({ inlineToken: "s3cr3t-token" }),
  insecure: false,
};

describe("listObjectTypes", () => {
  it("returns compact summaries, sorted, with no schema internals attached", async () => {
    const types = await provider.listObjectTypes();
    expect(types.map((type) => type.object_type)).toEqual([
      "dcim.device",
      "dcim.frontport",
      "dcim.interface",
      "dcim.rearport",
      "dcim.site",
      "ipam.ipaddress",
      "ipam.prefix",
      "users.permission",
    ]);
    for (const type of types) {
      expect(Object.keys(type).sort()).toEqual([
        "app",
        "endpoint",
        "label",
        "object_type",
        "operations",
        "summary",
      ]);
    }
    // The whole registry must stay cheap enough to send once per session.
    expect(JSON.stringify(types).length).toBeLessThan(2000);
  });

  it("filters by app and by free text", async () => {
    expect(
      (await provider.listObjectTypes({ app: "ipam" })).map((t) => t.object_type),
    ).toEqual(["ipam.ipaddress", "ipam.prefix"]);
    expect(
      (await provider.listObjectTypes({ query: "IP address" })).map((t) => t.object_type),
    ).toEqual(["ipam.ipaddress"]);
    expect(await provider.listObjectTypes({ app: "nope" })).toEqual([]);
  });

  it("resolves a known key and returns undefined for an unknown one", async () => {
    expect((await provider.resolve("dcim.site"))?.endpoint).toBe("dcim/sites");
    expect(await provider.resolve("dcim.sites")).toBeUndefined();
  });

  it("reports the version the document describes", async () => {
    expect(await provider.version()).toBe("4.6.7");
  });
});

describe("describe", () => {
  it("throws UnknownObjectTypeError with suggestions", async () => {
    await expect(provider.describe("dcim.sites", "create")).rejects.toBeInstanceOf(
      UnknownObjectTypeError,
    );
    const error = await provider.describe("dcim.sites", "create").then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(UnknownObjectTypeError);
    expect((error as UnknownObjectTypeError).suggestions).toContain("dcim.site");
  });

  it("throws UnsupportedOperationError rather than inventing an operation", async () => {
    const readOnly = createSchemaProviderFromDocument({
      paths: {
        "/api/extras/scripts/": { get: {}, post: {} },
        "/api/extras/scripts/{id}/": { get: {} },
      },
    });
    await expect(readOnly.describe("extras.script", "create")).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(readOnly.describe("extras.script", "list")).resolves.toBeDefined();
  });

  it("never returns anything resembling the raw document", async () => {
    const result = await provider.describe("dcim.device", "create");
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("$ref");
    expect(serialised).not.toContain("components");
    expect(serialised).not.toContain("openapi");
    expect(serialised.length).toBeLessThan(fixtureText.length / 10);
  });
});

describe("laziness", () => {
  it("does not fetch anything until a method is called", async () => {
    const calls: string[] = [];
    const httpGet: HttpGet = (url) => {
      calls.push(url);
      if (url.includes("/status/")) {
        return Promise.resolve({
          status: 200,
          statusText: "OK",
          body: JSON.stringify({ "netbox-version": "4.6.7" }),
        });
      }
      return Promise.resolve({ status: 200, statusText: "OK", body: fixtureText });
    };

    const lazy = createSchemaProvider({
      config,
      httpGet,
      cacheDir: null,
      warn: () => {},
    });
    expect(calls).toHaveLength(0);

    const types = await lazy.listObjectTypes();
    expect(types).toHaveLength(8);
    expect(calls.filter((url) => url.includes("/schema/"))).toHaveLength(1);

    // A second question costs nothing.
    await lazy.describe("dcim.site", "create");
    await lazy.version();
    expect(calls.filter((url) => url.includes("/schema/"))).toHaveLength(1);
  });

  it("prefers the version /api/status/ reports over the document's own", async () => {
    const httpGet: HttpGet = (url) =>
      Promise.resolve(
        url.includes("/status/")
          ? {
              status: 200,
              statusText: "OK",
              body: JSON.stringify({ "netbox-version": "4.7.1" }),
            }
          : { status: 200, statusText: "OK", body: fixtureText },
      );
    const live = createSchemaProvider({
      config,
      httpGet,
      cacheDir: null,
      warn: () => {},
    });
    expect(await live.version()).toBe("4.7.1");
  });
});
