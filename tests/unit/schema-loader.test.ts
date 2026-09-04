/**
 * Loader behaviour: laziness, content-type indifference, the two cache keys,
 * and honest failure. No test here opens a socket.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NetBoxConfig } from "../../src/config.js";
import { createCredentialProvider } from "../../src/credentials.js";
import {
  createHttpGet,
  createSchemaLoader,
  defaultCacheDir,
  SchemaUnavailableError,
  type HttpGet,
  type HttpResponse,
} from "../../src/schema/loader.js";

const config: NetBoxConfig = {
  baseUrl: "https://netbox.example.com",
  apiUrl: "https://netbox.example.com/api",
  credentials: createCredentialProvider({ inlineToken: "s3cr3t-token" }),
  insecure: false,
};

const document = {
  openapi: "3.0.3",
  info: { title: "NetBox REST API", version: "4.6.7" },
  paths: { "/api/dcim/sites/": { get: {} } },
  components: { schemas: {} },
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

function makeHttpGet(responses: Record<string, HttpResponse | (() => HttpResponse)>): {
  httpGet: HttpGet;
  calls: Call[];
} {
  const calls: Call[] = [];
  const httpGet: HttpGet = (url, headers) => {
    calls.push({ url, headers });
    for (const [fragment, response] of Object.entries(responses)) {
      if (url.includes(fragment)) {
        return Promise.resolve(typeof response === "function" ? response() : response);
      }
    }
    return Promise.reject(new Error(`unexpected request to ${url}`));
  };
  return { httpGet, calls };
}

function ok(body: unknown): HttpResponse {
  return { status: 200, statusText: "OK", body: JSON.stringify(body) };
}

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "netbox-mcp-cache-"));
});

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe("transport redirects", () => {
  it.each([false, true])(
    "rejects a cross-origin redirect without forwarding Authorization (insecure=%s)",
    async (insecure) => {
      let redirectedAuthorization: string | undefined;
      const destination = http.createServer((request, response) => {
        redirectedAuthorization = request.headers.authorization;
        response.writeHead(200).end("unexpected");
      });
      await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
      const destinationAddress = destination.address();
      if (!destinationAddress || typeof destinationAddress === "string") {
        throw new Error("test server did not expose a TCP address");
      }

      const source = http.createServer((_request, response) => {
        response
          .writeHead(302, {
            Location: `http://127.0.0.1:${destinationAddress.port}/schema`,
          })
          .end();
      });
      await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
      const sourceAddress = source.address();
      if (!sourceAddress || typeof sourceAddress === "string") {
        throw new Error("test server did not expose a TCP address");
      }

      try {
        const httpGet = createHttpGet({ ...config, insecure });
        await expect(
          httpGet(
            `http://127.0.0.1:${sourceAddress.port}/schema`,
            { Authorization: "Token redirect-test-secret" },
            1_000,
          ),
        ).rejects.toThrow(/cross-origin redirect/i);
        expect(redirectedAuthorization).toBeUndefined();
      } finally {
        await Promise.all([
          new Promise<void>((resolve, reject) =>
            source.close((error) => (error ? reject(error) : resolve())),
          ),
          new Promise<void>((resolve, reject) =>
            destination.close((error) => (error ? reject(error) : resolve())),
          ),
        ]);
      }
    },
  );
});

describe("fetching", () => {
  it.each([
    ["legacy token", "s3cr3t-token", "Token"],
    ["complete v2 token", "nbt_example01.example-secret", "Bearer"],
    ["incomplete v2 lookalike", "nbt_example01", "Token"],
  ])(
    "requests schema with %s authentication and the vendor Accept type",
    async (_name, token, scheme) => {
      const { httpGet, calls } = makeHttpGet({
        "/status/": ok({ "netbox-version": "4.6.7" }),
        "/schema/": ok(document),
      });
      const loaded = await createSchemaLoader({
        config: { ...config, credentials: { getToken: () => Promise.resolve(token) } },
        httpGet,
        cacheDir,
        warn: () => {},
      }).load();

      const schemaCall = calls.find((call) => call.url.includes("/schema/"));
      expect(schemaCall?.url).toBe("https://netbox.example.com/api/schema/?format=json");
      expect(schemaCall?.headers["Authorization"]).toBe(`${scheme} ${token}`);
      expect(schemaCall?.headers["Accept"]).toContain("application/vnd.oai.openapi+json");
      expect(loaded.version).toBe("4.6.7");
      expect(loaded.source).toBe("network");
    },
  );

  /**
   * A live 4.6.0 transferred the schema UNCOMPRESSED: 12,431,579 bytes in
   * 7,451 ms, `Content-Encoding` absent, on a request that did ask for gzip.
   * The instance's front end is not compressing the vendor content type, which
   * this end cannot fix — but dropping the request header would turn a
   * server-side misconfiguration into a permanent one, so it is pinned here.
   */
  it("gets credentials from the provider for both status and schema requests", async () => {
    let tokenNumber = 0;
    const rotatingConfig: NetBoxConfig = {
      ...config,
      credentials: {
        getToken: () => Promise.resolve(`rotated-token-${++tokenNumber}`),
      },
    };
    const { httpGet, calls } = makeHttpGet({
      "/status/": ok({ "netbox-version": "4.6.7" }),
      "/schema/": ok(document),
    });

    await createSchemaLoader({
      config: rotatingConfig,
      httpGet,
      cacheDir,
      warn: () => {},
    }).load();

    expect(
      calls.find((call) => call.url.includes("/status/"))?.headers["Authorization"],
    ).toBe("Token rotated-token-1");
    expect(
      calls.find((call) => call.url.includes("/schema/"))?.headers["Authorization"],
    ).toBe("Token rotated-token-2");
  });

  it("asks for a compressed schema: 12 MB is not a reasonable first tool call", async () => {
    const { httpGet, calls } = makeHttpGet({
      "/status/": ok({ "netbox-version": "4.6.7" }),
      "/schema/": ok(document),
    });
    await createSchemaLoader({ config, httpGet, cacheDir, warn: () => {} }).load();

    const schemaCall = calls.find((call) => call.url.includes("/schema/"));
    expect(schemaCall?.headers["Accept-Encoding"]).toContain("gzip");
  });

  it("parses the body whatever the content type claims", async () => {
    // drf-spectacular serves `application/vnd.oai.openapi+json`; a client that
    // gates on `application/json` gets binary garbage instead of a document.
    const { httpGet } = makeHttpGet({
      "/status/": {
        status: 200,
        statusText: "OK",
        body: JSON.stringify({ "netbox-version": "4.6.7" }),
      },
      "/schema/": { status: 200, statusText: "OK", body: JSON.stringify(document) },
    });
    const loaded = await createSchemaLoader({
      config,
      httpGet,
      cacheDir,
      warn: () => {},
    }).load();
    expect(Object.keys(loaded.document.paths ?? {})).toEqual(["/api/dcim/sites/"]);
  });

  it("is lazy and memoised: nothing is fetched until load(), then never again", async () => {
    const { httpGet, calls } = makeHttpGet({
      "/status/": ok({ "netbox-version": "4.6.7" }),
      "/schema/": ok(document),
    });
    const loader = createSchemaLoader({ config, httpGet, cacheDir, warn: () => {} });
    expect(calls).toHaveLength(0);
    await Promise.all([loader.load(), loader.load()]);
    await loader.load();
    expect(calls.filter((call) => call.url.includes("/schema/"))).toHaveLength(1);
  });
});

describe("cache key", () => {
  // What this buys, measured on a live 4.6.0: 12.43 MB and 7,451 ms, paid on
  // the first tool call of the first process per NetBox+plugin version, and
  // never again until one of those versions changes. The test below is the
  // guarantee that "never again" holds.
  it("keys on the NetBox version and skips the fetch on the next process", async () => {
    const first = makeHttpGet({
      "/status/": ok({
        "netbox-version": "4.6.7",
        plugins: { netbox_inventory: "2.3.0" },
      }),
      "/schema/": ok(document),
    });
    await createSchemaLoader({
      config,
      httpGet: first.httpGet,
      cacheDir,
      warn: () => {},
    }).load();
    expect(await readdir(cacheDir)).toHaveLength(1);

    const second = makeHttpGet({
      "/status/": ok({
        "netbox-version": "4.6.7",
        plugins: { netbox_inventory: "2.3.0" },
      }),
      "/schema/": () => {
        throw new Error("the schema must not be refetched when the cache key matches");
      },
    });
    const loaded = await createSchemaLoader({
      config,
      httpGet: second.httpGet,
      cacheDir,
      warn: () => {},
    }).load();
    expect(loaded.source).toBe("disk");
    expect(loaded.version).toBe("4.6.7");
    expect(second.calls.some((call) => call.url.includes("/schema/"))).toBe(false);
  });

  it("re-fetches when a plugin's version changes but NetBox's does not", async () => {
    const before = makeHttpGet({
      "/status/": ok({
        "netbox-version": "4.6.7",
        plugins: { netbox_inventory: "2.3.0" },
      }),
      "/schema/": ok(document),
    });
    await createSchemaLoader({
      config,
      httpGet: before.httpGet,
      cacheDir,
      warn: () => {},
    }).load();

    const after = makeHttpGet({
      "/status/": ok({
        "netbox-version": "4.6.7",
        plugins: { netbox_inventory: "2.4.0" },
      }),
      "/schema/": ok(document),
    });
    const loaded = await createSchemaLoader({
      config,
      httpGet: after.httpGet,
      cacheDir,
      warn: () => {},
    }).load();
    expect(loaded.source).toBe("network");
    expect(await readdir(cacheDir)).toHaveLength(2);
  });

  it("falls back to hashing the document when netbox-version is null", async () => {
    // netbox-docker #1582: the v4.5.0-beta1 image returns null here.
    const { httpGet } = makeHttpGet({
      "/status/": ok({ "netbox-version": null, "python-version": null }),
      "/schema/": ok(document),
    });
    const loaded = await createSchemaLoader({
      config,
      httpGet,
      cacheDir,
      warn: () => {},
    }).load();
    expect(loaded.cacheKey).toMatch(/^[0-9a-f]{16}$/);
    // The version still has to come from somewhere: the document itself.
    expect(loaded.version).toBe("4.6.7");

    const second = makeHttpGet({
      "/status/": ok({ "netbox-version": null }),
      "/schema/": ok(document),
    });
    const again = await createSchemaLoader({
      config,
      httpGet: second.httpGet,
      cacheDir,
      warn: () => {},
    }).load();
    expect(again.source).toBe("disk");
    expect(again.cacheKey).toBe(loaded.cacheKey);
  });

  it("survives an unreachable /api/status/ and an unwritable cache directory", async () => {
    const { httpGet } = makeHttpGet({ "/schema/": ok(document) });
    const loaded = await createSchemaLoader({
      config,
      httpGet,
      cacheDir: null,
      warn: () => {},
    }).load();
    expect(loaded.version).toBe("4.6.7");
    expect(loaded.source).toBe("network");
  });

  it("honours XDG_CACHE_HOME, then falls back to ~/.cache", () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/tmp/xdg" })).toContain("netbox-mcp");
    expect(defaultCacheDir({}, "linux")).toMatch(/[\\/]\.cache[\\/]netbox-mcp$/);
  });

  it("uses each platform's own cache location", () => {
    // A multi-megabyte schema document in ~/.cache on Windows or macOS works,
    // and is somewhere neither platform ever looks — so it never gets cleaned
    // up. XDG_CACHE_HOME still wins everywhere when explicitly set.
    expect(
      defaultCacheDir({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "win32"),
    ).toContain("netbox-mcp");
    expect(defaultCacheDir({}, "darwin")).toMatch(/Library[\\/]Caches[\\/]netbox-mcp$/);
    expect(defaultCacheDir({}, "linux")).toMatch(/\.cache[\\/]netbox-mcp$/);
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/explicit" }, "win32")).toMatch(
      /explicit[\\/]netbox-mcp$/,
    );
    // Windows with no LOCALAPPDATA must still return something usable.
    expect(defaultCacheDir({}, "win32")).toContain("netbox-mcp");
  });
});

describe("failure is honest", () => {
  it("names the cause on an auth failure and offers no substitute schema", async () => {
    const { httpGet } = makeHttpGet({
      "/status/": { status: 403, statusText: "Forbidden", body: "{}" },
      "/schema/": { status: 403, statusText: "Forbidden", body: "{}" },
    });
    const loader = createSchemaLoader({ config, httpGet, cacheDir, warn: () => {} });
    await expect(loader.load()).rejects.toBeInstanceOf(SchemaUnavailableError);
    await expect(loader.load()).rejects.toThrow(/HTTP 403/);
    await expect(loader.load()).rejects.toThrow(/NETBOX_TOKEN/);
    await expect(loader.load()).rejects.toThrow(/no substitute schema is used/);
  });

  it("never leaks the token into the error", async () => {
    const { httpGet } = makeHttpGet({
      "/status/": { status: 401, statusText: "Unauthorized", body: "{}" },
      "/schema/": { status: 401, statusText: "Unauthorized", body: "{}" },
    });
    const loader = createSchemaLoader({ config, httpGet, cacheDir, warn: () => {} });
    const error = await loader.load().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(SchemaUnavailableError);
    expect(String(error)).not.toContain("s3cr3t-token");
  });

  it("reports a non-JSON body without pretending it parsed", async () => {
    const { httpGet } = makeHttpGet({
      "/status/": ok({ "netbox-version": "4.6.7" }),
      "/schema/": {
        status: 200,
        statusText: "OK",
        body: "<html><head><title>502 Bad Gateway</title></head></html>",
      },
    });
    await expect(
      createSchemaLoader({ config, httpGet, cacheDir, warn: () => {} }).load(),
    ).rejects.toThrow(/was not JSON/);
  });

  it("redacts a token-file value from a non-JSON schema response", async () => {
    const token = "file-token-that-must-not-leak";
    const tokenFileConfig: NetBoxConfig = {
      ...config,
      credentials: createCredentialProvider({
        tokenFile: "/run/secrets/netbox-token",
        fileSystem: {
          stat: () => Promise.resolve({ isFile: () => true }),
          readFile: () => Promise.resolve(token),
        },
      }),
    };
    const { httpGet } = makeHttpGet({
      "/status/": ok({ "netbox-version": "4.6.7" }),
      "/schema/": {
        status: 200,
        statusText: "OK",
        body:
          `gateway rejected Authorization: Bearer ${token}; ` +
          `it also reflected ${token} without a prefix`,
      },
    });

    const error = await createSchemaLoader({
      config: tokenFileConfig,
      httpGet,
      cacheDir,
      warn: () => {},
    })
      .load()
      .then(
        () => undefined,
        (reason: unknown) => String(reason),
      );

    expect(error).not.toContain(token);
    expect(error).toContain("[redacted]");
  });

  it("rejects JSON that is not an OpenAPI document, without quoting it", async () => {
    const { httpGet } = makeHttpGet({
      "/status/": ok({ "netbox-version": "4.6.7" }),
      "/schema/": ok({ detail: "You do not have permission to perform this action." }),
    });
    const loader = createSchemaLoader({ config, httpGet, cacheDir, warn: () => {} });
    await expect(loader.load()).rejects.toThrow(/no OpenAPI `paths` object/);
    const error = await loader.load().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(String(error)).not.toContain("You do not have permission");
  });

  it("does not memoise a failure, so a fixed token works without a restart", async () => {
    let broken = true;
    const { httpGet } = makeHttpGet({
      "/status/": ok({ "netbox-version": "4.6.7" }),
      "/schema/": () =>
        broken ? { status: 403, statusText: "Forbidden", body: "{}" } : ok(document),
    });
    const loader = createSchemaLoader({ config, httpGet, cacheDir, warn: () => {} });
    await expect(loader.load()).rejects.toBeInstanceOf(SchemaUnavailableError);
    broken = false;
    await expect(loader.load()).resolves.toMatchObject({ version: "4.6.7" });
  });

  it("reports a network-level failure with a diagnosable reason", async () => {
    const httpGet: HttpGet = (url) => {
      if (url.includes("/status/"))
        return Promise.resolve(ok({ "netbox-version": "4.6.7" }));
      const error = new Error("getaddrinfo ENOTFOUND netbox.example.com");
      (error as NodeJS.ErrnoException).code = "ENOTFOUND";
      return Promise.reject(error);
    };
    await expect(
      createSchemaLoader({ config, httpGet, cacheDir, warn: () => {} }).load(),
    ).rejects.toThrow(/ENOTFOUND/);
  });
});
