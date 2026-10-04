import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SERVER_NAME } from "../dist/index.js";

// npm installs a bin as a symlink to dist/index.js; the server must still start when run that way.
test("starts on stdio when run through a symlinked bin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-bin-"));
  const link = join(dir, "server-bin");
  symlinkSync(fileURLToPath(new URL("../dist/index.js", import.meta.url)), link);
  const client = new Client({ name: "bin-test", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [link], stderr: "ignore" }));
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
