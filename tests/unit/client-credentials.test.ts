import axios from "axios";
import { createServer, type RequestListener, type Server } from "node:http";
import { Agent } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { NetBoxClient } from "../../src/client.js";
import type { NetBoxConfig } from "../../src/config.js";

function listen(handler: RequestListener): Promise<Server> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function serverUrl(server: Server, hostname: string): string {
  const address = server.address() as AddressInfo;
  return `http://${hostname}:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("NetBoxClient credentials", () => {
  it("gets a fresh token from its provider for every API request", async () => {
    let tokenNumber = 0;
    const config: NetBoxConfig = {
      baseUrl: "https://netbox.example.com",
      apiUrl: "https://netbox.example.com/api",
      credentials: {
        getToken: () => Promise.resolve(`rotated-token-${++tokenNumber}`),
      },
      insecure: false,
    };
    const headers: string[] = [];
    const http = axios.create({
      adapter: (request) => {
        headers.push(String(request.headers.get("Authorization")));
        return Promise.resolve({
          data: { count: 0, next: null, previous: null, results: [] },
          status: 200,
          statusText: "OK",
          headers: {},
          config: request,
        });
      },
    });
    const client = new NetBoxClient(config, { http });

    await client.list("dcim/sites");
    await client.list("dcim/sites");

    expect(headers).toEqual(["Token rotated-token-1", "Token rotated-token-2"]);
  });

  it.each([
    ["legacy token", "0123456789abcdef0123456789abcdef01234567", "Token"],
    ["complete v2 token", "nbt_example01.example-secret", "Bearer"],
    ["incomplete v2 lookalike", "nbt_example01", "Token"],
  ])("uses %s authentication for each request", async (_name, token, scheme) => {
    const config: NetBoxConfig = {
      baseUrl: "https://netbox.example.com",
      apiUrl: "https://netbox.example.com/api",
      credentials: { getToken: () => Promise.resolve(token) },
      insecure: false,
    };
    let authorization: string | undefined;
    const http = axios.create({
      adapter: (request) => {
        authorization = String(request.headers.get("Authorization"));
        return Promise.resolve({
          data: { count: 0, next: null, previous: null, results: [] },
          status: 200,
          statusText: "OK",
          headers: {},
          config: request,
        });
      },
    });

    await new NetBoxClient(config, { http }).list("dcim/sites");
    expect(authorization).toBe(`${scheme} ${token}`);
  });

  it("does not forward Authorization to a redirect subdomain", async () => {
    const token = "redirect-token-that-must-not-leak";
    let redirectedAuthorization: string | undefined;
    const target = await listen((request, response) => {
      redirectedAuthorization = request.headers.authorization;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ count: 0, next: null, previous: null, results: [] }));
    });
    const source = await listen((_request, response) => {
      response.writeHead(302, {
        Location: `${serverUrl(target, "redirect.netbox.test")}/api/dcim/sites/`,
      });
      response.end();
    });
    const agent = new Agent({
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address: "127.0.0.1", family: 4 }]);
        } else {
          callback(null, "127.0.0.1", 4);
        }
      },
    });
    const config: NetBoxConfig = {
      baseUrl: serverUrl(source, "netbox.test"),
      apiUrl: `${serverUrl(source, "netbox.test")}/api`,
      credentials: { getToken: () => Promise.resolve(token) },
      insecure: false,
    };

    try {
      await new NetBoxClient(config, { httpAgent: agent }).list("dcim/sites");
      expect(redirectedAuthorization).toBeUndefined();
    } finally {
      agent.destroy();
      await Promise.all([close(source), close(target)]);
    }
  });

  it("preserves Authorization on a same-origin redirect", async () => {
    const token = "same-origin-redirect-token";
    let redirectedAuthorization: string | undefined;
    const source = await listen((request, response) => {
      if (request.url === "/api/dcim/sites/") {
        response.writeHead(302, { Location: "/api/dcim/sites/redirected/" });
        response.end();
        return;
      }
      redirectedAuthorization = request.headers.authorization;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ count: 0, next: null, previous: null, results: [] }));
    });
    const baseUrl = serverUrl(source, "127.0.0.1");
    const config: NetBoxConfig = {
      baseUrl,
      apiUrl: `${baseUrl}/api`,
      credentials: { getToken: () => Promise.resolve(token) },
      insecure: false,
    };

    try {
      await new NetBoxClient(config).list("dcim/sites");
      expect(redirectedAuthorization).toBe(`Token ${token}`);
    } finally {
      await close(source);
    }
  });

  it("redacts the active token when NetBox reflects it in an Axios error body", async () => {
    const token = "active-token-that-must-not-leak";
    const config: NetBoxConfig = {
      baseUrl: "https://netbox.example.com",
      apiUrl: "https://netbox.example.com/api",
      credentials: { getToken: () => Promise.resolve(token) },
      insecure: false,
    };
    const http = axios.create({
      adapter: (request) =>
        Promise.resolve({
          data: {
            detail:
              `The proxy saw Authorization: Bearer ${token}; ` +
              `the bare value is ${token}.`,
          },
          status: 400,
          statusText: "Bad Request",
          headers: {},
          config: request,
        }),
    });

    const error = await new NetBoxClient(config, { http }).list("dcim/sites").then(
      () => undefined,
      (reason: unknown) => String(reason),
    );

    expect(error).not.toContain(token);
    expect(error).toContain("[redacted]");
  });
});
