/**
 * Error formatting for NetBox API failures.
 *
 * Returns compact, actionable strings that the LLM can relay to the user or
 * use to pick a different approach.
 */

import axios, { AxiosError } from "axios";

/** Redacts one active credential from text without retaining it outside a request. */
export type SecretRedactor = (text: string) => string;

const NO_REDACTION: SecretRedactor = (text) => text;

/**
 * Make a redactor for the credential used by one outbound request.
 *
 * This deliberately uses string replacement rather than a token-shaped regular
 * expression: an upstream service can reflect the exact token without an
 * Authorization, Token, or Bearer prefix.
 */
export function createCredentialRedactor(token: string): SecretRedactor {
  if (token.length === 0) return NO_REDACTION;
  return (text: string): string => text.split(token).join("[redacted]");
}

/**
 * Convert an unknown error into a user-facing message.
 *
 * Never includes secrets: the formatters below read only the response status
 * and body, never `error.config` (which holds the Authorization header). Keep
 * it that way — any new branch that touches `error.config` must redact it.
 * The HTTP client supplies a request-scoped redactor for body text that an
 * upstream server might have reflected.
 */
export function handleApiError(
  error: unknown,
  redact: SecretRedactor = NO_REDACTION,
): string {
  if (axios.isAxiosError(error)) {
    return formatAxiosError(error, redact);
  }
  if (error instanceof Error) {
    return `Error: ${redact(error.message)}`;
  }
  return `Error: ${redact(String(error))}`;
}

function formatAxiosError(error: AxiosError, redact: SecretRedactor): string {
  // Network / no response.
  if (!error.response) {
    if (error.code === "ECONNABORTED") {
      return "Error: Request to NetBox timed out. The server may be slow or unreachable.";
    }
    if (error.code === "ENOTFOUND") {
      return "Error: NetBox host not found. Check that NETBOX_URL is correct and reachable.";
    }
    if (error.code === "ECONNREFUSED") {
      return "Error: Connection to NetBox refused. Check NETBOX_URL and that the server is running.";
    }
    if (
      error.code === "CERT_HAS_EXPIRED" ||
      error.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    ) {
      return (
        "Error: TLS certificate verification failed. " +
        "If this is an internal NetBox with a self-signed cert, set NETBOX_INSECURE=1."
      );
    }
    return `Error: Network error contacting NetBox: ${redact(error.message)}`;
  }

  const status = error.response.status;
  const bodyMessage = extractNetBoxMessage(error.response.data, redact);

  switch (status) {
    case 400:
      return (
        `Error: NetBox rejected the request (400 Bad Request). ` +
        `${bodyMessage ?? "Check that all required fields are provided and IDs/slugs exist."}`
      );
    case 401:
      return "Error: NetBox authentication failed (401). Check that NETBOX_TOKEN is valid and not expired.";
    case 403:
      return forbiddenMessage(bodyMessage);
    case 404:
      return (
        `Error: NetBox object not found (404). ` +
        `Verify the ID/slug is correct. ${bodyMessage ?? ""}`
      ).trim();
    case 409:
      return `Error: Conflict (409). ${bodyMessage ?? "An object with that name/slug likely already exists."}`;
    case 429:
      return "Error: NetBox rate limit exceeded (429). Wait a moment and retry.";
    default:
      if (status >= 500) {
        return `Error: NetBox server error (${status}). ${bodyMessage ?? "The NetBox instance may be unhealthy."}`;
      }
      return `Error: NetBox request failed with status ${status}. ${bodyMessage ?? ""}`.trim();
  }
}

/**
 * A live NetBox 4.6.0 answers **403** for a bad token, not 401: the body is
 * `{"detail":"Invalid v2 token"}`. Telling that operator "the token lacks
 * permission for this object" sends them to check object permissions when the
 * token is simply wrong, so the two cases are separated by the `detail` string.
 *
 * The same instance answers 403 with `Authentication credentials were not
 * provided.` when no `Authorization` header arrives — which is what a proxy
 * stripping the header looks like, and presents as neither a network error nor
 * an obvious auth error.
 */
const NO_CREDENTIAL = /authentication credentials were not provided/i;

/** DRF/NetBox wordings that mean "the credential you sent is not usable". */
const BAD_CREDENTIAL = [
  /invalid\s+(?:v\d+\s+)?token/i,
  /invalid token header/i,
  /token has expired/i,
  /expired token/i,
  /invalid username\/password/i,
];

/** DRF/NetBox wordings that mean "we know who you are; you may not do this". */
const NOT_PERMITTED = [
  /you do not have permission to perform this action/i,
  /permission denied/i,
  /insufficient permission/i,
  /read[- ]only/i,
  /not allowed/i,
];

const CHECK_TOKEN =
  "Check NETBOX_TOKEN: that it is the whole key, current, and belongs to this instance.";
const CHECK_PERMISSIONS =
  "Check the token's object permissions, and its write_enabled flag if this was a create, " +
  "update or delete — a read-only token is the most common cause.";

/**
 * Turn a 403 into advice that names the right fix.
 *
 * An unrecognised body must never produce a confident wrong answer: 403 alone
 * does not distinguish "your token is wrong" from "your token is fine but may
 * not do this", so when the body does not say, both are named.
 */
function forbiddenMessage(bodyMessage: string | undefined): string {
  const detail = bodyMessage?.trim();
  const quoted = detail !== undefined && detail.length > 0 ? `: ${detail}` : "";

  if (detail !== undefined && NO_CREDENTIAL.test(detail)) {
    return (
      `Error: NetBox received no credential (403${quoted}). ` +
      "The Authorization header did not arrive: either NETBOX_TOKEN is empty, or a proxy in " +
      "front of NetBox stripped the header. This is not a network failure and not a " +
      "permission problem — the request reached NetBox unauthenticated."
    );
  }
  if (detail !== undefined && BAD_CREDENTIAL.some((pattern) => pattern.test(detail))) {
    return (
      `Error: NetBox rejected the API token (403${quoted}). ` +
      `NetBox answers 403, not 401, for a token it cannot use. ${CHECK_TOKEN}`
    );
  }
  if (detail !== undefined && NOT_PERMITTED.some((pattern) => pattern.test(detail))) {
    return (
      `Error: Permission denied by NetBox (403${quoted}). ` +
      `The token was accepted but is not allowed to do this. ${CHECK_PERMISSIONS}`
    );
  }
  return (
    `Error: NetBox refused the request (403${quoted}) without saying which cause applies. ` +
    "Two are possible and this status does not distinguish them. " +
    `(1) The token is invalid or expired — NetBox answers 403, not 401, for that. ${CHECK_TOKEN} ` +
    `(2) The token is valid but not permitted here. ${CHECK_PERMISSIONS}`
  );
}

/** Longest upstream body text relayed to the model, per message part. */
const MAX_BODY_CHARS = 300;

/** Opening tags and closing tags of a served error page, either order. */
const HTML_BODY =
  /^\s*(?:<!doctype\s+html|<\?xml|<html|<head|<body)|<\/(?:html|body|head|title)\s*>/i;

/**
 * Bound one piece of upstream text before it can reach the model.
 *
 * A live 404 on an unknown endpoint answers `text/html`, and relaying a whole
 * error page — markup, stack frames, whatever the front-end serves — is not
 * something a caller can use. HTML is described rather than quoted, and
 * everything else is collapsed to one line and truncated.
 */
function boundBodyText(text: string, redact: SecretRedactor): string | undefined {
  const safeText = redact(text);
  const flat = safeText.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  if (HTML_BODY.test(safeText) || HTML_BODY.test(flat)) {
    return (
      `NetBox returned an HTML page (${safeText.length} characters) instead of a JSON error body; ` +
      "it is not relayed. This usually means the URL did not reach the API, or a proxy or " +
      "error page answered instead of NetBox."
    );
  }
  return flat.length <= MAX_BODY_CHARS
    ? flat
    : `${flat.slice(0, MAX_BODY_CHARS - 1)}… (truncated)`;
}

/**
 * NetBox returns errors in a few shapes. This extracts the most useful message
 * without assuming a specific structure:
 *   { "detail": "Not found." }
 *   { "field_name": ["This field is required."] }
 *   { "non_field_errors": ["..."] }
 *   plain string
 *
 * Every branch goes through `boundBodyText`: this is the only code that reads
 * an upstream body, so it is the only place that can bound one.
 */
function extractNetBoxMessage(data: unknown, redact: SecretRedactor): string | undefined {
  if (!data) return undefined;
  if (typeof data === "string") return boundBodyText(data, redact);
  if (typeof data !== "object") return undefined;

  const obj = data as Record<string, unknown>;
  if (typeof obj.detail === "string") return boundBodyText(obj.detail, redact);

  const parts: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val)) {
      parts.push(`${key}: ${val.join("; ")}`);
    } else if (typeof val === "string") {
      parts.push(`${key}: ${val}`);
    }
  }
  return parts.length > 0 ? boundBodyText(parts.join(" | "), redact) : undefined;
}
