#!/usr/bin/env node
/**
 * osv-advisories: query OSV.dev for known vulnerabilities.
 *
 * Transport: stdio only. Network: HTTPS to api.osv.dev and nothing else, with a 15 s timeout per request
 * and an 8 MB cap per response. Local reads: scan_lockfile reads one file at a caller-supplied path.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { LOCKFILE_FORMATS, detectFormat, parseLockfile, type LockPackage } from "./lockfiles.js";
import { ECOSYSTEMS, MAX_BATCH_QUERIES, OsvClient, OsvError, normaliseEcosystem, summarise, type OsvClientOptions } from "./osv.js";

export const SERVER_NAME = "osv-advisories";
export const SERVER_VERSION = "0.2.0";
export const MAX_LOCKFILE_BYTES = 10 * 1024 * 1024;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const ecosystemSchema = z
  .string()
  .min(1)
  .max(40)
  .describe(`OSV ecosystem name, case-insensitive. One of: ${ECOSYSTEMS.join(", ")}.`);
const nameSchema = z.string().min(1).max(300).describe("Package name as the ecosystem spells it (npm scope included, Go module path, PyPI project name).");
const versionSchema = z.string().min(1).max(100).describe("Exact installed version. For Go, with or without the leading v.");

export function createServer(options: OsvClientOptions = {}): McpServer {
  const client = new OsvClient(options);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Looks up known vulnerabilities in the OSV.dev database (https://osv.dev) by package name, version and ecosystem. " +
        "query_package returns full advisories for one package; query_batch returns advisory ids for many; scan_lockfile parses a " +
        "package-lock.json, requirements.txt, poetry.lock or go.sum and batch-queries every pinned dependency; get_vulnerability fetches one advisory by id. " +
        "The server only contacts api.osv.dev. Results reflect the OSV database at query time and do not prove a package is safe.",
    },
  );
  const network = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.registerTool(
    "query_package",
    {
      title: "Query OSV for one package",
      description:
        "Return the OSV advisories affecting one package at one version (or every known advisory for the package when version is omitted). " +
        "Each advisory carries its id, aliases such as CVE ids, summary, severity, affected ranges, fixed versions and reference URLs. " +
        "Calls POST https://api.osv.dev/v1/query.",
      inputSchema: { ecosystem: ecosystemSchema, name: nameSchema, version: versionSchema.optional() },
      annotations: network,
    },
    async ({ ecosystem, name, version }) => {
      const eco = normaliseEcosystem(ecosystem);
      if (!eco) return fail(`Unknown ecosystem ${JSON.stringify(ecosystem)}. Known: ${ECOSYSTEMS.join(", ")}.`);
      try {
        const vulns = await client.queryPackage({ ecosystem: eco, name, version });
        return json({ ecosystem: eco, name, version: version ?? null, count: vulns.length, vulnerabilities: vulns.map(summarise) });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "query_batch",
    {
      title: "Query OSV for many packages",
      description:
        `Return, for each package in the list (up to ${MAX_BATCH_QUERIES}), the ids of OSV advisories that affect it. Ids only; call get_vulnerability for details. ` +
        "Calls POST https://api.osv.dev/v1/querybatch in chunks of 100.",
      inputSchema: {
        packages: z.array(z.object({ ecosystem: ecosystemSchema, name: nameSchema, version: versionSchema.optional() })).min(1).max(MAX_BATCH_QUERIES),
      },
      annotations: network,
    },
    async ({ packages }) => {
      const queries: LockPackage[] = [];
      for (const p of packages) {
        const eco = normaliseEcosystem(p.ecosystem);
        if (!eco) return fail(`Unknown ecosystem ${JSON.stringify(p.ecosystem)} for ${p.name}. Known: ${ECOSYSTEMS.join(", ")}.`);
        queries.push({ ecosystem: eco, name: p.name, version: p.version ?? "" });
      }
      try {
        const results = await client.queryBatch(queries.map((q) => ({ ...q, version: q.version || undefined })));
        const rows = queries.map((q, i) => ({ ...q, version: q.version || null, vulnerability_ids: results[i].ids }));
        return json({ queried: rows.length, affected: rows.filter((r) => r.vulnerability_ids.length > 0).length, results: rows });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "scan_lockfile",
    {
      title: "Scan a lockfile against OSV",
      description:
        "Parse a lockfile and batch-query OSV for every exactly pinned dependency in it. Supported formats: package-lock.json (lockfileVersion 1 to 3), " +
        "requirements.txt (only == pins are queried; other specifiers are listed as skipped), poetry.lock and go.sum (basic: every module line, leading v removed). " +
        `Supply either path (a local file up to ${MAX_LOCKFILE_BYTES} bytes) or content (the file text). Format is detected from the file name and content unless given. ` +
        "Returns the packages with advisories, the ids per package, the skipped entries and counts. With include_details, fetches up to 20 advisories in full.",
      inputSchema: {
        path: z.string().min(1).max(4096).optional().describe("Path to the lockfile on this machine."),
        content: z.string().min(1).max(MAX_LOCKFILE_BYTES).optional().describe("Lockfile text, as an alternative to path."),
        filename: z.string().max(255).optional().describe("Original file name, used for format detection when content is supplied."),
        format: z.enum(LOCKFILE_FORMATS).optional(),
        include_details: z.boolean().optional().describe("Also fetch the first 20 advisories in full. Default false."),
      },
      annotations: network,
    },
    async ({ path, content, filename, format, include_details }) => {
      if ((path && content) || (!path && !content)) return fail("Supply exactly one of path or content.");
      let text = content ?? "";
      let name = filename;
      if (path) {
        const abs = resolve(path);
        try {
          const st = await stat(abs);
          if (!st.isFile()) return fail(`${abs} is not a file.`);
          if (st.size > MAX_LOCKFILE_BYTES) return fail(`${abs} is ${st.size} bytes; the limit is ${MAX_LOCKFILE_BYTES}.`);
          text = await readFile(abs, "utf8");
        } catch (err) {
          return fail(`Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`);
        }
        name = name ?? abs;
      }
      const fmt = format ?? detectFormat(name, text);
      if (!fmt) return fail(`Could not detect the lockfile format. Pass format as one of ${LOCKFILE_FORMATS.join(", ")}.`);
      let parsed;
      try {
        parsed = parseLockfile(text, fmt);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      if (parsed.packages.length === 0) return json({ format: fmt, packages: 0, skipped: parsed.skipped, affected: [], note: "No exactly pinned packages found." });
      if (parsed.packages.length > MAX_BATCH_QUERIES) return fail(`${parsed.packages.length} packages found; the limit is ${MAX_BATCH_QUERIES} per scan.`);
      try {
        const results = await client.queryBatch(parsed.packages);
        const affected = parsed.packages.map((p, i) => ({ ...p, vulnerability_ids: results[i].ids })).filter((r) => r.vulnerability_ids.length > 0);
        const ids = [...new Set(affected.flatMap((a) => a.vulnerability_ids))];
        let details: unknown[] | undefined;
        if (include_details) {
          details = [];
          for (const id of ids.slice(0, 20)) {
            const v = await client.getVulnerability(id);
            if (v) details.push(summarise(v));
          }
        }
        return json({
          format: fmt,
          packages: parsed.packages.length,
          affected_packages: affected.length,
          distinct_advisories: ids.length,
          affected,
          skipped: parsed.skipped,
          ...(details ? { details, details_truncated: ids.length > 20 } : {}),
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "get_vulnerability",
    {
      title: "Get one OSV advisory",
      description:
        "Fetch one advisory by OSV id (for example GHSA-xxxx-xxxx-xxxx, PYSEC-2023-1, GO-2024-1234, or a CVE id that OSV aliases). " +
        "Returns the summary plus the raw OSV record. Calls GET https://api.osv.dev/v1/vulns/{id}.",
      inputSchema: { id: z.string().min(3).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/, "advisory ids contain letters, digits, dots, colons, underscores and dashes") },
      annotations: network,
    },
    async ({ id }) => {
      try {
        const v = await client.getVulnerability(id);
        if (!v) return fail(`OSV has no advisory with id ${JSON.stringify(id)}.`);
        return json({ summary: summarise(v), record: v });
      } catch (err) {
        return fail(err instanceof OsvError ? err.message : String(err));
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
