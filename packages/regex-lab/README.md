# regex-lab MCP server

Tests JavaScript regular expressions against sample strings, explains a pattern construct by construct, and looks for catastrophic backtracking. Every execution runs in a worker thread that is terminated when it exceeds the timeout, so a pathological pattern cannot hang the server.

Part of [dev-mcp-servers](https://github.com/basitalisandhu/dev-mcp-servers). Stdio transport only; the server never opens a port.

## Tools

| Tool | Input | What it returns |
|---|---|---|
| `test_regex` | `pattern`, `flags?`, `samples[]` (up to 50 of 20 000 chars), `replacement?`, `timeout_ms?` (50 to 10 000, default 2000) | Every match per sample with offsets, text, numbered and named groups (with offsets), optional `replace` preview. Samples finished before a timeout are still returned. |
| `explain_regex` | `pattern`, `flags?` | Indented description of literals, classes, escapes, anchors, groups, lookarounds, quantifiers and alternation, plus the capturing group count and flag meanings. |
| `check_redos` | `pattern`, `flags?`, `probe?` (default true), `timeout_ms?` | Static findings (nested unbounded repeats, overlapping alternatives under a repeat, adjacent overlapping repeats) with a probe character each, then timed runs against crafted inputs of growing length to confirm or clear the pattern. |

## Install

Claude Code:

```bash
claude mcp add regex-lab -- npx -y @basitalisandhu/mcp-regex-lab@0.1.1
```

Add `-s user` to make it available in every project. Any client that reads `.mcp.json` (Claude Code, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "regex-lab": {
      "command": "npx",
      "args": ["-y", "@basitalisandhu/mcp-regex-lab@0.1.1"]
    }
  }
}
```

Pin the version as shown so that an update to the package cannot change what runs in your editor without you noticing. From a checkout, use `"command": "node", "args": ["<path>/packages/regex-lab/dist/index.js"]` after `npm install && npm run build` at the repository root.

## What it touches

- Network: None.
- Local files: None.
- Telemetry: none.

## Notes

- Syntax follows V8 (Node.js). PCRE, RE2 and Python differ in places such as possessive quantifiers and lookbehind.
- `g` and `d` flags are added automatically when matching; the replacement preview uses the flags you gave.
- No findings and flat timings are evidence, not proof, that a pattern is safe.

## Build and test

```bash
npm install        # at the repository root
npm run build -w @basitalisandhu/mcp-regex-lab
npm test -w @basitalisandhu/mcp-regex-lab
```

Tests use `node:test` and the SDK's in-memory transport; they do not reach the network.

## Licence

MIT. See [LICENSE](../../LICENSE).
