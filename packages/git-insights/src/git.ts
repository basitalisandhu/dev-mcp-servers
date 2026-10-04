/**
 * Read-only git access. Every command is spawned without a shell, with a fixed argument list, a timeout,
 * an output cap and GIT_OPTIONAL_LOCKS=0 so that nothing in the repository is modified.
 */
import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export const TIMEOUT_MS = 20_000;
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export class GitError extends Error {}

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat", LC_ALL: "C" };

export function runGit(repo: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile("git", ["--no-pager", ...args], { cwd: repo, env: ENV, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { killed?: boolean; code?: unknown };
        if (e.killed) return reject(new GitError(`git ${args[0]} exceeded ${TIMEOUT_MS} ms`));
        return reject(new GitError(`git ${args[0]} failed: ${(stderr || e.message).trim().split("\n")[0]}`));
      }
      resolvePromise(stdout);
    });
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

/** Run two git commands with the first one's stdout piped into the second (used for cat-file --batch-check). */
export function pipeGit(repo: string, first: string[], second: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const a = spawn("git", ["--no-pager", ...first], { cwd: repo, env: ENV, windowsHide: true });
    const b = spawn("git", ["--no-pager", ...second], { cwd: repo, env: ENV, windowsHide: true });
    let out = "";
    let err = "";
    let size = 0;
    const timer = setTimeout(() => {
      a.kill();
      b.kill();
      reject(new GitError(`git ${first[0]} | git ${second[0]} exceeded ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    a.stdout.pipe(b.stdin);
    a.on("error", (e) => reject(new GitError(e.message)));
    b.on("error", (e) => reject(new GitError(e.message)));
    b.stderr.on("data", (d) => (err += String(d)));
    b.stdout.on("data", (d) => {
      size += d.length;
      if (size > MAX_OUTPUT_BYTES) {
        a.kill();
        b.kill();
        clearTimeout(timer);
        return reject(new GitError("output exceeds the size cap"));
      }
      out += String(d);
    });
    b.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new GitError(`git ${second[0]} failed: ${err.trim().split("\n")[0]}`));
      resolvePromise(out);
    });
  });
}

export interface RepoInfo {
  path: string;
  top_level: string;
  git_dir: string;
  bare: boolean;
}

export async function openRepo(input: string): Promise<RepoInfo> {
  const abs = resolve(input);
  const st = await stat(abs).catch(() => undefined);
  if (!st || !st.isDirectory()) throw new GitError(`${abs} is not a directory`);
  let out: string;
  try {
    out = await runGit(abs, ["rev-parse", "--is-bare-repository", "--git-dir", "--show-toplevel"]);
  } catch (err) {
    if (err instanceof GitError && /not a git repository/i.test(err.message)) throw new GitError(`${abs} is not inside a git repository`);
    try {
      const bare = (await runGit(abs, ["rev-parse", "--is-bare-repository", "--git-dir"])).trim().split("\n");
      if (bare[0] === "true") return { path: abs, top_level: abs, git_dir: resolve(abs, bare[1]), bare: true };
    } catch {
      /* fall through */
    }
    throw err;
  }
  const [bare, gitDir, top] = out.trim().split("\n");
  return { path: abs, top_level: top ?? abs, git_dir: resolve(abs, gitDir), bare: bare === "true" };
}

const REV = /^[A-Za-z0-9][A-Za-z0-9._\/^~-]{0,199}$/;

export function safeRev(rev: string | undefined, fallback = "HEAD"): string {
  if (rev === undefined) return fallback;
  if (!REV.test(rev) || rev.includes("..") || rev.includes("//") || rev.endsWith(".lock")) throw new GitError(`${JSON.stringify(rev)} is not an acceptable revision (branch, tag, commit or HEAD~n)`);
  return rev;
}

export function safePath(p: string): string {
  const norm = p.replace(/\\/g, "/");
  if (norm.length > 1024 || norm.includes("\0")) throw new GitError("path is too long or contains NUL");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || norm.startsWith("-")) throw new GitError(`${JSON.stringify(p)} must be relative to the repository root and not start with -`);
  if (norm.split("/").some((seg) => seg === "..")) throw new GitError(`${JSON.stringify(p)} must not contain .. segments`);
  return norm.replace(/^\.\//, "");
}

export function safeText(value: string | undefined, label: string, max = 200): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > max || value.startsWith("-") || /[\0\n\r]/.test(value)) throw new GitError(`${label} must be at most ${max} characters, not start with -, and contain no newlines`);
  return value;
}

export function sanitizeRemoteUrl(url: string): string {
  return url.replace(/\/\/[^@\/]+@/, "//");
}
