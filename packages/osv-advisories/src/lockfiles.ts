/**
 * Lockfile parsers. Each returns the exact (name, version) pairs it can read and lists what it skipped,
 * so a scan never silently drops a dependency.
 */

export const LOCKFILE_FORMATS = ["package-lock", "requirements", "poetry", "go-sum"] as const;
export type LockfileFormat = (typeof LOCKFILE_FORMATS)[number];

export interface LockPackage {
  ecosystem: string;
  name: string;
  version: string;
}

export interface ParsedLockfile {
  format: LockfileFormat;
  packages: LockPackage[];
  skipped: { entry: string; reason: string }[];
}

export function detectFormat(filename: string | undefined, content: string): LockfileFormat | undefined {
  const base = (filename ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return "package-lock";
  if (base === "poetry.lock") return "poetry";
  if (base === "go.sum") return "go-sum";
  if (base.endsWith(".txt") && base.includes("requirements")) return "requirements";
  const head = content.slice(0, 2000);
  if (/^\s*\{/.test(head) && /"lockfileVersion"/.test(head)) return "package-lock";
  if (/^\[\[package\]\]/m.test(head)) return "poetry";
  if (/^\S+ v[\w.+-]+(\/go\.mod)? h1:/m.test(head)) return "go-sum";
  if (/^[A-Za-z0-9_.-]+(\[[^\]]*\])?\s*==\s*[\w.*+!-]+/m.test(head)) return "requirements";
  return undefined;
}

export function parseLockfile(content: string, format: LockfileFormat): ParsedLockfile {
  switch (format) {
    case "package-lock":
      return parsePackageLock(content);
    case "requirements":
      return parseRequirements(content);
    case "poetry":
      return parsePoetryLock(content);
    case "go-sum":
      return parseGoSum(content);
  }
}

function dedupe(packages: LockPackage[]): LockPackage[] {
  const seen = new Set<string>();
  const out: LockPackage[] = [];
  for (const p of packages) {
    const key = `${p.ecosystem}\0${p.name}\0${p.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function parsePackageLock(content: string): ParsedLockfile {
  const skipped: ParsedLockfile["skipped"] = [];
  let doc: { lockfileVersion?: number; packages?: Record<string, { version?: string; link?: boolean; name?: string }>; dependencies?: Record<string, unknown> };
  try {
    doc = JSON.parse(content);
  } catch (err) {
    throw new Error(`package-lock.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const packages: LockPackage[] = [];
  if (doc.packages && typeof doc.packages === "object") {
    for (const [key, entry] of Object.entries(doc.packages)) {
      if (key === "") continue;
      if (!entry || typeof entry !== "object") continue;
      if (entry.link) {
        skipped.push({ entry: key, reason: "workspace link" });
        continue;
      }
      const idx = key.lastIndexOf("node_modules/");
      const name = entry.name ?? (idx >= 0 ? key.slice(idx + "node_modules/".length) : key);
      if (!entry.version) {
        skipped.push({ entry: key, reason: "no version" });
        continue;
      }
      packages.push({ ecosystem: "npm", name, version: entry.version });
    }
  } else if (doc.dependencies && typeof doc.dependencies === "object") {
    const walk = (deps: Record<string, unknown>) => {
      for (const [name, raw] of Object.entries(deps)) {
        const entry = raw as { version?: string; dependencies?: Record<string, unknown> };
        if (entry.version && !/^(file|link|git|http|npm):/.test(entry.version)) packages.push({ ecosystem: "npm", name, version: entry.version });
        else skipped.push({ entry: name, reason: entry.version ? `non-registry version ${entry.version}` : "no version" });
        if (entry.dependencies) walk(entry.dependencies);
      }
    };
    walk(doc.dependencies);
  } else {
    throw new Error("package-lock.json has neither a packages nor a dependencies map");
  }
  return { format: "package-lock", packages: dedupe(packages), skipped };
}

function parseRequirements(content: string): ParsedLockfile {
  const packages: LockPackage[] = [];
  const skipped: ParsedLockfile["skipped"] = [];
  const logical = content.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  for (const rawLine of logical) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    if (line.startsWith("-")) {
      skipped.push({ entry: line.slice(0, 80), reason: "pip option, not a requirement" });
      continue;
    }
    const spec = line.split(";")[0].split("--hash")[0].trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(===|==|~=|>=|<=|!=|>|<|@)\s*(\S+)(.*)$/.exec(spec);
    if (!m) {
      skipped.push({ entry: spec.slice(0, 80), reason: "unpinned or unrecognised requirement" });
      continue;
    }
    const [, name, , op, version, rest] = m;
    if ((op !== "==" && op !== "===") || rest.trim().startsWith(",")) {
      skipped.push({ entry: spec.slice(0, 80), reason: `not pinned with == (found ${op})` });
      continue;
    }
    if (/[*]/.test(version)) {
      skipped.push({ entry: spec.slice(0, 80), reason: "wildcard version" });
      continue;
    }
    packages.push({ ecosystem: "PyPI", name: name.toLowerCase().replace(/[._]+/g, "-"), version });
  }
  return { format: "requirements", packages: dedupe(packages), skipped };
}

function parsePoetryLock(content: string): ParsedLockfile {
  const packages: LockPackage[] = [];
  const skipped: ParsedLockfile["skipped"] = [];
  const blocks = content.split(/^\[\[package\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    const body = block.split(/^\[/m)[0];
    const name = /^name\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    if (!name || !version) {
      skipped.push({ entry: body.trim().split("\n")[0]?.slice(0, 80) ?? "", reason: "package block without name or version" });
      continue;
    }
    packages.push({ ecosystem: "PyPI", name: name.toLowerCase().replace(/[._]+/g, "-"), version });
  }
  return { format: "poetry", packages: dedupe(packages), skipped };
}

function parseGoSum(content: string): ParsedLockfile {
  const packages: LockPackage[] = [];
  const skipped: ParsedLockfile["skipped"] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) {
      skipped.push({ entry: line.slice(0, 80), reason: "malformed go.sum line" });
      continue;
    }
    const [module, rawVersion] = parts;
    const version = rawVersion.replace(/\/go\.mod$/, "").replace(/^v/, "");
    packages.push({ ecosystem: "Go", name: module, version });
  }
  return { format: "go-sum", packages: dedupe(packages), skipped };
}
