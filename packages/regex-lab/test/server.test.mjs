import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../dist/index.js";
import { explain, parse } from "../dist/ast.js";
import { analyse } from "../dist/redos.js";
import { runRegex } from "../dist/runner.js";

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const parseResult = (r) => JSON.parse(r.content[0].text);

test("lists the three tools", async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["check_redos", "explain_regex", "test_regex"]);
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  } finally {
    await close();
  }
});

test("test_regex reports matches, groups, replacements and invalid patterns", async () => {
  const { client, close } = await connected();
  try {
    const r = parseResult(await client.callTool({ name: "test_regex", arguments: { pattern: "(?<year>\\d{4})-(\\d{2})", flags: "i", samples: ["2024-05 and 1999-12", "none"], replacement: "$<year>/$2" } }));
    assert.equal(r.timed_out, false);
    assert.equal(r.results[0].match_count, 2);
    assert.equal(r.results[0].matches[0].text, "2024-05");
    assert.deepEqual(r.results[0].matches[0].groups.map((g) => [g.index, g.value, g.start]), [[1, "2024", 0], [2, "05", 5], ["year", "2024", 0]]);
    assert.equal(r.results[0].replaced, "2024/05 and 1999-12");
    assert.equal(r.results[1].matched, false);
    const empty = parseResult(await client.callTool({ name: "test_regex", arguments: { pattern: "x*", samples: ["ab"] } }));
    assert.equal(empty.results[0].match_count, 3);
    const bad = await client.callTool({ name: "test_regex", arguments: { pattern: "(", samples: ["a"] } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Invalid pattern/);
    const badFlags = await client.callTool({ name: "test_regex", arguments: { pattern: "a", flags: "x", samples: ["a"] } });
    assert.equal(badFlags.isError, true);
  } finally {
    await close();
  }
});

test("test_regex terminates a catastrophic pattern at the timeout and keeps finished samples", async () => {
  const { client, close } = await connected();
  try {
    const r = parseResult(await client.callTool({ name: "test_regex", arguments: { pattern: "^(a+)+$", samples: ["aaa", "a".repeat(40) + "!"], timeout_ms: 300 } }));
    assert.equal(r.timed_out, true);
    assert.equal(r.samples_completed, 1);
    assert.equal(r.results[0].matched, true);
    assert.match(r.note, /terminated/);
  } finally {
    await close();
  }
});

test("explain_regex describes constructs and rejects syntax errors", async () => {
  const { client, close } = await connected();
  try {
    const r = parseResult(await client.callTool({ name: "explain_regex", arguments: { pattern: "^(?<user>[\\w.]+)@(?:example|test)\\.com$|\\bfoo\\b", flags: "i" } }));
    assert.equal(r.capturing_groups, 1);
    const text = r.explanation.join("\n");
    assert.match(text, /named capturing group "user"/);
    assert.match(text, /non-capturing group/);
    assert.match(text, /one or more times/);
    assert.match(text, /2 alternatives/);
    assert.match(text, /word boundary/);
    assert.deepEqual(r.flag_meanings, ["i: case-insensitive"]);
    const bad = await client.callTool({ name: "explain_regex", arguments: { pattern: "a{3,1}" } });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});

test("check_redos flags nested quantifiers, overlapping alternation and adjacent overlaps, and probes them", async () => {
  const { client, close } = await connected();
  try {
    const nested = parseResult(await client.callTool({ name: "check_redos", arguments: { pattern: "^(a+)+$", timeout_ms: 400 } }));
    assert.equal(nested.findings[0].kind, "nested-quantifier");
    assert.equal(nested.findings[0].severity, "high");
    assert.equal(nested.findings[0].probe_char, "a");
    assert.equal(nested.verdict, "confirmed vulnerable");
    assert.ok(nested.probes[0].timed_out || nested.probes[0].growth_factors.some((g) => g >= 1.8));

    const alt = parseResult(await client.callTool({ name: "check_redos", arguments: { pattern: "^(a|ab)*c$", probe: false } }));
    assert.ok(alt.findings.some((f) => f.kind === "overlapping-alternation"));

    const adjacent = parseResult(await client.callTool({ name: "check_redos", arguments: { pattern: "\\d+\\d+x", probe: false } }));
    assert.equal(adjacent.findings[0].kind, "adjacent-overlap");
    assert.equal(adjacent.findings[0].severity, "medium");
    assert.equal(adjacent.verdict, "review");

    const safe = parseResult(await client.callTool({ name: "check_redos", arguments: { pattern: "^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$", flags: "i", timeout_ms: 1500 } }));
    assert.equal(safe.findings.length, 0);
    assert.equal(safe.verdict, "no known backtracking hazard found");
    assert.equal(safe.probes[0].timed_out, false);
    const bad = await client.callTool({ name: "check_redos", arguments: { pattern: "[" } });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});

test("parser and heuristics on their own", async () => {
  assert.equal(parse("(a)(?<b>b)(?:c)").groups, 2);
  assert.throws(() => parse("a)"), /unmatched/);
  assert.throws(() => parse("*a"), /nothing to repeat/);
  assert.match(explain(parse("[^a-z\\d]").ast).join("\n"), /any character NOT in the set/);
  assert.equal(analyse("(a+b)+").find((f) => f.kind === "nested-quantifier").severity, "medium");
  assert.equal(analyse("(\\d+\\s?)*$")[0].severity, "high");
  assert.deepEqual(analyse("^\\s*(\\w+)\\s*=\\s*(.*)$"), []);
  const run = await runRegex("a", "", ["a"], { timeoutMs: 500 });
  assert.equal(run.results[0].matched, true);
});
