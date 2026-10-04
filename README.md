# dev-mcp-servers

Ten small MCP servers for everyday development and security checks. Each one is a separate npm package you add to Claude Code, Claude Desktop, Cursor or any other MCP client with one line, and each does one job well: look up vulnerabilities, grade security headers, decode a JWT, test a regex, explain a cron expression, validate JSON against a schema, lint an OpenAPI document or a Dockerfile, read statistics out of a git repository, or build an `llms.txt`.

All servers are TypeScript on the official `@modelcontextprotocol/sdk`, speak stdio only, validate every input with zod, bound their inputs and run time, send no telemetry, and ship with `node:test` suites that cover every tool.

## Servers

| Server | Purpose | Install |
|---|---|---|
| [osv-advisories](packages/osv-advisories) | Query OSV.dev for known vulnerabilities by package and version; scan `package-lock.json`, `requirements.txt`, `poetry.lock` and `go.sum` | `claude mcp add osv-advisories -- npx -y @basitalisandhu/mcp-osv-advisories@0.1.0` |
| [security-headers](packages/security-headers) | Fetch a public URL's response headers and grade CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy and cookies | `claude mcp add security-headers -- npx -y @basitalisandhu/mcp-security-headers@0.1.0` |
| [jwt-tools](packages/jwt-tools) | Decode a JWT without verifying it, flag `alg: none`, expiry and missing claims, verify HS256/RS256 with a key, sign test tokens | `claude mcp add jwt-tools -- npx -y @basitalisandhu/mcp-jwt-tools@0.1.0` |
| [regex-lab](packages/regex-lab) | Test a regex against samples in a timeout-guarded worker, explain it, detect catastrophic backtracking | `claude mcp add regex-lab -- npx -y @basitalisandhu/mcp-regex-lab@0.1.0` |
| [cron-tools](packages/cron-tools) | Parse, explain and validate 5-field cron, list the next runs in a time zone | `claude mcp add cron-tools -- npx -y @basitalisandhu/mcp-cron-tools@0.1.0` |
| [json-schema-tools](packages/json-schema-tools) | Validate JSON with Ajv, infer a schema from samples, diff two schemas with a compatibility verdict | `claude mcp add json-schema-tools -- npx -y @basitalisandhu/mcp-json-schema-tools@0.1.0` |
| [openapi-lint](packages/openapi-lint) | Lint OpenAPI 3.x for missing security, responses, descriptions and versioning; list operations | `claude mcp add openapi-lint -- npx -y @basitalisandhu/mcp-openapi-lint@0.1.0` |
| [dockerfile-lint](packages/dockerfile-lint) | Lint Dockerfiles for root users, `latest` tags, secrets in `ENV`/`ARG`, missing `HEALTHCHECK`, apt without cleanup, `ADD` vs `COPY` | `claude mcp add dockerfile-lint -- npx -y @basitalisandhu/mcp-dockerfile-lint@0.1.0` |
| [git-insights](packages/git-insights) | Read-only git statistics: log, blame ownership, churn, authors, large files | `claude mcp add git-insights -- npx -y @basitalisandhu/mcp-git-insights@0.1.0` |
| [llms-txt](packages/llms-txt) | Generate `llms.txt` from local Markdown or a sitemap, check an existing one | `claude mcp add llms-txt -- npx -y @basitalisandhu/mcp-llms-txt@0.1.0` |

Every package README lists its tools with inputs and outputs, the exact `claude mcp add` command, a `.mcp.json` snippet, and what the server touches on disk and on the network.

## Quick start

With Claude Code:

```bash
claude mcp add jwt-tools -- npx -y @basitalisandhu/mcp-jwt-tools@0.1.0
claude mcp list
```

Add `-s user` to install for every project rather than the current one. For clients that read `.mcp.json` (Claude Code, Claude Desktop, Cursor), add an entry per server:

```json
{
  "mcpServers": {
    "jwt-tools": { "command": "npx", "args": ["-y", "@basitalisandhu/mcp-jwt-tools@0.1.0"] },
    "osv-advisories": { "command": "npx", "args": ["-y", "@basitalisandhu/mcp-osv-advisories@0.1.0"] }
  }
}
```

Pin the version in the `npx` argument, as above. An unpinned `npx -y package` runs whatever is on the registry at the time, which turns a package update into code that runs inside your editor without review.

From a checkout instead of npm:

```bash
git clone https://github.com/basitalisandhu/dev-mcp-servers
cd dev-mcp-servers
npm install
npm run build
claude mcp add jwt-tools -- node "$PWD/packages/jwt-tools/dist/index.js"
```

Packages are published to npm by the release workflow when a version tag is pushed; until a tag exists for a version, install from a checkout.

## Security posture

- **Stdio only.** No server opens a port. Each one is a child process of your MCP client and exits with it.
- **Validated, bounded inputs.** Every tool input has a zod schema with length and range limits; files are read with size caps; regex runs, HTTP requests and git commands have timeouts; results are capped.
- **Network only where the job is network, and only to the documented host.** `osv-advisories` talks to `api.osv.dev` and refuses any other origin. `security-headers` fetches the URL you give it, refuses private, loopback, link-local and cloud-metadata addresses (including names that resolve to them), limits redirects and never reads a body. The other eight servers make no network requests at all.
- **Read-only.** No server writes files, runs a shell, or modifies a repository. `git-insights` spawns `git` without a shell from fixed argument lists with validated paths and revisions and `GIT_OPTIONAL_LOCKS=0`; the output of `llms-txt` is returned as text for you to save.
- **No telemetry.** Nothing phones home. There are no analytics, update checks or crash reporters.
- **Honest tool descriptions.** Tool descriptions say what the tool does and returns. They contain no instructions aimed at the model, and the outputs of `decode_jwt` and the lints say when something is unverified or heuristic.
- **Small dependency trees.** Runtime dependencies are `@modelcontextprotocol/sdk` and `zod`, plus `ajv` and `ajv-formats` for json-schema-tools and `yaml` for openapi-lint. `npm ci` from the committed lockfile reproduces the exact tree.
- **Provenance.** Releases are published with `npm publish --provenance`, so every package version links to the commit and workflow run that built it (`npm view @basitalisandhu/mcp-jwt-tools --json | jq .dist.attestations`).

Before adding any MCP server, including these, read its source: it runs with your user's permissions and its tool results go into the model's context. See [SECURITY.md](SECURITY.md) for how to report a problem.

## Repository layout

```
packages/<name>/
  src/index.ts     server entry: createServer(), tool registrations, stdio main()
  src/*.ts         the logic, importable and tested on its own
  test/*.test.mjs  node:test suites over the built dist/ using the SDK's in-memory transport
  package.json     @basitalisandhu/mcp-<name>, bin, mcpName
  server.json      MCP registry metadata (checked against the schema in CI)
  README.md        tools, install, what it touches
scripts/check-server-json.mjs   offline validation of every server.json
.github/workflows/ci.yml        build and test every workspace on Node 20 and 22
.github/workflows/release.yml   publish every workspace with provenance on a version tag
```

Build and test everything:

```bash
npm install
npm run build
npm test
npm run check:server-json
```

Tests run offline: network-facing servers are tested against a fake `fetch`, and git-insights builds a temporary repository.

## Adding a server

1. Copy the closest existing package to `packages/<name>` and rename it: `name` is `@basitalisandhu/mcp-<name>`, `bin` is `mcp-<name>`, `mcpName` is `io.github.basitalisandhu/<name>`, and `server.json` repeats the name, version, identifier and `packages/<name>` subfolder.
2. Keep the pattern: `createServer()` returns an `McpServer`; `main()` connects a `StdioServerTransport` only when the file is run directly; every tool has a zod `inputSchema` with limits, `annotations`, and a description that states what it does, what it returns and what it refuses.
3. Keep logic in separate modules so it can be tested without MCP, and write `test/*.test.mjs` that connect over `InMemoryTransport` and call every tool at least once, including an invalid input.
4. No network unless the tool's purpose is network, and then: one documented host, an allowlist check before the request, `AbortSignal.timeout`, a response size cap, and a fake `fetch` in tests.
5. Add a row to the table above, a section in `CHANGELOG.md`, and run `npm run check:server-json`. The CI matrix picks up new workspaces automatically.

## Releasing

Set every package's `version` (they move together), add the release to `CHANGELOG.md`, and push a tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`release.yml` builds, tests, checks that every `version` matches the tag, then runs `npm publish --workspaces --provenance --access public`. Authentication is one of:

- **Trusted publishing (recommended).** On npmjs.com, for each package, add this repository and the workflow file name `release.yml` as a trusted publisher. No secret is needed; the workflow's `id-token: write` permission lets npm verify the GitHub OIDC token. The workflow upgrades npm first because trusted publishing needs npm 11.5.1 or newer.
- **An automation token.** Create a granular access token with publish rights and store it as the repository secret `NPM_TOKEN`; the workflow passes it as `NODE_AUTH_TOKEN`.

Provenance requires the workflow to run on GitHub-hosted runners from the public repository.

To list the servers in the [MCP registry](https://github.com/modelcontextprotocol/registry), each `server.json` is already in the registry's format and each `package.json` carries the matching `mcpName`; publish with the registry's `mcp-publisher` CLI from the package directory after the npm release.

## Related

- [agent-security-skills](https://github.com/basitalisandhu/agent-security-skills): Claude Code plugin and skill pack for securing LLM agents, including an MCP server over the AI agent incident dataset.
- [hisar](https://github.com/basitalisandhu/hisar): policy and control plane for agent tool calls.

## Licence

MIT. See [LICENSE](LICENSE).
