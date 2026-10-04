import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../dist/index.js";
import { RULES, lint, parseDockerfile } from "../dist/dockerfile.js";

const BAD = `# syntax=docker/dockerfile:1
FROM node
MAINTAINER someone
ENV API_KEY=abc123 DEBUG=true
ARG DB_PASSWORD=hunter2
RUN apt-get update && apt-get install -y curl \\
    && curl -sSL https://example.com/install.sh | bash
RUN sudo apk add git
RUN pip install requests
ADD ./src /app/src
ADD https://example.com/file.txt /tmp/file.txt
ADD dist.tar.gz /app/
WORKDIR app
COPY . .
EXPOSE 22 8080
CMD npm start
CMD ["npm", "run", "serve"]
`;

const GOOD = `FROM node:22-bookworm-slim@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY src ./src

FROM node:22-bookworm-slim@sha256:0000000000000000000000000000000000000000000000000000000000000000
RUN apt-get update && apt-get install -y --no-install-recommends tini \\
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
HEALTHCHECK --interval=30s CMD node healthcheck.js
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
`;

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const parse = (r) => JSON.parse(r.content[0].text);

test("lists the three tools", async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["explain_rule", "lint_dockerfile", "parse_dockerfile"]);
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  } finally {
    await close();
  }
});

test("lint_dockerfile finds every planted problem and stays quiet on a good file", async () => {
  const { client, close } = await connected();
  try {
    const r = parse(await client.callTool({ name: "lint_dockerfile", arguments: { content: BAD } }));
    const rules = new Set(r.findings.map((f) => f.rule));
    for (const expected of ["latest-tag", "maintainer-deprecated", "secret-in-env", "secret-in-arg", "apt-no-cleanup", "apt-no-recommends", "curl-pipe-shell", "sudo", "apk-no-cache", "pip-no-cache", "add-for-copy", "add-remote", "workdir-relative", "copy-whole-context", "expose-ssh", "shell-form-cmd", "multiple-cmd", "root-user", "no-healthcheck"]) {
      assert.ok(rules.has(expected), expected);
    }
    assert.ok(!rules.has("secret-literal"));
    assert.equal(r.findings.find((f) => f.rule === "curl-pipe-shell").line, 6, "continuation lines report the first line");
    assert.equal(r.findings.find((f) => f.rule === "add-for-copy").line, 10);
    assert.ok(!r.findings.some((f) => f.rule === "add-for-copy" && f.line === 12), "tar archives are a legitimate ADD");
    assert.equal(r.findings[0].severity, "error");
    assert.ok(r.findings.every((f) => typeof f.fix === "string" && f.fix.length > 10));

    const dir = await mkdtemp(join(tmpdir(), "dl-"));
    const file = join(dir, "Dockerfile");
    await writeFile(file, GOOD);
    const good = parse(await client.callTool({ name: "lint_dockerfile", arguments: { path: file } }));
    assert.equal(good.source, file);
    assert.equal(good.stages.length, 2);
    assert.equal(good.stages[0].name, "build");
    assert.deepEqual(good.findings, []);

    const ignored = parse(await client.callTool({ name: "lint_dockerfile", arguments: { content: BAD, ignore: ["latest-tag", "no-healthcheck"] } }));
    assert.ok(!ignored.findings.some((f) => f.rule === "latest-tag" || f.rule === "no-healthcheck"));
    const both = await client.callTool({ name: "lint_dockerfile", arguments: { content: BAD, path: file } });
    assert.equal(both.isError, true);
    const missing = await client.callTool({ name: "lint_dockerfile", arguments: { path: join(dir, "nope") } });
    assert.equal(missing.isError, true);
  } finally {
    await close();
  }
});

test("rules handle digests, scratch, build-arg bases, root USER, chown and secret literals", () => {
  const rules = (text) => lint(parseDockerfile(text)).map((f) => f.rule);
  assert.ok(rules("FROM alpine:3.20\nUSER nobody\nHEALTHCHECK NONE\n").includes("unpinned-digest"));
  assert.ok(rules("FROM alpine:latest\n").includes("latest-tag"));
  assert.ok(rules("FROM ghcr.io/org/image\n").includes("latest-tag"));
  assert.ok(!rules("FROM ghcr.io/org/image:1.2\n").includes("latest-tag"));
  assert.deepEqual(rules("FROM scratch\nCOPY --chown=1000:1000 app /app\nUSER 1000\nENTRYPOINT [\"/app\"]\n"), []);
  assert.ok(rules("ARG BASE=alpine:3.20\nFROM $BASE\nUSER nobody\nHEALTHCHECK NONE\n").every((r) => r !== "latest-tag"));
  assert.ok(rules("FROM ${UNDECLARED}\n").includes("latest-tag"));
  const root = lint(parseDockerfile("FROM alpine:3.20@sha256:aa\nUSER nobody\nUSER root\nHEALTHCHECK NONE\n"));
  assert.equal(root.find((f) => f.rule === "root-user").line, 3);
  assert.ok(rules("FROM alpine:3.20@sha256:aa\nUSER nobody\nCOPY app /app\nHEALTHCHECK NONE\n").includes("copy-chown-missing"));
  assert.ok(rules("FROM alpine:3.20@sha256:aa\nRUN echo AKIAIOSFODNN7EXAMPLE > /k\nUSER nobody\nHEALTHCHECK NONE\n").includes("secret-literal"));
  assert.ok(rules("FROM alpine:3.20@sha256:aa\nENV GITHUB_TOKEN=$TOKEN\nUSER nobody\nHEALTHCHECK NONE\n").every((r) => r !== "secret-in-env"), "variable references are not literals");
  assert.ok(rules("FROM alpine:3.20@sha256:aa\nENV SECRET_KEY value\nUSER nobody\nHEALTHCHECK NONE\n").includes("secret-in-env"));
  assert.ok(rules("").includes("empty-dockerfile"));
  assert.ok(rules("RUN echo hi\n").includes("from-missing"));
  assert.ok(!rules("FROM debian:12@sha256:aa\nRUN --mount=type=cache,target=/var/lib/apt apt-get install -y --no-install-recommends git\nUSER nobody\nHEALTHCHECK NONE\n").includes("apt-no-cleanup"));
});

test("parse_dockerfile handles directives, continuations, comments inside continuations and heredocs", async () => {
  const { client, close } = await connected();
  try {
    const text = "# escape=`\nFROM alpine:3.20 AS base\nRUN apk add --no-cache `\n    # a comment in the middle\n    git\nRUN <<EOF\necho one\necho two\nEOF\nCOPY a b\n";
    const r = parse(await client.callTool({ name: "parse_dockerfile", arguments: { content: text } }));
    assert.equal(r.escape, "`");
    assert.deepEqual(r.stages, [{ index: 0, name: "base", base: "alpine:3.20", line: 2 }]);
    assert.deepEqual(r.instructions.map((i) => i.instruction), ["FROM", "RUN", "RUN", "COPY"]);
    assert.equal(r.instructions[1].args, "apk add --no-cache git");
    assert.deepEqual([r.instructions[1].line, r.instructions[1].end_line], [3, 5]);
    assert.deepEqual([r.instructions[2].line, r.instructions[2].end_line], [6, 9]);
    assert.match(r.instructions[2].args, /echo two/);
    assert.equal(r.instructions[3].line, 10);
    const platform = parseDockerfile("FROM --platform=linux/amd64 node:22-slim AS deps\n");
    assert.equal(platform.stages[0].base, "node:22-slim");
    assert.equal(platform.stages[0].name, "deps");
    const bad = await client.callTool({ name: "parse_dockerfile", arguments: {} });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});

test("explain_rule documents every rule", async () => {
  const { client, close } = await connected();
  try {
    for (const rule of Object.keys(RULES)) {
      const r = parse(await client.callTool({ name: "explain_rule", arguments: { rule } }));
      assert.equal(r.rule, rule);
      assert.ok(["error", "warning", "info"].includes(r.severity));
    }
    const bad = await client.callTool({ name: "explain_rule", arguments: { rule: "nope" } });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});
