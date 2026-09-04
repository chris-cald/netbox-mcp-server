/**
 * Thin Axios-based NetBox REST client.
 *
 * Server-built tools use clients created by `createNetBoxClient()` and cached
 * lazily per server instance. Direct tool registration retains legacy
 * process-global `getClient()` as its default. Clients apply auth headers and
 * TLS options from their configuration.
 */

import axios, { AxiosError, AxiosInstance, AxiosResponse } from "axios";
import http from "node:http";
import https from "node:https";

import { netBoxAuthorization } from "./authorization.js";
import { loadConfig, NetBoxConfig } from "./config.js";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";
import { createCredentialRedactor, handleApiError } from "./errors.js";

let cachedClient: NetBoxClient | null = null;

export interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/**
 * The narrow NetBox REST operations the tool layer may use. It deliberately
 * exposes collection-relative methods rather than arbitrary URLs, so injected
 * implementations retain the same endpoint boundary as the default client.
 */
export type DetailAction = "available-ips" | "available-prefixes" | "trace" | "paths";
export type CollectionActionMethod = "post" | "patch" | "delete";

export interface NetBoxApi {
  list<T>(
    endpoint: string,
    params?: Record<string, unknown>,
  ): Promise<PaginatedResponse<T>>;
  get<T>(endpoint: string, id: number | string): Promise<T>;
  create<T>(endpoint: string, body: Record<string, unknown>): Promise<T>;
  update<T>(
    endpoint: string,
    id: number | string,
    body: Record<string, unknown>,
  ): Promise<T>;
  del(endpoint: string, id: number | string): Promise<void>;
  /** Invoke a schema-confirmed collection action; callers never supply a path or method. */
  collectionAction<T>(
    endpoint: string,
    method: CollectionActionMethod,
    body: Record<string, unknown>[],
  ): Promise<T>;
  /** Invoke a closed semantic detail action; callers never supply a path or method. */
  detailAction<T>(
    endpoint: string,
    id: number,
    action: DetailAction,
    method: "get" | "post",
    body?: unknown,
    params?: Record<string, unknown>,
  ): Promise<T>;
}

/** Supplies an API at call time, preserving lazy tool construction. */
export type NetBoxApiProvider = () => NetBoxApi;

export interface NetBoxClientOptions {
  /** Injectable transport seam for tests; normal clients create Axios themselves. */
  http?: AxiosInstance | undefined;
  /** Injectable DNS seam for HTTP integration tests. */
  httpAgent?: http.Agent | undefined;
}

export class NetBoxClient implements NetBoxApi {
  readonly config: NetBoxConfig;
  private readonly http: AxiosInstance;

  constructor(config: NetBoxConfig, options: NetBoxClientOptions = {}) {
    this.config = config;
    this.http =
      options.http ??
      axios.create({
        baseURL: config.apiUrl,
        timeout: DEFAULT_TIMEOUT_MS,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        // Axios serialises an array as `name[]=a&name[]=b`. NetBox's filters
        // expect the parameter REPEATED — `name=a&name=b` — and, worse, NetBox
        // silently ignores a parameter it does not recognise and returns the
        // complete unfiltered collection. So `name[]=` did not error: it dropped
        // the filter and answered with everything, which a caller cannot tell
        // from a genuinely unfiltered match.
        //
        // The local filter-name validation does not catch this. The caller sends
        // `name`, which is a real parameter, and the corruption happens after
        // validation, during serialisation.
        paramsSerializer: { serialize: repeatParams },
        httpAgent: options.httpAgent,
        httpsAgent: config.insecure
          ? new https.Agent({ rejectUnauthorized: false })
          : undefined,
        // `follow-redirects` historically preserves Authorization for a
        // subdomain redirect. A subdomain is a separate origin and must never
        // receive a NetBox token. Same-origin redirects retain it.
        beforeRedirect: (options) =>
          stripAuthorizationOnCrossOriginRedirect(options, new URL(config.apiUrl).origin),
        // Reject only on >= 500 so we can surface NetBox's error body verbatim.
        validateStatus: (status) => status < 500,
      });
  }

  /**
   * GET /<endpoint>/ optionally with query params. `endpoint` should NOT have
   * leading or trailing slashes, e.g. "dcim/sites".
   */
  async list<T>(
    endpoint: string,
    params: Record<string, unknown> = {},
  ): Promise<PaginatedResponse<T>> {
    const response = await this.request((authorization) =>
      this.http.get(`/${endpoint}/`, {
        params: cleanParams(params),
        headers: { Authorization: authorization },
      }),
    );
    return response.data as PaginatedResponse<T>;
  }

  /** GET /<endpoint>/<id>/ */
  async get<T>(endpoint: string, id: number | string): Promise<T> {
    const response = await this.request((authorization) =>
      this.http.get(`/${endpoint}/${id}/`, { headers: { Authorization: authorization } }),
    );
    return response.data as T;
  }

  /** POST /<endpoint>/ with a JSON body. */
  async create<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.request((authorization) =>
      this.http.post(`/${endpoint}/`, cleanParams(body), {
        headers: { Authorization: authorization },
      }),
    );
    return response.data as T;
  }

  /** PATCH /<endpoint>/<id>/ with a JSON body. */
  async update<T>(
    endpoint: string,
    id: number | string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.request((authorization) =>
      this.http.patch(`/${endpoint}/${id}/`, cleanParams(body), {
        headers: { Authorization: authorization },
      }),
    );
    return response.data as T;
  }

  /** DELETE /<endpoint>/<id>/ */
  async del(endpoint: string, id: number | string): Promise<void> {
    await this.request((authorization) =>
      this.http.delete(`/${endpoint}/${id}/`, {
        headers: { Authorization: authorization },
      }),
    );
  }

  /** Native collection writes. These calls are deliberately one-shot: no automatic retry. */
  async collectionAction<T>(
    endpoint: string,
    method: CollectionActionMethod,
    body: Record<string, unknown>[],
  ): Promise<T> {
    const response = await this.request((authorization) => {
      const path = `/${endpoint}/`;
      const config = { headers: { Authorization: authorization } };
      if (method === "post") return this.http.post(path, body, config);
      if (method === "patch") return this.http.patch(path, body, config);
      return this.http.delete(path, { ...config, data: body });
    });
    return response.data as T;
  }

  /** Native, closed semantic detail actions. */
  async detailAction<T>(
    endpoint: string,
    id: number,
    action: DetailAction,
    method: "get" | "post",
    body: unknown = [],
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const path = `/${endpoint}/${id}/${action}/`;
    const response = await this.request((authorization) =>
      method === "get"
        ? this.http.get(path, {
            params: cleanParams(params),
            headers: { Authorization: authorization },
          })
        : this.http.post(path, body, {
            headers: { Authorization: authorization },
          }),
    );
    return response.data as T;
  }

  /** GET /<path>/ with raw query params. Used for global search. */
  async raw<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await this.request((authorization) =>
      this.http.get(path.startsWith("/") ? path : `/${path}`, {
        params: cleanParams(params),
        headers: { Authorization: authorization },
      }),
    );
    return response.data as T;
  }

  /**
   * Keep a credential and its redactor together for exactly one request. The
   * resulting error is already safe text, so tools never receive credentials
   * or redaction capabilities.
   */
  private async request<T>(
    send: (authorization: string) => Promise<AxiosResponse<T>>,
  ): Promise<AxiosResponse<T>> {
    const token = await this.config.credentials.getToken();
    try {
      const response = await send(netBoxAuthorization(token));
      if (response.status >= 400) throw axiosLikeError(response);
      return response;
    } catch (error) {
      // Do not retain the original Axios error as a cause: an inspector can
      // log its response body or request config. The returned Error contains
      // only text redacted while this request's credential was in scope.
      throw redactedRequestError(handleApiError(error, createCredentialRedactor(token)));
    }
  }
}

/**
 * Drop undefined / null / "" params. Arrays are preserved and serialised by
 * `repeatParams` below.
 */
/**
 * Serialise params the way NetBox's filters expect: a repeated key per value,
 * never an indexed or bracketed form.
 */
export function repeatParams(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = paramValue(item);
        if (text !== undefined) search.append(key, text);
      }
    } else {
      const text = paramValue(value);
      if (text !== undefined) search.append(key, text);
    }
  }
  return search.toString();
}

/**
 * A query parameter is a scalar. Anything else — an object, a nested array, a
 * symbol — has no meaningful query-string form, and `String()` would turn it
 * into "[object Object]" and send that to NetBox as a filter value. Drop it
 * instead of transmitting nonsense; the caller's filter names are already
 * validated against the instance's own parameter list upstream of here.
 */
function paramValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return undefined;
}

/** Remove the request credential unless the redirect target is exactly the API origin. */
function stripAuthorizationOnCrossOriginRedirect(
  options: Record<string, unknown>,
  apiOrigin: string,
): void {
  const headers = options.headers;
  const target = options.href;
  const isSameOrigin =
    typeof target === "string" &&
    (() => {
      try {
        return new URL(target).origin === apiOrigin;
      } catch {
        return false;
      }
    })();
  if (isSameOrigin || !headers || typeof headers !== "object") return;

  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "authorization") {
      delete (headers as Record<string, unknown>)[name];
    }
  }
}

function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Shape a 4xx response as an AxiosError-like so `handleApiError` can use the
 * same logic as network errors.
 */
function axiosLikeError(response: { status: number; data: unknown }): Error {
  const err = new axios.AxiosError(
    `Request failed with status code ${response.status}`,
    String(response.status),
  );
  err.response = response as NonNullable<AxiosError["response"]>;
  return err;
}

/** Construct a safe error without retaining an Axios error as its cause. */
function redactedRequestError(message: string): Error {
  return new Error(message);
}

/** Build an isolated client for one server instance or test. */
export function createNetBoxClient(
  config: NetBoxConfig,
  options?: NetBoxClientOptions,
): NetBoxApi {
  return new NetBoxClient(config, options);
}

/**
 * Legacy process-global adapter for direct tool registration and existing
 * consumers. Server construction uses `createNetBoxClient` instead, so hosted
 * transports can supply isolated credentials without sharing this cache.
 */
export function getClient(): NetBoxClient {
  if (!cachedClient) {
    cachedClient = new NetBoxClient(loadConfig());
  }
  return cachedClient;
}

/** Reset the cached client; mainly useful for tests. */
export function resetClient(): void {
  cachedClient = null;
}
