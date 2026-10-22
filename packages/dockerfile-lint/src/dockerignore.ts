import { posix } from "node:path";
import { minimatch } from "minimatch";

export const MAX_DOCKERIGNORE_BYTES = 1024 * 1024;

/** Conservative sensitive-root coverage, not a filesystem walk or Docker emulator. */
export function exposedSensitiveRoots(content: string | undefined): string[] {
  const roots = [
    { name: ".git", probes: [".git"] },
    { name: ".env*", probes: [".env", ".env.production", ".env.secret"] },
    { name: "node_modules", probes: ["node_modules"] },
  ];
  const excluded = new Set<string>();
  const matches = (path: string, pattern: string) => minimatch(path, pattern, {
    dot: true, nonegate: true, noext: true, nobrace: true, platform: "linux",
  });
  for (const line of (content ?? "").split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    let pattern = line.trim();
    const negate = pattern.startsWith("!");
    if (negate) pattern = pattern.slice(1).trim();
    pattern = posix.normalize(pattern).replace(/^\/+|\/+$/g, "");
    if (!pattern || pattern === ".") continue;
    const first = pattern.split("/")[0];
    for (const root of roots) {
      // A trailing globstar/star is needed to cover every .env suffix, not just
      // the sample names (e.g. .env*[!z] must not hide an exposed .env.z).
      const coversFamily = root.name !== ".env*" || pattern.endsWith("*");
      if (!negate && coversFamily && root.probes.every((probe) => matches(probe, pattern))) excluded.add(root.name);
      if (negate) {
        // Literal descendants and .env variants can re-include a sensitive file.
        // Wildcard negations are uncertain without enumerating the filesystem.
        const couldInclude = /[*?[]/.test(first) || root.probes.some((probe) => matches(probe, first))
          || (root.name === ".env*" && first.startsWith(".env"));
        if (couldInclude) excluded.delete(root.name);
      }
    }
  }
  return roots.map((root) => root.name).filter((name) => !excluded.has(name));
}
