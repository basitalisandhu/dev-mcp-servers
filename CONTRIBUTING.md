# Contributing

Thank you for improving these servers. The repository values precision over volume: a tool that does one thing correctly, with a clear description and a test, beats three that almost work.

## Ground rules

- **No telemetry, no surprise network calls.** Network access is allowed only where the tool's purpose is network, and then only to the documented host, with an allowlist check before the request, a timeout and a response size cap. Tests must use a fake `fetch`.
- **Stdio only.** Do not add HTTP or SSE transports.
- **Bounded inputs.** Every tool input needs a zod schema with length or range limits. Files are read with size caps. Anything that can loop or recurse has an iteration or depth cap.
- **Read-only.** Servers do not write files or run shells. If a tool needs a subprocess (as git-insights does), spawn it without a shell, from a fixed argument list, with validated arguments after `--`, a timeout and an output cap.
- **Minimal dependencies.** `@modelcontextprotocol/sdk` and `zod` are the baseline. Add a dependency only when implementing the thing yourself would be larger than the dependency and worse; say why in the pull request.
- **Tool descriptions are read by models.** Say what the tool does, what it returns, what it refuses and what its limits are. Do not put instructions to the model in a description, and do not overstate certainty: a heuristic is called a heuristic.
- **Tests come with code.** Every tool is called at least once over `InMemoryTransport` in `test/*.test.mjs`, including with an invalid input. Logic lives in modules that can be tested without MCP.
- **No model version strings** in code, descriptions or docs; the servers work with whatever model the client runs.
- **Plain language.** Write for a developer who has not used MCP before. Avoid em-dashes; use commas, colons or full stops.

## Workflow

```bash
npm install
npm run build
npm test
npm run check:server-json
```

Work in one package at a time: `npm test -w @basitalisandhu/mcp-<name>`. Node 20 and 22 are both supported; CI runs both.

## Adding a tool or a server

See "Adding a server" in [README.md](README.md). For a new tool in an existing server: register it in `src/index.ts` with a schema, annotations and a description; implement the logic in a module; add tests; add a row to the package README's tool table and a line to `CHANGELOG.md`.

## Pull requests

- One topic per pull request.
- Describe what changed, why, and how you tested it.
- Changes to lint rules, graders or heuristics need a before/after example (a fixture that now produces or no longer produces a finding).
- By contributing you agree that your contribution is licensed under the MIT licence of this repository.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please do not file security problems as public issues.
