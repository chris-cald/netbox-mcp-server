/**
 * Closed semantic-action registry for native IPAM prefix availability APIs.
 *
 * The registry names the only semantic operations this server understands. Its
 * envelopes and metadata are constructed from the connected instance's OpenAPI
 * contract; a method/path match alone never makes an action available.
 */

import { z } from "zod";

import type {
  DetailActionContract,
  DetailActionMethod,
  DetailActionSchema,
  SchemaProvider,
} from "../schema/types.js";

export type ActionAccess = "read" | "write";
export type PrefixActionName = "ipam.prefix.available_ips" | "ipam.prefix.allocate_ip";

const integerId = z.number().int().positive();
const objectInput = z.record(z.string(), z.unknown());

/** M3a deliberately supports only the native contracts verified for NetBox 4.6.x. */
const SUPPORTED_ACTION_VERSION = /^4\.6\.\d+$/;
/** Allocation is one native request item; bulk writes belong in netbox_write. */
export const MAX_ALLOCATION_ITEMS = 1;
/** Keep a single allocation request within the server's 25 KiB response budget. */
export const MAX_ALLOCATION_PAYLOAD_BYTES = 25 * 1024;

interface PrefixActionDefinition {
  name: PrefixActionName;
  target_resource_type: "ipam.prefix";
  classification: { access: ActionAccess; destructive: false };
  description: string;
  native: { action: "available-ips"; method: DetailActionMethod };
  envelope: "query" | "data";
}

export interface SemanticActionMetadata {
  name: PrefixActionName;
  target_resource_type: "ipam.prefix";
  classification: { access: ActionAccess; destructive: false };
  description: string;
  native: { action: "available-ips"; method: DetailActionMethod };
  /** The only accepted tool input envelope, derived from the native contract. */
  input_schema: DetailActionSchema;
  /** The native JSON response schema from the connected instance. */
  output_schema: DetailActionSchema;
}

export interface CompactSemanticActionMetadata {
  name: PrefixActionName;
  target_resource_type: "ipam.prefix";
  classification: { access: ActionAccess; destructive: false };
  native: { action: "available-ips"; method: DetailActionMethod };
  metadata_truncated: true;
}

export type AdvertisedSemanticActionMetadata =
  SemanticActionMetadata | CompactSemanticActionMetadata;

export interface ApplicablePrefixAction {
  definition: PrefixActionDefinition;
  contract: DetailActionContract;
  metadata: SemanticActionMetadata;
}

/** Bound all schema-derived action metadata before it enters a tool payload. */
const MAX_SEMANTIC_ACTION_METADATA_CHARS = 8_000;

function compactSemanticActionMetadata(
  action: SemanticActionMetadata,
): CompactSemanticActionMetadata {
  return {
    name: action.name,
    target_resource_type: action.target_resource_type,
    classification: action.classification,
    native: action.native,
    metadata_truncated: true,
  };
}

/**
 * Full action schemas are useful until an instance's custom schema makes them
 * dominate a discovery or description response. Retain only the closed action
 * identity in that case; invocation still re-derives and validates the full
 * contract rather than trusting advertised metadata.
 */
export function boundedSemanticActionMetadata(actions: SemanticActionMetadata[]): {
  actions: AdvertisedSemanticActionMetadata[];
  truncated: boolean;
} {
  try {
    if (JSON.stringify(actions).length <= MAX_SEMANTIC_ACTION_METADATA_CHARS) {
      return { actions, truncated: false };
    }
  } catch {
    // Schema metadata is derived JSON, but fail closed if an unusual provider
    // returns an unserializable value rather than sending it to the client.
  }
  return { actions: actions.map(compactSemanticActionMetadata), truncated: true };
}

const definitions: readonly PrefixActionDefinition[] = Object.freeze([
  {
    name: "ipam.prefix.available_ips",
    target_resource_type: "ipam.prefix",
    classification: { access: "read", destructive: false },
    description: "List native available IP addresses within this prefix.",
    native: { action: "available-ips", method: "get" },
    envelope: "query",
  },
  {
    name: "ipam.prefix.allocate_ip",
    target_resource_type: "ipam.prefix",
    classification: { access: "write", destructive: false },
    description:
      "Allocate IP addresses through NetBox's native availability endpoint exactly once; allocations are never retried.",
    native: { action: "available-ips", method: "post" },
    envelope: "data",
  },
]);

export function prefixAction(name: string): PrefixActionDefinition | undefined {
  return definitions.find((action) => action.name === name);
}

export const InvokeInput = z
  .object({
    operation: z.enum(["ipam.prefix.available_ips", "ipam.prefix.allocate_ip"]),
    target: integerId.describe("Numeric id of the target ipam.prefix object."),
    input: objectInput.default({}),
  })
  .strict();

function actionIsCompatible(
  action: PrefixActionDefinition,
  contract: DetailActionContract | undefined,
): contract is DetailActionContract & { response_schema: DetailActionSchema } {
  if (
    !contract?.path_id_schema ||
    contract.path_id_schema.type !== "integer" ||
    !contract.response_schema ||
    contract.response_schema.type !== "array" ||
    contract.response_schema.items?.type !== "object"
  )
    return false;
  // A read action accepts query parameters only: an undocumented body, whether
  // JSON or not, is a different contract and is never sent by this tool.
  if (action.envelope === "query") return contract.request_content === "none";
  return (
    contract.request_content === "json" &&
    contract.request_required &&
    // The allocation envelope contains only `data`; required query parameters
    // would be omitted, so this is not a contract the action can invoke.
    !contract.query_schema.required?.length &&
    contract.request_schema?.type === "array" &&
    contract.request_schema.items?.type === "object" &&
    contract.response_schema.type === "array"
  );
}

export function supportsPrefixActionVersion(version: string): boolean {
  return SUPPORTED_ACTION_VERSION.test(version);
}

export function prefixActionVersionError(version: string): string {
  return (
    `Controlled prefix actions require a schema from NetBox 4.6.x (>=4.6.0, <4.7.0); ` +
    `this instance reports "${version}". The action was not sent.`
  );
}

function inputSchema(
  action: PrefixActionDefinition,
  contract: DetailActionContract,
): DetailActionSchema {
  if (action.envelope === "query") {
    return {
      type: "object",
      additionalProperties: false,
      properties: { query: contract.query_schema },
    };
  }
  return {
    type: "object",
    required: ["data"],
    additionalProperties: false,
    properties: { data: contract.request_schema ?? {} },
  };
}

function actionMetadata(
  action: PrefixActionDefinition,
  contract: DetailActionContract & { response_schema: DetailActionSchema },
): SemanticActionMetadata {
  return {
    name: action.name,
    target_resource_type: action.target_resource_type,
    classification: action.classification,
    description: action.description,
    native: action.native,
    input_schema: inputSchema(action, contract),
    output_schema: contract.response_schema,
  };
}

/** Return one action only when its full request/query/response shape is proven. */
export async function applicablePrefixAction(
  schema: SchemaProvider,
  action: PrefixActionDefinition,
  version?: string,
): Promise<ApplicablePrefixAction | undefined> {
  const actionVersion = version ?? (await schema.version());
  if (!supportsPrefixActionVersion(actionVersion)) return undefined;
  const contract = await schema.detailActionContract?.(
    action.target_resource_type,
    action.native.action,
    action.native.method,
  );
  if (!actionIsCompatible(action, contract)) return undefined;
  return { definition: action, contract, metadata: actionMetadata(action, contract) };
}

/** Return only semantic actions whose full native contract is proven by this instance. */
export async function applicablePrefixActions(
  schema: SchemaProvider,
  objectType: string,
): Promise<SemanticActionMetadata[]> {
  if (objectType !== "ipam.prefix") return [];
  const version = await schema.version();
  if (!supportsPrefixActionVersion(version)) return [];
  const applicable = await Promise.all(
    definitions.map((action) => applicablePrefixAction(schema, action, version)),
  );
  return applicable.flatMap((action) => (action ? [action.metadata] : []));
}

/**
 * Validate the dynamic envelope against a schema-derived contract. This small,
 * strict validator covers every schema feature emitted in action metadata that
 * affects request shape; NetBox remains the authority for semantic validation.
 */
function schemaError(
  schema: DetailActionSchema,
  value: unknown,
  path: string,
): string | undefined {
  if (value === null && schema.nullable) return undefined;
  for (const member of schema.allOf ?? []) {
    const error = schemaError(member, value, path);
    if (error) return error;
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives && !alternatives.some((member) => !schemaError(member, value, path))) {
    return `${path} does not match an accepted shape`;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    for (const [index, item] of value.entries()) {
      const error = schema.items && schemaError(schema.items, item, `${path}[${index}]`);
      if (error) return error;
    }
  } else if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `${path} must be an object`;
    }
    const object = value as Record<string, unknown>;
    for (const field of schema.required ?? []) {
      if (!(field in object)) return `${path}.${field} is required`;
    }
    if (schema.additionalProperties === false) {
      for (const field of Object.keys(object)) {
        if (!Object.hasOwn(schema.properties ?? {}, field)) {
          return `${path} contains an unsupported field`;
        }
      }
    }
    for (const [field, child] of Object.entries(schema.properties ?? {})) {
      if (!(field in object)) continue;
      const error = schemaError(child, object[field], `${path}.${field}`);
      if (error) return error;
    }
  } else if (schema.type && typeof value !== schema.type) {
    // OpenAPI's integer/number are both JavaScript numbers, with integer being
    // the only extra constraint relevant to an action request.
    if (
      schema.type !== "integer" ||
      typeof value !== "number" ||
      !Number.isInteger(value)
    ) {
      return `${path} must be a ${schema.type}`;
    }
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    return `${path} must be an allowed value`;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      return `${path} is too short`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return `${path} is too long`;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      return `${path} is too small`;
    if (schema.maximum !== undefined && value > schema.maximum)
      return `${path} is too large`;
  }
  return undefined;
}

export function requestForAction(
  action: ApplicablePrefixAction,
  input: Record<string, unknown>,
): { body?: unknown; params?: Record<string, unknown> } {
  const allowed = action.definition.envelope === "query" ? ["query"] : ["data"];
  const unexpected = Object.keys(input).some((key) => !allowed.includes(key));
  if (unexpected)
    throw new Error(
      `Invalid input for "${action.definition.name}": input contains an unsupported field.`,
    );

  if (action.definition.envelope === "query") {
    const query = input.query ?? {};
    const error = schemaError(action.contract.query_schema, query, "query");
    if (error)
      throw new Error(`Invalid input for "${action.definition.name}": ${error}.`);
    return { params: query as Record<string, unknown> };
  }

  if (!("data" in input))
    throw new Error(`Invalid input for "${action.definition.name}": data is required.`);
  const error = schemaError(action.contract.request_schema ?? {}, input.data, "data");
  if (error) throw new Error(`Invalid input for "${action.definition.name}": ${error}.`);

  // Deliberately do not expose bulk allocation through the availability endpoint.
  // One array item maps to one allocation; callers needing multiple ordinary
  // records should use netbox_write with an explicit, reviewable sequence.
  if (!Array.isArray(input.data) || input.data.length !== MAX_ALLOCATION_ITEMS) {
    throw new Error(
      `Invalid input for "${action.definition.name}": data must contain exactly one item.`,
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input.data);
  } catch {
    throw new Error(
      `Invalid input for "${action.definition.name}": data must be JSON-serializable.`,
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_ALLOCATION_PAYLOAD_BYTES) {
    throw new Error(
      `Invalid input for "${action.definition.name}": serialized data exceeds the 25 KiB limit.`,
    );
  }
  return { body: input.data };
}

/** Validate the entire native response, including every item and required field. */
export function validateActionResponse(
  action: ApplicablePrefixAction,
  response: unknown,
): unknown[] {
  const responseSchema = action.contract.response_schema;
  if (!responseSchema) {
    throw new Error("The schema-confirmed action response contract is unavailable.");
  }
  const error = schemaError(responseSchema, response, "response");
  if (error) {
    throw new Error(
      `NetBox returned a response that does not match the schema-confirmed result: ${error}.`,
    );
  }
  // `actionIsCompatible` proves the response is an array, and schemaError
  // confirms it. Keep this guard to make the boundary explicit at runtime.
  if (!Array.isArray(response)) {
    throw new Error(
      "NetBox returned a response that does not match the schema-confirmed array result.",
    );
  }
  return response;
}
