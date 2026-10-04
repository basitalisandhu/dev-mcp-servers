import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkServer } from "./check-server-json.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (name, file) => JSON.parse(readFileSync(join(root, "packages", name, file), "utf8"));
const good = () => ({ server: load("jwt-tools", "server.json"), pkg: load("jwt-tools", "package.json") });

test("the committed jwt-tools server.json passes", () => {
  const { server, pkg } = good();
  assert.deepEqual(checkServer("jwt-tools", server, pkg), []);
});

test("an npm entry is rejected because the registry only verifies npmjs.org", () => {
  const { server, pkg } = good();
  server.packages = [{ registryType: "npm", registryBaseUrl: "https://registry.npmjs.org", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } }];
  assert.ok(checkServer("jwt-tools", server, pkg).some((p) => p.includes("registryType npm")));
});

test("an OCI entry with a version field or a wrong tag is rejected", () => {
  const { server, pkg } = good();
  server.packages[0].version = server.version;
  server.packages[0].identifier = "ghcr.io/basitalisandhu/mcp-jwt-tools:latest";
  const problems = checkServer("jwt-tools", server, pkg);
  assert.ok(problems.some((p) => p.includes("must not have version")));
  assert.ok(problems.some((p) => p.includes("should be ghcr.io/basitalisandhu/mcp-jwt-tools:")));
});

test("name, $schema, websiteUrl, repository and description are enforced", () => {
  const { server, pkg } = good();
  server.name = "io.github.basitalisandhu/jwt-tools";
  server.$schema = "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json";
  server.websiteUrl = "https://example.com/";
  server.repository.source = "gitlab";
  server.description = "x".repeat(101);
  const problems = checkServer("jwt-tools", server, pkg).join("\n");
  for (const want of ["name should be", "$schema should be", "websiteUrl should be", "repository.source", "description must be"]) {
    assert.ok(problems.includes(want), `expected a problem mentioning ${want}:\n${problems}`);
  }
});
