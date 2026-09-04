/**
 * The `SchemaProvider` implementation — the only thing `src/tools/` sees.
 *
 * Laziness lives here: the registry is derived on first use and the loader is
 * not touched before that. Nothing on this surface exposes the OpenAPI
 * document, and nothing may be added that does.
 */

import type { NetBoxConfig } from "../config.js";
import { describeObjectType, suggestObjectTypes } from "./describe.js";
import {
  createSchemaLoader,
  type SchemaLoader,
  type SchemaLoaderOptions,
} from "./loader.js";
import {
  deref,
  jsonRequestSchema,
  jsonResponseSchema,
  type JsonSchemaNode,
  type OpenApiDocument,
  type OperationObject,
  type ParameterObject,
} from "./openapi.js";
import { buildRegistry, type RegistryEntry, type SchemaRegistry } from "./registry.js";
import {
  type BulkOperation,
  type BulkOperationContract,
  type DescribeResult,
  type DetailActionContract,
  type DetailActionMethod,
  type DetailActionName,
  type DetailActionSchema,
  type ListObjectTypesFilter,
  type ObjectTypeKey,
  type ObjectTypeSummary,
  type Operation,
  type SchemaProvider,
  UnknownObjectTypeError,
  UnsupportedOperationError,
} from "./types.js";

function matchesFilter(
  summary: ObjectTypeSummary,
  filter: ListObjectTypesFilter,
): boolean {
  if (filter.app !== undefined && filter.app.length > 0) {
    if (summary.app.toLowerCase() !== filter.app.toLowerCase()) return false;
  }
  const query = filter.query?.trim().toLowerCase();
  if (query !== undefined && query.length > 0) {
    const haystack =
      `${summary.object_type} ${summary.label} ${summary.summary} ${summary.endpoint}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

/** Build a provider over an already-parsed document. Used by tests and warm starts. */
export function createSchemaProviderFromDocument(
  document: OpenApiDocument,
): SchemaProvider {
  return providerFromRegistry(() => Promise.resolve(buildRegistry(document)));
}

export interface SchemaProviderOptions extends SchemaLoaderOptions {
  loader?: SchemaLoader;
}

/** Build a provider that fetches the connected instance's schema on first use. */
export function createSchemaProvider(options: SchemaProviderOptions): SchemaProvider {
  const loader = options.loader ?? createSchemaLoader(options);
  let registry: Promise<SchemaRegistry> | undefined;
  return providerFromRegistry(() => {
    if (!registry) {
      registry = loader
        .load()
        .then((loaded) => {
          const derived = buildRegistry(loaded.document);
          // `/api/status/` is authoritative for the version; `info.version`
          // is the fallback the document itself carries.
          return loaded.version === "unknown"
            ? derived
            : { ...derived, version: loaded.version };
        })
        .catch((error: unknown) => {
          registry = undefined;
          throw error;
        });
    }
    return registry;
  });
}

/** Convenience for the server wiring: config in, provider out. */
export function createSchemaProviderForConfig(config: NetBoxConfig): SchemaProvider {
  return createSchemaProvider({ config });
}

function schemaMetadata(
  document: OpenApiDocument,
  node: JsonSchemaNode | undefined,
  depth = 0,
): DetailActionSchema | undefined {
  const resolved = deref(document, node);
  if (!resolved || depth >= 8) return undefined;
  const properties = resolved.properties
    ? Object.fromEntries(
        Object.entries(resolved.properties).flatMap(([name, property]) => {
          const metadata = schemaMetadata(document, property, depth + 1);
          return metadata ? [[name, metadata]] : [];
        }),
      )
    : undefined;
  const items = schemaMetadata(document, resolved.items, depth + 1);
  const additionalProperties =
    typeof resolved.additionalProperties === "object"
      ? schemaMetadata(document, resolved.additionalProperties, depth + 1)
      : resolved.additionalProperties;
  const oneOf = resolved.oneOf
    ?.map((member) => schemaMetadata(document, member, depth + 1))
    .filter((member): member is DetailActionSchema => member !== undefined);
  const anyOf = resolved.anyOf
    ?.map((member) => schemaMetadata(document, member, depth + 1))
    .filter((member): member is DetailActionSchema => member !== undefined);
  const allOf = resolved.allOf
    ?.map((member) => schemaMetadata(document, member, depth + 1))
    .filter((member): member is DetailActionSchema => member !== undefined);
  return {
    ...(resolved.type ? { type: resolved.type } : {}),
    ...(resolved.format ? { format: resolved.format } : {}),
    ...(resolved.description ? { description: resolved.description } : {}),
    ...(resolved.nullable ? { nullable: true } : {}),
    ...(resolved.readOnly ? { readOnly: true } : {}),
    ...(resolved.enum ? { enum: [...resolved.enum] } : {}),
    ...(resolved.default !== undefined ? { default: resolved.default } : {}),
    ...(resolved.minimum !== undefined ? { minimum: resolved.minimum } : {}),
    ...(resolved.maximum !== undefined ? { maximum: resolved.maximum } : {}),
    ...(resolved.minLength !== undefined ? { minLength: resolved.minLength } : {}),
    ...(resolved.maxLength !== undefined ? { maxLength: resolved.maxLength } : {}),
    ...(properties ? { properties } : {}),
    ...(resolved.required ? { required: [...resolved.required] } : {}),
    ...(items ? { items } : {}),
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
    ...(oneOf && oneOf.length > 0 ? { oneOf } : {}),
    ...(anyOf && anyOf.length > 0 ? { anyOf } : {}),
    ...(allOf && allOf.length > 0 ? { allOf } : {}),
  };
}

function arrayRequestSchema(
  document: OpenApiDocument,
  node: JsonSchemaNode | undefined,
  depth = 0,
): JsonSchemaNode | undefined {
  const resolved = deref(document, node);
  if (!resolved || depth >= 8) return undefined;
  if (resolved.type === "array" || resolved.items !== undefined) return resolved;
  for (const member of [...(resolved.oneOf ?? []), ...(resolved.anyOf ?? [])]) {
    const array = arrayRequestSchema(document, member, depth + 1);
    if (array) return array;
  }
  return undefined;
}

function bulkContract(
  document: OpenApiDocument,
  operation: OperationObject | undefined,
  method: BulkOperationContract["method"],
  status: string,
): BulkOperationContract | undefined {
  if (!operation || operation.requestBody?.required !== true) return undefined;
  const request = arrayRequestSchema(document, jsonRequestSchema(operation));
  if (!request?.items) return undefined;
  const requestSchema = schemaMetadata(document, request);
  const response = operation.responses?.[status];
  if (!requestSchema || !response) return undefined;
  const responseSchema = schemaMetadata(
    document,
    response.content?.["application/json"]?.schema,
  );
  if (method === "delete") {
    // NetBox's bulk destroy is contractually 204 with no response body.
    return responseSchema
      ? undefined
      : {
          method,
          request_schema: requestSchema,
          response_content: "none",
        };
  }
  return responseSchema
    ? {
        method,
        request_schema: requestSchema,
        response_content: "json",
        response_schema: responseSchema,
      }
    : undefined;
}

function collectionBulkContract(
  document: OpenApiDocument,
  entry: RegistryEntry,
  operation: BulkOperation,
): BulkOperationContract | undefined {
  // The registry owns collectionPath, so this does not infer a URL from a caller value.
  if (operation === "bulk_create")
    return bulkContract(document, entry.collection.post, "post", "201");
  if (operation === "bulk_update")
    return bulkContract(document, entry.collection.patch, "patch", "200");
  return bulkContract(document, entry.collection.delete, "delete", "204");
}

function actionContract(
  document: OpenApiDocument,
  operation: OperationObject | undefined,
  pathParameters: ParameterObject[] = [],
): DetailActionContract | undefined {
  if (!operation) return undefined;
  const parameters = [...pathParameters, ...(operation.parameters ?? [])];
  // Operation parameters override path-item parameters with the same name/in.
  const pathId = [...parameters]
    .reverse()
    .find((parameter) => parameter.in === "path" && parameter.name === "id");
  const pathIdSchema = schemaMetadata(document, pathId?.schema);
  const queryParameters = parameters.filter(
    (parameter) => parameter.in === "query" && Boolean(parameter.name),
  );
  const queryProperties = Object.fromEntries(
    queryParameters.flatMap((parameter) => {
      const metadata = schemaMetadata(document, parameter.schema);
      return metadata && parameter.name ? [[parameter.name, metadata]] : [];
    }),
  );
  const requiredQueryParameters = queryParameters.flatMap((parameter) =>
    parameter.required && parameter.name ? [parameter.name] : [],
  );
  const requestSchema = schemaMetadata(document, jsonRequestSchema(operation));
  const responseSchema = schemaMetadata(document, jsonResponseSchema(operation));
  return {
    ...(pathId?.required === true && pathIdSchema?.type === "integer"
      ? { path_id_schema: pathIdSchema }
      : {}),
    query_schema: {
      type: "object",
      properties: queryProperties,
      ...(requiredQueryParameters.length > 0
        ? { required: requiredQueryParameters }
        : {}),
      additionalProperties: false,
    },
    request_content: operation.requestBody
      ? requestSchema
        ? "json"
        : "non-json"
      : "none",
    request_required: operation.requestBody?.required === true,
    ...(requestSchema ? { request_schema: requestSchema } : {}),
    ...(responseSchema ? { response_schema: responseSchema } : {}),
  };
}

function providerFromRegistry(
  getRegistry: () => Promise<SchemaRegistry>,
): SchemaProvider {
  return {
    async version(): Promise<string> {
      return (await getRegistry()).version;
    },

    async listObjectTypes(
      filter: ListObjectTypesFilter = {},
    ): Promise<ObjectTypeSummary[]> {
      const registry = await getRegistry();
      return [...registry.types.values()]
        .map((entry) => entry.summary)
        .filter((summary) => matchesFilter(summary, filter))
        .sort((a, b) => a.object_type.localeCompare(b.object_type));
    },

    async resolve(objectType: ObjectTypeKey): Promise<ObjectTypeSummary | undefined> {
      const registry = await getRegistry();
      return registry.types.get(objectType)?.summary;
    },

    async describe(
      objectType: ObjectTypeKey,
      operation: Operation,
    ): Promise<DescribeResult> {
      const registry = await getRegistry();
      const entry = registry.types.get(objectType);
      if (!entry) {
        throw new UnknownObjectTypeError(
          objectType,
          suggestObjectTypes(registry, objectType),
        );
      }
      if (!entry.summary.operations.includes(operation)) {
        throw new UnsupportedOperationError(
          objectType,
          operation,
          entry.summary.operations,
        );
      }
      return describeObjectType(registry, entry, operation);
    },

    async bulkOperationContract(
      objectType: ObjectTypeKey,
      operation: BulkOperation,
    ): Promise<BulkOperationContract | undefined> {
      const registry = await getRegistry();
      const entry = registry.types.get(objectType);
      if (!entry) return undefined;
      return collectionBulkContract(registry.document, entry, operation);
    },

    async supportsDetailAction(
      objectType: ObjectTypeKey,
      action: DetailActionName,
      method: DetailActionMethod,
    ): Promise<boolean> {
      const registry = await getRegistry();
      const entry = registry.types.get(objectType);
      if (!entry) return false;
      // Construct from the schema-derived detail path, rather than accepting a
      // path from a caller or inferring an endpoint from a model name.
      const path = `${entry.detailPath.replace(/\/$/, "")}/${action}/`;
      return registry.document.paths?.[path]?.[method] !== undefined;
    },

    async detailActionContract(
      objectType: ObjectTypeKey,
      action: DetailActionName,
      method: DetailActionMethod,
    ): Promise<DetailActionContract | undefined> {
      const registry = await getRegistry();
      const entry = registry.types.get(objectType);
      if (!entry) return undefined;
      const path = `${entry.detailPath.replace(/\/$/, "")}/${action}/`;
      const pathItem = registry.document.paths?.[path];
      return actionContract(registry.document, pathItem?.[method], pathItem?.parameters);
    },
  };
}
