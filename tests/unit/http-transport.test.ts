import { request as httpRequest } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import {
  createStreamableHttpServer,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  loadTransportConfig,
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

async function startHttpServer(createMcpServer = () => buildServer()) {
  const server = createStreamableHttpServer(
    { transport: "http", host: "127.0.0.1", port: 0 },
    createMcpServer,
  );
  await server.listen();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP listener");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("HTTP transport configuration", () => {
  it("keeps stdio as the default", () => {
    expect(loadTransportConfig({})).toEqual({ transport: "stdio" });
  });

  it("uses a loopback HTTP listener by default", () => {
    expect(loadTransportConfig({ NETBOX_TRANSPORT: "http" })).toEqual({
      transport: "http",
      host: "127.0.0.1",
      port: 3000,
    });
  });

  it("fails closed for unsupported transports, public hosts, and invalid ports", () => {
    expect(() => loadTransportConfig({ NETBOX_TRANSPORT: "sse" })).toThrow(
      /NETBOX_TRANSPORT/,
    );
    expect(() =>
      loadTransportConfig({ NETBOX_TRANSPORT: "http", NETBOX_HTTP_HOST: "0.0.0.0" }),
    ).toThrow(/loopback/);
    expect(() =>
      loadTransportConfig({ NETBOX_TRANSPORT: "http", NETBOX_HTTP_PORT: "65536" }),
    ).toThrow(/NETBOX_HTTP_PORT/);
    expect(() =>
      createStreamableHttpServer({ transport: "http", host: "0.0.0.0", port: 3000 }),
    ).toThrow(/loopback/);
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
});
