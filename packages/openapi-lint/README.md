# openapi-lint MCP server

Loads an OpenAPI 3.0 or 3.1 document (JSON or YAML, from a local path or inline) and lints it for security and completeness problems; lists and fetches operations with their effective security. Only local `#/` references are resolved; nothing is fetched.

Part of [dev-mcp-servers](https://github.com/basitalisandhu/dev-mcp-servers). Stdio transport only; the server never opens a port.

## Tools

`lint_openapi` also warns about query-string API keys (`security-scheme-apikey-query`), notes HTTP Basic authentication (`security-scheme-http-basic`), and notes operations without a 4xx, 5xx or default response (`operation-no-error-response`). Error ranges `4XX` and `5XX` count as documented errors. Each rule can be suppressed with `ignore` and explained with `explain_rule`.

| Tool | Input | What it returns |
|---|---|---|
| `lint_openapi` | `path` or `document`, `ignore?` | Findings sorted by severity with rule id, JSON Pointer path and message: openapi version, http servers, missing, unused or undefined security schemes, operations without security (and explicitly public ones), operations without responses or success responses, undescribed responses and parameters, path parameters not declared or not required, missing or duplicate operationIds, unversioned paths, empty request bodies, deprecated operations, undeclared tags. |
| `list_operations` | `path` or `document`, `tag?`, `method?`, `path_prefix?` | Every operation with operationId, summary, tags, deprecated flag, effective security (`public` for `security: []`, `inherited-none` when nothing applies), parameters, request media types and response codes. |
| `get_operation` | `path` or `document`, `operation_id` or `method` + `operation_path` | One operation in full with path-level parameters merged and local references resolved. |
| `explain_rule` | `rule` | Severity, what the rule detects and how to fix it. |

## Install

Claude Code:

```bash
claude mcp add openapi-lint -- docker run --rm -i -v "$PWD:/work:ro" ghcr.io/basitalisandhu/mcp-openapi-lint:0.3.0
```

Add `-s user` to make it available in every project. Any client that reads `.mcp.json` (Claude Code, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "openapi-lint": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-v", "/path/to/your/project:/work:ro", "ghcr.io/basitalisandhu/mcp-openapi-lint:0.3.0"]
    }
  }
}
```

Pin the version as shown so that an update cannot change what runs in your editor without you noticing. The container sees only the mounted directory, so pass paths under `/work`. The package is not on npmjs.com yet, so `npx` does not work; see the [repository README](https://github.com/basitalisandhu/dev-mcp-servers#install) for GitHub Packages npm. From a checkout, use `"command": "node", "args": ["<path>/packages/openapi-lint/dist/index.js"]` after `npm install && npm run build` at the repository root.

## What it touches

- Network: None.
- Local files: Reads the one file you name, up to 5 MB. YAML is parsed with an alias limit.
- Telemetry: none.

## Notes

- Swagger 2.0 documents are reported by the `openapi-version` rule rather than linted.
- Findings describe the document, not the running API.

## Build and test

```bash
npm install        # at the repository root
npm run build -w @basitalisandhu/mcp-openapi-lint
npm test -w @basitalisandhu/mcp-openapi-lint
```

Tests use `node:test` and the SDK's in-memory transport; they do not reach the network.

## Licence

MIT. See [LICENSE](../../LICENSE).
