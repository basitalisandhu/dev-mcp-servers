import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../dist/index.js";
import { diffSchemas, inferSchema, validate } from "../dist/schema.js";

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const parse = (r) => JSON.parse(r.content[0].text);

const USER = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { id: { type: "integer", minimum: 1 }, email: { type: "string", format: "email" }, tags: { type: "array", items: { type: "string" }, maxItems: 3 }, role: { enum: ["admin", "user"] } },
  required: ["id", "email"],
  additionalProperties: false,
};

test("lists the three tools", async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["diff_schemas", "infer_schema", "validate_json"]);
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  } finally {
    await close();
  }
});

test("validate_json reports every violation with paths, across drafts", async () => {
  const { client, close } = await connected();
  try {
    const ok = parse(await client.callTool({ name: "validate_json", arguments: { schema: USER, data: { id: 1, email: "a@b.co", tags: ["x"], role: "admin" } } }));
    assert.equal(ok.valid, true);
    assert.equal(ok.draft, "draft-07");
    const bad = parse(await client.callTool({ name: "validate_json", arguments: { schema: JSON.stringify(USER), data: JSON.stringify({ id: 0, email: "nope", tags: [1, 2, 3, 4], role: "root", extra: true }) } }));
    assert.equal(bad.valid, false);
    const keywords = bad.errors.map((e) => e.keyword).sort();
    assert.deepEqual(keywords, ["additionalProperties", "enum", "format", "maxItems", "minimum", "type", "type", "type", "type"]);
    assert.ok(bad.errors.some((e) => e.path === "/id" && e.keyword === "minimum"));
    assert.ok(bad.errors.some((e) => e.path === "/tags/0" && e.keyword === "type"));
    const s2020 = parse(await client.callTool({ name: "validate_json", arguments: { schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "array", prefixItems: [{ type: "string" }], items: false }, data: ["a", "b"] } }));
    assert.equal(s2020.draft, "2020-12");
    assert.equal(s2020.valid, false);
    const s2019 = parse(await client.callTool({ name: "validate_json", arguments: { schema: { type: "object", dependentRequired: { a: ["b"] } }, data: { a: 1 }, draft: "2019-09" } }));
    assert.equal(s2019.valid, false);
    assert.equal(s2019.errors[0].keyword, "dependentRequired");
    const literal = parse(await client.callTool({ name: "validate_json", arguments: { schema: { type: "string" }, data: "\"text\"" } }));
    assert.equal(literal.valid, true);
    const notJson = await client.callTool({ name: "validate_json", arguments: { schema: "{", data: 1 } });
    assert.equal(notJson.isError, true);
    const draft4 = await client.callTool({ name: "validate_json", arguments: { schema: { $schema: "http://json-schema.org/draft-04/schema#", type: "string" }, data: "x" } });
    assert.equal(draft4.isError, true);
    const bogus = await client.callTool({ name: "validate_json", arguments: { schema: { type: "banana" }, data: 1 } });
    assert.equal(bogus.isError, true);
    assert.match(bogus.content[0].text, /does not compile/);
  } finally {
    await close();
  }
});

test("infer_schema unions types, finds required keys, nests and detects formats", async () => {
  const { client, close } = await connected();
  try {
    const samples = [
      { id: 1, name: "a", created: "2024-01-01T00:00:00Z", tags: ["x"], meta: { k: 1 }, status: "open" },
      { id: 2, name: null, created: "2024-02-01T10:00:00+01:00", tags: [], meta: { k: 2.5, extra: true }, status: "closed" },
      { id: 3.5, name: "c", created: "2024-03-01T00:00:00Z", tags: ["y", "z"], meta: { k: 3 }, status: "open" },
    ];
    const r = parse(await client.callTool({ name: "infer_schema", arguments: { samples, enum_threshold: 3, title: "Ticket" } }));
    const s = r.schema;
    assert.equal(r.samples, 3);
    assert.equal(s.title, "Ticket");
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(s.type, "object");
    assert.deepEqual(s.required, ["created", "id", "meta", "name", "status", "tags"]);
    assert.equal(s.properties.id.type, "number");
    assert.deepEqual(s.properties.name.type, ["string", "null"]);
    assert.equal(s.properties.created.format, "date-time");
    assert.deepEqual(s.properties.tags, { type: "array", items: { type: "string" } });
    assert.deepEqual(s.properties.meta.required, ["k"]);
    assert.equal(s.properties.meta.properties.extra.type, "boolean");
    assert.deepEqual(s.properties.status.enum, ["closed", "open"]);
    assert.equal(validate(s, samples[1]).valid, true);

    const single = parse(await client.callTool({ name: "infer_schema", arguments: { samples: JSON.stringify({ email: "x@y.z", id: "123e4567-e89b-12d3-a456-426614174000", url: "https://example.com/a" }) } }));
    assert.equal(single.schema.properties.email.format, "email");
    assert.equal(single.schema.properties.id.format, "uuid");
    assert.equal(single.schema.properties.url.format, "uri");
    assert.deepEqual(inferSchema([[]]), { type: "array", items: {} });
    const bad = await client.callTool({ name: "infer_schema", arguments: { samples: "not json" } });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});

test("diff_schemas classifies changes", async () => {
  const { client, close } = await connected();
  try {
    const after = {
      ...USER,
      properties: { ...USER.properties, id: { type: "number", minimum: 2 }, name: { type: "string" }, tags: { type: "array", items: { type: "string" }, maxItems: 5 }, role: { enum: ["admin"] }, phone: { type: "string" } },
      required: ["id", "email", "name", "tags"],
    };
    delete after.properties.email;
    const r = parse(await client.callTool({ name: "diff_schemas", arguments: { before: USER, after } }));
    assert.equal(r.verdict, "breaking");
    const by = Object.fromEntries(r.details.map((c) => [`${c.path} ${c.change}`, c.impact]));
    assert.equal(by["/properties/email property removed"], "breaking");
    assert.equal(by["/properties/name property added"], "breaking");
    assert.equal(by["/properties/phone property added"], "compatible");
    assert.equal(by["/properties/id type"], "compatible");
    assert.equal(by["/properties/id/minimum minimum"], "breaking");
    assert.equal(by["/properties/tags/maxItems maxItems"], "compatible");
    assert.equal(by["/properties/role/enum enum"], "breaking");
    assert.equal(by["/required required added"], "breaking");
    assert.equal(r.details.find((c) => c.change === "required added").after, "tags");
    assert.equal(r.breaking, 5);

    const same = parse(await client.callTool({ name: "diff_schemas", arguments: { before: USER, after: JSON.stringify(USER) } }));
    assert.equal(same.verdict, "identical");
    const loosened = diffSchemas({ type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string", pattern: "^x" } } }, { type: "object", properties: { a: { type: "string" } }, description: "d" });
    assert.ok(loosened.every((c) => c.impact === "compatible"), JSON.stringify(loosened));
    const composed = diffSchemas({ oneOf: [{ type: "string" }] }, { oneOf: [{ type: "number" }] });
    assert.equal(composed[0].impact, "review");
    const bad = await client.callTool({ name: "diff_schemas", arguments: { before: "[]", after: {} } });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});
