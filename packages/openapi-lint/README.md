# openapi-lint

Lint an OpenAPI 3.x document (JSON or YAML, from a local path or inline) and list its operations with their effective security. Only local `#/` references are resolved; nothing is fetched.

Part of [dev-mcp-servers](https://github.com/basitalisandhu/dev-mcp-servers). Stdio transport only; the server never opens a port.

## Tools

| Tool | Input | What it returns |
|---|---|---|
| `lint_openapi` | `path` or `document`, `ignore?` | Findings sorted by severity with rule id, JSON Pointer path and message: openapi version, http servers, missing, unused or undefined security schemes, API keys in the query string, HTTP Basic schemes, operations without security (and explicitly public ones), operations without responses, success responses or error responses, undescribed responses and parameters, path parameters not declared or not required, missing or duplicate operationIds, unversioned paths, empty request bodies, deprecated operations, undeclared tags. |
| `list_operations` | `path` or `document`, `tag?`, `method?`, `path_prefix?` | Every operation with operationId, summary, tags, deprecated flag, effective security (`public` for `security: []`, `inherited-none` when nothing applies), parameters, request media types and response codes. |
| `get_operation` | `path` or `document`, `operation_id` or `method` + `operation_path` | One operation in full with path-level parameters merged and local references resolved. |
| `explain_rule` | `rule` | Severity, what the rule detects and how to fix it. |
