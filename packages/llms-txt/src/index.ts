#!/usr/bin/env node
/**
 * llms-txt: generate and check llms.txt files.
 *
 * Transport: stdio only. No network: Markdown and sitemaps are read from local paths only, and nothing is written.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { MAX_FILES, check, collectMarkdown, entriesFromSitemap, parseSitemap, render } from "./llms.js";

export const SERVER_NAME = "llms-txt";
export const SERVER_VERSION = "0.1.1";
const MAX_TEXT = 2 * 1024 * 1024;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

async function readBounded(path: string): Promise<string> {
  const abs = resolve(path);
  const st = await stat(abs).catch((err: Error) => {
    throw new Error(`cannot read ${abs}: ${err.message}`);
  });
  if (!st.isFile()) throw new Error(`${abs} is not a file`);
  if (st.size > MAX_TEXT) throw new Error(`${abs} is ${st.size} bytes; the limit is ${MAX_TEXT}`);
  return readFile(abs, "utf8");
}

const localRead = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Builds and checks llms.txt files (https://llmstxt.org): an H1 title, a blockquote summary, optional paragraphs, then H2 sections of '- [name](url): notes' links, " +
        "with an Optional section for secondary material. generate_llms_txt scans a local directory of Markdown; generate_from_sitemap reads a local sitemap.xml; " +
        "check_llms_txt validates an existing file. Tools return the text; they never write files or fetch URLs.",
    },
  );

  server.registerTool(
    "generate_llms_txt",
    {
      title: "Generate llms.txt from Markdown",
      description:
        "Scan a local directory (recursively, skipping node_modules, .git, build output and hidden directories, up to max_files files) for .md, .mdx and .markdown files and return an llms.txt. " +
        "Each file's title comes from frontmatter, its first H1 or the file name; its notes from frontmatter description or the first paragraph (trimmed to 200 characters). " +
        "Files are grouped into sections by top-level folder (root files under Docs). URLs are base_url plus the relative path, with .md stripped and README/index mapped to the folder " +
        "unless url_style is keep-extension. Sections named in optional_sections are moved under Optional. Returns the text, the entries, and anything skipped.",
      inputSchema: {
        directory: z.string().min(1).max(4096),
        title: z.string().min(1).max(200).describe("H1 title, usually the project name."),
        description: z.string().max(500).optional().describe("One-sentence summary for the blockquote."),
        details: z.string().max(4000).optional().describe("Optional paragraph(s) placed after the summary."),
        base_url: z.string().max(500).optional().describe("Prefix for links, for example https://docs.example.com. Default: root-relative paths."),
        url_style: z.enum(["strip-extension", "keep-extension"]).optional(),
        max_files: z.number().int().min(1).max(MAX_FILES).optional().describe(`Default ${MAX_FILES}.`),
        include_dirs: z.array(z.string().min(1).max(200)).max(50).optional().describe("Only scan these top-level directories (use \".\" to keep root files)."),
        optional_sections: z.array(z.string().min(1).max(200)).max(50).optional(),
      },
      annotations: localRead,
    },
    async ({ directory, title, description, details, base_url, url_style, max_files, include_dirs, optional_sections }) => {
      try {
        const { entries, skipped, scanned } = await collectMarkdown(directory, { baseUrl: base_url, urlStyle: url_style, maxFiles: max_files, includeDirs: include_dirs });
        if (entries.length === 0) return fail(`No Markdown files found under ${resolve(directory)}.`);
        const content = render(entries, { title, description, details, optionalSections: optional_sections });
        return json({ files_scanned: scanned, entries: entries.length, skipped, content, entries_detail: entries });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "generate_from_sitemap",
    {
      title: "Generate llms.txt from a local sitemap.xml",
      description:
        "Read a sitemap.xml from a local path (download it first; this tool does not fetch URLs) and return an llms.txt with one link per <url>, grouped into sections by the first path segment. " +
        "Titles are derived from the last path segment because page content is not fetched, so notes are empty; edit them afterwards. include_prefix and exclude_prefix filter by URL path. " +
        "Child sitemaps in a sitemap index are listed but not read.",
      inputSchema: {
        path: z.string().min(1).max(4096).describe("Local path to sitemap.xml."),
        title: z.string().min(1).max(200),
        description: z.string().max(500).optional(),
        details: z.string().max(4000).optional(),
        include_prefix: z.array(z.string().min(1).max(500)).max(50).optional(),
        exclude_prefix: z.array(z.string().min(1).max(500)).max(50).optional(),
        optional_sections: z.array(z.string().min(1).max(200)).max(50).optional(),
        max_urls: z.number().int().min(1).max(5000).optional().describe("Default 1000."),
      },
      annotations: localRead,
    },
    async ({ path, title, description, details, include_prefix, exclude_prefix, optional_sections, max_urls }) => {
      try {
        const xml = await readBounded(path);
        const { urls, child_sitemaps } = parseSitemap(xml);
        if (urls.length === 0 && child_sitemaps.length === 0) return fail("No <url> or <sitemap> entries found; is this a sitemap.xml?");
        const limit = max_urls ?? 1000;
        const entries = entriesFromSitemap(urls.slice(0, limit), { includePrefix: include_prefix, excludePrefix: exclude_prefix });
        if (entries.length === 0) return fail(`The sitemap lists ${urls.length} URL(s) but none passed the filters${child_sitemaps.length ? `; ${child_sitemaps.length} child sitemap(s) were not read` : ""}.`);
        return json({ urls_in_sitemap: urls.length, truncated: urls.length > limit, entries: entries.length, child_sitemaps, content: render(entries, { title, description, details, optionalSections: optional_sections }) });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "check_llms_txt",
    {
      title: "Check an llms.txt file",
      description:
        "Validate llms.txt text (from a local path or inline content) against the convention: exactly one H1 first, an optional blockquote summary, H2 sections containing only " +
        "'- [name](url): notes' items, no deeper headings, no duplicate URLs or sections, a modest size. Returns errors (convention violations), warnings, info (such as links without notes " +
        "or relative URLs) with line numbers, and statistics.",
      inputSchema: {
        path: z.string().min(1).max(4096).optional(),
        content: z.string().min(1).max(MAX_TEXT).optional(),
      },
      annotations: localRead,
    },
    async ({ path, content }) => {
      if ((path && content) || (!path && !content)) return fail("Supply exactly one of path or content.");
      try {
        const text = content ?? (await readBounded(path as string));
        return json(check(text));
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
