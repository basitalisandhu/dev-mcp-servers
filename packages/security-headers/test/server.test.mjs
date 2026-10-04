import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../dist/index.js";
import { assertPublicUrl, fetchHeaders, isPrivateAddress } from "../dist/fetcher.js";

const GOOD = {
  "content-security-policy": "default-src 'self'; script-src 'self' 'nonce-abc'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const resolve = async (host) => {
  if (host === "public.example") return ["93.184.216.34"];
  if (host === "evil.example") return ["93.184.216.34", "10.0.0.5"];
  if (host === "v6.example") return ["2606:2800:220:1:248:1893:25c8:1946"];
  throw new Error("ENOTFOUND");
};

function fakeFetch(log = []) {
  return async (url, init) => {
    const u = new URL(url);
    log.push({ url: u.toString(), method: init.method, redirect: init.redirect });
    if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "/final" } });
    if (u.pathname === "/to-private") return new Response(null, { status: 301, headers: { location: "http://127.0.0.1/admin" } });
    if (u.pathname === "/loop") return new Response(null, { status: 302, headers: { location: "/loop" } });
    if (u.pathname === "/nohead" && init.method === "HEAD") return new Response(null, { status: 405 });
    if (u.pathname === "/nohead") return new Response("body", { status: 200, headers: { "x-content-type-options": "nosniff" } });
    if (u.pathname === "/cookies") {
      const h = new Headers({ "set-cookie": "a=1; Path=/" });
      h.append("set-cookie", "b=2; Secure; HttpOnly; SameSite=Lax");
      return new Response(null, { status: 200, headers: h });
    }
    if (u.pathname === "/final") return new Response("ignored body", { status: 200, headers: GOOD });
    return new Response(null, { status: 200, headers: { server: "nginx/1.18.0", "x-powered-by": "Express", "x-xss-protection": "1; mode=block" } });
  };
}

async function connected(fetchImpl) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ fetchImpl, resolve });
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const parse = (r) => JSON.parse(r.content[0].text);

test("lists three tools and names the server", async () => {
  const { client, close } = await connected(fakeFetch());
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["check_url_headers", "explain_header", "grade_headers"]);
    assert.equal(tools.find((t) => t.name === "grade_headers").annotations.openWorldHint, false);
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  } finally {
    await close();
  }
});

test("check_url_headers follows a redirect, grades the final response and never reads the body", async () => {
  const log = [];
  const { client, close } = await connected(fakeFetch(log));
  try {
    const r = parse(await client.callTool({ name: "check_url_headers", arguments: { url: "https://public.example/redirect" } }));
    assert.equal(r.status, 200);
    assert.equal(r.final_url, "https://public.example/final");
    assert.equal(r.redirects.length, 1);
    assert.equal(r.report.grade, "A+");
    assert.ok(r.report.checks.every((c) => c.status !== "fail"));
    assert.ok(log.every((l) => l.redirect === "manual" && l.method === "HEAD"));

    const bare = parse(await client.callTool({ name: "check_url_headers", arguments: { url: "https://public.example/bare" } }));
    assert.equal(bare.report.grade, "F");
    const byName = Object.fromEntries(bare.report.checks.map((c) => [c.header, c]));
    assert.equal(byName["content-security-policy"].status, "fail");
    assert.equal(byName.server.status, "warn");
    assert.equal(byName["x-powered-by"].status, "info");
    assert.equal(byName["x-xss-protection"].status, "warn");

    const fallback = parse(await client.callTool({ name: "check_url_headers", arguments: { url: "https://public.example/nohead" } }));
    assert.equal(fallback.method, "GET");
    assert.equal(fallback.headers["x-content-type-options"], "nosniff");

    const cookies = parse(await client.callTool({ name: "check_url_headers", arguments: { url: "https://public.example/cookies" } }));
    assert.equal(cookies.set_cookie.length, 2);
    const cookieCheck = cookies.report.checks.find((c) => c.header === "set-cookie");
    assert.equal(cookieCheck.status, "warn");
    assert.match(cookieCheck.explanation, /a lacks Secure, HttpOnly, SameSite/);
  } finally {
    await close();
  }
});

test("check_url_headers refuses private targets, redirect to private, loops and bad schemes", async () => {
  const { client, close } = await connected(fakeFetch());
  try {
    for (const url of ["http://localhost:3000/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://10.1.2.3/", "http://evil.example/", "ftp://public.example/", "http://user:pw@public.example/", "http://unknown.example/"]) {
      const r = await client.callTool({ name: "check_url_headers", arguments: { url } });
      assert.equal(r.isError, true, url);
    }
    const toPrivate = await client.callTool({ name: "check_url_headers", arguments: { url: "https://public.example/to-private" } });
    assert.equal(toPrivate.isError, true);
    assert.match(toPrivate.content[0].text, /127\.0\.0\.1/);
    const loop = await client.callTool({ name: "check_url_headers", arguments: { url: "https://public.example/loop", max_redirects: 2 } });
    assert.equal(loop.isError, true);
    assert.match(loop.content[0].text, /more than 2 redirects/);
  } finally {
    await close();
  }
});

test("grade_headers scores a supplied set and explain_header documents each header", async () => {
  const { client, close } = await connected(fakeFetch());
  try {
    const weak = parse(await client.callTool({ name: "grade_headers", arguments: { headers: { "Content-Security-Policy": "default-src *; script-src * 'unsafe-inline' 'unsafe-eval'", "Strict-Transport-Security": "max-age=300", "X-Frame-Options": "ALLOW-FROM https://x", "Referrer-Policy": "unsafe-url", "Set-Cookie": ["s=1; SameSite=None"] } } }));
    const by = Object.fromEntries(weak.checks.map((c) => [c.header, c]));
    assert.equal(by["content-security-policy"].status, "fail");
    assert.match(by["content-security-policy"].explanation, /unsafe-inline/);
    assert.equal(by["strict-transport-security"].status, "warn");
    assert.equal(by["x-frame-options"].status, "warn");
    assert.equal(by["referrer-policy"].status, "fail");
    assert.match(by["set-cookie"].explanation, /Secure \(required with SameSite=None\)/);
    assert.ok(["D", "F"].includes(weak.grade));

    const http = parse(await client.callTool({ name: "grade_headers", arguments: { headers: GOOD, https: false } }));
    assert.equal(http.checks.find((c) => c.header === "strict-transport-security").status, "info");
    assert.ok(http.notes.some((n) => /plain HTTP/.test(n)));

    const cspOnlyFrames = parse(await client.callTool({ name: "grade_headers", arguments: { headers: { "content-security-policy": "default-src 'self'; frame-ancestors 'self'" } } }));
    assert.equal(cspOnlyFrames.checks.find((c) => c.header === "x-frame-options").status, "pass");

    const doc = parse(await client.callTool({ name: "explain_header", arguments: { header: "strict-transport-security" } }));
    assert.match(doc.recommended, /max-age=31536000/);
    assert.match(doc.reference, /^https:\/\//);
    const bad = await client.callTool({ name: "explain_header", arguments: { header: "x-made-up" } });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});

test("address classification and URL validation", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.5", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "ff02::1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
  await assert.rejects(assertPublicUrl("not a url", resolve), /not an absolute URL/);
  await assert.rejects(assertPublicUrl("http://app.internal/", resolve), /local hostname/);
  await assert.rejects(assertPublicUrl("http://evil.example/", resolve), /10\.0\.0\.5/);
  const ok = await assertPublicUrl("https://v6.example/x", resolve);
  assert.equal(ok.hostname, "v6.example");
  await assert.rejects(fetchHeaders("https://public.example/", "HEAD", { fetchImpl: async () => { throw new Error("timeout"); }, resolve }), /failed: timeout/);
});
