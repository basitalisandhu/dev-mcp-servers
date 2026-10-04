import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../dist/index.js";
import { check, extractMeta, parseSitemap, toUrl } from "../dist/llms.js";

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "llms-"));
  await mkdir(join(dir, "guide"));
  await mkdir(join(dir, "api", "v2"), { recursive: true });
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(dir, ".hidden"));
  await writeFile(join(dir, "README.md"), "# Demo Project\n\nA **small** project to [test](x) things.\nSecond line of the paragraph.\n\n## Install\n");
  await writeFile(join(dir, "guide", "01-getting-started.md"), "---\ntitle: \"Getting started\"\ndescription: 'Install and run in two minutes.'\n---\n\n# Ignored heading\n\nBody.\n");
  await writeFile(join(dir, "guide", "faq.mdx"), "import X from 'y'\n\n```js\nconst a = 1\n```\n\nQuestions people ask.\n");
  await writeFile(join(dir, "api", "v2", "index.md"), "# API v2\n");
  await writeFile(join(dir, "node_modules", "pkg", "README.md"), "# Not included\n");
  await writeFile(join(dir, ".hidden", "secret.md"), "# Not included\n");
  await writeFile(join(dir, "notes.txt"), "not markdown");
  await writeFile(join(dir, "sitemap.xml"), '<?xml version="1.0"?><urlset><url><loc>https://ex.com/</loc><lastmod>2026-01-01</lastmod></url><url><loc>https://ex.com/docs/getting-started</loc></url><url><loc>https://ex.com/docs/api/auth.html</loc></url><url><loc>https://ex.com/blog/hello-world</loc></url><url><loc>https://ex.com/legal/terms&amp;conditions</loc></url></urlset>');
  await writeFile(join(dir, "index.xml"), "<sitemapindex><sitemap><loc>https://ex.com/sitemap-1.xml</loc></sitemap></sitemapindex>");
});

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const parse = (r) => JSON.parse(r.content[0].text);

test("lists the three tools", async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["check_llms_txt", "generate_from_sitemap", "generate_llms_txt"]);
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  } finally {
    await close();
  }
});

test("generate_llms_txt scans Markdown, extracts titles and notes, groups and links", async () => {
  const { client, close } = await connected();
  try {
    const r = parse(await client.callTool({ name: "generate_llms_txt", arguments: { directory: dir, title: "Demo", description: "Docs for Demo.", base_url: "https://docs.example.com/", optional_sections: ["Api"] } }));
    assert.equal(r.entries, 4);
    assert.deepEqual(r.skipped, []);
    const c = r.content;
    assert.ok(c.startsWith("# Demo\n\n> Docs for Demo.\n\n## Docs\n"), c);
    assert.match(c, /- \[Demo Project\]\(https:\/\/docs\.example\.com\/\): A small project to test things\. Second line of the paragraph\./);
    assert.match(c, /## Guide\n\n- \[Getting started\]\(https:\/\/docs\.example\.com\/guide\/01-getting-started\/\): Install and run in two minutes\.\n- \[Faq\]\(https:\/\/docs\.example\.com\/guide\/faq\/\): Questions people ask\./);
    assert.match(c, /## Optional\n\n- \[API v2\]\(https:\/\/docs\.example\.com\/api\/v2\/\)\n$/);
    assert.ok(!c.includes("Not included"));
    assert.equal(check(c).valid, true);

    const kept = parse(await client.callTool({ name: "generate_llms_txt", arguments: { directory: dir, title: "Demo", url_style: "keep-extension", include_dirs: ["guide"] } }));
    assert.equal(kept.entries, 2);
    assert.match(kept.content, /\(\/guide\/faq\.mdx\)/);
    await mkdir(join(dir, "empty"), { recursive: true });
    const empty = await client.callTool({ name: "generate_llms_txt", arguments: { directory: join(dir, "empty"), title: "x" } });
    assert.equal(empty.isError, true);
    const missing = await client.callTool({ name: "generate_llms_txt", arguments: { directory: join(dir, "nope"), title: "x" } });
    assert.equal(missing.isError, true);
  } finally {
    await close();
  }
});

test("generate_from_sitemap groups URLs and honours filters and sitemap indexes", async () => {
  const { client, close } = await connected();
  try {
    const r = parse(await client.callTool({ name: "generate_from_sitemap", arguments: { path: join(dir, "sitemap.xml"), title: "Ex", description: "Site.", exclude_prefix: ["/legal"] } }));
    assert.equal(r.urls_in_sitemap, 5);
    assert.equal(r.entries, 4);
    assert.match(r.content, /## Blog\n\n- \[Hello World\]\(https:\/\/ex\.com\/blog\/hello-world\)/);
    assert.match(r.content, /## Docs\n\n- \[Getting Started\]\(https:\/\/ex\.com\/docs\/getting-started\)\n- \[Auth\]\(https:\/\/ex\.com\/docs\/api\/auth\.html\)/);
    assert.match(r.content, /## Pages\n\n- \[Home\]\(https:\/\/ex\.com\/\)/);
    const only = parse(await client.callTool({ name: "generate_from_sitemap", arguments: { path: join(dir, "sitemap.xml"), title: "Ex", include_prefix: ["/docs/"] } }));
    assert.equal(only.entries, 2);
    const idx = await client.callTool({ name: "generate_from_sitemap", arguments: { path: join(dir, "index.xml"), title: "Ex" } });
    assert.equal(idx.isError, true);
    assert.match(idx.content[0].text, /1 child sitemap/);
    const notXml = await client.callTool({ name: "generate_from_sitemap", arguments: { path: join(dir, "notes.txt"), title: "Ex" } });
    assert.equal(notXml.isError, true);
    assert.deepEqual(parseSitemap("<urlset><url><loc> https://a/&amp;b </loc></url></urlset>").urls, [{ url: "https://a/&b" }]);
  } finally {
    await close();
  }
});

test("check_llms_txt reports convention violations", async () => {
  const { client, close } = await connected();
  try {
    const good = parse(await client.callTool({ name: "check_llms_txt", arguments: { content: "# Title\n\n> Summary.\n\nSome details.\n\n## Docs\n\n- [A](https://x/a): notes\n- [B](https://x/b)\n\n## Optional\n\n- [C](/c): more\n" } }));
    assert.equal(good.valid, true);
    assert.deepEqual(good.errors, []);
    assert.deepEqual(good.warnings, []);
    assert.equal(good.stats.links, 3);
    assert.deepEqual(good.stats.sections, ["Docs", "Optional"]);
    assert.ok(good.info.some((i) => /no notes/.test(i.message)));

    const bad = parse(await client.callTool({ name: "check_llms_txt", arguments: { content: "Intro text\n# One\n# Two\n## Empty\n## Docs\n### Deep\n- plain bullet\n- [A](https://x/a): n\n- [A again](https://x/a)\nStray paragraph\n> late quote\n" } }));
    assert.equal(bad.valid, false);
    const msgs = [...bad.errors, ...bad.warnings].map((e) => e.message).join("\n");
    assert.match(msgs, /first line must be an H1/);
    assert.match(msgs, /only one H1/);
    assert.match(msgs, /"Empty" has no link items/);
    assert.match(msgs, /H3 and deeper/);
    assert.match(msgs, /must be markdown links/);
    assert.match(msgs, /duplicate URL/);
    assert.match(msgs, /paragraph text inside a section/);
    assert.match(msgs, /blockquotes belong/);
    assert.match(msgs, /no blockquote summary/);

    await writeFile(join(dir, "llms.txt"), "# F\n\n> s\n\n## S\n\n- [x](https://x): y\n");
    const fromFile = parse(await client.callTool({ name: "check_llms_txt", arguments: { path: join(dir, "llms.txt") } }));
    assert.equal(fromFile.valid, true);
    const neither = await client.callTool({ name: "check_llms_txt", arguments: {} });
    assert.equal(neither.isError, true);
    assert.equal(check("").valid, false);
  } finally {
    await close();
  }
});

test("meta extraction and URL mapping", () => {
  assert.deepEqual(extractMeta("---\ntitle: T\n---\n# H\n\nPara\n", "f.md"), { title: "T", description: "Para" });
  assert.deepEqual(extractMeta("# H #\n\n- list\n\nPara one.\n", "f.md"), { title: "H", description: "Para one." });
  assert.equal(extractMeta("no heading\n", "my-page.md").title, "My Page");
  assert.equal(extractMeta("# T\n\n" + "word ".repeat(100), "f.md").description.length <= 200, true);
  assert.equal(toUrl("README.md", "https://d.ex", "strip-extension"), "https://d.ex/");
  assert.equal(toUrl("a/index.md", undefined, "strip-extension"), "/a/");
  assert.equal(toUrl("a/b.md", "https://d.ex/base/", "keep-extension"), "https://d.ex/base/a/b.md");
});
