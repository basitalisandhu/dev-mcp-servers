#!/usr/bin/env node
/**
 * dockerfile-lint: parse and lint Dockerfiles.
 *
 * Transport: stdio only. No network. Reads one local file per call when a path is given; never runs docker.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { MAX_DOCKERFILE_BYTES, RULES, lint, parseDockerfile } from "./dockerfile.js";

export const SERVER_NAME = "dockerfile-lint";
export const SERVER_VERSION = "0.1.0";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const sourceShape = {
  path: z.string().min(1).max(4096).optional().describe(`Path to a local Dockerfile (up to ${MAX_DOCKERFILE_BYTES} bytes).`),
  content: z.string().min(1).max(MAX_DOCKERFILE_BYTES).optional().describe("Dockerfile text. Alternative to path."),
};
const ruleNames = Object.keys(RULES) as [string, ...string[]];
const localRead = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

async function load(input: { path?: string; content?: string }): Promise<{ text: string; source: string }> {
  if ((input.path && input.content) || (!input.path && !input.content)) throw new Error("supply exactly one of path or content");
  if (input.content !== undefined) return { text: input.content, source: "inline" };
  const abs = resolve(input.path as string);
  const st = await stat(abs).catch((err: Error) => {
    throw new Error(`cannot read ${abs}: ${err.message}`);
  });
  if (!st.isFile()) throw new Error(`${abs} is not a file`);
  if (st.size > MAX_DOCKERFILE_BYTES) throw new Error(`${abs} is ${st.size} bytes; the limit is ${MAX_DOCKERFILE_BYTES}`);
  return { text: await readFile(abs, "utf8"), source: abs };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Lints Dockerfiles without running Docker. lint_dockerfile returns findings with rule ids, line numbers and fixes; parse_dockerfile returns the instructions and build stages; " +
        `explain_rule documents one rule. Rules: ${ruleNames.join(", ")}. Findings are static observations about the file; they do not scan the image or its packages.`,
    },
  );

  server.registerTool(
    "lint_dockerfile",
    {
      title: "Lint a Dockerfile",
      description:
        "Parse a Dockerfile (comments, escape directive, line continuations, heredocs, multi-stage builds) and return findings sorted by severity with line numbers and fixes. " +
        "Checks: final stage running as root, base images without a tag or with :latest, images without a digest, credential-like names in ENV or ARG, credential literals in RUN, " +
        "missing HEALTHCHECK, apt-get install without list cleanup or --no-install-recommends, apt-get upgrade, apk add without --no-cache, pip without --no-cache-dir, ADD for plain files " +
        "or remote URLs, curl piped to a shell, sudo, relative WORKDIR, repeated CMD or ENTRYPOINT, shell-form CMD, EXPOSE 22, MAINTAINER, copying the whole build context, " +
        "and COPY after USER without --chown. Pass ignore to silence rule ids.",
      inputSchema: { ...sourceShape, ignore: z.array(z.enum(ruleNames)).max(50).optional().describe("Rule ids to skip.") },
      annotations: localRead,
    },
    async ({ path, content, ignore }) => {
      try {
        const { text, source } = await load({ path, content });
        const parsed = parseDockerfile(text);
        const findings = lint(parsed, { ignore });
        const counts = { error: 0, warning: 0, info: 0 };
        for (const f of findings) counts[f.severity]++;
        return json({ source, instructions: parsed.instructions.length, stages: parsed.stages.map((s) => ({ index: s.index, name: s.name, base: s.base, line: s.line })), ...counts, findings });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "parse_dockerfile",
    {
      title: "Parse a Dockerfile",
      description:
        "Return the Dockerfile's instructions in order (instruction keyword, arguments with continuations joined, start and end line, stage index) and its build stages " +
        "(index, AS name, base image, line), plus the escape character in effect.",
      inputSchema: sourceShape,
      annotations: localRead,
    },
    async ({ path, content }) => {
      try {
        const { text, source } = await load({ path, content });
        const parsed = parseDockerfile(text);
        return json({ source, escape: parsed.escape, stages: parsed.stages, instructions: parsed.instructions });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "explain_rule",
    {
      title: "Explain a lint rule",
      description: `Describe one lint rule: its default severity, what it detects and how to fix it. Rules: ${ruleNames.join(", ")}.`,
      inputSchema: { rule: z.enum(ruleNames) },
      annotations: localRead,
    },
    async ({ rule }) => json({ rule, ...RULES[rule] }),
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
