import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../dist/index.js";
import { RULES, lint, parseDocument } from "../dist/lint.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/petstore.yaml", import.meta.url));

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const parse = (r) => JSON.parse(r.content[0].text);

test("lists the four tools", async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["explain_rule", "get_operation", "lint_openapi", "list_operations"]);
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  } finally {
    await close();
  }
});

test("lint_openapi finds the planted problems in the YAML fixture", async () => {
  const { client, close } = await connected();
  try {
    const r = parse(await client.callTool({ name: "lint_openapi", arguments: { path: FIXTURE } }));
    assert.equal(r.openapi, "3.0.3");
    assert.equal(r.title, "Pet Store");
    assert.equal(r.operations, 5);
    const rules = r.findings.map((f) => f.rule);
    for (const expected of ["server-http", "unused-security-scheme", "operation-public", "security-scheme-undefined", "duplicate-operation-id", "operation-no-success-response", "deprecated-operation", "tag-undefined", "parameter-no-description", "operation-no-description", "operation-no-operation-id", "path-parameter-undefined", "operation-no-responses", "security-scheme-apikey-query", "security-scheme-http-basic", "operation-no-error-response"]) {
      assert.ok(rules.includes(expected), expected);
    }
    assert.ok(!rules.includes("path-unversioned"), "server URL is versioned");
    assert.ok(!rules.includes("no-security-schemes"));
    assert.ok(!rules.includes("operation-no-security"), "global security applies");
    assert.equal(r.findings[0].severity, "error");
    const dup = r.findings.find((f) => f.rule === "duplicate-operation-id");
    assert.equal(dup.path, "/paths/~1pets~1{petId}/delete");
    assert.match(dup.message, /GET \/pets/);
    const ignored = parse(await client.callTool({ name: "lint_openapi", arguments: { path: FIXTURE, ignore: ["parameter-no-description", "tag-undefined", "security-scheme-apikey-query"] } }));
    assert.ok(!ignored.findings.some((f) => f.rule === "parameter-no-description"));
    assert.ok(!ignored.findings.some((f) => f.rule === "security-scheme-apikey-query"));
    assert.equal(ignored.findings.length, r.findings.length - r.findings.filter((f) => ["parameter-no-description", "tag-undefined", "security-scheme-apikey-query"].includes(f.rule)).length);
  } finally {
    await close();
  }
});
