import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../dist/index.js";
import { safePath, safeRev, safeText, sanitizeRemoteUrl } from "../dist/git.js";

let repo;
let plain;

function git(args, env = {}) {
  return execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: env.date ?? "2026-01-01T10:00:00Z", GIT_COMMITTER_DATE: env.date ?? "2026-01-01T10:00:00Z", GIT_AUTHOR_NAME: env.name ?? "Alice", GIT_AUTHOR_EMAIL: env.email ?? "alice@example.com", GIT_COMMITTER_NAME: "CI", GIT_COMMITTER_EMAIL: "ci@example.com" }, encoding: "utf8" });
}

before(async () => {
  repo = await mkdtemp(join(tmpdir(), "gi-"));
  plain = await mkdtemp(join(tmpdir(), "gi-plain-"));
  git(["init", "-q", "-b", "main"]);
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "a.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "README.md"), "# Demo\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial commit"]);
  await writeFile(join(repo, "src", "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "add lines to a"], { name: "Bob", email: "bob@example.com", date: "2026-02-01T10:00:00Z" });
  await writeFile(join(repo, "big.bin"), Buffer.alloc(50_000, 0));
  git(["add", "."]);
  git(["commit", "-q", "-m", "add binary"], { date: "2026-03-01T10:00:00Z" });
  await rename(join(repo, "src", "a.txt"), join(repo, "src", "b.txt"));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "rename a to b"], { name: "Bob", email: "bob@example.com", date: "2026-04-01T10:00:00Z" });
  git(["rm", "-q", "big.bin"]);
  git(["commit", "-q", "-m", "remove binary"], { date: "2026-05-01T10:00:00Z" });
  git(["tag", "v1.0.0"]);
  git(["remote", "add", "origin", "https://user:token@github.com/example/demo.git"]);
  await writeFile(join(repo, "untracked.txt"), "x");
});

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const parse = (r) => JSON.parse(r.content[0].text);

test("lists the six read-only tools", async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["authors", "blame_summary", "churn", "git_log", "large_files", "repo_summary"]);
    for (const t of tools) assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  } finally {
    await close();
  }
});

test("repo_summary strips credentials and counts", async () => {
  const { client, close } = await connected();
  try {
    const r = parse(await client.callTool({ name: "repo_summary", arguments: { repo: join(repo, "src") } }));
    assert.equal(r.branch, "main");
    assert.equal(r.commits, 5);
    assert.equal(r.tags, 1);
    assert.equal(r.head.subject, "remove binary");
    assert.deepEqual(r.remotes, [{ name: "origin", url: "https://github.com/example/demo.git" }]);
    assert.equal(r.work_tree.untracked, 1);
    assert.equal(r.work_tree.modified, 0);
    const notRepo = await client.callTool({ name: "repo_summary", arguments: { repo: plain } });
    assert.equal(notRepo.isError, true);
    assert.match(notRepo.content[0].text, /not inside a git repository/);
    const missing = await client.callTool({ name: "repo_summary", arguments: { repo: join(plain, "nope") } });
    assert.equal(missing.isError, true);
  } finally {
    await close();
  }
});

test("git_log filters by author, path, date and message", async () => {
  const { client, close } = await connected();
  try {
    const all = parse(await client.callTool({ name: "git_log", arguments: { repo, with_files: true } }));
    assert.equal(all.count, 5);
    assert.equal(all.commits[0].subject, "remove binary");
    assert.deepEqual(all.commits[4].files.sort(), ["README.md", "src/a.txt"]);
    const bob = parse(await client.callTool({ name: "git_log", arguments: { repo, author: "bob@" } }));
    assert.equal(bob.count, 2);
    const since = parse(await client.callTool({ name: "git_log", arguments: { repo, since: "2026-03-15", until: "2026-04-15" } }));
    assert.deepEqual(since.commits.map((c) => c.subject), ["rename a to b"]);
    const grep = parse(await client.callTool({ name: "git_log", arguments: { repo, grep: "binary", limit: 1 } }));
    assert.equal(grep.count, 1);
    const path = parse(await client.callTool({ name: "git_log", arguments: { repo, path: "README.md" } }));
    assert.equal(path.count, 1);
    const rev = parse(await client.callTool({ name: "git_log", arguments: { repo, rev: "HEAD~3" } }));
    assert.equal(rev.count, 2);
    for (const bad of [{ rev: "--output=/tmp/x" }, { path: "../etc/passwd" }, { path: "/abs" }, { author: "--all" }, { rev: "a..b" }]) {
      const r = await client.callTool({ name: "git_log", arguments: { repo, ...bad } });
      assert.equal(r.isError, true, JSON.stringify(bad));
    }
  } finally {
    await close();
  }
});

test("blame_summary attributes lines per author", async () => {
  const { client, close } = await connected();
  try {
    const r = parse(await client.callTool({ name: "blame_summary", arguments: { repo, path: "src/b.txt" } }));
    assert.equal(r.total_lines, 5);
    assert.equal(r.commits, 2);
    assert.deepEqual(r.authors.map((a) => [a.author, a.lines, a.percent]), [["Alice", 3, 60], ["Bob", 2, 40]]);
    assert.equal(r.authors[1].latest_commit, "2026-02-01T10:00:00.000Z");
    const old = parse(await client.callTool({ name: "blame_summary", arguments: { repo, path: "src/a.txt", rev: "v1.0.0~2", ignore_whitespace: true } }));
    assert.equal(old.total_lines, 5);
    const missing = await client.callTool({ name: "blame_summary", arguments: { repo, path: "nope.txt" } });
    assert.equal(missing.isError, true);
  } finally {
    await close();
  }
});

test("churn follows renames and counts binaries; authors aggregates by email", async () => {
  const { client, close } = await connected();
  try {
    const r = parse(await client.callTool({ name: "churn", arguments: { repo } }));
    assert.equal(r.commits_examined, 5);
    const byFile = Object.fromEntries(r.files.map((f) => [f.file, f]));
    assert.equal(byFile["src/b.txt"].commits, 3, "rename is followed to the new name");
    assert.equal(byFile["src/b.txt"].added, 5);
    assert.equal(byFile["big.bin"].binary, true);
    assert.equal(byFile["big.bin"].commits, 2);
    const limited = parse(await client.callTool({ name: "churn", arguments: { repo, path: "src", limit: 1, since: "2026-01-15" } }));
    assert.equal(limited.files.length, 1);
    assert.equal(limited.commits_examined, 2);

    const a = parse(await client.callTool({ name: "authors", arguments: { repo } }));
    assert.equal(a.commits, 5);
    assert.deepEqual(a.authors.map((x) => [x.email, x.commits, x.percent]), [["alice@example.com", 3, 60], ["bob@example.com", 2, 40]]);
    assert.equal(a.authors[0].first_commit, "2026-01-01T10:00:00Z");
    assert.equal(a.authors[0].last_commit, "2026-05-01T10:00:00Z");
  } finally {
    await close();
  }
});

test("large_files reads the tree and the whole history", async () => {
  const { client, close } = await connected();
  try {
    const tree = parse(await client.callTool({ name: "large_files", arguments: { repo, limit: 2 } }));
    assert.equal(tree.files.length, 2);
    assert.ok(!tree.files.some((f) => f.path === "big.bin"), "deleted file is not in the tree");
    assert.equal(tree.files[0].path, "src/b.txt");
    const history = parse(await client.callTool({ name: "large_files", arguments: { repo, include_history: true, limit: 1 } }));
    assert.equal(history.scope, "history");
    assert.equal(history.files[0].path, "big.bin");
    assert.equal(history.files[0].size, 50_000);
    const atTag = parse(await client.callTool({ name: "large_files", arguments: { repo, rev: "v1.0.0~1" } }));
    assert.ok(atTag.files.some((f) => f.path === "big.bin"));
  } finally {
    await close();
  }
});

test("argument validators", () => {
  assert.equal(safeRev(undefined), "HEAD");
  assert.equal(safeRev("feature/x-1"), "feature/x-1");
  assert.equal(safeRev("HEAD~2^1"), "HEAD~2^1");
  assert.throws(() => safeRev("-x"));
  assert.throws(() => safeRev("main..dev"));
  assert.throws(() => safeRev("refs/heads/x.lock"));
  assert.equal(safePath("./src/a.ts"), "src/a.ts");
  assert.throws(() => safePath("src/../../x"));
  assert.throws(() => safePath("-rf"));
  assert.throws(() => safeText("--help", "author"));
  assert.throws(() => safeText("a\nb", "grep"));
  assert.equal(sanitizeRemoteUrl("https://user:secret@host/x.git"), "https://host/x.git");
  assert.equal(sanitizeRemoteUrl("git@github.com:a/b.git"), "git@github.com:a/b.git");
});

test("rename parsing", async () => {
  const { renamePaths } = await import("../dist/index.js");
  assert.deepEqual(renamePaths("src/{a.ts => b.ts}"), { oldPath: "src/a.ts", newPath: "src/b.ts" });
  assert.deepEqual(renamePaths("src/{ => lib}/x.ts"), { oldPath: "src/x.ts", newPath: "src/lib/x.ts" });
  assert.deepEqual(renamePaths("a.ts => dir/b.ts"), { oldPath: "a.ts", newPath: "dir/b.ts" });
  assert.equal(renamePaths("plain.ts"), null);
});
