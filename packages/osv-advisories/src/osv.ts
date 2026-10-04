/**
 * Minimal OSV.dev client. The only host it will ever contact is api.osv.dev, over HTTPS,
 * with a timeout and a cap on the response size.
 */

export const OSV_ORIGIN = "https://api.osv.dev";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const BATCH_CHUNK = 100;
export const MAX_BATCH_QUERIES = 1000;

/** Ecosystem names as OSV spells them. Input is matched case-insensitively and normalised to these. */
export const ECOSYSTEMS = [
  "AlmaLinux", "Alpine", "Android", "Bioconductor", "Bitnami", "Chainguard", "ConanCenter", "CRAN", "crates.io", "Debian",
  "GHC", "GitHub Actions", "Go", "Hackage", "Hex", "Linux", "Mageia", "Maven", "npm", "NuGet", "openSUSE", "OSS-Fuzz",
  "Packagist", "Pub", "PyPI", "Red Hat", "Rocky Linux", "RubyGems", "SUSE", "SwiftURL", "Ubuntu", "Wolfi",
] as const;

export function normaliseEcosystem(input: string): string | undefined {
  const needle = input.trim().toLowerCase();
  return ECOSYSTEMS.find((e) => e.toLowerCase() === needle);
}

export interface PackageQuery {
  ecosystem: string;
  name: string;
  version?: string;
}

export interface OsvVulnerability {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  modified?: string;
  published?: string;
  withdrawn?: string;
  severity?: { type: string; score: string }[];
  affected?: {
    package?: { ecosystem?: string; name?: string };
    ranges?: { type: string; events: Record<string, string>[] }[];
    versions?: string[];
    ecosystem_specific?: Record<string, unknown>;
    database_specific?: Record<string, unknown>;
  }[];
  references?: { type?: string; url: string }[];
  database_specific?: Record<string, unknown>;
}

export interface VulnerabilitySummary {
  id: string;
  aliases: string[];
  summary: string;
  severity: string[];
  published?: string;
  modified?: string;
  withdrawn?: string;
  affected_ranges: { package: string; ecosystem: string; introduced?: string; fixed?: string; last_affected?: string }[];
  fixed_versions: string[];
  references: string[];
}

export interface OsvClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class OsvError extends Error {}

async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new OsvError(`response of ${declared} bytes exceeds the ${maxBytes} byte limit`);
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new OsvError(`response exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class OsvClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: OsvClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, OSV_ORIGIN);
    if (url.origin !== OSV_ORIGIN) throw new OsvError(`refusing to contact ${url.origin}; only ${OSV_ORIGIN} is allowed`);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new OsvError(`request to ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new OsvError(`OSV responded ${res.status} for ${url.pathname}`);
    const text = await readBounded(res, this.maxResponseBytes);
    try {
      return JSON.parse(text);
    } catch {
      throw new OsvError(`OSV returned a non-JSON body for ${url.pathname}`);
    }
  }

  /** POST /v1/query, following next_page_token for up to five pages. */
  async queryPackage(q: PackageQuery): Promise<OsvVulnerability[]> {
    const vulns: OsvVulnerability[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const payload: Record<string, unknown> = { package: { name: q.name, ecosystem: q.ecosystem } };
      if (q.version) payload.version = q.version;
      if (pageToken) payload.page_token = pageToken;
      const data = (await this.request("/v1/query", payload)) as { vulns?: OsvVulnerability[]; next_page_token?: string } | null;
      if (!data) break;
      vulns.push(...(data.vulns ?? []));
      if (!data.next_page_token) break;
      pageToken = data.next_page_token;
    }
    return vulns;
  }

  /** POST /v1/querybatch in chunks. Returns, per query (same order), the vulnerability ids only. */
  async queryBatch(queries: PackageQuery[]): Promise<{ ids: string[] }[]> {
    if (queries.length > MAX_BATCH_QUERIES) throw new OsvError(`at most ${MAX_BATCH_QUERIES} packages per batch`);
    const out: { ids: string[] }[] = [];
    for (let i = 0; i < queries.length; i += BATCH_CHUNK) {
      const chunk = queries.slice(i, i + BATCH_CHUNK);
      const payload = {
        queries: chunk.map((q) => ({ package: { name: q.name, ecosystem: q.ecosystem }, ...(q.version ? { version: q.version } : {}) })),
      };
      const data = (await this.request("/v1/querybatch", payload)) as { results?: { vulns?: { id: string }[] }[] } | null;
      const results = data?.results ?? [];
      for (let j = 0; j < chunk.length; j++) {
        out.push({ ids: (results[j]?.vulns ?? []).map((v) => v.id) });
      }
    }
    return out;
  }

  /** GET /v1/vulns/{id}. Returns null when OSV does not know the id. */
  async getVulnerability(id: string): Promise<OsvVulnerability | null> {
    return (await this.request(`/v1/vulns/${encodeURIComponent(id)}`)) as OsvVulnerability | null;
  }
}

export function summarise(v: OsvVulnerability): VulnerabilitySummary {
  const severity: string[] = [];
  for (const s of v.severity ?? []) severity.push(`${s.type}: ${s.score}`);
  const dbSeverity = v.database_specific?.severity;
  if (typeof dbSeverity === "string") severity.push(`database: ${dbSeverity}`);
  const ranges: VulnerabilitySummary["affected_ranges"] = [];
  const fixed = new Set<string>();
  for (const a of v.affected ?? []) {
    for (const r of a.ranges ?? []) {
      const entry: VulnerabilitySummary["affected_ranges"][number] = { package: a.package?.name ?? "", ecosystem: a.package?.ecosystem ?? "" };
      for (const e of r.events) {
        if (e.introduced !== undefined) entry.introduced = e.introduced;
        if (e.fixed !== undefined) {
          entry.fixed = e.fixed;
          fixed.add(e.fixed);
        }
        if (e.last_affected !== undefined) entry.last_affected = e.last_affected;
      }
      ranges.push(entry);
    }
  }
  return {
    id: v.id,
    aliases: v.aliases ?? [],
    summary: v.summary ?? (v.details ? v.details.slice(0, 300) : ""),
    severity,
    published: v.published,
    modified: v.modified,
    withdrawn: v.withdrawn,
    affected_ranges: ranges,
    fixed_versions: [...fixed],
    references: (v.references ?? []).slice(0, 8).map((r) => r.url),
  };
}
