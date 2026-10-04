#!/usr/bin/env node
/**
 * regex-lab: test, explain and stress regular expressions.
 *
 * Transport: stdio only. No network, no file access. Every regex execution happens in a worker thread
 * that is terminated when it exceeds the timeout.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { RegexSyntaxError, explain, parse } from "./ast.js";
import { analyse } from "./redos.js";
import { DEFAULT_TIMEOUT_MS, MAX_MATCHES_PER_SAMPLE, MAX_TIMEOUT_MS, probeRegex, runRegex } from "./runner.js";

export const SERVER_NAME = "regex-lab";
export const SERVER_VERSION = "0.1.0";
const MAX_PATTERN = 2000;
const MAX_SAMPLE = 20_000;
const MAX_SAMPLES = 50;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const patternSchema = z.string().min(1).max(MAX_PATTERN).describe("JavaScript regular expression source, without the surrounding slashes.");
const flagsSchema = z.string().max(8).regex(/^[dgimsuvy]*$/, "flags are a combination of d g i m s u v y").optional().describe("RegExp flags such as i, m, s, u. g and d are added automatically when matching.");
const pure = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function validateFlags(flags: string): string | undefined {
  if (new Set(flags).size !== flags.length) return "duplicate flag";
  if (flags.includes("u") && flags.includes("v")) return "u and v flags cannot be combined";
  return undefined;
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Works with JavaScript (ECMAScript) regular expressions. test_regex runs a pattern against sample strings in a worker with a timeout and reports every match with group captures; " +
        "explain_regex describes the pattern construct by construct; check_redos looks for catastrophic backtracking shapes and can time the pattern against crafted inputs. " +
        "Syntax follows the V8 engine in Node.js; other engines (PCRE, RE2, Python re) differ in details such as lookbehind and possessive quantifiers.",
    },
  );

  server.registerTool(
    "test_regex",
    {
      title: "Test a regex against samples",
      description:
        `Run a pattern against up to ${MAX_SAMPLES} sample strings (each up to ${MAX_SAMPLE} characters) and return every match with its start and end offsets, matched text, ` +
        "numbered and named capture groups with their offsets, and optionally the result of String.prototype.replace with the given replacement. Execution runs in a " +
        `worker thread and is stopped after timeout_ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}); results for samples finished before the timeout are still returned. ` +
        `At most ${MAX_MATCHES_PER_SAMPLE} matches per sample are listed.`,
      inputSchema: {
        pattern: patternSchema,
        flags: flagsSchema,
        samples: z.array(z.string().max(MAX_SAMPLE)).min(1).max(MAX_SAMPLES),
        replacement: z.string().max(2000).optional().describe("If given, each sample is also shown after replace(pattern, replacement); $1 and $<name> work as in JavaScript."),
        timeout_ms: z.number().int().min(50).max(MAX_TIMEOUT_MS).optional(),
      },
      annotations: pure,
    },
    async ({ pattern, flags, samples, replacement, timeout_ms }) => {
      const f = flags ?? "";
      const flagError = validateFlags(f);
      if (flagError) return fail(flagError);
      const out = await runRegex(pattern, f, samples, { timeoutMs: timeout_ms, replacement });
      if (out.error) return fail(`Invalid pattern: ${out.error}`);
      return json({
        pattern,
        flags: f,
        timed_out: out.timed_out,
        elapsed_ms: out.elapsed_ms,
        samples_completed: out.results.length,
        samples_total: samples.length,
        ...(out.timed_out ? { note: `Execution exceeded ${timeout_ms ?? DEFAULT_TIMEOUT_MS} ms and was terminated; run check_redos on this pattern.` } : {}),
        results: out.results,
      });
    },
  );

  server.registerTool(
    "explain_regex",
    {
      title: "Explain a regex",
      description:
        "Parse a pattern and describe it construct by construct: literals, character classes, escapes, anchors, groups (capturing, named, non-capturing, lookaround), " +
        "quantifiers (greedy and lazy) and alternation, as indented lines plus the number of capturing groups. Reports a syntax error with its position when the pattern does not parse.",
      inputSchema: { pattern: patternSchema, flags: flagsSchema },
      annotations: pure,
    },
    async ({ pattern, flags }) => {
      const f = flags ?? "";
      const flagError = validateFlags(f);
      if (flagError) return fail(flagError);
      try {
        new RegExp(pattern, f);
      } catch (err) {
        return fail(`Invalid pattern: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const { ast, groups } = parse(pattern);
        const flagNotes: Record<string, string> = { i: "case-insensitive", m: "^ and $ match at line breaks", s: ". matches line terminators", u: "Unicode mode", v: "Unicode sets mode", g: "global", y: "sticky", d: "match indices" };
        return json({ pattern, flags: f, flag_meanings: [...f].map((c) => `${c}: ${flagNotes[c]}`), capturing_groups: groups, explanation: explain(ast) });
      } catch (err) {
        if (err instanceof RegexSyntaxError) return fail(`Could not parse pattern at position ${err.position}: ${err.message}`);
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "check_redos",
    {
      title: "Check a regex for catastrophic backtracking",
      description:
        "Statically look for the constructs that cause exponential or polynomial backtracking: an unbounded repeat nested inside another (such as (a+)+ or (\\d+\\s?)*), " +
        "alternatives that can match the same text inside a repeated group (such as (a|ab)*), and consecutive repeats that accept the same characters (such as \\d+\\d+). " +
        "Each finding names the construct, a severity (high: likely exponential; medium: polynomial or needs review) and a character that exercises it. With probe (default true), " +
        "the pattern is then timed in a worker against crafted non-matching inputs of growing length (from the probe character) and the timings are returned; the worker is " +
        `terminated after timeout_ms (default ${DEFAULT_TIMEOUT_MS}). No findings and flat timings is good evidence, not a proof, that the pattern is safe.`,
      inputSchema: {
        pattern: patternSchema,
        flags: flagsSchema,
        probe: z.boolean().optional().describe("Time the pattern against crafted inputs. Default true."),
        timeout_ms: z.number().int().min(50).max(MAX_TIMEOUT_MS).optional(),
      },
      annotations: pure,
    },
    async ({ pattern, flags, probe, timeout_ms }) => {
      const f = flags ?? "";
      const flagError = validateFlags(f);
      if (flagError) return fail(flagError);
      try {
        new RegExp(pattern, f);
      } catch (err) {
        return fail(`Invalid pattern: ${err instanceof Error ? err.message : String(err)}`);
      }
      let findings;
      try {
        findings = analyse(pattern, f);
      } catch (err) {
        if (err instanceof RegexSyntaxError) return fail(`Could not parse pattern at position ${err.position}: ${err.message}`);
        return fail(err instanceof Error ? err.message : String(err));
      }
      const verdict = findings.some((x) => x.severity === "high") ? "likely vulnerable" : findings.length ? "review" : "no known backtracking hazard found";
      if (probe === false) return json({ pattern, flags: f, verdict, findings });
      const chars = [...new Set(findings.map((x) => x.probe_char).filter((c): c is string => c !== null))];
      if (chars.length === 0) chars.push("a");
      const probes = [];
      for (const ch of chars.slice(0, 3)) {
        const inputs = [10, 14, 18, 22, 26, 30].map((n) => `${ch.repeat(n)}\u0001`);
        const out = await probeRegex(pattern, f, inputs, timeout_ms ?? DEFAULT_TIMEOUT_MS);
        const growth: number[] = [];
        for (let i = 1; i < out.timings.length; i++) {
          const prev = out.timings[i - 1].ms;
          growth.push(prev > 0.05 ? Math.round((out.timings[i].ms / prev) * 10) / 10 : 1);
        }
        const exponential = out.timed_out || (growth.length >= 3 && growth.slice(-3).every((g) => g >= 1.8));
        probes.push({ probe_char: ch, timed_out: out.timed_out, timings: out.timings, growth_factors: growth, assessment: exponential ? "timing grows exponentially or hit the timeout: confirmed catastrophic backtracking" : "timing stays flat: no blow-up observed with this input shape" });
      }
      const confirmed = probes.some((p) => p.assessment.startsWith("timing grows"));
      return json({ pattern, flags: f, verdict: confirmed ? "confirmed vulnerable" : verdict, findings, probes });
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[${SERVER_NAME}] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
