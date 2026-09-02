#!/usr/bin/env node
/**
 * netbox-mcp-server — entry point.
 *
 * Thin by design: parse argv, delegate, exit. Everything worth testing lives
 * in `server.ts` and below.
 *
 * Exit codes:
 *   0   success
 *   1   runtime failure
 *   78  configuration error (EX_CONFIG) — used by `--check`
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { buildServer, listTools, SERVER_NAME, SERVER_VERSION } from "./server.js";

const EX_CONFIG = 78;

const HELP = [
  `${SERVER_NAME} v${SERVER_VERSION}`,
  "",
  "MCP server exposing the NetBox REST API to an AI assistant.",
  "",
  "Usage:",
  "  netbox-mcp                Run the server on stdio (the normal mode).",
  "  netbox-mcp --check        Validate configuration and exit. 0 = usable, 78 = not.",
  "  netbox-mcp --list-tools   Print every registered tool name and exit.",
  "  netbox-mcp --version      Print the version and exit.",
  "  netbox-mcp --help         Print this message and exit.",
  "",
  "Required environment variables and credential source:",
  "  NETBOX_URL         Base URL of the NetBox instance, e.g. https://netbox.example.com",
  "  NETBOX_TOKEN       Inline NetBox API token (set exactly one token source)",
  "  NETBOX_TOKEN_FILE  Readable regular file containing the token (set exactly one token source)",
  "",
  "Optional environment variables:",
  "  NETBOX_INSECURE     Set to 1/true/yes to disable TLS certificate verification.",
  "                      This exposes the token to anyone able to intercept the",
  "                      connection. Prefer installing your internal root CA.",
  "",
  "NETBOX_TOKEN_FILE is read before every NetBox request so token rotation takes",
  "effect without restart. File paths and token values are never reported.",
  "",
  "Write access is controlled by the NetBox token, not by this server. Create",
  "the token with 'write enabled' unchecked, and constrain its object",
  "permissions, if the assistant should not be able to change anything. That",
  "is enforced by NetBox, where no tool argument can reach it.",
  "",
  "Transport: stdio only. This binary is launched as a subprocess by an",
  "MCP-aware client (Claude Desktop, Claude Code, Cursor, Codex, ...).",
].join("\n");

async function runStdio(): Promise<void> {
  try {
    const config = loadConfig();
    await config.credentials.getToken();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(EX_CONFIG);
  }

  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(SERVER_VERSION);
    return;
  }

  if (argv.includes("--check")) {
    try {
      const config = loadConfig();
      await config.credentials.getToken();
      console.log(
        `ok: ${SERVER_NAME} v${SERVER_VERSION} configured for ${config.baseUrl}`,
      );
      if (config.insecure) {
        console.error(
          "warning: NETBOX_INSECURE is set — TLS certificate verification is disabled.",
        );
      }
      return;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(EX_CONFIG);
    }
  }

  if (argv.includes("--list-tools")) {
    const tools = await listTools();
    for (const tool of tools) console.log(tool.name);
    console.error(`${tools.length} tools registered.`);
    return;
  }

  await runStdio();
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
