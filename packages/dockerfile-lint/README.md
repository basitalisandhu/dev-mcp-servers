# dockerfile-lint MCP server

Parses Dockerfiles (comments, `escape` directive, line continuations, heredocs, multi-stage builds) and lints them for the mistakes that matter in production images. Static analysis only; Docker is never invoked.

Part of [dev-mcp-servers](https://github.com/basitalisandhu/dev-mcp-servers). Stdio transport only; the server never opens a port.

## Tools

| Tool | Input | What it returns |
|---|---|---|
| `lint_dockerfile` | `path` or `content`, `ignore?` | Findings with rule id, severity, line and fix: final stage running as root, `latest` or missing tags, no digest, credential-like `ENV`/`ARG` names and literals, missing `HEALTHCHECK`, `apt-get` without cleanup or `--no-install-recommends`, `apt-get upgrade`, `apk add` without `--no-cache`, `pip` without `--no-cache-dir`, `ADD` for plain files or URLs, `curl | sh`, `sudo`, relative `WORKDIR`, repeated `CMD`/`ENTRYPOINT`, shell-form `CMD`, `EXPOSE 22`, `MAINTAINER`, `COPY . .`, `COPY` after `USER` without `--chown`. |
| `parse_dockerfile` | `path` or `content` | Instructions with line ranges and stage index, stages with `AS` names and base images, escape character. |
| `explain_rule` | `rule` | Severity, description and fix for one rule. |

## Install

Claude Code:

```bash
claude mcp add dockerfile-lint -- npx -y @basitalisandhu/mcp-dockerfile-lint@0.2.0
```

Add `-s user` to make it available in every project. Any client that reads `.mcp.json` (Claude Code, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "dockerfile-lint": {
      "command": "npx",
      "args": ["-y", "@basitalisandhu/mcp-dockerfile-lint@0.2.0"]
    }
  }
}
```

Pin the version as shown so that an update to the package cannot change what runs in your editor without you noticing. From a checkout, use `"command": "node", "args": ["<path>/packages/dockerfile-lint/dist/index.js"]` after `npm install && npm run build` at the repository root.

## What it touches

- Network: None.
- Local files: Reads the one file you name, up to 1 MB.
- Telemetry: none.

## Notes

- `FROM $ARG` bases are checked against the declared `ARG`s; `scratch` and stage references are exempt from tag checks.
- Rules are heuristics on the text; a clean result does not scan the image's packages.

## Build and test

```bash
npm install        # at the repository root
npm run build -w @basitalisandhu/mcp-dockerfile-lint
npm test -w @basitalisandhu/mcp-dockerfile-lint
```

Tests use `node:test` and the SDK's in-memory transport; they do not reach the network.

## Licence

MIT. See [LICENSE](../../LICENSE).
