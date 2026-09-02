/**
 * The contract between the schema layer and the tool layer.
 *
 * This file is the seam. `src/schema/` produces a `SchemaProvider` from a
 * NetBox OpenAPI document; `src/tools/` consumes one and knows nothing about
 * OpenAPI. Neither side may reach past it.
 *
 * Everything here is derived at runtime from the connected instance's own
 * `/api/schema/`, which is what makes the layered design defensible: the
 * planning layer cannot drift from the instance the way a hand-written tool
 * schema can. See `docs/reference/netbox-schema-derivation.md` for the rules
 * and, more importantly, for the four assumptions that turned out to be wrong.
 */

/** Stable identifier for a NetBox object type, e.g. `dcim.device`. */
export type ObjectTypeKey = string;

export type Operation = "list" | "get" | "create" | "update" | "delete";

/** Schema-confirmed native detail actions available to the semantic action layer. */
export type DetailActionName = "available-ips" | "available-prefixes";
export type DetailActionMethod = "get" | "post";

/** A JSON-schema-shaped value made safe to advertise as action metadata. */
export interface DetailActionSchema {
  type?: string | undefined;
  format?: string | undefined;
  description?: string | undefined;
  nullable?: boolean | undefined;
  enum?: unknown[] | undefined;
  default?: unknown;
  minimum?: number | undefined;
  maximum?: number | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  properties?: Record<string, DetailActionSchema> | undefined;
  required?: string[] | undefined;
  items?: DetailActionSchema | undefined;
  additionalProperties?: boolean | DetailActionSchema | undefined;
  oneOf?: DetailActionSchema[] | undefined;
  anyOf?: DetailActionSchema[] | undefined;
  allOf?: DetailActionSchema[] | undefined;
}

/**
 * The contract for one schema-confirmed native detail action.  It deliberately
 * contains only request/query/response shapes, not an endpoint path, so the
 * tool layer cannot turn it into arbitrary HTTP.
 */
export interface DetailActionContract {
  /** Required integer `{id}` path parameter that the tool maps from `target`. */
  path_id_schema?: DetailActionSchema | undefined;
  query_schema: DetailActionSchema;
  /** Whether the operation has no body, a JSON body, or only unsupported body media types. */
  request_content: "none" | "json" | "non-json";
  request_required: boolean;
  request_schema?: DetailActionSchema | undefined;
  response_schema?: DetailActionSchema | undefined;
}

export interface ObjectTypeSummary {
  /** e.g. `dcim.device` */
  object_type: ObjectTypeKey;
  /** Human label, e.g. "Device". */
  label: string;
  /** API endpoint with no leading or trailing slash, e.g. `dcim/devices`. */
  endpoint: string;
  /** App label, e.g. `dcim`. Plugins use `plugins/<plugin>`. */
  app: string;
  /**
   * Operations this type genuinely supports as a SINGLE-object action.
   *
   * Derived from a `post` on the collection plus a matching `/{id}/` detail
   * path — NOT from the set of HTTP methods present. 125 of 138 collection
   * paths carry bulk PUT/PATCH/DELETE, and advertising those as `update` or
   * `delete` would offer a single-object verb that acts on many.
   */
  operations: Operation[];
  /** One line, for the discovery layer. */
  summary: string;
}

export interface FieldSpec {
  name: string;
  type: "string" | "integer" | "number" | "boolean" | "array" | "object" | "unknown";
  required: boolean;
  readOnly: boolean;
  nullable?: boolean | undefined;
  description?: string | undefined;
  /** Exact allowed values, when the field is an enum. */
  enum?: string[] | undefined;
  /**
   * For a foreign key, the object type it points at — this is what tells an
   * agent that a site must exist before a device can be created.
   */
  refersTo?: ObjectTypeKey | undefined;
  /**
   * True when a bare integer primary key is accepted as well as an object.
   * NetBox expresses FKs as `oneOf: [integer, Brief<X>Request]`.
   */
  acceptsId?: boolean | undefined;
}

export interface FilterSpec {
  name: string;
  type: string;
  description?: string | undefined;
}

/**
 * One hand-encoded NetBox deprecation or removal.
 *
 * The single exception to "everything here is derived at runtime". NetBox
 * publishes no machine-readable deprecation signal, so this cannot be derived;
 * see `src/schema/deprecations.ts` for the full justification and the table.
 *
 * It is ADVISORY. Nothing built from a `Deprecation` refuses, rewrites or
 * gates a request — the API token's permissions remain the only authority over
 * what may be written.
 */
export interface Deprecation {
  /** What is deprecated: an object type key, or `<key>.<field>`. */
  readonly target: string;
  /**
   * The object type the note attaches to; for a field-level entry, the owning
   * type. Carried separately rather than parsed out of `target`: a plugin key
   * is `plugins.<plugin>.<model>`, so counting dots cannot tell a field target
   * from an object-type target.
   */
  readonly objectType: ObjectTypeKey;
  /** NetBox version that deprecated it, e.g. `4.3`. */
  readonly since: string;
  /**
   * Version it is removed in, or targeted for. Omitted when genuinely
   * unannounced. When it EQUALS `since` the thing was removed outright in that
   * release with no deprecation period — `dcim.module.local_context_data` went
   * in a patch release that way — and the note says "removed", not "deprecated".
   */
  readonly removedIn?: string | undefined;
  /** How certain `removedIn` is. NetBox is not always as definite as it sounds. */
  readonly removalCertainty?:
    "announced-in-docs" | "issue-only" | "unannounced" | undefined;
  /** What to do instead, concrete enough to act on without a second lookup. */
  readonly useInstead: string;
  /** Citation URL. */
  readonly source: string;
  /** True when the API accepts the call, answers 200, and silently does nothing. */
  readonly silentNoOp?: boolean | undefined;
  /**
   * Overrides the generated headline subject when `target` alone would mislead
   * — e.g. when only the write methods of an endpoint were removed and the
   * endpoint itself still serves reads.
   */
  readonly subject?: string | undefined;
}

export interface DescribeResult {
  object_type: ObjectTypeKey;
  operation: Operation;
  endpoint: string;
  /** Populated for create and update. Empty for list, get and delete. */
  fields: FieldSpec[];
  /**
   * Populated for list. SUMMARISED, not exhaustive: `dcim/devices` accepts
   * 342 query parameters and 72.5% of them are `__`-suffixed lookup variants.
   * Returning all of them is not usable by a model.
   */
  filters?: FilterSpec[] | undefined;
  /**
   * EVERY query-parameter name the instance declares for this list endpoint,
   * including the `__` lookup variants `filters` elides. Populated for list.
   *
   * Not for display — 342 names is exactly what the summary exists to avoid
   * showing. This is the set a filter name is VALIDATED against, which the
   * summary cannot be: `name__ic` is legitimate and is not in the summary.
   * A live NetBox 4.6.0 answers 200 and the UNFILTERED collection for a
   * parameter it does not recognise, so an unknown name has to be caught here
   * or not at all.
   */
  filterNames?: string[] | undefined;
  /** One sentence describing the `__` lookup-suffix grammar that was elided. */
  filterGrammar?: string | undefined;
  /** Object types that must exist before this one can be created. */
  dependsOn: ObjectTypeKey[];
  /** Anything the caller must know that the field list cannot express. */
  notes: string[];
  /**
   * NetBox deprecations that apply to this type and operation, if any.
   *
   * A machine-readable mirror of the deprecation entries in `notes`, which are
   * always present and always come FIRST — a caller that reads only the prose
   * loses nothing. Absent, not empty, when nothing applies.
   *
   * Advisory. Populating this never changes what a write is allowed to do.
   */
  deprecations?: Deprecation[] | undefined;
}

export interface ListObjectTypesFilter {
  /** Restrict to one app, e.g. `dcim`. */
  app?: string | undefined;
  /** Free-text match against object_type, label and summary. */
  query?: string | undefined;
}

/**
 * Everything the tool layer is allowed to know about the connected instance.
 *
 * Implementations must be lazy: a session that only lists devices should not
 * pay to fetch and parse a multi-megabyte schema document.
 */
export interface SchemaProvider {
  /** NetBox version the loaded document describes, e.g. "4.6.7". */
  version(): Promise<string>;

  listObjectTypes(filter?: ListObjectTypesFilter): Promise<ObjectTypeSummary[]>;

  /** Undefined when the key is not a known object type. */
  resolve(objectType: ObjectTypeKey): Promise<ObjectTypeSummary | undefined>;

  describe(objectType: ObjectTypeKey, operation: Operation): Promise<DescribeResult>;

  /**
   * Whether this instance's OpenAPI document exposes the exact native detail
   * action and method. Optional for third-party/test providers; callers must
   * treat an absent capability as unsupported.
   */
  supportsDetailAction?(
    this: void,
    objectType: ObjectTypeKey,
    action: DetailActionName,
    method: DetailActionMethod,
  ): Promise<boolean>;

  /**
   * Schema-derived request/query/response contract for a native detail action.
   * An absent contract is unsupported; method/path presence alone is unsafe.
   */
  detailActionContract?(
    this: void,
    objectType: ObjectTypeKey,
    action: DetailActionName,
    method: DetailActionMethod,
  ): Promise<DetailActionContract | undefined>;
}

/** Thrown when a caller names an object type that does not exist. */
export class UnknownObjectTypeError extends Error {
  constructor(
    readonly objectType: string,
    readonly suggestions: ObjectTypeKey[] = [],
  ) {
    const hint =
      suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(", ")}?`
        : " Call netbox_discover to list the object types this instance supports.";
    super(`Unknown object type "${objectType}".${hint}`);
    this.name = "UnknownObjectTypeError";
  }
}

/** Thrown when an operation is not supported for an object type. */
export class UnsupportedOperationError extends Error {
  constructor(
    readonly objectType: ObjectTypeKey,
    readonly operation: Operation,
    readonly supported: Operation[],
  ) {
    super(
      `Object type "${objectType}" does not support "${operation}". ` +
        `Supported: ${supported.join(", ") || "none"}.`,
    );
    this.name = "UnsupportedOperationError";
  }
}
