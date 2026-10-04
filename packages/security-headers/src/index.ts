#!/usr/bin/env node
/**
 * security-headers: fetch a URL's response headers and grade them.
 *
 * Transport: stdio only. Network: one HEAD (or GET) request to the caller-supplied public URL plus at most
 * a few redirect hops, each re-checked against private address ranges, with a 10 s timeout. Bodies are never read.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { MAX_REDIRECTS, fetchHeaders, type FetchHeadersOptions } from "./fetcher.js";
import { GRADED_HEADERS, HEADER_DOCS, gradeHeaders, toHeaderSet } from "./grade.js";

export const SERVER_NAME = "security-headers";
export const SERVER_VERSION = "0.1.0";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

export function createServer(options: FetchHeadersOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Grades HTTP response security headers. check_url_headers fetches a public URL (HEAD, then GET if HEAD is refused), follows a limited number of redirects " +
        "and refuses private or local addresses; grade_headers scores a header set you already have (for example from curl -I); explain_header describes one header. " +
        "Scores: Content-Security-Policy 25, Strict-Transport-Security 20, X-Frame-Options 10, X-Content-Type-Options 10, Referrer-Policy 10, Set-Cookie 10, " +
        "Permissions-Policy 5, Cross-Origin-Opener-Policy 5, Cross-Origin-Resource-Policy 5; Server, X-Powered-By and X-XSS-Protection are reported without points. " +
        "A high grade means the headers are well configured, not that the site is secure.",
    },
  );

  server.registerTool(
    "check_url_headers",
    {
      title: "Fetch and grade a URL's security headers",
      description:
        "Send a HEAD request (GET when the server answers 405 or 501, or when method is GET) to a public http or https URL, follow up to max_redirects redirects " +
        "(default 5) and grade the final response's security headers. Returns the final URL, status, redirect chain, every response header, and per-header " +
        "pass/warn/fail/info checks with explanations, recommendations and an overall grade from A+ to F. Refuses URLs whose host is localhost, a .local or " +
        ".internal name, or resolves to a private, loopback, link-local or cloud-metadata address. The response body is never downloaded.",
      inputSchema: {
        url: z.string().min(8).max(2048).describe("Absolute http:// or https:// URL."),
        method: z.enum(["HEAD", "GET"]).optional().describe("Default HEAD."),
        max_redirects: z.number().int().min(0).max(MAX_REDIRECTS).optional().describe("Default 5."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, method, max_redirects }) => {
      try {
        const fetched = await fetchHeaders(url, method ?? "HEAD", { ...options, maxRedirects: max_redirects ?? options.maxRedirects });
        const report = gradeHeaders({ headers: fetched.headers, setCookie: fetched.set_cookie, https: fetched.final_url.startsWith("https:") });
        return json({ ...fetched, report });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "grade_headers",
    {
      title: "Grade a supplied header set",
      description:
        "Grade response headers you already have, without any network access. Pass headers as an object of name to value (names are case-insensitive; " +
        "Set-Cookie may be an array). Returns the same per-header checks and overall grade as check_url_headers. Set https to false when the response came over plain HTTP.",
      inputSchema: {
        headers: z.record(z.string().min(1).max(200), z.union([z.string().max(16_384), z.array(z.string().max(16_384)).max(50)])).describe("Response headers, name to value."),
        https: z.boolean().optional().describe("Whether the response was served over HTTPS. Default true."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ headers, https }) => {
      if (Object.keys(headers).length > 200) return fail("At most 200 headers.");
      return json(gradeHeaders(toHeaderSet(headers, https ?? true)));
    },
  );

  server.registerTool(
    "explain_header",
    {
      title: "Explain a security header",
      description: `Describe what one response header does, the recommended value and a reference link. Headers: ${GRADED_HEADERS.join(", ")}.`,
      inputSchema: { header: z.enum(GRADED_HEADERS) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ header }) => json({ header, ...HEADER_DOCS[header] }),
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
