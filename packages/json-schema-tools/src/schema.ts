/**
 * JSON Schema helpers: validation with Ajv (draft-07, 2019-09 and 2020-12), schema inference from samples,
 * and a structural diff between two schemas with a compatibility assessment.
 */
import AjvModule from "ajv";
import type { ErrorObject, Options, ValidateFunction } from "ajv";
import Ajv2019Module from "ajv/dist/2019.js";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// Ajv ships CommonJS with both `module.exports = Ajv` and `module.exports.default = Ajv`; under Node's
// ESM interop the default import is the former, so unwrap `.default` when it is present.
type AjvInstance = InstanceType<typeof AjvModule.default>;
type AjvCtor = new (options?: Options) => AjvInstance;
function unwrap<T>(mod: unknown): T {
  const m = mod as { default?: T };
  return (m && typeof m === "object" && "default" in m && m.default ? m.default : mod) as T;
}
const Ajv = unwrap<AjvCtor>(AjvModule);
const Ajv2019 = unwrap<AjvCtor>(Ajv2019Module);
const Ajv2020 = unwrap<AjvCtor>(Ajv2020Module);
const addFormats = unwrap<(ajv: AjvInstance) => AjvInstance>(addFormatsModule);

export const DRAFTS = ["auto", "draft-07", "2019-09", "2020-12"] as const;
export type Draft = (typeof DRAFTS)[number];

export interface ValidationError {
  path: string;
  schema_path: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  draft: Exclude<Draft, "auto">;
  error_count: number;
  errors: ValidationError[];
}

export function detectDraft(schema: Record<string, unknown>): Exclude<Draft, "auto"> {
  const id = typeof schema.$schema === "string" ? schema.$schema : "";
  if (id.includes("2020-12")) return "2020-12";
  if (id.includes("2019-09")) return "2019-09";
  if (id.includes("draft-04") || id.includes("draft-06")) return "draft-07";
  return "draft-07";
}

function makeAjv(draft: Exclude<Draft, "auto">): AjvInstance {
  const options: Options = { allErrors: true, strict: false, allowUnionTypes: true, validateFormats: true };
  const ajv = draft === "2020-12" ? new Ajv2020(options) : draft === "2019-09" ? new Ajv2019(options) : new Ajv(options);
  addFormats(ajv);
  return ajv;
}

const MAX_ERRORS = 200;

export function validate(schema: Record<string, unknown>, data: unknown, draft: Draft = "auto"): ValidationResult {
  const d = draft === "auto" ? detectDraft(schema) : draft;
  if (typeof schema.$schema === "string" && /draft-0[46]/.test(schema.$schema)) {
    throw new Error(`${schema.$schema} is not supported; Ajv supports draft-07, 2019-09 and 2020-12. Remove $schema or update it.`);
  }
  const ajv = makeAjv(d);
  let fn: ValidateFunction;
  try {
    fn = ajv.compile(schema);
  } catch (err) {
    throw new Error(`schema does not compile: ${err instanceof Error ? err.message : String(err)}`);
  }
  const valid = fn(data) as boolean;
  const errors = (fn.errors ?? []).slice(0, MAX_ERRORS).map((e: ErrorObject) => ({
    path: e.instancePath || "/",
    schema_path: e.schemaPath,
    keyword: e.keyword,
    message: `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim(),
    params: e.params as Record<string, unknown>,
  }));
  return { valid, draft: d, error_count: fn.errors?.length ?? 0, errors };
}

/* Inference */

type JsonType = "null" | "boolean" | "integer" | "number" | "string" | "array" | "object";

function typeOf(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(v) ? "integer" : "number";
    case "string":
      return "string";
    case "object":
      return "object";
    default:
      throw new Error(`cannot infer a schema for a ${typeof v} value`);
  }
}

const FORMATS: [string, RegExp][] = [
  ["date-time", /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/],
  ["date", /^\d{4}-\d{2}-\d{2}$/],
  ["time", /^\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/],
  ["email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ["uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ["uri", /^[a-z][a-z0-9+.-]*:\/\/\S+$/i],
  ["ipv4", /^(\d{1,3}\.){3}\d{1,3}$/],
];

export interface InferOptions {
  /** Add enum for string properties with at most this many distinct values across at least 3 samples. 0 disables. Default 0. */
  enumThreshold?: number;
  /** Guess string formats (date-time, date, time, email, uuid, uri, ipv4). Default true. */
  detectFormats?: boolean;
  maxDepth?: number;
}

export function inferSchema(samples: unknown[], options: InferOptions = {}, depth = 0): Record<string, unknown> {
  if (samples.length === 0) return {};
  if (depth > (options.maxDepth ?? 32)) return {};
  const types = new Set<JsonType>(samples.map(typeOf));
  if (types.has("number") && types.has("integer")) types.delete("integer");
  const schema: Record<string, unknown> = {};
  const typeList = [...types];
  schema.type = typeList.length === 1 ? typeList[0] : typeList;

  if (types.has("string")) {
    const strings = samples.filter((s): s is string => typeof s === "string");
    if (options.detectFormats !== false && strings.length > 0) {
      const format = FORMATS.find(([, re]) => strings.every((s) => re.test(s)));
      if (format) schema.format = format[0];
    }
    const threshold = options.enumThreshold ?? 0;
    if (threshold > 0 && strings.length >= 3 && !schema.format) {
      const distinct = [...new Set(strings)];
      if (distinct.length <= threshold && distinct.length < strings.length) schema.enum = distinct.sort();
    }
  }
  if (types.has("object")) {
    const objects = samples.filter((s): s is Record<string, unknown> => s !== null && typeof s === "object" && !Array.isArray(s));
    const keys = new Set<string>();
    objects.forEach((o) => Object.keys(o).forEach((k) => keys.add(k)));
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const key of [...keys].sort()) {
      const present = objects.filter((o) => key in o);
      properties[key] = inferSchema(present.map((o) => o[key]), options, depth + 1);
      if (present.length === objects.length) required.push(key);
    }
    schema.properties = properties;
    if (required.length) schema.required = required;
  }
  if (types.has("array")) {
    const items = samples.filter((s): s is unknown[] => Array.isArray(s)).flat(1);
    schema.items = items.length ? inferSchema(items, options, depth + 1) : {};
  }
  return schema;
}

/* Diff */

export type Impact = "breaking" | "compatible" | "review";

export interface SchemaChange {
  path: string;
  change: string;
  impact: Impact;
  before?: unknown;
  after?: unknown;
  reason: string;
}

const TYPE_WIDENING: Record<string, string[]> = { integer: ["number"] };

function asTypes(t: unknown): string[] {
  return Array.isArray(t) ? t.map(String) : typeof t === "string" ? [t] : [];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare `before` and `after` from the point of view of data that was valid under `before`:
 * "breaking" means such data can now be rejected, "compatible" means every previously valid document
 * is still valid, "review" means it depends on the data.
 */
export function diffSchemas(before: unknown, after: unknown, path = "", out: SchemaChange[] = [], depth = 0): SchemaChange[] {
  if (depth > 64) return out;
  const b = (before && typeof before === "object" && !Array.isArray(before) ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === "object" && !Array.isArray(after) ? after : {}) as Record<string, unknown>;
  const p = path || "/";

  if (!same(b.type, a.type)) {
    const bt = asTypes(b.type);
    const at = asTypes(a.type);
    const widened = bt.every((t) => at.includes(t) || (TYPE_WIDENING[t] ?? []).some((w) => at.includes(w)));
    out.push({ path: p, change: "type", impact: bt.length === 0 ? "breaking" : widened ? "compatible" : "breaking", before: b.type, after: a.type, reason: widened ? "every previous type is still accepted" : "values of a previously accepted type are now rejected" });
  }

  const bProps = (b.properties ?? {}) as Record<string, unknown>;
  const aProps = (a.properties ?? {}) as Record<string, unknown>;
  const bReq = new Set(Array.isArray(b.required) ? b.required.map(String) : []);
  const aReq = new Set(Array.isArray(a.required) ? a.required.map(String) : []);
  for (const key of Object.keys(bProps)) {
    if (!(key in aProps)) {
      const additional = a.additionalProperties;
      out.push({ path: `${p === "/" ? "" : p}/properties/${key}`, change: "property removed", impact: additional === false ? "breaking" : "review", reason: additional === false ? "documents that still send it are rejected by additionalProperties: false" : "the property is no longer described; readers that depend on it lose its contract" });
    }
  }
  for (const key of Object.keys(aProps)) {
    const sub = `${p === "/" ? "" : p}/properties/${key}`;
    if (!(key in bProps)) {
      out.push({ path: sub, change: "property added", impact: aReq.has(key) ? "breaking" : "compatible", reason: aReq.has(key) ? "it is required, so existing documents without it are rejected" : "optional, so existing documents stay valid" });
    } else {
      diffSchemas(bProps[key], aProps[key], sub, out, depth + 1);
    }
  }
  for (const key of aReq) if (!bReq.has(key) && key in bProps) out.push({ path: `${p === "/" ? "" : p}/required`, change: "required added", impact: "breaking", after: key, reason: `documents without ${key} are now rejected` });
  for (const key of bReq) if (!aReq.has(key)) out.push({ path: `${p === "/" ? "" : p}/required`, change: "required removed", impact: "compatible", before: key, reason: `${key} became optional; readers must handle its absence` });

  if (b.additionalProperties !== a.additionalProperties) {
    const nowClosed = a.additionalProperties === false;
    out.push({ path: `${p === "/" ? "" : p}/additionalProperties`, change: "additionalProperties", impact: nowClosed ? "breaking" : b.additionalProperties === false ? "compatible" : "review", before: b.additionalProperties, after: a.additionalProperties, reason: nowClosed ? "unknown properties are now rejected" : "unknown properties are now allowed or constrained differently" });
  }

  if ("enum" in b || "enum" in a) {
    const be = Array.isArray(b.enum) ? b.enum : undefined;
    const ae = Array.isArray(a.enum) ? a.enum : undefined;
    if (!same(be, ae)) {
      const removed = (be ?? []).filter((v) => !(ae ?? []).some((w) => same(v, w)));
      const added = (ae ?? []).filter((v) => !(be ?? []).some((w) => same(v, w)));
      out.push({ path: `${p === "/" ? "" : p}/enum`, change: "enum", impact: !be ? "breaking" : !ae ? "compatible" : removed.length ? "breaking" : "compatible", before: be, after: ae, reason: !be ? "values are now restricted to a list" : !ae ? "the restriction was lifted" : removed.length ? `values removed: ${JSON.stringify(removed)}` : `values added: ${JSON.stringify(added)}` });
    }
  }

  const tighten: [string, (x: number, y: number) => boolean][] = [
    ["minimum", (x, y) => y > x],
    ["exclusiveMinimum", (x, y) => y > x],
    ["minLength", (x, y) => y > x],
    ["minItems", (x, y) => y > x],
    ["minProperties", (x, y) => y > x],
    ["maximum", (x, y) => y < x],
    ["exclusiveMaximum", (x, y) => y < x],
    ["maxLength", (x, y) => y < x],
    ["maxItems", (x, y) => y < x],
    ["maxProperties", (x, y) => y < x],
  ];
  for (const [kw, tighter] of tighten) {
    if (b[kw] === a[kw]) continue;
    const bv = typeof b[kw] === "number" ? (b[kw] as number) : undefined;
    const av = typeof a[kw] === "number" ? (a[kw] as number) : undefined;
    const impact: Impact = av === undefined ? "compatible" : bv === undefined ? "breaking" : tighter(bv, av) ? "breaking" : "compatible";
    out.push({ path: `${p === "/" ? "" : p}/${kw}`, change: kw, impact, before: b[kw], after: a[kw], reason: impact === "breaking" ? "the constraint is tighter than before" : "the constraint is looser or removed" });
  }
  for (const kw of ["pattern", "format", "const", "multipleOf", "uniqueItems", "$ref", "contentEncoding"]) {
    if (same(b[kw], a[kw])) continue;
    out.push({ path: `${p === "/" ? "" : p}/${kw}`, change: kw, impact: a[kw] === undefined ? "compatible" : b[kw] === undefined ? "breaking" : "review", before: b[kw], after: a[kw], reason: a[kw] === undefined ? "the constraint was removed" : b[kw] === undefined ? "a new constraint applies" : "the constraint changed; whether old values still pass depends on the data" });
  }
  if (b.items !== undefined || a.items !== undefined) {
    if (a.items !== undefined && b.items === undefined) out.push({ path: `${p === "/" ? "" : p}/items`, change: "items added", impact: "breaking", reason: "array elements are now constrained" });
    else if (a.items === undefined && b.items !== undefined) out.push({ path: `${p === "/" ? "" : p}/items`, change: "items removed", impact: "compatible", reason: "array elements are no longer constrained" });
    else if (!Array.isArray(b.items) && !Array.isArray(a.items)) diffSchemas(b.items, a.items, `${p === "/" ? "" : p}/items`, out, depth + 1);
    else if (!same(b.items, a.items)) out.push({ path: `${p === "/" ? "" : p}/items`, change: "items", impact: "review", before: b.items, after: a.items, reason: "tuple-style items changed" });
  }
  for (const kw of ["oneOf", "anyOf", "allOf", "not", "if", "then", "else", "patternProperties", "dependentRequired", "$defs", "definitions"]) {
    if (!same(b[kw], a[kw])) out.push({ path: `${p === "/" ? "" : p}/${kw}`, change: kw, impact: "review", before: b[kw], after: a[kw], reason: "composition keywords are compared as a whole; inspect the change by hand" });
  }
  for (const kw of ["title", "description", "examples", "default", "deprecated", "$comment"]) {
    if (!same(b[kw], a[kw])) out.push({ path: `${p === "/" ? "" : p}/${kw}`, change: kw, impact: "compatible", before: b[kw], after: a[kw], reason: "annotation only, no effect on validation" });
  }
  return out;
}
