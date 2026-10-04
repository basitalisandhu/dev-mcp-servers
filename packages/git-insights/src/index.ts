#!/usr/bin/env node
/**
 * git-insights: read-only git statistics for a local repository.
 *
 * Transport: stdio only. No network. Runs an allowlisted set of git commands (rev-parse, log, blame,
 * ls-tree, rev-list, cat-file, status, remote, tag) with validated arguments and never writes.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { GitError, openRepo, pipeGit, runGit, safePath, safeRev, safeText, sanitizeRemoteUrl } from "./git.js";

export const SERVER_NAME = "git-insights";
export const SERVER_VERSION = "0.1.1";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const repoSchema = z.string().min(1).max(4096).describe("Path to the repository (any directory inside the work tree).");
const revSchema = z.string().min(1).max(200).optional().describe("Branch, tag, commit or HEAD~n. Default HEAD.");
const sinceSchema = z.string().min(1).max(64).optional().describe("Only commits after this date, in any form git accepts, for example 2026-01-01 or '3 months ago'.");
const untilSchema = z.string().min(1).max(64).optional().describe("Only commits before this date.");
const pathSchema = z.string().min(1).max(1024).optional().describe("Limit to this file or directory, relative to the repository root.");
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const SEP = "\u001f";

/** git prints UTC offsets as +00:00 or Z depending on its version; keep one canonical form. */
const isoZ = (d: string): string => d.replace(/\+00:00$/, "Z");
const REC = "\u001e";

/** Split a --numstat rename such as "src/{a.ts => b.ts}" or "a.ts => dir/b.ts" into its old and new paths. */
export function renamePaths(raw: string): { oldPath: string; newPath: string } | null {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braced) return { oldPath: `${braced[1]}${braced[2]}${braced[4]}`.replace(/\/\/+/g, "/"), newPath: `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/\/+/g, "/") };
  const plain = /^(.+) => (.+)$/.exec(raw);
  if (plain) return { oldPath: plain[1], newPath: plain[2] };
  return null;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try {
    return await fn();
  } catch (err) {
    return fail(err instanceof GitError ? err.message : `unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only statistics for a local git repository: repo_summary (branch, head, remotes, counts), git_log (commits with filters), blame_summary (who owns the lines of a file), " +
        "churn (files changed most often, with lines added and removed), authors (commits per author with first and last dates) and large_files (biggest blobs in a tree or in history). " +
        "Every tool takes a repo path. Nothing is written, fetched or checked out; remote URLs are shown with credentials removed.",
    },
  );

  server.registerTool(
    "repo_summary",
    {
      title: "Summarise a repository",
      description:
        "Return the repository's top-level path, current branch, HEAD commit (hash, author, date, subject), remotes with credential-free URLs, number of commits reachable from HEAD, " +
        "number of tags and local branches, and the count of modified or untracked files in the work tree.",
      inputSchema: { repo: repoSchema },
      annotations: readOnly,
    },
    async ({ repo }) =>
      guarded(async () => {
        const info = await openRepo(repo);
        const top = info.bare ? info.path : info.top_level;
        const branch = (await runGit(top, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
        const headRaw = await runGit(top, ["log", "-1", `--format=%H${SEP}%an${SEP}%aI${SEP}%s`]).catch(() => "");
        const [hash, author, dateRaw, subject] = headRaw.trim().split(SEP);
        const date = dateRaw ? isoZ(dateRaw) : dateRaw;
        const remotes = (await runGit(top, ["remote", "-v"]).catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split(/\s+/))
          .filter((p) => p[2] === "(fetch)")
          .map((p) => ({ name: p[0], url: sanitizeRemoteUrl(p[1]) }));
        const commitCount = Number((await runGit(top, ["rev-list", "--count", "HEAD"]).catch(() => "0")).trim());
        const tags = (await runGit(top, ["tag", "--list"]).catch(() => "")).trim().split("\n").filter(Boolean).length;
        const branches = (await runGit(top, ["branch", "--list", "--format=%(refname:short)"]).catch(() => "")).trim().split("\n").filter(Boolean).length;
        const status = info.bare ? "" : await runGit(top, ["status", "--porcelain", "--untracked-files=normal"]).catch(() => "");
        const statusLines = status.split("\n").filter(Boolean);
        return json({
          path: info.path,
          top_level: top,
          bare: info.bare,
          branch: branch === "HEAD" ? "(detached)" : branch,
          head: hash ? { hash, author, date, subject } : null,
          remotes,
          commits: commitCount,
          tags,
          branches,
          work_tree: info.bare ? null : { modified: statusLines.filter((l) => !l.startsWith("??")).length, untracked: statusLines.filter((l) => l.startsWith("??")).length },
        });
      }),
  );

  server.registerTool(
    "git_log",
    {
      title: "List commits",
      description:
        "List commits reachable from rev (default HEAD), newest first, with hash, short hash, author name and email, ISO date, subject and (optionally) the files touched. " +
        "Filters: path, author (substring of name or email), since, until, grep (substring of the message), no_merges. limit is 1 to 500, default 50.",
      inputSchema: {
        repo: repoSchema,
        rev: revSchema,
        limit: z.number().int().min(1).max(500).optional(),
        path: pathSchema,
        author: z.string().min(1).max(200).optional(),
        since: sinceSchema,
        until: untilSchema,
        grep: z.string().min(1).max(200).optional(),
        no_merges: z.boolean().optional(),
        with_files: z.boolean().optional().describe("Include the list of files changed by each commit. Default false."),
      },
      annotations: readOnly,
    },
    async ({ repo, rev, limit, path, author, since, until, grep, no_merges, with_files }) =>
      guarded(async () => {
        const info = await openRepo(repo);
        const args = ["log", `--format=${REC}%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s`, `-n`, String(limit ?? 50), "--date=iso-strict"];
        if (no_merges) args.push("--no-merges");
        if (author) args.push(`--author=${safeText(author, "author")}`);
        if (since) args.push(`--since=${safeText(since, "since", 64)}`);
        if (until) args.push(`--until=${safeText(until, "until", 64)}`);
        if (grep) args.push(`--grep=${safeText(grep, "grep")}`, "--fixed-strings");
        if (with_files) args.push("--name-only");
        args.push(safeRev(rev));
        args.push("--");
        if (path) args.push(safePath(path));
        const out = await runGit(info.bare ? info.path : info.top_level, args);
        const commits = out
          .split(REC)
          .map((chunk) => chunk.trim())
          .filter(Boolean)
          .map((chunk) => {
            const [header, ...rest] = chunk.split("\n");
            const [hash, short, name, email, dateRaw, subject] = header.split(SEP);
            const date = dateRaw ? isoZ(dateRaw) : dateRaw;
            const entry: Record<string, unknown> = { hash, short, author: name, email, date, subject };
            if (with_files) entry.files = rest.map((l) => l.trim()).filter(Boolean);
            return entry;
          });
        return json({ repo: info.top_level, rev: rev ?? "HEAD", count: commits.length, commits });
      }),
  );

  server.registerTool(
    "blame_summary",
    {
      title: "Summarise blame for a file",
      description:
        "Attribute every line of one file at rev (default HEAD) to its last author and return, per author, the number of lines, the percentage, and the most recent commit date; plus the total " +
        "line count and the number of distinct commits involved. With ignore_whitespace, whitespace-only changes are attributed to the earlier author.",
      inputSchema: { repo: repoSchema, path: z.string().min(1).max(1024).describe("File path relative to the repository root."), rev: revSchema, ignore_whitespace: z.boolean().optional() },
      annotations: readOnly,
    },
    async ({ repo, path, rev, ignore_whitespace }) =>
      guarded(async () => {
        const info = await openRepo(repo);
        const args = ["blame", "--line-porcelain"];
        if (ignore_whitespace) args.push("-w");
        args.push(safeRev(rev), "--", safePath(path));
        const out = await runGit(info.bare ? info.path : info.top_level, args);
        const byAuthor = new Map<string, { lines: number; latest: number; email: string }>();
        const commits = new Set<string>();
        let total = 0;
        let current: { author?: string; email?: string; time?: number } = {};
        for (const line of out.split("\n")) {
          if (/^[0-9a-f]{40} \d+ \d+/.test(line)) {
            commits.add(line.slice(0, 40));
            current = {};
          } else if (line.startsWith("author ")) current.author = line.slice(7);
          else if (line.startsWith("author-mail ")) current.email = line.slice(12).replace(/[<>]/g, "");
          else if (line.startsWith("author-time ")) current.time = Number(line.slice(12));
          else if (line.startsWith("\t")) {
            total++;
            const key = current.author ?? "unknown";
            const entry = byAuthor.get(key) ?? { lines: 0, latest: 0, email: current.email ?? "" };
            entry.lines++;
            entry.latest = Math.max(entry.latest, current.time ?? 0);
            byAuthor.set(key, entry);
          }
        }
        const authors = [...byAuthor.entries()]
          .map(([author, v]) => ({ author, email: v.email, lines: v.lines, percent: total ? Math.round((v.lines / total) * 1000) / 10 : 0, latest_commit: v.latest ? new Date(v.latest * 1000).toISOString() : null }))
          .sort((a, b) => b.lines - a.lines);
        return json({ repo: info.top_level, path, rev: rev ?? "HEAD", total_lines: total, commits: commits.size, authors });
      }),
  );

  server.registerTool(
    "churn",
    {
      title: "Files changed most often",
      description:
        "Rank files by how many commits touched them, with lines added and removed, over the commits reachable from rev (default HEAD) and optionally limited by since, until and path. " +
        "Renames are followed and reported under the newest name. Binary files count commits but not lines. limit is 1 to 200, default 25. Also returns the number of commits examined.",
      inputSchema: { repo: repoSchema, rev: revSchema, since: sinceSchema, until: untilSchema, path: pathSchema, limit: z.number().int().min(1).max(200).optional(), max_commits: z.number().int().min(1).max(20_000).optional().describe("Cap on commits examined. Default 5000.") },
      annotations: readOnly,
    },
    async ({ repo, rev, since, until, path, limit, max_commits }) =>
      guarded(async () => {
        const info = await openRepo(repo);
        const args = ["log", "--numstat", "-M", `--format=${REC}%H`, "-n", String(max_commits ?? 5000)];
        if (since) args.push(`--since=${safeText(since, "since", 64)}`);
        if (until) args.push(`--until=${safeText(until, "until", 64)}`);
        args.push(safeRev(rev), "--");
        if (path) args.push(safePath(path));
        const out = await runGit(info.bare ? info.path : info.top_level, args);
        const files = new Map<string, { commits: number; added: number; deleted: number; binary: boolean }>();
        // Commits arrive newest first, so a rename maps its old name onto the name the file has today.
        const aliases = new Map<string, string>();
        const current = (name: string): string => {
          let n = name;
          for (let hop = 0; hop < 64 && aliases.has(n); hop++) n = aliases.get(n) as string;
          return n;
        };
        let commitCount = 0;
        for (const chunk of out.split(REC)) {
          const lines = chunk.trim().split("\n").filter(Boolean);
          if (lines.length === 0) continue;
          commitCount++;
          for (const l of lines.slice(1)) {
            const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
            if (!m) continue;
            const rename = renamePaths(m[3]);
            let name: string;
            if (rename) {
              name = current(rename.newPath);
              if (rename.oldPath !== name) aliases.set(rename.oldPath, name);
            } else name = current(m[3]);
            const e = files.get(name) ?? { commits: 0, added: 0, deleted: 0, binary: false };
            e.commits++;
            if (m[1] === "-") e.binary = true;
            else {
              e.added += Number(m[1]);
              e.deleted += Number(m[2]);
            }
            files.set(name, e);
          }
        }
        const ranked = [...files.entries()]
          .map(([file, v]) => ({ file, ...v, churn: v.added + v.deleted }))
          .sort((a, b) => b.commits - a.commits || b.churn - a.churn)
          .slice(0, limit ?? 25);
        return json({ repo: info.top_level, rev: rev ?? "HEAD", commits_examined: commitCount, files_total: files.size, files: ranked });
      }),
  );

  server.registerTool(
    "authors",
    {
      title: "Commits per author",
      description:
        "Count commits per author (grouped by email) over the commits reachable from rev (default HEAD), optionally limited by since, until and path, with each author's first and last commit dates. " +
        "Merge commits are excluded unless include_merges is true.",
      inputSchema: { repo: repoSchema, rev: revSchema, since: sinceSchema, until: untilSchema, path: pathSchema, include_merges: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional().describe("Default 50.") },
      annotations: readOnly,
    },
    async ({ repo, rev, since, until, path, include_merges, limit }) =>
      guarded(async () => {
        const info = await openRepo(repo);
        const args = ["log", `--format=%an${SEP}%ae${SEP}%aI`];
        if (!include_merges) args.push("--no-merges");
        if (since) args.push(`--since=${safeText(since, "since", 64)}`);
        if (until) args.push(`--until=${safeText(until, "until", 64)}`);
        args.push(safeRev(rev), "--");
        if (path) args.push(safePath(path));
        const out = await runGit(info.bare ? info.path : info.top_level, args);
        const byEmail = new Map<string, { name: string; commits: number; first: string; last: string }>();
        let total = 0;
        for (const line of out.split("\n")) {
          if (!line) continue;
          const [name, email, dateRaw] = line.split(SEP);
          const date = dateRaw ? isoZ(dateRaw) : dateRaw;
          total++;
          const key = email.toLowerCase();
          const e = byEmail.get(key);
          if (!e) byEmail.set(key, { name, commits: 1, first: date, last: date });
          else {
            e.commits++;
            if (date < e.first) e.first = date;
            if (date > e.last) e.last = date;
          }
        }
        const authors = [...byEmail.entries()]
          .map(([email, v]) => ({ email, name: v.name, commits: v.commits, percent: total ? Math.round((v.commits / total) * 1000) / 10 : 0, first_commit: v.first, last_commit: v.last }))
          .sort((a, b) => b.commits - a.commits)
          .slice(0, limit ?? 50);
        return json({ repo: info.top_level, rev: rev ?? "HEAD", commits: total, authors });
      }),
  );

  server.registerTool(
    "large_files",
    {
      title: "Largest files",
      description:
        "List the largest blobs in the tree at rev (default HEAD) with their paths and sizes in bytes. With include_history, instead scan every object reachable from any ref " +
        "(git rev-list --objects --all piped to cat-file --batch-check) and report the largest blobs ever committed, including ones no longer in the tree, which is what makes a clone big. " +
        "limit is 1 to 100, default 20.",
      inputSchema: { repo: repoSchema, rev: revSchema, limit: z.number().int().min(1).max(100).optional(), include_history: z.boolean().optional() },
      annotations: readOnly,
    },
    async ({ repo, rev, limit, include_history }) =>
      guarded(async () => {
        const info = await openRepo(repo);
        const cwd = info.bare ? info.path : info.top_level;
        const n = limit ?? 20;
        if (include_history) {
          const out = await pipeGit(cwd, ["rev-list", "--objects", "--all"], ["cat-file", "--batch-check=%(objecttype) %(objectname) %(objectsize) %(rest)"]);
          const blobs = out
            .split("\n")
            .filter((l) => l.startsWith("blob "))
            .map((l) => {
              const [, hash, size, ...rest] = l.split(" ");
              return { hash, size: Number(size), path: rest.join(" ") || null };
            })
            .sort((a, b) => b.size - a.size)
            .slice(0, n);
          return json({ repo: info.top_level, scope: "history", files: blobs });
        }
        const out = await runGit(cwd, ["ls-tree", "-r", "-l", safeRev(rev)]);
        const files = out
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const m = /^(\d+) (\w+) ([0-9a-f]+)\s+(\d+|-)\t(.+)$/.exec(l);
            return m ? { hash: m[3], size: m[4] === "-" ? 0 : Number(m[4]), path: m[5], type: m[2] } : null;
          })
          .filter((f): f is NonNullable<typeof f> => f !== null && f.type === "blob")
          .map(({ hash, size, path }) => ({ hash, size, path }))
          .sort((a, b) => b.size - a.size)
          .slice(0, n);
        return json({ repo: info.top_level, scope: `tree at ${rev ?? "HEAD"}`, files });
      }),
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
