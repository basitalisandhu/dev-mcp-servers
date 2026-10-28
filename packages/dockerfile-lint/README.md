# dockerfile-lint MCP server

Parses Dockerfiles (comments, `escape` directive, line continuations, heredocs, multi-stage builds) and lints them for the mistakes that matter in production images. Static analysis only; Docker is never invoked.

Part of [dev-mcp-servers](https://github.com/basitalisandhu/dev-mcp-servers). Stdio transport only; the server never opens a port.

## Tools

| Tool | Input | What it returns |
|---|---|---|
| `lint_dockerfile` | `path` or `content`, `ignore?`, `dockerignore?` | Findings with rule id, severity, line and fix: final stage running as root, `latest` or missing tags, no digest, credential-like `ENV`/`ARG` names and literals, missing `HEALTHCHECK`, `apt-get` without cleanup or `--no-install-recommends`, `apt-get upgrade`, `apk add` without `--no-cache`, `pip` without `--no-cache-dir`, `ADD` for plain files or URLs, `curl | sh`, `sudo`, relative `WORKDIR`, repeated `CMD`/`ENTRYPOINT`, shell-form `CMD`, `EXPOSE 22`, `MAINTAINER`, `COPY . .` (sensitive-root ignore coverage), `COPY` after `USER` without `--chown`. |
| `parse_dockerfile` | `path` or `content` | Instructions with line ranges and stage index, stages with `AS` names and base images, escape character. |
| `explain_rule` | `rule` | Severity, description and fix for one rule. |

## Install

Claude Code:

```bash
claude mcp add dockerfile-lint -- docker run --rm -i -v "$PWD:/work:ro" ghcr.io/basitalisandhu/mcp-dockerfile-lint:0.2.2
```

Add `-s user` to make it available in every project. Any client that reads `.mcp.json` (Claude Code, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "dockerfile-lint": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-v", "/path/to/your/project:/work:ro", "ghcr.io/basitalisandhu/mcp-dockerfile-lint:0.2.2"]
    }
  }
}
```

Pin the version as shown so that an update cannot change what runs in your editor without you noticing. The container sees only the mounted directory, so pass paths under `/work`. The package is not on npmjs.com yet, so `npx` does not work; see the [repository README](https://github.com/basitalisandhu/dev-mcp-servers#install) for GitHub Packages npm. From a checkout, use `"command": "node", "args": ["<path>/packages/dockerfile-lint/dist/index.js"]` after `npm install && npm run build` at the repository root.

## What it touches

- Network: None.
- Local files: Reads the Dockerfile you name, up to 1 MB, and its sibling `.dockerignore`, up to 64 KB, unless inline ignore text is supplied.
- Telemetry: none.

## Notes

- With `path`, `lint_dockerfile` reads `.dockerignore` beside the Dockerfile (up to 64 KB). Supply `dockerignore` to override it, or when using inline Dockerfile content; inline input never reads ignore files from the working directory. Missing ignore files preserve the warning; other read errors are returned.
- The `copy-whole-context` rule reports uncovered root patterns `.git`, `.env` (or `.env*`) and `node_modules`, and is suppressed only when all are covered. The dependency-free matcher supports exact names, `*` within a segment, `**`, leading/trailing slashes, comments and ordered `!` negations. This is conservative root-pattern analysis, not a directory walk or full Docker matcher: uncertain wildcard negations retain the warning, nested build contexts are not inferred, and suppressing this finding does not certify that the context contains no secrets. Prefer `.env*` to cover environment-specific files as well as `.env`.
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
