#!/usr/bin/env node
/**
 * Validates every packages/<name>/server.json against the vendored MCP registry schema
 * (scripts/server.schema.json, from https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
 * plus the rules the official registry (registry.modelcontextprotocol.io) applies on publish, and checks that
 * it agrees with the package's package.json. Runs offline.
 *
 * Registry rules mirrored here (see docs/modelcontextprotocol-io/package-types.mdx and
 * internal/validators/registries/oci.go in modelcontextprotocol/registry):
 *   - the name is io.github.basitalisandhu/mcp-<name>, so GitHub OIDC login for the repository owner can publish it;
 *   - each server ships as one OCI package, ghcr.io/basitalisandhu/mcp-<name>:<version>, whose image carries the
 *     label io.modelcontextprotocol.server.name=<name> (set in the Dockerfile and the publish workflow);
 *   - an OCI package has no registryBaseUrl, version or fileSha256 field: the version is the image tag;
 *   - npm entries are not used: the registry only verifies npm packages on registry.npmjs.org, and these
 *     packages are published to GitHub Packages.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, "server.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

export const SCHEMA_URL = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
export const OWNER = "basitalisandhu";
export const REPOSITORY_URL = `https://github.com/${OWNER}/dev-mcp-servers`;
export const WEBSITE_URL = `https://${OWNER}.github.io/dev-mcp-servers/`;
export const MAX_DESCRIPTION = 100;

/** Returns a list of problems with one server.json (empty when it is valid). */
export function checkServer(name, server, pkg) {
  const problems = [];
  if (!validate(server)) problems.push(...validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`));
  const expectedName = `io.github.${OWNER}/mcp-${name}`;
  if (server.$schema !== SCHEMA_URL) problems.push(`$schema should be ${SCHEMA_URL}`);
  if (server.name !== expectedName) problems.push(`name should be ${expectedName}`);
  if (server.name !== pkg.mcpName) problems.push(`server.json name ${server.name} differs from package.json mcpName ${pkg.mcpName}`);
  if (server.version !== pkg.version) problems.push(`server.json version ${server.version} differs from package.json version ${pkg.version}`);
  if (typeof server.description !== "string" || server.description.length === 0 || server.description.length > MAX_DESCRIPTION) {
    problems.push(`description must be 1 to ${MAX_DESCRIPTION} characters`);
  }
  if (server.websiteUrl !== WEBSITE_URL) problems.push(`websiteUrl should be ${WEBSITE_URL}`);
  if (server.repository?.url !== REPOSITORY_URL) problems.push(`repository.url should be ${REPOSITORY_URL}`);
  if (server.repository?.source !== "github") problems.push("repository.source should be github");
  if (server.repository?.subfolder !== `packages/${name}`) problems.push(`repository.subfolder should be packages/${name}`);

  const packages = server.packages ?? [];
  if (packages.length !== 1) problems.push(`expected exactly one package entry, found ${packages.length}`);
  for (const p of packages) {
    if (p.registryType !== "oci") {
      problems.push(`package registryType ${p.registryType} is not supported here: the registry verifies npm only on registry.npmjs.org`);
      continue;
    }
    const identifier = `ghcr.io/${OWNER}/mcp-${name}:${server.version}`;
    if (p.identifier !== identifier) problems.push(`oci identifier ${p.identifier} should be ${identifier}`);
    for (const field of ["registryBaseUrl", "version", "fileSha256"]) {
      if (field in p) problems.push(`oci package must not have ${field} (the version is the image tag)`);
    }
    if (p.transport?.type !== "stdio") problems.push("transport must be stdio");
  }
  if (!pkg.bin || !Object.values(pkg.bin).includes("dist/index.js")) problems.push("package.json bin must point at dist/index.js");
  return problems;
}

function main() {
  const root = join(here, "..");
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
    const problems = checkServer(name, server, pkg);
    if (problems.length) {
      failures++;
      console.error(`${name}:\n  ${problems.join("\n  ")}`);
    } else {
      console.log(`${name}: ok (${server.name}, ${server.packages[0].identifier}, ${server.description.length}/${MAX_DESCRIPTION} chars)`);
    }
  }
  if (failures) {
    console.error(`${failures} server.json file(s) failed`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
