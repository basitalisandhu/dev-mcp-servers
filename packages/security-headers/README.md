# security-headers MCP server

Fetches a public URL's response headers and grades Content-Security-Policy, Strict-Transport-Security, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, the Cross-Origin-* headers, Set-Cookie attributes and information-disclosure headers, with an explanation and a recommendation per header. The response body is never downloaded.

Part of [dev-mcp-servers](https://github.com/basitalisandhu/dev-mcp-servers). Stdio transport only; the server never opens a port.

## Tools

| Tool | Input | What it returns |
|---|---|---|
| `check_url_headers` | `url`, `method?` (HEAD or GET), `max_redirects?` (0 to 10, default 5) | HEAD request (GET on 405/501) to a public http(s) URL, redirects followed with the same checks on every hop, then a graded report. Refuses localhost, `.local`, `.internal`, private, loopback, link-local, CGNAT and cloud-metadata addresses, including names that resolve to them. |
| `grade_headers` | `headers` (object), `https?` | The same grading for headers you already have, for example from `curl -I`. No network. |
| `explain_header` | `header` | Purpose, recommended value and reference for one header. |

## Install

Claude Code:

```bash
claude mcp add security-headers -- npx -y @basitalisandhu/mcp-security-headers@0.2.0
```

Add `-s user` to make it available in every project. Any client that reads `.mcp.json` (Claude Code, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "security-headers": {
      "command": "npx",
      "args": ["-y", "@basitalisandhu/mcp-security-headers@0.2.0"]
    }
  }
}
```

Pin the version as shown so that an update to the package cannot change what runs in your editor without you noticing. From a checkout, use `"command": "node", "args": ["<path>/packages/security-headers/dist/index.js"]` after `npm install && npm run build` at the repository root.

## What it touches

- Network: One request to the URL you give plus at most `max_redirects` hops, each validated. 10 s timeout per request. The host is resolved and every address checked before connecting; this does not defeat DNS rebinding between the check and the connection, so do not point the tool at hosts you do not trust to answer honestly. No telemetry.
- Local files: None.
- Telemetry: none.

## Notes

- Scores: CSP 25, HSTS 20, X-Frame-Options 10, X-Content-Type-Options 10, Referrer-Policy 10, Set-Cookie 10, Permissions-Policy 5, COOP 5, CORP 5. Grades: A+ (95% and no fail), A (85% and no fail), B (70%), C (55%), D (40%), otherwise F.
- A report-only CSP earns nothing: it is not enforced.
- A good grade means the headers are configured well, not that the application is secure.

## Build and test

```bash
npm install        # at the repository root
npm run build -w @basitalisandhu/mcp-security-headers
npm test -w @basitalisandhu/mcp-security-headers
```

Tests use `node:test` and the SDK's in-memory transport; they do not reach the network.

## Licence

MIT. See [LICENSE](../../LICENSE).
