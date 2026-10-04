/**
 * JWT decoding, analysis, verification and test signing with node:crypto only.
 */
import { createHmac, createPrivateKey, createPublicKey, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto";

export const HMAC_ALGORITHMS = ["HS256", "HS384", "HS512"] as const;
export const RSA_ALGORITHMS = ["RS256", "RS384", "RS512"] as const;
export const ALGORITHMS = [...HMAC_ALGORITHMS, ...RSA_ALGORITHMS] as const;
export type Algorithm = (typeof ALGORITHMS)[number];

const HASH: Record<Algorithm, string> = { HS256: "sha256", HS384: "sha384", HS512: "sha512", RS256: "sha256", RS384: "sha384", RS512: "sha512" };

export interface Decoded {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature_present: boolean;
  signature_bytes: number;
  signing_input: string;
  signature: Buffer;
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
}

export function base64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

export function base64urlEncode(b: Buffer | string): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeJwt(token: string): Decoded {
  const trimmed = token.trim().replace(/^Bearer\s+/i, "");
  const parts = trimmed.split(".");
  if (parts.length !== 3) throw new Error(`a JWS compact token has three dot-separated parts; this one has ${parts.length}`);
  const [h, p, s] = parts;
  if (!/^[A-Za-z0-9_-]*$/.test(h) || !/^[A-Za-z0-9_-]*$/.test(p) || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("token parts must be base64url (letters, digits, - and _)");
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(base64urlDecode(h).toString("utf8"));
  } catch {
    throw new Error("header is not base64url-encoded JSON");
  }
  try {
    payload = JSON.parse(base64urlDecode(p).toString("utf8"));
  } catch {
    throw new Error("payload is not base64url-encoded JSON (encrypted JWE tokens cannot be decoded here)");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error("header is not a JSON object");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload is not a JSON object");
  const signature = base64urlDecode(s);
  return {
    header: header as Record<string, unknown>,
    payload: payload as Record<string, unknown>,
    signature_present: s.length > 0,
    signature_bytes: signature.length,
    signing_input: `${h}.${p}`,
    signature,
  };
}

function asSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function humanDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 60) return `${Math.round(abs)} s`;
  if (abs < 3600) return `${Math.round(abs / 60)} min`;
  if (abs < 86400) return `${(abs / 3600).toFixed(1)} h`;
  return `${(abs / 86400).toFixed(1)} days`;
}

const SENSITIVE_CLAIM = /(password|passwd|secret|ssn|social.?security|credit.?card|card.?number|cvv|private.?key|api.?key)/i;

export interface AnalysisOptions {
  now?: number;
  maxTtlHours?: number;
}

export function analyseJwt(d: Decoded, options: AnalysisOptions = {}): { findings: Finding[]; times: Record<string, string> } {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maxTtl = (options.maxTtlHours ?? 24) * 3600;
  const findings: Finding[] = [];
  const times: Record<string, string> = {};
  const alg = typeof d.header.alg === "string" ? d.header.alg : undefined;

  findings.push({ code: "not-verified", severity: "info", message: "Decoded only. The signature was not checked; nothing in the payload can be trusted until verify_jwt succeeds with the expected key and algorithm." });

  if (!alg) findings.push({ code: "alg-missing", severity: "high", message: "Header has no alg. Libraries may reject it or fall back to an unsafe default." });
  else if (alg.toLowerCase() === "none") findings.push({ code: "alg-none", severity: "critical", message: "alg is none: the token is unsigned. Any verifier that accepts none accepts forged tokens." });
  else if (!ALGORITHMS.includes(alg as Algorithm) && !/^(ES(256|384|512)|PS(256|384|512)|EdDSA)$/.test(alg)) findings.push({ code: "alg-unknown", severity: "medium", message: `alg ${JSON.stringify(alg)} is not a registered JWS algorithm.` });
  if (alg && /^HS/.test(alg)) findings.push({ code: "alg-symmetric", severity: "info", message: `${alg} is symmetric: every party that can verify the token can also mint one.` });
  if (!d.signature_present) findings.push({ code: "signature-empty", severity: alg && alg.toLowerCase() === "none" ? "info" : "critical", message: "The signature part is empty." });

  if (d.header.jku !== undefined || d.header.x5u !== undefined) findings.push({ code: "header-key-url", severity: "high", message: "Header carries jku or x5u, a URL the verifier may fetch keys from. Verifiers must pin allowed key URLs or ignore these fields." });
  if (d.header.jwk !== undefined) findings.push({ code: "header-embedded-jwk", severity: "high", message: "Header embeds a jwk. A verifier that trusts it accepts a key chosen by the token's author." });
  if (d.header.kid !== undefined && typeof d.header.kid === "string" && /[\/\\'"`;]/.test(d.header.kid)) findings.push({ code: "kid-suspicious", severity: "medium", message: "kid contains path or quote characters; verifiers that use kid in file paths or SQL are at risk." });
  if (d.header.typ !== undefined && String(d.header.typ).toUpperCase() !== "JWT" && !String(d.header.typ).includes("+")) findings.push({ code: "typ-unusual", severity: "info", message: `typ is ${JSON.stringify(d.header.typ)} rather than JWT.` });

  const exp = asSeconds(d.payload.exp);
  const iat = asSeconds(d.payload.iat);
  const nbf = asSeconds(d.payload.nbf);
  for (const [name, value] of [["exp", exp], ["iat", iat], ["nbf", nbf]] as const) {
    if (value !== undefined && value > 1e11) findings.push({ code: `${name}-milliseconds`, severity: "medium", message: `${name}=${value} looks like milliseconds; JWT timestamps are seconds since the epoch.` });
    else if (value !== undefined) times[name] = iso(value);
  }
  if (exp === undefined) findings.push({ code: "exp-missing", severity: "high", message: "No exp claim: the token never expires." });
  else if (exp <= 1e11) {
    if (exp <= now) findings.push({ code: "expired", severity: "high", message: `Expired ${humanDuration(now - exp)} ago (exp ${iso(exp)}).` });
    const start = iat ?? nbf;
    if (start !== undefined && start <= 1e11) {
      const ttl = exp - start;
      if (ttl > maxTtl) findings.push({ code: "long-ttl", severity: ttl > 365 * 86400 ? "high" : "medium", message: `Lifetime is ${humanDuration(ttl)} (iat/nbf to exp), above the ${options.maxTtlHours ?? 24} h threshold. Long-lived bearer tokens widen the window after a leak.` });
    } else if (exp - now > maxTtl) {
      findings.push({ code: "long-ttl", severity: "medium", message: `Expires in ${humanDuration(exp - now)}, above the ${options.maxTtlHours ?? 24} h threshold, and there is no iat to measure the full lifetime.` });
    }
  }
  if (nbf !== undefined && nbf <= 1e11 && nbf > now + 300) findings.push({ code: "not-yet-valid", severity: "medium", message: `nbf is ${humanDuration(nbf - now)} in the future (${iso(nbf)}).` });
  if (iat !== undefined && iat <= 1e11 && iat > now + 300) findings.push({ code: "iat-future", severity: "medium", message: `iat is ${humanDuration(iat - now)} in the future; clocks disagree or the token is forged.` });
  if (iat === undefined) findings.push({ code: "iat-missing", severity: "low", message: "No iat claim, so the token's age cannot be measured." });
  if (d.payload.aud === undefined) findings.push({ code: "aud-missing", severity: "medium", message: "No aud claim: the token can be replayed against any service that shares the key." });
  if (d.payload.iss === undefined) findings.push({ code: "iss-missing", severity: "medium", message: "No iss claim: verifiers cannot pin the issuer." });
  if (d.payload.sub === undefined) findings.push({ code: "sub-missing", severity: "low", message: "No sub claim." });
  if (d.payload.jti === undefined) findings.push({ code: "jti-missing", severity: "info", message: "No jti claim, so individual tokens cannot be revoked or deduplicated." });
  const sensitive = Object.keys(d.payload).filter((k) => SENSITIVE_CLAIM.test(k));
  if (sensitive.length) findings.push({ code: "sensitive-claims", severity: "high", message: `Payload contains ${sensitive.join(", ")}. JWS payloads are only base64url-encoded, not encrypted; anyone holding the token can read them.` });
  return { findings, times };
}

export function keyObjectFor(algorithm: Algorithm, key: string, usage: "sign" | "verify"): KeyObject | Buffer {
  if (algorithm.startsWith("HS")) {
    if (key.length === 0) throw new Error("an HMAC key must not be empty");
    return Buffer.from(key, "utf8");
  }
  try {
    if (usage === "sign") return createPrivateKey(key);
    return createPublicKey(key);
  } catch (err) {
    throw new Error(`key is not a PEM ${usage === "sign" ? "private" : "public (or private)"} key: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function computeSignature(algorithm: Algorithm, signingInput: string, key: KeyObject | Buffer): Buffer {
  if (algorithm.startsWith("HS")) return createHmac(HASH[algorithm], key as Buffer).update(signingInput).digest();
  const keyObj = key as KeyObject;
  if (keyObj.asymmetricKeyType !== "rsa") throw new Error(`${algorithm} needs an RSA key, got ${keyObj.asymmetricKeyType ?? "unknown"}`);
  return cryptoSign(HASH[algorithm], Buffer.from(signingInput), keyObj);
}

export interface VerifyOptions {
  audience?: string;
  issuer?: string;
  now?: number;
  clockToleranceSeconds?: number;
}

export interface VerifyResult {
  valid: boolean;
  signature_valid: boolean;
  claims_valid: boolean;
  algorithm: Algorithm;
  reasons: string[];
  payload: Record<string, unknown>;
}

export function verifyJwt(token: string, key: string, algorithm: Algorithm, options: VerifyOptions = {}): VerifyResult {
  const d = decodeJwt(token);
  const reasons: string[] = [];
  const alg = d.header.alg;
  if (alg !== algorithm) {
    return { valid: false, signature_valid: false, claims_valid: false, algorithm, reasons: [`header alg is ${JSON.stringify(alg)} but ${algorithm} was required; refusing to verify with a different algorithm than expected`], payload: d.payload };
  }
  const keyObj = keyObjectFor(algorithm, key, "verify");
  let signatureValid = false;
  if (algorithm.startsWith("HS")) {
    const expected = computeSignature(algorithm, d.signing_input, keyObj);
    signatureValid = expected.length === d.signature.length && timingSafeEqual(expected, d.signature);
  } else {
    const k = keyObj as KeyObject;
    if (k.asymmetricKeyType !== "rsa") reasons.push(`${algorithm} needs an RSA key, got ${k.asymmetricKeyType ?? "unknown"}`);
    else signatureValid = cryptoVerify(HASH[algorithm], Buffer.from(d.signing_input), k, d.signature);
  }
  if (!signatureValid && reasons.length === 0) reasons.push("signature does not match the supplied key");

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tol = options.clockToleranceSeconds ?? 0;
  let claimsValid = true;
  const exp = asSeconds(d.payload.exp);
  const nbf = asSeconds(d.payload.nbf);
  if (exp === undefined) {
    claimsValid = false;
    reasons.push("no exp claim");
  } else if (exp + tol <= now) {
    claimsValid = false;
    reasons.push(`expired at ${iso(exp)}`);
  }
  if (nbf !== undefined && nbf - tol > now) {
    claimsValid = false;
    reasons.push(`not valid before ${iso(nbf)}`);
  }
  if (options.audience !== undefined) {
    const aud = d.payload.aud;
    const list = Array.isArray(aud) ? aud : aud === undefined ? [] : [aud];
    if (!list.includes(options.audience)) {
      claimsValid = false;
      reasons.push(`aud ${JSON.stringify(aud ?? null)} does not include ${JSON.stringify(options.audience)}`);
    }
  }
  if (options.issuer !== undefined && d.payload.iss !== options.issuer) {
    claimsValid = false;
    reasons.push(`iss ${JSON.stringify(d.payload.iss ?? null)} is not ${JSON.stringify(options.issuer)}`);
  }
  return { valid: signatureValid && claimsValid, signature_valid: signatureValid, claims_valid: claimsValid, algorithm, reasons, payload: d.payload };
}

export interface SignOptions {
  expiresInSeconds?: number;
  now?: number;
  header?: Record<string, unknown>;
}

export function signJwt(payload: Record<string, unknown>, key: string, algorithm: Algorithm, options: SignOptions = {}): string {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { iat: now, ...payload };
  if (options.expiresInSeconds !== undefined) claims.exp = now + options.expiresInSeconds;
  const header = { ...(options.header ?? {}), alg: algorithm, typ: "JWT" };
  const signingInput = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(claims))}`;
  const keyObj = keyObjectFor(algorithm, key, "sign");
  const sig = computeSignature(algorithm, signingInput, keyObj);
  return `${signingInput}.${base64urlEncode(sig)}`;
}
