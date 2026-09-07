import { createServer as createHttpServer, request as httpRequest } from "node:http";

import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";

import {
  createStreamableHttpServer,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  MAX_SESSIONS_PER_PRINCIPAL,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  loadTransportConfig,
  type TransportConfig,
} from "../../src/http.js";
import { buildServer } from "../../src/server.js";

const MCP_POST_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "http-transport-test", version: "0.0.0" },
  },
};

async function postWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: { ...MCP_POST_HEADERS, host },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(INITIALIZE_REQUEST));
  });
}

async function startHttpServer(
  createMcpServer = () => buildServer(),
  config: Extract<TransportConfig, { transport: "http" }> = {
    transport: "http",
    host: "127.0.0.1",
    port: 0,
  },
) {
  const server = createStreamableHttpServer(config, createMcpServer);
  await server.listen();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP listener");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function signedToken(
  privateKey: CryptoKey,
  subject: string,
  scope = "mcp",
  expiration: string | number | null = "5m",
): Promise<string> {
  const jwt = new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://issuer.example.test")
    .setAudience("netbox-mcp")
    .setSubject(subject)
    .setIssuedAt();
  if (expiration !== null) jwt.setExpirationTime(expiration);
  return jwt.sign(privateKey);
}

describe("HTTP transport configuration", () => {
  it("keeps stdio as the default", () => {
    expect(loadTransportConfig({})).toEqual({ transport: "stdio" });
  });

  it("uses the conventional container port and wildcard listener", () => {
    expect(loadTransportConfig({ NETBOX_TRANSPORT: "http" })).toEqual({
      transport: "http",
      host: "0.0.0.0",
      port: 3000,
    });
  });

  it("lets the container runtime control network exposure", () => {
    expect(() => loadTransportConfig({ NETBOX_TRANSPORT: "sse" })).toThrow(
      /NETBOX_TRANSPORT/,
    );
    expect(
      loadTransportConfig({
        NETBOX_TRANSPORT: "http",
        NETBOX_HTTP_HOST: "192.0.2.1",
        NETBOX_HTTP_PORT: "65536",
      }),
    ).toEqual({ transport: "http", host: "0.0.0.0", port: 3000 });
    expect(() =>
      createStreamableHttpServer({ transport: "http", host: "0.0.0.0", port: 0 }),
    ).not.toThrow();
  });

  it("sets conservative Node request timeouts", () => {
    expect(HTTP_HEADERS_TIMEOUT_MS).toBe(10_000);
    expect(HTTP_REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});

describe("Streamable HTTP transport", () => {
  it("serves health/readiness separately from the MCP endpoint", async () => {
    const { server, baseUrl } = await startHttpServer();
    try {
      await expect(fetch(`${baseUrl}/healthz`)).resolves.toMatchObject({ status: 200 });
      await expect(fetch(`${baseUrl}/readyz`)).resolves.toMatchObject({ status: 200 });
      await expect(fetch(`${baseUrl}/not-a-rest-api`)).resolves.toMatchObject({
        status: 404,
      });
    } finally {
      await server.close();
    }
  });

  it("bounds malformed MCP request bodies", async () => {
    const { server, baseUrl } = await startHttpServer();
    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: MCP_POST_HEADERS,
        body: JSON.stringify("x".repeat(1024 * 1024)),
      });
      expect(response.status).toBe(413);
    } finally {
      await server.close();
    }
  });

  it("performs a real Streamable HTTP MCP handshake and cleans up its session", async () => {
    const { server, baseUrl } = await startHttpServer();
    const client = new Client({ name: "http-test", version: "0.0.0" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: "Bearer gateway-caller-token" } },
      });
      await client.connect(transport as never);
      expect((await client.listTools()).tools).toHaveLength(6);
      expect(server.sessionCount()).toBe(1);

      await transport.terminateSession();
      expect(server.sessionCount()).toBe(0);

      await server.close();
      expect(server.isReady()).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects unsupported methods with the Streamable HTTP error envelope", async () => {
    const { server, baseUrl } = await startHttpServer();
    try {
      const response = await fetch(`${baseUrl}/mcp`, { method: "PATCH" });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, POST, DELETE");
      await expect(response.json()).resolves.toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
    } finally {
      await server.close();
    }
  });

  it("does not let failed initialization consume session capacity", async () => {
    let created = 0;
    const { server, baseUrl } = await startHttpServer(() => {
      created += 1;
      return buildServer();
    });
    try {
      const rejected = await Promise.all(
        Array.from({ length: 100 }, () =>
          postWithHost(`${baseUrl}/mcp`, "attacker.invalid"),
        ),
      );
      expect(rejected.every((status) => status === 403)).toBe(true);
      expect(created).toBe(0);
      expect(server.sessionCount()).toBe(0);

      const initialized = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: MCP_POST_HEADERS,
        body: JSON.stringify(INITIALIZE_REQUEST),
      });
      expect(initialized.status).toBe(200);
      expect(created).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("cleans up sessions after idle and absolute lifetimes", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { server, baseUrl } = await startHttpServer();
    try {
      const initialized = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: MCP_POST_HEADERS,
        body: JSON.stringify(INITIALIZE_REQUEST),
      });
      const sessionId = initialized.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      clock.mockReturnValue(now + SESSION_IDLE_TIMEOUT_MS + 1);
      const idleExpired = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...MCP_POST_HEADERS, "mcp-session-id": sessionId ?? "" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(idleExpired.status).toBe(404);
      expect(server.sessionCount()).toBe(0);

      clock.mockReturnValue(now);
      const secondInitialized = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: MCP_POST_HEADERS,
        body: JSON.stringify(INITIALIZE_REQUEST),
      });
      const secondSessionId = secondInitialized.headers.get("mcp-session-id");
      expect(secondSessionId).toBeTruthy();
      for (
        let elapsed = SESSION_IDLE_TIMEOUT_MS / 2;
        elapsed < SESSION_ABSOLUTE_TIMEOUT_MS;
        elapsed += SESSION_IDLE_TIMEOUT_MS / 2
      ) {
        clock.mockReturnValue(now + elapsed);
        const activity = await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { ...MCP_POST_HEADERS, "mcp-session-id": secondSessionId ?? "" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: elapsed,
            method: "tools/list",
            params: {},
          }),
        });
        expect(activity.status).toBe(200);
      }
      clock.mockReturnValue(now + SESSION_ABSOLUTE_TIMEOUT_MS + 1);
      const absoluteExpired = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...MCP_POST_HEADERS, "mcp-session-id": secondSessionId ?? "" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      });
      expect(absoluteExpired.status).toBe(404);
      expect(server.sessionCount()).toBe(0);
    } finally {
      clock.mockRestore();
      await server.close();
    }
  });

  it("does not forward gateway bearer tokens to the NetBox API", async () => {
    const upstreamAuthorizations: string[] = [];
    const netbox = createHttpServer((request, response) => {
      upstreamAuthorizations.push(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ count: 0, results: [] }));
    });
    await new Promise<void>((resolve) => netbox.listen(0, "127.0.0.1", resolve));
    const netboxAddress = netbox.address();
    if (!netboxAddress || typeof netboxAddress === "string")
      throw new Error("expected TCP listener");

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return url === "https://issuer.example.test/jwks"
          ? new Response(JSON.stringify({ keys: [jwk] }), {
              headers: { "content-type": "application/json" },
            })
          : originalFetch(input, init);
      },
    );
    const { server, baseUrl } = await startHttpServer(
      () =>
        buildServer({
          NETBOX_URL: `http://127.0.0.1:${netboxAddress.port}`,
          NETBOX_TOKEN: "server-side-token",
        }),
      {
        transport: "http",
        host: "127.0.0.1",
        port: 0,
        oidc: {
          issuer: "https://issuer.example.test",
          jwksUrl: "https://issuer.example.test/jwks",
          audience: "netbox-mcp",
        },
      },
    );
    const client = new Client({ name: "oidc-upstream-test", version: "0.0.0" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: {
          headers: { authorization: `Bearer ${await signedToken(privateKey, "alice")}` },
        },
      });
      await client.connect(transport as never);
      await client.callTool({
        name: "netbox_global_search",
        arguments: { query: "edge", resources: ["sites"] },
      });
      expect(upstreamAuthorizations).toEqual(["Token server-side-token"]);
    } finally {
      vi.unstubAllGlobals();
      await client.close();
      await server.close();
      await new Promise<void>((resolve, reject) =>
        netbox.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("fails closed with bounded JWKS retry backoff when the configured JWKS is unavailable", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const originalFetch = globalThis.fetch;
    const jwksFetch = vi.fn(() => {
      throw new TypeError("JWKS unavailable");
    });
    vi.stubGlobal(
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url === "https://issuer.example.test/unavailable-jwks") return jwksFetch();
        return originalFetch(input, init);
      },
    );
    const { server, baseUrl } = await startHttpServer(() => buildServer(), {
      transport: "http",
      host: "127.0.0.1",
      port: 0,
      oidc: {
        issuer: "https://issuer.example.test",
        jwksUrl: "https://issuer.example.test/unavailable-jwks",
        audience: "netbox-mcp",
      },
    });
    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_POST_HEADERS,
          authorization: `Bearer ${await signedToken(privateKey, "alice")}`,
        },
        body: JSON.stringify(INITIALIZE_REQUEST),
      });
      expect(response.status).toBe(503);
      const retry = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_POST_HEADERS,
          authorization: `Bearer ${await signedToken(privateKey, "alice")}`,
        },
        body: JSON.stringify(INITIALIZE_REQUEST),
      });
      expect(retry.status).toBe(503);
      expect(jwksFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      await server.close();
    }
  });

  it("verifies signed bearer tokens from the configured JWKS before session work", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    const originalFetch = globalThis.fetch;
    const jwksFetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal(
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return url === "https://issuer.example.test/jwks"
          ? jwksFetch()
          : originalFetch(input, init);
      },
    );
    const { server, baseUrl } = await startHttpServer(() => buildServer(), {
      transport: "http",
      host: "127.0.0.1",
      port: 0,
      oidc: {
        issuer: "https://issuer.example.test",
        jwksUrl: "https://issuer.example.test/jwks",
        audience: "netbox-mcp",
        requiredScope: "mcp",
      },
    });
    try {
      const missing = await fetch(`${baseUrl}/mcp`, { method: "POST" });
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toBe("Bearer");

      const expired = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_POST_HEADERS,
          authorization: `Bearer ${await signedToken(privateKey, "alice", "mcp", Math.floor(Date.now() / 1000) - 60)}`,
        },
        body: JSON.stringify(INITIALIZE_REQUEST),
      });
      expect(expired.status).toBe(401);

      const missingExpiration = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_POST_HEADERS,
          authorization: `Bearer ${await signedToken(privateKey, "alice", "mcp", null)}`,
        },
        body: JSON.stringify(INITIALIZE_REQUEST),
      });
      expect(missingExpiration.status).toBe(401);

      const insufficientScope = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_POST_HEADERS,
          authorization: `Bearer ${await signedToken(privateKey, "alice", "other")}`,
        },
        body: JSON.stringify(INITIALIZE_REQUEST),
      });
      expect(insufficientScope.status).toBe(403);

      const initialized = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_POST_HEADERS,
          authorization: `Bearer ${await signedToken(privateKey, "alice")}`,
        },
        body: JSON.stringify(INITIALIZE_REQUEST),
      });
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      const principalSessions = await Promise.all(
        Array.from({ length: MAX_SESSIONS_PER_PRINCIPAL - 1 }, async () =>
          fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
              ...MCP_POST_HEADERS,
              authorization: `Bearer ${await signedToken(privateKey, "alice")}`,
            },
            body: JSON.stringify(INITIALIZE_REQUEST),
          }),
        ),
      );
      expect(principalSessions.every((response) => response.status === 200)).toBe(true);
      const overQuota = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_POST_HEADERS,
          authorization: `Bearer ${await signedToken(privateKey, "alice")}`,
        },
        body: JSON.stringify(INITIALIZE_REQUEST),
      });
      expect(overQuota.status).toBe(429);

      const mismatchedSubject = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_POST_HEADERS,
          authorization: `Bearer ${await signedToken(privateKey, "bob")}`,
          "mcp-session-id": sessionId ?? "",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(mismatchedSubject.status).toBe(401);
      expect(jwksFetch).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await server.close();
    }
  });
});
