#!/usr/bin/env node
/**
 * jwt-tools: decode, analyse, verify and sign JSON Web Tokens.
 *
 * Transport: stdio only. No network access, no file access. Keys stay in process memory for the call.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ALGORITHMS, analyseJwt, decodeJwt, signJwt, verifyJwt } from "./jwt.js";

export const SERVER_NAME = "jwt-tools";
export const SERVER_VERSION = "0.1.0";
const MAX_TOKEN = 16_384;
const MAX_KEY = 16_384;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const tokenSchema = z.string().min(3).max(MAX_TOKEN).describe("Compact JWS token (header.payload.signature). A leading 'Bearer ' is ignored.");
const pure = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Inspects JSON Web Tokens locally. decode_jwt shows the header and claims without verifying anything and lists risk findings (alg none, expired, missing exp, aud or iss, long lifetimes, key URLs in the header, sensitive claims). " +
        "verify_jwt checks the signature with a key you supply for one expected algorithm (HS256/384/512 with a shared secret, RS256/384/512 with a PEM public key) and then the time, audience and issuer claims. " +
        "sign_test_jwt mints a token for test fixtures. Nothing leaves the process.",
    },
  );

  server.registerTool(
    "decode_jwt",
    {
      title: "Decode a JWT without verifying it",
      description:
        "Base64url-decode the header and payload of a JWS compact token and report findings. The signature is NOT verified; the output says so and the claims must be " +
        "treated as unverified. Findings cover: alg none or missing, empty signature, jku/x5u/jwk in the header, expired, not yet valid, missing exp/iat/aud/iss/sub/jti, " +
        "lifetime above max_ttl_hours (default 24), timestamps given in milliseconds, and claims whose names suggest secrets. Timestamps are also returned as ISO 8601. " +
        "JWE (encrypted, five-part) tokens are rejected.",
      inputSchema: {
        token: tokenSchema,
        now: z.number().int().min(0).max(1e11).optional().describe("Unix seconds to evaluate exp and nbf against. Default: current time."),
        max_ttl_hours: z.number().min(0.01).max(8760 * 10).optional().describe("Lifetime threshold for the long-ttl finding, in hours. Default 24."),
      },
      annotations: pure,
    },
    async ({ token, now, max_ttl_hours }) => {
      try {
        const d = decodeJwt(token);
        const { findings, times } = analyseJwt(d, { now, maxTtlHours: max_ttl_hours });
        return json({
          verified: false,
          header: d.header,
          payload: d.payload,
          signature_present: d.signature_present,
          signature_bytes: d.signature_bytes,
          times,
          findings,
        });
      } catch (err) {
        return fail(`Cannot decode token: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "verify_jwt",
    {
      title: "Verify a JWT signature and claims",
      description:
        "Verify the signature of a JWS compact token with the supplied key for exactly the given algorithm, then check exp (required), nbf, and optionally aud and iss. " +
        "HS256/HS384/HS512 take the shared secret as key; RS256/RS384/RS512 take a PEM public key, certificate or private key. A token whose header alg differs from " +
        "algorithm fails without any cryptographic check, which blocks algorithm-confusion attacks. Returns valid (both signature and claims), signature_valid, claims_valid and the reasons.",
      inputSchema: {
        token: tokenSchema,
        key: z.string().min(1).max(MAX_KEY).describe("Shared secret (HS*) or PEM-encoded key (RS*)."),
        algorithm: z.enum(ALGORITHMS).describe("The one algorithm the verifier accepts."),
        audience: z.string().max(500).optional().describe("Required aud value (matches a string aud or one element of an array aud)."),
        issuer: z.string().max(500).optional().describe("Required iss value."),
        now: z.number().int().min(0).max(1e11).optional().describe("Unix seconds for time checks. Default: current time."),
        clock_tolerance_seconds: z.number().int().min(0).max(3600).optional().describe("Leeway for exp and nbf. Default 0."),
      },
      annotations: pure,
    },
    async ({ token, key, algorithm, audience, issuer, now, clock_tolerance_seconds }) => {
      try {
        return json(verifyJwt(token, key, algorithm, { audience, issuer, now, clockToleranceSeconds: clock_tolerance_seconds }));
      } catch (err) {
        return fail(`Cannot verify token: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "sign_test_jwt",
    {
      title: "Sign a JWT for test fixtures",
      description:
        "Create a signed JWS compact token from a claims object for use in tests and local development. iat is set to now unless the payload supplies one; exp is set from " +
        "expires_in_seconds when given. HS* algorithms use key as the shared secret; RS* algorithms need a PEM private key. Returns the token and the final header and claims.",
      inputSchema: {
        payload: z.record(z.string().max(200), z.unknown()).describe("Claims to sign, for example {\"sub\":\"user-1\",\"aud\":\"api\"}."),
        key: z.string().min(1).max(MAX_KEY),
        algorithm: z.enum(ALGORITHMS),
        expires_in_seconds: z.number().int().min(1).max(10 * 365 * 86400).optional(),
        now: z.number().int().min(0).max(1e11).optional().describe("Unix seconds used for iat and exp. Default: current time."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ payload, key, algorithm, expires_in_seconds, now }) => {
      if (JSON.stringify(payload).length > MAX_TOKEN) return fail(`payload exceeds ${MAX_TOKEN} bytes`);
      try {
        const token = signJwt(payload, key, algorithm, { expiresInSeconds: expires_in_seconds, now });
        const d = decodeJwt(token);
        return json({ token, header: d.header, payload: d.payload });
      } catch (err) {
        return fail(`Cannot sign: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Compare real paths: an installed bin (npx, npm i -g) is a symlink, so argv[1] differs from import.meta.url.
function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

const invokedDirectly = isInvokedDirectly();
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[${SERVER_NAME}] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
