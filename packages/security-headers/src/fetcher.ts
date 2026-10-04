/**
 * Fetches response headers for a public http(s) URL. Refuses private, loopback, link-local and
 * metadata addresses (both literal IPs and names that resolve to them), follows at most a few
 * redirects with the same checks on every hop, times out, and never reads the response body.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_REDIRECTS = 5;
export const MAX_REDIRECTS = 10;

export interface FetchHeadersOptions {
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface FetchedHeaders {
  requested_url: string;
  final_url: string;
  method: string;
  status: number;
  redirects: { from: string; to: string; status: number }[];
  headers: Record<string, string>;
  set_cookie: string[];
}

export class UnsafeUrlError extends Error {}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::" || lower === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1]);
  const first = lower.split(":")[0];
  if (/^fe[89ab]/.test(first)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(first)) return true; // unique local fc00::/7
  if (first === "" || first === "0") return true; // ::/8 and v4-compatible
  if (/^ff/.test(first)) return true; // multicast
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true;
}

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal";
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

export async function assertPublicUrl(raw: string, resolve: (h: string) => Promise<string[]>): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`${JSON.stringify(raw)} is not an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError(`only http and https URLs are supported, not ${url.protocol}`);
  if (url.username || url.password) throw new UnsafeUrlError("URLs with embedded credentials are refused");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host)) throw new UnsafeUrlError(`${host} is a local hostname; only public hosts are fetched`);
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError(`${host} is a private, loopback, link-local or reserved address`);
    return url;
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    throw new UnsafeUrlError(`${host} does not resolve: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`${host} does not resolve to any address`);
  const bad = addresses.find((a) => isPrivateAddress(a));
  if (bad) throw new UnsafeUrlError(`${host} resolves to ${bad}, a private or reserved address; refusing to fetch`);
  return url;
}

export async function fetchHeaders(raw: string, method: "HEAD" | "GET", options: FetchHeadersOptions = {}): Promise<FetchedHeaders> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const resolve = options.resolve ?? defaultResolve;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = Math.min(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS, MAX_REDIRECTS);
  const redirects: FetchedHeaders["redirects"] = [];
  let current = await assertPublicUrl(raw, resolve);
  let currentMethod: "HEAD" | "GET" = method;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(current, {
        method: currentMethod,
        redirect: "manual",
        headers: { "user-agent": "mcp-security-headers/0.1 (+https://github.com/basitalisandhu/dev-mcp-servers)", accept: "*/*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`request to ${current.origin} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await res.body?.cancel();
    } catch {
      /* body already consumed or absent */
    }
    if (currentMethod === "HEAD" && (res.status === 405 || res.status === 501)) {
      currentMethod = "GET";
      continue;
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= maxRedirects) throw new Error(`more than ${maxRedirects} redirects (last: ${current} -> ${location})`);
      const next = await assertPublicUrl(new URL(location, current).toString(), resolve);
      redirects.push({ from: current.toString(), to: next.toString(), status: res.status });
      current = next;
      continue;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      if (name.toLowerCase() !== "set-cookie") headers[name.toLowerCase()] = value;
    });
    const setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    return { requested_url: raw, final_url: current.toString(), method: currentMethod, status: res.status, redirects, headers, set_cookie: setCookie };
  }
}
