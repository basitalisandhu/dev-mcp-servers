// Seeded fuzz and scaling tests for every parser in the repository, and a pass that calls
// every offline tool of every server with generated arguments. Runs after `npm run build`,
// with no network: fetch is replaced and the network tools are left out. A parser may
// reject bad input with its own Error; an internal TypeError or RangeError, a non-Error
// throw, or a case slower than 2 s fails the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = (pkg, f) => import(path.join(repo, "packages", pkg, "dist", f));
const ROUNDS = Number(process.env.FUZZ_ROUNDS ?? 400);
const failures = [];

/** A seeded linear congruential generator, so a failing case reproduces. */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const cron = await P("cron-tools", "cron.js"), dock = await P("dockerfile-lint", "dockerfile.js"), jwt = await P("jwt-tools", "jwt.js");
const rx = await P("regex-lab", "ast.js"), redos = await P("regex-lab", "redos.js"), oa = await P("openapi-lint", "lint.js"), lock = await P("osv-advisories", "lockfiles.js");
const llms = await P("llms-txt", "llms.js"), js = await P("json-schema-tools", "schema.js"), sh = await P("security-headers", "grade.js"), di = await P("dockerfile-lint", "dockerignore.js");

let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const CH = ['\u0000', '\n', '\r', ' ', '\t', '"', "'", '\\', '{', '}', '[', ']', '(', ')', '*', '+', '?', '|', '^', '$', '/', ',', '-', ':', '=', '<', '>', '&', '#', '@', '0', '9', 'a', 'Z', '\u202e', '\ud800', 'é', '%'];
function mutate(s) { let a = [...s]; const n = 1 + Math.floor(rnd() * 6); for (let i = 0; i < n; i++) { const op = rnd(); const p = Math.floor(rnd() * (a.length + 1)); if (op < 0.4) a.splice(p, 0, pick(CH)); else if (op < 0.7) a.splice(p, 1); else if (op < 0.85) a.splice(p, 0, ...a.slice(p, p + Math.floor(rnd() * 20))); else a[p] = pick(CH); } return a.join(''); }
const internal = /TypeError|RangeError|ReferenceError|Maximum call stack|is not a function|Cannot read|is not iterable|undefined/;
function run(name, fn, input) {
  const started = Date.now();
  try {
    fn(input);
  } catch (e) {
    const m = `${e?.constructor?.name}: ${e?.message}`;
    if (internal.test(m) || !(e instanceof Error)) failures.push(`${name}: ${m.slice(0, 140)} on ${JSON.stringify(input).slice(0, 160)}`);
  }
  const elapsed = Date.now() - started;
  if (elapsed > 2000) failures.push(`${name}: took ${elapsed} ms on ${JSON.stringify(input).slice(0, 120)}`);
}
const tok = (h, p) => Buffer.from(JSON.stringify(h)).toString('base64url') + '.' + Buffer.from(JSON.stringify(p)).toString('base64url') + '.sig';
const seeds = {
  cron: ['*/15 9-17 1,15 jan-mar mon-fri', '@weekly', '0 0 L * *', '5 4 * * sun', '0 0 1-31/2 * 1-5'],
  docker: ['FROM node:20 AS build\nRUN npm ci\nCOPY . .\nUSER node\nENV API_KEY=x\nHEALTHCHECK CMD true\nARG A=1\nADD x y\nRUN apt-get update && apt-get install -y curl \\\n  && rm -rf /var/lib/apt/lists/*\nFROM scratch\nCOPY --from=build /a /b\nEXPOSE 80\nCMD ["node","x"]\n', '# syntax=docker/dockerfile:1\nFROM alpine@sha256:abc\nRUN <<EOF\necho hi\nEOF\n'],
  jwt: [tok({ alg: 'none' }, { sub: 'u', exp: 1700000000 }), tok({ alg: 'HS256', typ: 'JWT' }, { aud: ['a'], nbf: 1, iat: 1e12 }), tok({ alg: 'ES256', kid: 'k' }, { exp: 'x' })],
  rx: ['^(a+)+$', '(?<year>\\d{4})-(?<m>\\d\\d)', '[a-z\\d_-]+@[^\\s]+', '(?:a|b)*?c{2,5}\\b(?=x)(?!y)(?<=z)', '\\p{L}+\\u{1F600}', '((a*)*)*b'],
  oa: [JSON.stringify({ openapi: '3.1.0', info: { title: 't', version: '1' }, paths: { '/a/{id}': { parameters: [{ $ref: '#/components/parameters/id' }], get: { operationId: 'g', responses: { 200: { description: 'ok' } }, security: [{ k: [] }] } } }, components: { parameters: { id: { name: 'id', in: 'path', required: true } }, securitySchemes: { k: { type: 'apiKey', in: 'header', name: 'X' } } } }), 'openapi: 3.0.0\ninfo:\n  title: t\n  version: 1\npaths:\n  /x:\n    get:\n      responses:\n        "200":\n          $ref: "#/components/responses/ok"\n'],
  lock: [['package-lock', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b/node_modules/c': { version: '2.0.0' } } })], ['requirements', 'requests==2.31.0\nflask>=2  # x\n-e git+https://x\n--hash=sha256:abc\n'], ['poetry', '[[package]]\nname = "a"\nversion = "1.0"\n'], ['go-sum', 'golang.org/x/net v0.1.0 h1:abc=\ngolang.org/x/net v0.1.0/go.mod h1:def=\n'], ['cargo', '[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n'], ['gemfile', 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.3)\n      x (>= 1)\n\nPLATFORMS\n  ruby\n'], ['uv', 'version = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "anyio"\nversion = "4.4.0"\nsource = { registry = "https://pypi.org/simple" }\ndependencies = [\n    { name = "idna" },\n]\n\n[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n']],
  sitemap: ['<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://x.example/a</loc></url><url><loc>https://x.example/docs/b?q=1&amp;r=2</loc></url></urlset>'],
  llms: ['# Title\n\n> Summary\n\nDetails\n\n## Docs\n\n- [A](https://x/a): note\n- [B](/b)\n\n## Optional\n\n- [C](c)\n'],
  schema: [JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { a: { type: 'string', pattern: '^x', format: 'email' }, b: { $ref: '#/$defs/b' } }, $defs: { b: { type: 'array', items: { type: 'integer' } } }, required: ['a'] })],
  ignore: ['node_modules\n!keep\n**/*.pem\n.env*\n# c\n/.git\n'],
};

test("every parser survives seeded mutations of valid input", () => {
  failures.length = 0;
  for (let i = 0; i < ROUNDS; i++) {
  run('cron.parse', (x) => { cron.parseCron(x); cron.validateCron(x); cron.explainCron(x); }, mutate(pick(seeds.cron)));
  run('cron.next', (x) => cron.nextRuns(cron.parseCron('*/7 * * * *'), Date.UTC(2026,2,29,0,30), x, 50), pick(['UTC', 'Europe/London', 'Asia/Karachi', 'America/New_York', 'Australia/Lord_Howe', 'Pacific/Chatham']));
  run('docker', (x) => { dock.lint(dock.parseDockerfile(x), {}); }, mutate(pick(seeds.docker)));
  run('dockerignore', (x) => di.exposedSensitiveRoots(x), mutate(pick(seeds.ignore)));
  run('jwt', (x) => { jwt.analyseJwt(jwt.decodeJwt(x), { now: 1700000000 }); }, rnd() < 0.5 ? mutate(pick(seeds.jwt)) : tok(JSON.parse(pick(['{"alg":1}', '{"alg":"HS256","crit":["x"]}', '[]', 'null', '"x"', '{"alg":"RS256","kid":{}}'])), JSON.parse(pick(['{"exp":1e400}', '{"exp":-1e20,"iat":"x","nbf":[]}', '[]', 'null', '{"aud":{}}', '{"exp":8.64e15}']))));
  run('rx', (x) => { const r = rx.parse(x); rx.explain(r.ast); redos.analyse(x, ''); }, mutate(pick(seeds.rx)));
  run('openapi', (x) => { const d = oa.parseDocument(x); oa.lint(d, {}); oa.listOperations(d); }, mutate(pick(seeds.oa)));
  const [fmt, txt] = pick(seeds.lock); run('lock.' + fmt, (x) => { lock.parseLockfile(x, fmt); lock.detectFormat(undefined, x); }, mutate(txt));
  run('sitemap', (x) => llms.entriesFromSitemap(llms.parseSitemap(x).urls, {}), mutate(pick(seeds.sitemap)));
  run('llms.check', (x) => llms.check(x), mutate(pick(seeds.llms)));
  run('schema', (x) => { const s = JSON.parse(x); js.detectDraft(s); js.validate(s, { a: 'x@y.z', b: [1] }); js.diffSchemas(s, JSON.parse(pick(seeds.schema))); js.inferSchema([s, { a: 1 }], {}); }, mutate(pick(seeds.schema)));
  run('headers', (x) => sh.gradeHeaders(sh.toHeaderSet(x, true)), { 'content-security-policy': mutate("default-src 'self'; script-src 'unsafe-inline' https:"), 'strict-transport-security': mutate('max-age=31536000; includeSubDomains'), 'set-cookie': [mutate('a=b; Secure; HttpOnly; SameSite=None')], 'permissions-policy': mutate('camera=*, geolocation=(self "https://x")') });
}
  assert.deepEqual(failures, []);
});

// ---- every offline tool of every server, through MCP -------------------------------------

const NETWORK_TOOLS = new Set([
  "security-headers/check_url_headers",
  "osv-advisories/query_package",
  "osv-advisories/query_batch",
  "osv-advisories/get_vulnerability",
  "osv-advisories/scan_lockfile",
]);
const STRINGS = ["", " ", "a", "\u0000", "\ud800", "‮", "0", "-1", "{", "[", "((a+)+)+$", "(?<a>", "\\", "*/0 * * * *", "@reboot", "60 24 32 13 8", "FROM\nUSER", "eyJ.eyJ.", "a.b.c", '{"openapi":"3.1.0","paths":{"/a":{"get":{}}}}', "<urlset><url><loc>http://x</loc></url></urlset>", "HEAD~999999", "--output=x", '{"$ref":"#"}', "é".repeat(100)];

function argumentsFor(schema, dir, gitdir, next, depth = 0) {
  const pick = (items) => items[Math.floor(next() * items.length)];
  const value = (s, name, d) => {
    if (next() < 0.05) return pick([null, 1, "x", [], {}, true]);
    if (name === "path" || name === "directory") {
      const file = path.join(dir, `in-${Math.floor(next() * 3)}`);
      writeFileSync(file, next() < 0.5 ? pick(STRINGS) : Buffer.from(Array.from({ length: Math.floor(next() * 200) }, () => Math.floor(next() * 256))));
      return next() < 0.3 ? dir : file;
    }
    if (name === "repo") return next() < 0.8 ? gitdir : pick(STRINGS);
    if (s?.enum) return pick(s.enum);
    if (s?.anyOf) return value(pick(s.anyOf), name, d);
    const type = Array.isArray(s?.type) ? pick(s.type) : s?.type;
    switch (type) {
      case "string": {
        const text = pick(STRINGS) + (next() < 0.3 ? pick(STRINGS) : "");
        return typeof s.maxLength === "number" ? text.slice(0, s.maxLength) : text;
      }
      case "number":
      case "integer": {
        const n = pick([0, -1, 1, 1e9, -1e9, 0.5, 65535, 100, 7]);
        const lo = s.minimum ?? s.exclusiveMinimum ?? -Infinity, hi = s.maximum ?? s.exclusiveMaximum ?? Infinity;
        return next() < 0.8 ? Math.min(hi, Math.max(lo, type === "integer" ? Math.round(n) : n)) : n;
      }
      case "boolean":
        return next() < 0.5;
      case "array":
        return Array.from({ length: Math.min(s.maxItems ?? 5, Math.floor(next() * 5)) }, () => value(s.items, name, d + 1));
      case "object":
        if (s.properties) {
          const out = {};
          for (const [k, sub] of Object.entries(s.properties)) if ((s.required ?? []).includes(k) || next() < 0.5) out[k] = value(sub, k, d + 1);
          return out;
        }
        return d > 3 ? {} : { a: pick(STRINGS), b: [1, { c: null }], type: pick(["object", "string", "array"]), properties: { x: { type: "string" } }, required: ["x", "y"] };
      default:
        return next() < 0.5 ? pick(STRINGS) : { type: "object" };
    }
  };
  return value(schema, "", depth);
}

test("every offline tool answers generated arguments with a result or a clear error", { timeout: 600_000 }, async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network disabled in the fuzz test");
  };
  const dir = mkdtempSync(path.join(tmpdir(), "dev-mcp-fuzz-"));
  const gitdir = path.join(dir, "repo");
  mkdirSync(gitdir);
  const git = (...args) => execFileSync("git", ["-C", gitdir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args]);
  git("init", "-q");
  writeFileSync(path.join(gitdir, "a.txt"), "x\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const next = rng(4242);
  const problems = [];
  try {
    for (const pkg of readdirSync(path.join(repo, "packages"))) {
      const mod = await import(path.join(repo, "packages", pkg, "dist", "index.js"));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = mod.createServer();
      await server.connect(serverTransport);
      const client = new Client({ name: "fuzz", version: "0.0.0" });
      await client.connect(clientTransport);
      try {
        const { tools } = await client.listTools();
        for (const tool of tools) {
          if (NETWORK_TOOLS.has(`${pkg}/${tool.name}`)) continue;
          for (let i = 0; i < Math.max(5, ROUNDS / 20); i++) {
            const generated = argumentsFor(tool.inputSchema, dir, gitdir, next);
            const args = generated && typeof generated === "object" && !Array.isArray(generated) ? generated : {};
            const started = Date.now();
            let result;
            try {
              result = await Promise.race([
                client.callTool({ name: tool.name, arguments: args }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("no answer in 15 s")), 15_000)),
              ]);
            } catch (e) {
              if (!/-32602/.test(String(e?.message))) problems.push(`${pkg}/${tool.name}: ${e?.message} on ${JSON.stringify(args).slice(0, 160)}`);
              continue;
            }
            const text = result?.content?.[0]?.text ?? "";
            if (result?.isError && !/Input validation error/.test(text) && internal.test(text)) problems.push(`${pkg}/${tool.name}: ${text.slice(0, 160)} on ${JSON.stringify(args).slice(0, 160)}`);
            if (Date.now() - started > 10_000) problems.push(`${pkg}/${tool.name}: took ${Date.now() - started} ms`);
          }
        }
        await client.listTools(); // still answering after the fuzzing
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(problems, []);
});

// ---- scaling: input ten times the usual size stays linear --------------------------------

test("parsers stay fast on ten times the usual input", () => {
  const n = 10_000;
  const timed = (name, fn) => {
    const started = performance.now();
    fn();
    return [name, performance.now() - started];
  };
  const paths = Object.fromEntries(Array.from({ length: n }, (_, i) => [`/r${i}/{id}`, { get: { operationId: `op${i}`, parameters: [{ $ref: "#/components/parameters/id" }], responses: { 200: { $ref: "#/components/responses/ok" } } } }]));
  const openapi = JSON.stringify({ openapi: "3.1.0", info: { title: "t", version: "1" }, paths, components: { parameters: { id: { name: "id", in: "path", required: true } }, responses: { ok: { description: "ok" } } } });
  const results = [
    timed("dockerfile", () => dock.lint(dock.parseDockerfile(Array.from({ length: n }, (_, i) => (i % 50 === 0 ? `FROM node:${i} AS s${i}` : `RUN echo ${i} && apt-get install -y x${i} \\\n  && true\nENV K${i}=v\nCOPY --from=s0 /a${i} /b`)).join("\n")), {})),
    timed("package-lock", () => lock.parseLockfile(JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(Array.from({ length: n * 5 }, (_, i) => [`node_modules/p${i}`, { version: `1.0.${i}` }])) }), "package-lock")),
    timed("requirements", () => lock.parseLockfile(Array.from({ length: n * 5 }, (_, i) => `pkg${i}==1.${i}.0`).join("\n"), "requirements")),
    timed("go-sum", () => lock.parseLockfile(Array.from({ length: n * 5 }, (_, i) => `example.com/m${i} v1.${i}.0 h1:abc=`).join("\n"), "go-sum")),
    timed("cargo", () => lock.parseLockfile(Array.from({ length: n * 5 }, (_, i) => `[[package]]\nname = "c${i}"\nversion = "1.0.${i}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`).join("\n"), "cargo")),
    timed("uv", () => lock.parseLockfile(Array.from({ length: n * 5 }, (_, i) => `[[package]]\nname = "u${i}"\nversion = "1.0.${i}"\nsource = { registry = "https://pypi.org/simple" }\n`).join("\n"), "uv")),
    timed("gemfile", () => lock.parseLockfile("GEM\n  remote: https://rubygems.org/\n  specs:\n" + Array.from({ length: n * 5 }, (_, i) => `    g${i} (1.${i})`).join("\n") + "\n", "gemfile")),
    timed("openapi", () => {
      const d = oa.parseDocument(openapi);
      oa.lint(d, {});
      oa.listOperations(d);
    }),
    timed("sitemap", () => llms.entriesFromSitemap(llms.parseSitemap("<urlset>" + Array.from({ length: n * 5 }, (_, i) => `<url><loc>https://x.example/p${i}</loc></url>`).join("") + "</urlset>").urls, {})),
    timed("diffSchemas", () => {
      const props = Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { type: i % 2 ? "string" : "integer" }]));
      js.diffSchemas({ type: "object", properties: props, required: Object.keys(props) }, { type: "object", properties: { ...props, extra: { type: "string" } }, required: Object.keys(props).slice(1) });
    }),
  ];
  // Measured on 28 October 2026: every one of these took 0.05 s or less; 2 s leaves room
  // for slow CI machines while still catching a quadratic step.
  assert.deepEqual(results.filter(([, ms]) => ms > 2000).map(([name, ms]) => `${name} ${Math.round(ms)} ms`), []);
});
