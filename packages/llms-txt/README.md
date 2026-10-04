# llms-txt MCP server

Generates an [`llms.txt`](https://llmstxt.org) from a directory of Markdown or from a local `sitemap.xml`, and checks an existing `llms.txt` against the convention. Reads local files only; never writes and never fetches a URL.

Part of [dev-mcp-servers](https://github.com/basitalisandhu/dev-mcp-servers). Stdio transport only; the server never opens a port.

## Tools

| Tool | Input | What it returns |
|---|---|---|
| `generate_llms_txt` | `directory`, `title`, `description?`, `details?`, `base_url?`, `url_style?`, `max_files?`, `include_dirs?`, `optional_sections?` | Scans `.md`, `.mdx` and `.markdown` files (skipping `node_modules`, `.git`, build output and hidden directories), takes each title from frontmatter, the first H1 or the file name and the notes from frontmatter or the first paragraph, groups by top-level folder, and returns the text plus the entries and anything skipped. |
| `generate_from_sitemap` | `path`, `title`, `description?`, `details?`, `include_prefix?`, `exclude_prefix?`, `optional_sections?`, `max_urls?` | One link per `<url>`, grouped by first path segment, titles derived from the URL (pages are not fetched). |
| `check_llms_txt` | `path` or `content` | Errors, warnings and info with line numbers: single H1 first, blockquote summary, H2 sections of `- [name](url): notes`, no deeper headings, no duplicates, modest size. |

## Install

Claude Code:

```bash
claude mcp add llms-txt -- npx -y @basitalisandhu/mcp-llms-txt@0.1.1
```

Add `-s user` to make it available in every project. Any client that reads `.mcp.json` (Claude Code, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "llms-txt": {
      "command": "npx",
      "args": ["-y", "@basitalisandhu/mcp-llms-txt@0.1.1"]
    }
  }
}
```

Pin the version as shown so that an update to the package cannot change what runs in your editor without you noticing. From a checkout, use `"command": "node", "args": ["<path>/packages/llms-txt/dist/index.js"]` after `npm install && npm run build` at the repository root.

## What it touches

- Network: None.
- Local files: Reads Markdown files under the directory you name (up to 1000 files, 1 MB each, 12 levels deep) or the one sitemap or llms.txt you name (up to 2 MB).
- Telemetry: none.

## Notes

- The output is returned as text; write it to `llms.txt` yourself after reviewing it.
- Sitemap-derived files have empty notes because page content is not fetched; fill them in before publishing.

## Build and test

```bash
npm install        # at the repository root
npm run build -w @basitalisandhu/mcp-llms-txt
npm test -w @basitalisandhu/mcp-llms-txt
```

Tests use `node:test` and the SDK's in-memory transport; they do not reach the network.

## Licence

MIT. See [LICENSE](../../LICENSE).
