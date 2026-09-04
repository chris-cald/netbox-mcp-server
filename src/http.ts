/** Streamable HTTP transport and its loopback-only listener configuration. */

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import { isIP, type AddressInfo } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { buildServer } from "./server.js";

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_SESSIONS = 100;

/** Conservative limits for incomplete HTTP requests on the local listener. */
export const HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const HTTP_REQUEST_TIMEOUT_MS = 30_000;

type McpServer = ReturnType<typeof buildServer>;

export type TransportConfig =
  { transport: "stdio" } | { transport: "http"; host: string; port: number };

/** Parse only transport configuration; NetBox credentials stay in config.ts. */
export function loadTransportConfig(
  env: NodeJS.ProcessEnv = process.env,
): TransportConfig {
  const transport = (env.NETBOX_TRANSPORT ?? "stdio").trim().toLowerCase();
  if (transport === "stdio") return { transport: "stdio" };
  if (transport !== "http") {
    throw new Error("NETBOX_TRANSPORT must be either stdio or http.");
  }

  const host = (env.NETBOX_HTTP_HOST ?? DEFAULT_HTTP_HOST).trim();
  const rawPort = (env.NETBOX_HTTP_PORT ?? String(DEFAULT_HTTP_PORT)).trim();
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("NETBOX_HTTP_PORT must be an integer from 1 through 65535.");
  }
  const port = Number(rawPort);
  assertHttpListenerConfig(host, port);
  return { transport: "http", host, port };
}

function assertHttpListenerConfig(
  host: string,
  port: number,
  allowPortZero = false,
): void {
  if (!isLoopbackAddress(host)) {
    throw new Error(
      "NETBOX_HTTP_HOST must be a loopback IP address until gateway authentication is configured.",
    );
  }
  if (!Number.isSafeInteger(port) || port < (allowPortZero ? 0 : 1) || port > 65535) {
    throw new Error("NETBOX_HTTP_PORT must be an integer from 1 through 65535.");
  }
}

function isLoopbackAddress(host: string): boolean {
  const version = isIP(host);
  if (version === 4) return host.split(".")[0] === "127";
  return version === 6 && host === "::1";
}

interface Session {
  id: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface StreamableHttpServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  address(): AddressInfo | string | null;
  isReady(): boolean;
  sessionCount(): number;
}

export function createStreamableHttpServer(
  config: Extract<TransportConfig, { transport: "http" }>,
  createMcpServer: () => McpServer = buildServer,
): StreamableHttpServer {
  // This factory is public; callers can bypass loadTransportConfig().
  assertHttpListenerConfig(config.host, config.port, true);

  const sessions = new Map<string, Session>();
  const activeSessions = new Set<Session>();
  let ready = false;
  let closed = false;

  const nodeServer = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent && !response.writableEnded) {
        writeJsonRpcError(response, 500, -32603, "Internal server error");
      }
    });
  });
  nodeServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  nodeServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  // Keep post-listen socket errors from becoming an uncaught process exception.
  nodeServer.on("error", () => undefined);

  const listenerPort = (): number => {
    const address = nodeServer.address();
    return address && typeof address !== "string" ? address.port : config.port;
  };
  const allowedHosts = (): string[] => {
    const host = config.host.includes(":") ? `[${config.host}]` : config.host;
    return [host, `${host}:${listenerPort()}`];
  };

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (closed) {
      writeJson(response, 503, { status: "shutting_down" });
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz" && request.method === "GET") {
      writeJson(response, 200, { status: "ok" });
      return;
    }
    if (path === "/readyz" && request.method === "GET") {
      writeJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
      return;
    }
    if (path !== "/mcp") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    if (!validateHostHeader(request, response)) return;

    if (
      request.method !== "POST" &&
      request.method !== "GET" &&
      request.method !== "DELETE"
    ) {
      writeJsonRpcError(response, 405, -32000, "Method not allowed.", {
        allow: "GET, POST, DELETE",
      });
      return;
    }

    const sessionId = request.headers["mcp-session-id"];
    const id = typeof sessionId === "string" ? sessionId : undefined;
    if (request.method === "POST") {
      if (!validatePostHeaders(request, response)) return;
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        if (error instanceof RequestTooLargeError) {
          writeJsonRpcError(
            response,
            413,
            -32600,
            "Request body exceeds the 1 MiB limit",
          );
        } else {
          writeJsonRpcError(response, 400, -32700, "Parse error");
        }
        return;
      }
      const existing = id ? sessions.get(id) : undefined;
      if (existing) {
        await existing.transport.handleRequest(request, response, body);
        return;
      }
      if (id || !isInitializeRequest(body)) {
        writeJsonRpcError(
          response,
          id ? 404 : 400,
          -32000,
          "Invalid or missing MCP session",
        );
        return;
      }
      if (activeSessions.size >= MAX_SESSIONS) {
        writeJsonRpcError(response, 503, -32000, "MCP session limit reached");
        return;
      }
      await createSession(body, request, response);
      return;
    }

    if (!id) {
      writeJsonRpcError(response, 400, -32000, "Mcp-Session-Id header is required");
      return;
    }
    const session = sessions.get(id);
    if (!session) {
      writeJsonRpcError(response, 404, -32001, "Session not found");
      return;
    }
    await session.transport.handleRequest(request, response);
  }

  function validateHostHeader(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    const host = request.headers.host;
    if (host && allowedHosts().includes(host)) return true;
    request.resume();
    writeJsonRpcError(response, 403, -32000, `Invalid Host header: ${host}`);
    return false;
  }

  function validatePostHeaders(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    const accept = request.headers.accept;
    if (!accept?.includes("application/json") || !accept.includes("text/event-stream")) {
      request.resume();
      writeJsonRpcError(
        response,
        406,
        -32000,
        "Not Acceptable: Client must accept both application/json and text/event-stream",
      );
      return false;
    }
    const contentType = request.headers["content-type"];
    if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      request.resume();
      writeJsonRpcError(
        response,
        415,
        -32000,
        "Unsupported Media Type: Content-Type must be application/json",
      );
      return false;
    }
    return true;
  }

  async function createSession(
    body: unknown,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const id = randomUUID();
    const server = createMcpServer();
    const session: Session = {
      id,
      server,
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
        allowedHosts: allowedHosts(),
        enableDnsRebindingProtection: true,
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, session);
        },
        onsessionclosed: () => {
          sessions.delete(id);
          activeSessions.delete(session);
        },
      }),
    };
    const remove = () => {
      sessions.delete(id);
      activeSessions.delete(session);
    };
    activeSessions.add(session);
    // connect() preserves this callback, so all transport closes release capacity.
    session.transport.onclose = remove;
    try {
      // SDK 1.30's optional callback declarations conflict with exactOptionalPropertyTypes.
      await server.connect(session.transport as never);
      await session.transport.handleRequest(request, response, body);
    } finally {
      // Validation failures can occur inside the SDK before onsessioninitialized.
      if (!sessions.has(id)) {
        try {
          await server.close();
        } finally {
          remove();
        }
      }
    }
  }

  return {
    async listen(): Promise<void> {
      if (closed) throw new Error("HTTP transport has been closed.");
      if (ready) return;
      await listen(nodeServer, config.port, config.host);
      ready = true;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      ready = false;
      const active = [...activeSessions];
      await Promise.allSettled(active.map((session) => session.server.close()));
      for (const session of active) {
        sessions.delete(session.id);
        activeSessions.delete(session);
      }
      await close(nodeServer);
    },
    address: () => nodeServer.address(),
    isReady: () => ready,
    sessionCount: () => sessions.size,
  };
}

class RequestTooLargeError extends Error {}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
    request.resume();
    throw new RequestTooLargeError();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  await new Promise<void>((resolve, reject) => {
    request.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", resolve);
    request.once("error", reject);
  });
  if (tooLarge) throw new RequestTooLargeError();
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: object,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function writeJsonRpcError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
): void {
  writeJson(
    response,
    status,
    { jsonrpc: "2.0", error: { code, message }, id: null },
    headers,
  );
}

function listen(server: NodeHttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
