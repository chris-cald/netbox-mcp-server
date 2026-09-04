/**
 * Server construction and introspection.
 *
 * Kept separate from `index.ts` so the server can be built and inspected
 * in-process, without starting a transport as an import side effect. The
 * entry point is an executable; importing an executable to test it is not a
 * thing we want anyone to have to do.
 */

import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createNetBoxClient, type NetBoxApi } from "./client.js";
import { loadConfig, type NetBoxConfig } from "./config.js";
import { handleApiError } from "./errors.js";
import { createSchemaProviderForConfig } from "./schema/index.js";
import type { SchemaProvider } from "./schema/types.js";
import { registerLayeredTools } from "./tools/layered/index.js";

export const SERVER_NAME = "netbox-mcp-server";

/**
 * Read the version from package.json rather than restating it here. A
 * hardcoded copy drifts from what npm publishes, and the drift is silent.
 */
export const SERVER_VERSION: string = (() => {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0-unknown";
})();

/**
 * A provider that fails on use, for the paths that must work with no NetBox
 * configuration at all — `--list-tools`, and any client that calls
 * `tools/list` before the user has supplied credentials.
 *
 * This is safe only because the six tools are registered statically: their
 * names, descriptions and input schemas do not depend on the instance. The
 * schema is consulted when a tool is *called*, never when it is listed. The
 * surface suite pins that by listing tools through a provider that throws on
 * every method.
 */
function unconfiguredProvider(reason: string): SchemaProvider {
  const fail = (): never => {
    throw new Error(reason);
  };
  return {
    version: () => Promise.resolve().then(fail),
    listObjectTypes: () => Promise.resolve().then(fail),
    resolve: () => Promise.resolve().then(fail),
    describe: () => Promise.resolve().then(fail),
  };
}

export interface InjectedNetBoxApi {
  /** The server-scoped operations exposed to the layered tools. */
  api: NetBoxApi;
  /**
   * Turns a failed injected request into safe MCP text while that adapter's
   * active credential is still in scope. It must redact reflected secrets and
   * must not expose credentials or redaction functions to MCP/tool adapters.
   */
  sanitizeApiError: (error: unknown) => string;
}

export interface BuildServerOptions {
  /** Override the schema provider. Tests use this; nothing else should. */
  schema?: SchemaProvider | undefined;
  /**
   * Server-scoped API dependency. Injected adapters must sanitize errors at
   * their credential boundary rather than allowing raw upstream errors into
   * MCP tool results.
   */
  api?: InjectedNetBoxApi | undefined;
}

/**
 * Build a fully registered server.
 *
 * Does not read NetBox configuration unless it has to, and never contacts the
 * instance during construction — the schema document is fetched lazily on the
 * first tool call that needs it. A session that only lists tools pays nothing.
 */
function assertInjectedApi(dependency: InjectedNetBoxApi): void {
  if (typeof dependency.sanitizeApiError !== "function") {
    throw new Error(
      "An injected NetBox API requires sanitizeApiError so upstream errors cannot reach tool output.",
    );
  }
  const api = dependency.api;
  if (
    !api ||
    ["list", "get", "create", "update", "del", "detailAction"].some(
      (method) => typeof api[method as keyof NetBoxApi] !== "function",
    )
  ) {
    throw new Error("An injected NetBox API must implement every NetBoxApi method.");
  }
}

export function buildServer(
  env: NodeJS.ProcessEnv = process.env,
  options: BuildServerOptions = {},
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  if (options.api) assertInjectedApi(options.api);

  let config: NetBoxConfig | undefined;
  const loadServerConfig = (): NetBoxConfig => {
    if (!config) config = loadConfig(env);
    return config;
  };

  let schema = options.schema;
  if (!schema) {
    try {
      schema = createSchemaProviderForConfig(loadServerConfig());
    } catch (err) {
      schema = unconfiguredProvider(
        `${err instanceof Error ? err.message : String(err)} ` +
          "Set NETBOX_URL and NETBOX_TOKEN, then run `netbox-mcp --check` to verify.",
      );
    }
  }

  // Construct the HTTP client only on the first execution call. Unlike the
  // legacy `getClient` adapter, this cache belongs to this server instance and
  // therefore cannot couple stdio, future HTTP sessions, or test credentials.
  let api = options.api?.api;
  const getServerApi = (): NetBoxApi => {
    if (!api) api = createNetBoxClient(loadServerConfig());
    return api;
  };

  // The built-in client sanitizes while its request-scoped credential is in
  // scope. An injected client supplies the same narrow boundary explicitly.
  registerLayeredTools(
    server,
    schema,
    getServerApi,
    options.api ? options.api.sanitizeApiError : handleApiError,
  );
  return server;
}

export interface ToolSummary {
  name: string;
  description?: string | undefined;
}

/**
 * Enumerate the registered tools over a real MCP handshake on an in-memory
 * transport. Deliberately not a read of the SDK's private registry: what
 * matters is what a client actually receives from `tools/list`.
 */
export async function listTools(
  env: NodeJS.ProcessEnv = process.env,
  options: BuildServerOptions = {},
): Promise<ToolSummary[]> {
  const server = buildServer(env, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "introspect", version: SERVER_VERSION });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.listTools();
    return result.tools.map((t) => ({ name: t.name, description: t.description }));
  } finally {
    await client.close();
    await server.close();
  }
}
