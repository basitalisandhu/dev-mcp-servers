# osv-advisories MCP server

Looks up known vulnerabilities in the [OSV.dev](https://osv.dev) database by package name, version and ecosystem, and scans lockfiles. The only host it ever contacts is `api.osv.dev` over HTTPS, with a 15 s timeout per request and an 8 MB cap per response.

Part of [dev-mcp-servers](https://github.com/basitalisandhu/dev-mcp-servers). Stdio transport only; the server never opens a port.

## Tools

| Tool | Input | What it returns |
|---|---|---|
| `query_package` | `ecosystem`, `name`, `version?` | Full advisories for one package: ids, aliases (CVE), summary, severity, affected ranges, fixed versions, references. POST `/v1/query`, up to five pages. |
| `query_batch` | `packages[]` (up to 1000) | Advisory ids per package. POST `/v1/querybatch` in chunks of 100. |
| `scan_lockfile` | `path` or `content`, `filename?`, `format?`, `include_details?` | Parses `package-lock.json` (v1 to v3), `requirements.txt` (`==` pins only), `poetry.lock` or `go.sum` (basic) and batch-queries every pinned package; lists skipped entries. Reads one local file up to 10 MB. |
| `get_vulnerability` | `id` | One advisory in full. GET `/v1/vulns/{id}`. |

## Install

Claude Code:

```bash
claude mcp add osv-advisories -- npx -y @basitalisandhu/mcp-osv-advisories@0.1.1
```

Add `-s user` to make it available in every project. Any client that reads `.mcp.json` (Claude Code, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "osv-advisories": {
      "command": "npx",
      "args": ["-y", "@basitalisandhu/mcp-osv-advisories@0.1.1"]
    }
  }
}
```

Pin the version as shown so that an update to the package cannot change what runs in your editor without you noticing. From a checkout, use `"command": "node", "args": ["<path>/packages/osv-advisories/dist/index.js"]` after `npm install && npm run build` at the repository root.

## What it touches

- Network: `https://api.osv.dev` only. Any other origin is refused before a request is made. Redirects are refused. No telemetry.
- Local files: `scan_lockfile` reads the one file you name, up to 10 MB.
- Telemetry: none.

## Notes

- Ecosystem names are matched case-insensitively against the OSV list and normalised (`pypi` becomes `PyPI`); unknown names are an error rather than an empty result.
- For Go modules the leading `v` is stripped from versions, as OSV expects.
- An empty result means OSV has no advisory for that exact package and version; it does not prove the package is safe.

## Build and test

```bash
npm install        # at the repository root
npm run build -w @basitalisandhu/mcp-osv-advisories
npm test -w @basitalisandhu/mcp-osv-advisories
```

Tests use `node:test` and the SDK's in-memory transport; they do not reach the network.

## Licence

MIT. See [LICENSE](../../LICENSE).
