# cron-tools MCP server

Parses, explains, validates and schedules 5-field cron expressions in the Vixie cron dialect (Linux crontab, GitHub Actions, most schedulers), including lists, ranges, steps, month and weekday names, 0 or 7 for Sunday and the `@hourly` to `@yearly` macros. Time zone arithmetic uses `Intl` only; there are no dependencies beyond the MCP SDK and zod.

Part of [dev-mcp-servers](https://github.com/basitalisandhu/dev-mcp-servers). Stdio transport only; the server never opens a port.

## Tools

| Tool | Input | What it returns |
|---|---|---|
| `parse_cron` | `expression` | Per field: raw text, wildcard flag and every accepted value; plus the normalised expression and macro expansion. |
| `explain_cron` | `expression` | One English sentence, for example `*/15 9-17 * * 1-5` is "At every 15th minute past every hour from 9 through 17 on Monday through Friday." |
| `validate_cron` | `expression` | `valid`, errors, and warnings: both day fields restricted (OR semantics), days that never occur in the chosen months, `7` for Sunday, `?` spelling, macro expansion. |
| `next_runs` | `expression`, `count?` (1 to 100), `timezone?` (IANA), `from?` (ISO 8601) | Upcoming run times in local time with offset and in UTC. Wall-clock times skipped by a forward DST transition are not run that day; a repeated hour runs twice. Stops after ten years. |

## Install

Claude Code:

```bash
claude mcp add cron-tools -- npx -y @basitalisandhu/mcp-cron-tools@0.1.1
```

Add `-s user` to make it available in every project. Any client that reads `.mcp.json` (Claude Code, Claude Desktop, Cursor):

```json
{
  "mcpServers": {
    "cron-tools": {
      "command": "npx",
      "args": ["-y", "@basitalisandhu/mcp-cron-tools@0.1.1"]
    }
  }
}
```

Pin the version as shown so that an update to the package cannot change what runs in your editor without you noticing. From a checkout, use `"command": "node", "args": ["<path>/packages/cron-tools/dist/index.js"]` after `npm install && npm run build` at the repository root.

## What it touches

- Network: None.
- Local files: None.
- Telemetry: none.

## Notes

- Seconds fields (6-field Quartz) and `L`, `W`, `#` are rejected with an explanation.
- When both day-of-month and day-of-week are restricted, a day matches if either does, as in Vixie cron.

## Build and test

```bash
npm install        # at the repository root
npm run build -w @basitalisandhu/mcp-cron-tools
npm test -w @basitalisandhu/mcp-cron-tools
```

Tests use `node:test` and the SDK's in-memory transport; they do not reach the network.

## Licence

MIT. See [LICENSE](../../LICENSE).
