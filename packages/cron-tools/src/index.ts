#!/usr/bin/env node
/**
 * cron-tools: parse, explain, validate and schedule 5-field cron expressions.
 *
 * Transport: stdio only. No network, no file access, no dependencies beyond the MCP SDK and zod.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DAY_NAMES_EXPORT, MAX_RUNS, explainCron, formatLocal, isValidTimeZone, localParts, nextRuns, parseCron, validateCron } from "./cron.js";

export const SERVER_NAME = "cron-tools";
export const SERVER_VERSION = "0.1.0";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const expressionSchema = z.string().min(1).max(200).describe("Five space-separated fields (minute hour day-of-month month day-of-week) or a macro such as @daily.");
const pure = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Handles 5-field cron expressions in the Vixie cron dialect used by Linux crontab, GitHub Actions and most schedulers: lists (1,15), ranges (1-5), steps (*/10, 1-30/5), " +
        "month and weekday names, 0 or 7 for Sunday, and @hourly/@daily/@weekly/@monthly/@yearly. Seconds fields and Quartz L/W/# are rejected with an explanation. " +
        "parse_cron shows the accepted values per field, explain_cron gives an English sentence, validate_cron lists errors and warnings, next_runs computes upcoming run times in an IANA time zone.",
    },
  );

  server.registerTool(
    "parse_cron",
    {
      title: "Parse a cron expression",
      description:
        "Parse a 5-field cron expression (or @ macro) and return, for each field, the raw text, whether it is a wildcard, and every value it accepts, plus the normalised expression. " +
        "Returns an error with the offending field when the expression is invalid.",
      inputSchema: { expression: expressionSchema },
      annotations: pure,
    },
    async ({ expression }) => {
      try {
        const p = parseCron(expression);
        return json({ expression: p.expression, normalised: p.normalised, macro: p.macro ?? null, fields: Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, { raw: v.raw, wildcard: v.wildcard, values: v.values }])) });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "explain_cron",
    {
      title: "Explain a cron expression in English",
      description:
        "Translate a 5-field cron expression into one English sentence, for example '*/15 9-17 * * 1-5' becomes 'At every 15th minute past every hour from 9 through 17 on Monday through Friday.' " +
        "When both day fields are restricted the sentence says 'or', matching Vixie cron semantics. Also returns the validation warnings.",
      inputSchema: { expression: expressionSchema },
      annotations: pure,
    },
    async ({ expression }) => {
      const v = validateCron(expression);
      if (!v.valid) return fail(v.errors.join("; "));
      return json({ expression, normalised: v.parsed?.normalised, explanation: explainCron(expression), warnings: v.warnings });
    },
  );

  server.registerTool(
    "validate_cron",
    {
      title: "Validate a cron expression",
      description:
        "Check a 5-field cron expression and return valid (boolean), errors (syntax or range problems) and warnings for expressions that parse but behave unexpectedly: " +
        "day-of-month and day-of-week both restricted (OR semantics), days that do not exist in the selected months, 7 used for Sunday, ? spelling, macro expansion.",
      inputSchema: { expression: expressionSchema },
      annotations: pure,
    },
    async ({ expression }) => {
      const v = validateCron(expression);
      return json({ expression, valid: v.valid, errors: v.errors, warnings: v.warnings, normalised: v.parsed?.normalised ?? null });
    },
  );

  server.registerTool(
    "next_runs",
    {
      title: "List the next runs of a cron expression",
      description:
        `Compute the next count (1 to ${MAX_RUNS}, default 5) run times of a 5-field cron expression in an IANA time zone (default UTC), starting strictly after 'from' ` +
        "(ISO 8601 date-time, default now). Each run is returned in the zone's local time with its UTC offset and in UTC. Daylight-saving transitions follow the zone's rules: " +
        "a wall-clock time skipped by a forward transition is not run that day, and a repeated hour runs twice. Reports when no run exists within ten years.",
      inputSchema: {
        expression: expressionSchema,
        count: z.number().int().min(1).max(MAX_RUNS).optional(),
        timezone: z.string().min(1).max(64).optional().describe("IANA zone such as Europe/Berlin or America/New_York. Default UTC."),
        from: z.string().max(40).optional().describe("ISO 8601 date-time to start after, for example 2026-01-31T09:00:00Z. Default: now."),
      },
      annotations: pure,
    },
    async ({ expression, count, timezone, from }) => {
      const tz = timezone ?? "UTC";
      if (!isValidTimeZone(tz)) return fail(`${JSON.stringify(tz)} is not a known IANA time zone.`);
      let fromMs = Date.now();
      if (from !== undefined) {
        fromMs = Date.parse(from);
        if (!Number.isFinite(fromMs)) return fail(`${JSON.stringify(from)} is not an ISO 8601 date-time.`);
      }
      const v = validateCron(expression);
      if (!v.valid || !v.parsed) return fail(v.errors.join("; "));
      const n = count ?? 5;
      const runs = nextRuns(v.parsed, fromMs, tz, n);
      return json({
        expression,
        timezone: tz,
        from: new Date(fromMs).toISOString(),
        explanation: explainCron(expression),
        warnings: v.warnings,
        found: runs.length,
        ...(runs.length < n ? { note: runs.length === 0 ? "No run within ten years of 'from'." : `Only ${runs.length} run(s) within ten years of 'from'.` } : {}),
        runs: runs.map((ms) => ({ local: formatLocal(ms, tz), utc: new Date(ms).toISOString(), weekday: DAY_NAMES_EXPORT[localParts(ms, tz).weekday] })),
      });
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Compare real paths: an installed bin (npx, npm i -g) is a symlink, so argv[1] differs from import.meta.url.
function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

const invokedDirectly = isInvokedDirectly();
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[${SERVER_NAME}] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
