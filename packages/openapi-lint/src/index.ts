#!/usr/bin/env node
/**
 * openapi-lint: list and lint the operations of an OpenAPI 3.x document.
 *
 * Transport: stdio only. No network. Reads one local file per call when a path is given; remote $ref
 * targets are never fetched.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { MAX_DOCUMENT_BYTES, METHODS, RULES, deref, lint, listOperations, loadDocument } from "./lint.js";

export const SERVER_NAME = "openapi-lint";
export const SERVER_VERSION = "0.1.1";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const sourceShape = {
  path: z.string().min(1).max(4096).optional().describe(`Path to a local OpenAPI JSON or YAML file (up to ${MAX_DOCUMENT_BYTES} bytes).`),
  document: z.union([z.string().min(1).max(MAX_DOCUMENT_BYTES), z.record(z.string(), z.unknown())]).optional().describe("The document itself, as JSON or YAML text or as an object. Alternative to path."),
};
const ruleNames = Object.keys(RULES) as [string, ...string[]];
const localRead = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Reads OpenAPI 3.0 and 3.1 documents (JSON or YAML, from a local path or inline). lint_openapi reports security and completeness problems with JSON Pointer paths; " +
        `list_operations tabulates every operation with its effective security; get_operation returns one operation in full; explain_rule documents a rule. Rules: ${ruleNames.join(", ")}. ` +
        "Only local #/ references are resolved. Findings describe the document, not the running API.",
    },
  );

  server.registerTool(
    "lint_openapi",
    {
      title: "Lint an OpenAPI document",
      description:
        "Check an OpenAPI 3.x document and return findings sorted by severity (error, warning, info), each with a rule id, a JSON Pointer path into the document and a message. " +
        "Rules cover: openapi version, http server URLs, missing or unused security schemes, operations with no security requirement (and explicitly public ones), undefined schemes, " +
        "operations without responses or without a success response, responses and parameters without descriptions, path parameters not declared or not required, missing operationId " +
        "and duplicates, unversioned paths, request bodies without content, deprecated operations and undeclared tags. Pass ignore to silence rule ids.",
      inputSchema: { ...sourceShape, ignore: z.array(z.enum(ruleNames)).max(50).optional().describe("Rule ids to skip.") },
      annotations: localRead,
    },
    async ({ path, document, ignore }) => {
      try {
        const { doc, source } = await loadDocument({ path, document });
        const findings = lint(doc, { ignore });
        const counts = { error: 0, warning: 0, info: 0 };
        for (const f of findings) counts[f.severity]++;
        return json({ source, openapi: doc.openapi ?? null, title: (doc.info as { title?: string } | undefined)?.title ?? null, operations: listOperations(doc).length, ...counts, findings });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "list_operations",
    {
      title: "List the operations of an OpenAPI document",
      description:
        "Return every operation (method and path) with operationId, summary, tags, deprecated flag, effective security (the operation's own requirement, the global one, " +
        "'public' for security: [], or 'inherited-none' when nothing applies), parameters with location and required flag, request body media types and response codes. " +
        "Optional filters: tag, method, path_prefix.",
      inputSchema: {
        ...sourceShape,
        tag: z.string().max(100).optional(),
        method: z.enum(METHODS).optional(),
        path_prefix: z.string().max(500).optional(),
      },
      annotations: localRead,
    },
    async ({ path, document, tag, method, path_prefix }) => {
      try {
        const { doc, source } = await loadDocument({ path, document });
        let ops = listOperations(doc);
        if (tag) ops = ops.filter((o) => o.tags.includes(tag));
        if (method) ops = ops.filter((o) => o.method === method.toUpperCase());
        if (path_prefix) ops = ops.filter((o) => o.path.startsWith(path_prefix));
        return json({ source, count: ops.length, operations: ops });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "get_operation",
    {
      title: "Get one operation",
      description:
        "Return the full definition of one operation, selected by operation_id or by method and path, with path-level parameters merged in and local $ref values resolved one level. " +
        "Useful for reading a single endpoint out of a large document.",
      inputSchema: {
        ...sourceShape,
        operation_id: z.string().max(200).optional(),
        method: z.enum(METHODS).optional(),
        operation_path: z.string().max(500).optional().describe("Path template as written in the document, for example /users/{id}."),
      },
      annotations: localRead,
    },
    async ({ path, document, operation_id, method, operation_path }) => {
      try {
        const { doc } = await loadDocument({ path, document });
        if (!operation_id && !(method && operation_path)) return fail("Supply operation_id, or both method and operation_path.");
        const paths = (doc.paths ?? {}) as Record<string, unknown>;
        for (const [p, rawItem] of Object.entries(paths)) {
          const item = deref<Record<string, unknown>>(doc, rawItem);
          if (!item || typeof item !== "object") continue;
          for (const m of METHODS) {
            const op = item[m] as Record<string, unknown> | undefined;
            if (!op || typeof op !== "object") continue;
            const matches = operation_id ? op.operationId === operation_id : m === method && p === operation_path;
            if (!matches) continue;
            const params = [...((item.parameters as unknown[]) ?? []), ...((op.parameters as unknown[]) ?? [])].map((x) => deref(doc, x));
            const responses = Object.fromEntries(Object.entries((op.responses as Record<string, unknown>) ?? {}).map(([k, v]) => [k, deref(doc, v)]));
            return json({ method: m.toUpperCase(), path: p, operation: { ...op, parameters: params, requestBody: deref(doc, op.requestBody), responses }, effective_security: op.security ?? doc.security ?? null });
          }
        }
        return fail(operation_id ? `No operation with operationId ${JSON.stringify(operation_id)}.` : `No ${method?.toUpperCase()} operation at ${operation_path}.`);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "explain_rule",
    {
      title: "Explain a lint rule",
      description: `Describe one lint rule: its default severity, what it detects and how to fix it. Rules: ${ruleNames.join(", ")}.`,
      inputSchema: { rule: z.enum(ruleNames) },
      annotations: localRead,
    },
    async ({ rule }) => json({ rule, ...RULES[rule] }),
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
