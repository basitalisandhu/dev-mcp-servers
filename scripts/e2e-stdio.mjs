// Start servers over stdio the way an MCP client does and check the README quick start.
//   node scripts/e2e-stdio.mjs <command> [args...]   one server, prints its tools
//   node scripts/e2e-stdio.mjs --all <packages dir>  every server, plus the decode_jwt sample
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function withServer(command, args, fn) {
  const transport = new StdioClientTransport({ command, args, stderr: "pipe" });
  const client = new Client({ name: "e2e-quickstart", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function checkJwtSample(client) {
  // The README sample: an unsigned token for user-1 that expired at 1700000000, decoded an hour later.
  const token = `${b64({ alg: "none" })}.${b64({ sub: "user-1", exp: 1700000000 })}.`;
  const result = await client.callTool({ name: "decode_jwt", arguments: { token, now: 1700003600 } });
  const r = JSON.parse(result.content[0].text);
  assert.equal(r.verified, false);
  assert.deepEqual(r.header, { alg: "none" });
  const byCode = Object.fromEntries(r.findings.map((f) => [f.code, f]));
  assert.equal(byCode["alg-none"].severity, "critical");
  assert.equal(byCode.expired.message, "Expired 1.0 h ago (exp 2023-11-14T22:13:20.000Z).");
  assert.equal(byCode["aud-missing"].severity, "medium");
  console.log("decode_jwt sample matches the README");
}

if (process.argv[2] === "--all") {
  const dir = path.resolve(process.argv[3]);
  for (const pkg of readdirSync(dir)) {
    const tools = await withServer(process.execPath, [path.join(dir, pkg, "dist", "index.js")], async (client) => {
      const { tools } = await client.listTools();
      if (pkg === "jwt-tools") await checkJwtSample(client);
      return tools.map((t) => t.name);
    });
    assert.ok(tools.length > 0, `${pkg} lists tools`);
    console.log(`${pkg}: ${tools.join(", ")}`);
  }
} else {
  const [command, ...args] = process.argv.slice(2);
  await withServer(command, args, async (client) => {
    const { tools } = await client.listTools();
    console.log(tools.map((t) => t.name).join(", "));
    if (tools.some((t) => t.name === "decode_jwt")) await checkJwtSample(client);
  });
}
