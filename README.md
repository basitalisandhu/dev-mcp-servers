# dev-mcp-servers

Ten small MCP servers for everyday development and security checks. Each one is a separate npm package you add to Claude Code, Claude Desktop, Cursor or any other MCP client with one line, and each does one job well: look up vulnerabilities, grade security headers, decode a JWT, test a regex, explain a cron expression, validate JSON against a schema, lint an OpenAPI document or a Dockerfile, read statistics out of a git repository, or build an `llms.txt`.

All servers are TypeScript on the official `@modelcontextprotocol/sdk`, speak stdio only, validate every input with zod, bound their inputs and run time, send no telemetry, and ship with `node:test` suites that cover every tool.

## Servers

| Server | Purpose | Install |
|---|---|---|
| [osv-advisories](packages/osv-advisories) | Query OSV.dev for known vulnerabilities by package and version; scan `package-lock.json`, `requirements.txt`, `poetry.lock` and `go.sum` | `claude mcp add osv-advisories -- npx -y @basitalisandhu/mcp-osv-advisories@0.1.1` |
| [security-headers](packages/security-headers) | Fetch a public URL's response headers and grade CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy and cookies | `claude mcp add security-headers -- npx -y @basitalisandhu/mcp-security-headers@0.1.1` |
| [jwt-tools](packages/jwt-tools) | Decode a JWT without verifying it, flag `alg: none`, expiry and missing claims, verify HS256/RS256 with a key, sign test tokens | `claude mcp add jwt-tools -- npx -y @basitalisandhu/mcp-jwt-tools@0.1.1` |
| [regex-lab](packages/regex-lab) | Test a regex against samples in a timeout-guarded worker, explain it, detect catastrophic backtracking | `claude mcp add regex-lab -- npx -y @basitalisandhu/mcp-regex-lab@0.1.1` |
| [cron-tools](packages/cron-tools) | Parse, explain and validate 5-field cron, list the next runs in a time zone | `claude mcp add cron-tools -- npx -y @basitalisandhu/mcp-cron-tools@0.1.1` |
| [json-schema-tools](packages/json-schema-tools) | Validate JSON with Ajv, infer a schema from samples, diff two schemas with a compatibility verdict | `claude mcp add json-schema-tools -- npx -y @basitalisandhu/mcp-json-schema-tools@0.1.1` |
| [openapi-lint](packages/openapi-lint) | Lint OpenAPI 3.x for missing security, responses, descriptions and versioning; list operations | `claude mcp add openapi-lint -- npx -y @basitalisandhu/mcp-openapi-lint@0.1.1` |
| [dockerfile-lint](packages/dockerfile-lint) | Lint Dockerfiles for root users, `latest` tags, secrets in `ENV`/`ARG`, missing `HEALTHCHECK`, apt without cleanup, `ADD` vs `COPY` | `claude mcp add dockerfile-lint -- npx -y @basitalisandhu/mcp-dockerfile-lint@0.1.1` |
| [git-insights](packages/git-insights) | Read-only git statistics: log, blame ownership, churn, authors, large files | `claude mcp add git-insights -- npx -y @basitalisandhu/mcp-git-insights@0.1.1` |
| [llms-txt](packages/llms-txt) | Generate `llms.txt` from local Markdown or a sitemap, check an existing one | `claude mcp add llms-txt -- npx -y @basitalisandhu/mcp-llms-txt@0.1.1` |

Every package README lists its tools with inputs and outputs, the exact `claude mcp add` command, a `.mcp.json` snippet, and what the server touches on disk and on the network.

## Quick start

With Claude Code:

```bash
claude mcp add jwt-tools -- npx -y @basitalisandhu/mcp-jwt-tools@0.1.1
claude mcp list
```

Add `-s user` to install for every project rather than the current one. For clients that read `.mcp.json` (Claude Code, Claude Desktop, Cursor), add an entry per server:

```json
{
  "mcpServers": {
    "jwt-tools": { "command": "npx", "args": ["-y", "@basitalisandhu/mcp-jwt-tools@0.1.1"] },
    "osv-advisories": { "command": "npx", "args": ["-y", "@basitalisandhu/mcp-osv-advisories@0.1.1"] }
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

Packages are published to GitHub Packages (npm and container images, see Install) when a version tag is pushed; until a tag exists for a version, install from a checkout.

## Install

Every release is published in two places by `publish-github-packages.yml`: an npm package per server on GitHub Packages, and a container image per server on the GitHub Container Registry. The `npx` commands above use npmjs.com, where the packages appear once that registry is set up (see Releasing).

| Server | npm (GitHub Packages) | Container (GHCR) |
|---|---|---|
| osv-advisories | `npm i -g @basitalisandhu/mcp-osv-advisories@0.1.1` | `docker run --rm -i ghcr.io/basitalisandhu/mcp-osv-advisories:0.1.1` |
| security-headers | `npm i -g @basitalisandhu/mcp-security-headers@0.1.1` | `docker run --rm -i ghcr.io/basitalisandhu/mcp-security-headers:0.1.1` |
| jwt-tools | `npm i -g @basitalisandhu/mcp-jwt-tools@0.1.1` | `docker run --rm -i ghcr.io/basitalisandhu/mcp-jwt-tools:0.1.1` |
| regex-lab | `npm i -g @basitalisandhu/mcp-regex-lab@0.1.1` | `docker run --rm -i ghcr.io/basitalisandhu/mcp-regex-lab:0.1.1` |
| cron-tools | `npm i -g @basitalisandhu/mcp-cron-tools@0.1.1` | `docker run --rm -i ghcr.io/basitalisandhu/mcp-cron-tools:0.1.1` |
| json-schema-tools | `npm i -g @basitalisandhu/mcp-json-schema-tools@0.1.1` | `docker run --rm -i ghcr.io/basitalisandhu/mcp-json-schema-tools:0.1.1` |
| openapi-lint | `npm i -g @basitalisandhu/mcp-openapi-lint@0.1.1` | `docker run --rm -i ghcr.io/basitalisandhu/mcp-openapi-lint:0.1.1` |
| dockerfile-lint | `npm i -g @basitalisandhu/mcp-dockerfile-lint@0.1.1` | `docker run --rm -i ghcr.io/basitalisandhu/mcp-dockerfile-lint:0.1.1` |
| git-insights | `npm i -g @basitalisandhu/mcp-git-insights@0.1.1` | `docker run --rm -i ghcr.io/basitalisandhu/mcp-git-insights:0.1.1` |
| llms-txt | `npm i -g @basitalisandhu/mcp-llms-txt@0.1.1` | `docker run --rm -i ghcr.io/basitalisandhu/mcp-llms-txt:0.1.1` |

### npm from GitHub Packages

Point the `@basitalisandhu` scope at GitHub Packages in `~/.npmrc`:

```
@basitalisandhu:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

GitHub's npm registry asks for a token even to install public packages. That is a GitHub limitation, not a setting of this repository: use a personal access token (classic) with the `read:packages` scope, exported as `GITHUB_TOKEN`. With that in place, install globally as in the table, or let the client start the server through `npx`:

```bash
claude mcp add jwt-tools -- npx -y @basitalisandhu/mcp-jwt-tools@0.1.1
```

Each package installs a `mcp-<server>` command (for example `mcp-jwt-tools`) that speaks MCP on stdio.

### Container images

Images are built for `linux/amd64` and `linux/arm64`, run as the non-root `node` user, and speak stdio, so `-i` is required and no port is published. Each image is tagged with the version and `latest`; pin the version.

With Claude Code:

```bash
claude mcp add jwt-tools -- docker run --rm -i ghcr.io/basitalisandhu/mcp-jwt-tools:0.1.1
```

With Cursor (`.cursor/mcp.json`) or any client that reads `.mcp.json`:

```json
{
  "mcpServers": {
    "jwt-tools": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "ghcr.io/basitalisandhu/mcp-jwt-tools:0.1.1"]
    }
  }
}
```

A container only sees the files you mount. For servers that read local files (`dockerfile-lint`, `openapi-lint`, `osv-advisories` lockfile scans, `llms-txt`), mount the directory read-only and pass paths inside it, for example `docker run --rm -i -v "$PWD:/work:ro" ghcr.io/basitalisandhu/mcp-openapi-lint:0.1.1` and then `/work/openapi.yaml`. For `git-insights`, mount the repository at `/repo` (the image marks only `/repo` as a safe git directory): `docker run --rm -i -v "$PWD:/repo:ro" ghcr.io/basitalisandhu/mcp-git-insights:0.1.1`.

Every image is signed with cosign (keyless) and carries a build provenance attestation; an SPDX SBOM per image is attached to the GitHub release. To check an image before running it:

```bash
cosign verify ghcr.io/basitalisandhu/mcp-jwt-tools:0.1.1 \
  --certificate-identity-regexp '^https://github.com/basitalisandhu/dev-mcp-servers/\.github/workflows/publish-github-packages\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/basitalisandhu/mcp-jwt-tools:0.1.1 --owner basitalisandhu
```

To build an image locally from a checkout: `docker build --build-arg SERVER=jwt-tools -t mcp-jwt-tools .`

## Security posture

- **Stdio only.** No server opens a port. Each one is a child process of your MCP client and exits with it.
- **Validated, bounded inputs.** Every tool input has a zod schema with length and range limits; files are read with size caps; regex runs, HTTP requests and git commands have timeouts; results are capped.
- **Network only where the job is network, and only to the documented host.** `osv-advisories` talks to `api.osv.dev` and refuses any other origin. `security-headers` fetches the URL you give it, refuses private, loopback, link-local and cloud-metadata addresses (including names that resolve to them), limits redirects and never reads a body. The other eight servers make no network requests at all.
- **Read-only.** No server writes files, runs a shell, or modifies a repository. `git-insights` spawns `git` without a shell from fixed argument lists with validated paths and revisions and `GIT_OPTIONAL_LOCKS=0`; the output of `llms-txt` is returned as text for you to save.
- **No telemetry.** Nothing phones home. There are no analytics, update checks or crash reporters.
- **Honest tool descriptions.** Tool descriptions say what the tool does and returns. They contain no instructions aimed at the model, and the outputs of `decode_jwt` and the lints say when something is unverified or heuristic.
- **Small dependency trees.** Runtime dependencies are `@modelcontextprotocol/sdk` and `zod`, plus `ajv` and `ajv-formats` for json-schema-tools and `yaml` for openapi-lint. `npm ci` from the committed lockfile reproduces the exact tree.
- **Provenance.** Container images get a build provenance attestation and a keyless cosign signature from the workflow run that built them, plus an SPDX SBOM on the release. When the npmjs.com release is enabled it publishes with `npm publish --provenance`, so each npmjs version links to its commit and workflow run.

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
.github/workflows/publish-github-packages.yml   npm packages and GHCR images on a version tag
.github/workflows/release.yml   npmjs.com publish with provenance (off until NPMJS_PUBLISH is set)
Dockerfile                      one image per server: --build-arg SERVER=<name>
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

Set every package's `version` (they move together), add the release to `CHANGELOG.md`, and push an annotated tag:

```bash
git tag -a v0.1.1 -m "0.1.1" && git push origin v0.1.1
```

`publish-github-packages.yml` builds, tests, checks that every `version` matches the tag, then:

- publishes each workspace to GitHub Packages npm with the workflow's `GITHUB_TOKEN` (a version that already exists is skipped, so a re-run is safe);
- builds and pushes `ghcr.io/basitalisandhu/mcp-<server>:<version>` and `:latest` for every server, generates an SPDX SBOM, records a build provenance attestation and signs the image digest with cosign;
- creates the GitHub release for the tag with generated notes and the SBOMs attached.

No secret is needed. Pull requests that change the Dockerfile, the workflow or a `package.json` run the same build as a dry run.

`release.yml` publishes the same packages to npmjs.com and is off until the repository variable `NPMJS_PUBLISH` is `true`. Before turning it on, set up one of:

- **Trusted publishing (recommended).** On npmjs.com, for each package, add this repository and the workflow file name `release.yml` as a trusted publisher. No secret is needed; the workflow's `id-token: write` permission lets npm verify the GitHub OIDC token. The workflow upgrades npm first because trusted publishing needs npm 11.5.1 or newer.
- **An automation token.** Create a granular access token with publish rights and store it as the repository secret `NPM_TOKEN`; the workflow passes it as `NODE_AUTH_TOKEN`.

It passes `--registry https://registry.npmjs.org`, which overrides the GitHub Packages registry in each `publishConfig`. Provenance requires the workflow to run on GitHub-hosted runners from the public repository.

To list the servers in the [MCP registry](https://github.com/modelcontextprotocol/registry), each `server.json` is already in the registry's format and each `package.json` carries the matching `mcpName`; publish with the registry's `mcp-publisher` CLI from the package directory after the npm release.

## Related

More tools by the same author: https://github.com/basitalisandhu

- [agent-security-skills](https://github.com/basitalisandhu/agent-security-skills): Claude Code plugin and skill pack for securing LLM agents, including an MCP server over the AI agent incident dataset.

## Licence

MIT. See [LICENSE](LICENSE).
