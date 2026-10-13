// Guard for the test suites: every server must start, list at least one tool, and every tool it
// lists must be called by name in that package's own tests. Runs after `npm run build`, offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const packagesDir = new URL("../packages/", import.meta.url);
const packages = readdirSync(packagesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

test("there is at least one server package", () => {
  assert.ok(packages.length > 0);
});

for (const pkg of packages) {
  test(`${pkg}: starts, lists tools, and its tests call every tool`, async () => {
    const mod = await import(new URL(`${pkg}/dist/index.js`, packagesDir).href);
    assert.equal(typeof mod.createServer, "function", "dist/index.js exports createServer");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mod.createServer();
    await server.connect(serverTransport);
    const client = new Client({ name: "coverage-guard", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0, "lists at least one tool");
      const testDir = new URL(`${pkg}/test/`, packagesDir);
      const sources = readdirSync(testDir).filter((f) => f.endsWith(".test.mjs")).map((f) => readFileSync(new URL(f, testDir), "utf8")).join("\n");
      const uncalled = tools.map((t) => t.name).filter((name) => !sources.includes(`name: "${name}"`));
      assert.deepEqual(uncalled, [], `tools with no callTool in packages/${pkg}/test`);
    } finally {
      await client.close();
      await server.close();
    }
  });
}
