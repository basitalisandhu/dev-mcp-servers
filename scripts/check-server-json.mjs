#!/usr/bin/env node
/**
 * Validates every packages/<name>/server.json against the vendored MCP registry schema
 * (scripts/server.schema.json, from https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
 * and checks that it agrees with the package's package.json. Runs offline.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const schema = JSON.parse(readFileSync(join(here, "server.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

let failures = 0;
for (const name of readdirSync(join(root, "packages")).sort()) {
  const dir = join(root, "packages", name);
  let server;
  let pkg;
  try {
    server = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch (err) {
    console.error(`${name}: ${err.message}`);
    failures++;
    continue;
  }
  const problems = [];
  if (!validate(server)) problems.push(...validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`));
  if (server.name !== pkg.mcpName) problems.push(`server.json name ${server.name} differs from package.json mcpName ${pkg.mcpName}`);
  if (server.name !== `io.github.basitalisandhu/${name}`) problems.push(`name should be io.github.basitalisandhu/${name}`);
  if (server.version !== pkg.version) problems.push(`server.json version ${server.version} differs from package.json version ${pkg.version}`);
  const npm = (server.packages ?? []).find((p) => p.registryType === "npm");
  if (!npm) problems.push("no npm package entry");
  else {
    if (npm.identifier !== pkg.name) problems.push(`npm identifier ${npm.identifier} differs from package.json name ${pkg.name}`);
    if (npm.version !== pkg.version) problems.push(`npm package version ${npm.version} differs from package.json version ${pkg.version}`);
    if (npm.transport?.type !== "stdio") problems.push("transport must be stdio");
  }
  if (server.repository?.subfolder !== `packages/${name}`) problems.push(`repository.subfolder should be packages/${name}`);
  if (!pkg.bin || !Object.values(pkg.bin).includes("dist/index.js")) problems.push("package.json bin must point at dist/index.js");
  if (problems.length) {
    failures++;
    console.error(`${name}:\n  ${problems.join("\n  ")}`);
  } else {
    console.log(`${name}: ok (${server.description.length}/100 chars)`);
  }
}
if (failures) {
  console.error(`${failures} server.json file(s) failed`);
  process.exit(1);
}
