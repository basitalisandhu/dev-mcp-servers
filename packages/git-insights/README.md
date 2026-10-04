# git-insights MCP server

Read-only statistics for a local git repository: log, blame ownership, churn, authors and large files. Every command is spawned without a shell from a fixed argument list, with validated paths and revisions, a 20 s timeout, an output cap and `GIT_OPTIONAL_LOCKS=0`. Nothing is written, fetched or checked out.

Part of [dev-mcp-servers](https://github.com/basitalisandhu/dev-mcp-servers). Stdio transport only; the server never opens a port.

## Tools

| Tool | Input | What it returns |
|---|---|---|
| `repo_summary` | `repo` | Top level, branch, HEAD commit, remotes (credentials stripped from URLs), commit, tag and branch counts, modified and untracked file counts. |
| `git_log` | `repo`, `rev?`, `limit?` (1 to 500), `path?`, `author?`, `since?`, `until?`, `grep?`, `no_merges?`, `with_files?` | Commits newest first with hash, author, ISO date, subject and optionally the files touched. |
| `blame_summary` | `repo`, `path`, `rev?`, `ignore_whitespace?` | Lines, percentage and latest commit per author for one file. |
| `churn` | `repo`, `rev?`, `since?`, `until?`, `path?`, `limit?`, `max_commits?` | Files ranked by commits touching them with lines added and removed; renames are followed to the current name. |
| `authors` | `repo`, `rev?`, `since?`, `until?`, `path?`, `include_merges?`, `limit?` | Commits per author (by email) with first and last commit dates. |
| `large_files` | `repo`, `rev?`, `limit?`, `include_history?` | Largest blobs in a tree, or across all history (what makes a clone big). |

## Install

Claude Code:

```bash
claude mcp add git-insights -- npx -y @basitalisandhu/mcp-git-insights@0.1.1
```

Add `-s user` to make it available in every project. Any client that reads `.mcp.json` (Claude Code, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "git-insights": {
      "command": "npx",
      "args": ["-y", "@basitalisandhu/mcp-git-insights@0.1.1"]
    }
  }
}
```

Pin the version as shown so that an update to the package cannot change what runs in your editor without you noticing. From a checkout, use `"command": "node", "args": ["<path>/packages/git-insights/dist/index.js"]` after `npm install && npm run build` at the repository root.

## What it touches

- Network: None. `git` is run with `GIT_TERMINAL_PROMPT=0`; no command that contacts a remote is on the allowlist.
- Local files: Runs `git rev-parse`, `log`, `blame`, `ls-tree`, `rev-list`, `cat-file`, `status`, `remote`, `tag` and `branch` in the repository you name. Revisions must match `[A-Za-z0-9._/^~-]` without `..`; paths must be relative without `..`; free-text filters may not start with `-`.
- Telemetry: none.

## Notes

- The server does not restrict which repository paths may be read; run it under an account that should be able to read them.
- Requires `git` on `PATH`.

## Build and test

```bash
npm install        # at the repository root
npm run build -w @basitalisandhu/mcp-git-insights
npm test -w @basitalisandhu/mcp-git-insights
```

Tests use `node:test` and the SDK's in-memory transport; they do not reach the network.

## Licence

MIT. See [LICENSE](../../LICENSE).
