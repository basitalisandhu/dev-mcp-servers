import { posix } from "node:path";

export const MAX_DOCKERIGNORE_BYTES = 64 * 1024;

// Dynamic programming bounds work by pattern length times the short root name.
// Unlike a generated regexp, repeated stars cannot cause exponential backtracking.
function matches(path: string, pattern: string): boolean {
  let matched = new Uint8Array(path.length + 1);
  matched[0] = 1;
  for (let i = 0; i < pattern.length; i++) {
    const next = new Uint8Array(path.length + 1);
    if (pattern[i] === "*") {
      const recursive = pattern[i + 1] === "*";
      while (pattern[i + 1] === "*") i++;
      const optionalDirectory = recursive && pattern[i + 1] === "/";
      if (optionalDirectory) i++;
      let prefix = false;
      for (let j = 0; j <= path.length; j++) {
        if (optionalDirectory) {
          next[j] = matched[j] || (prefix && path[j - 1] === "/" ? 1 : 0);
          prefix ||= matched[j] === 1;
        } else {
          next[j] = matched[j] || (j > 0 && (recursive || path[j - 1] !== "/") ? next[j - 1] : 0);
        }
      }
    } else {
      for (let j = 1; j <= path.length; j++) next[j] = matched[j - 1] && path[j - 1] === pattern[i] ? 1 : 0;
    }
    matched = next;
  }
  return matched[path.length] === 1;
}

/** Conservative sensitive-root coverage, not a filesystem walk or Docker emulator. */
export function exposedSensitiveRoots(content: string | undefined): string[] {
  const roots = [
    { name: ".git", probe: ".git" },
    { name: ".env*", probe: ".env" },
    { name: "node_modules", probe: "node_modules" },
  ];
  const excluded = new Set<string>();
  for (const line of (content ?? "").split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    let pattern = line.trim();
    const negate = pattern.startsWith("!");
    if (negate) pattern = pattern.slice(1).trim();
    pattern = posix.normalize(pattern).replace(/^\/+|\/+$/g, "");
    if (!pattern || pattern === ".") continue;
    const first = pattern.split("/")[0];
    for (const root of roots) {
      if (!negate && matches(root.probe, pattern)) excluded.add(root.name);
      if (negate) {
        // Literal descendants and .env variants can re-include a sensitive file.
        // Wildcard negations are uncertain without enumerating the filesystem.
        const couldInclude = first.includes("*") || matches(root.probe, first)
          || (root.name === ".env*" && first.startsWith(".env"));
        if (couldInclude) excluded.delete(root.name);
      }
    }
  }
  return roots.map((root) => root.name).filter((name) => !excluded.has(name));
}
