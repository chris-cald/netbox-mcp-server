/**
 * Local validation of a write payload against the layer-2 schema.
 *
 * The whole point is that a wrong `data` object never leaves the process. A
 * NetBox 400 costs a round-trip, tells the model only what NetBox chose to
 * echo, and — per RFC-003 S2 — echoes back whatever was submitted. Checking
 * here is cheaper, more specific, and cannot leak.
 */

import type {
  DescribeResult,
  DetailActionSchema,
  FieldSpec,
} from "../../schema/types.js";
import { writableFields } from "./shared.js";

export interface ValidationOutcome {
  ok: boolean;
  errors: string[];
}

/**
 * @param data      What the caller wants to send.
 * @param described The layer-2 description for this object type + operation.
 * @param mode      `create` enforces required fields; `update` is a PATCH and
 *                  deliberately does not — sending only the changed fields is
 *                  the correct way to use it.
 */
export function validateWriteData(
  data: Record<string, unknown>,
  described: DescribeResult,
  mode: "create" | "update",
): ValidationOutcome {
  const errors: string[] = [];
  const all = described.fields;
  const writable = writableFields(all);
  const byName = new Map(all.map((f) => [f.name, f]));
  const writableNames = writable.map((f) => f.name);

  for (const [key, value] of Object.entries(data)) {
    const field = byName.get(key);
    if (!field) {
      errors.push(
        `Unknown field \`${key}\`. This object type accepts: ${writableNames.join(", ") || "(no writable fields)"}.`,
      );
      continue;
    }
    if (field.readOnly) {
      errors.push(
        `Field \`${key}\` is read-only — NetBox computes it. Remove it from \`data\`.`,
      );
      continue;
    }
    errors.push(...checkValue(field, value));
  }

  if (mode === "create") {
    for (const field of writable) {
      if (!field.required) continue;
      const value = data[field.name];
      if (value === undefined || value === null || value === "") {
        errors.push(
          `Missing required field \`${field.name}\` (${field.type})` +
            (field.refersTo ? `, a reference to ${field.refersTo}` : "") +
            ".",
        );
      }
    }
  }

  if (mode === "update" && Object.keys(data).length === 0) {
    errors.push("`data` is empty — an update must name at least one field to change.");
  }

  return { ok: errors.length === 0, errors };
}

function checkValue(field: FieldSpec, value: unknown): string[] {
  if (value === null) {
    return field.nullable === false
      ? [`Field \`${field.name}\` is not nullable — omit it instead of sending null.`]
      : [];
  }

  if (field.enum && field.enum.length > 0) {
    if (typeof value !== "string" || !field.enum.includes(value)) {
      return [
        `Field \`${field.name}\` must be one of: ${field.enum.join(", ")}. ` +
          `Received ${describeValue(value)}.`,
      ];
    }
    return [];
  }

  switch (field.type) {
    case "string":
      return typeof value === "string" ? [] : [typeError(field, "a string", value)];
    case "integer":
      return isReference(field, value) ||
        (typeof value === "number" && Number.isInteger(value))
        ? []
        : [typeError(field, referenceHint(field) ?? "an integer", value)];
    case "number":
      return isReference(field, value) || typeof value === "number"
        ? []
        : [typeError(field, referenceHint(field) ?? "a number", value)];
    case "boolean":
      return typeof value === "boolean" ? [] : [typeError(field, "true or false", value)];
    case "array":
      return Array.isArray(value) ? [] : [typeError(field, "an array", value)];
    case "object":
      return typeof value === "object" && !Array.isArray(value)
        ? []
        : [typeError(field, "an object", value)];
    case "unknown":
      return [];
    default:
      return [];
  }
}

/**
 * NetBox writes a foreign key as `oneOf: [integer, Brief<X>Request]`, so an
 * object is as valid as an id wherever `refersTo` is set.
 */
function isReference(field: FieldSpec, value: unknown): boolean {
  return (
    field.refersTo !== undefined &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function referenceHint(field: FieldSpec): string | undefined {
  return field.refersTo
    ? `the numeric id of a ${field.refersTo} (or an object identifying one)`
    : undefined;
}

function typeError(field: FieldSpec, expected: string, value: unknown): string {
  return `Field \`${field.name}\` must be ${expected}. Received ${describeValue(value)}.`;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`;
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return `the string "${truncate(value)}"`;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `the ${typeof value} ${truncate(String(value))}`;
  }
  return `a value of type ${typeof value}`;
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value;
}

/** Validate a native bulk request from its own OpenAPI array schema. */
export function validateBulkItems(
  items: Record<string, unknown>[],
  requestSchema: DetailActionSchema,
): ValidationOutcome {
  if (requestSchema.type !== "array" || !requestSchema.items) {
    return {
      ok: false,
      errors: ["The advertised bulk request schema is not an array of items."],
    };
  }
  const errors = items.flatMap((item, index) =>
    validateSchema(item, requestSchema.items as DetailActionSchema, `items[${index}]`),
  );
  return { ok: errors.length === 0, errors };
}

function validateSchema(
  value: unknown,
  schema: DetailActionSchema,
  path: string,
): string[] {
  if (value === null) return schema.nullable ? [] : [`${path} is not nullable.`];
  if (schema.oneOf?.length) {
    const matches = schema.oneOf.filter(
      (member) => validateSchema(value, member, path).length === 0,
    ).length;
    if (matches !== 1) return [`${path} must match exactly one allowed value.`];
  }
  if (
    schema.anyOf?.length &&
    !schema.anyOf.some((member) => validateSchema(value, member, path).length === 0)
  ) {
    return [`${path} does not match any allowed value.`];
  }
  const allOfErrors =
    schema.allOf?.flatMap((member) => validateSchema(value, member, path)) ?? [];
  if (allOfErrors.length) return allOfErrors;
  if (schema.enum && !schema.enum.some((member) => member === value)) {
    return [`${path} must be one of: ${schema.enum.map(String).join(", ")}.`];
  }
  if (
    schema.type === "integer" &&
    (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value))
  ) {
    return [`${path} must be an integer.`];
  }
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
    return [`${path} must be a number.`];
  if (schema.type === "string" && typeof value !== "string")
    return [`${path} must be a string.`];
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      return [`${path} must be at least ${schema.minimum}.`];
    if (schema.maximum !== undefined && value > schema.maximum)
      return [`${path} must be at most ${schema.maximum}.`];
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      return [`${path} must be at least ${schema.minLength} character(s).`];
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return [`${path} must be at most ${schema.maxLength} character(s).`];
  }
  if (schema.type === "boolean" && typeof value !== "boolean")
    return [`${path} must be true or false.`];
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array.`];
    const itemSchema = schema.items;
    return itemSchema
      ? value.flatMap((item, index) =>
          validateSchema(item, itemSchema, `${path}[${index}]`),
        )
      : [];
  }
  if (schema.type !== "object") return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${path} must be an object.`];
  }
  const record = value as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const errors: string[] = [];
  for (const required of schema.required ?? []) {
    if (
      record[required] === undefined ||
      record[required] === null ||
      record[required] === ""
    ) {
      errors.push(`${path}.${required} is required.`);
    }
  }
  for (const [name, item] of Object.entries(record)) {
    const property = properties[name];
    if (!property) {
      if (schema.additionalProperties === false) {
        errors.push(`${path}.${name} is not an accepted field.`);
      } else if (typeof schema.additionalProperties === "object") {
        errors.push(
          ...validateSchema(item, schema.additionalProperties, `${path}.${name}`),
        );
      }
      continue;
    }
    if (property.readOnly) {
      errors.push(`${path}.${name} is read-only.`);
      continue;
    }
    errors.push(...validateSchema(item, property, `${path}.${name}`));
  }
  return errors;
}
