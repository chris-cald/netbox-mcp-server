/**
 * Environment configuration for the NetBox MCP server.
 *
 * Required:
 *   NETBOX_URL   - base URL of the NetBox instance (e.g. https://netbox.example.com)
 *   exactly one of NETBOX_TOKEN or NETBOX_TOKEN_FILE - API token source
 *
 * Optional:
 *   NETBOX_INSECURE - "1"/"true"/"yes" to skip TLS verification
 */

import {
  ENV_NETBOX_INSECURE,
  ENV_NETBOX_TOKEN,
  ENV_NETBOX_TOKEN_FILE,
  ENV_NETBOX_URL,
} from "./constants.js";
import {
  createCredentialProvider,
  type NetBoxCredentialProvider,
} from "./credentials.js";

export interface NetBoxConfig {
  /** Fully qualified base URL, no trailing slash. */
  baseUrl: string;
  /** Derived API root, e.g. https://netbox.example.com/api */
  apiUrl: string;
  /** Resolves an API token immediately before each outbound request. */
  credentials: NetBoxCredentialProvider;
  /** Whether to allow self-signed TLS certificates. */
  insecure: boolean;
}

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

/**
 * Read and validate environment configuration. Throws with an actionable
 * message if required variables are missing or malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): NetBoxConfig {
  const rawUrl = (env[ENV_NETBOX_URL] ?? "").trim();
  const insecure = parseBool(env[ENV_NETBOX_INSECURE]);

  if (!rawUrl) {
    throw new Error(
      `Missing required environment variable ${ENV_NETBOX_URL}. ` +
        `Set it to the base URL of your NetBox instance, e.g. https://netbox.example.com`,
    );
  }
  // Normalize the URL: strip trailing slash and any trailing /api.
  let baseUrl = rawUrl.replace(/\/+$/, "");
  baseUrl = baseUrl.replace(/\/api$/i, "");

  try {
    // A base URL identifies an instance, not a credential-bearing request.
    // Keep the generic error free of raw input: URLs can contain userinfo.
    const parsed = new URL(baseUrl);
    // URL.username is empty for the syntactically valid empty-userinfo form
    // (`https://@host`), so inspect only the authority delimiter as well.
    const authority = baseUrl.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1] ?? "";
    if (
      authority.includes("@") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("base URL must not include userinfo, a query, or a fragment");
    }
  } catch {
    throw new Error(
      `${ENV_NETBOX_URL} is not a valid URL. ` +
        `Expected a base URL like https://netbox.example.com without userinfo, a query, or a fragment.`,
    );
  }

  return {
    baseUrl,
    apiUrl: `${baseUrl}/api`,
    credentials: createCredentialProvider({
      inlineToken: env[ENV_NETBOX_TOKEN],
      tokenFile: env[ENV_NETBOX_TOKEN_FILE],
    }),
    insecure,
  };
}
