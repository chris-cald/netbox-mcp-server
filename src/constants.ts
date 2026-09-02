/**
 * Shared constants.
 */

/**
 * Maximum character size of a single tool response. Responses larger than this
 * are truncated with a clear message guiding the caller to filter or paginate.
 */
export const CHARACTER_LIMIT = 25000;

/** Default page size for list operations. */
export const DEFAULT_LIMIT = 50;

/** Maximum page size a caller may request. */
export const MAX_LIMIT = 1000;

/** Default HTTP timeout for NetBox API calls (ms). */
export const DEFAULT_TIMEOUT_MS = 30000;

/** Required environment variable: full base URL of the NetBox instance, e.g. `https://netbox.example.com`. */
export const ENV_NETBOX_URL = "NETBOX_URL";

/** Inline NetBox API token credential source. */
export const ENV_NETBOX_TOKEN = "NETBOX_TOKEN";

/** Path to a regular file containing the NetBox API token credential source. */
export const ENV_NETBOX_TOKEN_FILE = "NETBOX_TOKEN_FILE";

/**
 * Optional environment variable: "1" / "true" / "yes" to allow self-signed TLS
 * certificates (common for on-prem NetBox). Defaults to verifying TLS.
 */
export const ENV_NETBOX_INSECURE = "NETBOX_INSECURE";
