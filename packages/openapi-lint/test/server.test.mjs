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
    for (const expected of ["server-http", "unused-security-scheme", "operation-public", "security-scheme-undefined", "duplicate-operation-id", "operation-no-success-response", "deprecated-operation", "tag-undefined", "parameter-no-description", "operation-no-description", "operation-no-operation-id", "path-parameter-undefined", "operation-no-responses"]) {
      assert.ok(rules.includes(expected), expected);
    }
    assert.ok(!rules.includes("path-unversioned"), "server URL is versioned");
    assert.ok(!rules.includes("no-security-schemes"));
    assert.ok(!rules.includes("operation-no-security"), "global security applies");
    assert.equal(r.findings[0].severity, "error");
    const dup = r.findings.find((f) => f.rule === "duplicate-operation-id");
    assert.equal(dup.path, "/paths/~1pets~1{petId}/delete");
    assert.match(dup.message, /GET \/pets/);
    const ignored = parse(await client.callTool({ name: "lint_openapi", arguments: { path: FIXTURE, ignore: ["parameter-no-description", "tag-undefined"] } }));
    assert.ok(!ignored.findings.some((f) => f.rule === "parameter-no-description"));
    assert.equal(ignored.findings.length, r.findings.length - r.findings.filter((f) => ["parameter-no-description", "tag-undefined"].includes(f.rule)).length);
  } finally {
    await close();
  }
});

test("lint_openapi handles inline JSON, objects, Swagger 2 and bad input", async () => {
  const { client, close } = await connected();
  try {
    const minimal = parse(await client.callTool({ name: "lint_openapi", arguments: { document: { openapi: "3.1.0", info: { title: "x", version: "1" }, paths: { "/things": { get: { responses: { 200: { description: "ok" } } } } } } } }));
    const rules = minimal.findings.map((f) => f.rule);
    for (const expected of ["info-description", "no-security-schemes", "operation-no-security", "operation-no-operation-id", "operation-no-description", "path-unversioned"]) assert.ok(rules.includes(expected), expected);
    const swagger = parse(await client.callTool({ name: "lint_openapi", arguments: { document: JSON.stringify({ swagger: "2.0", info: {}, paths: {} }) } }));
    assert.equal(swagger.findings[0].rule, "openapi-version");
    assert.match(swagger.findings[0].message, /Swagger 2.0/);
    const both = await client.callTool({ name: "lint_openapi", arguments: { path: FIXTURE, document: "{}" } });
    assert.equal(both.isError, true);
    const neither = await client.callTool({ name: "lint_openapi", arguments: {} });
    assert.equal(neither.isError, true);
    const missing = await client.callTool({ name: "lint_openapi", arguments: { path: "/nonexistent/openapi.yaml" } });
    assert.equal(missing.isError, true);
    const badYaml = await client.callTool({ name: "lint_openapi", arguments: { document: "openapi: [unclosed" } });
    assert.equal(badYaml.isError, true);
    const list = await client.callTool({ name: "lint_openapi", arguments: { document: "- a\n- b" } });
    assert.equal(list.isError, true);
    assert.throws(() => parseDocument("{ not json"), /not valid JSON/);
  } finally {
    await close();
  }
});

test("list_operations reports effective security and filters", async () => {
  const { client, close } = await connected();
  try {
    const text = await readFile(FIXTURE, "utf8");
    const r = parse(await client.callTool({ name: "list_operations", arguments: { document: text } }));
    assert.equal(r.count, 5);
    const byId = Object.fromEntries(r.operations.map((o) => [`${o.method} ${o.path}`, o]));
    assert.deepEqual(byId["GET /pets"].security, [["bearer"]]);
    assert.equal(byId["POST /pets"].security, "public");
    assert.deepEqual(byId["POST /pets"].request_body, ["application/json"]);
    assert.deepEqual(byId["GET /pets/{petId}"].parameters, [{ name: "petId", in: "path", required: true }]);
    assert.deepEqual(byId["GET /pets/{petId}"].responses, ["200", "404"]);
    assert.equal(byId["DELETE /pets/{petId}"].deprecated, true);
    const filtered = parse(await client.callTool({ name: "list_operations", arguments: { document: text, tag: "pets" } }));
    assert.equal(filtered.count, 1);
    const prefixed = parse(await client.callTool({ name: "list_operations", arguments: { document: text, path_prefix: "/owners", method: "get" } }));
    assert.equal(prefixed.count, 1);
    const none = lint({ openapi: "3.0.0", info: {}, paths: { "/a": { get: { responses: { 200: { description: "x" } } } } } });
    assert.ok(none.some((f) => f.rule === "operation-no-security"));
  } finally {
    await close();
  }
});

test("get_operation resolves references and explain_rule documents rules", async () => {
  const { client, close } = await connected();
  try {
    const byId = parse(await client.callTool({ name: "get_operation", arguments: { path: FIXTURE, operation_id: "getPet" } }));
    assert.equal(byId.method, "GET");
    assert.equal(byId.operation.parameters[0].name, "petId");
    assert.equal(byId.operation.responses["404"].description, "Not found.");
    assert.deepEqual(byId.effective_security, [{ bearer: [] }]);
    const byPath = parse(await client.callTool({ name: "get_operation", arguments: { path: FIXTURE, method: "post", operation_path: "/pets" } }));
    assert.equal(byPath.operation.operationId, "createPet");
    const missing = await client.callTool({ name: "get_operation", arguments: { path: FIXTURE, operation_id: "nope" } });
    assert.equal(missing.isError, true);
    const incomplete = await client.callTool({ name: "get_operation", arguments: { path: FIXTURE, method: "get" } });
    assert.equal(incomplete.isError, true);
    for (const rule of Object.keys(RULES)) {
      const doc = parse(await client.callTool({ name: "explain_rule", arguments: { rule } }));
      assert.ok(doc.description.length > 20 && doc.fix.length > 10, rule);
    }
    const bad = await client.callTool({ name: "explain_rule", arguments: { rule: "no-such-rule" } });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});
