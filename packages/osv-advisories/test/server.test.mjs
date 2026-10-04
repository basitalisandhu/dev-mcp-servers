import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../dist/index.js";
import { OsvClient } from "../dist/osv.js";

const GHSA = {
  id: "GHSA-test-0001",
  summary: "Prototype pollution in example",
  aliases: ["CVE-2020-0001"],
  published: "2020-01-01T00:00:00Z",
  modified: "2021-01-01T00:00:00Z",
  severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
  affected: [{ package: { ecosystem: "npm", name: "example" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.3" }] }] }],
  references: [{ type: "ADVISORY", url: "https://example.com/advisory" }],
  database_specific: { severity: "HIGH" },
};

/** A fetch double that only answers api.osv.dev and records every request. */
function fakeFetch(calls) {
  return async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u.toString(), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined, redirect: init?.redirect });
    assert.equal(u.origin, "https://api.osv.dev");
    if (u.pathname === "/v1/query") {
      const body = JSON.parse(init.body);
      if (body.package.name === "example") return Response.json({ vulns: [GHSA] });
      return Response.json({});
    }
    if (u.pathname === "/v1/querybatch") {
      const body = JSON.parse(init.body);
      return Response.json({ results: body.queries.map((q) => (q.package.name === "example" || q.package.name === "lodash" ? { vulns: [{ id: "GHSA-test-0001", modified: "x" }] } : {})) });
    }
    if (u.pathname === "/v1/vulns/GHSA-test-0001") return Response.json(GHSA);
    if (u.pathname.startsWith("/v1/vulns/")) return new Response("not found", { status: 404 });
    return new Response("boom", { status: 500 });
  };
}

async function connected(fetchImpl) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ fetchImpl });
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server, close: async () => { await client.close(); await server.close(); } };
}
const parse = (result) => JSON.parse(result.content[0].text);

test("exposes the four documented tools, all read-only", async () => {
  const { client, close } = await connected(fakeFetch([]));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["get_vulnerability", "query_batch", "query_package", "scan_lockfile"]);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true);
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  } finally {
    await close();
  }
});

test("query_package normalises the ecosystem and summarises advisories", async () => {
  const calls = [];
  const { client, close } = await connected(fakeFetch(calls));
  try {
    const r = parse(await client.callTool({ name: "query_package", arguments: { ecosystem: "NPM", name: "example", version: "1.0.0" } }));
    assert.equal(r.ecosystem, "npm");
    assert.equal(r.count, 1);
    assert.equal(r.vulnerabilities[0].id, "GHSA-test-0001");
    assert.deepEqual(r.vulnerabilities[0].fixed_versions, ["1.2.3"]);
    assert.deepEqual(r.vulnerabilities[0].aliases, ["CVE-2020-0001"]);
    assert.ok(r.vulnerabilities[0].severity.some((s) => s.startsWith("CVSS_V3")));
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].redirect, "error");
    assert.deepEqual(calls[0].body, { package: { name: "example", ecosystem: "npm" }, version: "1.0.0" });

    const none = parse(await client.callTool({ name: "query_package", arguments: { ecosystem: "pypi", name: "clean" } }));
    assert.equal(none.count, 0);
    const bad = await client.callTool({ name: "query_package", arguments: { ecosystem: "maven-central", name: "x" } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Unknown ecosystem/);
  } finally {
    await close();
  }
});

test("query_batch returns ids per package in order", async () => {
  const calls = [];
  const { client, close } = await connected(fakeFetch(calls));
  try {
    const r = parse(await client.callTool({ name: "query_batch", arguments: { packages: [{ ecosystem: "npm", name: "clean", version: "1.0.0" }, { ecosystem: "npm", name: "example", version: "1.0.0" }] } }));
    assert.equal(r.queried, 2);
    assert.equal(r.affected, 1);
    assert.deepEqual(r.results[0].vulnerability_ids, []);
    assert.deepEqual(r.results[1].vulnerability_ids, ["GHSA-test-0001"]);
    assert.equal(calls[0].url, "https://api.osv.dev/v1/querybatch");
    const empty = await client.callTool({ name: "query_batch", arguments: { packages: [] } });
    assert.equal(empty.isError, true);
  } finally {
    await close();
  }
});

test("scan_lockfile parses a package-lock.json from disk and a requirements.txt from content", async () => {
  const calls = [];
  const { client, close } = await connected(fakeFetch(calls));
  try {
    const dir = await mkdtemp(join(tmpdir(), "osv-"));
    const lock = join(dir, "package-lock.json");
    await writeFile(lock, JSON.stringify({ name: "app", lockfileVersion: 3, packages: { "": { name: "app" }, "node_modules/lodash": { version: "4.17.20" }, "node_modules/a/node_modules/b": { version: "2.0.0" }, "packages/ws": { link: true } } }));
    const r = parse(await client.callTool({ name: "scan_lockfile", arguments: { path: lock, include_details: true } }));
    assert.equal(r.format, "package-lock");
    assert.equal(r.packages, 2);
    assert.equal(r.affected_packages, 1);
    assert.equal(r.affected[0].name, "lodash");
    assert.equal(r.details[0].id, "GHSA-test-0001");
    assert.deepEqual(r.skipped, [{ entry: "packages/ws", reason: "workspace link" }]);

    const req = parse(await client.callTool({ name: "scan_lockfile", arguments: { content: "# deps\nrequests==2.31.0\nflask>=2.0\nexample[extra]==1.0 ; python_version<'3'\n-r other.txt\n", filename: "requirements.txt" } }));
    assert.equal(req.format, "requirements");
    assert.equal(req.packages, 2);
    assert.equal(req.skipped.length, 2);
    assert.equal(req.affected_packages, 1);

    const both = await client.callTool({ name: "scan_lockfile", arguments: { content: "x", path: lock } });
    assert.equal(both.isError, true);
    const missing = await client.callTool({ name: "scan_lockfile", arguments: { path: join(dir, "nope.lock") } });
    assert.equal(missing.isError, true);
  } finally {
    await close();
  }
});

test("get_vulnerability returns the record or a clear error", async () => {
  const { client, close } = await connected(fakeFetch([]));
  try {
    const r = parse(await client.callTool({ name: "get_vulnerability", arguments: { id: "GHSA-test-0001" } }));
    assert.equal(r.summary.id, "GHSA-test-0001");
    assert.equal(r.record.summary, GHSA.summary);
    const missing = await client.callTool({ name: "get_vulnerability", arguments: { id: "GHSA-nope" } });
    assert.equal(missing.isError, true);
    const invalid = await client.callTool({ name: "get_vulnerability", arguments: { id: "../x" } });
    assert.equal(invalid.isError, true);
  } finally {
    await close();
  }
});

test("client refuses other origins, oversized bodies and surfaces HTTP errors", async () => {
  const c = new OsvClient({ fetchImpl: async () => new Response("x".repeat(100), { status: 200, headers: { "content-type": "application/json" } }), maxResponseBytes: 50 });
  await assert.rejects(c.getVulnerability("GHSA-a"), /exceeds the 50 byte limit/);
  const e = new OsvClient({ fetchImpl: async () => new Response("down", { status: 503 }) });
  await assert.rejects(e.queryPackage({ ecosystem: "npm", name: "x" }), /responded 503/);
  const t = new OsvClient({ fetchImpl: async () => { throw new Error("timeout"); } });
  await assert.rejects(t.queryBatch([{ ecosystem: "npm", name: "x" }]), /failed: timeout/);
});
