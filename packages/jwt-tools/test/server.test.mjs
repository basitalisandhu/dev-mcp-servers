import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../dist/index.js";
import { base64urlEncode, decodeJwt, signJwt, verifyJwt } from "../dist/jwt.js";

const NOW = 1_700_000_000;
const SECRET = "test-secret-with-enough-length";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUB = publicKey.export({ type: "spki", format: "pem" });
const PRIV = privateKey.export({ type: "pkcs8", format: "pem" });

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const parse = (r) => JSON.parse(r.content[0].text);
const codes = (r) => r.findings.map((f) => f.code);

test("lists the three tools", async () => {
  const { client, close } = await connected();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["decode_jwt", "sign_test_jwt", "verify_jwt"]);
    assert.ok(tools.every((t) => t.annotations.openWorldHint === false));
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
  } finally {
    await close();
  }
});

test("decode_jwt never verifies and flags the documented problems", async () => {
  const { client, close } = await connected();
  try {
    const good = signJwt({ sub: "u1", aud: "api", iss: "https://issuer.example", jti: "1", exp: NOW + 600 }, SECRET, "HS256", { now: NOW });
    const r = parse(await client.callTool({ name: "decode_jwt", arguments: { token: `Bearer ${good}`, now: NOW } }));
    assert.equal(r.verified, false);
    assert.equal(r.header.alg, "HS256");
    assert.equal(r.payload.sub, "u1");
    assert.equal(r.times.exp, new Date((NOW + 600) * 1000).toISOString());
    assert.deepEqual(codes(r), ["not-verified", "alg-symmetric"]);

    const noneToken = `${base64urlEncode(JSON.stringify({ alg: "none" }))}.${base64urlEncode(JSON.stringify({ sub: "x", password: "hunter2", exp: NOW - 10, iat: NOW - 40 * 86400 }))}.`;
    const bad = parse(await client.callTool({ name: "decode_jwt", arguments: { token: noneToken, now: NOW } }));
    const c = codes(bad);
    for (const expected of ["alg-none", "signature-empty", "expired", "long-ttl", "aud-missing", "iss-missing", "sensitive-claims"]) assert.ok(c.includes(expected), expected);
    assert.equal(bad.findings.find((f) => f.code === "alg-none").severity, "critical");

    const header = base64urlEncode(JSON.stringify({ alg: "RS256", jku: "https://attacker.example/keys", jwk: { kty: "RSA" } }));
    const weird = parse(await client.callTool({ name: "decode_jwt", arguments: { token: `${header}.${base64urlEncode(JSON.stringify({ exp: NOW * 1000, nbf: NOW + 7200 }))}.AAAA`, now: NOW } }));
    const w = codes(weird);
    for (const expected of ["header-key-url", "header-embedded-jwk", "exp-milliseconds", "not-yet-valid", "iat-missing"]) assert.ok(w.includes(expected), expected);

    const notJwt = await client.callTool({ name: "decode_jwt", arguments: { token: "a.b" } });
    assert.equal(notJwt.isError, true);
    const jwe = await client.callTool({ name: "decode_jwt", arguments: { token: "a.b.c.d.e" } });
    assert.equal(jwe.isError, true);
    const badJson = await client.callTool({ name: "decode_jwt", arguments: { token: "e30.bm90anNvbg.sig" } });
    assert.equal(badJson.isError, true);
  } finally {
    await close();
  }
});

test("verify_jwt checks HS256 and RS256 signatures, claims, and refuses algorithm confusion", async () => {
  const { client, close } = await connected();
  try {
    const hs = signJwt({ sub: "u1", aud: ["api", "web"], iss: "me" }, SECRET, "HS256", { now: NOW, expiresInSeconds: 300 });
    const ok = parse(await client.callTool({ name: "verify_jwt", arguments: { token: hs, key: SECRET, algorithm: "HS256", audience: "api", issuer: "me", now: NOW + 10 } }));
    assert.equal(ok.valid, true);
    assert.deepEqual(ok.reasons, []);
    const wrongKey = parse(await client.callTool({ name: "verify_jwt", arguments: { token: hs, key: "other", algorithm: "HS256", now: NOW } }));
    assert.equal(wrongKey.signature_valid, false);
    assert.equal(wrongKey.valid, false);
    const expired = parse(await client.callTool({ name: "verify_jwt", arguments: { token: hs, key: SECRET, algorithm: "HS256", now: NOW + 301 } }));
    assert.equal(expired.signature_valid, true);
    assert.equal(expired.claims_valid, false);
    assert.match(expired.reasons[0], /expired/);
    const tolerated = parse(await client.callTool({ name: "verify_jwt", arguments: { token: hs, key: SECRET, algorithm: "HS256", now: NOW + 301, clock_tolerance_seconds: 5 } }));
    assert.equal(tolerated.valid, true);
    const wrongAud = parse(await client.callTool({ name: "verify_jwt", arguments: { token: hs, key: SECRET, algorithm: "HS256", audience: "admin", issuer: "you", now: NOW } }));
    assert.equal(wrongAud.reasons.length, 2);

    const rs = signJwt({ sub: "u2" }, PRIV, "RS256", { now: NOW, expiresInSeconds: 60 });
    const rsOk = parse(await client.callTool({ name: "verify_jwt", arguments: { token: rs, key: PUB, algorithm: "RS256", now: NOW } }));
    assert.equal(rsOk.valid, true);
    const rsPriv = parse(await client.callTool({ name: "verify_jwt", arguments: { token: rs, key: PRIV, algorithm: "RS256", now: NOW } }));
    assert.equal(rsPriv.signature_valid, true);
    const tampered = rs.slice(0, -4) + "AAAA";
    const rsBad = parse(await client.callTool({ name: "verify_jwt", arguments: { token: tampered, key: PUB, algorithm: "RS256", now: NOW } }));
    assert.equal(rsBad.signature_valid, false);

    // Algorithm confusion: an HS256 token signed with the public key text must not verify when RS256 is expected, and vice versa.
    const confused = signJwt({ sub: "u3" }, PUB, "HS256", { now: NOW, expiresInSeconds: 60 });
    const refused = parse(await client.callTool({ name: "verify_jwt", arguments: { token: confused, key: PUB, algorithm: "RS256", now: NOW } }));
    assert.equal(refused.valid, false);
    assert.match(refused.reasons[0], /header alg is "HS256" but RS256 was required/);
    const badKey = await client.callTool({ name: "verify_jwt", arguments: { token: rs, key: "not a pem", algorithm: "RS256" } });
    assert.equal(badKey.isError, true);
    const noExp = verifyJwt(signJwt({ sub: "x" }, SECRET, "HS256", { now: NOW }), SECRET, "HS256", { now: NOW });
    assert.equal(noExp.claims_valid, false);
    assert.deepEqual(noExp.reasons, ["no exp claim"]);
  } finally {
    await close();
  }
});

test("sign_test_jwt produces tokens that decode and verify", async () => {
  const { client, close } = await connected();
  try {
    const r = parse(await client.callTool({ name: "sign_test_jwt", arguments: { payload: { sub: "t", aud: "api" }, key: SECRET, algorithm: "HS512", expires_in_seconds: 120, now: NOW } }));
    assert.equal(r.header.alg, "HS512");
    assert.equal(r.payload.iat, NOW);
    assert.equal(r.payload.exp, NOW + 120);
    assert.equal(verifyJwt(r.token, SECRET, "HS512", { now: NOW }).valid, true);
    const rs = parse(await client.callTool({ name: "sign_test_jwt", arguments: { payload: { sub: "t" }, key: PRIV, algorithm: "RS384", expires_in_seconds: 10, now: NOW } }));
    assert.equal(verifyJwt(rs.token, PUB, "RS384", { now: NOW }).valid, true);
    const noKey = await client.callTool({ name: "sign_test_jwt", arguments: { payload: {}, key: PUB, algorithm: "RS256" } });
    assert.equal(noKey.isError, true);
    assert.equal(decodeJwt(r.token).signature_bytes, 64);
  } finally {
    await close();
  }
});
