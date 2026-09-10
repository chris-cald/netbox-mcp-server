/** Streamable HTTP transport; container networking controls listener exposure. */

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

import {
  assertOidcConfig,
  createOidcAuthenticator,
  loadOidcConfig,
  resolveOidcConfig,
  OidcAuthenticationError,
  type OidcConfig,
  type OidcAuthenticator,
  type OidcPrincipal,
} from "./oidc.js";
import { buildServer } from "./server.js";

const DEFAULT_HTTP_HOST = "0.0.0.0";
const DEFAULT_HTTP_PORT = 3000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_SESSIONS = 100;
export const MAX_SESSIONS_PER_PRINCIPAL = 10;
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60_000;
const SESSION_EXPIRY_SWEEP_MS = 60_000;

/** Conservative limits for incomplete HTTP requests on the local listener. */
export const HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const HTTP_REQUEST_TIMEOUT_MS = 30_000;

type McpServer = ReturnType<typeof buildServer>;

export type TransportConfig =
  | { transport: "stdio" }
  | {
      transport: "http";
      host: string;
      port: number;
      allowedHosts: string[];
      oidc?: OidcConfig | undefined;
    };

/** Parse only transport configuration; NetBox credentials stay in config.ts. */
export function loadTransportConfig(
  env: NodeJS.ProcessEnv = process.env,
): TransportConfig {
  const transport = (env.NETBOX_TRANSPORT ?? "stdio").trim().toLowerCase();
  if (transport === "stdio") return { transport: "stdio" };
  if (transport !== "http") {
    throw new Error("NETBOX_TRANSPORT must be either stdio or http.");
  }

  // HTTP runs on the conventional container port. Compose (or another runtime)
  // chooses whether and where that port is published.
  const host = DEFAULT_HTTP_HOST;
  const port = DEFAULT_HTTP_PORT;
  const allowedHosts = loadAllowedHosts(env);
  // Discovery is asynchronous and resolved before startup or --check completes.
  const oidc = env.NETBOX_OIDC_DISCOVERY_URL?.trim()
    ? undefined
    : loadOidcConfig(env, true);
  return { transport: "http", host, port, allowedHosts, oidc };
}

/** Resolve remote OIDC discovery only after the synchronous transport shape is valid. */
export async function resolveTransportConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TransportConfig> {
  const config = loadTransportConfig(env);
  if (config.transport === "stdio") return config;
  return { ...config, oidc: await resolveOidcConfig(env, true) };
}

function loadAllowedHosts(env: NodeJS.ProcessEnv): string[] {
  const raw = env.NETBOX_HTTP_ALLOWED_HOSTS?.trim();
  if (!raw) {
    throw new Error(
      "NETBOX_HTTP_ALLOWED_HOSTS is required when NETBOX_TRANSPORT=http; set comma-separated published Host values.",
    );
  }
  const allowedHosts = [
    ...new Set(raw.split(",").map((host) => host.trim().toLowerCase())),
  ];
  if (allowedHosts.some((host) => !isValidHostHeader(host))) {
    throw new Error(
      "NETBOX_HTTP_ALLOWED_HOSTS must be comma-separated hostnames or IP addresses with optional ports.",
    );
  }
  return allowedHosts;
}

interface ParsedHostHeader {
  hostname: string;
  port: string;
}

function parseHostHeader(host: string): ParsedHostHeader | undefined {
  const match = /^(?:\[([a-f\d:.]+)\]|([a-z\d.-]+))(?::(\d+))?$/i.exec(host);
  if (!match) return undefined;
  const port = match[3] ? Number(match[3]) : undefined;
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) {
    return undefined;
  }
  try {
    const parsed = new URL(`http://${host}`);
    return {
      hostname: parsed.hostname.toLowerCase(),
      port: port === undefined ? "" : String(port),
    };
  } catch {
    return undefined;
  }
}

function isValidHostHeader(host: string): boolean {
  return parseHostHeader(host) !== undefined;
}

function matchesAllowedHost(host: string, allowedHosts: string[]): boolean {
  const requested = parseHostHeader(host);
  return (
    !!requested &&
    allowedHosts.some((allowedHost) => {
      const allowed = parseHostHeader(allowedHost);
      return (
        !!allowed &&
        allowed.hostname === requested.hostname &&
        (!allowed.port || allowed.port === requested.port)
      );
    })
  );
}

function assertHttpListenerConfig(
  host: string,
  port: number,
  allowPortZero = false,
): void {
  if (!isIP(host)) {
    throw new Error("NETBOX_HTTP_HOST must be an IP address.");
  }
  if (!Number.isSafeInteger(port) || port < (allowPortZero ? 0 : 1) || port > 65535) {
    throw new Error("NETBOX_HTTP_PORT must be an integer from 1 through 65535.");
  }
}

interface Session {
  id: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastActivityAt: number;
  principal?: OidcPrincipal | undefined;
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
  if (config.allowedHosts.length === 0) {
    throw new Error("NETBOX_HTTP_ALLOWED_HOSTS must contain at least one Host value.");
  }
  if (config.oidc) assertOidcConfig(config.oidc);

  const authenticator = config.oidc ? createOidcAuthenticator(config.oidc) : undefined;
  const metadata = config.oidc ? protectedResourceMetadata(config.oidc) : undefined;
  const sessions = new Map<string, Session>();
  const activeSessions = new Set<Session>();
  let ready = false;
  let closed = false;
  let expirySweepRunning = false;

  async function cleanupExpiredSessions(): Promise<void> {
    if (expirySweepRunning) return;
    expirySweepRunning = true;
    try {
      const now = Date.now();
      const expired = [...activeSessions].filter(
        (session) =>
          now - session.lastActivityAt >= SESSION_IDLE_TIMEOUT_MS ||
          now - session.createdAt >= SESSION_ABSOLUTE_TIMEOUT_MS,
      );
      await Promise.allSettled(expired.map((session) => session.server.close()));
      for (const session of expired) {
        sessions.delete(session.id);
        activeSessions.delete(session);
      }
    } finally {
      expirySweepRunning = false;
    }
  }

  const expiryTimer = setInterval(
    () => void cleanupExpiredSessions(),
    SESSION_EXPIRY_SWEEP_MS,
  );
  expiryTimer.unref();

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
    if (metadata && path === metadata.path && request.method === "GET") {
      if (!validateHostHeader(request, response)) return;
      writeJson(response, 200, {
        resource: config.oidc?.resourceUrl,
        authorization_servers: [config.oidc?.issuer],
      });
      return;
    }
    if (path !== "/mcp") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    if (!validateHostHeader(request, response)) return;
    if (!validateOriginHeader(request, response)) return;

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

    const principal = await authenticateRequest(
      request,
      response,
      authenticator,
      config.oidc,
    );
    if (principal === undefined && authenticator) return;
    await cleanupExpiredSessions();

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
        if (!samePrincipal(existing.principal, principal)) {
          request.resume();
          writeAuthenticationError(response, 401, config.oidc);
          return;
        }
        existing.lastActivityAt = Date.now();
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
      if (
        principal &&
        [...activeSessions].filter((session) =>
          samePrincipal(session.principal, principal),
        ).length >= MAX_SESSIONS_PER_PRINCIPAL
      ) {
        writeJsonRpcError(response, 429, -32000, "MCP principal session limit reached");
        return;
      }
      await createSession(body, request, response, principal);
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
    if (!samePrincipal(session.principal, principal)) {
      request.resume();
      writeAuthenticationError(response, 401, config.oidc);
      return;
    }
    session.lastActivityAt = Date.now();
    await session.transport.handleRequest(request, response);
  }

  function validateHostHeader(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    const host = request.headers.host?.toLowerCase();
    if (host && matchesAllowedHost(host, config.allowedHosts)) return true;
    request.resume();
    writeJsonRpcError(response, 403, -32000, `Invalid Host header: ${host}`);
    return false;
  }

  function validateOriginHeader(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    const origin = request.headers.origin;
    const resourceOrigin =
      config.oidc?.resourceUrl && new URL(config.oidc.resourceUrl).origin;
    if (!origin || !resourceOrigin || origin === resourceOrigin) return true;
    request.resume();
    writeJsonRpcError(response, 403, -32000, "Invalid Origin header");
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
    principal: OidcPrincipal | undefined,
  ): Promise<void> {
    const id = randomUUID();
    const server = createMcpServer();
    const now = Date.now();
    const session: Session = {
      id,
      server,
      createdAt: now,
      lastActivityAt: now,
      ...(principal ? { principal } : {}),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
        // Validate here because configured hosts may intentionally omit a port.
        enableDnsRebindingProtection: false,
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
      clearInterval(expiryTimer);
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

async function authenticateRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authenticator: OidcAuthenticator | undefined,
  oidc: OidcConfig | undefined,
): Promise<OidcPrincipal | undefined> {
  if (!authenticator) return undefined;
  try {
    return await authenticator.authenticate(request.headers.authorization);
  } catch (error) {
    request.resume();
    writeAuthenticationError(
      response,
      error instanceof OidcAuthenticationError ? error.status : 503,
      oidc,
    );
    return undefined;
  }
}

function samePrincipal(
  sessionPrincipal: OidcPrincipal | undefined,
  requestPrincipal: OidcPrincipal | undefined,
): boolean {
  return (
    sessionPrincipal?.issuer === requestPrincipal?.issuer &&
    sessionPrincipal?.subject === requestPrincipal?.subject
  );
}

function writeAuthenticationError(
  response: ServerResponse,
  status: 401 | 403 | 503,
  oidc?: OidcConfig,
): void {
  const message =
    status === 403
      ? "Forbidden"
      : status === 503
        ? "Service unavailable"
        : "Unauthorized";
  writeJsonRpcError(
    response,
    status,
    -32000,
    message,
    status === 401
      ? { "www-authenticate": bearerChallenge(oidc) }
      : status === 403
        ? {
            "www-authenticate": `Bearer error="insufficient_scope", scope="${oidc?.requiredScope ?? ""}"`,
          }
        : undefined,
  );
}

function protectedResourceMetadata(oidc: OidcConfig): { path: string; url: string } {
  const resource = new URL(oidc.resourceUrl ?? "");
  resource.pathname = `/.well-known/oauth-protected-resource${resource.pathname}`;
  return { path: resource.pathname, url: resource.href };
}

function bearerChallenge(oidc: OidcConfig | undefined): string {
  if (!oidc?.resourceUrl) return "Bearer";
  return `Bearer resource_metadata="${protectedResourceMetadata(oidc).url}"`;
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
