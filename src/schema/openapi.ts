/**
 * Minimal structural types for the slice of OpenAPI 3.0 that NetBox emits,
 * plus the `$ref` walking helpers the derivation depends on.
 *
 * This module is deliberately structural rather than validating: the document
 * is 6-13 MB of generated JSON and running a validator over it would cost more
 * than the derivation it feeds. Every accessor below is total — a missing or
 * unexpected node yields `undefined`, never a throw — because the one thing
 * this layer must not do is fail the whole registry over one odd path item.
 *
 * Nothing in here is ever returned to a caller. See `loader.ts`.
 */

/** A JSON Schema node as drf-spectacular emits it. */
export interface JsonSchemaNode {
  $ref?: string;
  type?: string;
  format?: string;
  title?: string;
  description?: string;
  nullable?: boolean;
  readOnly?: boolean;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, JsonSchemaNode | undefined>;
  required?: string[];
  items?: JsonSchemaNode;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  additionalProperties?: JsonSchemaNode | boolean;
  maxLength?: number;
  minLength?: number;
  maximum?: number;
  minimum?: number;
}

export interface ParameterObject {
  in?: string;
  name?: string;
  description?: string;
  required?: boolean;
  schema?: JsonSchemaNode;
}

export interface MediaTypeObject {
  schema?: JsonSchemaNode;
}

export interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, MediaTypeObject | undefined>;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject | undefined>;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject | undefined>;
}

export interface PathItemObject {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  parameters?: ParameterObject[];
}

export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItemObject | undefined>;
  components?: { schemas?: Record<string, JsonSchemaNode | undefined> };
}

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

const JSON_MEDIA_TYPE = "application/json";
const MAX_REF_DEPTH = 8;

/** True when the parsed value is plausibly a NetBox OpenAPI document. */
export function isOpenApiDocument(value: unknown): value is OpenApiDocument {
  if (typeof value !== "object" || value === null) return false;
  const paths = (value as { paths?: unknown }).paths;
  return typeof paths === "object" && paths !== null;
}

/** `#/components/schemas/BriefSite` -> `BriefSite`. */
export function refName(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const slash = ref.lastIndexOf("/");
  const name = slash === -1 ? ref : ref.slice(slash + 1);
  return name.length > 0 ? name : undefined;
}

export function getComponent(
  doc: OpenApiDocument,
  name: string | undefined,
): JsonSchemaNode | undefined {
  if (!name) return undefined;
  return doc.components?.schemas?.[name];
}

/**
 * Follow a `$ref` chain to the node it names. Bounded, so a self-referential
 * component cannot hang the server.
 */
export function deref(
  doc: OpenApiDocument,
  node: JsonSchemaNode | undefined,
  depth = 0,
): JsonSchemaNode | undefined {
  if (!node) return undefined;
  if (!node.$ref) return node;
  if (depth >= MAX_REF_DEPTH) return undefined;
  return deref(doc, getComponent(doc, refName(node.$ref)), depth + 1);
}

/**
 * Collapse the `oneOf: [single, array]` wrapper NetBox >= 4.4 puts on every
 * collection POST body down to the single-object member.
 *
 * Idempotent by design: the detail PUT body is a bare `$ref` and must survive
 * this unchanged (derivation doc §3.1).
 */
export function unwrapSingleForm(
  node: JsonSchemaNode | undefined,
  depth = 0,
): JsonSchemaNode | undefined {
  if (!node) return undefined;
  if (depth >= MAX_REF_DEPTH) return node;
  const first = node.oneOf?.[0];
  if (first) return unwrapSingleForm(first, depth + 1);
  return node;
}

/** The `application/json` schema of a request body, if there is one. */
export function jsonRequestSchema(
  operation: OperationObject | undefined,
): JsonSchemaNode | undefined {
  return operation?.requestBody?.content?.[JSON_MEDIA_TYPE]?.schema;
}

/** The `application/json` schema of the 200/201 response, if there is one. */
export function jsonResponseSchema(
  operation: OperationObject | undefined,
): JsonSchemaNode | undefined {
  const responses = operation?.responses;
  if (!responses) return undefined;
  for (const status of ["200", "201"]) {
    const schema = responses[status]?.content?.[JSON_MEDIA_TYPE]?.schema;
    if (schema) return schema;
  }
  return undefined;
}

/**
 * The component name a request body resolves to, after unwrapping the
 * single-or-array `oneOf`.
 *
 * Returns `undefined` rather than guessing — `/api/extras/scripts/` has a POST
 * with no `application/json` content at all, and a missing write schema means
 * "create is not describable", not "fall back to a name lookup".
 */
export function requestSchemaName(
  operation: OperationObject | undefined,
): string | undefined {
  return refName(unwrapSingleForm(jsonRequestSchema(operation))?.$ref);
}

export function responseSchemaName(
  operation: OperationObject | undefined,
): string | undefined {
  return refName(jsonResponseSchema(operation)?.$ref);
}

/** How a write operation on a *collection* path treats its request body. */
export type CollectionWriteKind = "bulk" | "singleton" | "none";

/**
 * Distinguish a bulk operation from a singleton one by the SHAPE OF THE
 * REQUEST BODY, never by the HTTP method.
 *
 * `PUT /api/dcim/sites/` takes an array (bulk update); `PUT /api/extras/dashboard/`
 * takes a single `DashboardRequest` (the caller's own dashboard). Both are a
 * PUT on a 3-segment collection path, so method-based detection is wrong in
 * both directions (derivation doc §2.4).
 */
export function classifyCollectionWrite(
  operation: OperationObject | undefined,
): CollectionWriteKind {
  const schema = jsonRequestSchema(operation);
  if (!schema) return "none";
  if (schema.type === "array" || schema.items !== undefined) return "bulk";
  // A `oneOf: [single, array]` POST body documents both forms on one endpoint;
  // the single form is what a single-object verb maps to.
  return "singleton";
}
