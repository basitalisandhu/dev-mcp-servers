#!/usr/bin/env node
/**
 * json-schema-tools: validate, infer and diff JSON Schemas.
 *
 * Transport: stdio only. No network, no file access. Ajv runs with strict mode off so that real-world
 * schemas with unknown keywords still validate; remote $ref resolution is disabled.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DRAFTS, diffSchemas, inferSchema, validate } from "./schema.js";

export const SERVER_NAME = "json-schema-tools";
export const SERVER_VERSION = "0.1.1";
const MAX_JSON = 2 * 1024 * 1024;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/** Accept either a JSON value or a JSON string; enforce a size limit either way. */
function coerce(value: unknown, label: string): unknown {
  if (typeof value === "string") {
    if (value.length > MAX_JSON) throw new Error(`${label} exceeds ${MAX_JSON} characters`);
    try {
      return JSON.parse(value);
    } catch (err) {
      throw new Error(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (JSON.stringify(value).length > MAX_JSON) throw new Error(`${label} exceeds ${MAX_JSON} characters`);
  return value;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  const v = coerce(value, label);
  if (typeof v === "boolean") return v ? {} : { not: {} };
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${label} must be a JSON object`);
  return v as Record<string, unknown>;
}

const schemaInput = z.union([z.record(z.string(), z.unknown()), z.string().min(1).max(MAX_JSON), z.boolean()]).describe("A JSON Schema object, or the same as a JSON string.");
const pure = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Works with JSON Schema drafts 07, 2019-09 and 2020-12 using Ajv. validate_json checks a document against a schema and lists every violation with its JSON Pointer path; " +
        "infer_schema builds a 2020-12 schema from one or more sample documents (types, required keys, nested objects, array items, common string formats); " +
        "diff_schemas compares two schemas and classifies each change as breaking, compatible or review from the point of view of documents valid under the old schema. " +
        "Schemas and documents may be passed as JSON values or JSON strings. Remote $ref targets are not fetched.",
    },
  );

  server.registerTool(
    "validate_json",
    {
      title: "Validate JSON against a schema",
      description:
        "Validate a JSON document against a JSON Schema. The draft is read from $schema (draft-07 when absent) unless draft is given. Formats such as email, uri, date-time and uuid " +
        "are checked. Returns valid, the draft used, the total error count and up to 200 errors with instance path (JSON Pointer), schema path, keyword, message and params. " +
        "Unknown keywords are ignored (Ajv strict mode is off). Draft-04 and draft-06 schemas are rejected.",
      inputSchema: {
        schema: schemaInput,
        data: z.unknown().describe("The document to validate: any JSON value, or a JSON string (strings are parsed; to validate a literal string, pass it JSON-encoded, for example \"\\\"text\\\"\")."),
        draft: z.enum(DRAFTS).optional().describe("Force a draft. Default auto."),
      },
      annotations: pure,
    },
    async ({ schema, data, draft }) => {
      try {
        return json(validate(asObject(schema, "schema"), coerce(data, "data"), draft));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "infer_schema",
    {
      title: "Infer a schema from sample JSON",
      description:
        "Build a JSON Schema (draft 2020-12) that describes the given samples: a single document or an array of documents (each sample is one document; wrap one array document as [[...]]). " +
        "Properties present in every sample become required; types seen across samples are unioned; nested objects and array items are inferred recursively; strings that all look like " +
        "a date-time, date, time, email, uuid, uri or ipv4 get a format. With enum_threshold above 0, string properties with few distinct values across at least three samples become enums. " +
        "The result is a starting point to edit, not a complete contract.",
      inputSchema: {
        samples: z.union([z.array(z.unknown()).min(1).max(500), z.string().min(1).max(MAX_JSON)]).describe("Array of sample documents, or a JSON string of one document or an array of documents."),
        enum_threshold: z.number().int().min(0).max(50).optional().describe("Default 0 (no enums)."),
        detect_formats: z.boolean().optional().describe("Default true."),
        title: z.string().max(200).optional().describe("Optional title for the root schema."),
      },
      annotations: pure,
    },
    async ({ samples, enum_threshold, detect_formats, title }) => {
      try {
        let list: unknown[];
        if (typeof samples === "string") {
          const parsed = coerce(samples, "samples");
          list = Array.isArray(parsed) ? parsed : [parsed];
        } else {
          coerce(samples, "samples");
          list = samples;
        }
        const schema = inferSchema(list, { enumThreshold: enum_threshold, detectFormats: detect_formats });
        return json({ samples: list.length, schema: { $schema: "https://json-schema.org/draft/2020-12/schema", ...(title ? { title } : {}), ...schema } });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "diff_schemas",
    {
      title: "Diff two JSON Schemas",
      description:
        "Compare two JSON Schemas structurally and list every change with its path, the before and after values, and an impact: breaking (a document valid under the old schema can " +
        "now be rejected: required added, property removed with additionalProperties false, type narrowed, enum value removed, tighter min/max), compatible (every old document stays valid), " +
        "or review (composition keywords, changed patterns or formats). Walks properties, required, additionalProperties, items, enum, numeric and length bounds, pattern, format, $ref and annotations. " +
        "oneOf/anyOf/allOf and conditionals are compared as a whole.",
      inputSchema: { before: schemaInput, after: schemaInput },
      annotations: pure,
    },
    async ({ before, after }) => {
      try {
        const changes = diffSchemas(asObject(before, "before"), asObject(after, "after"));
        const counts = { breaking: 0, compatible: 0, review: 0 };
        for (const c of changes) counts[c.impact]++;
        return json({ changes: changes.length, ...counts, verdict: counts.breaking ? "breaking" : counts.review ? "review" : changes.length ? "compatible" : "identical", details: changes });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Compare real paths: an installed bin (npx, npm i -g) is a symlink, so argv[1] differs from import.meta.url.
function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

const invokedDirectly = isInvokedDirectly();
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[${SERVER_NAME}] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
