import { createRemoteJWKSet, jwtVerify } from "jose";
import { JOSEError, JWKSMultipleMatchingKeys, JWKSNoMatchingKey } from "jose/errors";

const JWKS_CACHE_MAX_AGE_MS = 5 * 60_000;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_TIMEOUT_MS = 5_000;
const JWKS_FAILURE_BACKOFF_INITIAL_MS = 1_000;
const JWKS_FAILURE_BACKOFF_MAX_MS = 30_000;

export interface OidcConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
  requiredScope?: string | undefined;
  resourceUrl?: string | undefined;
}

export interface OidcPrincipal {
  issuer: string;
  subject: string;
}

export class OidcAuthenticationError extends Error {
  constructor(readonly status: 401 | 403 | 503) {
    super(
      status === 403
        ? "Forbidden"
        : status === 503
          ? "Service unavailable"
          : "Unauthorized",
    );
  }
}

/** Read the gateway configuration only when HTTP authentication is relevant. */
export function loadOidcConfig(
  env: NodeJS.ProcessEnv,
  required: boolean,
): OidcConfig | undefined {
  const issuer = (env.NETBOX_OIDC_ISSUER ?? "").trim();
  const jwksUrl = (env.NETBOX_OIDC_JWKS_URL ?? "").trim();
  const audience = (env.NETBOX_OIDC_AUDIENCE ?? "").trim();
  const requiredScope = (env.NETBOX_OIDC_REQUIRED_SCOPE ?? "").trim();
  const resourceUrl = (env.NETBOX_OIDC_RESOURCE_URL ?? "").trim();
  const configured = issuer || jwksUrl || audience || requiredScope || resourceUrl;
  if (!required && !configured) return undefined;
  const config = {
    issuer,
    jwksUrl,
    audience,
    ...(requiredScope ? { requiredScope } : {}),
    ...(resourceUrl ? { resourceUrl } : {}),
  };
  assertOidcConfig(config);
  return config;
}

/** Resolve optional OIDC discovery before the HTTP listener starts. */
export async function resolveOidcConfig(
  env: NodeJS.ProcessEnv,
  required: boolean,
  warn: (message: string) => void = console.error,
): Promise<OidcConfig | undefined> {
  const discoveryUrl = (env.NETBOX_OIDC_DISCOVERY_URL ?? "").trim();
  if (!discoveryUrl) return loadOidcConfig(env, required);
  assertCanonicalHttpsUrl("NETBOX_OIDC_DISCOVERY_URL", discoveryUrl);

  let discovered: Pick<OidcConfig, "issuer" | "jwksUrl">;
  try {
    discovered = await fetchOidcDiscovery(discoveryUrl);
  } catch {
    try {
      const manual = loadOidcConfig(env, required);
      if (!manual) throw new Error("missing manual configuration");
      warn(
        "warning: OIDC discovery failed; using manually configured issuer and JWKS URL.",
      );
      return manual;
    } catch {
      throw new Error(
        "OIDC discovery failed and manual NETBOX_OIDC_ISSUER and NETBOX_OIDC_JWKS_URL configuration is incomplete or invalid.",
      );
    }
  }

  const manualIssuer = (env.NETBOX_OIDC_ISSUER ?? "").trim();
  const manualJwksUrl = (env.NETBOX_OIDC_JWKS_URL ?? "").trim();
  if (Boolean(manualIssuer) !== Boolean(manualJwksUrl)) {
    throw new Error(
      "NETBOX_OIDC_ISSUER and NETBOX_OIDC_JWKS_URL must be supplied together when NETBOX_OIDC_DISCOVERY_URL is set.",
    );
  }
  if (manualIssuer) {
    assertCanonicalHttpsUrl("NETBOX_OIDC_ISSUER", manualIssuer);
    assertCanonicalHttpsUrl("NETBOX_OIDC_JWKS_URL", manualJwksUrl);
    if (manualIssuer !== discovered.issuer || manualJwksUrl !== discovered.jwksUrl) {
      throw new Error(
        "Manual NETBOX_OIDC_ISSUER and NETBOX_OIDC_JWKS_URL must exactly match OIDC discovery.",
      );
    }
  }

  const config = {
    issuer: discovered.issuer,
    jwksUrl: discovered.jwksUrl,
    audience: (env.NETBOX_OIDC_AUDIENCE ?? "").trim(),
    ...((env.NETBOX_OIDC_REQUIRED_SCOPE ?? "").trim()
      ? { requiredScope: (env.NETBOX_OIDC_REQUIRED_SCOPE ?? "").trim() }
      : {}),
    ...((env.NETBOX_OIDC_RESOURCE_URL ?? "").trim()
      ? { resourceUrl: (env.NETBOX_OIDC_RESOURCE_URL ?? "").trim() }
      : {}),
  };
  assertOidcConfig(config);
  return config;
}

async function fetchOidcDiscovery(
  discoveryUrl: string,
): Promise<Pick<OidcConfig, "issuer" | "jwksUrl">> {
  const response = await fetch(discoveryUrl, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("OIDC discovery request failed");
  const document: unknown = await response.json();
  if (!document || typeof document !== "object") {
    throw new Error("OIDC discovery response is not an object");
  }
  const { issuer, jwks_uri: jwksUri } = document as Record<string, unknown>;
  if (typeof issuer !== "string" || typeof jwksUri !== "string") {
    throw new Error("OIDC discovery response is missing issuer or jwks_uri");
  }
  const config = { issuer: issuer.trim(), jwksUrl: jwksUri.trim() };
  assertCanonicalHttpsUrl("OIDC discovery issuer", config.issuer);
  assertCanonicalHttpsUrl("OIDC discovery jwks_uri", config.jwksUrl);
  return config;
}

export function assertOidcConfig(config: OidcConfig): void {
  if (!config.issuer.trim()) {
    throw new Error("Missing required environment variable NETBOX_OIDC_ISSUER.");
  }
  if (!config.jwksUrl.trim()) {
    throw new Error("Missing required environment variable NETBOX_OIDC_JWKS_URL.");
  }
  if (!config.audience.trim()) {
    throw new Error("Missing required environment variable NETBOX_OIDC_AUDIENCE.");
  }
  if (!config.requiredScope?.trim()) {
    throw new Error("Missing required environment variable NETBOX_OIDC_REQUIRED_SCOPE.");
  }
  if (!config.resourceUrl?.trim()) {
    throw new Error("Missing required environment variable NETBOX_OIDC_RESOURCE_URL.");
  }
  assertCanonicalHttpsUrl("NETBOX_OIDC_ISSUER", config.issuer);
  assertCanonicalHttpsUrl("NETBOX_OIDC_JWKS_URL", config.jwksUrl);
  assertCanonicalMcpResourceUrl(config.resourceUrl);
}

function assertCanonicalMcpResourceUrl(value: string): void {
  assertCanonicalHttpsUrl("NETBOX_OIDC_RESOURCE_URL", value);
  if (new URL(value).pathname !== "/mcp") {
    throw new Error("NETBOX_OIDC_RESOURCE_URL must identify the HTTPS /mcp endpoint.");
  }
}

function assertCanonicalHttpsUrl(name: string, value: string): void {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("invalid URL");
    }
  } catch {
    throw new Error(
      `${name} must be a canonical HTTPS URL without userinfo, a query, or a fragment.`,
    );
  }
}

export interface OidcAuthenticator {
  authenticate(authorization: string | undefined): Promise<OidcPrincipal>;
}

/** Verify gateway access tokens without exposing them to the NetBox API client. */
export function createOidcAuthenticator(config: OidcConfig): OidcAuthenticator {
  const keys = createRemoteJWKSet(new URL(config.jwksUrl), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    timeoutDuration: JWKS_TIMEOUT_MS,
  });
  let unavailableUntil = 0;
  let failureBackoffMs = JWKS_FAILURE_BACKOFF_INITIAL_MS;

  return {
    async authenticate(authorization: string | undefined): Promise<OidcPrincipal> {
      const token = bearerToken(authorization);
      if (!token) throw new OidcAuthenticationError(401);
      if (Date.now() < unavailableUntil) throw new OidcAuthenticationError(503);
      try {
        const { payload } = await jwtVerify(token, keys, {
          algorithms: ["RS256", "ES256"],
          issuer: config.issuer,
          audience: config.audience,
        });
        if (typeof payload.exp !== "number") throw new OidcAuthenticationError(401);
        const subject = typeof payload.sub === "string" ? payload.sub : "";
        if (!subject.trim()) throw new OidcAuthenticationError(401);
        if (config.requiredScope && !hasScope(payload.scope, config.requiredScope)) {
          throw new OidcAuthenticationError(403);
        }
        unavailableUntil = 0;
        failureBackoffMs = JWKS_FAILURE_BACKOFF_INITIAL_MS;
        return { issuer: config.issuer, subject };
      } catch (error) {
        if (error instanceof OidcAuthenticationError) throw error;
        if (isUnavailableJwks(error)) {
          unavailableUntil = Date.now() + failureBackoffMs;
          failureBackoffMs = Math.min(failureBackoffMs * 2, JWKS_FAILURE_BACKOFF_MAX_MS);
          throw new OidcAuthenticationError(503);
        }
        throw new OidcAuthenticationError(401);
      }
    },
  };
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    authorization ?? "",
  );
  return match?.[1];
}

function hasScope(scope: unknown, requiredScope: string): boolean {
  return typeof scope === "string" && scope.split(/\s+/).includes(requiredScope);
}

function isUnavailableJwks(error: unknown): boolean {
  if (error instanceof JWKSNoMatchingKey || error instanceof JWKSMultipleMatchingKeys) {
    return false;
  }
  return (
    error instanceof TypeError ||
    (error instanceof JOSEError &&
      (error.code === "ERR_JOSE_GENERIC" || error.code.startsWith("ERR_JWKS_")))
  );
}
